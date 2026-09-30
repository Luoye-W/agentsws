/**
 * WP207：事项的**归档与找回**——纯逻辑部分（没有 IO、没有模型）。
 *
 * - 自动归档的判据（`archiveVerdict`）：开着的事超过 N 天没有新活动；在跑的运行、
 *   等你批的卡由宿主判（`busy`），它们**不自动归档**。
 * - 找回的打分（`rankArchived`）：关键词（中英混排：拉丁按词、中文按字对）+ 可选的语义分
 *   （宿主有嵌入就给，没有就只有关键词）+ 时间段（「上周」「昨天」拆出来的窗口，**加分不硬筛**——
 *   人给的是模糊印象，差一两天的不该被筛掉）。
 *
 * 纪律：时间一律调用方给（`now`），本文件不产生时间。
 */
import type { ArchivedWorkCandidate, Iso8601, Matter } from '@agentsws/contracts'
import { DAY_MS, ms } from './util.js'

/** 一件事能不能自动归档（开着、没归档、超过 N 天没动、宿主说它不忙）。 */
export function archiveVerdict(
  matter: Matter,
  input: { now: Iso8601; idle_days: number | null; busy?: boolean },
): boolean {
  if (input.idle_days === null || input.idle_days <= 0) return false
  if (matter.archived_at !== undefined) return false
  if (matter.status === 'closed') return false
  if (input.busy === true) return false
  return ms(input.now) - ms(matter.context.last_activity) >= input.idle_days * DAY_MS
}

const CJK = /[㐀-鿿豈-﫿぀-ヿ]/

/**
 * 找回用的粗分词：拉丁 / 数字按词，中文按**相邻两字**（单个字的词留单字）。
 *
 * 中文没有空格，按字切太碎（「红人」拆成「红」「人」，满库都是「人」），
 * 按两字一对切，「美国红人」→「美国 / 国红 / 红人」，命中「红人」就算。
 */
export function recallTokens(text: string): string[] {
  const out: string[] = []
  const lower = text.toLowerCase()
  for (const m of lower.matchAll(/[a-z0-9]+|[㐀-鿿豈-﫿぀-ヿ]+/gu)) {
    const run = m[0]
    if (!CJK.test(run)) {
      if (run.length >= 2 || /[0-9]/.test(run)) out.push(run)
      continue
    }
    if (run.length === 1) {
      out.push(run)
      continue
    }
    for (let i = 0; i + 1 < run.length; i += 1) out.push(run.slice(i, i + 2))
  }
  return [...new Set(out)]
}

/** 找回时常见、却不指向任何一件事的英文词（中文的在 {@link CJK_FILLER} 里先整段去掉）。 */
const RECALL_STOP = new Set([
  'the',
  'that',
  'this',
  'with',
  'about',
  'chat',
  'conversation',
  'task',
  'restore',
  'recover',
  'find',
  'bring',
  'back',
  'archived',
  'my',
  'me',
  'we',
  'to',
  'of',
  'and',
  'on',
  'in',
  'it',
  'please',
])

/**
 * 中文里的虚词与「找回来 / 对话」这类套话：分词前先整段换成空格，
 * 否则「的对」「话找」这种跨词的字对会冲淡真正的关键词。
 */
const CJK_FILLER =
  /找回来|找一下|找回|恢复一下|恢复|放回来|回来|对话|会话|任务|聊天|聊过|聊的|之前|以前|上次|那个|这个|那件|那条|这件|一个|一下|帮我|我想|想要|我要|把|跟|和|与|的|了|吗|呢|吧|请|帮|找|聊|谈过/g

export interface RecallDoc {
  matter: Matter
  /** 参与人的展示名（宿主翻译好）。 */
  people: string[]
  /** 岗位 / 职责的展示名（宿主翻译好）。 */
  labels: string[]
  /** 时间线正文（人话与 Agent 的话），宿主截好长度。 */
  body: string
}

export interface TimeWindow {
  since?: Iso8601
  until?: Iso8601
  /** 人话：「上周」「昨天」。 */
  label?: string
}

const iso = (t: number): Iso8601 => new Date(t).toISOString()

/**
 * 从一句模糊的话里拆时间段（「上周」「昨天」「3 天前」「last week」）。拆不出来就是空窗口。
 *
 * 周一算一周的开始；日界线按工作区时区（`tz_offset_minutes`，默认 +8）。
 * 「N 天前」给前后各放宽一天——人记的日子常差一天。
 */
