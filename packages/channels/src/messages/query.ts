/**
 * WP113（63 §7）：筛选、搜索与**会话聚合**的纯函数。
 *
 * 抽出来是因为两个实现（内存与 SQLite）必须给出**逐字一样**的答案：
 * SQLite 那一份只用索引做粗筛（文件夹 / 账号 / 时间），细筛与聚合仍走这里。
 * 两边各写一套的话，"搜索结果在开发机上对、在用户机器上不对"是迟早的事。
 */

import type { MessageListQuery, MessageRecord, MessageThreadSummary } from '@agentsws/contracts'

/** 一条记录过不过筛子。 */
export function matchesQuery(m: MessageRecord, q: MessageListQuery): boolean {
  if (q.folder !== undefined && m.folder !== q.folder) return false
  if (q.folder_kind !== undefined && m.folder_kind !== q.folder_kind) return false
  if (q.account !== undefined && m.account !== q.account) return false
  if (q.route !== undefined && m.route !== q.route) return false
  if (q.label !== undefined && !m.labels.includes(q.label)) return false
  if (q.unread === true && m.flags.read) return false
  if (q.starred === true && !m.flags.starred) return false
  if (q.q !== undefined && q.q.trim() !== '' && !matchesText(m, q.q)) return false
  return true
}

/**
 * 搜索：发件人、主题、正文、标签、文件夹五处都算命中（63 §7）。
 *
 * 不做分词、不做相关度排序——一只邮箱里的搜索是"我记得他姓什么"，
 * 子串命中 + 按时间倒序就够了，而且它对中文与英文一视同仁。
 */
export function matchesText(m: MessageRecord, raw: string): boolean {
  const needle = raw.trim().toLowerCase()
  if (needle === '') return true
  const hay = [
    m.from.email,
    m.from.name ?? '',
    ...m.to.map((a) => `${a.email} ${a.name ?? ''}`),
    ...m.cc.map((a) => `${a.email} ${a.name ?? ''}`),
    m.subject,
    m.text,
    m.folder,
    ...m.labels,
  ]
    .join('\n')
    .toLowerCase()
  return hay.includes(needle)
}

/** 新的在前。时间一样时按 id 稳定排（两封同秒的信在列表上不许左右横跳）。 */
export function byNewest(a: MessageRecord, b: MessageRecord): number {
  const ta = Date.parse(a.date)
  const tb = Date.parse(b.date)
  if (ta !== tb) return tb - ta
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
}

/**
 * 会话聚合：同 `thread_id` 的信折成一行。
 *
 * 聚合出来的那一行里几处**故意不取最后一封**的值：
 * - `unread` 是"这条会话里还有几封没读"（不是"最后一封读没读"）；
 * - `starred` 是"里面有没有星标的"（星标是钉在一封上的，但列表上是一行）；
 * - `labels` 与 `folders` 是并集——一条会话的信可能一半在 INBOX、一半已经被
 *   挪进 `kefuagents`，界面要说得出这件事。
 */
export function aggregateThreads(messages: readonly MessageRecord[]): MessageThreadSummary[] {
  const groups = new Map<string, MessageRecord[]>()
  for (const m of messages) {
    const list = groups.get(m.thread_id)
    if (list === undefined) groups.set(m.thread_id, [m])
    else list.push(m)
  }
  const out: MessageThreadSummary[] = []
  for (const [thread_id, list] of groups) {
    const sorted = [...list].sort(byNewest)
    const last = sorted[0]
    if (last === undefined) continue
    const labels = new Set<string>()
    const folders = new Set<string>()
    const accounts = new Set<string>()
    const participants = new Map<string, { email: string; name?: string | undefined }>()
    let unread = 0
    let starred = false
    let needs_reply = false
    for (const m of sorted) {
      for (const l of m.labels) labels.add(l)
      folders.add(m.folder)
      accounts.add(m.account)
      if (!m.flags.read) unread += 1
      if (m.flags.starred) starred = true
      if (m.triage?.needs_reply === true) needs_reply = true
      for (const a of [m.from, ...m.to, ...m.cc]) {
        if (a.email === m.account) continue
        if (!participants.has(a.email)) participants.set(a.email, { ...a })
      }
    }
    out.push({
      thread_id,
      subject: last.subject,
      participants: [...participants.values()].map((p) =>
        p.name === undefined ? { email: p.email } : { email: p.email, name: p.name },
      ),
      last_at: last.date,
      count: sorted.length,
      unread,
      starred,
      labels: [...labels],
      route: last.route,
      folders: [...folders],
      accounts: [...accounts],
      needs_reply,
      snippet: last.snippet,
      last_message_id: last.id,
    })
  }
  return out.sort((a, b) => Date.parse(b.last_at) - Date.parse(a.last_at))
}
