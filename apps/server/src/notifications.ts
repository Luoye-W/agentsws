/**
 * WP429：**站内通知**的服务端——一张表（每人各自的）+ 从事件日志里认出「该告诉谁一声」的事。
 *
 * 卡 ≠ 通知（`@agentsws/contracts` 的 `notifications.ts`）：卡要人拍板；通知只是告诉一声、点了跳过去。
 *
 * 通知从两条路来：
 * 1. **事件日志**（{@link notificationsOfEvent}）：服务进程里所有事件都经同一个 `appendEvent`，那里顺手
 *    交给 {@link NotificationsService.onEvent}——同事接下 / 没接 / 退回了你交的事、上级派给你的、卡到了
 *    你这儿要你批（同事交给你的、审批到你的）、本周岗位更新到了、模型订阅要重新登录（WP430 的事件）；
 * 2. **装配处直接发**（{@link NotificationsService.notify}）：任务跑完 / 被停下、连接断了、积分快用完、
 *    同事回你了（WP417 替我答，原来是一张「知道了」卡）；
 * 3. **系统卡同步**（{@link NotificationsService.syncAlerts}，WP466）：原来首页告警区的 `system_alert`，
 *    每次铃铛来问时按本人现在挂着的那几张对一遍——新的进来、没了的收成已读（见 `alert-notifications.ts`）。
 *
 * 规矩：
 * - **同一件事合并**：同一个 `key` 还没读时再来一次，不另起一条——顶上来、计数加一；已读过的再来就重新变未读；
 * - 那件事办完了（卡定了 / 撤了 / 连接又连上了）就把同键还没读的那条收成已读（{@link NotificationsService.settle}）；
 * - 保留 30 天，一个人最多 500 条；
 * - 设置里关了的类别不记；「系统」开着的那一类来的时候标 `system`，桌面版据此弹系统通知。
 */
import { createRequire } from 'node:module'
import type { NotificationActor, NotificationsPort } from '@agentsws/api'
import {
  type ApprovalItem,
  type Clock,
  CONTENT_DIGEST_CARD_KIND,
  type EventEnvelope,
  type InboxNotification,
  isPluginDeskCard,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_MAX_PER_PERSON,
  NOTIFICATION_RETENTION_DAYS,
  type NotificationCategory,
  type NotificationInput,
  type NotificationList,
  type NotificationPrefs,
  type PersonId,
  resolveNotificationPrefs,
  type WorkspaceId,
} from '@agentsws/contracts'
import type { DeckCard } from '@agentsws/deck'
import type BetterSqlite3 from 'better-sqlite3'
import { ALERT_KEY_PREFIX, alertNotificationOf } from './alert-notifications.js'

type MaybeAsync<T> = T | Promise<T>

/** 存的那一份（偏好按人按品牌一份，只存人改过的格）。 */
type SavedPrefs = Partial<Record<NotificationCategory, { inbox?: boolean; system?: boolean }>>

interface Backend {
  /** 这个人在这个品牌里的全部（新的在前）。 */
  all(ws: WorkspaceId, person: PersonId): InboxNotification[]
  byKey(ws: WorkspaceId, person: PersonId, key: string): InboxNotification | undefined
  /** 这个品牌里同键的（不分人）。 */
  withKey(ws: WorkspaceId, key: string): InboxNotification[]
  put(row: InboxNotification): void
  remove(ids: readonly string[]): void
  /** 最后一次更新早于这一刻的全删，回删了几条。 */
  pruneBefore(at: string): number
  prefs(ws: WorkspaceId, person: PersonId): SavedPrefs | undefined
  setPrefs(ws: WorkspaceId, person: PersonId, prefs: SavedPrefs): void
  close(): void
}

const byNewest = (a: InboxNotification, b: InboxNotification): number =>
  b.updated_at.localeCompare(a.updated_at) || b.id.localeCompare(a.id)

/** WP466：没读的紧急档排最上面，其余照新的在前。 */
const urgentFirst = (a: InboxNotification, b: InboxNotification): number => {
  const ua = a.urgent === true && a.read_at === undefined ? 0 : 1
  const ub = b.urgent === true && b.read_at === undefined ? 0 : 1
  return ua - ub || byNewest(a, b)
}