export function timeHint(text: string, now: Iso8601, tz_offset_minutes = 480): TimeWindow {
  const s = text.toLowerCase()
  const nowMs = ms(now)
  const shift = tz_offset_minutes * 60_000
  const day0 = Math.floor((nowMs + shift) / DAY_MS) * DAY_MS - shift
  const local = new Date(nowMs + shift)
  const weekStart = day0 - ((local.getUTCDay() + 6) % 7) * DAY_MS
  const monthStart = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - shift
  const prevMonthStart = Date.UTC(local.getUTCFullYear(), local.getUTCMonth() - 1, 1) - shift
  const win = (from: number, to: number, label: string): TimeWindow => ({
    since: iso(from),
    until: iso(to),
    label,
  })
  const days = /(\d{1,2})\s*(?:天前|days?\s+ago)/.exec(s)
  if (days !== null) {
    const n = Number(days[1])
    return win(day0 - (n + 1) * DAY_MS, day0 - (n - 2) * DAY_MS, `${n} 天前`)
  }
  const recent = /(?:最近|近|past|last)\s*(\d{1,2})\s*(?:天|days?)/.exec(s)
  if (recent !== null) {
    const n = Number(recent[1])
    return win(day0 - (n - 1) * DAY_MS, nowMs + 1, `最近 ${n} 天`)
  }
  if (/前天|day before yesterday/.test(s)) return win(day0 - 2 * DAY_MS, day0 - DAY_MS, '前天')
  if (/昨天|yesterday/.test(s)) return win(day0 - DAY_MS, day0, '昨天')
  if (/今天|today/.test(s)) return win(day0, day0 + DAY_MS, '今天')
  if (/上周|上个?星期|上个?礼拜|last week/.test(s))
    return win(weekStart - 7 * DAY_MS, weekStart, '上周')
  if (/这周|本周|这个?星期|this week/.test(s)) return win(weekStart, weekStart + 7 * DAY_MS, '这周')
  if (/上个?月|last month/.test(s)) return win(prevMonthStart, monthStart, '上个月')
  if (/这个月|本月|this month/.test(s)) return win(monthStart, nowMs + 1, '这个月')
  if (/前几天|前些天|few days ago/.test(s)) return win(day0 - 7 * DAY_MS, day0, '前几天')
  return {}
}

/** 查询词：去掉时间字眼与「找回 / 对话」这类不指向任何一件事的词。 */
export function queryTerms(text: string): string[] {
  const stripped = text
    .toLowerCase()
    .replace(
      /(\d{1,2})\s*(?:天前|days?\s+ago)|(?:最近|近|past|last)\s*\d{1,2}\s*(?:天|days?)|前天|昨天|今天|上周|这周|本周|上个?星期|这个?星期|上个?月|这个月|本月|前几天|前些天|yesterday|today|last week|this week|last month|this month/g,
      ' ',
    )
  return recallTokens(stripped.replace(CJK_FILLER, ' ')).filter((t) => !RECALL_STOP.has(t))
}

/** 一件事和这组词有多像：标题 3、摘要 2、参与人 2、岗位 / 职责名 1、正文 1，按命中的权重归一到 0..1。 */
export function keywordScore(
  terms: readonly string[],
  doc: RecallDoc,
): { score: number; why: string[]; strong: boolean } {
  if (terms.length === 0) return { score: 0, why: [], strong: false }
  const fields: { text: string; weight: number; name: string }[] = [
    { text: doc.matter.title.toLowerCase(), weight: 3, name: 'title' },
    { text: doc.matter.context.summary.toLowerCase(), weight: 2, name: 'summary' },
    { text: doc.people.join(' ').toLowerCase(), weight: 2, name: 'people' },
    // 岗位 / 职责名是弱信号：同一个岗位下的事个个都带着它，不能光凭它进候选
    { text: doc.labels.join(' ').toLowerCase(), weight: 1, name: 'labels' },
    { text: doc.body.toLowerCase(), weight: 1, name: 'body' },
  ]
  let got = 0
  const hitWords = new Map<string, string[]>()
  for (const term of terms) {
    const best = fields.find((f) => f.text.includes(term))
    if (best === undefined) continue
    got += best.weight
    hitWords.set(best.name, [...(hitWords.get(best.name) ?? []), term])
  }
  const why: string[] = []
  for (const [name, words] of hitWords) why.push(`${name}:${mergeBigrams(words).join(' ')}`)
  // 只中了岗位 / 职责名不算"像"：同一个岗位下的事个个都带着它
  const strong = [...hitWords.keys()].some((k) => k !== 'labels')
  // 分母封顶 4 个词：模型常把同一件事的几种说法（中英、同义）一起给，
  // 命中其中一半就该是"很像"，不能被没命中的同义词摊薄
  return { score: Math.min(1, got / (Math.min(terms.length, 4) * 3)), why, strong }
}

/** 「美国 / 国红 / 红人」拼回「美国红人」，给人看的理由里不出现半截词。 */
function mergeBigrams(words: readonly string[]): string[] {
  const out: string[] = []
  for (const w of words) {
    const last = out.at(-1)
    if (last !== undefined && CJK.test(w) && w.length === 2 && last.endsWith(w[0] ?? '')) {
      out[out.length - 1] = last + w.slice(1)
    } else out.push(w)
  }
  return out
}

