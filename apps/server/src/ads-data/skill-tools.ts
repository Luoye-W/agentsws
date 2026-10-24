/**
 * WP452（docs/109 §5.2 #12–15）：投放第二批技能那几个工具的执行器（名字 / 描述在 `@agentsws/stand-ins` 的
 * `runtime/ads-data.ts`）。数全由 `@agentsws/ads-core` 的规则算，这一层只把事实读齐、落状态、开事项、出卡。
 *
 * - `run_ads_audit`：十家共用一套（老四家读插件每天导的同一张表）；清单按品牌读（订阅来的正式清单覆盖基础版）。
 * - `calc_break_even`：保本 ROAS / CPA（目标）；毛利率没给读事实卡；结论存进状态，右栏「保本线」读它。
 * - `check_ad_landing`：抓落地页两份（不开 JS / 渲染后），逐条核对；对不上的按「谁来改」开事项（同一份 7 天内不重开）。
 * - `design_ads_experiment` / `read_ads_experiment`：规则算样本量与时长、读结果出「保留 / 停 / 再测」卡。
 */
import { createHash } from 'node:crypto'
import {
  breakEvenTargets,
  checkLanding,
  designExperiment,
  EXPERIMENT_VERDICT_LABEL,
  extractAdClaims,
  landingHandoffText,
  readExperiment,
} from '@agentsws/ads-core'
import type {
  AdExperimentEntry,
  AdsBreakEvenInput,
  AdsBreakEvenResult,
  AdsExperimentArmResult,
  AdsExperimentGuardrail,
  AdsExperimentMetric,
  AdsExperimentReadoutPayload,
  AdsExperimentUnit,
  AdsPlatform,
  LandingCheckResult,
  LandingFix,
  RunRequest,
} from '@agentsws/contracts'
import type { ToolExecution } from '@agentsws/stand-ins'
import { exportAudit } from './export-view.js'
import type { AdsDataService } from './service.js'

/** 状态格的键（右栏那几块读同一份）。 */
export const ADS_SKILL_STATE = {
  breakEven: 'break_even',
  landing: 'landing_checks',
  landingOpened: 'landing_opened',
  fatigue: 'creative_fatigue',
} as const

export interface AdsSkillToolOptions {
  /** 品牌 id（体检清单按品牌覆盖）。 */
  brand?(): string | undefined
  hasApp?(): boolean | undefined
  /** 品牌那一格毛利率（事实卡；没填回 `undefined`）。 */
  grossMargin?(): number | undefined
  /** 抓落地页：不开 JS 的原始页与渲染后那份，都换成读得到的文字；抓不到的不给。 */
  landingPage?(url: string): Promise<{ raw?: string; rendered?: string; note?: string }>
  /** 给某条职责的担当人开一件事（没人担回 `undefined`）。 */
  openMatter?(input: {
    role_id: string
    title: string
    text: string
  }): Promise<{ matter_id: string } | undefined>
  /** 实验记忆（投放岗记忆里那几条）。 */
  experiments?: {
    add(
      req: RunRequest,
      input: { hypothesis: string; change: string; platform?: string; plan: unknown },
    ): Promise<AdExperimentEntry>
    get(req: RunRequest, id: string): AdExperimentEntry | undefined
  }
  /** 出「保留 / 停 / 再测」卡。 */
  readoutCard?(
    req: RunRequest,
    payload: AdsExperimentReadoutPayload,
  ): Promise<{ id: string } | undefined>
  now(): string
}

const ok = (data: unknown): ToolExecution => ({ status: 'ok', data })
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
const strs = (v: unknown, max: number): string[] =>
  Array.isArray(v)
    ? v
        .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
        .map((x) => x.trim())
        .slice(0, max)
    : []

const dayAdd = (day: string, n: number): string =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

