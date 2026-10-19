/**
 * WP417（自查客服 A8 / A43 / B7 / C23）：客服查询类工具背后的**只读**数据——
 * 「哪些来信还等着回」「快超 24 小时的 Amazon 买家消息」「聊天里谁在等人工」。
 *
 * 真源都是本机已有的库，不另记账：
 *
 * - 来信：消息库（WP113 同步下来的整只邮箱）里分拣成客服（`route: 'support'`）的会话。**最后一封是客户发的**
 *   = 还等着回；等了多久从「上一封我们发出去的信之后，客户的第一封」算起（SLA 的锚点，同 `support-core`）。
 *   Amazon 买家消息（参与者里有 marketplace relay 地址）另算「离 24 小时回复线还剩几小时」。
 * - 聊天：聊天库里的会话（等人工 / 已转邮件跟进 / 还开着）。
 *
 * 只出摘要：主题、来信人显示名与地址、等了多久、最后一句的前 200 字（外部文本，进模型前运行时会围栏）。
 */
import type { MessageRecord } from '@agentsws/contracts'
import { isMarketplaceRelayAddress } from '@agentsws/support-core'

/** Amazon 买家消息的回复线（小时）。 */
export const AMAZON_REPLY_HOURS = 24
/** 一次最多回几条。 */
export const SUPPORT_LIST_MAX = 50

export interface WaitingMailRow {
  thread_id: string
  subject: string
  from: string
  from_name?: string
  /** 从「客户这一轮第一封」起等了几小时（一位小数）。 */
  waiting_hours: number
  /** 最后一封的时刻。 */
  last_at: string
  amazon: boolean
  /** Amazon：离 24 小时回复线还剩几小时（负数 = 已经超了）。 */
  due_in_hours?: number
  snippet: string
}

export interface ChatSessionRow {
  session_id: string
  visitor: string
  status: string
  /** 等人工等了几分钟（只有在等人工的会话才有）。 */
  waiting_minutes?: number
  last_visitor_text?: string
  updated_at: string
  has_email: boolean
}

export interface SupportInboxPort {
  waitingMail(): Promise<WaitingMailRow[]>
  chatSessions(status: 'waiting' | 'email_follow_up' | 'open' | 'all'): Promise<ChatSessionRow[]>
}

export interface SupportInboxOptions {
  clock: { now(): string }
  /** 消息库（没连邮箱 / 没开消息同步 = undefined）。 */
  mail?(): { list(q: { route: 'support'; limit: number }): unknown } | undefined
  /** 聊天车道（没装 = undefined）。 */
  chat?():
    | {
        sessions(filter?: { status?: string[]; limit?: number }): Promise<ChatSessionLike[]>
        messages(session_id: string, limit?: number): Promise<{ role: string; text: string }[]>
      }
    | undefined
}

interface ChatSessionLike {
  id: string
  visitor_display?: string
  visitor_email?: string
  status: string
  updated_at: string
  assist_requested_at?: string
}

const OUTBOUND_FOLDERS = new Set(['sent', 'drafts', 'trash'])
const hoursBetween = (from: string, to: string): number =>
  Math.round(((Date.parse(to) - Date.parse(from)) / 3_600_000) * 10) / 10

/** 一条会话里的信（时间正序）→ 还等不等着回、从哪一封算起。 */
export function waitingOf(list: readonly MessageRecord[], now: string): WaitingMailRow | undefined {
  const sorted = [...list].sort((a, b) => Date.parse(a.date) - Date.parse(b.date))
  const last = sorted.at(-1)
  if (last === undefined) return undefined
  const ours = (m: MessageRecord): boolean =>
    OUTBOUND_FOLDERS.has(m.folder_kind) || m.from.email.toLowerCase() === m.account.toLowerCase()
  if (ours(last)) return undefined
  // 锚点：最后一封我们发出去的信之后，客户的第一封
  let anchor = last
  for (let i = sorted.length - 1; i >= 0; i--) {
    const m = sorted[i]
    if (m === undefined || ours(m)) break
    anchor = m
  }
  const amazon = sorted.some((m) =>
    [m.from, ...m.to, ...m.cc].some((a) => isMarketplaceRelayAddress(a.email)),
  )
  const waiting = hoursBetween(anchor.date, now)
  return {
    thread_id: last.thread_id,
    subject: last.subject,
    from: last.from.email,
    ...(last.from.name === undefined ? {} : { from_name: last.from.name }),
    waiting_hours: waiting,
    last_at: last.date,
    amazon,
    ...(amazon ? { due_in_hours: Math.round((AMAZON_REPLY_HOURS - waiting) * 10) / 10 } : {}),
    snippet: (last.snippet ?? '').slice(0, 200),
  }
}

const CHAT_STATUS: Record<'waiting' | 'email_follow_up' | 'open', string[]> = {
  waiting: ['assist_requested', 'human_takeover'],
  email_follow_up: ['email_follow_up'],
  open: ['open', 'assist_requested', 'human_takeover'],
}

export function createSupportInbox(options: SupportInboxOptions): SupportInboxPort {
  return {
    async waitingMail() {
      const store = options.mail?.()
      if (store === undefined) return []
      const records = (await Promise.resolve(
        store.list({ route: 'support', limit: 500 }),
      )) as MessageRecord[]
      const byThread = new Map<string, MessageRecord[]>()
      for (const m of records) {
        const l = byThread.get(m.thread_id)
        if (l === undefined) byThread.set(m.thread_id, [m])
        else l.push(m)
      }
      const now = options.clock.now()
      const out: WaitingMailRow[] = []
      for (const list of byThread.values()) {
        const row = waitingOf(list, now)
        if (row !== undefined) out.push(row)
      }
      return out.sort((a, b) => b.waiting_hours - a.waiting_hours)
    },

    async chatSessions(status) {
      const chat = options.chat?.()
      if (chat === undefined) return []
      const sessions = await chat.sessions(
        status === 'all' ? { limit: 200 } : { status: CHAT_STATUS[status], limit: 200 },
      )
      const now = options.clock.now()
      const out: ChatSessionRow[] = []
      for (const s of sessions.slice(0, SUPPORT_LIST_MAX)) {
        const msgs = await chat.messages(s.id, 20).catch(() => [])
        const lastVisitor = [...msgs].reverse().find((m) => m.role === 'visitor')
        out.push({
          session_id: s.id,
          visitor: s.visitor_display ?? '访客',
          status: s.status,
          ...(s.assist_requested_at === undefined
            ? {}
            : {
                waiting_minutes: Math.max(
                  0,
                  Math.round((Date.parse(now) - Date.parse(s.assist_requested_at)) / 60_000),
                ),
              }),
          ...(lastVisitor === undefined
            ? {}
            : { last_visitor_text: lastVisitor.text.slice(0, 200) }),
          updated_at: s.updated_at,
          has_email: s.visitor_email !== undefined,
        })
      }
      return out.sort((a, b) => (b.waiting_minutes ?? -1) - (a.waiting_minutes ?? -1))
    },
  }
}