function createMemoryBackend(): Backend {
  const rows = new Map<string, InboxNotification>()
  const prefs = new Map<string, SavedPrefs>()
  const who = (ws: string, p: string): string => `${ws}\u0000${p}`
  return {
    all: (ws, p) =>
      [...rows.values()]
        .filter((r) => r.workspace_id === ws && r.person_id === p)
        .sort(byNewest)
        .map((r) => ({ ...r })),
    byKey: (ws, p, key) => {
      const hit = [...rows.values()].find(
        (r) => r.workspace_id === ws && r.person_id === p && r.key === key,
      )
      return hit === undefined ? undefined : { ...hit }
    },
    withKey: (ws, key) =>
      [...rows.values()]
        .filter((r) => r.workspace_id === ws && r.key === key)
        .map((r) => ({ ...r })),
    put: (row) => {
      rows.set(row.id, { ...row })
    },
    remove: (ids) => {
      for (const id of ids) rows.delete(id)
    },
    pruneBefore: (at) => {
      let n = 0
      for (const [id, r] of rows)
        if (r.updated_at < at) {
          rows.delete(id)
          n += 1
        }
      return n
    },
    prefs: (ws, p) => prefs.get(who(ws, p)),
    setPrefs: (ws, p, v) => {
      prefs.set(who(ws, p), v)
    },
    close: () => {
      rows.clear()
      prefs.clear()
    },
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  key TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS notifications_who ON notifications (workspace_id, person_id, updated_at);
CREATE INDEX IF NOT EXISTS notifications_key ON notifications (workspace_id, key);
CREATE TABLE IF NOT EXISTS notification_prefs (
  workspace_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  json TEXT NOT NULL,
  PRIMARY KEY (workspace_id, person_id)
);
`

function createSqliteBackend(dbPath: string): Backend {
  const require = createRequire(import.meta.url)
  const Database = require('better-sqlite3') as typeof BetterSqlite3
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA)
  const parse = (rows: { json: string }[]): InboxNotification[] =>
    rows.map((r) => JSON.parse(r.json) as InboxNotification)
  const all = db.prepare(
    'SELECT json FROM notifications WHERE workspace_id = ? AND person_id = ? ORDER BY updated_at DESC, id DESC',
  )
  const byKey = db.prepare(
    'SELECT json FROM notifications WHERE workspace_id = ? AND person_id = ? AND key = ? LIMIT 1',
  )
  const withKey = db.prepare('SELECT json FROM notifications WHERE workspace_id = ? AND key = ?')
  const put = db.prepare(
    `INSERT INTO notifications (id, workspace_id, person_id, key, updated_at, json) VALUES (?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET key = excluded.key, updated_at = excluded.updated_at, json = excluded.json`,
  )
  const del = db.prepare('DELETE FROM notifications WHERE id = ?')
  const prune = db.prepare('DELETE FROM notifications WHERE updated_at < ?')
  const getPrefs = db.prepare(
    'SELECT json FROM notification_prefs WHERE workspace_id = ? AND person_id = ?',
  )
  const putPrefs = db.prepare(
    `INSERT INTO notification_prefs (workspace_id, person_id, json) VALUES (?,?,?)
     ON CONFLICT(workspace_id, person_id) DO UPDATE SET json = excluded.json`,
  )
  return {
    all: (ws, p) => parse(all.all(ws, p) as { json: string }[]),
    byKey: (ws, p, key) => parse(byKey.all(ws, p, key) as { json: string }[])[0],
    withKey: (ws, key) => parse(withKey.all(ws, key) as { json: string }[]),
    put: (r) => {
      put.run(r.id, r.workspace_id, r.person_id, r.key, r.updated_at, JSON.stringify(r))
    },
    remove: (ids) => {
      db.transaction(() => {
        for (const id of ids) del.run(id)
      })()
    },
    pruneBefore: (at) => prune.run(at).changes,
    prefs: (ws, p) => {
      const row = getPrefs.get(ws, p) as { json: string } | undefined
      return row === undefined ? undefined : (JSON.parse(row.json) as SavedPrefs)
    },
    setPrefs: (ws, p, v) => {
      putPrefs.run(ws, p, JSON.stringify(v))
    },
    close: () => {
      db.close()
    },
  }
}

/**
 * 从事件里认人、认标题要用到的几样（各品牌各一份，品牌装好时挂上）。都是只读的。
 */
export interface NotificationResolver {
  /** 人名（翻不出来回 undefined——那就写「同事」，不印 id）。 */
  personName(id: PersonId): MaybeAsync<string | undefined>
  /** 整个品牌的事（连接、积分、模型登录）告诉谁：工作区所有者。 */
  owners(): MaybeAsync<PersonId[]>
  /** 这个品牌里还在的人（整个团队都该知道的事：比如改回了同事互联）。 */
  members?(): MaybeAsync<PersonId[]>
  /** 一张卡（审批到你 / 交给你 / 岗位更新）。 */
  approval?(id: string): MaybeAsync<ApprovalItem | undefined>
  /** 一件交接出去的事的标题与地址（事项 / 待办）。 */
  handoff?(ref: {
    kind: string
    id: string
  }): MaybeAsync<{ title: string; href: string } | undefined>
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v : undefined

const short = (t: string, n = 40): string => (t.length > n ? `${t.slice(0, n)}…` : t)

/** WP430（决策 1289）：模型订阅过期 / 登录失效、当下的事已自动换别的 AI 接着做。 */
export const RELOGIN_NEEDED_EVENT = 'model_source.relogin_needed'

/** WP436（决策 1316）：自带的 API key 被拒（401 / 403、key 失效），要人去换一把。 */
export const KEY_REJECTED_EVENT = 'model_source.key_rejected'

/**
 * 通知里说 key 的那个名字：来源名去掉括号里的说明与「 · 」后面那半截
 * （「OpenAI（API key，按量计费）」→「OpenAI」、「DeepSeek 官方 · 官方 API 接口连接」→「DeepSeek 官方」）。
 */
export function keySourceName(label: string): string {
  const name = label
    .replace(/\s*[（(][^）)]*[）)]\s*/g, ' ')
    .replace(/\s*·.*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
  return name === '' ? label.trim() : name
}

/** 状态类提醒（要重新登录 / key 用不了了）：同一来源还没读时再来不加计数。 */
const STATE_EVENTS = new Set([RELOGIN_NEEDED_EVENT, KEY_REJECTED_EVENT])

/**
 * WP432：Reddit 的写批了、等你在浏览器插件里打开发（插件图标上也有数字）。
 * 发出去了 / 没发出去 / 不发了，那条就收成已读。
 */
export const REDDIT_AWAITING_EVENT = 'reddit.write_awaiting'
const REDDIT_SETTLED = new Set(['reddit.write_sent', 'reddit.write_failed', 'reddit.write_dropped'])
/**
 * WP483（决策 1658 / 1660）：走 ego 那一路要人管一下的两种——ego 里弹了要你处理的框（处理完工坊接着做）、
 * 平台拦了 / 点过发送没确认（工坊停下了，不绕）。key 用 `ego:<卡>`，发出去了收成已读。
 */
export const REDDIT_EGO_HUMAN_EVENT = 'reddit.write_needs_human'
export const REDDIT_EGO_STOPPED_EVENT = 'reddit.write_ego_stopped'

/** 卡的地址。 */
export const cardHref = (id: string): string => `/cards/${encodeURIComponent(id)}`

/** 一张卡定了 / 撤了 / 过期了之后，它那条通知就不用再挂着未读了。 */
const CARD_SETTLED = new Set([
  'approval.decided',
  'approval.withdrawn',
  'approval.expired',
  'approval.superseded',
  'approval.applied',
  'approval.auto_approved',
])

/**
 * 这一条事件要告诉谁、说什么（纯判断 + 经 resolver 翻名字 / 标题）。不认识的事件回空。
 */
export async function notificationsOfEvent(
  e: Pick<EventEnvelope, 'type' | 'workspace_id' | 'actor' | 'subject' | 'payload'>,
  ctx: NotificationResolver,
): Promise<NotificationInput[]> {
  const ws = e.workspace_id
  const p = (e.payload ?? {}) as Record<string, unknown>
  const name = async (id: string | undefined): Promise<string> =>
    (id === undefined ? undefined : await ctx.personName(id as PersonId)) ?? '同事'

  if (
    e.type === 'handoff.accepted' ||
    e.type === 'handoff.declined' ||
    e.type === 'handoff.returned'
  ) {
    const from = str(p.from)
    const to = str(p.to)
    if (from === undefined || to === undefined || e.subject === undefined) return []
    const ref = { kind: e.subject.type, id: e.subject.id }
    const hit = await ctx.handoff?.(ref)
    const title = short(hit?.title ?? '一件事')
    const key = `handoff:${ref.kind}:${ref.id}`
    const href = hit?.href
    const base = {
      workspace_id: ws,
      category: 'team' as const,
      key,
      ...(href === undefined ? {} : { href }),
    }
    // WP277（决策 241）：③ 里上级派下来的——直接生效，告诉接的人一声
    if (e.type === 'handoff.accepted' && p.dispatched === true)
      return [
        { ...base, person_id: to as PersonId, text: `${await name(from)} 派给你「${title}」` },
      ]
    const text =
      e.type === 'handoff.accepted'
        ? `${await name(to)} 接下了「${title}」`
        : e.type === 'handoff.declined'
          ? `${await name(to)} 没接「${title}」`
          : `「${title}」${await name(to)} 一直没接，退回给你了`
    return [{ ...base, person_id: from as PersonId, text }]
  }

  if (e.type === 'approval.delivered') {
    const to = str(p.to)
    const id = e.subject?.id
    if (to === undefined || id === undefined || ctx.approval === undefined) return []
    const item = await ctx.approval(id)
    if (item === undefined) return []
    const form = (item.payload as { form?: unknown } | undefined)?.form
    // WP445：插件里审的卡不在工坊出、也不在铃铛里说「等你批」（插件「等你发」那一路已经说了）
    if (isPluginDeskCard(item)) return []
    const base = {
      workspace_id: ws,
      person_id: to as PersonId,
      key: `card:${id}`,
      href: cardHref(id),
    }
    // WP406：本周岗位更新到了（卡上定用不用；这里只告诉一声）
    if (item.kind === CONTENT_DIGEST_CARD_KIND || form === CONTENT_DIGEST_CARD_KIND)
      return [{ ...base, category: 'update', text: `岗位更新到了：${short(item.title, 60)}` }]
    // WP417：同事问你、助理起好了稿，等你看一眼
    if (form === 'secretary_answer')
      return [{ ...base, category: 'team', text: short(item.title, 60) }]
    // 同事交给你的（交接、分享、提的卡）
    if (item.proposer.kind === 'person' && item.proposer.id !== to) {
      const who = await name(item.proposer.id)
      const title = short(item.title, 60)
      return [{ ...base, category: 'team', text: title.includes(who) ? title : `${who}：${title}` }]
    }
    // ③ 审批到你：按岗位上级走的卡、升级过来的卡
    if (item.routing.rule === 'scope_manager' || item.routing.escalation.escalated_at.length > 0)
      return [{ ...base, category: 'team', text: `等你批：${short(item.title, 60)}` }]
    return []
  }

  // WP277（决策 240）：老板把公司改回同事互联——同事们知道一声（原来是首页一行「知道了」）
  if (e.type === 'organization.mode_changed' && p.mode === 'peers' && p.from === 'company') {
    const by = e.actor.kind === 'person' ? e.actor.id : undefined
    const who = await name(by)
    const people = ((await ctx.members?.()) ?? []).filter((m) => m !== by)
    return people.map((person_id) => ({
      workspace_id: ws,
      person_id,
      category: 'team' as const,
      text: `${who} 把这里改回了同事互联`,
      key: `mode:${str(p.organization_id) ?? ws}`,
    }))
  }

  if (e.type === REDDIT_AWAITING_EVENT) {
    const id = str(p.approval_item_id)
    if (id === undefined) return []
    const item = await ctx.approval?.(id)
    // WP445：告诉发起人（要去插件里点发送的人；主管在工坊里批了的也是发起人去发）；不是人发起的告诉批的人，
    // 都翻不出来告诉所有者
    const proposer = item?.proposer.kind === 'person' ? item.proposer.id : undefined
    const by = item?.decision?.by
    const people =
      proposer !== undefined
        ? [proposer as PersonId]
        : by !== undefined && by !== 'mandate'
          ? [by as PersonId]
          : await ctx.owners()
    const what = short(str(p.label) ?? item?.title ?? `r/${str(p.subreddit) ?? ''}`, 60)
    return people.map((person_id) => ({
      workspace_id: ws,
      person_id,
      category: 'outbound' as const,
      text: `等你在浏览器插件里发：${what}`,
      key: `outbound:${id}`,
    }))
  }

  if (e.type === REDDIT_EGO_HUMAN_EVENT || e.type === REDDIT_EGO_STOPPED_EVENT) {
    const id = str(p.approval_item_id)
    if (id === undefined) return []
    const item = await ctx.approval?.(id)
    const proposer = item?.proposer.kind === 'person' ? item.proposer.id : undefined
    const by = item?.decision?.by
    const people =
      proposer !== undefined
        ? [proposer as PersonId]
        : by !== undefined && by !== 'mandate'
          ? [by as PersonId]
          : await ctx.owners()
    const what = short(str(p.label) ?? item?.title ?? 'Reddit', 60)
    const text =
      e.type === REDDIT_EGO_HUMAN_EVENT
        ? `ego 里有个框要你点一下（比如「显示通知」点「阻止」），点完工坊接着发：${what}`
        : `工坊在 ego 里停下了，去看一眼：${what}`
    return people.map((person_id) => ({
      workspace_id: ws,
      person_id,
      category: 'outbound' as const,
      text,
      key: `ego:${id}`,
    }))
  }

  if (e.type === RELOGIN_NEEDED_EVENT) {
    const source = str(p.source_name) ?? str(p.source) ?? str(p.label) ?? str(p.name) ?? 'AI 订阅'
    const person = str(p.person_id) ?? (e.actor.kind === 'person' ? str(e.actor.id) : undefined)
    const people = person !== undefined ? [person as PersonId] : await ctx.owners()
    return people.map((person_id) => ({
      workspace_id: ws,
      person_id,
      category: 'connection' as const,
      // 来源名以英文结尾（WP430 给的是「ChatGPT」）时和后面的中文之间留一个空格
      text: `你的 ${source}${/[A-Za-z0-9]$/.test(source) ? ' ' : ''}要重新登录`,
      href: '/settings/models',
      key: `relogin:${source}`,
    }))
  }

  if (e.type === KEY_REJECTED_EVENT) {
    const label = str(p.label) ?? str(p.source_name) ?? str(p.provider)
    const name = label === undefined ? undefined : keySourceName(label)
    const person = str(p.person_id) ?? (e.actor.kind === 'person' ? str(e.actor.id) : undefined)
    const people = person !== undefined ? [person as PersonId] : await ctx.owners()
    return people.map((person_id) => ({
      workspace_id: ws,
      person_id,
      category: 'connection' as const,
      text:
        name === undefined
          ? '你的 API key 用不了了，去换一把'
          : `你的 ${name} key 用不了了，去换一把`,
      href: '/settings/models',
      key: `apikey:${str(p.provider) ?? name ?? 'key'}`,
    }))
  }

  return []
}

export interface NotificationsOptions {
  clock: Clock
  random: () => number
  /** 给了就落盘（`notifications.db`）；不给只在内存。 */
  dbPath?: string
}

export interface NotificationsService {
  /**
   * 发一条（设置里关了这一类就不记，回 undefined）。`opts` 只给演示种子用（定时间、直接算已读）。
   */
  notify(
    input: NotificationInput,
    opts?: { at?: string; read?: boolean },
  ): InboxNotification | undefined
  /** 这件事办完了：同键还没读的都收成已读（不给人 = 这个品牌里所有人的）。 */
  settle(ws: WorkspaceId, key: string, person?: PersonId): void
  /**
   * WP466：本人现在挂着的系统卡（原首页告警区）对一遍——没进过铃铛的进来（一张一条），
   * 已经在的不加计数、不改已读，不在了的那几条收成已读。
   */
  syncAlerts(actor: NotificationActor, alerts: readonly DeckCard[]): void
  list(actor: NotificationActor, query: { view: 'unread' | 'all'; limit: number }): NotificationList
  markRead(actor: NotificationActor, ids: readonly string[]): { unread: number }
  markAllRead(actor: NotificationActor): { unread: number }
  prefs(actor: NotificationActor): NotificationPrefs
  setPrefs(actor: NotificationActor, patch: SavedPrefs): NotificationPrefs
  /** 删掉过了保留期的，回删了几条。 */
  prune(): number
  /** 品牌装好时挂上它那一份 resolver（事件里认人、认标题用）。 */
  register(ws: WorkspaceId, resolver: NotificationResolver): void
  /** 没单独挂的品牌用这一份（服务进程按品牌现取：名字、卡、事项都是那个品牌的）。 */
  fallback(make: (ws: WorkspaceId) => NotificationResolver | undefined): void
  /** 事件日志的每一条都过一下（`appendEvent` 里调；不抛、不等）。 */
  onEvent(e: EventEnvelope | (Omit<EventEnvelope, 'id' | 'at'> & { at?: string })): void
  /** 等手上还没处理完的事件（测试用）。 */
  flush(): Promise<void>
  port: NotificationsPort
  close(): void
}

const DAY_MS = 86_400_000

export function createNotifications(options: NotificationsOptions): NotificationsService {
  const backend =
    options.dbPath === undefined || options.dbPath === ':memory:'
      ? createMemoryBackend()
      : createSqliteBackend(options.dbPath)
  const resolvers = new Map<WorkspaceId, NotificationResolver>()
  let makeResolver: ((ws: WorkspaceId) => NotificationResolver | undefined) | undefined
  let seq = 0
  let pending: Promise<void> = Promise.resolve()
  let lastPrune = 0

  const now = (): string => options.clock.now()
  const newId = (): string => {
    seq += 1
    const rand = Math.floor(options.random() * 36 ** 4)
      .toString(36)
      .padStart(4, '0')
    return `ntf_${Date.parse(now()).toString(36)}${seq.toString(36)}${rand}`
  }
  const prefsOf = (ws: WorkspaceId, person: PersonId): NotificationPrefs =>
    resolveNotificationPrefs(backend.prefs(ws, person))
  const unreadOf = (ws: WorkspaceId, person: PersonId): number =>
    backend.all(ws, person).filter((r) => r.read_at === undefined).length

  const prune = (): number => {
    const cutoff = new Date(Date.parse(now()) - NOTIFICATION_RETENTION_DAYS * DAY_MS).toISOString()
    return backend.pruneBefore(cutoff)
  }
  const maybePrune = (): void => {
    const t = Date.parse(now())
    if (t - lastPrune < 3_600_000) return
    lastPrune = t
    prune()
  }
  /** 一个人超过上限：先删最老的已读，再删最老的。 */
  const cap = (ws: WorkspaceId, person: PersonId): void => {
    const rows = backend.all(ws, person)
    if (rows.length <= NOTIFICATION_MAX_PER_PERSON) return
    const over = rows.length - NOTIFICATION_MAX_PER_PERSON
    const oldest = [...rows].reverse()
    const drop = [
      ...oldest.filter((r) => r.read_at !== undefined),
      ...oldest.filter((r) => r.read_at === undefined),
    ].slice(0, over)
    backend.remove(drop.map((r) => r.id))
  }

  /** 告警这一类「系统」开着也只弹紧急档的（普通的只进铃铛，决策 1489）。 */
  const systemOf = (input: NotificationInput, on: boolean): boolean =>
    on && (input.category !== 'alert' || input.urgent === true)

  const notify = (
    input: NotificationInput,
    opts?: { at?: string; read?: boolean },
  ): InboxNotification | undefined => {
    const text = input.text.trim()
    if (text === '') return undefined
    const prefs = prefsOf(input.workspace_id, input.person_id)[input.category]
    if (!prefs.inbox) return undefined
    maybePrune()
    const at = opts?.at ?? now()
    const key = input.key ?? `once:${newId()}`
    const prev =
      input.key === undefined ? undefined : backend.byKey(input.workspace_id, input.person_id, key)
    const row: InboxNotification =
      prev === undefined
        ? {
            id: newId(),
            workspace_id: input.workspace_id,
            person_id: input.person_id,
            category: input.category,
            text,
            ...(input.href === undefined ? {} : { href: input.href }),
            key,
            count: 1,
            created_at: at,
            updated_at: at,
            system: systemOf(input, prefs.system),
            ...(input.urgent === true ? { urgent: true } : {}),
          }
        : {
            id: prev.id,
            workspace_id: prev.workspace_id,
            person_id: prev.person_id,
            category: input.category,
            text,
            ...(input.href === undefined ? {} : { href: input.href }),
            key,
            // 还没读：同一件事又来一次，计数加一；读过了：重新算一条新的
            count: prev.read_at === undefined ? prev.count + 1 : 1,
            created_at: prev.created_at,
            updated_at: at,
            system: systemOf(input, prefs.system),
            ...(input.urgent === true ? { urgent: true } : {}),
          }
    const stored = opts?.read === true ? { ...row, read_at: at } : row
    backend.put(stored)
    cap(input.workspace_id, input.person_id)
    return stored
  }

  const settle = (ws: WorkspaceId, key: string, person?: PersonId): void => {
    const at = now()
    for (const r of backend.withKey(ws, key))
      if (r.read_at === undefined && (person === undefined || r.person_id === person))
        backend.put({ ...r, read_at: at })
  }

  const syncAlerts: NotificationsService['syncAlerts'] = (actor, alerts) => {
    const live = new Set<string>()
    for (const card of alerts) {
      const n = alertNotificationOf(card, actor)
      if (n?.key === undefined || live.has(n.key)) continue
      live.add(n.key)
      const prev = backend.byKey(actor.workspace_id, actor.person_id, n.key)
      if (prev === undefined) {
        // 卡上的时间是那件事发生的时间；铃铛里按「来到铃铛」的那一刻算（不然一进来就排到底下）
        notify(n)
        continue
      }
      // 还挂着：一个状态，不加计数、不变回未读；只把字 / 去处 / 档位对齐（读回结果补上了之类）
      const href = n.href
      const same =
        prev.text === n.text && prev.href === href && (prev.urgent === true) === (n.urgent === true)
      if (same) continue
      const { href: _h, urgent: _u, ...rest } = prev
      backend.put({
        ...rest,
        text: n.text,
        ...(href === undefined ? {} : { href }),
        ...(n.urgent === true ? { urgent: true } : {}),
      })
    }
    // 不在了的：那件事过去了，没读的收成已读
    const at = now()
    for (const r of backend.all(actor.workspace_id, actor.person_id))
      if (r.key.startsWith(ALERT_KEY_PREFIX) && !live.has(r.key) && r.read_at === undefined)
        backend.put({ ...r, read_at: at })
  }

  const list: NotificationsService['list'] = (actor, query) => {
    maybePrune()
    const all = backend.all(actor.workspace_id, actor.person_id).sort(urgentFirst)
    const unread = all.filter((r) => r.read_at === undefined)
    const items = (query.view === 'all' ? all : unread).slice(0, query.limit)
    return { items, unread: unread.length }
  }

  const markRead: NotificationsService['markRead'] = (actor, ids) => {
    const at = now()
    const want = new Set(ids)
    for (const r of backend.all(actor.workspace_id, actor.person_id))
      if (want.has(r.id) && r.read_at === undefined) backend.put({ ...r, read_at: at })
    return { unread: unreadOf(actor.workspace_id, actor.person_id) }
  }

  const markAllRead: NotificationsService['markAllRead'] = (actor) => {
    const at = now()
    for (const r of backend.all(actor.workspace_id, actor.person_id))
      if (r.read_at === undefined) backend.put({ ...r, read_at: at })
    return { unread: 0 }
  }

  const setPrefs: NotificationsService['setPrefs'] = (actor, patch) => {
    const saved: SavedPrefs = { ...(backend.prefs(actor.workspace_id, actor.person_id) ?? {}) }
    for (const c of NOTIFICATION_CATEGORIES) {
      const v = patch[c]
      if (v === undefined) continue
      saved[c] = { ...(saved[c] ?? {}), ...v }
    }
    backend.setPrefs(actor.workspace_id, actor.person_id, saved)
    return prefsOf(actor.workspace_id, actor.person_id)
  }

  const handle = async (
    e: Pick<EventEnvelope, 'type' | 'workspace_id' | 'actor' | 'subject' | 'payload'>,
  ): Promise<void> => {
    if (CARD_SETTLED.has(e.type) && e.subject?.id !== undefined) {
      settle(e.workspace_id, `card:${e.subject.id}`)
      // WP445：插件里审的那张卡不发了 / 撤了 / 过期了 → 「等你发」那条也收成已读（批了的接着等你打开、发出去才收）
      const state = str((e.payload as Record<string, unknown> | undefined)?.state)
      const gone =
        e.type === 'approval.decided'
          ? state !== 'approved' && state !== 'approved_edited'
          : e.type === 'approval.withdrawn' ||
            e.type === 'approval.expired' ||
            e.type === 'approval.superseded'
      if (gone) settle(e.workspace_id, `outbound:${e.subject.id}`)
      return
    }
    // WP432：等你发的那一条有了结局 → 那条通知收成已读
    if (REDDIT_SETTLED.has(e.type)) {
      const id = str((e.payload as Record<string, unknown> | undefined)?.approval_item_id)
      if (id !== undefined) settle(e.workspace_id, `outbound:${id}`)
      // WP483：发出去了，「ego 里要你点一下」那条也收掉
      if (id !== undefined && e.type === 'reddit.write_sent') settle(e.workspace_id, `ego:${id}`)
      return
    }
    const ctx = resolvers.get(e.workspace_id) ?? makeResolver?.(e.workspace_id)
    if (ctx === undefined) return
    for (const n of await notificationsOfEvent(e, ctx)) {
      /*
       * int/1023：「要重新登录」是一个状态、不是一件件的事——同一来源还没读时又来一条（DeepSeek 账号过期时
       * 网关那一跳和摘账号那一路各发一条 `model_source.relogin_needed`）不加计数，铃铛里只有一条、没有 ×2。
       * WP436：「key 用不了了」同一口径。
       */
      // WP445：同一条「等你发」（插件里批了又进「等你打开」）还没读时不再加一条
      if (
        (STATE_EVENTS.has(e.type) ||
          e.type === REDDIT_AWAITING_EVENT ||
          e.type === REDDIT_EGO_HUMAN_EVENT) &&
        n.key !== undefined
      ) {
        const prev = backend.byKey(n.workspace_id, n.person_id, n.key)
        if (prev !== undefined && prev.read_at === undefined) continue
      }
      notify(n)
    }
  }

  const INTERESTING = new Set([
    'handoff.accepted',
    'handoff.declined',
    'handoff.returned',
    'approval.delivered',
    'organization.mode_changed',
    RELOGIN_NEEDED_EVENT,
    KEY_REJECTED_EVENT,
    REDDIT_AWAITING_EVENT,
    REDDIT_EGO_HUMAN_EVENT,
    REDDIT_EGO_STOPPED_EVENT,
    ...REDDIT_SETTLED,
    ...CARD_SETTLED,
  ])

  const service: NotificationsService = {
    notify,
    settle,
    syncAlerts,
    list,
    markRead,
    markAllRead,
    prefs: (actor) => prefsOf(actor.workspace_id, actor.person_id),
    setPrefs,
    prune,
    register: (ws, resolver) => {
      resolvers.set(ws, resolver)
    },
    fallback: (make) => {
      makeResolver = make
    },
    onEvent: (e) => {
      if (!INTERESTING.has(e.type)) return
      pending = pending.then(() => handle(e)).catch(() => undefined)
    },
    flush: () => pending,
    port: {
      list: (actor, query) => list(actor, query),
      markRead: (actor, ids) => markRead(actor, ids),
      markAllRead: (actor) => markAllRead(actor),
      prefs: (actor) => prefsOf(actor.workspace_id, actor.person_id),
      setPrefs: (actor, patch) => setPrefs(actor, patch),
      syncAlerts: (actor, alerts) => {
        syncAlerts(actor, alerts)
      },
    },
    close: () => {
      backend.close()
    },
  }
  return service
}

// ── 装配处直接发的那几类：文字与键集中在这里，测试与装配同一份 ─────────────────

/** 一次运行收尾时告诉跑它的人（WP429）。 */
export interface RunEndedNotice {
  run_id: string
  matter_id: string
  matter_title: string
  person_id: PersonId
  outcome: 'completed' | 'stopped' | 'failed'
  /** 停的原因（`user` = 人自己点了停：不用再告诉他）。 */
  reason?: string
  started_at: string
  ended_at: string
}

/** 跑完的只有跑得够久（人多半已经去忙别的了）才告诉；停下 / 没跑成的都告诉（人点停的除外）。 */
export const RUN_NOTIFY_MIN_MS = 60_000

export function runEndedNotification(
  ws: WorkspaceId,
  r: RunEndedNotice,
): NotificationInput | undefined {
  if (r.outcome === 'stopped' && (r.reason === 'user' || r.reason === 'update')) return undefined
  const took = Date.parse(r.ended_at) - Date.parse(r.started_at)
  if (r.outcome === 'completed' && !(took >= RUN_NOTIFY_MIN_MS)) return undefined
  const title = short(r.matter_title.trim() === '' ? '这件事' : r.matter_title)
  const text =
    r.outcome === 'completed'
      ? `「${title}」跑完了`
      : r.outcome === 'stopped'
        ? `「${title}」被停下了`
        : `「${title}」没跑成`
  return {
    workspace_id: ws,
    person_id: r.person_id,
    category: 'task',
    text,
    href: `/matters/${encodeURIComponent(r.matter_id)}`,
    key: `run:${r.matter_id}`,
  }
}

/** 连接从「连着」变成要重连 / 停用了。 */
export function connectionBrokenNotification(
  ws: WorkspaceId,
  person_id: PersonId,
  c: { id: string; label: string },
): NotificationInput {
  return {
    workspace_id: ws,
    person_id,
    category: 'connection',
    text: `${c.label} 连接断了，要重新连一下`,
    href: '/settings/connections',
    key: connectionKey(c.id),
  }
}

export const connectionKey = (id: string): string => `conn:${id}`

/** 工坊积分快用完了（云钱包说 `low_balance`）。 */
export function creditsLowNotification(
  ws: WorkspaceId,
  person_id: PersonId,
  available: number | undefined,
): NotificationInput {
  return {
    workspace_id: ws,
    person_id,
    category: 'credits',
    text:
      available === undefined
        ? '工坊积分快用完了'
        : `工坊积分快用完了，还剩 ${Math.max(0, Math.floor(available))}`,
    href: '/settings/account#credits',
    key: CREDITS_LOW_KEY,
  }
}

export const CREDITS_LOW_KEY = 'credits_low'

/**
 * 演示世界里给所有者放几条（截图与演示看得出铃铛长什么样）。只在挂了合成世界时放；放过就不再放。
 */
export function seedDemoNotifications(
  svc: NotificationsService,
  ws: WorkspaceId,
  person_id: PersonId,
  now: string,
  /** WP466：告警那两条点了去哪（店铺管理的职责页；没有就回首页）。 */
  links: { store?: string } = {},
): void {
  if (svc.list({ workspace_id: ws, person_id }, { view: 'all', limit: 1 }).items.length > 0) return
  const t = Date.parse(now)
  const ago = (min: number): string => new Date(t - min * 60_000).toISOString()
  const rows: [NotificationInput, number, boolean?][] = [
    [
      {
        workspace_id: ws,
        person_id,
        category: 'update',
        text: '岗位更新到了：网站运营 · 本周更新 · 3 项',
        href: '/',
        key: 'demo:update',
      },
      60 * 26,
      true,
    ],
    [
      {
        workspace_id: ws,
        person_id,
        category: 'credits',
        text: '工坊积分快用完了，还剩 18',
        href: '/settings/account#credits',
        key: CREDITS_LOW_KEY,
      },
      60 * 5,
    ],
    [
      {
        workspace_id: ws,
        person_id,
        category: 'connection',
        text: 'Shopify 店铺 连接断了，要重新连一下',
        href: '/settings/connections',
        key: 'demo:conn',
      },
      95,
    ],
    [
      {
        workspace_id: ws,
        person_id,
        category: 'task',
        text: '「找 5 个值得回的 Reddit 帖子」跑完了',
        href: '/in-progress',
        key: 'demo:run',
      },
      18,
    ],
    [
      {
        workspace_id: ws,
        person_id,
        category: 'team',
        text: '陈晓回你了：退款单都核对完了，有两单要你定',
        href: '/assistant?peers=1',
        key: 'demo:reply',
      },
      3,
    ],
  ]
  /*
   * WP466：原首页告警区那一类——一条紧急（店铺日报异常）、一条普通（目标市场校正）。
   * 演示世界的订单里没有骤降、也没有断货，真的系统卡出不来；键用 `demo:` 开头，铃铛对系统卡时不会把它们收掉。
   */
  rows.push(
    [
      {
        workspace_id: ws,
        person_id,
        category: 'alert',
        text: '目标市场按店铺后台改了：加上了 英国',
        href: '/settings#company',
        key: 'demo:alert:markets',
      },
      60 * 3,
    ],
    [
      {
        workspace_id: ws,
        person_id,
        category: 'alert',
        text: '店铺日报：销售额比上一期跌了 42%',
        href: links.store ?? '/',
        key: 'demo:alert:store',
        urgent: true,
      },
      25,
    ],
  )
  for (const [input, min, read] of rows) svc.notify(input, { at: ago(min), read: read === true })
  // 同一件事又来了两次（合并成一条 ×3）
  svc.notify(rows[2]?.[0] as NotificationInput, { at: ago(40) })
  svc.notify(rows[2]?.[0] as NotificationInput, { at: ago(12) })
}
