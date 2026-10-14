/**
 * WP330（docs/102 附：甲方周报要求）：**Reddit 周报**——纯函数（不读钟、不联网、不调模型）。
 *
 * 1. {@link redditWeekWindow}：窗口「起始那天 00:00（本地，默认周日）— 现在」；
 * 2. {@link composeRedditWeekly}：WP328 巡查入库的条目 + 发出记录里本周的 Reddit 回复 → 四节 + 一份 Markdown；
 * 3. {@link normalizeRedditWeeklyFormat}：AI 按用户的话改分节与措辞时给的那一份 → 校验、补齐（只认这几样）。
 *
 * 数字全是数出来的（按条目 id 去重、按 Reddit 上的发出时间进窗口）；话题概括、评估、VOC / UGC 判断是
 * WP328 已经判好的，这里只按话题合并、取最重的那一档。不截图，一律原文引用 + 链接。
 */
import {
  DEFAULT_REDDIT_WEEKLY_FORMAT,
  type Iso8601,
  type OutboundRecord,
  REDDIT_ASSESSMENTS,
  REDDIT_WEEKLY_ACTION,
  REDDIT_WEEKLY_SECTION_IDS,
  type RedditAssessment,
  type RedditWatchItem,
  type RedditWeeklyFormat,
  type RedditWeeklyPayload,
  type RedditWeeklyQuote,
  type RedditWeeklyReply,
  type RedditWeeklySection,
  type RedditWeeklySectionFormat,
  type RedditWeeklySectionId,
  type RedditWeeklyTopic,
} from '@agentsws/contracts'

const DAY_MS = 86_400_000

/** 本地日期（YYYY-MM-DD）。 */
const localDate = (ms: number, tz: number): string =>
  new Date(ms + tz * 60_000).toISOString().slice(0, 10)

/**
 * 数据窗口：最近一个「起始那天」的本地 00:00（≤ 现在）到现在。
 * 周五 17:00 出报告、起始周日 → 周日 00:00 — 周五 17:00。
 */
export function redditWeekWindow(
  now: Iso8601,
  tzOffsetMinutes: number,
  startWeekday = 0,
): { since: Iso8601; until: Iso8601; week_of: string } {
  const nowMs = Date.parse(now)
  const local = new Date(nowMs + tzOffsetMinutes * 60_000)
  const back = (local.getUTCDay() - (((startWeekday % 7) + 7) % 7) + 7) % 7
  const midnightLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate())
  const sinceMs = midnightLocal - back * DAY_MS - tzOffsetMinutes * 60_000
  return {
    since: new Date(sinceMs).toISOString(),
    until: new Date(nowMs).toISOString(),
    week_of: localDate(sinceMs, tzOffsetMinutes),
  }
}

/** 按记号写时间（只认 YYYY MM DD HH mm ss；本地时区）。 */
export function formatWeeklyDate(at: Iso8601, pattern: string, tzOffsetMinutes: number): string {
  const ms = Date.parse(at)
  if (Number.isNaN(ms)) return at
  const d = new Date(ms + tzOffsetMinutes * 60_000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return pattern
    .replace(/YYYY/g, String(d.getUTCFullYear()))
    .replace(/MM/g, pad(d.getUTCMonth() + 1))
    .replace(/DD/g, pad(d.getUTCDate()))
    .replace(/HH/g, pad(d.getUTCHours()))
    .replace(/mm/g, pad(d.getUTCMinutes()))
    .replace(/ss/g, pad(d.getUTCSeconds()))
}

/* ── 分节与措辞：校验 AI 给的那一份 ────────────────────────────────────── */

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const text = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, max) : undefined
const isSectionId = (v: unknown): v is RedditWeeklySectionId =>
  typeof v === 'string' && (REDDIT_WEEKLY_SECTION_IDS as readonly string[]).includes(v)

/**
 * 在 `base` 上叠 AI 给的改动（只给要改的那几项）。认不出的照实回在 `problems` 里，不瞎猜。
 * `sections` 给了顺序就按它排，没提到的小节接在后面、保持原样（四节永远都在，关掉的 `enabled: false`）。
 */
