/**
 * WP510（决策 1515，WP459-T2）：**同事 / 公司模式的收件箱**——服务进程这一侧。
 *
 * 四件事，只在 ② 同事互联 / ③ 公司集体里做事；① 个人里一律什么都不记、什么都不改：
 *
 * 1. **谁在看**（{@link TeamPresence}）：工作台 5 秒一跳「我开着哪一件」，20 秒没跳算离开。只在内存里。
 * 2. **上次在线**：每一次带岗位的请求记一笔（内存里实时，落盘 10 分钟最多一次）——「负责人不在」按它算。
 * 3. **邮箱负责人**（{@link TeamInboxStore}）：每只邮箱一人或多人；连同「多少天没上线算不在」「不在交给谁」
 *    存在品牌目录的 `team-inbox.json`。改一次写一条 `inbox.team_changed`（地址遮过）。
 * 4. **催促卡按负责人分**：出卡时收件人就是负责人（{@link TeamInbox.nudgeRecipients}）；还没定的卡懒扫一遍
 *    （{@link TeamInbox.sweep}）——负责人换了、负责人不在了 / 回来了，改派过去（同一条 `reroute`，卡上一句为什么）。
 *
 * 不替用户定规矩：天数、交给谁都是可配的；没上线记录的人不算不在。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ApiError, type TeamInboxPort } from '@agentsws/api'
import {
  type ApprovalBus,
  type ApprovalItem,
  type Clock,
  clampAwayDays,
  type EventEnvelope,
  INBOX_PRESENCE_TTL_MS,
  type InboxPresenceView,
  type InboxViewer,
  isAway,
  isFollowUpNudgePayload,
  type MailboxOwnersRow,
  mailboxKey,
  type OrganizationMode,
  type OwnerRoute,
  type PersonId,
  routeToOwners,
  TEAM_INBOX_DEFAULTS,
  type TeamInboxFallback,
  type TeamInboxPatch,
  type TeamInboxSettings,
  type TeamInboxView,
  type TeamMember,
  type WorkspaceId,
} from '@agentsws/contracts'
import { maskAddress } from './mailbox-actions.js'

/* ── 谁在看（全进程一份，按品牌分） ─────────────────────────────────────── */

interface Beat {
  name: string
  item: string
  at: number
}

export class TeamPresence {
  private readonly rows = new Map<string, Map<string, Beat>>()
  constructor(private readonly ttlMs = INBOX_PRESENCE_TTL_MS) {}

  /** 一跳：这个人现在开着哪一件（`null` = 没开着，立刻从别人那里消失）。 */
  beat(
    workspace_id: string,
    person_id: string,
    name: string,
    item: string | null,
    now: number,
  ): void {
    let ws = this.rows.get(workspace_id)
    if (ws === undefined) {
      ws = new Map()
      this.rows.set(workspace_id, ws)
    }
    if (item === null) ws.delete(person_id)
    else ws.set(person_id, { name, item, at: now })
  }

  /** 别人开着哪几件（不含 `except`；过了 TTL 的不算）。 */
  viewers(workspace_id: string, except: string, now: number): Record<string, InboxViewer[]> {
    const out: Record<string, InboxViewer[]> = {}
    const ws = this.rows.get(workspace_id)
    if (ws === undefined) return out
    for (const [person_id, b] of ws) {
      if (now - b.at > this.ttlMs) {
        ws.delete(person_id)
        continue
      }
      if (person_id === except) continue
      const list = out[b.item] ?? []
      list.push({ person_id, name: b.name })
      out[b.item] = list
    }
    return out
  }
}

/* ── 存档（品牌目录里一个 JSON） ─────────────────────────────────────────── */

interface StateFile {
  version: 1
  settings: TeamInboxSettings
  /** 键是小写地址。 */
  mailboxes: Record<string, PersonId[]>
  /** 人 → 上次在线。 */
  seen: Record<string, string>
}

const empty = (): StateFile => ({
  version: 1,
  settings: { ...TEAM_INBOX_DEFAULTS },
  mailboxes: {},
  seen: {},
})

export class TeamInboxStore {
  private readonly file: string | undefined
  private state: StateFile

  constructor(options: { dir?: string } = {}) {
    this.file = options.dir === undefined ? undefined : join(options.dir, 'team-inbox.json')
    this.state = this.load()
  }

  settings(): TeamInboxSettings {
    return { ...this.state.settings }
  }

  owners(account: string): PersonId[] {
    return [...(this.state.mailboxes[mailboxKey(account)] ?? [])]
  }