/** 近 30 天这家的数里算基准比例与每天的量（按主指标）。 */
function baselineFrom(
  svc: AdsDataService,
  platform: AdsPlatform,
  metric: AdsExperimentMetric,
  campaign: string | undefined,
): { rate?: number; daily?: number; from: string } {
  const today = svc.today()
  const rows = svc
    .rows({ since: dayAdd(today, -30), until: today, platform: platform as never })
    .filter((r) => r.level === 'campaign' || r.level === 'ad_group' || r.level === 'ad')
  // 同一份钱在三层里各算一遍：取最粗的那一层
  const level = ['campaign', 'ad_group', 'ad'].find((l) => rows.some((r) => r.level === l))
  const mine = rows
    .filter((r) => r.level === level)
    .filter(
      (r) =>
        campaign === undefined || (r.campaign ?? '').toLowerCase().includes(campaign.toLowerCase()),
    )
  const sum = (k: 'impressions' | 'clicks' | 'conversions'): number =>
    mine.reduce((a, r) => a + (r.metrics[k] ?? 0), 0)
  const days = new Set(mine.map((r) => r.day)).size
  const [units, wins] =
    metric === 'ctr'
      ? [sum('impressions'), sum('clicks')]
      : metric === 'cvr'
        ? [sum('clicks'), sum('conversions')]
        : [sum('impressions'), sum('conversions')]
  if (units <= 0 || days === 0) return { from: '库里近 30 天没有这家的数' }
  return {
    ...(wins > 0 ? { rate: Math.round((wins / units) * 1e6) / 1e6 } : {}),
    daily: Math.round(units / days),
    from: `近 30 天已入库的数（${days} 天${campaign === undefined ? '' : `，只看「${campaign}」`}）`,
  }
}

function guardrailsOf(v: unknown): AdsExperimentGuardrail[] {
  if (!Array.isArray(v)) return []
  return v
    .filter((g): g is Record<string, unknown> => typeof g === 'object' && g !== null)
    .map((g) => ({
      metric: str(g.metric) ?? '',
      higher_is_better: g.higher_is_better === true,
      max_worse_pct: num(g.max_worse_pct) ?? Number.NaN,
    }))
    .filter((g) => g.metric !== '' && Number.isFinite(g.max_worse_pct))
    .slice(0, 5)
}

function armsOf(v: unknown): AdsExperimentArmResult[] {
  if (!Array.isArray(v)) return []
  return v
    .filter((a): a is Record<string, unknown> => typeof a === 'object' && a !== null)
    .map((a, i) => {
      const g =
        typeof a.guardrails === 'object' && a.guardrails !== null
          ? Object.fromEntries(
              Object.entries(a.guardrails as Record<string, unknown>).filter(
                (e): e is [string, number] => num(e[1]) !== undefined,
              ),
            )
          : undefined
      return {
        id: str(a.id) ?? `v${i}`,
        ...(str(a.label) === undefined ? {} : { label: str(a.label) as string }),
        units: Math.max(0, Math.floor(num(a.units) ?? 0)),
        successes: Math.max(0, Math.floor(num(a.successes) ?? 0)),
        ...(g === undefined || Object.keys(g).length === 0 ? {} : { guardrails: g }),
      }
    })
    .filter((a) => a.successes <= a.units)
    .slice(0, 6)
}

/** 落地页对不上的交给谁（页面 → 网站运营；广告 → 投放这条自己）。 */
const FIX_ROLE = (fix: LandingFix, self: string): string => (fix === 'page' ? 'dtc.store' : self)
const LANDING_QUIET_MS = 7 * 86_400_000

