/**
 * 红人营销增值服务的**本地那一头**（67 §3，WP118）。
 *
 * 云上那一半（`packages/kol-cloud`）早就在了：租户私有的库、双向同步的四条路由、
 * 订阅闸门。这个文件是缺的另一半——**本地这本账**：
 *
 * 1. **变更日志**：本地改了哪几条、改到第几版、推上去没有；
 * 2. **离线队列**：云连不通 / 没订阅 / 欠费暂停的时候，改动照样记在本地，
 *    一条不丢，等能同步了一次推上去；
 * 3. **冲突不静默丢**：两头各改各的那一条，赢了的是当前值，**输的那一份留着**，
 *    界面上标出来，用户能挑回来。
 *
 * 三条设计上的决定，都是为了让"本地这一份"不出事：
 *
 * - **变更靠快照比对，不靠拦写入**。红人库有十几个写口子（工具、审批施行、演练、
 *   归因回填、合并），逐个挂钩子等于每加一个写口子都要记得来这儿登记一次；漏一个
 *   就是"这条改了但云上永远不知道"。快照比对慢一点（本地库几百到几千行），
 *   但**漏不掉**。
 * - **版本号每对象自己数，判胜负才看时间**。与云上那一条逐字相同（见
 *   `packages/contracts/src/kol-cloud.ts` 的 `kolWinsOver`）：两台机器的钟差几秒
 *   是常事，用时间当版本号会让"谁更新"变成"谁的钟快"。
 * - **演练数据一条不上云**。演练那 24 个合成红人是本地 playground 的东西，
 *   推进用户花钱买的那本云库里，等于往他的资产里掺假数据（WP117b 同一条纪律：
 *   演练数据不进真漏斗、不进归因）。判据见 {@link isSandboxRow}。
 */
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type {
  Clock,
  KolCloudConflictView,
  KolCloudLocalStatus,
  KolCloudSyncRun,
  KolObjectKind,
  KolSyncConflict,
  KolSyncObject,
  KolSyncPullResult,
  KolSyncPushResult,
  KolSyncStatus,
  SubscriptionStatus,
} from '@agentsws/contracts'
import {
  isKolObjectKind,
  KOL_SYNC_MAX_BATCH,
  kolWinsOver,
  subscriptionUsable,
} from '@agentsws/contracts'
import type BetterSqlite3 from 'better-sqlite3'
import type { KolStore, KolTable } from './kol.js'

/* ------------------------------------------------------------------ */
/* 种类 ⇄ 本地那张表                                                    */
/* ------------------------------------------------------------------ */

/**
 * 本地这一版**有表**的那些种类。
 *
 * `campaign` / `candidate` / `note` 是契约先行的三个（云上已经能存），本地还没有
 * 表——从云上拉下来也无处可放。这类条数**报出来**（`KolCloudSyncRun.skipped`），
 * 不静默扔掉：本地补上表之后自动开始同步，协议一个字不用改。
 */
export const LOCAL_KINDS: readonly KolObjectKind[] = [
  'creator',
  'platform_account',
  'creator_contact',
  'collaboration',
  'deliverable',
  'tracked_link',
  'exchange',
]

/** 种类 → 本地表名。七个一一对应（`apps/server/src/kol.ts` 的七张表）。 */
export function tableOfKind(kind: KolObjectKind): KolTable | undefined {
  return (LOCAL_KINDS as readonly string[]).includes(kind) ? (kind as KolTable) : undefined
}

/** 演练那一批的 id 前缀（`apps/server/src/kol-sandbox.ts` 的 `SANDBOX_ID_PREFIX`）。 */
const SANDBOX_PREFIX = 'sbx_'

/**
 * 这一行是不是演练数据（是就不上云）。
 *
 * 三条判据，任何一条命中就算：
 *
 * 1. 行上自己写着 `sandbox: true`（红人、合作、往来信件三类有这个字段）；
 * 2. id 带演练前缀（账号 / 联系方式 / 合作 / 信件都是 `sbx_…` 生成的）；
 * 3. 挂在那条演练合作下的交付物与追踪链接（这两类自己身上没有标记，
 *    只能顺着 `collaboration_id` 认）。
 */
