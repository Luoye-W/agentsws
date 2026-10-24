/**
 * WP452（docs/109 §5.2 #12–16、§6.3）：投放第二批技能的契约——实验设计与读结果、盈亏平衡与目标、
 * 广告与落地页说法一致性、素材疲劳、品牌「卖的是什么」。算法全在 `@agentsws/ads-core`（纯函数），
 * 这里只放跨包要对齐的形状。只加不删。
 *
 * 方法借鉴 AgriciDaniel/claude-ads（MIT）的 `skills/ads-test`、`ads-math`、`ads-landing`、`ads-creative`、
 * `ads-monitor`、`ads-attribution`、`ads-apple`：只借判断方法与检查项结构，平台事实不抄（THIRD-PARTY-NOTICES）。
 */

/* ── 品牌：卖的是什么（§6.3 第 3 条） ─────────────────────────── */

/**
 * 卖的是实物、App 还是别的数字产品（品牌档案可选的一格）。只有投放与 SEO 的建议读它：
 * Apple 搜索广告体检（只推 App）、归因技能要不要提 App 那一节。没填 = 不知道（不猜）。
 */
export const BRAND_OFFERINGS = ['physical', 'app', 'digital'] as const
export type BrandOffering = (typeof BRAND_OFFERINGS)[number]

/** 品牌有没有 App：填了 `app` = 有；填了别的 = 没有；没填 = 不知道。 */
export function brandHasApp(offering: BrandOffering | undefined): boolean | undefined {
  return offering === undefined ? undefined : offering === 'app'
}

/* ── 实验设计与读结果（#13） ─────────────────────────────────── */

/** 主指标（都是比例：点击 / 展示、转化 / 点击、转化 / 展示）。 */
export type AdsExperimentMetric = 'ctr' | 'cvr' | 'conv_per_impression'

/** 按什么拆（同一个人只看到一版的那一层）。 */
export type AdsExperimentUnit = 'impression' | 'click' | 'user' | 'geo' | 'campaign'

/** 护栏：这一样变差超过这么多就不算赢（数由人定，AI 先给建议）。 */
export interface AdsExperimentGuardrail {
  /** 名字（`cpa`、`roas`、`退货率`…，读结果时按这个名字对值）。 */
  metric: string
  /** 越大越好（ROAS）还是越小越好（CPA）。 */
  higher_is_better: boolean
  /** 最多容忍变差几 %。 */
  max_worse_pct: number
}

export interface AdsExperimentPlan {
  hypothesis: string
  /** 改了哪一样（一次只变一样）。 */
  change: string
  unit: AdsExperimentUnit
  metric: AdsExperimentMetric
  /** 基准的比例（0–1）与它从哪来（「近 30 天报表」/「你说的」）。 */
  baseline_rate: number
  baseline_from: string
  /** 想看出的最小相对提升（%）。 */
  mde_rel_pct: number
  alpha: number
  power: number
  /** 几版（含基准）。 */
  arms: number
  /** 每一版要多少个单位（展示 / 点击…）。 */
  per_arm: number
  total: number
  /** 每天能进实验的单位数与从哪来。 */
  daily_units?: number
  daily_from?: string
  /** 要跑几天（至少 `min_days`）。 */
  days?: number
  min_days: number
  guardrails: AdsExperimentGuardrail[]
  /** 什么结果算赢，一句人话（卡上原样）。 */
  win_rule: string
  /** 要提醒的（跑太久、样本太大…）。 */
  warnings: string[]
  /** 缺什么（照实问，不拿默认值当事实）。 */
  missing: string[]
}

/** 一版的结果（读结果时给）。 */
export interface AdsExperimentArmResult {
  id: string
  label?: string
  /** 单位数（展示 / 点击）与成功数（点击 / 转化）。 */
  units: number
  successes: number
  /** 护栏那几样的值（按护栏的 `metric` 名）。 */
  guardrails?: Record<string, number>
}

export type AdsExperimentVerdict = 'keep' | 'stop' | 'retest'

export interface AdsExperimentReadout {
  verdict: AdsExperimentVerdict
  /** 每个变体对基准：比例、相对提升（%）、p 值、差的置信区间（百分点）。 */
  comparisons: {
    arm: string
    control_rate: number
    rate: number
    lift_pct: number
    p_value: number
    ci_low_pp: number
    ci_high_pp: number
    significant: boolean
  }[]
  /** 样本够不够（每一版到没到计划的数）。 */
  reached: boolean
  guardrail_breaches: { arm: string; metric: string; worse_pct: number; limit_pct: number }[]
  /** 为什么这么判（一条一句）。 */
  reasons: string[]
}

