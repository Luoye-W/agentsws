/**
 * WP488（决策 1680）：从邮箱里的过往往来拼「客户问 → 我们人工回」的对（{@link QaPair}）。
 *
 * Extracted from KefuAgent `src/lib/support/knowledge-learning.ts`（`learnKnowledgeFromHistory` 的取对口径：
 * 一条线程里第一封客户来信 + 我们真人回的那一封；只认 `human_mailbox` 发的），rewritten for agentsws：
 * 这里没有数据库，只吃一串已经解析好的信（形状只要下面那几格），纯函数。
 *
 * 跳过的（每一条都有原因计数，给人看「为什么只拼出这几对」）：
 * - **AI 发的**：工坊自己发出去的那几封（出站台账里有它的 Message-ID）；信头 `Auto-Submitted`；
 * - **营销 / 群发 / 系统通知**：`List-Unsubscribe` / `List-Id` / `Precedence: bulk|list|junk`、`noreply@`、
 *   分拣判成营销 / 账单 / 物流通知的；
 * - **没人回的**：线程里只有客户来信；
 * - **内部往来**：线程里第一封就是我们自己发的（开发信、群发），不是客户问的。
 */
import type { Iso8601 } from '@agentsws/contracts'
import type { QaPair } from './knowledge.js'

/** 拼对要看的那几格（`MessageRecord` 的子集）。 */
export interface HistoryMail {
  id: string
  thread_id: string
  message_id?: string
  from: { email: string }
  subject: string
  text: string
  date: Iso8601
  /** 小写键的那几个原始头。 */
  headers?: Record<string, string>
  /** 分拣判的类型（`marketing` / `billing_system` / `logistics` 这几类当通知跳过）。 */
  kind?: string
}

export interface QaPairsResult {
  pairs: QaPair[]
  skipped: {
    machine_sent: number
    bulk: number
    no_reply: number
    ours_first: number
  }
}

const NOTICE_KINDS = new Set(['marketing', 'billing_system', 'logistics'])
const NOREPLY = /^(?:no-?reply|do-?not-?reply|mailer-daemon|postmaster|notifications?|newsletter)@/i

/** 一封是不是机器 / 群发（看信头与发件人，不读正文）。 */
export function isBulkMail(m: Pick<HistoryMail, 'headers' | 'from' | 'kind'>): boolean {
  const h = m.headers ?? {}
  if (h['list-unsubscribe'] !== undefined || h['list-id'] !== undefined) return true
  if (/^(?:bulk|list|junk)$/i.test((h.precedence ?? '').trim())) return true
  const auto = h['auto-submitted']
  if (auto !== undefined && auto.trim().toLowerCase() !== 'no') return true
  if (NOREPLY.test(m.from.email)) return true
  return m.kind !== undefined && NOTICE_KINDS.has(m.kind)
}

/**
 * 回信里引用的那一截（`On … wrote:` / `> …` / 「在 … 写道：」/ Outlook 的 `From:` 分隔线）去掉，
 * 只留我们这一次写的话。
 */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  for (const line of lines) {
    const t = line.trim()
    if (
      /^On .{4,200} wrote:$/i.test(t) ||
      /^在.{2,200}写道[:：]$/.test(t) ||
      /^-{2,}\s*(?:Original Message|原始邮件)\s*-{2,}$/i.test(t) ||
      /^_{5,}$/.test(t) ||
      (/^(?:From|发件人)[:：]\s/.test(t) && out.length > 0)
    )
      break
    if (t.startsWith('>')) continue
    out.push(line)
  }
  return out.join('\n').trim()
}

/** 一对里每一半最长多少字（聚类与出题只看前面；再长只是费钱）。 */
export const QA_PAIR_MAX_CHARS = 2000

/**
 * 拼对。
 *
 * @param ours 我们自己的邮箱地址（小写）——发件人在里面就是「我们答」。
 * @param machineSent 工坊自己发出去的 Message-ID（出站台账）——这些是 AI 写的，不学。
 */
export function qaPairsFromMail(
  mails: readonly HistoryMail[],
  opts: { ours: ReadonlySet<string>; machineSent?: ReadonlySet<string> },
): QaPairsResult {
  const skipped = { machine_sent: 0, bulk: 0, no_reply: 0, ours_first: 0 }
  const byThread = new Map<string, HistoryMail[]>()
  for (const m of mails) byThread.set(m.thread_id, [...(byThread.get(m.thread_id) ?? []), m])
  const isOurs = (m: HistoryMail): boolean => opts.ours.has(m.from.email.toLowerCase())
  const machine = (m: HistoryMail): boolean =>
    (m.message_id !== undefined && opts.machineSent?.has(m.message_id) === true) ||
    (m.headers?.['auto-submitted'] !== undefined &&
      m.headers['auto-submitted'].trim().toLowerCase() !== 'no')
  const pairs: QaPair[] = []
  for (const [thread_id, list] of byThread) {
    // 同一封出现在两个文件夹（收件箱与归档）只算一次
    const seen = new Set<string>()
    const sorted = [...list]
      .filter((m) => {
        const k = m.message_id ?? m.id
        if (seen.has(k)) return false
        seen.add(k)
        return true
      })
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    const first = sorted[0]
    if (first === undefined) continue
    if (isOurs(first)) {
      skipped.ours_first += 1
      continue
    }
    if (isBulkMail(first)) {
      skipped.bulk += 1
      continue
    }
    // 第一封客户来信之后，我们第一封**真人**回的
    const replies = sorted.filter((m) => isOurs(m) && m.date >= first.date)
    const human = replies.find((m) => !machine(m))
    if (human === undefined) {
      if (replies.length > 0) skipped.machine_sent += 1
      else skipped.no_reply += 1
      continue
    }
    const answer = stripQuoted(human.text).slice(0, QA_PAIR_MAX_CHARS)
    const body = stripQuoted(first.text)
    const question = `${first.subject.trim()}\n${body}`.trim().slice(0, QA_PAIR_MAX_CHARS)
    if (answer === '' || question === '') {
      skipped.no_reply += 1
      continue
    }
    pairs.push({ thread_id, question, human_answer: answer, at: human.date })
  }
  return { pairs, skipped }
}
