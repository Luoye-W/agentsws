/**
 * WP452（docs/109 §5.2 #13）：广告实验的**设计**与**读结果**——规则算，不经模型手。
 *
 * 设计：假设、一次只变一样（变体来自 `variants.ts` 的 `planVariants`）、拆分单位、主指标、样本量与时长、
 * 护栏指标、什么结果算赢。读结果：样本到没到、差得显不显著、护栏破没破 → 「保留 / 停 / 再测」。
 *
 * 方法借鉴 AgriciDaniel/claude-ads（MIT）`skills/ads-test`：先定好再看（不偷看、不中途叫停）、样本不够不叫赢、
 * 最小效果与门槛由人定；我们只借方法，公式是教科书上的两比例 z 检验（THIRD-PARTY-NOTICES）。
 *
 * 三条纪律：
 * 1. **最小提升（MDE）、护栏的数由人定**：AI 先给建议、人确认（不替用户定运营规矩）；
 *    显著性 0.05、把握 0.8、至少跑 7 天（盖住一周的起伏）是统计上的常用默认，都能改。
 * 2. **缺的照实问**：基准比例、每天进多少量没有就列进 `missing`，不拿行业平均顶上。
 * 3. **没跑够不下结论**：样本不到计划的数一律「再测」（跑满再看），哪怕眼下差得很多。
 *
 * 纯函数：无 IO、无时钟、无随机。
 */
import type {
  AdsExperimentArmResult,
  AdsExperimentGuardrail,
  AdsExperimentMetric,
  AdsExperimentPlan,
  AdsExperimentReadout,
  AdsExperimentUnit,
  AdsExperimentVerdict,
} from '@agentsws/contracts'
import type { VariantPlan } from './variants.js'

/* ── 正态分布（Acklam 反函数；erf 用 Abramowitz–Stegun 7.1.26） ─────────── */

/** 标准正态分布的分位数（p ∈ (0,1)）。误差 < 1e-9。 */
export function normInv(p: number): number {
  if (!(p > 0 && p < 1)) throw new RangeError(`normInv 要 0 < p < 1，给的是 ${p}`)
  const a = [
    -39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716,
    2.506628277459239,
  ]
  const b = [
    -54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972,
    -13.28068155288572,
  ]
  const c = [
    -0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ]
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416]
  const lo = 0.02425
  const poly = (k: number[], x: number): number => k.reduce((acc, v) => acc * x + v, 0)
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p))
    return poly(c, q) / (poly(d, q) * q + 1)
  }
  if (p > 1 - lo) {
    const q = Math.sqrt(-2 * Math.log(1 - p))
    return -poly(c, q) / (poly(d, q) * q + 1)
  }
  const q = p - 0.5
  const r = q * q
  return (poly(a, r) * q) / (poly(b, r) * r + 1)
}

/** 标准正态分布的累积概率。 */
export function normCdf(x: number): number {
  const t = 1 / (1 + 0.3275911 * (Math.abs(x) / Math.SQRT2))
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-(x * x) / 2)
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2
}

/* ── 样本量与时长 ─────────────────────────────────────────────────── */

export interface SampleSizeInput {
  /** 基准比例（0–1）。 */
  baseline_rate: number
  /** 想看出的最小相对提升（%，20 = 提升两成）。 */
  mde_rel_pct: number
  alpha?: number
  power?: number
  /** 几版（含基准）；多于 2 版按「每个变体对基准」做 Bonferroni 校正。 */
  arms?: number
}

/**
 * 每一版要多少个单位（两比例、双侧 z 检验）：
 * n = (z₁₋α/₂·√(2p̄(1−p̄)) + z₁₋β·√(p₁(1−p₁)+p₂(1−p₂)))² ÷ (p₂−p₁)²，向上取整。
 */
export function sampleSizePerArm(input: SampleSizeInput): number {
  const p1 = input.baseline_rate
  const p2 = p1 * (1 + input.mde_rel_pct / 100)
  if (!(p1 > 0 && p1 < 1) || !(p2 > 0 && p2 < 1) || p2 === p1)
    throw new RangeError('基准比例要在 0 到 1 之间，最小提升不能是 0，提升后也不能超过 100%。')
  const comparisons = Math.max(1, (input.arms ?? 2) - 1)
  const alpha = (input.alpha ?? 0.05) / comparisons
  const za = normInv(1 - alpha / 2)
  const zb = normInv(input.power ?? 0.8)
  const pbar = (p1 + p2) / 2
  const top = za * Math.sqrt(2 * pbar * (1 - pbar)) + zb * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2))
  return Math.ceil((top * top) / ((p2 - p1) * (p2 - p1)))
}

