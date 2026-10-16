/**
 * WP352（决策 931，Luoye 10-16）：「助理」只有一条长对话，上下文分四层，每一轮由服务端拼，
 * **不把整条历史塞给模型**：
 *
 * ① 当前段原话：最近这一段的原文；超过预算（按模型窗口约 50%）就把段内较早那部分压成段内小结；
 * ② 自动分段：隔了 2 小时以上 / 跨天 / 人说「换个话题」或点了那个钮 / 模型判断话题变了（回答开头写
 *    {@link TOPIC_TAG}，零额外调用），就切段；旧段压成一条「话题小结」存本机；最近几段的小结进开场上下文；
 * ③ 长期记忆：WP343 助理记忆，只带条目（`assistant-memory.ts`）；
 * ④ 按需翻旧账：只读工具「查以前聊过的」（{@link searchHistory}），按关键词 / 时间搜小结与原话，回片段与出处。
 *
 * 这里只放纯函数（切不切、怎么估 token、怎么拼、怎么搜、小结怎么写）；读写存储与调模型在 `free-chat.ts`。
 *
 * 小结的提示词与「一次性压成结构化检查点、再压时把旧检查点合并而不是照抄」的做法移植自 DeepSeek 官方
 * `@deepseek-ai/dsh-compaction-basic@0.2.1-alpha.2`（MIT，`lib/index.js` 的 `COMPACTION_INSTRUCTION`），
 * 改成生意上的话（谁、要做什么、定了什么、派了哪些事），分节也照我们的需要换了。官方那一份挂在 dsh 会话
 * 存储与 token 计量上；助理的每一轮是直连模型网关的无状态调用（stub / direct / dsh 同一条路），接不上它，
 * 只能搬做法（见报告「自主决定」）。
 */
import type { FreeChatMessageView } from '@agentsws/api'
import type { AssistantSegmentReason, AssistantSegmentRow } from './free-chat-store.js'

/** 隔多久没说话就算新的一段。 */
export const SEGMENT_GAP_MS = 2 * 60 * 60 * 1000
/** 模型窗口拿不到时按这个算（DeepSeek 对话模型 64K 起）。 */
export const DEFAULT_CONTEXT_WINDOW = 64_000
/** 当前段原话最多占窗口的多少。 */
export const RAW_BUDGET_RATIO = 0.5
/** 段内压缩之后，最近的原话留多少（占原话预算的比例）。 */
export const RETAIN_RATIO = 0.4
/** 开场上下文带最近几段的小结。 */
export const RECENT_TOPICS = 3
/** 那几段小结一共最多多少 token。 */
export const TOPICS_BUDGET = 1500
/** 「查以前聊过的」一次最多回几处。 */
export const MAX_HISTORY_HITS = 8
/** 模型觉得用户这句开了一个新话题时，写在回答最开头的记号（不给人看）。 */
export const TOPIC_TAG = '<new-topic/>'

/** 粗估 token：汉字（及全角）一个字算 1，其余 4 个字符算 1（宁多不少，用来卡预算）。 */
export function estimateTokens(text: string): number {
  let wide = 0
  for (const ch of text) if ((ch.codePointAt(0) ?? 0) > 0x2e7f) wide += 1
  return wide + Math.ceil((text.length - wide) / 4)
}

/** 一条话进模型大概多少 token（附件正文也算）。 */
export function messageTokens(m: FreeChatMessageView): number {
  const files = (m.attachments ?? []).reduce((n, a) => n + estimateTokens(a.text ?? ''), 0)
  return estimateTokens(m.text) + files + 4
}

/** 人在这句话里自己说要换话题（就当点了那个钮）。 */
const SAY_NEW_TOPIC = /^\s*(换个话题|换个事|聊点别的|说点别的|说个别的|新话题|另外一件事|另一件事)/u

/** 本地日历日（按这台电脑的时区；`offsetMin` 给测试钉时区）。 */
function localDay(iso: string, offsetMin: number): string {
  return new Date(Date.parse(iso) + offsetMin * 60_000).toISOString().slice(0, 10)
}

