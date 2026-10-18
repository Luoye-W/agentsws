/**
 * WP393（docs/104 C5 / C8）：方案卡上 AI 给的两样建议——**哪几种变化算要紧**（按品类）、**竞品哪款对标你哪款**。
 *
 * 先问一次模型（只回 JSON、逐格验形状）；没模型 / 回得不对就用规则版（规则脑）。规则版给的只是起步值，
 * 卡上写清「按什么给的」，用户点「就这样 / 改一下」才算数（C5：不替用户定运营规矩）。
 */
import type {
  CatalogSnapshotRow,
  CompetitorImportanceRules,
  CompetitorProductPair,
  OwnShopProduct,
} from '@agentsws/contracts'
import { formatMoney, productsOfRows, suggestPairs } from '@agentsws/social-core'

export interface RulesSuggestion {
  rules: CompetitorImportanceRules
  /** 卡上那一句为什么。 */
  why: string
  by: 'model' | 'rules'
}

const median = (xs: number[]): number | undefined => {
  if (xs.length === 0) return undefined
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

const jsonIn = (text: string | undefined, open: '{' | '['): unknown => {
  if (text === undefined) return undefined
  const close = open === '{' ? '}' : ']'
  const a = text.indexOf(open)
  const b = text.lastIndexOf(close)
  if (a < 0 || b <= a) return undefined
  try {
    return JSON.parse(text.slice(a, b + 1)) as unknown
  } catch {
    return undefined
  }
}

/** 规则版：按品类与你店里的价位给起步值（客单价越高，降一成越要紧）。 */
export function ruleSuggestion(input: {
  category?: string
  own: readonly OwnShopProduct[]
  connected: boolean
}): RulesSuggestion {
  const prices = input.own.map((p) => p.price).filter((n): n is number => n !== undefined)
  const mid = median(prices)
  const pct = mid === undefined ? 10 : mid >= 300 ? 10 : mid >= 60 ? 15 : 20
  const what =
    input.category === undefined || input.category === '' ? '你的品类' : `「${input.category}」`
  const level =
    mid === undefined
      ? ''
      : `，你店里一件中位 ${formatMoney(mid, input.own.find((p) => p.currency !== undefined)?.currency)}`
  return {
    rules: {
      price_drop_pct: pct,
      cheaper_than_own: input.connected,
      new_products: true,
      discounts: true,
      stock: false,
      removed: false,
    },
    why: `按${what}给的起步值${level}：降 ${pct}% 以上、上新、开始打折算要紧；断货补货太碎先不算`,
    by: 'rules',
  }
}

const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined)

/** 让模型按品类给一份「什么算要紧」；回得不对回 `undefined`（用规则版）。 */
export async function modelSuggestion(
  ask: ((prompt: string) => Promise<string | undefined>) | undefined,
  input: { category?: string; own: readonly OwnShopProduct[]; connected: boolean },
): Promise<RulesSuggestion | undefined> {
  if (ask === undefined) return undefined
  const sample = input.own
    .slice(0, 8)
    .map((p) => `${p.title}${p.price === undefined ? '' : ` ${formatMoney(p.price, p.currency)}`}`)
    .join('；')
  const prompt = [
    '你在帮一个跨境品牌盯竞品独立站的上新和价格。按它的品类，建议「哪几种变化算要紧、值得进每天简报」。',
    `品类：${input.category ?? '不知道'}`,
    sample === '' ? '' : `它店里的几件商品：${sample}`,
    input.connected ? '它连着自家店，能和竞品比价。' : '它没连自家店，比不了价。',
    '只回一个 JSON：{"price_drop_pct": 降价幅度到多少算要紧（1–50 的整数）, "cheaper_than_own": 降完比它便宜算不算要紧, ' +
      '"new_products": 上新算不算, "discounts": 开始打折算不算, "stock": 断货 / 补货算不算, "removed": 下架算不算, "why": "一句中文理由，20 字以内"}',
  ]
    .filter((x) => x !== '')
    .join('\n')
  const got = jsonIn(await ask(prompt).catch(() => undefined), '{') as
    | Record<string, unknown>
    | undefined
  if (got === undefined || typeof got !== 'object') return undefined
  const pct = typeof got.price_drop_pct === 'number' ? Math.round(got.price_drop_pct) : undefined
  if (pct === undefined || pct < 1 || pct > 50) return undefined
  const why =
    typeof got.why === 'string' && got.why.trim() !== '' ? got.why.trim().slice(0, 80) : undefined
  const rules: CompetitorImportanceRules = { price_drop_pct: pct }
  for (const k of ['cheaper_than_own', 'new_products', 'discounts', 'stock', 'removed'] as const) {
    const b = bool(got[k])
    if (b !== undefined) rules[k] = b
  }
  if (!input.connected) rules.cheaper_than_own = false
  return { rules, why: why ?? 'AI 按你的品类给的建议', by: 'model' }
}