/** 要跑几天：总样本 ÷ 每天进实验的量，向上取整，至少 `min_days`。 */
export function experimentDays(input: {
  per_arm: number
  arms: number
  daily_units: number
  /** 拿出多少流量做实验（0–1，默认全部）。 */
  traffic_share?: number
  min_days?: number
}): number {
  const daily = input.daily_units * (input.traffic_share ?? 1)
  if (!(daily > 0)) throw new RangeError('每天进实验的量要大于 0。')
  return Math.max(input.min_days ?? 7, Math.ceil((input.per_arm * input.arms) / daily))
}

/* ── 设计 ─────────────────────────────────────────────────────────── */

const METRIC_ZH: Record<AdsExperimentMetric, { name: string; unit: string; success: string }> = {
  ctr: { name: '点击率', unit: '展示', success: '点击' },
  cvr: { name: '转化率（按点击）', unit: '点击', success: '转化' },
  conv_per_impression: { name: '转化率（按展示）', unit: '展示', success: '转化' },
}

export const METRIC_LABEL_ZH = (m: AdsExperimentMetric): string => METRIC_ZH[m].name

export interface DesignExperimentInput {
  hypothesis: string
  change?: string
  /** 从 `planVariants` 来的变体计划（有就用它的版数与「改了哪一样」）。 */
  variants?: VariantPlan
  unit?: AdsExperimentUnit
  metric: AdsExperimentMetric
  baseline_rate?: number
  baseline_from?: string
  mde_rel_pct?: number
  alpha?: number
  power?: number
  arms?: number
  daily_units?: number
  daily_from?: string
  traffic_share?: number
  min_days?: number
  /** 跑超过这么多天要提醒（默认 42；只提醒，不拦）。 */
  warn_days?: number
  guardrails?: readonly AdsExperimentGuardrail[]
}

const pct = (n: number, d = 2): string => `${Math.round(n * 100 * 10 ** d) / 10 ** d}%`