  seen(): Record<string, string> {
    return { ...this.state.seen }
  }

  setSettings(next: TeamInboxSettings): void {
    this.state = { ...this.state, settings: { ...next } }
    this.save()
  }

  setOwners(account: string, owners: readonly PersonId[]): void {
    const mailboxes = { ...this.state.mailboxes }
    const list = [...new Set(owners)]
    if (list.length === 0) delete mailboxes[mailboxKey(account)]
    else mailboxes[mailboxKey(account)] = list
    this.state = { ...this.state, mailboxes }
    this.save()
  }

  /** 记上线；`persist` = 落盘（调用方节流）。 */
  setSeen(person_id: string, at: string, persist: boolean): void {
    this.state = { ...this.state, seen: { ...this.state.seen, [person_id]: at } }
    if (persist) this.save()
  }

  private load(): StateFile {
    if (this.file === undefined || !existsSync(this.file)) return empty()
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<StateFile>
      const s = (raw.settings ?? {}) as Partial<TeamInboxSettings>
      const fallback: TeamInboxFallback = s.fallback === 'position' ? 'position' : 'admins'
      const mailboxes: Record<string, PersonId[]> = {}
      for (const [k, v] of Object.entries(raw.mailboxes ?? {}))
        if (Array.isArray(v)) mailboxes[k] = v.filter((x): x is string => typeof x === 'string')
      const seen: Record<string, string> = {}
      for (const [k, v] of Object.entries(raw.seen ?? {})) if (typeof v === 'string') seen[k] = v
      return {
        version: 1,
        settings: {
          away_days: clampAwayDays(Number(s.away_days ?? TEAM_INBOX_DEFAULTS.away_days)),
          fallback,
          ...(typeof s.updated_at === 'string' ? { updated_at: s.updated_at } : {}),
          ...(typeof s.updated_by === 'string' ? { updated_by: s.updated_by } : {}),
        },
        mailboxes,
        seen,
      }
    } catch {
      // 文件坏了：按缺省走，下一次改的时候重写
      return empty()
    }
  }

  private save(): void {
    if (this.file === undefined) return
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, `${JSON.stringify(this.state, null, 2)}\n`)
  }
}

/* ── 一个品牌的团队收件箱 ───────────────────────────────────────────────── */

export interface TeamDirectory {
  mode: OrganizationMode
  /** 这个品牌里还在的人（名字、是不是发起人 / 管理员）；`last_seen_at` 由这里补。 */
  members: Omit<TeamMember, 'last_seen_at'>[]
}

export interface TeamInboxOptions {
  workspace_id: WorkspaceId
  clock: Clock
  dir?: string
  appendEvent(e: Omit<EventEnvelope, 'id' | 'at'> & { at?: string }): void
  /** 用法与同事（装配方从组织面与身份层读；组织面装得晚，读不到当 ①）。 */
  directory(): Promise<TeamDirectory>
  /** 这个品牌的邮箱地址（连着的 + 消息库里有信的，同消息页左栏那一列）。 */
  mailboxes(): readonly string[] | Promise<readonly string[]>
  /** 同岗位的同事：做这条职责的人（「不在交给同岗位的同事」用）。 */
  holdersOf(role_id: string): readonly PersonId[]
  approvals: Pick<ApprovalBus, 'queue' | 'reroute'>
}

export interface TeamInbox {
  /** 同事 + 上次在线；① 时 `mode: 'solo'`。 */
  team(): Promise<{ mode: OrganizationMode; members: TeamMember[] }>
  /** 一只邮箱现在该给谁（① 或没指定负责人：`to` 空）。 */
  route(account: string, role_id?: string): Promise<OwnerRoute>
  view(person_id: PersonId): Promise<TeamInboxView>
  update(person_id: PersonId, patch: TeamInboxPatch): Promise<TeamInboxView>
  /** 记上线（每次带岗位的请求）。 */
  touch(person_id: PersonId): void
  /**
   * 催促卡出卡时给谁：这只邮箱有负责人就是负责人（都不在 → 兜底的人，卡上带一句为什么）；
   * 没有负责人 / ① → `undefined`（按老规矩给岗位的人）。
   */
  nudgeRecipients(
    account: string,
    role_id: string,
  ): Promise<{ person: PersonId; reason?: string }[] | undefined>
  /** 懒扫：还没定的催促卡按负责人改派。回改了几张。① 什么都不做。 */
  sweep(): Promise<number>
}

/** 落盘节流：同一个人 10 分钟最多写一次上线时刻。 */
const SEEN_PERSIST_MS = 10 * 60_000
/** 懒扫节流：30 秒最多一遍。 */
const SWEEP_EVERY_MS = 30_000

