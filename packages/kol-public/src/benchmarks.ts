/**
 * k-匿名基准（21 / 48 §1.2「合作管理…k-匿名基准」）。
 *
 * 一条规则，没有例外：**一个桶里少于 `BENCHMARK_MIN_SAMPLES`（20）条观察就不出数**。
 * 理由不是保守，是算术——桶里只有三个人的时候，"p50 是多少"就等于把那三个人的
 * 互动率报出去了；再配上"渠道 + 类目 + 粉丝量级"这三个条件，谁是谁一目了然。
 *
 * 出数的时候也**只回分位数**（p25 / p50 / p75），不回任何个体的行、不回样本列表，
 * `sample_size` 只回条数。
 */
import type { Benchmark, FollowersBand, Iso8601, KolChannel } from '@agentsws/contracts'
import { ANY_CATEGORY, BENCHMARK_MIN_SAMPLES } from '@agentsws/contracts'
import {
  BENCHMARK_CACHE_MS,
  type BucketFilter,
  type KolStore,
  type ObservationRow,
} from './store.js'

/**
 * 线性插值的分位数（与 Excel 的 `PERCENTILE.INC` 同一口径）。
 *
 * 为什么不是"取第 k 个样本"：取样本等于把某一个真人的那个数原样报出去——
 * 在一张号称 k-匿名的表上，这是最容易被忽略的一个泄露口。
 */
export function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  if (sorted.length === 1) return sorted[0] ?? 0
  const index = (sorted.length - 1) * p
  const lower = Math.floor(index)
  const upper = Math.ceil(index)
  const a = sorted[lower] ?? 0
  const b = sorted[upper] ?? a
  return a + (b - a) * (index - lower)
}

const trioOf = (values: number[]): { p25: number; p50: number; p75: number } => {
  const sorted = [...values].sort((a, b) => a - b)
  return {
    p25: quantile(sorted, 0.25),
    p50: quantile(sorted, 0.5),
    p75: quantile(sorted, 0.75),
  }
}

/** 一个桶里**每个红人只算一条**（最新那条）——同一个人被报一百次不该把桶撑到 k 之上。 */
export function latestPerCreator(rows: ObservationRow[]): ObservationRow[] {
  const latest = new Map<string, ObservationRow>()
  for (const row of rows) {
    const key = `${row.channel}/${row.handle}`
    const seen = latest.get(key)
    if (seen === undefined || row.at > seen.at) latest.set(key, row)
  }
  return [...latest.values()]
}

/** 桶不够 k 时的那一份：分位数一格都没有，只有条数与一句话由调用方补。 */
export function insufficient(filter: BucketFilter, sample_size: number, at: Iso8601): Benchmark {
  return {
    channel: filter.channel,
    category: filter.category,
    followers_band: filter.followers_band,
    sample_size,
    insufficient_samples: true,
    computed_at: at,
  }
}

export function computeBenchmark(
  rows: ObservationRow[],
  filter: BucketFilter,
  at: Iso8601,
): Benchmark {
  const unique = latestPerCreator(rows)
  if (unique.length < BENCHMARK_MIN_SAMPLES) return insufficient(filter, unique.length, at)
  return {
    channel: filter.channel,
    category: filter.category,
    followers_band: filter.followers_band,
    sample_size: unique.length,
    insufficient_samples: false,
    engagement_rate: trioOf(unique.map((r) => r.engagement_rate)),
    followers: trioOf(unique.map((r) => r.followers)),
    computed_at: at,
  }
}

/**
 * 取一个桶的基准：缓存新鲜就用缓存，否则现算再写回缓存。
 *
 * 缓存里存的也只有分位数与条数——**缓存表不是一个绕过 k 的后门**。
 */
export function benchmarkOf(store: KolStore, filter: BucketFilter, at: Iso8601): Benchmark {
  const cached = store.cachedBenchmark(filter)
  if (cached !== undefined && Date.parse(at) - Date.parse(cached.computed_at) < BENCHMARK_CACHE_MS)
    return cached
  const computed = computeBenchmark(store.observationsInBucket(filter), filter, at)
  store.putBenchmark(computed)
  return computed
}

/** 一句人话：桶不够 k 的时候界面照着它说，而不是画一张全是 0 的图。 */
export function benchmarkNote(benchmark: Benchmark): string {
  if (!benchmark.insufficient_samples)
    return `同渠道同量级里 ${benchmark.sample_size} 个账号的分位数。`
  return `这个桶里只有 ${benchmark.sample_size} 条观察，不到 ${BENCHMARK_MIN_SAMPLES} 条就不出数——样本太少，报出来的分位数会指向具体某个人。`
}

export interface BenchmarkQuery {
  channel: KolChannel
  category?: string | undefined
  followers_band: FollowersBand
}

export const bucketOf = (query: BenchmarkQuery): BucketFilter => ({
  channel: query.channel,
  followers_band: query.followers_band,
  category: (query.category ?? ANY_CATEGORY).toLowerCase(),
})
