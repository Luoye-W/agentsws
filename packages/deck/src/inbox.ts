/**
 * WP459（决策 1497–1505）：**收件箱**——所有岗位等你批的卡 + 要你判断的信，一条队列。
 *
 * 这里只放纯逻辑：一行长什么样（{@link InboxItem}）、急不急（{@link InboxUrgency}，决策 1500 甲：
 * 要紧 / 今天 / 不急三组、组内按时间）、行尾那颗次按钮是什么、几种筛选的计数。
 * 数据从哪来（各岗位的卡、没人接的信、AI 猜着交的）由网关装配（`GET /v1/inbox`）。
 *
 * 纪律：卡就是岗位里**同一张卡**（`card` 原样是 {@link DeckCard}，批 / 改 / 不要走同一个账本），
 * 不复制、不另存——在收件箱批了，岗位里那张一起没了，反之亦然。
 */
import type { DeckCard } from './types.js'

/** 急不急（决策 1500 甲）。 */
export type InboxUrgency = 'urgent' | 'today' | 'later'

export const INBOX_URGENCY_ORDER: readonly InboxUrgency[] = ['urgent', 'today', 'later']

/** 这一行是什么（行上的类型标签按它写字；卡的具体类别由前端按 `categoryKey` 再细说）。 */
export type InboxTag =
  /** 岗位里等你批的卡（回信草稿、改价、广告改动……）。 */
  | 'card'
  /** 回信跟进的催促卡（「X 还没回」）。 */
  | 'nudge'
  /** 要在浏览器插件里发的（Reddit「等你发」）：工坊里只给「去发」。 */
  | 'post'
  /** 拿不准归谁的信（AI 有头号猜测，把握不够）。 */
  | 'unsure'
  /** 只能你定的信（营业执照、报价……AI 建议「我自己回 / 我自己处理」）。 */
  | 'only_you'

/** 行尾那颗次按钮（「不要 / 改 / 交给别的 / 稍后」都在 ⋯ 里）。 */
export type InboxPrimary = 'approve' | 'go_post' | 'hand' | 'self' | 'open'

/** 收件箱里一封要你判断的信（「没人接的」那一条会话的要点）。 */
export interface InboxMail {
  thread_id: string
  /** 三个建议作用在哪一封上（这条会话里最新那封来信）。 */
  message_id: string
  subject: string
  from: { email: string; name?: string }
  summary?: string
  kind?: string
  kind_confidence?: number
  priority?: 'high' | 'normal' | 'low'
  last_at: string
  /** AI 的头号建议（「交给 B2B」/「我自己回」/「只是通知」）。 */
  suggest?: { action: 'hand' | 'notice' | 'self'; position?: string }
  account?: string
}

export interface InboxItem {
  /** `card:<审批项 id>` / `mail:<会话 id>`。 */
  id: string
  type: 'card' | 'mail'
  urgency: InboxUrgency
  tag: InboxTag
  primary: InboxPrimary
  /** 排序与「时间」那一格（卡 = 起草时刻，信 = 最后一封来信）。 */
  at: string
  /** 归哪个岗位（岗位模板 id）；没归岗位的信没有。 */
  position?: string
  card?: DeckCard
  mail?: InboxMail
  /**
   * 这张卡是从「AI 猜着交给岗位」的那封信来的（决策 1498）：行上一个「AI 猜的 · 改」，
   * 改判的就是这封信（`message_id`）。
   */
  guessed?: { message_id: string; position: string; confidence: number }
  /**
   * WP510（决策 1515，只在 ② / ③）：这一件是给谁的——卡 = 收件人；信 = 这只邮箱的负责人（没指定负责人的信没有）。
   * ① 个人里永远没有。
   */
  owners?: InboxPerson[]
  /** WP510（只在 ② / ③）：在不在「给我的」里（`false` = 只在「全部」里看得到，卡上的按钮也不给）。 */
  mine?: boolean
  /** WP510：负责人都不在、转给了兜底的人——原来的负责人是谁。 */
  fallback_from?: InboxPerson[]
}

/** WP510：收件箱里出现的一位同事。 */
export interface InboxPerson {
  person_id: string
  name: string
}

/** WP510（决策 1515）：「给我的」/「全部」。 */
export type InboxScope = 'mine' | 'all'

export const INBOX_SCOPES: readonly InboxScope[] = ['mine', 'all']

/** WP510：刚处理过的一件（「刚处理」那一块：谁、批了还是不要了、哪一张）。 */
export interface InboxHandled {
  /** 审批项 id（收件箱那一行是 `card:<id>`）。 */
  card_id: string
  title: string
  by: InboxPerson
  /** 是不是看的人自己。 */
  self: boolean
  action: 'approve' | 'reject' | 'defer' | 'other'
  at: string
  position?: string
}

/** WP510（只在 ② / ③）：收件箱的团队那一面。 */
export interface InboxTeam {
  mode: 'peers' | 'company'
  scope: InboxScope
  /** 「给我的」几件、「全部」几件（分段上的数）。 */
  mine: number
  all: number
  /** 最近 24 小时里谁处理了什么（新的在前，最多 8 件）。 */
  handled: InboxHandled[]
}

/** 「岗位」下拉里的一行（决策 1501 甲：带件数；最后一行是「还没归岗位的信」）。 */
export interface InboxPosition {
  /** 岗位模板 id。 */
  id: string
  name_zh: string
  name_en: string
  icon?: string
  /** 本人在这个岗位下的分配（「去客服岗位 →」跳哪一条）。 */
  assignment_id?: string
  count: number
}

export interface InboxCounts {
  all: number
  /** 「等我批」：岗位卡（含要去插件发的）。 */
  cards: number
  /** 「只看信」。 */
  mail: number
  urgent: number
  today: number
  later: number
}