export function createTeamInbox(options: TeamInboxOptions): TeamInbox {
  const { workspace_id, clock } = options
  const store = new TeamInboxStore(options.dir === undefined ? {} : { dir: options.dir })
  const persistedAt = new Map<string, number>()
  let lastSweep = 0

  const team = async (): Promise<{ mode: OrganizationMode; members: TeamMember[] }> => {
    let dir: TeamDirectory
    try {
      dir = await options.directory()
    } catch {
      return { mode: 'solo', members: [] }
    }
    const seen = store.seen()
    return {
      mode: dir.mode,
      members: dir.members.map((m) => {
        const at = seen[m.person_id]
        return at === undefined ? { ...m } : { ...m, last_seen_at: at }
      }),
    }
  }

  const routeWith = (
    t: { mode: OrganizationMode; members: TeamMember[] },
    account: string,
    role_id: string | undefined,
  ): OwnerRoute => {
    if (t.mode === 'solo') return { to: [], owners: [], fallback: false, away: [] }
    const settings = store.settings()
    const fallbackPeople =
      settings.fallback === 'position' && role_id !== undefined
        ? options.holdersOf(role_id)
        : t.members.filter((m) => m.admin).map((m) => m.person_id)
    return routeToOwners({
      owners: store.owners(account),
      members: t.members,
      now: clock.now(),
      away_days: settings.away_days,
      fallbackPeople,
    })
  }

  const names = (t: { members: TeamMember[] }, ids: readonly string[]): string =>
    ids
      .map((id) => t.members.find((m) => m.person_id === id)?.name ?? '')
      .filter((x) => x !== '')
      .join('、')

  /** 卡上那一句为什么转给他（只在兜底时写）。 */
  const reasonOf = (t: { members: TeamMember[] }, route: OwnerRoute): string | undefined =>
    route.fallback
      ? `邮箱负责人${names(t, route.away)}超过 ${store.settings().away_days} 天没上线，先交给你`
      : undefined

  const view = async (person_id: PersonId): Promise<TeamInboxView> => {
    const t = await team()
    const settings = store.settings()
    const me = t.members.find((m) => m.person_id === person_id)
    const can_edit =
      t.mode === 'peers' ? me !== undefined : t.mode === 'company' ? me?.admin === true : false
    const now = clock.now()
    const accounts = [...new Set((await options.mailboxes()).map(mailboxKey))]
    const mailboxes: MailboxOwnersRow[] = accounts.map((account) => ({
      account,
      owners: store.owners(account).filter((p) => t.members.some((m) => m.person_id === p)),
    }))
    return {
      mode: t.mode,
      me: person_id,
      can_edit,
      settings,
      mailboxes,
      members: t.members.map((m) => ({ ...m, away: isAway(m, now, settings.away_days) })),
    }
  }

  const emit = (by: PersonId, payload: Record<string, unknown>): void => {
    options.appendEvent({
      schema_version: 1,
      workspace_id,
      type: 'inbox.team_changed',
      actor: { kind: 'person', id: by },
      correlation: { trace_id: `tr_team_inbox_${clock.now()}` },
      payload,
    })
  }

  const update = async (person_id: PersonId, patch: TeamInboxPatch): Promise<TeamInboxView> => {
    const before = await view(person_id)
    if (before.mode === 'solo')
      throw new ApiError('conflict', '一个人用的时候没有收件箱分工（有同事一起用才出现）')
    if (!before.can_edit)
      throw new ApiError('forbidden', '公司模式里只有老板或管理员能改收件箱分工')
    const now = clock.now()
    if (patch.mailbox !== undefined) {
      const account = mailboxKey(patch.mailbox.account)
      if (!before.mailboxes.some((m) => m.account === account))
        throw new ApiError('not_found', '这只邮箱没有连着')
      const strangers = patch.mailbox.owners.filter(
        (p) => !before.members.some((m) => m.person_id === p),
      )
      if (strangers.length > 0) throw new ApiError('invalid_input', '负责人只能是这个品牌里的同事')
      store.setOwners(account, patch.mailbox.owners)
      emit(person_id, { account: maskAddress(account), owners: patch.mailbox.owners.length })
    }
    if (patch.away_days !== undefined || patch.fallback !== undefined) {
      const cur = store.settings()
      const next: TeamInboxSettings = {
        away_days: patch.away_days === undefined ? cur.away_days : clampAwayDays(patch.away_days),
        fallback: patch.fallback ?? cur.fallback,
        updated_at: now,
        updated_by: person_id,
      }
      store.setSettings(next)
      emit(person_id, { away_days: next.away_days, fallback: next.fallback })
    }
    lastSweep = 0
    return view(person_id)
  }

  const touch = (person_id: PersonId): void => {
    const now = clock.now()
    const ms = Date.parse(now)
    const last = persistedAt.get(person_id) ?? 0
    const persist = ms - last >= SEEN_PERSIST_MS
    if (persist) persistedAt.set(person_id, ms)
    store.setSeen(person_id, now, persist)
  }

  const nudgeRecipients: TeamInbox['nudgeRecipients'] = async (account, role_id) => {
    const t = await team()
    const route = routeWith(t, account, role_id)
    if (route.to.length === 0) return undefined
    const reason = reasonOf(t, route)
    return route.to.map((person) => (reason === undefined ? { person } : { person, reason }))
  }

  const sweep = async (): Promise<number> => {
    const nowMs = Date.parse(clock.now())
    if (nowMs - lastSweep < SWEEP_EVERY_MS) return 0
    lastSweep = nowMs
    const reroute = options.approvals.reroute
    if (reroute === undefined) return 0
    const t = await team()
    if (t.mode === 'solo') return 0
    const pending = new Map<string, ApprovalItem>()
    for (const m of t.members) {
      const rows = await options.approvals
        .queue({ workspace_id, person_id: m.person_id, lane: 'mine' })
        .catch(() => [] as ApprovalItem[])
      for (const i of rows) if (isFollowUpNudgePayload(i.payload)) pending.set(i.id, i)
    }
    let moved = 0
    for (const item of pending.values()) {
      if (!isFollowUpNudgePayload(item.payload)) continue
      const route = routeWith(t, item.payload.account, item.role_id)
      if (route.to.length === 0) continue
      const current = [...new Set(item.routing.recipients.map((r) => r.person))]
      if (current.some((p) => route.to.includes(p))) continue
      const reason = reasonOf(t, route) ?? '这只邮箱的负责人是你'
      const targets = route.to.filter((p) => !current.includes(p))
      for (let i = 0; i < current.length && i < targets.length; i += 1) {
        const from = current[i]
        const to = targets[i]
        if (from === undefined || to === undefined) continue
        const out = await reroute
          .call(options.approvals, item.id, { from, to, via: 'explicit', reason })
          .catch(() => undefined)
        if (out !== undefined) moved += 1
      }
    }
    return moved
  }

  return {
    team,
    route: async (account, role_id) => routeWith(await team(), account, role_id),
    view,
    update,
    touch,
    nudgeRecipients,
    sweep,
  }
}