/** 出一份实验设计。缺的列进 `missing`（照实问），能算的照算。 */
export function designExperiment(input: DesignExperimentInput): AdsExperimentPlan {
  const missing: string[] = []
  const warnings: string[] = []
  const arms = input.arms ?? input.variants?.variants.length ?? 2
  const axes = new Set(
    (input.variants?.variants ?? []).map((v) => v.axis).filter((a) => a !== undefined),
  )
  if (axes.size > 1)
    warnings.push('这几版改的不是同一样：跑完分不清是哪一样起的作用。一次只变一样。')
  const change =
    input.change?.trim() ||
    input.variants?.variants
      .filter((v) => v.id !== 'base')
      .map((v) => v.note)
      .join('；') ||
    ''
  if (change === '') missing.push('改了哪一样（一次只变一样）')
  if (input.hypothesis.trim() === '') missing.push('假设：想验证什么')
  const baseline = input.baseline_rate
  if (baseline === undefined || !(baseline > 0 && baseline < 1))
    missing.push(`基准${METRIC_ZH[input.metric].name}（近一段时间的实际数）`)
  if (input.mde_rel_pct === undefined || input.mde_rel_pct === 0)
    missing.push('想看出的最小提升（比如提升两成才值得换）')
  const alpha = input.alpha ?? 0.05
  const power = input.power ?? 0.8
  const min_days = input.min_days ?? 7
  let per_arm = 0
  if (baseline !== undefined && baseline > 0 && baseline < 1 && input.mde_rel_pct !== undefined) {
    try {
      per_arm = sampleSizePerArm({
        baseline_rate: baseline,
        mde_rel_pct: input.mde_rel_pct,
        alpha,
        power,
        arms,
      })
    } catch (e) {
      missing.push(e instanceof Error ? e.message : String(e))
    }
  }
  let days: number | undefined
  if (input.daily_units === undefined || !(input.daily_units > 0))
    missing.push(`每天能进实验的${METRIC_ZH[input.metric].unit}数`)
  else if (per_arm > 0) {
    days = experimentDays({
      per_arm,
      arms,
      daily_units: input.daily_units,
      ...(input.traffic_share === undefined ? {} : { traffic_share: input.traffic_share }),
      min_days,
    })
    if (days > (input.warn_days ?? 42))
      warnings.push(
        `要跑 ${days} 天：太久了，中间的季节、促销会搅进来。要么把最小提升放大，要么换个量大的指标（比如先看点击率）。`,
      )
  }
  const m = METRIC_ZH[input.metric]
  const guardrails = [...(input.guardrails ?? [])]
  const guardText =
    guardrails.length === 0
      ? ''
      : `，并且${guardrails.map((g) => `${g.metric}变差不超过 ${g.max_worse_pct}%`).join('、')}`
  const win_rule =
    per_arm > 0 && input.mde_rel_pct !== undefined
      ? `每一版跑满 ${per_arm} 次${m.unit}后再看：变体的${m.name}比基准高、差别显著（p < ${alpha}）${guardText}，才算赢。没跑满不看结果、不中途叫停。`
      : `先补齐缺的几样，才算得出要跑多少${m.unit}、什么算赢。`
  return {
    hypothesis: input.hypothesis.trim(),
    change,
    unit: input.unit ?? (input.metric === 'cvr' ? 'click' : 'impression'),
    metric: input.metric,
    baseline_rate: baseline ?? 0,
    baseline_from: input.baseline_from ?? (baseline === undefined ? '没有' : '你给的'),
    mde_rel_pct: input.mde_rel_pct ?? 0,
    alpha,
    power,
    arms,
    per_arm,
    total: per_arm * arms,
    ...(input.daily_units === undefined ? {} : { daily_units: input.daily_units }),
    ...(input.daily_from === undefined ? {} : { daily_from: input.daily_from }),
    ...(days === undefined ? {} : { days }),
    min_days,
    guardrails,
    win_rule,
    warnings,
    missing,
  }
}

/* ── 读结果 ───────────────────────────────────────────────────────── */

const round = (n: number, d: number): number => Math.round(n * 10 ** d) / 10 ** d

/** 两比例 z 检验（合并方差）的双侧 p 值，以及差的置信区间（非合并方差）。 */
export function twoProportionTest(
  control: { units: number; successes: number },
  variant: { units: number; successes: number },
  alpha = 0.05,
): { p_value: number; ci_low: number; ci_high: number; diff: number } {
  const p1 = control.successes / control.units
  const p2 = variant.successes / variant.units
  const pooled = (control.successes + variant.successes) / (control.units + variant.units)
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / control.units + 1 / variant.units))
  const z = se === 0 ? 0 : (p2 - p1) / se
  const p_value = 2 * (1 - normCdf(Math.abs(z)))
  const seu = Math.sqrt((p1 * (1 - p1)) / control.units + (p2 * (1 - p2)) / variant.units)
  const zc = normInv(1 - alpha / 2)
  return { p_value, ci_low: p2 - p1 - zc * seu, ci_high: p2 - p1 + zc * seu, diff: p2 - p1 }
}

/**
 * 读结果：第一版是基准，其余每版对它比。
 *
 * - 有一版没到计划的样本 → 再测（跑满再看）；
 * - 护栏破了 → 停；
 * - 显著变好 → 保留（有几版都显著变好，取提升最大的那版）；显著变差 → 停；
 * - 跑满了没分出高下：差的上限都够不着最小提升 → 停（没带来值得换的提升，留基准）；够得着 → 再测（量不够判）。
 */