export function normalizeRedditWeeklyFormat(
  raw: unknown,
  base: RedditWeeklyFormat = DEFAULT_REDDIT_WEEKLY_FORMAT,
): { format: RedditWeeklyFormat; problems: string[] } {
  const problems: string[] = []
  const out: RedditWeeklyFormat = {
    ...base,
    sections: base.sections.map((s) => ({ ...s })),
    assessment_labels: { ...base.assessment_labels },
  }
  if (!isRecord(raw)) return { format: out, problems: ['没给要改什么'] }
  const title = text(raw.title, 120)
  if (title !== undefined) out.title = title
  if (raw.sections !== undefined) {
    if (!Array.isArray(raw.sections)) problems.push('sections 要是一个列表')
    else {
      const seen = new Set<RedditWeeklySectionId>()
      const next: RedditWeeklySectionFormat[] = []
      for (const s of raw.sections) {
        if (!isRecord(s) || !isSectionId(s.id)) {
          problems.push(`认不出的小节：${isRecord(s) ? String(s.id) : String(s)}`)
          continue
        }
        if (seen.has(s.id)) continue
        seen.add(s.id)
        const prev = out.sections.find((x) => x.id === s.id) as RedditWeeklySectionFormat
        const intro =
          s.intro === '' || s.intro === null ? undefined : (text(s.intro, 300) ?? prev.intro)
        next.push({
          id: s.id,
          title: text(s.title, 60) ?? prev.title,
          enabled: typeof s.enabled === 'boolean' ? s.enabled : prev.enabled,
          ...(intro === undefined ? {} : { intro }),
        })
      }
      for (const s of out.sections) if (!seen.has(s.id)) next.push(s)
      out.sections = next
    }
  }
  if (raw.numbering !== undefined) {
    if (raw.numbering === 'zh' || raw.numbering === 'arabic' || raw.numbering === 'none')
      out.numbering = raw.numbering
    else problems.push('numbering 只能是 zh / arabic / none')
  }
  if (isRecord(raw.assessment_labels)) {
    for (const a of REDDIT_ASSESSMENTS) {
      const v = text(raw.assessment_labels[a], 40)
      if (v !== undefined) out.assessment_labels[a] = v
    }
  }
  const int = (v: unknown, min: number, max: number, name: string): number | undefined => {
    if (v === undefined) return undefined
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
      problems.push(`${name} 要是 ${min}–${max} 的整数`)
      return undefined
    }
    return v
  }
  out.quote_max_chars = int(raw.quote_max_chars, 40, 2000, 'quote_max_chars') ?? out.quote_max_chars
  out.max_quotes_per_topic =
    int(raw.max_quotes_per_topic, 0, 100, 'max_quotes_per_topic') ?? out.max_quotes_per_topic
  out.window_start_weekday =
    int(raw.window_start_weekday, 0, 6, 'window_start_weekday') ?? out.window_start_weekday
  if (raw.date_format !== undefined) {
    const f = text(raw.date_format, 30)
    if (f !== undefined && /(YYYY|MM|DD|HH|mm)/.test(f)) out.date_format = f
    else problems.push('date_format 要带 YYYY / MM / DD / HH / mm 这几个记号')
  }
  const instruction = text(raw.instruction, 2000)
  if (instruction !== undefined) out.instruction = instruction
  return { format: out, problems }
}

/* ── 组一份 ─────────────────────────────────────────────────────────────── */

export interface ComposeRedditWeeklyInput {
  now: Iso8601
  window: { since: Iso8601; until: Iso8601; week_of: string }
  tzOffsetMinutes: number
  format: RedditWeeklyFormat
  brand?: string
  /** 自家版块（用户配的；空 = WP328 标 `own` 的都算）。 */
  subreddits: string[]
  /** WP328 巡查入库的条目（可以多给，按窗口挑）。 */
  items: RedditWatchItem[]
  /** 发出记录（可以多给，只取窗口里、Reddit、已发的回复 / 评论 / 帖子）。 */
  records: OutboundRecord[]
  /** 窗口里各次巡查的时间（WP328 给；用来照实说「巡查了几次」）。 */
  sweeps: Iso8601[]
}

const severity = (a: RedditAssessment | undefined): number =>
  REDDIT_ASSESSMENTS.indexOf(a ?? 'no_action')