/* ── 网关的端口（按请求的品牌转过去） ───────────────────────────────────── */

export function teamInboxPort(options: {
  presence: TeamPresence
  nowMs(): number
  brandOf(workspace_id: string): Promise<TeamInbox | undefined>
}): TeamInboxPort {
  const need = async (ws: string): Promise<TeamInbox | undefined> =>
    options.brandOf(ws).catch(() => undefined)
  const solo = { mode: 'solo' as const, members: [] as TeamMember[] }
  return {
    team: async (actor) => (await (await need(actor.workspace_id))?.team()) ?? solo,
    ownersOf: async (actor, account, role_id) =>
      (await (await need(actor.workspace_id))?.route(account, role_id)) ?? {
        to: [],
        owners: [],
        fallback: false,
        away: [],
      },
    view: async (actor) => {
      const b = await need(actor.workspace_id)
      if (b === undefined) throw new ApiError('not_implemented', '这个品牌没有收件箱的团队那一面')
      return b.view(actor.person_id)
    },
    update: async (actor, patch) => {
      const b = await need(actor.workspace_id)
      if (b === undefined) throw new ApiError('not_implemented', '这个品牌没有收件箱的团队那一面')
      return b.update(actor.person_id, patch)
    },
    presence: async (actor, item): Promise<InboxPresenceView> => {
      const b = await need(actor.workspace_id)
      const t = b === undefined ? solo : await b.team()
      // ① 个人：什么都不记、回空
      if (t.mode === 'solo') return { viewers: {} }
      const me = t.members.find((m) => m.person_id === actor.person_id)
      const now = options.nowMs()
      options.presence.beat(actor.workspace_id, actor.person_id, me?.name ?? '', item, now)
      return { viewers: options.presence.viewers(actor.workspace_id, actor.person_id, now) }
    },
    sweep: async (actor) => {
      await (await need(actor.workspace_id))?.sweep()
    },
  }
}