/** 今天 AI 猜着交给岗位的一封（简报「猜着交给岗位 N 封」点开）。 */
export interface InboxGuess {
  message_id: string
  thread_id: string
  subject: string
  from: { email: string; name?: string }
  position: string
  confidence: number
  at: string
  open_card_count?: number
}

/** 顶上「今天的简报」那两行要的数。 */
export interface InboxBrief {
  /** AI 今天替你办完几件（跑完没回头问人的 + 额度内自动发的）。 */
  done: number
  /** 客服直接回了几封。 */
  auto_sent: number
  /** 猜着交给岗位几封。 */
  guessed: number
  /** 收好的通知几封（「只是通知」还没点知道了的）。 */
  notices: number
  /** 最急的那一件（要紧里排第一的那一行的标题）。 */
  top?: string
}

export interface InboxView {
  items: InboxItem[]
  counts: InboxCounts
  positions: InboxPosition[]
  /** 「还没归岗位的信」几件。 */
  unassigned: number
  guessed: InboxGuess[]
  brief: InboxBrief
  /** WP510：② 同事互联 / ③ 公司里才有；① 个人没有这一格（界面一个字都不多）。 */
  team?: InboxTeam
}

const HOUR = 3_600_000

/** 当地那一天（按工作区时区偏移）。 */
function localDay(ms: number, tz_offset_minutes: number): string {
  return new Date(ms + tz_offset_minutes * 60_000).toISOString().slice(0, 10)
}

/**
 * 一张卡急不急：
 * - **要紧**：客户在等（P0）、6 小时内到期；
 * - **今天**：待你确认（P1）、24 小时内到期、今天才来的；
 * - **不急**：其余（没人对着屏幕等、几天后才到期的）。
 */
export function inboxUrgencyOfCard(
  card: Pick<DeckCard, 'priority_band' | 'expires_at' | 'detail'>,
  now: string,
  tz_offset_minutes = 0,
): InboxUrgency {
  const nowMs = Date.parse(now)
  const due = card.expires_at === undefined ? Number.NaN : Date.parse(card.expires_at)
  if (card.priority_band === 'P0') return 'urgent'
  if (Number.isFinite(due) && due - nowMs <= 6 * HOUR) return 'urgent'
  if (card.priority_band === 'P1') return 'today'
  if (Number.isFinite(due) && due - nowMs <= 24 * HOUR) return 'today'
  const created = Date.parse(card.detail.created_at)
  if (
    Number.isFinite(created) &&
    localDay(created, tz_offset_minutes) === localDay(nowMs, tz_offset_minutes)
  )
    return 'today'
  return 'later'
}

/**
 * 一封信急不急：AI 判的「急」或客户等了 4 小时以上 → 要紧；今天来的 → 今天；其余 → 不急。
 * 只能你定的（营业执照、报价）没写期限时按信本身算。
 */
export function inboxUrgencyOfMail(
  mail: Pick<InboxMail, 'priority' | 'last_at'>,
  now: string,
  tz_offset_minutes = 0,
): InboxUrgency {
  const nowMs = Date.parse(now)
  const at = Date.parse(mail.last_at)
  if (mail.priority === 'high') return 'urgent'
  if (mail.priority === 'low') return 'later'
  if (!Number.isFinite(at)) return 'today'
  if (localDay(at, tz_offset_minutes) === localDay(nowMs, tz_offset_minutes)) return 'today'
  return 'later'
}

/** 组内按时间：要紧的最早来的先办（等得最久）；今天 / 不急新的在前。 */
export function sortInbox(items: readonly InboxItem[]): InboxItem[] {
  const rank = (u: InboxUrgency): number => INBOX_URGENCY_ORDER.indexOf(u)
  return [...items].sort((a, b) => {
    const r = rank(a.urgency) - rank(b.urgency)
    if (r !== 0) return r
    const ta = Date.parse(a.at)
    const tb = Date.parse(b.at)
    return a.urgency === 'urgent' ? ta - tb : tb - ta
  })
}

/** 三个分段 + 三组的计数（筛选那一排的数）。 */
export function inboxCounts(items: readonly InboxItem[]): InboxCounts {
  const out: InboxCounts = { all: 0, cards: 0, mail: 0, urgent: 0, today: 0, later: 0 }
  for (const i of items) {
    out.all += 1
    if (i.type === 'card') out.cards += 1
    else out.mail += 1
    out[i.urgency] += 1
  }
  return out
}

/** 筛选（前端与网关同一把尺子）。`position: '__none__'` = 还没归岗位的信。 */
export interface InboxFilter {
  type?: 'card' | 'mail'
  position?: string
}

export const INBOX_UNASSIGNED = '__none__'

export function filterInbox(items: readonly InboxItem[], filter: InboxFilter): InboxItem[] {
  return items.filter((i) => {
    if (filter.type !== undefined && i.type !== filter.type) return false
    if (filter.position === undefined) return true
    if (filter.position === INBOX_UNASSIGNED) return i.position === undefined
    return i.position === filter.position
  })
}

/** WP510：一次决定 → 「刚处理」里那个动词。 */
export function handledAction(action: string | undefined): InboxHandled['action'] {
  if (action === 'approve' || action === 'approve_edited') return 'approve'
  if (action === 'reject') return 'reject'
  if (action === 'defer') return 'defer'
  return 'other'
}

/** WP510：按「给我的 / 全部」挑（没有团队那一面时原样回）。 */
export function scopeInbox(items: readonly InboxItem[], scope: InboxScope): InboxItem[] {
  return scope === 'all' ? [...items] : items.filter((i) => i.mine !== false)
}
