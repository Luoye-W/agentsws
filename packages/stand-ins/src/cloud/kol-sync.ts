/**
 * 红人云端同步（67 §3，WP118）的**契约替身**（WP165，docs/83 §2 第 5 条）。
 *
 * 真服务（`KolCloudService`）在云端那一侧，将来进私有仓。本机那一头（`apps/server` 的
 * `kol-cloud-sync.ts`）的测试改打这一份：按 `@agentsws/contracts` 的 `kol-cloud.ts` 写的
 * 同步协议——上行（`push`）、下行（`pull`，自己推的不拉回）、最后写入者胜（`kolWinsOver`）、
 * 冲突**输的那份留着**、墓碑不留正文、没开通就 402 人话。
 *
 * 两份实现会不会「各按各的理解写、刚好一致」？云端那一侧有一条**一致性测试**
 * （`packages/kol-cloud/test/wp165-stand-in-conformance.test.ts`）拿同一串动作同时喂真服务和
 * 这个替身，回执逐条比对——协议哪天改了而替身没跟上，那一条先红。
 *
 * 订阅只做「没开通 / 开通了」两态（开通当场扣一期）；宽限、欠费、周期计费这些在云端测。
 */
import type {
  KolCloudExport,
  KolObjectKind,
  KolSyncConflict,
  KolSyncConflictEntry,
  KolSyncConflictList,
  KolSyncConflictResolveResult,
  KolSyncObject,
  KolSyncPullResult,
  KolSyncPushRequest,
  KolSyncPushResult,
  KolSyncStatus,
  ServiceSubscription,
} from '@agentsws/contracts'
import {
  emptySubscription,
  isKolObjectKind,
  KOL_SERVICE_CREDITS_PER_MONTH,
  KOL_SERVICE_ID,
  KOL_SYNC_MAX_BATCH,
  kolWinsOver,
} from '@agentsws/contracts'

/** 替身抛的错：码与状态照云上那张表（`payment_required` = 402、`invalid_input` = 400）。 */
export class StandInKolSyncError extends Error {
  readonly code: 'payment_required' | 'invalid_input'
  readonly status: number
  constructor(code: 'payment_required' | 'invalid_input', message: string) {
    super(message)
    this.name = 'StandInKolSyncError'
    this.code = code
    this.status = code === 'payment_required' ? 402 : 400
  }
}

const NOT_SUBSCRIBED =
  '还没开通「红人营销增值服务」。开通后本地与云端各存一份，换台电脑也能接着干（30 积分 / 月）。'

interface Row {
  object: KolSyncObject
  seq: number
}

interface ConflictRow extends KolSyncConflict {
  conflict_id: string
  resolved_at?: string
}

export class KolSyncStandIn {
  private readonly rows = new Map<string, Row>()
  private readonly conflictRows = new Map<string, ConflictRow>()
  private seq = 0
  private sub: ServiceSubscription
  private lastSync: string | undefined
  /** 开通时扣过几期（替身的钱包就是一个计数）。 */
  readonly charges: string[] = []
  private readonly now: () => string
  private readonly org_id: string

  constructor(options: { now: () => string; org_id: string }) {
    this.now = options.now
    this.org_id = options.org_id
    this.sub = emptySubscription(options.org_id, KOL_SERVICE_ID, options.now())
  }

  /** 开通：状态进 `active`，当场扣第一期。 */
  subscribe(): ServiceSubscription {
    const at = this.now()
    if (this.sub.status !== 'active') {
      this.charges.push(`${KOL_SERVICE_ID}:${at}:${String(KOL_SERVICE_CREDITS_PER_MONTH)}`)
      this.sub = {
        ...this.sub,
        status: 'active',
        started_at: this.sub.started_at ?? at,
        anchor_at: at,
        current_cycle_start: at,
        cancel_at_period_end: false,
        last_charge_at: at,
        last_charged_cycle_start: at,
        updated_at: at,
      }
    }
    return { ...this.sub }
  }

