/**
 * WP331（决策 691）：报告积木的**纯计算**——不读钟、不联网、不调模型、不认平台。
 *
 * 前身是 WP330 专用 Reddit 周报里的窗口 / 计数 / 话题归组；「周报」这个概念拆掉了，留下的是三样通用计算，
 * 给「查巡查数据」「查发出记录」两个 AI 工具用（`apps/server/src/report-tools.ts`）：
 *
 * 1. {@link resolvePeriod}：时间窗（本周 / 上周 / 最近 7 天 / 本月…，周从周几起可选；或直接给起止）；
 * 2. {@link queryWatchItems}：巡查入库条目按时间窗、自家 / 外部、判断档、话题、关键词、VOC / UGC 筛，给计数与按话题归组；
 * 3. {@link summarizeSent}：发出记录按时间窗 / 渠道 / 动作筛，给计数与链接清单。
 *
 * 数字全是数出来的（docs/29）：同一条只算一次、按平台上的发出时间进窗口、被删的照样计数但不引用原话。
 * 报告怎么写（分几节、什么顺序、叫什么）由 AI 按用户的话决定，这里一概不管。
 */
import {
  type Iso8601,
  OUTBOUND_OPT_IN_ACTIONS,
  type OutboundRecord,
  WATCH_ASSESSMENTS,
  type WatchAssessment,
  type WatchItem,
} from '@agentsws/contracts'

const DAY_MS = 86_400_000

/* ── 时间窗 ─────────────────────────────────────────────────────────────── */

export const PERIOD_PRESETS = [
  'today',
  'yesterday',
  'this_week',
  'last_week',
  'last_7_days',
  'this_month',
  'last_month',
] as const
export type PeriodPreset = (typeof PERIOD_PRESETS)[number]

export interface PeriodInput {
  /** 预设（不给 = 最近 7 天）。 */
  period?: string
  /** 一周从周几起（0 = 周日 … 6 = 周六；默认 1 周一）。只对本周 / 上周有用。 */
  week_start?: number
  /** 直接给起止：ISO 时间，或本地日期 `YYYY-MM-DD`（起 = 那天 00:00，止 = 那天 24:00）。 */
  since?: string
  until?: string
}

export interface ResolvedPeriod {
  since: Iso8601
  until: Iso8601
  /** 起那天（本地 `YYYY-MM-DD`）——发布报告时作 `period_start`，同一周期再发就是同一份。 */
  start_date: string
  end_date: string
  /** 人看的一句（`10/11 – 10/16`）。 */
  label: string
  problems: string[]
}

const localDate = (ms: number, tz: number): string =>
  new Date(ms + tz * 60_000).toISOString().slice(0, 10)