/** 找回最多给几个候选（卡片列 3–5 个最像的；模型要多看几个时最多 8）。 */
export const RECALL_DEFAULT_LIMIT = 5
export const RECALL_MAX_LIMIT = 8
/** 低于这个分就不算"像"——宁可少给，别把不相干的塞进候选卡。 */
export const RECALL_MIN_SCORE = 0.12

export interface RankInput {
  query: string
  since?: Iso8601
  until?: Iso8601
  position?: string
  participant?: string
  limit?: number
  now: Iso8601
  tz_offset_minutes?: number
}

const within = (at: Iso8601, w: TimeWindow): boolean =>
  (w.since === undefined || ms(at) >= ms(w.since)) &&
  (w.until === undefined || ms(at) < ms(w.until))

const mentions = (hay: readonly string[], needle: string): boolean => {
  const n = needle.trim().toLowerCase()
  return n !== '' && hay.some((h) => h.toLowerCase().includes(n) || n.includes(h.toLowerCase()))
}

/**
 * 混合检索：关键词 +（有的话）语义分 + 时间段 / 岗位 / 参与人加减分，给出最像的几个候选。
 *
 * `semantic[i]` 是第 i 件事与这句话的语义相似度（0..1，宿主用本机已有的嵌入算；没有就不给），
 * 只是加一路分，**不替代**关键词——嵌入模型没配时照样能找。
 */
export function rankArchived(
  docs: readonly RecallDoc[],
  input: RankInput,
  semantic?: readonly (number | undefined)[],
): ArchivedWorkCandidate[] {
  const terms = queryTerms(input.query)
  const hint = timeHint(input.query, input.now, input.tz_offset_minutes)
  const window: TimeWindow =
    input.since !== undefined || input.until !== undefined
      ? {
          ...(input.since === undefined ? {} : { since: input.since }),
          ...(input.until === undefined ? {} : { until: input.until }),
          label: hint.label ?? 'range',
        }
      : hint
  const hasWindow = window.since !== undefined || window.until !== undefined
  const out: ArchivedWorkCandidate[] = []
  docs.forEach((doc, i) => {
    const kw = keywordScore(terms, doc)
    const sem = semantic?.[i]
    const why = [...kw.why]
    const m = doc.matter
    const inWindow =
      hasWindow && (within(m.context.last_activity, window) || within(m.created_at, window))
    let score: number
    // 只说了时间（「上周那个」）：窗口里的都算，窗口外的不算
    if (terms.length === 0) score = inWindow ? 0.5 : 0
    else score = sem === undefined ? kw.score : 0.65 * kw.score + 0.35 * sem
    if (terms.length > 0 && !kw.strong && (sem === undefined || sem < 0.5)) return
    if (sem !== undefined && sem >= 0.5) why.push('semantic')
    // 时间是模糊印象：窗口里的按比例加分，窗口外的按比例减分，不硬筛
    if (hasWindow && terms.length > 0) score = inWindow ? score * 1.3 + 0.05 : score * 0.75
    if (inWindow) why.push(`time:${window.label ?? ''}`)
    if (input.participant !== undefined) {
      if (mentions(doc.people, input.participant)) {
        score += 0.2
        why.push(`people:${input.participant}`)
      } else score *= 0.7
    }
    if (input.position !== undefined) {
      const p = input.position
      if (doc.matter.position_template_id === p || mentions(doc.labels, p)) score += 0.15
      else score *= 0.7
    }
    if (score < RECALL_MIN_SCORE) return
    out.push({
      matter_id: m.id,
      title: m.title,
      summary: m.context.summary,
      ...(m.position_template_id === undefined
        ? {}
        : { position_template_id: m.position_template_id }),
      ...(m.role_id === undefined ? {} : { role_id: m.role_id }),
      archived_at: m.archived_at ?? m.context.last_activity,
      last_activity: m.context.last_activity,
      score: Math.min(1, Math.round(score * 1000) / 1000),
      why,
    })
  })
  const limit = Math.min(RECALL_MAX_LIMIT, Math.max(1, input.limit ?? RECALL_DEFAULT_LIMIT))
  return out
    .sort(
      (a, b) =>
        b.score - a.score ||
        ms(b.last_activity) - ms(a.last_activity) ||
        (a.matter_id < b.matter_id ? -1 : 1),
    )
    .slice(0, limit)
}

/**
 * 全文搜（归档列表的搜索框与 ⌘K）：标题、摘要、正文里**都出现**这几个词才算，
 * 按最后活动时间倒序。和找回不同：这里是"我记得字"，不是"我记得个大概"。
 */
export function textMatches(query: string, doc: RecallDoc): boolean {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w !== '')
  if (words.length === 0) return true
  const hay = [doc.matter.title, doc.matter.context.summary, doc.body, ...doc.people, ...doc.labels]
    .join('\n')
    .toLowerCase()
  return words.every((w) => hay.includes(w))
}