export function readExperiment(input: {
  plan: Pick<AdsExperimentPlan, 'per_arm' | 'alpha' | 'mde_rel_pct' | 'guardrails' | 'metric'>
  arms: readonly AdsExperimentArmResult[]
}): AdsExperimentReadout {
  const [control, ...variants] = input.arms
  const reasons: string[] = []
  if (control === undefined || variants.length === 0)
    return {
      verdict: 'retest',
      comparisons: [],
      reached: false,
      guardrail_breaches: [],
      reasons: ['至少要两版（第一版是基准）才比得了。'],
    }
  const m = METRIC_ZH[input.plan.metric]
  const labelOf = (id: string): string => input.arms.find((a) => a.id === id)?.label ?? id
  const comparisons = variants
    .filter((v) => v.units > 0 && control.units > 0)
    .map((v) => {
      const t = twoProportionTest(control, v, input.plan.alpha)
      const cr = control.successes / control.units
      const vr = v.successes / v.units
      return {
        arm: v.id,
        control_rate: round(cr, 6),
        rate: round(vr, 6),
        lift_pct: cr === 0 ? 0 : round(((vr - cr) / cr) * 100, 2),
        p_value: round(t.p_value, 4),
        ci_low_pp: round(t.ci_low * 100, 3),
        ci_high_pp: round(t.ci_high * 100, 3),
        significant: t.p_value < input.plan.alpha,
      }
    })
  const short = input.arms.filter((a) => a.units < input.plan.per_arm)
  const reached = short.length === 0
  const guardrail_breaches: AdsExperimentReadout['guardrail_breaches'] = []
  for (const v of variants)
    for (const g of input.plan.guardrails) {
      const base = control.guardrails?.[g.metric]
      const got = v.guardrails?.[g.metric]
      if (base === undefined || got === undefined || base === 0) continue
      const change = ((got - base) / Math.abs(base)) * 100
      const worse = g.higher_is_better ? -change : change
      if (worse > g.max_worse_pct)
        guardrail_breaches.push({
          arm: v.id,
          metric: g.metric,
          worse_pct: round(worse, 2),
          limit_pct: g.max_worse_pct,
        })
    }
  let verdict: AdsExperimentVerdict
  if (!reached) {
    verdict = 'retest'
    reasons.push(
      `还没跑够：${short.map((a) => `「${a.label ?? a.id}」${a.units}/${input.plan.per_arm}`).join('、')}。没跑满看结果容易看错，跑满再判。`,
    )
  } else if (guardrail_breaches.length > 0) {
    verdict = 'stop'
    for (const b of guardrail_breaches)
      reasons.push(
        `「${labelOf(b.arm)}」的${b.metric}变差 ${b.worse_pct}%，超过护栏 ${b.limit_pct}%。`,
      )
  } else {
    const wins = comparisons.filter((c) => c.significant && c.lift_pct > 0)
    const losses = comparisons.filter((c) => c.significant && c.lift_pct < 0)
    if (wins.length > 0) {
      const best = [...wins].sort((a, b) => b.lift_pct - a.lift_pct)[0] as (typeof wins)[number]
      verdict = 'keep'
      reasons.push(
        `「${labelOf(best.arm)}」${m.name} ${pct(best.rate)} 对基准 ${pct(best.control_rate)}，提升 ${best.lift_pct}%（p = ${best.p_value}）。`,
      )
    } else if (losses.length === comparisons.length && losses.length > 0) {
      verdict = 'stop'
      reasons.push(
        `变体都显著比基准差（${losses.map((l) => `「${labelOf(l.arm)}」${l.lift_pct}%`).join('、')}）。`,
      )
    } else {
      // 跑满了没分出高下：看差的上限够不够得着最小提升
      // 最小提升换成百分点：基准比例 × 相对提升（0.02 × 20% = 0.4 个百分点）
      const couldMatter = comparisons.some(
        (c) => c.ci_high_pp >= c.control_rate * input.plan.mde_rel_pct,
      )
      verdict = couldMatter ? 'retest' : 'stop'
      reasons.push(
        couldMatter
          ? '跑满了还没分出高下，但真实差别可能还够得着你要的提升：可以再测一轮（加量或延长）。'
          : `跑满了没分出高下，差别的上限也够不着你要的 ${input.plan.mde_rel_pct}% 提升：变体不值得换，留基准。`,
      )
    }
  }
  return { verdict, comparisons, reached, guardrail_breaches, reasons }
}

/** 三个选项在卡上的说法。 */
export const EXPERIMENT_VERDICT_LABEL: Readonly<Record<AdsExperimentVerdict, string>> = {
  keep: '保留：换成赢的那版',
  stop: '停：停掉变体，留基准版',
  retest: '再测：再跑一轮',
}