/**
 * 这句话来之前要不要先切一段：说了「换个话题」→ `manual`；跨天 → `day`；隔了 2 小时以上 → `gap`；否则不切。
 * `last_at` 是当前这段最后一句话的时间（这段还空着就不切）。
 */
export function splitBefore(input: {
  last_at: string | undefined
  now: string
  text: string
  offsetMin?: number
}): AssistantSegmentReason | undefined {
  if (input.last_at === undefined) return undefined
  if (SAY_NEW_TOPIC.test(input.text)) return 'manual'
  const offset = input.offsetMin ?? -new Date(input.now).getTimezoneOffset()
  if (localDay(input.last_at, offset) !== localDay(input.now, offset)) return 'day'
  if (Date.parse(input.now) - Date.parse(input.last_at) > SEGMENT_GAP_MS) return 'gap'
  return undefined
}

/** 回答里那个「换话题了」记号拿掉（流式时界面也藏它）。 */
export function splitTopicTag(text: string): { text: string; shifted: boolean } {
  if (!text.includes(TOPIC_TAG)) return { text, shifted: false }
  return { text: text.split(TOPIC_TAG).join('').replace(/^\s+/u, ''), shifted: true }
}

/** 系统提示里那一句（什么时候写记号）。 */
export const TOPIC_RULE = `- 用户这句话和前面聊的完全无关、是另起的一件事时，在回答最开头写 ${TOPIC_TAG}（不给人看，只用来分段）；接着前面聊的就不要写。`

/** 这段里交出去的事（编号 + 一句话），从话里收。 */
export function dispatchesOf(
  rows: readonly FreeChatMessageView[],
): NonNullable<AssistantSegmentRow['dispatches']> {
  const out: NonNullable<AssistantSegmentRow['dispatches']> = []
  for (const m of rows)
    for (const d of m.dispatches ?? [])
      if (!out.some((x) => x.matter_id === d.matter_id))
        out.push({
          matter_id: d.matter_id,
          title: d.title,
          position_name: d.position_name,
          ...(m.fanout?.batch_id === undefined ? {} : { batch_id: m.fanout.batch_id }),
        })
  return out
}

