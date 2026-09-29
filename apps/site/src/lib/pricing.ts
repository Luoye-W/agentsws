/**
 * 价格页的价目：**构建时**从云上公开接口 `GET /v1/pricing` 取一份（WP165，不要令牌）。
 *
 * - 取到了 → 用它（`source: 'cloud'`），页上写「构建于 X 日」；
 * - 取不到（断网、超时、回包不像价目）→ 用仓库里那份固定样例
 *   （`packages/stand-ins/src/cloud/pricing-sample.ts`），页上标「样例 · 以控制台为准」；
 * - 单价一个都不写死在官网代码里（docs/83 §2：价格是生意，只放云上）。
 */
import type { PricingCatalog, PricingEntry, TopupTier } from '@agentsws/contracts'

export type PricingSource = 'cloud' | 'sample'

export interface SitePricing {
  source: PricingSource
  /** 取到的那一刻（样例时是样例自己的 `as_of`）。 */
  as_of: string
  catalog: PricingCatalog
}

/** 回包像不像一份价目（只查骨架；坏的一律当没取到）。与 contracts 的 `isPricingCatalog` 同一套判断。 */
export function looksLikeCatalog(value: unknown): value is PricingCatalog {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Partial<PricingCatalog>
  const p = v.pricing
  const t = v.topup_tiers
  return (
    typeof p === 'object' &&
    p !== null &&
    Array.isArray(p.entries) &&
    typeof p.as_of === 'string' &&
    typeof t === 'object' &&
    t !== null &&
    Array.isArray(t.tiers)
  )
}

export interface LoadPricingOptions {
  url: string
  sample: PricingCatalog
  fetchImpl?: typeof fetch
  timeoutMs?: number
  /** 强制用样例（离线构建、测试）。 */
  offline?: boolean
}

export async function loadPricing(o: LoadPricingOptions): Promise<SitePricing> {
  const fallback: SitePricing = {
    source: 'sample',
    as_of: o.sample.pricing.as_of,
    catalog: o.sample,
  }
  if (o.offline === true) return fallback
  const f = o.fetchImpl ?? fetch
  try {
    const res = await f(o.url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(o.timeoutMs ?? 8000),
    })
    if (!res.ok) return fallback
    const body = (await res.json()) as { data?: unknown }
    const data = body?.data
    if (!looksLikeCatalog(data)) return fallback
    return { source: 'cloud', as_of: new Date().toISOString().slice(0, 10), catalog: data }
  } catch {
    return fallback
  }
}

export type Block = 'data' | 'ai' | 'service'

/** 一条能力归哪一块（与 contracts 的 `pricingBlockOf` 同一套兜底：先看 `block`，没有按前缀）。 */
export function blockOf(e: Pick<PricingEntry, 'capability' | 'block'>): Block {
  const b = e.block as string | undefined
  if (b === 'ai' || b === 'data') return b
  if (b === 'service' || b === 'kol_service') return 'service'
  if (e.capability.startsWith('ai.')) return 'ai'
  if (e.capability.includes('.service.')) return 'service'
  return 'data'
}

export function entriesOf(p: SitePricing, block: Block): PricingEntry[] {
  return p.catalog.pricing.entries.filter((e) => blockOf(e) === block)
}

export function tiersOf(p: SitePricing): TopupTier[] {
  return p.catalog.topup_tiers.tiers.filter(
    (t) => (t as { available?: boolean }).available !== false,
  )
}

/** 积分数：最多四位小数，去掉尾零（0.3 → 0.3，0.0015 → 0.0015，30 → 30）。 */
export function formatCredits(n: number): string {
  return String(Math.round(n * 10_000) / 10_000)
}

/** 单位的人话。认不出的原样显示。 */
export function unitLabel(unit: string, lang: 'zh' | 'en'): string {
  const zh: Record<string, string> = {
    '1k_tokens': '每千 token',
    call: '每次',
    page: '每页',
    minute: '每分钟',
    image: '每张',
    item: '每条',
    month: '每月',
    seat_month: '每座位每月',
  }
  const en: Record<string, string> = {
    '1k_tokens': 'per 1k tokens',
    call: 'per call',
    page: 'per page',
    minute: 'per minute',
    image: 'per image',
    item: 'per item',
    month: 'per month',
    seat_month: 'per seat / month',
  }
  return (lang === 'zh' ? zh : en)[unit] ?? unit
}

/** 标签里括号那一截（「（按次）」）在表里已经有单位列，去掉免得说两遍。 */
export function entryLabel(
  e: Pick<PricingEntry, 'label_zh' | 'label_en'>,
  lang: 'zh' | 'en',
): string {
  const raw = lang === 'zh' ? e.label_zh : e.label_en
  return raw.replace(/\s*[（(][^（）()]*[）)]\s*$/u, '')
}