  private gate(): void {
    if (this.sub.status !== 'active')
      throw new StandInKolSyncError('payment_required', NOT_SUBSCRIBED)
  }

  private put(object: KolSyncObject): void {
    this.seq += 1
    const stored: KolSyncObject = {
      kind: object.kind,
      id: object.id,
      version: object.version,
      updated_at: object.updated_at,
      writer: object.writer,
      // 墓碑不留正文
      ...(object.deleted === true
        ? { deleted: true }
        : object.body === undefined
          ? {}
          : { body: structuredClone(object.body) }),
    }
    this.rows.set(`${object.kind}|${object.id}`, { object: stored, seq: this.seq })
  }

  private current(kind: string, id: string): KolSyncObject | undefined {
    const row = this.rows.get(`${kind}|${id}`)
    return row === undefined ? undefined : structuredClone(row.object)
  }

  private validate(raw: KolSyncObject): KolSyncObject {
    if (raw === null || typeof raw !== 'object')
      throw new StandInKolSyncError('invalid_input', '同步里有一条不是对象。')
    if (!isKolObjectKind(String(raw.kind)))
      throw new StandInKolSyncError('invalid_input', `认不出这种数据：${String(raw.kind)}`)
    if (typeof raw.id !== 'string' || raw.id.trim() === '')
      throw new StandInKolSyncError('invalid_input', '同步里有一条没有 id。')
    if (!Number.isInteger(raw.version) || raw.version < 1)
      throw new StandInKolSyncError('invalid_input', '版本号要是 1 以上的整数（每对象自己数）。')
    if (typeof raw.updated_at !== 'string' || Number.isNaN(Date.parse(raw.updated_at)))
      throw new StandInKolSyncError('invalid_input', '同步里有一条的时间不合法。')
    if (typeof raw.writer !== 'string' || raw.writer.trim() === '')
      throw new StandInKolSyncError('invalid_input', '同步里有一条没带机器标识。')
    const base: KolSyncObject = {
      kind: raw.kind,
      id: raw.id,
      version: raw.version,
      updated_at: raw.updated_at,
      writer: raw.writer,
    }
    if (raw.deleted === true) return { ...base, deleted: true }
    return raw.body === undefined ? base : { ...base, body: raw.body }
  }

  push(request: KolSyncPushRequest): KolSyncPushResult {
    this.gate()
    if ((request.writer ?? '').trim() === '')
      throw new StandInKolSyncError(
        'invalid_input',
        '这次同步没带机器标识（writer），没法判谁写的。',
      )
    const objects = request.objects ?? []
    if (objects.length > KOL_SYNC_MAX_BATCH)
      throw new StandInKolSyncError(
        'invalid_input',
        `一次最多推 ${String(KOL_SYNC_MAX_BATCH)} 条，这次 ${String(objects.length)} 条。分几批再试。`,
      )
    const at = this.now()
    const rejected: KolSyncObject[] = []
    const conflicts: KolSyncConflict[] = []
    let accepted = 0
    for (const raw of objects) {
      const candidate = this.validate(raw)
      const current = this.current(candidate.kind, candidate.id)
      if (current === undefined || candidate.version > current.version) {
        this.put(candidate)
        accepted += 1
        continue
      }
      if (
        current.version === candidate.version &&
        current.updated_at === candidate.updated_at &&
        current.writer === candidate.writer
      )
        continue
      const candidateWins = kolWinsOver(candidate, current)
      const winner = candidateWins ? candidate : current
      const loser = candidateWins ? current : candidate
      const conflict: KolSyncConflict = {
        kind: candidate.kind,
        id: candidate.id,
        winner,
        loser,
        at,
      }
      const conflict_id = `cfl_${candidate.kind}_${candidate.id}_${loser.updated_at}`
      if (!this.conflictRows.has(conflict_id))
        this.conflictRows.set(conflict_id, structuredClone({ ...conflict, conflict_id }))
      conflicts.push(conflict)
      if (candidateWins) {
        this.put({ ...candidate, version: current.version + 1 })
        accepted += 1
        rejected.push(this.current(candidate.kind, candidate.id) as KolSyncObject)
      } else rejected.push(current)
    }
    this.lastSync = at
    return { accepted, rejected, conflicts, cursor: String(this.seq), at }
  }