/** 本地某天 00:00 的时刻（ms）。 */
const localMidnight = (ms: number, tz: number): number => {
  const d = new Date(ms + tz * 60_000)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - tz * 60_000
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

function parseEdge(v: string, tz: number, end: boolean): number | undefined {
  if (DATE_ONLY.test(v)) {
    const ms = Date.parse(`${v}T00:00:00Z`)
    if (Number.isNaN(ms)) return undefined
    return ms - tz * 60_000 + (end ? DAY_MS : 0)
  }
  const ms = Date.parse(v)
  return Number.isNaN(ms) ? undefined : ms
}

/** 按记号写本地时间（只认 YYYY MM DD HH mm ss）。 */
export function formatLocal(at: Iso8601, pattern: string, tzOffsetMinutes: number): string {
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

/** 时间窗。认不出的照实回在 `problems` 里，并退回最近 7 天。 */
export function resolvePeriod(
  now: Iso8601,
  tzOffsetMinutes: number,
  input: PeriodInput = {},
): ResolvedPeriod {
  const tz = tzOffsetMinutes
  const nowMs = Date.parse(now)
  const problems: string[] = []
  let since: number | undefined
  let until: number | undefined
  if (input.since !== undefined || input.until !== undefined) {
    since = input.since === undefined ? undefined : parseEdge(input.since, tz, false)
    until = input.until === undefined ? nowMs : parseEdge(input.until, tz, true)
    if (since === undefined || until === undefined || since > until) {
      problems.push('since / until 要写成 ISO 时间或 YYYY-MM-DD，且起不晚于止')
      since = undefined
    }
  }
  if (since === undefined || until === undefined) {
    const raw = input.period ?? 'last_7_days'
    const preset = (PERIOD_PRESETS as readonly string[]).includes(raw)
      ? (raw as PeriodPreset)
      : undefined
    if (preset === undefined) problems.push(`认不出的 period：${raw}（按最近 7 天）`)
    const ws = input.week_start ?? 1
    const okStart = Number.isInteger(ws) && ws >= 0 && ws <= 6
    if (!okStart) problems.push('week_start 要是 0–6（0 = 周日）')
    const weekStart = okStart ? ws : 1
    const today = localMidnight(nowMs, tz)
    const weekday = new Date(nowMs + tz * 60_000).getUTCDay()
    const thisWeek = today - ((weekday - weekStart + 7) % 7) * DAY_MS
    const local = new Date(nowMs + tz * 60_000)
    const monthStart = (y: number, m: number) => Date.UTC(y, m, 1) - tz * 60_000
    switch (preset ?? 'last_7_days') {
      case 'today':
        ;[since, until] = [today, nowMs]
        break
      case 'yesterday':
        ;[since, until] = [today - DAY_MS, today - 1]
        break
      case 'this_week':
        ;[since, until] = [thisWeek, nowMs]
        break
      case 'last_week':
        ;[since, until] = [thisWeek - 7 * DAY_MS, thisWeek - 1]
        break
      case 'this_month':
        ;[since, until] = [monthStart(local.getUTCFullYear(), local.getUTCMonth()), nowMs]
        break
      case 'last_month': {
        const start = monthStart(local.getUTCFullYear(), local.getUTCMonth())
        ;[since, until] = [monthStart(local.getUTCFullYear(), local.getUTCMonth() - 1), start - 1]
        break
      }
      default:
        ;[since, until] = [nowMs - 7 * DAY_MS, nowMs]
    }
  }
  const s = new Date(since).toISOString()
  const u = new Date(until).toISOString()
  return {
    since: s,
    until: u,
    start_date: localDate(since, tz),
    end_date: localDate(until, tz),
    label: `${formatLocal(s, 'MM/DD', tz)} – ${formatLocal(u, 'MM/DD', tz)}`,
    problems,
  }
}

/* ── 巡查条目 ───────────────────────────────────────────────────────────── */

/** 原话收成一行、截断（不改字）。 */
export function clipQuote(raw: string, max: number): string {
  const one = raw.replace(/\s+/g, ' ').trim()
  return one.length <= max ? one : `${one.slice(0, Math.max(1, max - 1)).trimEnd()}…`
}

export interface WatchFilter {
  scope?: 'own' | 'external'
  assessment?: WatchAssessment[]
  /** 话题概括里含这几个字。 */
  topic?: string
  keyword?: string
  /** 只要判过有效的 VOC / UGC（`any` = 两样有一样）。 */
  signal?: 'voc' | 'ugc' | 'any'
  kind?: 'post' | 'comment'
}

/** 一条原文引用（不截图：原话 + 作者 + 时间 + 链接）。 */
export interface WatchQuote {
  id: string
  kind: 'post' | 'comment'
  scope: 'own' | 'external'
  place: string
  author?: string
  at: Iso8601
  url: string
  title?: string
  /** 截断过的原话；原文被删了是空串 + `deleted`。 */
  text: string
  deleted?: true
  voc?: true
  ugc?: true
  note?: string
  topic?: string
  assessment?: WatchAssessment
  keyword?: string
}

export interface WatchGroup {
  key: string
  topic: string
  posts: number
  comments: number
  /** 组里最重的那一档。 */
  assessment: WatchAssessment
  items: WatchQuote[]
  /** 没列出来的条数。 */
  more: number
}

export interface WatchQueryResult {
  totals: {
    items: number
    posts: number
    comments: number
    own: { posts: number; comments: number }
    external: { posts: number; comments: number }
    voc: number
    ugc: number
  }
  groups?: WatchGroup[]
  items: WatchQuote[]
  /** 条数多于 `limit` 时没列出来的。 */
  more: number
}

export interface WatchQueryInput {
  items: WatchItem[]
  /** 用户配的自家地盘（空 = 标 `own` 的都算）。 */
  ownPlaces: string[]
  window: { since: Iso8601; until: Iso8601 }
  filter?: WatchFilter
  group_by?: 'topic'
  /** 列几条原文（每组 / 总共；默认 30，最多 200）。 */
  limit?: number
  /** 原文截几个字（默认 280）。 */
  quote_max?: number
}

const severity = (a: WatchAssessment | undefined): number =>
  WATCH_ASSESSMENTS.indexOf(a ?? 'no_action')
const gone = (it: WatchItem): boolean => it.deleted === true || it.text.trim() === ''
const bareName = (s: string): string => s.replace(/^\/?(r|u)\//i, '').toLowerCase()

export function queryWatchItems(input: WatchQueryInput): WatchQueryResult {
  const lo = Date.parse(input.window.since)
  const hi = Date.parse(input.window.until)
  const limit = Math.min(Math.max(input.limit ?? 30, 1), 200)
  const max = Math.min(Math.max(input.quote_max ?? 280, 40), 2000)
  const own = new Set(input.ownPlaces.map(bareName))
  const f = input.filter ?? {}
  const byId = new Map<string, WatchItem>()
  for (const it of input.items) {
    const t = Date.parse(it.created_at)
    if (!Number.isNaN(t) && t >= lo && t <= hi) byId.set(it.id, it)
  }
  const scopeOf = (it: WatchItem): 'own' | 'external' | undefined =>
    it.scope === 'external'
      ? 'external'
      : own.size === 0 || own.has(bareName(it.place))
        ? 'own'
        : undefined
  const topicLabel = (it: WatchItem): string =>
    it.topic?.label ?? (it.keyword === undefined ? '其他' : `关键词「${it.keyword}」`)
  const hits = [...byId.values()]
    .filter((it) => {
      const scope = scopeOf(it)
      if (scope === undefined) return false
      if (f.scope !== undefined && scope !== f.scope) return false
      if (f.kind !== undefined && it.kind !== f.kind) return false
      if (f.assessment !== undefined && f.assessment.length > 0) {
        if (it.assessment === undefined || !f.assessment.includes(it.assessment)) return false
      }
      if (f.topic !== undefined && !topicLabel(it).toLowerCase().includes(f.topic.toLowerCase()))
        return false
      if (f.keyword !== undefined && it.keyword?.toLowerCase() !== f.keyword.toLowerCase())
        return false
      if (f.signal !== undefined) {
        const s = it.signals
        const ok =
          f.signal === 'voc'
            ? s?.voc === true
            : f.signal === 'ugc'
              ? s?.ugc === true
              : s?.voc === true || s?.ugc === true
        if (!ok || gone(it)) return false
      }
      return true
    })
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))

  const quote = (it: WatchItem): WatchQuote => {
    const q: WatchQuote = {
      id: it.id,
      kind: it.kind,
      scope: scopeOf(it) ?? it.scope,
      place: it.place,
      at: it.created_at,
      url: it.url,
      text: gone(it) ? '' : clipQuote(it.text, max),
    }
    if (it.author !== undefined) q.author = it.author
    if (it.title !== undefined) q.title = clipQuote(it.title, 120)
    if (gone(it)) q.deleted = true
    if (it.signals?.voc === true) q.voc = true
    if (it.signals?.ugc === true) q.ugc = true
    if (it.signals?.note !== undefined) q.note = clipQuote(it.signals.note, 200)
    if (it.scope === 'external') q.topic = topicLabel(it)
    if (it.assessment !== undefined) q.assessment = it.assessment
    if (it.keyword !== undefined) q.keyword = it.keyword
    return q
  }
  const count = (xs: WatchItem[], scope?: 'own' | 'external') => {
    const ys = scope === undefined ? xs : xs.filter((x) => scopeOf(x) === scope)
    const posts = ys.filter((x) => x.kind === 'post').length
    return { posts, comments: ys.length - posts }
  }
  const all = count(hits)
  const result: WatchQueryResult = {
    totals: {
      items: hits.length,
      ...all,
      own: count(hits, 'own'),
      external: count(hits, 'external'),
      voc: hits.filter((x) => x.signals?.voc === true && !gone(x)).length,
      ugc: hits.filter((x) => x.signals?.ugc === true && !gone(x)).length,
    },
    items: [],
    more: 0,
  }
  if (input.group_by === 'topic') {
    const groups = new Map<string, WatchItem[]>()
    for (const it of hits) {
      const key = it.topic?.key ?? (it.keyword === undefined ? 'other' : `kw:${it.keyword}`)
      groups.set(key, [...(groups.get(key) ?? []), it])
    }
    result.groups = [...groups.entries()]
      .map(([key, list]) => {
        const latest = [...list].reverse().find((i) => i.topic !== undefined) ?? list[0]
        const shown = list.filter((i) => !gone(i))
        const c = count(list)
        return {
          key,
          topic: latest === undefined ? '其他' : topicLabel(latest),
          ...c,
          assessment: list.reduce<WatchAssessment>(
            (acc, i) => (severity(i.assessment) > severity(acc) ? (i.assessment ?? acc) : acc),
            'no_action',
          ),
          items: shown.slice(0, limit).map(quote),
          more: Math.max(0, shown.length - limit),
        }
      })
      .sort(
        (a, b) =>
          severity(b.assessment) - severity(a.assessment) ||
          b.posts + b.comments - (a.posts + a.comments) ||
          a.topic.localeCompare(b.topic),
      )
  } else {
    result.items = hits.slice(0, limit).map(quote)
    result.more = Math.max(0, hits.length - limit)
  }
  return result
}

/* ── 发出记录 ───────────────────────────────────────────────────────────── */

export interface SentFilter {
  window: { since: Iso8601; until: Iso8601 }
  /** 渠道（`reddit` / `email` …；不给 = 全部）。 */
  channel?: string
  /** 动作（`reply` / `comment` / `post` …；不给 = 全部，报告那一行除外）。 */
  actions?: string[]
  /** 默认只要「已发」的。 */
  status?: OutboundRecord['status'] | 'any'
  limit?: number
}

export interface SentLine {
  id: string
  at: Iso8601
  channel: string
  action: string
  /** 回的是帖子 / 评论（楼中楼）/ 我们发的新帖（认得出才有）。 */
  target?: 'post' | 'comment' | 'new_post'
  destination?: string
  thread_title?: string
  thread_url?: string
  /** 我们那一条的链接。 */
  link?: string
  /** 我们发的那句（截断过）。 */
  text: string
}

export interface SentSummary {
  totals: {
    all: number
    by_action: Record<string, number>
    replies_to_posts: number
    replies_to_comments: number
    new_posts: number
  }
  records: SentLine[]
  more: number
}

const REPLY_ACTIONS = new Set(['reply', 'comment'])

/**
 * 发出记录的一行 → 回的是帖子 / 评论 / 我们发的新帖。回的那条是不是评论按平台全名认
 * （目前认得 Reddit 的 `t1_`；认不出的回复算回帖子本身）。
 */
export function sentTargetOf(
  r: Pick<OutboundRecord, 'action' | 'parent_external_id'>,
): SentLine['target'] {
  if (r.action === 'post') return 'new_post'
  if (!REPLY_ACTIONS.has(r.action)) return undefined
  return r.parent_external_id?.startsWith('t1_') === true ? 'comment' : 'post'
}

export function summarizeSent(records: OutboundRecord[], f: SentFilter): SentSummary {
  const lo = Date.parse(f.window.since)
  const hi = Date.parse(f.window.until)
  const status = f.status ?? 'sent'
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 500)
  const hits = records
    .filter((r) => {
      const t = Date.parse(r.sent_at)
      if (Number.isNaN(t) || t < lo || t > hi) return false
      if (f.channel !== undefined && r.channel.toLowerCase() !== f.channel.toLowerCase())
        return false
      if (status !== 'any' && r.status !== status) return false
      if (f.actions !== undefined && f.actions.length > 0) return f.actions.includes(r.action)
      return !OUTBOUND_OPT_IN_ACTIONS.includes(r.action)
    })
    .sort((a, b) => Date.parse(a.sent_at) - Date.parse(b.sent_at))
  const by_action: Record<string, number> = {}
  for (const r of hits) by_action[r.action] = (by_action[r.action] ?? 0) + 1
  const targets = hits.map(sentTargetOf)
  const line = (r: OutboundRecord, target: SentLine['target']): SentLine => {
    const out: SentLine = {
      id: r.id,
      at: r.sent_at,
      channel: r.channel,
      action: r.action,
      text: clipQuote(r.content, 160),
    }
    if (target !== undefined) out.target = target
    if (r.destination !== undefined) out.destination = r.destination
    if (r.thread_title !== undefined) out.thread_title = clipQuote(r.thread_title, 120)
    if (r.thread_url !== undefined) out.thread_url = r.thread_url
    if (r.link !== undefined) out.link = r.link
    return out
  }
  return {
    totals: {
      all: hits.length,
      by_action,
      replies_to_posts: targets.filter((t) => t === 'post').length,
      replies_to_comments: targets.filter((t) => t === 'comment').length,
      new_posts: targets.filter((t) => t === 'new_post').length,
    },
    records: hits.slice(0, limit).map((r, i) => line(r, targets[i])),
    more: Math.max(0, hits.length - limit),
  }
}