const oneLine = (s: string, n: number): string => {
  const t = s.replace(/\s+/gu, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

/** 模型不在 / 没答出来时的小结：用户第一句当标题，加上派了哪些事。 */
export function ruleSummary(rows: readonly FreeChatMessageView[]): {
  title: string
  summary: string
} {
  const users = rows.filter((m) => m.role === 'user')
  const first = users[0]
  const said = first === undefined ? '' : first.text || (first.attachments?.[0]?.name ?? '')
  const title = said === '' ? '（没说什么）' : oneLine(said, 24)
  const lines = users
    .slice(0, 3)
    .map((m) => `- 你说：${oneLine(m.text || (m.attachments?.[0]?.name ?? ''), 60)}`)
  const sent = dispatchesOf(rows)
  if (sent.length > 0)
    lines.push(
      `- 交出去的事：${sent.map((d) => `${d.position_name}「${oneLine(d.title, 20)}」`).join('；')}`,
    )
  return { title, summary: lines.join('\n') }
}

/**
 * 话题小结 / 段内压缩的指令（做法移植自官方 `dsh-compaction-basic` 的 `COMPACTION_INSTRUCTION`：
 * 固定分节、空节写「无」、保留原话里的数字 / 名字 / 编号、已有旧小结时合并而不是照抄；分节改成生意上的）。
 */
export function summaryInstruction(kind: 'topic' | 'compact'): string {
  return [
    kind === 'topic'
      ? '你在给「Agents 工坊」里用户和他的助理的一段对话写话题小结：这段已经聊完了，之后助理只看这份小结，不再看原话。'
      : '你在给「Agents 工坊」里用户和他的助理的一段对话压缩前半段：之后助理只看这份小结和后面的原话。',
    '第一行只写一个标题（不超过 20 个字，说清这段在聊什么，不加标点和「标题：」）。从第二行起严格按下面的分节写，每节用短句列点，没有就写「- 无」：',
    '## 谁',
    '- 涉及的人、客户、岗位、商品、平台',
    '## 要做什么',
    '- 用户想做的事、他的原始要求（关键处照抄原话）',
    '## 定了什么',
    '- 已经定下的口径、数字、做法，以及为什么',
    '## 派了哪些事',
    '- 交给了哪个岗位、哪件事（只写一句话；进度以后现查，不要写进度）',
    '## 还没完的',
    '- 说好要做还没做的、还在等用户回答的',
    '规则：用用户的语言写；保留原话里的数字、名字、编号、日期；不要写「这段对话」「小结如下」这类话；不要编没出现过的事。',
    '对话里如果已经有一份「前面聊过的（已压缩）」，那是之前的小结：仍然成立的留下、过时的去掉、新的并进去，合成一份。',
  ].join('\n')
}

/** 话 → 给小结用的逐字稿（附件只写名字；交出去的事写成一行）。 */
export function transcriptOf(rows: readonly FreeChatMessageView[], prior?: string): string {
  const lines: string[] = []
  if (prior !== undefined && prior !== '') lines.push(`前面聊过的（已压缩）：\n${prior}`, '')
  for (const m of rows) {
    if (m.error !== undefined && m.text === '') continue
    const who = m.role === 'user' ? '用户' : m.report === undefined ? '助理' : '回报'
    const files = (m.attachments ?? []).map((a) => `［附件「${a.name}」］`).join('')
    lines.push(`${who}（${m.at.slice(5, 16).replace('T', ' ')}）：${m.text.slice(0, 4000)}${files}`)
    for (const d of m.dispatches ?? [])
      lines.push(
        `［交给了${d.position_name}${d.duty_name === undefined ? '' : ` · ${d.duty_name}`}：${d.title}（${d.matter_id}）］`,
      )
  }
  return lines.join('\n')
}

/** 模型回的小结 → 标题 + 正文（第一行是标题）。空的回 `undefined`。 */
export function parseSummary(text: string): { title: string; summary: string } | undefined {
  const lines = text
    .replace(/\r/gu, '')
    .split('\n')
    .map((l) => l.trimEnd())
  while (lines.length > 0 && (lines[0] ?? '').trim() === '') lines.shift()
  const head = (lines.shift() ?? '')
    .replace(/^#+\s*/u, '')
    .replace(/^标题[:：]\s*/u, '')
    .trim()
  const body = lines.join('\n').trim()
  if (head === '' && body === '') return undefined
  return { title: oneLine(head === '' ? body : head, 24), summary: body === '' ? head : body }
}

/** 一段的一行小结（分隔线上）与给模型看的那几行。 */
export function topicLine(seg: AssistantSegmentRow, rows: readonly FreeChatMessageView[]): string {
  const fallback = seg.summary === undefined ? ruleSummary(rows) : undefined
  const title = seg.title ?? fallback?.title ?? ''
  const body = seg.summary ?? fallback?.summary ?? ''
  const sent = seg.dispatches ?? dispatchesOf(rows)
  const ids =
    sent.length === 0
      ? ''
      : `\n- 事项编号：${sent.map((d) => d.matter_id).join('、')}（进度用工具现查）`
  return `### ${seg.started_at.slice(0, 10)} ${title}\n${body}${ids}`
}

/** 当前段的原话预算（token）。 */
export const rawBudget = (window = DEFAULT_CONTEXT_WINDOW): number =>
  Math.floor(window * RAW_BUDGET_RATIO)

/**
 * ① 当前段原话怎么带：段内压过就从压过的那条之后开始；超预算就算出要压掉的那一截（最近的原话留
 * {@link RETAIN_RATIO} 的预算，至少留最后一条）。`rows` 是这段的话（到这一句为止）。
 */
export function planRaw(
  seg: Pick<AssistantSegmentRow, 'compact'>,
  rows: readonly FreeChatMessageView[],
  budget: number,
): { raw: FreeChatMessageView[]; tokens: number; fold?: FreeChatMessageView[] } {
  const from = seg.compact === undefined ? 0 : rows.findIndex((m) => m.id === seg.compact?.upto) + 1
  const raw = rows.slice(Math.max(0, from))
  const tokens = raw.reduce((n, m) => n + messageTokens(m), 0)
  if (tokens <= budget || raw.length < 2) return { raw, tokens }
  const keepBudget = Math.floor(budget * RETAIN_RATIO)
  let cut = raw.length - 1
  let kept = messageTokens(raw[cut] as FreeChatMessageView)
  while (cut > 1) {
    const more = messageTokens(raw[cut - 1] as FreeChatMessageView)
    if (kept + more > keepBudget) break
    kept += more
    cut -= 1
  }
  return { raw: raw.slice(cut), tokens: kept, fold: raw.slice(0, cut) }
}

/** ② 开场上下文里「最近聊过的几个话题」：当前段之前、最近的几段，按预算从新往旧收。 */
export function recentTopics(
  closed: readonly { seg: AssistantSegmentRow; rows: readonly FreeChatMessageView[] }[],
): { text: string; count: number; tokens: number } {
  const picked: string[] = []
  let tokens = 0
  for (const one of [...closed].reverse().slice(0, RECENT_TOPICS)) {
    const line = topicLine(one.seg, one.rows)
    const t = estimateTokens(line)
    if (picked.length > 0 && tokens + t > TOPICS_BUDGET) break
    picked.unshift(line)
    tokens += t
  }
  return { text: picked.join('\n\n'), count: picked.length, tokens }
}

export interface HistoryHit {
  segment_id: string
  message_id?: string
  kind: 'message' | 'summary'
  at: string
  role?: 'user' | 'assistant'
  title?: string
  snippet: string
  score: number
}

const snippetAround = (text: string, words: readonly string[]): string => {
  const flat = text.replace(/\s+/gu, ' ').trim()
  const lower = flat.toLowerCase()
  const at = Math.max(0, Math.min(...words.map((w) => lower.indexOf(w)).filter((i) => i >= 0)))
  const from = Math.max(0, at - 40)
  return `${from > 0 ? '…' : ''}${flat.slice(from, at + 80)}${at + 80 < flat.length ? '…' : ''}`
}

/**
 * ④ 搜以前聊过的：关键词（空格隔开，命中越多越靠前，一样多新的在前）搜段落小结与原话；`skip` 那一段
 * （正在聊的，已经在上下文里）不搜原话。只读。
 */
export function searchHistory(
  segs: readonly { seg: AssistantSegmentRow; rows: readonly FreeChatMessageView[] }[],
  q: { q: string; since?: string; until?: string; skip?: string },
): HistoryHit[] {
  const words = [
    ...new Set(
      q.q
        .toLowerCase()
        .split(/[\s,，、]+/u)
        .filter((w) => w !== ''),
    ),
  ]
  if (words.length === 0) return []
  const inRange = (at: string): boolean =>
    (q.since === undefined || at >= q.since) && (q.until === undefined || at < q.until)
  const score = (text: string): number => {
    const lower = text.toLowerCase()
    return words.filter((w) => lower.includes(w)).length
  }
  const hits: HistoryHit[] = []
  for (const { seg, rows } of segs) {
    const title = seg.title ?? (seg.summary === undefined ? ruleSummary(rows).title : undefined)
    const sum = `${seg.title ?? ''}\n${seg.summary ?? ''}`
    const s = score(sum)
    if (s > 0 && inRange(seg.ended_at ?? seg.started_at))
      hits.push({
        segment_id: seg.id,
        kind: 'summary',
        at: seg.started_at,
        ...(title === undefined ? {} : { title }),
        snippet: snippetAround(seg.summary ?? seg.title ?? '', words),
        score: s + 0.5,
      })
    if (seg.id === q.skip) continue
    for (const m of rows) {
      if (m.text === '' || !inRange(m.at)) continue
      const text = `${m.text} ${(m.attachments ?? []).map((a) => a.name).join(' ')}`
      const ms = score(text)
      if (ms === 0) continue
      hits.push({
        segment_id: seg.id,
        message_id: m.id,
        kind: 'message',
        at: m.at,
        role: m.role,
        ...(title === undefined ? {} : { title }),
        snippet: snippetAround(text, words),
        score: ms,
      })
    }
  }
  return hits
    .sort((a, b) => b.score - a.score || (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, MAX_HISTORY_HITS)
}