export function isSandboxRow(kind: KolObjectKind, body: Record<string, unknown>): boolean {
  if (body.sandbox === true) return true
  const id = typeof body.id === 'string' ? body.id : ''
  if (id.startsWith(SANDBOX_PREFIX)) return true
  const parent = body.collaboration_id
  if (kind === 'deliverable' || kind === 'tracked_link')
    return typeof parent === 'string' && parent.startsWith(SANDBOX_PREFIX)
  return false
}

/** 稳定序列化：键排序之后再 stringify。 */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** 界面上认得出这是谁：名字 → handle → 链接 → id（总得有个能认的）。 */
export function labelOf(kind: KolObjectKind, body: Record<string, unknown> | undefined): string {
  if (body === undefined) return kind
  const text = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() === '' ? undefined : typeof v === 'string' ? v : undefined
  return text(body.display_name) ?? text(body.handle) ?? text(body.url) ?? text(body.id) ?? kind
}

/** `(kind,id)` → 一个字符串主键。中间那个 0 字节是为了 `note_1` 与 `note` + `1` 不撞。 */
export const keyOf = (kind: string, id: string): string => `${kind}\u0000${id}`

/** 冲突 id 由内容推出来（与云上同一个推法）：同一批重放不会记出两条。 */
export const conflictIdOf = (kind: string, id: string, loser_updated_at: string): string =>
  `cfl_${kind}_${id}_${loser_updated_at}`

/* ------------------------------------------------------------------ */
/* 本地这本账                                                           */
/* ------------------------------------------------------------------ */

/** 一个对象上一次同步之后的样子（版本号就存在这儿）。 */
export interface SyncStateRow {
  kind: KolObjectKind
  id: string
  version: number
  updated_at: string
  writer: string
  /** 上一次同步时的正文（稳定序列化）。与本地当前正文一比就知道改没改。 */
  json: string
  deleted: boolean
}

/** 本地记着的一条冲突（云上记的那一本在云上，两本一起在界面上标出来）。 */
export interface SyncConflictRow {
  conflict_id: string
  kind: KolObjectKind
  id: string
  at: string
  winner: KolSyncObject
  loser: KolSyncObject
  /** 这一条是哪一本记的。 */
  source: 'cloud' | 'local'
  resolved: boolean
}