/** 竞品那几家（每家的快照行）。 */
export interface RivalRows {
  competitor_id: string
  name: string
  rows: readonly CatalogSnapshotRow[]
}

/** 给模型看的候选：每家只挑价位离你家商品最近的几款（几百件全塞进去太贵也太乱）。 */
const nearest = (rival: RivalRows, own: readonly OwnShopProduct[], max: number) => {
  const prices = own.map((p) => p.price).filter((n): n is number => n !== undefined)
  return productsOfRows(rival.rows)
    .map((p) => ({
      p,
      d:
        p.price === undefined || prices.length === 0
          ? Number.POSITIVE_INFINITY
          : Math.min(...prices.map((x) => Math.abs(x - (p.price as number)) / Math.max(x, 1))),
    }))
    .sort((a, b) => a.d - b.d)
    .slice(0, max)
    .map((x) => x.p)
}

/**
 * 对标款：先问模型（每家挑价位最近的 30 款给它看），回得对就用；不然用规则版（标题词 + 价位）。
 * 人改过的（`by: 'user'`）原样留着。
 */
export async function suggestProductPairs(
  ask: ((prompt: string) => Promise<string | undefined>) | undefined,
  input: {
    rivals: readonly RivalRows[]
    own: readonly OwnShopProduct[]
    own_brand: string
    keep: readonly CompetitorProductPair[]
  },
): Promise<{ pairs: CompetitorProductPair[]; by: 'model' | 'rules' }> {
  const rulePairs = () => suggestPairs(input)
  if (ask === undefined || input.own.length === 0 || input.rivals.length === 0)
    return { pairs: rulePairs(), by: 'rules' }
  const candidates = input.rivals.map((r) => ({ r, items: nearest(r, input.own, 30) }))
  const prompt = [
    `下面是品牌「${input.own_brand}」自家店里的商品，和几家竞品独立站的商品。给自家每一款，在每家竞品里挑**一款**最像的对标款`,
    '（同一类东西、定位和价位接近；没有像的就不配）。只回一个 JSON 数组：[{"own": 自家 key, "competitor": 竞品 id, "product": 竞品商品 key}]。',
    '自家：',
    ...input.own
      .slice(0, 40)
      .map(
        (p) =>
          `- key=${p.key} | ${p.title}${p.price === undefined ? '' : ` | ${formatMoney(p.price, p.currency)}`}`,
      ),
    ...candidates.flatMap(({ r, items }) => [
      `竞品 ${r.name}（id=${r.competitor_id}）：`,
      ...items.map(
        (p) =>
          `- key=${p.product_key} | ${p.title}${p.price === undefined ? '' : ` | ${formatMoney(p.price, p.currency)}`}`,
      ),
    ]),
  ].join('\n')
  const got = jsonIn(await ask(prompt).catch(() => undefined), '[')
  if (!Array.isArray(got)) return { pairs: rulePairs(), by: 'rules' }
  const ownBy = new Map(input.own.map((p) => [p.key, p]))
  const kept = input.keep.filter((p) => p.by === 'user')
  const taken = new Set(kept.map((p) => `${p.competitor_id}|${p.product_key}`))
  const out: CompetitorProductPair[] = [...kept]
  for (const raw of got) {
    const x = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
    const mine = typeof x.own === 'string' ? ownBy.get(x.own) : undefined
    const c = candidates.find(({ r }) => r.competitor_id === x.competitor)
    const p = c?.items.find((i) => i.product_key === String(x.product))
    if (mine === undefined || c === undefined || p === undefined) continue
    const k = `${p.competitor_id}|${p.product_key}`
    if (taken.has(k)) continue
    taken.add(k)
    out.push({
      competitor_id: p.competitor_id,
      product_key: p.product_key,
      title: p.title,
      own_key: mine.key,
      own_title: mine.title,
      by: 'ai',
    })
  }
  return out.length > kept.length
    ? { pairs: out, by: 'model' }
    : { pairs: rulePairs(), by: 'rules' }
}