  pull(args: { cursor?: string; writer?: string; limit?: number }): KolSyncPullResult {
    this.gate()
    const from = Number(args.cursor ?? '0')
    const cursor = Number.isFinite(from) && from > 0 ? from : 0
    const limit = Math.min(Math.max(1, args.limit ?? KOL_SYNC_MAX_BATCH), KOL_SYNC_MAX_BATCH)
    const writer = args.writer?.trim()
    const rows = [...this.rows.values()]
      .filter((r) => r.seq > cursor)
      .filter((r) => writer === undefined || writer === '' || r.object.writer !== writer)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, limit + 1)
    const has_more = rows.length > limit
    const page = has_more ? rows.slice(0, limit) : rows
    const at = this.now()
    this.lastSync = at
    const last = page[page.length - 1]
    const next = last === undefined && !has_more ? this.seq : (last?.seq ?? cursor)
    return {
      objects: page.map((r) => structuredClone(r.object)),
      cursor: String(next),
      has_more,
      at,
    }
  }

  private openConflicts(): ConflictRow[] {
    return [...this.conflictRows.values()]
      .filter((c) => c.resolved_at === undefined)
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
  }

  status(): KolSyncStatus {
    const live = [...this.rows.values()].filter((r) => r.object.deleted !== true)
    const byKind = new Map<KolObjectKind, number>()
    for (const r of live) byKind.set(r.object.kind, (byKind.get(r.object.kind) ?? 0) + 1)
    return {
      org_id: this.org_id,
      subscription: { ...this.sub },
      object_count: live.length,
      by_kind: [...byKind]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([kind, count]) => ({ kind, count })),
      cursor: String(this.seq),
      pending_conflicts: this.openConflicts().length,
      ...(this.lastSync === undefined ? {} : { last_sync_at: this.lastSync }),
      at: this.now(),
    }
  }

  conflicts(limit = 200): KolSyncConflictList {
    this.gate()
    const open = this.openConflicts()
    return {
      org_id: this.org_id,
      conflicts: open
        .slice(0, limit)
        .map(({ resolved_at: _r, ...c }): KolSyncConflictEntry => structuredClone(c)),
      pending_conflicts: open.length,
      at: this.now(),
    }
  }

  resolveConflicts(input: { kind: string; id: string }): KolSyncConflictResolveResult {
    this.gate()
    if (!isKolObjectKind(input.kind))
      throw new StandInKolSyncError('invalid_input', '这个对象种类不认识（kind 不在清单里）。')
    const id = (input.id ?? '').trim()
    if (id === '') throw new StandInKolSyncError('invalid_input', '没说要处理哪一条（缺 id）。')
    const at = this.now()
    let resolved = 0
    for (const c of this.openConflicts())
      if (c.kind === input.kind && c.id === id) {
        c.resolved_at = at
        resolved += 1
      }
    return {
      org_id: this.org_id,
      kind: input.kind,
      id,
      resolved,
      pending_conflicts: this.openConflicts().length,
      at,
    }
  }

  exportAll(): KolCloudExport {
    return {
      format: 1,
      org_id: this.org_id,
      at: this.now(),
      subscription: { ...this.sub },
      objects: [...this.rows.values()]
        .map((r) => structuredClone(r.object))
        .sort((a, b) =>
          a.kind !== b.kind ? (a.kind < b.kind ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
        ),
      // 含已处理的（点过「处理完了」不等于同意把那一份扔掉），新的在前
      conflicts: [...this.conflictRows.values()]
        .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
        .map(({ resolved_at: _r, conflict_id: _id, ...c }) => structuredClone(c)),
    }
  }

  /** 测试里直接看云上那本账（不经协议）：每条对象原样。 */
  rawObjects(): KolSyncObject[] {
    return [...this.rows.values()].map((r) => structuredClone(r.object))
  }
}
