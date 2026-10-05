/**
 * WP220：研究报告的**形状**与**进卡片流的建议**。
 *
 * 报告（给人读的那份）：带出处链接与时间、按话题 / 情绪 / 平台分组、每个平台一行「从哪取的、取到没有」。
 * 「没取到」与「0 条」分开说（`pr-core/channels/alerts.ts` 第 3 条同一个纪律）。
 *
 * 卡（36：只有要人拍板的才是卡）：只有两种、最多三张——
 *
 * - `worth_responding`「这个话题值得回应」：负面、而且有人在看（互动够多，或者不止一个平台在说）；
 * - `spreading`「这条帖子在扩散」：扩散速度明显高于其余的。
 *
 * 正面的、零星的、判不准的都不出卡，写在报告里就够了。卡只是建议「要不要回、怎么回」，
 * 回什么由对应的职责起草、再出它自己的卡等人批——这里一个字都不往外发。
 */
import type { Iso8601, ResearchFetchRecord } from '@agentsws/contracts'
import type { RankedItem, ResearchSentiment } from './trend.js'

export type ResearchCardKind = 'worth_responding' | 'spreading'

export interface ResearchEvidence {
  url: string
  platform: string
  /** 发帖时间（不明就没有）。 */
  at?: Iso8601
}

export interface ResearchCardSuggestion {
  kind: ResearchCardKind
  /** 卡标题（一行）。 */
  title: string
  /** 为什么出这张卡（一句，带数）。 */
  why: string
  evidence: ResearchEvidence[]
  /** 建议下一步（交给哪条职责起草）。 */
  next: string
}

export interface ResearchCoverageLine {
  platform: string
  /** `ok` 取到了；`empty` 取到了但 0 条；`missing` 没取到。 */
  status: 'ok' | 'empty' | 'missing'
  line: string
}

export interface ResearchReport {
  topic: string
  window_days: number
  generated_at: Iso8601
  by_topic: { topic: string; items: RankedItem[] }[]
  by_sentiment: Record<ResearchSentiment, number>
  by_platform: Record<string, number>
  coverage: ResearchCoverageLine[]
  cards: ResearchCardSuggestion[]
}

/** 最多出几张卡（少而准）。 */
export const MAX_RESEARCH_CARDS = 3
/** 「有人在看」的门槛：互动合计。 */
export const RESPOND_MIN_ENGAGEMENT = 20
/** 「在扩散」：速度至少是中位数的几倍，且至少多少互动。 */
export const SPREADING_VELOCITY_RATIO = 3
export const SPREADING_MIN_ENGAGEMENT = 50

const ROUTE_LABEL: Record<string, string> = {
  web_search: '官方网页搜索',
  web_fetch: '官方网页抓取',
  workshop: '接口中台',
  browser_readonly: '浏览器只读',
  official_api: '官方接口',
}

const PLATFORM_LABEL: Record<string, string> = {
  web: '网页',
  reddit: 'Reddit',
  x: 'X',
  youtube: 'YouTube',
  tiktok: 'TikTok',
  instagram: 'Instagram',
  facebook: 'Facebook',
  linkedin: 'LinkedIn',
  threads: 'Threads',
  hacker_news: 'Hacker News',
  ad_library: '广告库',
}

const platformLabel = (p: string): string => PLATFORM_LABEL[p] ?? p

function engagementOf(r: RankedItem): number {
  const e = r.item.engagement ?? {}
  return (e.score ?? 0) + (e.likes ?? 0) + (e.comments ?? 0) + (e.shares ?? 0)
}

