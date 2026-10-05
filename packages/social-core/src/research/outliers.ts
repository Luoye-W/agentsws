/**
 * WP220：**爆款帖**怎么算——改编自 ScrapeCreators/social-media-research-skills 的
 * outlier-post-finder（MIT，© 2026 ScrapeCreators）。方法照它：
 *
 * - 跟**这个账号自己**比，不跟别人比（大号的普通帖也比小号的爆款播放多）；
 * - 基线用**中位数**不用平均数（一条爆款不该把基线拉高）；
 * - 每个平台、每个账号（能分就再按形式分：短视频 / 长视频 / 图文）各算各的基线，不混；
 * - 倍数分三档：5 倍以上「大爆」、2–5 倍「明显」、1.5–2 倍「小爆」；
 * - 样本不到 10 条，结论只能算「方向」（置信低）。
 *
 * 数字由这里算，模型不算（数字不编）。
 */
import type { Iso8601 } from '@agentsws/contracts'

export interface PerformancePost {
  platform: string
  account: string
  url: string
  posted_at?: Iso8601
  /** 形式（`short_video` / `long_video` / `image` / `text` ……）。不给就不分。 */
  format?: string
  views?: number
  likes?: number
  comments?: number
  shares?: number
  saves?: number
}

export type OutlierTier = 'huge' | 'strong' | 'mild'

export interface ScoredPost {
  post: PerformancePost
  /** 用哪个数比的：视频看播放，图文 / 文字看互动。 */
  metric: 'views' | 'engagement'
  value: number
  baseline: number
  /** 倍数（保留一位小数）。 */
  lift: number
  tier?: OutlierTier
}

export interface OutlierGroup {
  platform: string
  account: string
  format?: string
  sample: number
  metric: 'views' | 'engagement'
  baseline: number
  confidence: 'high' | 'medium' | 'low'
  posts: ScoredPost[]
}

export const OUTLIER_TIERS: readonly { tier: OutlierTier; min_lift: number }[] = [
  { tier: 'huge', min_lift: 5 },
  { tier: 'strong', min_lift: 2 },
  { tier: 'mild', min_lift: 1.5 },
]

/** 样本少于这个数，置信只能是低。 */
export const OUTLIER_MIN_SAMPLE = 10

const VIDEO_FORMATS = new Set(['short_video', 'long_video', 'video', 'reel', 'short'])

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? 0)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

function engagementOf(p: PerformancePost): number | undefined {
  const parts = [p.likes, p.comments, p.shares, p.saves].filter(
    (v): v is number => typeof v === 'number' && Number.isFinite(v),
  )
  return parts.length === 0 ? undefined : parts.reduce((a, b) => a + b, 0)
}

export function tierOf(lift: number): OutlierTier | undefined {
  return OUTLIER_TIERS.find((t) => lift >= t.min_lift)?.tier
}

/**
 * 按「平台 × 账号 × 形式」分组，各自用中位数做基线，给每条帖子算倍数与档位。
 * 一组里大多数帖子有播放数就按播放比，否则按互动比；两样都没有的帖子不进组。
 */
export function scoreOutliers(posts: readonly PerformancePost[]): OutlierGroup[] {
  const groups = new Map<string, PerformancePost[]>()
  for (const p of posts) {
    const key = `${p.platform}\u0000${p.account.toLowerCase()}\u0000${p.format ?? ''}`
    const list = groups.get(key)
    if (list === undefined) groups.set(key, [p])
    else list.push(p)
  }
  const out: OutlierGroup[] = []
  for (const list of groups.values()) {
    const first = list[0]
    if (first === undefined) continue
    const withViews = list.filter((p) => typeof p.views === 'number')
    const videoish =
      first.format === undefined
        ? withViews.length * 2 > list.length
        : VIDEO_FORMATS.has(first.format)
    const metric: 'views' | 'engagement' = videoish && withViews.length > 0 ? 'views' : 'engagement'
    const measured = list.flatMap((p) => {
      const v = metric === 'views' ? p.views : engagementOf(p)
      return v === undefined ? [] : [{ p, v }]
    })
    if (measured.length === 0) continue
    const baseline = median(measured.map((m) => m.v))
    const scored: ScoredPost[] = measured
      .map(({ p, v }) => {
        const lift = baseline > 0 ? Math.round((v / baseline) * 10) / 10 : 0
        const tier = tierOf(lift)
        return {
          post: p,
          metric,
          value: v,
          baseline,
          lift,
          ...(tier === undefined ? {} : { tier }),
        }
      })
      .sort((a, b) => b.lift - a.lift)
    out.push({
      platform: first.platform,
      account: first.account,
      ...(first.format === undefined ? {} : { format: first.format }),
      sample: measured.length,
      metric,
      baseline,
      confidence:
        measured.length < OUTLIER_MIN_SAMPLE ? 'low' : measured.length < 20 ? 'medium' : 'high',
      posts: scored,
    })
  }
  return out
}
