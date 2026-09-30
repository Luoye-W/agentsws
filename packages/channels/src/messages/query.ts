/**
 * WP113（63 §7）：筛选、搜索与**会话聚合**的纯函数。
 *
 * 抽出来是因为两个实现（内存与 SQLite）必须给出**逐字一样**的答案：
 * SQLite 那一份只用索引做粗筛（文件夹 / 账号 / 时间），细筛与聚合仍走这里。
 * 两边各写一套的话，"搜索结果在开发机上对、在用户机器上不对"是迟早的事。
 */

import type {
  MessageClaim,
  MessageListQuery,
  MessageRecord,
  MessageThreadSummary,
} from '@agentsws/contracts'
import { kindOfLegacy } from './kind.js'

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
  if (q.pending_route === true && pendingRouteOf(m) === undefined) return false
  return true
}

/**
 * WP167：这封信是不是「待确认」——分拣判不准（把握不够）的客服 / 红人信（WP172 起也收 B2B）。
 *
 * 判据只有一条：分拣挂了 `suggested_route`、信还留在 `inbox` 那条路上、而且人还没判过。
 * 人点过「这是客服」或「不是」之后分拣结论就是 `by: 'user'`，它从这一栏里消失。
 */
export function pendingRouteOf(m: MessageRecord): MessageRecord['route'] | undefined {
  const t = m.triage
  if (t === undefined || t.by === 'user' || m.route !== 'inbox') return undefined
  const s = t.suggested_route
  return s === 'support' || s === 'kol' || s === 'b2b' ? s : undefined
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
 *   挪进 `KefuAgents`，界面要说得出这件事。
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
    let pending: { route: MessageRecord['route']; id: string } | undefined
    for (const m of sorted) {
      const wanted = pendingRouteOf(m)
      if (pending === undefined && wanted !== undefined) pending = { route: wanted, id: m.id }
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
    const claim = claimOfThread(sorted)
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
      ...(pending === undefined
        ? {}
        : { suggested_route: pending.route, pending_message_id: pending.id }),
      ...claim,
    })
  }
  return out.sort((a, b) => Date.parse(b.last_at) - Date.parse(a.last_at))
}

/* ── WP212：没人接 / 只是通知 / 已交出去（docs/88 §3.1，服务端派生）──────────── */

/** 这封是别人寄来的吗（自己发的、草稿不算"来信"）。 */
export function isInbound(m: MessageRecord): boolean {
  if (m.folder_kind === 'sent' || m.folder_kind === 'drafts') return false
  return m.from.email.trim().toLowerCase() !== m.account.trim().toLowerCase()
}

/** 交给了哪个岗位（分拣自动交的按路由认，人点「交给 X」的按 `handled` 认）。 */
function handedPositionOf(m: MessageRecord): string | undefined {
  if (m.handled?.as === 'position') return m.handled.position_id ?? 'position'
  if (m.route === 'support') return 'customer-care'
  if (m.route === 'kol') return 'kol-marketing'
  if (m.route === 'b2b') return 'b2b'
  return undefined
}

type ThreadClaim = Pick<
  MessageThreadSummary,
  | 'claim'
  | 'claim_message_id'
  | 'kind'
  | 'kind_by'
  | 'kind_confidence'
  | 'summary'
  | 'priority'
  | 'handed_to'
>

/**
 * 一条会话现在是没人接、只是通知、还是已交出去——**只看事实**：
 *
 * 1. 这条会话里有一封归了岗位（分拣交的、或人点了「交给 X」）→ 已交出去（以后同一条会话的新来信
 *    也归那个岗位：交出去之后消息页不再催）；
 * 2. 看**最新那封来信**：进了垃圾箱 / 垃圾邮件 / 归档、人点过「只是通知」/「我自己处理」、
 *    回过了（`\Answered` 或它之后有一封自己发的）→ 已交出去；
 * 3. AI 判了不用回（`needs_reply = false`）→ 只是通知；
 * 4. 其余 → 没人接（包括没分拣过的——宁可多问一句，不让一封信没人看）。
 *
 * 整条会话里一封来信都没有（只有自己发的）：不给 `claim`。
 */
export function claimOfThread(sorted: readonly MessageRecord[]): ThreadClaim {
  const newestFirst = [...sorted].sort(byNewest)
  const inbound = newestFirst.filter(isInbound)
  const latest = inbound[0]
  const describe = (m: MessageRecord | undefined): ThreadClaim => {
    if (m === undefined) return {}
    const kind = kindOfLegacy(m.triage, m.labels, m.route)
    return {
      kind: kind.kind,
      kind_confidence: kind.confidence,
      ...(m.triage?.kind_by === undefined ? {} : { kind_by: m.triage.kind_by }),
      ...(m.triage?.summary === undefined || m.triage.summary === ''
        ? {}
        : { summary: m.triage.summary }),
      ...(m.triage?.priority === undefined ? {} : { priority: m.triage.priority }),
    }
  }
  const handedTo = newestFirst.map(handedPositionOf).find((p) => p !== undefined)
  if (handedTo !== undefined) return { claim: 'handed', handed_to: handedTo, ...describe(latest) }
  // 只有自己发的（已发 / 草稿）：不是来信，不算进没人接 / 已交出去任何一格
  if (latest === undefined) return {}
  const repliedAfter = newestFirst.some(
    (m) => !isInbound(m) && m.folder_kind !== 'drafts' && byNewest(m, latest) < 0,
  )
  if (
    latest.folder_kind === 'trash' ||
    latest.folder_kind === 'spam' ||
    latest.folder_kind === 'archive' ||
    latest.handled !== undefined ||
    latest.flags.answered ||
    repliedAfter
  )
    return {
      claim: 'handed',
      handed_to: latest.handled?.as === 'notice' ? 'notice' : 'me',
      ...describe(latest),
    }
  const claim: MessageClaim = latest.triage?.needs_reply === false ? 'notice' : 'unclaimed'
  return { claim, claim_message_id: latest.id, ...describe(latest) }
}

/** `claim` 这一格筛子（聚合之后才判得了：看的是整条会话）。 */
export function matchesClaim(t: MessageThreadSummary, q: MessageListQuery): boolean {
  return q.claim === undefined || t.claim === q.claim
}