/** 每个平台一行：从哪一路取的、命中缓存没有、几条；没取到照实写原因。 */
export function coverageOf(records: readonly ResearchFetchRecord[]): ResearchCoverageLine[] {
  const byPlatform = new Map<string, ResearchFetchRecord[]>()
  for (const r of records) byPlatform.set(r.platform, [...(byPlatform.get(r.platform) ?? []), r])
  const out: ResearchCoverageLine[] = []
  for (const [platform, list] of byPlatform) {
    const got = list.filter((r) => r.route !== 'none')
    const name = platformLabel(platform)
    if (got.length === 0) {
      const why = [
        ...new Set(list.flatMap((r) => r.attempts.map((a) => a.message ?? a.outcome))),
      ].join('；')
      out.push({
        platform,
        status: 'missing',
        line: `${name}：没取到（${why || '没有可用的来源'}）。这不等于没人在聊。`,
      })
      continue
    }
    const total = got.reduce((n, r) => n + r.items, 0)
    const routes = [
      ...new Set(
        got.map((r) => `${ROUTE_LABEL[r.route] ?? r.route}${r.cached ? '（命中缓存）' : ''}`),
      ),
    ].join('、')
    out.push({
      platform,
      status: total === 0 ? 'empty' : 'ok',
      line:
        total === 0
          ? `${name}：${routes}，这段时间没搜到相关的。`
          : `${name}：${routes}，${total} 条。`,
    })
  }
  return out
}

/** 从排好的条目里挑卡（最多三张；正面的不出）。 */
export function researchCards(ranked: readonly RankedItem[]): ResearchCardSuggestion[] {
  const cards: { strength: number; card: ResearchCardSuggestion }[] = []
  const evidenceOf = (r: RankedItem): ResearchEvidence => ({
    url: r.item.url,
    platform: r.item.platform,
    ...(r.item.published_at === undefined ? {} : { at: r.item.published_at }),
  })
  // 在扩散：速度明显高于其余的
  const velocities = ranked
    .flatMap((r) => (r.velocity === undefined ? [] : [r.velocity]))
    .sort((a, b) => a - b)
  const mid = velocities.length === 0 ? 0 : (velocities[Math.floor(velocities.length / 2)] ?? 0)
  for (const r of ranked) {
    if (r.entity_miss || r.velocity === undefined) continue
    if (engagementOf(r) < SPREADING_MIN_ENGAGEMENT) continue
    if (mid > 0 && r.velocity < mid * SPREADING_VELOCITY_RATIO) continue
    if (r.item.sentiment === 'positive') continue
    cards.push({
      strength: r.velocity,
      card: {
        kind: 'spreading',
        title: `这条在扩散：${(r.item.title ?? r.item.text ?? r.item.url).slice(0, 40)}`,
        why: `${platformLabel(r.item.platform)} 上每小时约 ${r.velocity} 个互动，是这批的 ${mid > 0 ? Math.round(r.velocity / mid) : '多'} 倍${r.seen_count > 1 ? `，另在 ${r.seen_count - 1} 处见到` : ''}。`,
        evidence: [evidenceOf(r)],
        next: '看一眼说的对不对：不对就让对应职责起一份带证据的回应草稿；对的话转给负责的人。',
      },
    })
  }
  // 值得回应：负面，并且有人在看（互动够多，或同一话题不止一个平台在说）
  const negativeByTopic = new Map<string, RankedItem[]>()
  for (const r of ranked) {
    if (r.entity_miss || r.item.sentiment !== 'negative') continue
    const k = r.item.topic ?? r.item.url
    negativeByTopic.set(k, [...(negativeByTopic.get(k) ?? []), r])
  }
  for (const [topic, list] of negativeByTopic) {
    const platforms = new Set(list.map((r) => r.item.platform))
    const eng = list.reduce((n, r) => n + engagementOf(r), 0)
    if (eng < RESPOND_MIN_ENGAGEMENT && platforms.size < 2) continue
    if (
      cards.some(
        (c) =>
          c.card.kind === 'spreading' && list.some((r) => c.card.evidence[0]?.url === r.item.url),
      )
    )
      continue
    cards.push({
      strength: eng + platforms.size * 50,
      card: {
        kind: 'worth_responding',
        title: `这个话题值得回应：${topic.slice(0, 40)}`,
        why: `${list.length} 条负面，${[...platforms].map(platformLabel).join(' / ')}，互动合计 ${eng}。`,
        evidence: list.slice(0, 3).map(evidenceOf),
        next: '让对应职责起一份回应草稿（数字只写事实卡里有的），草稿再出卡等你批。',
      },
    })
  }
  return cards
    .sort((a, b) => b.strength - a.strength)
    .slice(0, MAX_RESEARCH_CARDS)
    .map((c) => c.card)
}

