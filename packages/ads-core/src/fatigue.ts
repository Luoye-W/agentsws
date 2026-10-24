/**
 * WP452（docs/109 §5.2 #16）：**素材疲劳**——每日止损那一轮顺带看：频次在涨、点击率连着降、同一素材跑太久。
 * 只给建议与换素材需求单（`request_design`），**不自动换**（换素材上线照旧是改广告那张卡）。
 *
 * 判法：
 * - 点击率连降：最近连续 N 天每天都比前一天低，且最近一天比这段之前的最高点低了 X% 以上；
 * - 频次在涨：最近连续 N 天每天都比前一天高，且最近一天不低于下限（报表里有「频次」那一列才判，没有就不判）；
 * - 跑太久：这条广告在看的这段里有数的天数 ≥ N 天——**只当佐证，不单独算疲劳**（光凭跑得久不叫疲劳）。
 * 展示太少的天不算（噪声）。所有门槛都是**可改的起步值**（职责 yml 的 `thresholds`），不是平台规矩。
 *
 * 方法借鉴 AgriciDaniel/claude-ads（MIT）`skills/ads-creative`、`ads-monitor`：按时间序列的投放与反应判，
 * 「不单凭年龄」，不给放之四海皆准的刷新周期（THIRD-PARTY-NOTICES）。
 *
 * 纯函数：无 IO、无时钟。
 */
import type { CreativeFatigueRow, FatigueSignal } from '@agentsws/contracts'
import type { AdsReportRow } from './sheets/report.js'

export interface FatigueThresholds {
  /** 点击率连降几天（默认 3）。 */
  ctr_drop_days: number
  /** 比这段之前的最高点低多少 %（默认 20）。 */
  ctr_drop_pct: number
  /** 频次连涨几天（默认 3）。 */
  frequency_rise_days: number
  /** 频次至少多少才算（默认 2）。 */
  frequency_min: number
  /** 跑多少天算久（默认 21，只当佐证）。 */
  long_running_days: number
  /** 一天少于这么多展示不算（默认 500）。 */
  min_daily_impressions: number
}

export const DEFAULT_FATIGUE_THRESHOLDS: Readonly<FatigueThresholds> = {
  ctr_drop_days: 3,
  ctr_drop_pct: 20,
  frequency_rise_days: 3,
  frequency_min: 2,
  long_running_days: 21,
  min_daily_impressions: 500,
}

/** 职责 yml 的 `thresholds`（`fatigue_*` 那几格）→ 门槛；没写的用起步值。 */
export function fatigueThresholdsOf(
  t: Readonly<Record<string, number>> | undefined,
): FatigueThresholds {
  const pick = (k: keyof FatigueThresholds): number => {
    const v = t?.[`fatigue_${k}`]
    return v !== undefined && Number.isFinite(v) && v >= 0 ? v : DEFAULT_FATIGUE_THRESHOLDS[k]
  }
  return {
    ctr_drop_days: pick('ctr_drop_days'),
    ctr_drop_pct: pick('ctr_drop_pct'),
    frequency_rise_days: pick('frequency_rise_days'),
    frequency_min: pick('frequency_min'),
    long_running_days: pick('long_running_days'),
    min_daily_impressions: pick('min_daily_impressions'),
  }
}

const pct = (n: number): string => `${Math.round(n * 1000) / 10}%`

/** 末尾连续 n 段每段都严格单调（`dir` 1 涨 / -1 降）。 */
function tailMonotone(values: readonly number[], n: number, dir: 1 | -1): boolean {
  if (n < 1 || values.length < n + 1) return false
  const tail = values.slice(-(n + 1))
  for (let i = 1; i < tail.length; i++)
    if (dir * ((tail[i] as number) - (tail[i - 1] as number)) <= 0) return false
  return true
}

/**
 * 看一批广告那一层的逐日行（一般是最近 30 天），挑出有疲劳迹象的。
 * `platform` / `account` 原样写进结果（一家一账户调一次）。
 */