export async function runAdsSkillTool(
  name: string,
  input: Record<string, unknown>,
  req: RunRequest,
  svc: AdsDataService,
  platform: AdsPlatform,
  options: AdsSkillToolOptions,
): Promise<ToolExecution | undefined> {
  if (name === 'run_ads_audit') {
    const hasApp = options.hasApp?.()
    const brand = options.brand?.()
    return ok({
      ok: true,
      ...exportAudit(svc, platform, {
        ...(hasApp === undefined ? {} : { has_app: hasApp }),
        ...(brand === undefined ? {} : { brand }),
      }),
    })
  }

  if (name === 'calc_break_even') {
    const given: AdsBreakEvenInput = {}
    for (const k of [
      'aov',
      'gross_margin_pct',
      'cogs',
      'shipping',
      'payment_fee_pct',
      'payment_fee_fixed',
      'return_rate_pct',
      'target_profit_pct',
    ] as const) {
      const v = num(input[k])
      if (v !== undefined) given[k] = v
    }
    const currency = str(input.currency)
    if (currency !== undefined) given.currency = currency.toUpperCase()
    let margin_from: string | undefined
    if (given.gross_margin_pct === undefined && given.cogs === undefined) {
      const m = options.grossMargin?.()
      if (m !== undefined) {
        given.gross_margin_pct = m
        margin_from = '毛利率事实卡'
      }
    }
    const result: AdsBreakEvenResult = breakEvenTargets(given)
    const saved = {
      ...result,
      at: options.now(),
      ...(margin_from === undefined ? {} : { margin_from }),
    }
    svc.setState?.(ADS_SKILL_STATE.breakEven, saved)
    const MISSING_ZH: Record<string, string> = {
      aov: '客单价',
      gross_margin_pct: '毛利率或一单货本',
      shipping: '运费',
      payment_fee_pct: '支付手续费',
      return_rate_pct: '退货率',
    }
    return ok({
      ok: result.computable,
      ...saved,
      ask: result.missing.map((k) => MISSING_ZH[k] ?? k),
      hint:
        result.missing.length === 0
          ? '算全了：结果也放进了右栏「保本线」。'
          : '缺的几项照实问用户（别编行业平均）；问到了再算一次。右栏「保本线」写着这几项没算。',
    })
  }

  if (name === 'check_ad_landing') {
    const url = str(input.url)
    const texts = strs(input.texts, 12)
    if (url === undefined || !/^https?:\/\//iu.test(url) || texts.length === 0)
      return ok({ ok: false, problems: ['要给落地页网址（http 开头）和广告文案。'] })
    const ad_label = str(input.ad_label) ?? texts[0]?.slice(0, 40) ?? url
    const claims = extractAdClaims({ texts, selling_points: strs(input.selling_points, 5) })
    if (claims.length === 0)
      return ok({
        ok: true,
        items: [],
        message: '文案里没抽到价格、折扣、包邮；卖点短句也没给——没什么可核的。',
      })
    const page = (await options.landingPage?.(url).catch(() => undefined)) ?? {}
    const items = checkLanding({
      claims,
      ...(page.raw === undefined ? {} : { raw: page.raw }),
      ...(page.rendered === undefined ? {} : { rendered: page.rendered }),
    })
    const result: LandingCheckResult = {
      platform,
      url,
      ad_label,
      items,
      checked_at: options.now(),
    }
    const opened: NonNullable<LandingCheckResult['opened']> = []
    if (input.open_matters !== false && options.openMatter !== undefined) {
      const sent =
        svc.getState?.<Record<string, { at: string; matter_id: string }>>(
          ADS_SKILL_STATE.landingOpened,
        ) ?? {}
      for (const fix of ['page', 'ad'] as const) {
        const bad = items.filter((i) => i.fix === fix)
        if (bad.length === 0) continue
        const role_id = FIX_ROLE(fix, req.actor.role_id)
        const key = createHash('sha256')
          .update(`${fix}|${url}|${bad.map((b) => `${b.claim.kind}:${b.claim.value}`).join(',')}`)
          .digest('hex')
          .slice(0, 16)
        const prev = sent[key]
        if (
          prev !== undefined &&
          Date.parse(options.now()) - Date.parse(prev.at) < LANDING_QUIET_MS
        ) {
          opened.push({ fix, role_id, matter_id: prev.matter_id })
          continue
        }
        const title =
          fix === 'page'
            ? `落地页没接住广告的说法：${ad_label}`
            : `广告说法和落地页对不上，改广告：${ad_label}`
        const text = `${landingHandoffText(ad_label, url, bad)}\n${
          fix === 'page'
            ? '请把页面改到和广告一致（价格 / 优惠以店铺后台为准；不该写的告诉投放改广告）。'
            : '以落地页为准改广告文案（这条能改广告的出改动卡；只读的平台写成建议，去后台改）。'
        }`
        const out = await options.openMatter({ role_id, title, text }).catch(() => undefined)
        if (out === undefined) continue
        sent[key] = { at: options.now(), matter_id: out.matter_id }
        opened.push({ fix, role_id, matter_id: out.matter_id })
      }
      svc.setState?.(ADS_SKILL_STATE.landingOpened, sent)
    }
    if (opened.length > 0) result.opened = opened
    const history = svc.getState?.<LandingCheckResult[]>(ADS_SKILL_STATE.landing) ?? []
    svc.setState?.(
      ADS_SKILL_STATE.landing,
      [result, ...history.filter((h) => h.url !== url || h.ad_label !== ad_label)].slice(0, 20),
    )
    return ok({
      ok: true,
      ...result,
      ...(page.note === undefined ? {} : { page_note: page.note }),
      counts: {
        ok: items.filter((i) => i.verdict === 'ok').length,
        to_fix: items.filter((i) => i.fix !== undefined).length,
        unknown: items.filter((i) => i.verdict === 'unknown').length,
      },
    })
  }

  if (name === 'design_ads_experiment') {
    const metric = (str(input.metric) ?? 'ctr') as AdsExperimentMetric
    if (!['ctr', 'cvr', 'conv_per_impression'].includes(metric))
      return ok({ ok: false, problems: ['metric 只认 ctr / cvr / conv_per_impression。'] })
    const base =
      num(input.baseline_rate) === undefined || num(input.daily_units) === undefined
        ? baselineFrom(svc, platform, metric, str(input.campaign))
        : undefined
    const baseline_rate = num(input.baseline_rate) ?? base?.rate
    const daily_units = num(input.daily_units) ?? base?.daily
    const plan = designExperiment({
      hypothesis: str(input.hypothesis) ?? '',
      ...(str(input.change) === undefined ? {} : { change: str(input.change) as string }),
      metric,
      ...(str(input.unit) === undefined ? {} : { unit: str(input.unit) as AdsExperimentUnit }),
      ...(baseline_rate === undefined ? {} : { baseline_rate }),
      baseline_from: num(input.baseline_rate) !== undefined ? '你给的' : (base?.from ?? '没有'),
      ...(num(input.mde_rel_pct) === undefined
        ? {}
        : { mde_rel_pct: num(input.mde_rel_pct) as number }),
      ...(daily_units === undefined ? {} : { daily_units }),
      daily_from: num(input.daily_units) !== undefined ? '你给的' : (base?.from ?? '没有'),
      ...(num(input.arms) === undefined
        ? {}
        : { arms: Math.max(2, Math.floor(num(input.arms) as number)) }),
      ...(num(input.alpha) === undefined ? {} : { alpha: num(input.alpha) as number }),
      ...(num(input.power) === undefined ? {} : { power: num(input.power) as number }),
      ...(num(input.min_days) === undefined ? {} : { min_days: num(input.min_days) as number }),
      guardrails: guardrailsOf(input.guardrails),
    })
    let experiment_id: string | undefined
    if (plan.missing.length === 0 && input.record !== false && options.experiments !== undefined) {
      const saved = await options.experiments
        .add(req, { hypothesis: plan.hypothesis, change: plan.change, platform, plan })
        .catch(() => undefined)
      experiment_id = saved?.id
    }
    return ok({
      ok: plan.missing.length === 0,
      plan,
      ...(experiment_id === undefined ? {} : { experiment_id }),
      hint:
        plan.missing.length > 0
          ? '缺的几样照实问；最小提升与护栏的数让用户定（你先给建议）。'
          : '把样本量、天数、什么算赢原样告诉用户；跑满前别看结果、别提前收。',
    })
  }

  if (name === 'read_ads_experiment') {
    const id = str(input.experiment_id)
    const entry = id === undefined ? undefined : options.experiments?.get(req, id)
    if (entry === undefined)
      return ok({ ok: false, problems: [`没有这笔实验：${id ?? '（没给 experiment_id）'}`] })
    if (entry.plan === undefined)
      return ok({
        ok: false,
        problems: ['这笔实验当初没走 design_ads_experiment，没有样本量与护栏可照着判：先补设计。'],
      })
    const arms = armsOf(input.arms)
    if (arms.length < 2)
      return ok({ ok: false, problems: ['至少给两版的单位数与成功数（第一版是基准）。'] })
    const readout = readExperiment({ plan: entry.plan, arms })
    const payload: AdsExperimentReadoutPayload = {
      form: 'ads_experiment_readout',
      experiment_id: entry.id,
      platform,
      hypothesis: entry.hypothesis,
      change: entry.change,
      plan: entry.plan,
      arms,
      readout,
      recommended: readout.verdict,
    }
    const card = await options.readoutCard?.(req, payload).catch(() => undefined)
    return ok({
      ok: true,
      readout,
      recommended: EXPERIMENT_VERDICT_LABEL[readout.verdict],
      ...(card === undefined
        ? { message: '卡没出成：把结论照实告诉用户，请他在实验记忆里记一笔。' }
        : { card_id: card.id, message: '出了一张「保留 / 停 / 再测」卡，等用户选。' }),
    })
  }
  return undefined
}