export function buildResearchReport(input: {
  topic: string
  window_days: number
  now: Iso8601
  ranked: readonly RankedItem[]
  records: readonly ResearchFetchRecord[]
}): ResearchReport {
  const byTopic = new Map<string, RankedItem[]>()
  const bySentiment: Record<ResearchSentiment, number> = {
    positive: 0,
    negative: 0,
    neutral: 0,
    mixed: 0,
    unclear: 0,
  }
  const byPlatform: Record<string, number> = {}
  for (const r of input.ranked) {
    const t = r.item.topic ?? '其他'
    byTopic.set(t, [...(byTopic.get(t) ?? []), r])
    bySentiment[r.item.sentiment ?? 'unclear'] += 1
    byPlatform[r.item.platform] = (byPlatform[r.item.platform] ?? 0) + 1
  }
  return {
    topic: input.topic,
    window_days: input.window_days,
    generated_at: input.now,
    by_topic: [...byTopic.entries()]
      .map(([topic, items]) => ({ topic, items }))
      .sort((a, b) => b.items.length - a.items.length),
    by_sentiment: bySentiment,
    by_platform: byPlatform,
    coverage: coverageOf(input.records),
    cards: researchCards(input.ranked),
  }
}

const SENTIMENT_LABEL: Record<ResearchSentiment, string> = {
  positive: '正面',
  negative: '负面',
  neutral: '中性',
  mixed: '褒贬都有',
  unclear: '判不准',
}

/** 报告的 Markdown（给人读）。每条带链接、平台、时间、从哪一路取的。 */
export function renderResearchReport(report: ResearchReport): string {
  const lines: string[] = [`# ${report.topic}：最近 ${report.window_days} 天`, '']
  lines.push('## 从哪取的')
  for (const c of report.coverage) lines.push(`- ${c.line}`)
  if (report.coverage.length === 0) lines.push('- 这次一个来源都没取。')
  lines.push('', '## 情绪')
  lines.push(
    (Object.keys(SENTIMENT_LABEL) as ResearchSentiment[])
      .filter((s) => report.by_sentiment[s] > 0)
      .map((s) => `${SENTIMENT_LABEL[s]} ${report.by_sentiment[s]}`)
      .join(' · ') || '没有条目',
  )
  lines.push('', '## 平台')
  lines.push(
    Object.entries(report.by_platform)
      .map(([p, n]) => `${platformLabel(p)} ${n}`)
      .join(' · ') || '没有条目',
  )
  for (const g of report.by_topic) {
    lines.push('', `## ${g.topic}（${g.items.length} 条）`)
    for (const r of g.items.slice(0, 8)) {
      const i = r.item
      const at = i.published_at === undefined ? '时间不明' : i.published_at.slice(0, 10)
      const via = `${ROUTE_LABEL[i.route] ?? i.route}${i.cached === true ? '·缓存' : ''}`
      const mood = SENTIMENT_LABEL[i.sentiment ?? 'unclear']
      const seen = r.seen_count > 1 ? ` · 另见 ${r.seen_count - 1} 处` : ''
      lines.push(
        `- [${(i.title ?? i.text ?? i.url).slice(0, 80)}](${i.url}) · ${platformLabel(i.platform)} · ${at} · ${mood} · 来自${via}${seen}`,
      )
    }
  }
  if (report.cards.length > 0) {
    lines.push('', '## 要你拍板的')
    for (const c of report.cards) lines.push(`- ${c.title}——${c.why}`)
  }
  return lines.join('\n')
}