export function creativeFatigue(input: {
  rows: readonly AdsReportRow[]
  platform: string
  account: string
  today: string
  thresholds?: Partial<FatigueThresholds>
}): CreativeFatigueRow[] {
  const t = { ...DEFAULT_FATIGUE_THRESHOLDS, ...(input.thresholds ?? {}) }
  const byAd = new Map<string, AdsReportRow[]>()
  for (const r of input.rows) {
    if (r.level !== 'ad' || r.day === undefined) continue
    const k = r.ad_id ?? r.ad ?? ''
    if (k === '') continue
    byAd.set(k, [...(byAd.get(k) ?? []), r])
  }
  const out: CreativeFatigueRow[] = []
  for (const list of byAd.values()) {
    const days = [...list].sort((a, b) => (a.day as string).localeCompare(b.day as string))
    const first = days[0] as AdsReportRow
    const signals: FatigueSignal[] = []
    const evidence: string[] = []
    const counted = days.filter((d) => (d.metrics.impressions ?? 0) >= t.min_daily_impressions)
    const ctrs = counted.map((d) => (d.metrics.clicks ?? 0) / (d.metrics.impressions as number))
    if (tailMonotone(ctrs, t.ctr_drop_days, -1)) {
      const before = ctrs.slice(0, -(t.ctr_drop_days + 1))
      const peak = Math.max(...(before.length > 0 ? before : ctrs.slice(0, 1)))
      const last = ctrs[ctrs.length - 1] as number
      if (peak > 0 && ((peak - last) / peak) * 100 >= t.ctr_drop_pct) {
        signals.push('ctr_declining')
        evidence.push(`点击率连降 ${t.ctr_drop_days} 天，从最高 ${pct(peak)} 到 ${pct(last)}`)
      }
    }
    const freqs = counted
      .map((d) => d.metrics.frequency)
      .filter((f): f is number => f !== undefined && Number.isFinite(f))
    if (freqs.length === counted.length && tailMonotone(freqs, t.frequency_rise_days, 1)) {
      const last = freqs[freqs.length - 1] as number
      if (last >= t.frequency_min) {
        signals.push('frequency_rising')
        evidence.push(
          `频次连涨 ${t.frequency_rise_days} 天，到 ${Math.round(last * 100) / 100}（同一个人平均看了这么多次）`,
        )
      }
    }
    // 跑太久只当佐证：前两样一样都没有就不算疲劳
    if (signals.length === 0) continue
    const live = days.filter((d) => (d.metrics.impressions ?? 0) > 0).length
    if (live >= t.long_running_days) {
      signals.push('long_running')
      evidence.push(`这段里跑了 ${live} 天`)
    }
    const name = first.ad ?? first.ad_id ?? ''
    out.push({
      platform: input.platform,
      account: input.account,
      ...(first.campaign === undefined ? {} : { campaign: first.campaign }),
      ad: name,
      ...(first.ad_id === undefined ? {} : { ad_id: first.ad_id }),
      signals,
      evidence,
      suggestion: signals.includes('frequency_rising')
        ? '同一批人看腻了：备一版新图 / 新开头换上，或者把受众放宽一点。'
        : '点击率在往下走：备一版新图 / 新开头换上，先和现在这版并排跑几天。',
      day: input.today,
    })
  }
  return out
}

/** 换素材需求单那一段话（交设计岗）。 */
export function fatigueDesignNeed(row: CreativeFatigueRow): { title: string; need: string } {
  return {
    title: `换素材：${row.ad}（素材疲劳）`,
    need: [
      `${row.campaign === undefined ? '' : `广告系列「${row.campaign}」里的`}广告「${row.ad}」有疲劳迹象：`,
      ...row.evidence.map((e) => `- ${e}`),
      `建议：${row.suggestion}`,
      '只要新素材，不改投给谁；换上线由投放出改广告的卡，你批了才换。',
    ].join('\n'),
  }
}