interface SyncBackend {
  state(kind: string, id: string): SyncStateRow | undefined
  allState(): SyncStateRow[]
  putState(row: SyncStateRow): void
  meta(key: string): string | undefined
  setMeta(key: string, value: string): void
  putConflict(row: SyncConflictRow): void
  conflicts(): SyncConflictRow[]
  resolveConflict(conflict_id: string): void
  close(): void
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kol_sync_state (
  kind TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL,
  updated_at TEXT NOT NULL, writer TEXT NOT NULL, json TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (kind, id)
);
CREATE TABLE IF NOT EXISTS kol_sync_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS kol_sync_conflicts (
  conflict_id TEXT PRIMARY KEY, kind TEXT NOT NULL, id TEXT NOT NULL, at TEXT NOT NULL,
  winner TEXT NOT NULL, loser TEXT NOT NULL, source TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0
);
`

function createMemoryBackend(): SyncBackend {
  const state = new Map<string, SyncStateRow>()
  const meta = new Map<string, string>()
  const conflicts = new Map<string, SyncConflictRow>()
  return {
    state: (kind, id) => state.get(keyOf(kind, id)),
    allState: () => [...state.values()],
    putState: (row) => {
      state.set(keyOf(row.kind, row.id), { ...row })
    },
    meta: (key) => meta.get(key),
    setMeta: (key, value) => {
      meta.set(key, value)
    },
    putConflict: (row) => {
      conflicts.set(row.conflict_id, { ...row })
    },
    conflicts: () => [...conflicts.values()],
    resolveConflict: (cid) => {
      const found = conflicts.get(cid)
      if (found !== undefined) conflicts.set(cid, { ...found, resolved: true })
    },
    close: () => {
      state.clear()
      meta.clear()
      conflicts.clear()
    },
  }
}

function createSqliteBackend(path: string): SyncBackend {
  const require = createRequire(import.meta.url)
  const Database = require('better-sqlite3') as typeof BetterSqlite3
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA)
  const rowOf = (r: Record<string, unknown>): SyncStateRow => ({
    kind: String(r.kind) as KolObjectKind,
    id: String(r.id),
    version: Number(r.version),
    updated_at: String(r.updated_at),
    writer: String(r.writer),
    json: String(r.json),
    deleted: Number(r.deleted) === 1,
  })
  return {
    state: (kind, id) => {
      const r = db
        .prepare('SELECT * FROM kol_sync_state WHERE kind = ? AND id = ?')
        .get(kind, id) as Record<string, unknown> | undefined
      return r === undefined ? undefined : rowOf(r)
    },
    allState: () =>
      (
        db.prepare('SELECT * FROM kol_sync_state ORDER BY kind, id').all() as Record<
          string,
          unknown
        >[]
      ).map(rowOf),
    putState: (row) => {
      db.prepare(
        `INSERT INTO kol_sync_state (kind,id,version,updated_at,writer,json,deleted)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(kind,id) DO UPDATE SET version=excluded.version, updated_at=excluded.updated_at,
           writer=excluded.writer, json=excluded.json, deleted=excluded.deleted`,
      ).run(
        row.kind,
        row.id,
        row.version,
        row.updated_at,
        row.writer,
        row.json,
        row.deleted ? 1 : 0,
      )
    },
    meta: (key) => {
      const r = db.prepare('SELECT value FROM kol_sync_meta WHERE key = ?').get(key) as
        | { value: string }
        | undefined
      return r?.value
    },
    setMeta: (key, value) => {
      db.prepare(
        'INSERT INTO kol_sync_meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      ).run(key, value)
    },
    putConflict: (row) => {
      db.prepare(
        `INSERT INTO kol_sync_conflicts (conflict_id,kind,id,at,winner,loser,source,resolved)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(conflict_id) DO UPDATE SET at=excluded.at, winner=excluded.winner,
           loser=excluded.loser, source=excluded.source, resolved=excluded.resolved`,
      ).run(
        row.conflict_id,
        row.kind,
        row.id,
        row.at,
        JSON.stringify(row.winner),
        JSON.stringify(row.loser),
        row.source,
        row.resolved ? 1 : 0,
      )
    },
    conflicts: () =>
      (
        db
          .prepare('SELECT * FROM kol_sync_conflicts ORDER BY at DESC, conflict_id')
          .all() as Record<string, unknown>[]
      ).map((r) => ({
        conflict_id: String(r.conflict_id),
        kind: String(r.kind) as KolObjectKind,
        id: String(r.id),
        at: String(r.at),
        winner: JSON.parse(String(r.winner)) as KolSyncObject,
        loser: JSON.parse(String(r.loser)) as KolSyncObject,
        source: r.source === 'local' ? 'local' : 'cloud',
        resolved: Number(r.resolved) === 1,
      })),
    resolveConflict: (cid) => {
      db.prepare('UPDATE kol_sync_conflicts SET resolved = 1 WHERE conflict_id = ?').run(cid)
    },
    close: () => db.close(),
  }
}

/* ------------------------------------------------------------------ */
/* 同步引擎                                                             */
/* ------------------------------------------------------------------ */

/** 打云侧一跳的结果。**错误不抛**——连不通与欠费都是业务里正常的一半。 */
export interface KolCloudCall<T> {
  ok: boolean
  /** HTTP 状态；`0` = 根本没打通（没关联账号 / 超时 / 网络错）。 */
  status: number
  data?: T
  /** 云侧信封里的码（`payment_required` …）。 */
  code?: string
  /** 云侧那句人话（直接进界面）。 */
  message?: string
}

/** 打云侧那一跳（`apps/server/src/cloud.ts` 提供：令牌只在那一处出现）。 */
export type KolCloudCallFn = <T>(
  path: string,
  init?: { method?: string; body?: unknown },
) => Promise<KolCloudCall<T>>

export interface KolCloudSyncOptions {
  clock: Clock
  /** 这个品牌的红人库。递取值函数：装配期它可能还没建出来。 */
  store: () => KolStore | undefined
  call: KolCloudCallFn
  /** 关联了 agentsws 账号没有。 */
  linked: () => boolean
  /** 落盘目录（这个品牌自己的那一段）。不给就全内存（测试与一次性任务）。 */
  dbDir?: string
  /** 没关联账号时那句人话（与「账号与积分」那张卡同一句）。 */
  notLinkedMessage?: string
  /** 测试注入的机器标识。不给就生成一个并落盘（重装才换）。 */
  deviceId?: string
}

export interface KolCloudSync {
  /** 这台机器的标识（同步协议里的 `writer`）。 */
  deviceId(): string
  /** 本地攒着还没推上去的条数（离线队列的深度）。 */
  pending(): number
  status(): Promise<KolCloudLocalStatus>
  /** 走一趟：把本地改过的推上去，再把云上改过的拉下来。 */
  sync(): Promise<KolCloudSyncRun>
  /** 界面上要标出来的冲突（云上那本在前，本地这本在后；已处理的不出现）。 */
  conflicts(): KolCloudConflictView[]
  /**
   * 一条冲突怎么处理：`winner` = 就这样（当前值不动），`loser` = 把被盖掉的那一份
   * 挑回来（写进本地，下一趟推上去）。两种都**不删另一份**——账上留着。
   */
  resolveConflict(input: {
    kind: KolObjectKind
    id: string
    pick: 'winner' | 'loser'
  }): Promise<KolCloudSyncRun>
  close(): void
}

/** 没关联账号时的那句（与 `cloud.ts` 的 `NOT_LINKED` 同一句话，同一件事）。 */
export const KOL_CLOUD_NOT_LINKED =
  '还没关联 agentsws 账号。去"设置 → 账号与积分"里关联一次，才能把红人库同步到云上。'

/** 云连不通时的那句。**不说"失败"**——本地这一份一条没丢，说清楚这一点最要紧。 */
export const KOL_CLOUD_UNREACHABLE =
  '云上暂时联系不上。你的红人库在本地一条没动，改动都排着队，等连上会自动补同步。'

/** 本地库还没建出来（品牌刚建 / 已关）时那一句。 */
export const KOL_CLOUD_NO_STORE = '这个品牌还没有红人库，没有可同步的东西。'

export function createKolCloudSync(options: KolCloudSyncOptions): KolCloudSync {
  const { clock, call } = options
  const backend: SyncBackend =
    options.dbDir === undefined
      ? createMemoryBackend()
      : createSqliteBackend(join(options.dbDir, 'kol-sync.sqlite'))

  const notLinked = options.notLinkedMessage ?? KOL_CLOUD_NOT_LINKED
  const deviceId = options.deviceId ?? backend.meta('device_id') ?? newDeviceId()
  if (options.deviceId === undefined && backend.meta('device_id') === undefined)
    backend.setMeta('device_id', deviceId)

  const now = (): string => clock.now()

  /* ---------------- 本地快照与差异 ---------------- */

  /** 本地这一本现在的样子（演练那一批不在里面）。 */
  const snapshot = (): { kind: KolObjectKind; id: string; body: Record<string, unknown> }[] => {
    const store = options.store()
    if (store === undefined) return []
    const rows: { kind: KolObjectKind; id: string; body: Record<string, unknown> }[] = []
    const push = (kind: KolObjectKind, list: readonly { id: string }[]): void => {
      for (const row of list) {
        const body = row as unknown as Record<string, unknown>
        if (isSandboxRow(kind, body)) continue
        rows.push({ kind, id: row.id, body })
      }
    }
    push('creator', store.creators())
    push('platform_account', store.accounts())
    push('creator_contact', store.contacts())
    push('collaboration', store.collaborations())
    push('deliverable', store.deliverables())
    push('tracked_link', store.links())
    push('exchange', store.exchanges())
    return rows
  }

  /**
   * 本地改过、还没推上去的那些（**这就是离线队列**）。
   *
   * 两种情况算"改过"：账上没有这一条（新的），或者账上那一份的正文与本地当前的
   * 不一样（改过）。另外账上有、本地已经没有了的，推一条**墓碑**——不推的话，
   * 另一台机器上那一条会被当成新对象推回来，删不掉。
   */
  const diff = (): KolSyncObject[] => {
    const at = now()
    const seen = new Set<string>()
    const out: KolSyncObject[] = []
    for (const row of snapshot()) {
      const key = keyOf(row.kind, row.id)
      seen.add(key)
      const json = stableJson(row.body)
      const state = backend.state(row.kind, row.id)
      if (state !== undefined && state.deleted !== true && state.json === json) continue
      out.push({
        kind: row.kind,
        id: row.id,
        version: (state?.version ?? 0) + 1,
        updated_at: at,
        writer: deviceId,
        body: row.body,
      })
    }
    for (const state of backend.allState()) {
      if (state.deleted === true) continue
      if (seen.has(keyOf(state.kind, state.id))) continue
      if (tableOfKind(state.kind) === undefined) continue
      out.push({
        kind: state.kind,
        id: state.id,
        version: state.version + 1,
        updated_at: at,
        writer: deviceId,
        deleted: true,
      })
    }
    return out
  }

  /** 账上那一行 → 同步协议里的那个对象（判胜负要用同一把尺）。 */
  const asObject = (row: SyncStateRow): KolSyncObject => ({
    kind: row.kind,
    id: row.id,
    version: row.version,
    updated_at: row.updated_at,
    writer: row.writer,
    ...(row.deleted
      ? { deleted: true }
      : { body: JSON.parse(row.json) as Record<string, unknown> }),
  })

  /* ---------------- 写回本地 ---------------- */

  /**
   * 把云上的一个对象写进本地库。
   *
   * 回 `false` 表示**没写**：本地这一份更新（还没推上去），盖掉它就是丢掉用户刚写的
   * 东西——这时候记一条冲突，等本地那一份推上去时由版本号定胜负。
   */
  const applyRemote = (object: KolSyncObject): boolean => {
    const store = options.store()
    if (store === undefined) return false
    const table = tableOfKind(object.kind)
    if (table === undefined) return false
    const state = backend.state(object.kind, object.id)
    if (state !== undefined && !kolWinsOver(object, asObject(state))) {
      recordConflict({ kind: object.kind, id: object.id, winner: asObject(state), loser: object })
      return false
    }
    if (object.deleted === true) {
      // 库里没有这一条也不报错：删两次与删一次的结果一样
      store.removeRow(table, object.id)
    } else {
      writeRow(store, object.kind, object.body ?? {})
    }
    backend.putState({
      kind: object.kind,
      id: object.id,
      version: object.version,
      updated_at: object.updated_at,
      writer: object.writer,
      json: object.deleted === true ? '{}' : stableJson(object.body ?? {}),
      deleted: object.deleted === true,
    })
    return true
  }

  const recordConflict = (
    input: Omit<KolSyncConflict, 'at'> & { at?: string; source?: 'cloud' | 'local' },
  ): void => {
    backend.putConflict({
      conflict_id: conflictIdOf(input.kind, input.id, input.loser.updated_at),
      kind: input.kind,
      id: input.id,
      at: input.at ?? now(),
      winner: input.winner,
      loser: input.loser,
      source: input.source ?? 'local',
      resolved: false,
    })
  }

  /* ---------------- 一趟同步 ---------------- */

  const pushAll = async (
    objects: KolSyncObject[],
  ): Promise<{ ok: boolean; pushed: number; conflicts: number; message?: string }> => {
    let pushed = 0
    let conflicts = 0
    for (let i = 0; i < objects.length; i += KOL_SYNC_MAX_BATCH) {
      const batch = objects.slice(i, i + KOL_SYNC_MAX_BATCH)
      const res = await call<KolSyncPushResult>('/v1/kol/sync/push', {
        method: 'POST',
        body: { writer: deviceId, objects: batch },
      })
      if (!res.ok || res.data === undefined)
        return {
          ok: false,
          pushed,
          conflicts,
          ...(res.message === undefined ? {} : { message: res.message }),
        }
      const rejected = new Map(res.data.rejected.map((r) => [keyOf(r.kind, r.id), r]))
      for (const conflict of res.data.conflicts) {
        recordConflict({ ...conflict, source: 'cloud' })
        conflicts += 1
      }
      for (const sent of batch) {
        const back = rejected.get(keyOf(sent.kind, sent.id))
        if (back !== undefined) {
          /*
           * 云上那一份赢了（或者赢的那一份被云端接着版本号往上数了一格）：
           * 以云上回来的这一份为准写回本地，两本账才收敛。
           */
          applyRemote(back)
          continue
        }
        backend.putState({
          kind: sent.kind,
          id: sent.id,
          version: sent.version,
          updated_at: sent.updated_at,
          writer: sent.writer,
          json: sent.deleted === true ? '{}' : stableJson(sent.body ?? {}),
          deleted: sent.deleted === true,
        })
        pushed += 1
      }
    }
    return { ok: true, pushed, conflicts }
  }

  const pullAll = async (): Promise<{
    ok: boolean
    pulled: number
    skipped: number
    conflicts: number
    message?: string
  }> => {
    let cursor = backend.meta('cursor') ?? ''
    let pulled = 0
    let skipped = 0
    let conflicts = 0
    for (let page = 0; page < 100; page++) {
      const query = new URLSearchParams({ writer: deviceId, limit: String(KOL_SYNC_MAX_BATCH) })
      if (cursor !== '') query.set('cursor', cursor)
      const res = await call<KolSyncPullResult>(`/v1/kol/sync/pull?${query.toString()}`)
      if (!res.ok || res.data === undefined)
        return {
          ok: false,
          pulled,
          skipped,
          conflicts,
          ...(res.message === undefined ? {} : { message: res.message }),
        }
      for (const object of res.data.objects) {
        if (!isKolObjectKind(object.kind) || tableOfKind(object.kind) === undefined) {
          // 契约先行的那三个种类：本地还没有表，报出来而不是悄悄扔掉
          skipped += 1
          continue
        }
        if (applyRemote(object)) pulled += 1
        else conflicts += 1
      }
      cursor = res.data.cursor
      backend.setMeta('cursor', cursor)
      if (!res.data.has_more) break
    }
    return { ok: true, pulled, skipped, conflicts }
  }

  /** 云上说有多少条（`status()` 那一跳顺手记下来，回执里就有数了）。 */
  let objectCount: number | undefined

  /** 一趟同步的回执（四个出口共用一个拼法，免得某一处少了一格）。 */
  const run = (
    ok: boolean,
    push: { pushed: number; conflicts: number },
    pull: { pulled: number; skipped: number; conflicts: number } | undefined,
    message?: string,
    at?: string,
  ): KolCloudSyncRun => ({
    ok,
    ...(message === undefined ? {} : { message }),
    pushed: push.pushed,
    pulled: pull?.pulled ?? 0,
    conflicts: push.conflicts + (pull?.conflicts ?? 0),
    skipped: pull?.skipped ?? 0,
    ...(objectCount === undefined ? {} : { object_count: objectCount }),
    pending: pending(),
    ...(backend.meta('last_sync_at') === undefined
      ? {}
      : { last_sync_at: backend.meta('last_sync_at') as string }),
    at: at ?? now(),
  })

  const sync = async (): Promise<KolCloudSyncRun> => {
    const at = now()
    if (options.store() === undefined)
      return {
        ok: false,
        message: KOL_CLOUD_NO_STORE,
        pushed: 0,
        pulled: 0,
        conflicts: 0,
        skipped: 0,
        pending: 0,
        at,
      }
    if (!options.linked()) return run(false, { pushed: 0, conflicts: 0 }, undefined, notLinked, at)
    const push = await pushAll(diff())
    if (!push.ok) return run(false, push, undefined, push.message ?? KOL_CLOUD_UNREACHABLE, at)
    const pull = await pullAll()
    if (!pull.ok) return run(false, push, pull, pull.message ?? KOL_CLOUD_UNREACHABLE, at)
    const doneAt = now()
    backend.setMeta('last_sync_at', doneAt)
    return run(true, push, pull, undefined, doneAt)
  }

  const pending = (): number => diff().length

  const conflictViews = (): KolCloudConflictView[] =>
    backend
      .conflicts()
      .filter((c) => !c.resolved)
      .map((c) => ({
        kind: c.kind,
        id: c.id,
        at: c.at,
        winner: c.winner,
        loser: c.loser,
        label: labelOf(c.kind, c.winner.body ?? c.loser.body),
        source: c.source,
      }))

  const status = async (): Promise<KolCloudLocalStatus> => {
    const at = now()
    const base = {
      linked: options.linked(),
      cloud_reachable: false,
      pending: pending(),
      conflicts: conflictViews(),
      device_id: deviceId,
      at,
      ...(backend.meta('last_sync_at') === undefined
        ? {}
        : { last_sync_at: backend.meta('last_sync_at') as string }),
    }
    if (!base.linked) return { ...base, reason: notLinked }
    const res = await call<KolSyncStatus>('/v1/kol/sync/status')
    if (!res.ok || res.data === undefined)
      return { ...base, reason: res.message ?? KOL_CLOUD_UNREACHABLE }
    objectCount = res.data.object_count
    return {
      ...base,
      cloud_reachable: true,
      subscription: res.data.subscription,
      object_count: res.data.object_count,
      by_kind: res.data.by_kind,
      cloud_conflicts: res.data.pending_conflicts,
      ...(res.data.last_sync_at === undefined ? {} : { last_sync_at: res.data.last_sync_at }),
    }
  }

  const resolveConflict = async (input: {
    kind: KolObjectKind
    id: string
    pick: 'winner' | 'loser'
  }): Promise<KolCloudSyncRun> => {
    const at = now()
    const store = options.store()
    const rows = backend
      .conflicts()
      .filter((c) => !c.resolved && c.kind === input.kind && c.id === input.id)
    for (const row of rows) {
      backend.resolveConflict(row.conflict_id)
      /*
       * 挑回被盖掉的那一份：写进本地库，但**账上的正文不动**——这样下一趟
       * 快照比对就会把它当成一次本地改动推上去（版本号 +1，干净覆盖）。
       */
      if (input.pick === 'loser' && store !== undefined && row.loser.deleted !== true) {
        if (tableOfKind(row.kind) !== undefined) writeRow(store, row.kind, row.loser.body ?? {})
      }
    }
    // 云上那本也标一下（能标就标；标不了不影响本地这一趟）
    if (options.linked())
      await call('/v1/kol/sync/conflicts/resolve', {
        method: 'POST',
        body: { kind: input.kind, id: input.id },
      })
    return {
      ok: true,
      pushed: 0,
      pulled: 0,
      conflicts: rows.length,
      skipped: 0,
      pending: pending(),
      at,
    }
  }

  return {
    deviceId: () => deviceId,
    pending,
    status,
    sync,
    conflicts: conflictViews,
    resolveConflict,
    close: () => backend.close(),
  }
}

function newDeviceId(): string {
  return `device:${randomBytes(8).toString('hex')}`
}

/**
 * 把云上的一份正文写进本地那张表。
 *
 * 走 `KolStore` 自己的写口子（不是直接插库）：那七个 `saveX` 是这个库唯一的写入口，
 * 绕过它们就等于绕过以后可能加在那儿的任何一条纪律。
 */
function writeRow(store: KolStore, kind: KolObjectKind, body: Record<string, unknown>): void {
  switch (kind) {
    case 'creator':
      store.saveCreator(body as never)
      return
    case 'platform_account':
      store.saveAccount(body as never)
      return
    case 'creator_contact':
      store.saveContact(body as never)
      return
    case 'collaboration':
      store.saveCollaboration(body as never)
      return
    case 'deliverable':
      store.saveDeliverable(body as never)
      return
    case 'tracked_link':
      store.saveLink(body as never)
      return
    case 'exchange':
      store.saveExchange(body as never)
      return
    default:
      // 本地没有这张表（`campaign` / `candidate` / `note`）：调用方已经数进 skipped
      return
  }
}

/** 界面上那一句：这个订阅状态下同步能不能做、不能做的话为什么。 */
export function syncGateMessage(status: SubscriptionStatus, message?: string): string | undefined {
  if (subscriptionUsable(status)) return undefined
  if (message !== undefined) return message
  if (status === 'none')
    return '还没开通红人营销增值服务。开通之后（30 积分 / 月）红人库才开始往云上同步。'
  if (status === 'cancelling') return '这一期用完之后就不再同步了（当期照常用）。数据一条没动。'
  return '这个月的 30 积分没扣上，同步暂停了。**云上与本地的数据一条都没动**，充上值就自己接上。'
}