/** 「保留 / 停 / 再测」卡（`ads_experiment_readout`）的 payload。 */
export interface AdsExperimentReadoutPayload {
  form: 'ads_experiment_readout'
  experiment_id?: string
  platform?: string
  hypothesis: string
  change: string
  plan?: AdsExperimentPlan
  arms: AdsExperimentArmResult[]
  readout: AdsExperimentReadout
  /** 建议选哪个（卡上标「建议」）。 */
  recommended: AdsExperimentVerdict
}

/* ── 盈亏平衡与目标（#14） ──────────────────────────────────── */

export interface AdsBreakEvenInput {
  /** 客单价（一单的售价，含不含税照你店里的口径）。 */
  aov?: number
  /** 毛利率（%）。和 `cogs` 二选一（都给按毛利率）。 */
  gross_margin_pct?: number
  /** 一单的货本（采购 + 头程等，元）。 */
  cogs?: number
  /** 一单的运费（你出的那部分）。 */
  shipping?: number
  /** 支付手续费（% 与每单固定费）。 */
  payment_fee_pct?: number
  payment_fee_fixed?: number
  /** 退货率（%）。 */
  return_rate_pct?: number
  /** 想留的利润（占客单价 %）；给了才算目标 CPA / 目标 ROAS。 */
  target_profit_pct?: number
  currency?: string
}

export interface AdsBreakEvenResult {
  input: AdsBreakEvenInput
  /** 一单扣完各项、还没算广告时剩多少（广告最多花这么多不亏）。 */
  contribution?: number
  contribution_pct?: number
  break_even_cpa?: number
  break_even_roas?: number
  target_cpa?: number
  target_roas?: number
  /** 哪几项没给（卡上照实写「没算」）。 */
  missing: (keyof AdsBreakEvenInput)[]
  /** 能不能算（客单价与毛利 / 货本缺一样就算不了）。 */
  computable: boolean
  /** 算式（卡上原样）。 */
  formula: string
  note?: string
}

/* ── 广告与落地页说法一致性（#15） ─────────────────────────── */

export type AdClaimKind = 'price' | 'discount' | 'free_shipping' | 'selling_point'

export interface AdClaim {
  kind: AdClaimKind
  /** 广告里那一段原话。 */
  text: string
  /** 规整过的值（价格 `29.99`、折扣 `20%`、包邮 `free_shipping`、卖点原话）。 */
  value: string
}

export type LandingFix = 'page' | 'ad'

export interface LandingCheckItem {
  claim: AdClaim
  /** 不开 JS 的那份里有没有；渲染后那份有没有（没渲染成 = `not_checked`）。 */
  raw: 'present' | 'absent' | 'unknown'
  rendered: 'present' | 'absent' | 'not_checked'
  /** ok 对得上；mismatch 页上写的是另一个数；js_only 只有开 JS 才看得到；missing 页上没写；unknown 抓不到。 */
  verdict: 'ok' | 'mismatch' | 'js_only' | 'missing' | 'unknown'
  /** 页上读到的同类的值（价格 / 折扣，`mismatch` 时给人对照）。 */
  page_values?: string[]
  /** 对不上时谁来改（页面 → 网站运营；广告 → 投放自己）。 */
  fix?: LandingFix
  note: string
}

export interface LandingCheckResult {
  url: string
  ad_label: string
  items: LandingCheckItem[]
  /** 开出去的事项（谁、哪件）。 */
  opened?: { fix: LandingFix; role_id: string; matter_id: string }[]
  checked_at?: string
}

/* ── 素材疲劳（#16） ────────────────────────────────────────── */

export type FatigueSignal = 'frequency_rising' | 'ctr_declining' | 'long_running'

export interface CreativeFatigueRow {
  platform: string
  account: string
  campaign?: string
  ad: string
  ad_id?: string
  signals: FatigueSignal[]
  /** 每个信号的证据一句（「CTR 连降 4 天，3.1% → 2.0%」）。 */
  evidence: string[]
  /** 建议一句。 */
  suggestion: string
  /** 下给设计岗的换素材需求单（开了才有）。 */
  design_request_id?: string
  day: string
}