/** 原话收成一行、截断（不改字）。 */
export function clipQuote(raw: string, max: number): string {
  const one = raw.replace(/\s+/g, ' ').trim()
  return one.length <= max ? one : `${one.slice(0, Math.max(1, max - 1)).trimEnd()}…`
}

const REPLY_ACTIONS = new Set(['reply', 'comment', 'post'])

/** 发出记录的一行 → 回的是帖子 / 评论 / 我们发的新帖（不是 Reddit 回复的回 undefined）。 */
export function replyTargetOf(
  r: Pick<OutboundRecord, 'channel' | 'action' | 'parent_external_id' | 'status'>,
): 'post' | 'comment' | 'new_post' | undefined {
  if (r.channel.toLowerCase() !== 'reddit' || r.status !== 'sent') return undefined
  if (r.action === REDDIT_WEEKLY_ACTION || !REPLY_ACTIONS.has(r.action)) return undefined
  if (r.action === 'post') return 'new_post'
  // Reddit 全名：t1_ = 评论（楼中楼），t3_ = 帖子；没有 parent 的回复是回帖子本身（WP249 起的老路）
  return r.parent_external_id?.startsWith('t1_') === true ? 'comment' : 'post'
}

export function composeRedditWeekly(input: ComposeRedditWeeklyInput): RedditWeeklyPayload {
  const { format, window } = input
  const tz = input.tzOffsetMinutes
  const lo = Date.parse(window.since)
  const hi = Date.parse(window.until)
  const inWindow = (at: string): boolean => {
    const t = Date.parse(at)
    return !Number.isNaN(t) && t >= lo && t <= hi
  }
  const own = new Set(input.subreddits.map((s) => s.replace(/^\/?r\//i, '').toLowerCase()))
  // 同一条只算一次（后给的那一份为准：WP328 后来补判的 VOC / 话题盖掉早先的）
  const byId = new Map<string, RedditWatchItem>()
  for (const it of input.items) if (inWindow(it.created_at)) byId.set(it.id, it)
  const items = [...byId.values()].sort(
    (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at),
  )
  const isOwn = (it: RedditWatchItem): boolean =>
    it.scope === 'own' && (own.size === 0 || own.has(it.subreddit.toLowerCase()))

  const quote = (it: RedditWatchItem): RedditWeeklyQuote => ({
    id: it.id,
    kind: it.kind,
    subreddit: it.subreddit,
    ...(it.author === undefined ? {} : { author: it.author }),
    at: it.created_at,
    url: it.permalink,
    ...(it.title === undefined ? {} : { title: clipQuote(it.title, 120) }),
    text: it.deleted === true ? '' : clipQuote(it.text, format.quote_max_chars),
    ...(it.deleted === true ? { deleted: true } : {}),
    ...(it.signals?.note === undefined ? {} : { note: clipQuote(it.signals.note, 200) }),
  })

  // ① 自家版块：帖子数 / 评论数（被删的照样算——它确实发过）
  const ownItems = items.filter(isOwn)
  const ownNames =
    input.subreddits.length > 0
      ? input.subreddits.map((s) => s.replace(/^\/?r\//i, ''))
      : [...new Set(ownItems.map((i) => i.subreddit))]
  const posts = ownItems.filter((i) => i.kind === 'post').length
  const comments = ownItems.length - posts
  // ② VOC / UGC：只列判过有效的、原话还在的
  const live = ownItems.filter((i) => i.deleted !== true)
  const voc = live.filter((i) => i.signals?.voc === true).map(quote)
  const ugc = live.filter((i) => i.signals?.ugc === true).map(quote)
  // ③ 外部社区：按话题合并，取最重的那一档
  const groups = new Map<string, RedditWatchItem[]>()
  for (const it of items) {
    if (it.scope !== 'external') continue
    const key = it.topic?.key ?? (it.keyword === undefined ? 'other' : `kw:${it.keyword}`)
    groups.set(key, [...(groups.get(key) ?? []), it])
  }
  const topics: RedditWeeklyTopic[] = [...groups.entries()].map(([key, list]) => {
    const latest = [...list].reverse().find((i) => i.topic !== undefined)
    const kw = list.find((i) => i.keyword !== undefined)?.keyword
    const assessment = list.reduce<RedditAssessment>(
      (acc, i) => (severity(i.assessment) > severity(acc) ? (i.assessment ?? acc) : acc),
      'no_action',
    )
    const shown = list.filter((i) => i.deleted !== true)
    const cap = format.max_quotes_per_topic
    const quotes = (cap > 0 ? shown.slice(0, cap) : shown).map(quote)
    return {
      key,
      label: latest?.topic?.label ?? (kw === undefined ? '其他' : `关键词「${kw}」`),
      posts: list.filter((i) => i.kind === 'post').length,
      comments: list.filter((i) => i.kind === 'comment').length,
      assessment,
      quotes,
      more: shown.length - quotes.length,
    }
  })
  topics.sort(
    (a, b) =>
      severity(b.assessment) - severity(a.assessment) ||
      b.posts + b.comments - (a.posts + a.comments) ||
      a.label.localeCompare(b.label),
  )
  // ④ 我们本周发出去的（发出记录）
  const replies: RedditWeeklyReply[] = input.records
    .filter((r) => inWindow(r.sent_at))
    .map((r) => ({ r, target: replyTargetOf(r) }))
    .filter(
      (x): x is { r: OutboundRecord; target: RedditWeeklyReply['target'] } =>
        x.target !== undefined,
    )
    .sort((a, b) => Date.parse(a.r.sent_at) - Date.parse(b.r.sent_at))
    .map(({ r, target }) => {
      const url = r.link ?? r.thread_url
      return {
        record_id: r.id,
        at: r.sent_at,
        target,
        ...(url === undefined ? {} : { url }),
        ...(r.destination === undefined ? {} : { destination: r.destination }),
        ...(r.thread_title === undefined ? {} : { thread_title: clipQuote(r.thread_title, 120) }),
        text: clipQuote(r.content, 120),
      }
    })
  const count = (t: RedditWeeklyReply['target']) => replies.filter((r) => r.target === t).length

  const sweeps = input.sweeps.filter(inWindow).sort()
  const totals = {
    posts,
    comments,
    voc: voc.length,
    ugc: ugc.length,
    topics: topics.length,
    follow_up_topics: topics.filter((t) => t.assessment === 'follow_up').length,
    external_items: items.filter((i) => i.scope === 'external').length,
    to_posts: count('post'),
    to_comments: count('comment'),
    new_posts: count('new_post'),
  }
  const sections: RedditWeeklySection[] = []
  for (const f of format.sections) {
    if (!f.enabled) continue
    const head = { title: f.title, ...(f.intro === undefined ? {} : { intro: f.intro }) }
    if (f.id === 'own_stats')
      sections.push({ id: f.id, ...head, subreddits: ownNames, posts, comments })
    else if (f.id === 'voc_ugc') sections.push({ id: f.id, ...head, voc, ugc })
    else if (f.id === 'external') sections.push({ id: f.id, ...head, topics })
    else
      sections.push({
        id: f.id,
        ...head,
        to_posts: totals.to_posts,
        to_comments: totals.to_comments,
        new_posts: totals.new_posts,
        replies,
      })
  }
  const short = (at: string) => formatWeeklyDate(at, 'MM/DD', tz)
  const title = format.title
    .replace(/\{brand\}/g, input.brand ?? '')
    .replace(/\{start\}/g, short(window.since))
    .replace(/\{end\}/g, short(window.until))
    .replace(/\s{2,}/g, ' ')
    .trim()
  const summary = [
    `帖子 ${posts} · 评论 ${comments}`,
    `VOC ${voc.length} · UGC ${ugc.length}`,
    `外部话题 ${topics.length}${totals.follow_up_topics > 0 ? `（${format.assessment_labels.follow_up} ${totals.follow_up_topics}）` : ''}`,
    `我们回复 ${totals.to_posts + totals.to_comments}`,
  ].join(' · ')
  const last = sweeps.at(-1)
  const payload: RedditWeeklyPayload = {
    kind: 'reddit_weekly',
    week_of: window.week_of,
    window: { since: window.since, until: window.until },
    generated_at: input.now,
    title,
    summary,
    sections,
    totals,
    sweeps: { count: sweeps.length, ...(last === undefined ? {} : { last_at: last }) },
    markdown: '',
    assessment_labels: { ...format.assessment_labels },
  }
  payload.markdown = renderRedditWeeklyMarkdown(payload, format, tz)
  return payload
}

/* ── 文档（Markdown：可复制、可导出；飞书 / Notion / Google 文档都能直接贴） ───── */

const ZH_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十']

function quoteLines(q: RedditWeeklyQuote, format: RedditWeeklyFormat, tz: number): string[] {
  const meta = [
    q.author === undefined ? undefined : `u/${q.author}`,
    `r/${q.subreddit}`,
    formatWeeklyDate(q.at, format.date_format, tz),
    q.url,
  ]
    .filter((x): x is string => x !== undefined)
    .join(' · ')
  return [
    ...(q.note === undefined ? [] : [`- ${q.note}`, '']),
    ...(q.title === undefined || q.kind !== 'post' ? [] : [`**${q.title}**`, '']),
    `> ${q.text === '' ? '（原文已删除）' : q.text}`,
    '',
    meta,
    '',
  ]
}

/** 一份周报 → Markdown（只排版，数字与原话都来自 payload）。 */
export function renderRedditWeeklyMarkdown(
  p: RedditWeeklyPayload,
  format: RedditWeeklyFormat,
  tzOffsetMinutes: number,
): string {
  const tz = tzOffsetMinutes
  const when = (at: string) => formatWeeklyDate(at, 'YYYY-MM-DD HH:mm', tz)
  const out: string[] = [`# ${p.title}`, '']
  const sweep =
    p.sweeps.count === 0
      ? '这段时间没有巡查记录'
      : `巡查 ${p.sweeps.count} 次${p.sweeps.last_at === undefined ? '' : `（最后一次 ${formatWeeklyDate(p.sweeps.last_at, format.date_format, tz)}）`}`
  out.push(`${when(p.window.since)} – ${when(p.window.until)} · ${sweep}`, '')
  p.sections.forEach((s, i) => {
    const n =
      format.numbering === 'zh'
        ? `${ZH_NUM[i] ?? String(i + 1)}、`
        : format.numbering === 'arabic'
          ? `${i + 1}. `
          : ''
    out.push(`## ${n}${s.title}`, '')
    if (s.intro !== undefined) out.push(s.intro, '')
    if (s.id === 'own_stats') {
      const where =
        s.subreddits.length === 0 ? '' : `${s.subreddits.map((x) => `r/${x}`).join('、')}：`
      out.push(`- ${where}帖子 **${s.posts}** · 评论 **${s.comments}**`, '')
    } else if (s.id === 'voc_ugc') {
      for (const [name, list] of [
        ['VOC', s.voc],
        ['UGC', s.ugc],
      ] as const) {
        out.push(`### ${name}（${list.length}）`, '')
        if (list.length === 0) out.push('本周没有。', '')
        for (const q of list) out.push(...quoteLines(q, format, tz))
      }
    } else if (s.id === 'external') {
      if (s.topics.length === 0) out.push('本周没有。', '')
      s.topics.forEach((t, j) => {
        out.push(`### ${j + 1}. ${t.label}（post × ${t.posts} / comment × ${t.comments}）`, '')
        out.push(`评估：${format.assessment_labels[t.assessment]}`, '')
        for (const q of t.quotes) out.push(...quoteLines(q, format, tz))
        if (t.more > 0) out.push(`另有 ${t.more} 条未列出。`, '')
      })
    } else {
      out.push(
        `- 回复帖子 **${s.to_posts}** · 回复评论 **${s.to_comments}**${s.new_posts > 0 ? ` · 发帖 **${s.new_posts}**` : ''}`,
        '',
      )
      if (s.replies.length === 0) out.push('本周没有。', '')
      s.replies.forEach((r, j) => {
        const kind = r.target === 'post' ? '回帖子' : r.target === 'comment' ? '回评论' : '发帖'
        const bits = [
          formatWeeklyDate(r.at, format.date_format, tz),
          kind,
          r.destination,
          r.thread_title,
          r.url,
        ].filter((x): x is string => x !== undefined && x !== '')
        out.push(`${j + 1}. ${bits.join(' · ')}`)
      })
      if (s.replies.length > 0) out.push('')
    }
  })
  return `${out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`
}
