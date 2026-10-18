/**
 * WP419（自查 P8）：信息监控**每天一份简报**——职责说明里承诺的那份。拉完一轮之后按本地日出一份（同一天只一份），
 * 进这个岗位的报表区（与 AI 发布的报告同一种报表块，看一眼就过，不进审批队列）。
 *
 * 内容：自家 / 竞品 / 行业 / 指定网站各列最近 24 小时最多 5 条（负面在前、带链接），没拉到的源照实列出来——
 * **没拉到不等于没人提**。一条都没有的组写「这一天没有新的」。数字是数出来的，不编。
 */
import type { Iso8601, Mention, MonitorGroup } from '@agentsws/contracts'

const GROUP_ZH: Readonly<Record<MonitorGroup, string>> = {
  own: '自家',
  competitor: '竞品',
  industry: '行业',
  site: '指定网站',
}
const ORDER: readonly MonitorGroup[] = ['own', 'competitor', 'industry', 'site']
const SENT_ZH: Readonly<Record<string, string>> = {
  negative: '负面',
  neutral: '中性',
  positive: '正面',
}
/** 每组最多几条。 */
export const BRIEF_PER_GROUP = 5
/** 看最近多久。 */
export const BRIEF_WINDOW_MS = 24 * 3_600_000

export interface BriefSource {
  label: string
  group: MonitorGroup
  status: 'ok' | 'failed' | 'unchecked'
  last_error?: string
  paused?: boolean
}

export interface MonitorBrief {
  /** 本地日期 YYYY-MM-DD（同一天只一份）。 */
  date: string
  title: string
  period: string
  markdown: string
  counts: Record<MonitorGroup, number>
  failed: number
}

/** 本地日期（按品牌时区）。 */
export function localDate(now: Iso8601, tzOffsetMinutes: number): string {
  return new Date(Date.parse(now) + tzOffsetMinutes * 60_000).toISOString().slice(0, 10)
}

const oneLine = (s: string, n: number): string => {
  const t = s.replace(/\s+/gu, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

export function buildMonitorBrief(input: {
  now: Iso8601
  tzOffsetMinutes: number
  mentions: readonly Pick<
    Mention,
    | 'title'
    | 'text'
    | 'url'
    | 'origin'
    | 'published_at'
    | 'observed_at'
    | 'sentiment'
    | 'group'
    | 'competitor'
  >[]
  sources: readonly BriefSource[]
}): MonitorBrief {
  const date = localDate(input.now, input.tzOffsetMinutes)
  const since = Date.parse(input.now) - BRIEF_WINDOW_MS
  const fresh = input.mentions.filter((m) => Date.parse(m.observed_at) >= since)
  const counts = { own: 0, competitor: 0, industry: 0, site: 0 } as Record<MonitorGroup, number>
  const lines: string[] = []
  const rank = (s: string | undefined) => (s === 'negative' ? 0 : s === 'positive' ? 2 : 1)
  for (const g of ORDER) {
    const rows = fresh
      .filter((m) => (m.group ?? 'own') === g)
      .sort(
        (a, b) =>
          rank(a.sentiment) - rank(b.sentiment) ||
          Date.parse(b.published_at) - Date.parse(a.published_at),
      )
    counts[g] = rows.length
    // 指定网站那一组没配源、也没东西就不占一节
    if (g === 'site' && rows.length === 0 && !input.sources.some((s) => s.group === 'site'))
      continue
    lines.push(`## ${GROUP_ZH[g]}（${rows.length} 条）`)
    if (rows.length === 0) lines.push('这一天没有新的。')
    for (const m of rows.slice(0, BRIEF_PER_GROUP)) {
      const head = oneLine(m.title ?? m.text, 90)
      const tag = [
        m.sentiment === undefined ? undefined : SENT_ZH[m.sentiment],
        m.competitor,
        m.origin,
      ]
        .filter((x): x is string => x !== undefined && x !== '')
        .join(' · ')
      lines.push(`- [${head}](${m.url})${tag === '' ? '' : `（${tag}）`}`)
    }
    if (rows.length > BRIEF_PER_GROUP)
      lines.push(`- 另有 ${rows.length - BRIEF_PER_GROUP} 条在提及表里。`)
    lines.push('')
  }
  const failed = input.sources.filter((s) => s.status === 'failed' && s.paused !== true)
  if (failed.length > 0) {
    lines.push(`## 没拉到的源（${failed.length} 条）`)
    lines.push('这几条这次没拉到——**不等于没人提**：')
    for (const s of failed)
      lines.push(
        `- ${s.label}${s.last_error === undefined ? '' : `：${oneLine(s.last_error, 80)}`}`,
      )
    lines.push('')
  }
  const total = ORDER.reduce((n, g) => n + counts[g], 0)
  return {
    date,
    title: `监控简报 · ${date.slice(5)}`,
    period: `${date}（最近 24 小时 ${total} 条）`,
    markdown: lines.join('\n').trim(),
    counts,
    failed: failed.length,
  }
}
