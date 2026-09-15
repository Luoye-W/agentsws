/**
 * 体检报告（48 §5.3「免费体检报告」）。
 *
 * 一条纪律压着所有算法：**数据不足就明说"样本不够"，不编**。
 *
 * - 少于 `MIN_AUDIT_SAMPLES` 条观察 → `insufficient_samples: true`，
 *   `follower_authenticity` 与 `engagement_percentile` 一格都不给；
 * - 基准桶不到 k（20）→ 分位那一格不给，报告里说清楚是"没有可比的人"，
 *   不是"这个人很差"；
 * - 风险标记**只标不判**：标出来的是"这一项和同量级的人差得远"这种事实，
 *   要不要合作是用户的判断。
 *
 * 粉丝真实度是一个**估计**，算法写在这里而不是藏在别处：同量级同渠道的人互动率
 * 差得离谱（低于 p25 的四分之一）通常意味着粉丝买过；发布停了很久而粉丝还在涨
 * 是另一个信号。两项都不成立就给一个由样本量与来源档决定的基线。
 */
import type { AuditReport, AuditRiskFlag, Benchmark, Iso8601 } from '@agentsws/contracts'
import {
  followersBandOf,
  MIN_AUDIT_SAMPLES,
  SOURCE_CONFIDENCE,
  STALE_AFTER_DAYS,
} from '@agentsws/contracts'
import { benchmarkNote } from './benchmarks.js'
import type { CreatorRow, ObservationRow } from './store.js'

const DAY_MS = 24 * 60 * 60 * 1000

/** 互动率在这个桶里的分位（0–100）。桶不够 k 就没有这一格。 */
export function percentileOf(value: number, benchmark: Benchmark): number | undefined {
  const trio = benchmark.engagement_rate
  if (benchmark.insufficient_samples || trio === undefined) return undefined
  if (value <= trio.p25) return Math.max(0, Math.round((value / Math.max(trio.p25, 1e-9)) * 25))
  if (value <= trio.p50)
    return Math.round(25 + ((value - trio.p25) / Math.max(trio.p50 - trio.p25, 1e-9)) * 25)
  if (value <= trio.p75)
    return Math.round(50 + ((value - trio.p50) / Math.max(trio.p75 - trio.p50, 1e-9)) * 25)
  return Math.min(100, Math.round(75 + ((value - trio.p75) / Math.max(trio.p75, 1e-9)) * 25))
}

/**
 * 粉丝真实度估计（0–1）。
 *
 * 基线 = 来源档 × 样本量带来的把握；再按两条护栏往下扣：
 * 互动率远低于同量级的 p25（买粉最常见的形状）、近 30 天没发但粉丝数在涨。
 */
export function followerAuthenticity(
  card: CreatorRow,
  observations: ObservationRow[],
  benchmark: Benchmark,
): number {
  const base = Math.min(
    0.95,
    (SOURCE_CONFIDENCE[card.source] ?? 0.5) * 0.6 + Math.min(observations.length / 10, 1) * 0.35,
  )
  let score = base
  const p25 = benchmark.insufficient_samples ? undefined : benchmark.engagement_rate?.p25
  if (p25 !== undefined && p25 > 0 && card.engagement_rate < p25 / 4) score -= 0.35
  else if (p25 !== undefined && p25 > 0 && card.engagement_rate < p25 / 2) score -= 0.15
  if (card.posts_30d === 0 && followerGrowing(observations)) score -= 0.2
  return Math.max(0, Math.round(Math.min(1, score) * 100) / 100)
}

/** 粉丝数在最近几条观察里是不是一直在涨。 */
export function followerGrowing(observations: ObservationRow[]): boolean {
  const sorted = [...observations].sort((a, b) => (a.observed_at < b.observed_at ? -1 : 1))
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  if (first === undefined || last === undefined || sorted.length < 2) return false
  return last.followers > first.followers * 1.05
}

/** 粉丝数是不是出现过一次跳变（两条相邻观察之间涨了一半以上）。 */
export function followerSpike(observations: ObservationRow[]): boolean {
  const sorted = [...observations].sort((a, b) => (a.observed_at < b.observed_at ? -1 : 1))
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1]
    const cur = sorted[i]
    if (prev === undefined || cur === undefined || prev.followers <= 0) continue
    if (cur.followers > prev.followers * 1.5) return true
  }
  return false
}

export interface AuditInput {
  card: CreatorRow
  observations: ObservationRow[]
  benchmark: Benchmark
  at: Iso8601
  depth: 'basic' | 'deep'
}

export function buildAudit(input: AuditInput): AuditReport {
  const { card, observations, benchmark, at } = input
  const flags: AuditRiskFlag[] = []
  if (card.posts_30d === 0) flags.push('no_recent_posts')
  if (observations.length <= 1) flags.push('single_source')
  if (Date.parse(at) - Date.parse(card.observed_at) > STALE_AFTER_DAYS * DAY_MS)
    flags.push('stale_data')
  if (followerSpike(observations)) flags.push('follower_spike')

  const percentile = percentileOf(card.engagement_rate, benchmark)
  if (percentile !== undefined && percentile < 10) flags.push('engagement_far_below_peers')
  if (percentile !== undefined && percentile > 95) flags.push('engagement_far_above_peers')

  const enough = observations.length >= MIN_AUDIT_SAMPLES
  const base = {
    channel: card.channel,
    handle: card.handle,
    depth: input.depth,
    sample_size: observations.length,
    insufficient_samples: !enough,
    active_30d: card.posts_30d > 0,
    risk_flags: flags,
    generated_at: at,
  }

  if (!enough) {
    return {
      ...base,
      note: `样本不够：这个人身上只有 ${observations.length} 条观察，至少要 ${MIN_AUDIT_SAMPLES} 条才出粉丝真实度与分位。现在能说的只有最近一次看到的资料本身。`,
    }
  }

  const authenticity = followerAuthenticity(card, observations, benchmark)
  const note =
    percentile === undefined
      ? `${benchmarkNote(benchmark)}所以这份报告里没有分位——不是这个人差，是同量级可比的人还不够。`
      : `基于 ${observations.length} 条观察与同渠道同量级（${followersBandOf(card.followers)}）${benchmark.sample_size} 个账号的分位。`

  return {
    ...base,
    follower_authenticity: authenticity,
    ...(percentile === undefined ? {} : { engagement_percentile: percentile }),
    ...(input.depth === 'deep' ? { benchmark } : {}),
    note,
  }
}
