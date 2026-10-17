/**
 * WP380：**官方事实表**——描述准确度与对外说法一致性都拿它对。
 *
 * 从品牌档案跟过来（名称、品类、价格带、卖点 / 定位、市场），人可以在这里改（人改的不被档案盖）。
 * 每一格带日期；档案里改了，旧说法挪进 `previous`（带截止日），AI 或网页说的是旧说法 → 「过时」。
 *
 * 纯函数：今天是哪天由调用方给。
 */
import type { GeoFactKey, GeoFactsPatch, GeoOfficialFact } from '@agentsws/contracts'
import { GEO_FACT_KEYS } from '@agentsws/contracts'

/** 以前的说法最多留几条。 */
export const GEO_FACT_HISTORY_MAX = 5

/** 品牌档案里和官方事实有关的几格（都可选）。 */
export interface FactProfile {
  name: string
  category?: string | undefined
  subcategory?: string | undefined
  price_band?: string | undefined
  positioning?: string | undefined
  one_liner?: string | undefined
  markets?: readonly string[] | undefined
}

const clean = (v: string | undefined, max = 300): string | undefined => {
  const t = (v ?? '').replace(/\s+/g, ' ').trim()
  return t === '' ? undefined : t.slice(0, max)
}

/** 档案 → 每一格的现值（没有的不出现）。品类带上子品类；卖点读定位，没有就读一句话介绍。 */
export function factValuesOf(p: FactProfile): Partial<Record<GeoFactKey, string>> {
  const category = clean(p.category, 80)
  const sub = clean(p.subcategory, 80)
  const markets = [...new Set((p.markets ?? []).map((m) => m.trim().toUpperCase()))].filter(
    (m) => m !== '',
  )
  const out: Partial<Record<GeoFactKey, string>> = {}
  const name = clean(p.name, 120)
  if (name !== undefined) out.name = name
  if (category !== undefined)
    out.category = sub === undefined || sub === category ? category : `${category}（${sub}）`
  const price = clean(p.price_band, 80)
  if (price !== undefined) out.price = price
  const points = clean(p.positioning) ?? clean(p.one_liner)
  if (points !== undefined) out.selling_points = points
  if (markets.length > 0) out.markets = markets.join(', ')
  return out
}

const roll = (
  f: GeoOfficialFact,
  value: string,
  today: string,
  source: GeoOfficialFact['source'],
) =>
  ({
    key: f.key,
    value,
    as_of: today,
    source,
    previous: [{ value: f.value, until: today }, ...(f.previous ?? [])].slice(
      0,
      GEO_FACT_HISTORY_MAX,
    ),
  }) satisfies GeoOfficialFact

/**
 * 跟档案同步：档案里变了的格子换新值、旧值进 `previous`；人改过的（`source: 'human'`）不动；
 * 档案里没了的格子（人也没改过）去掉。回新的一份（按 {@link GEO_FACT_KEYS} 排）。
 */
export function syncFacts(
  current: readonly GeoOfficialFact[],
  values: Partial<Record<GeoFactKey, string>>,
  today: string,
): GeoOfficialFact[] {
  const by = new Map(current.map((f) => [f.key, f]))
  const out: GeoOfficialFact[] = []
  for (const key of GEO_FACT_KEYS) {
    const cur = by.get(key)
    const next = values[key]
    if (cur?.source === 'human') out.push(cur)
    else if (next === undefined) continue
    else if (cur === undefined) out.push({ key, value: next, as_of: today, source: 'profile' })
    else if (cur.value === next) out.push(cur)
    else out.push(roll(cur, next, today, 'profile'))
  }
  return out
}

/** 人改：给了值 = 用人的（变了才记一条旧说法）；空值 = 退回跟档案走（下一次同步按档案的来）。 */
export function patchFacts(
  current: readonly GeoOfficialFact[],
  patch: GeoFactsPatch,
  today: string,
): GeoOfficialFact[] {
  const by = new Map(current.map((f) => [f.key, f]))
  for (const { key, value } of patch.facts) {
    if (!GEO_FACT_KEYS.includes(key)) continue
    const v = clean(value)
    const cur = by.get(key)
    if (v === undefined) {
      if (cur !== undefined) by.set(key, { ...cur, source: 'profile' })
      continue
    }
    if (cur === undefined) by.set(key, { key, value: v, as_of: today, source: 'human' })
    else if (cur.value === v) by.set(key, { ...cur, source: 'human' })
    else by.set(key, roll(cur, v, today, 'human'))
  }
  return GEO_FACT_KEYS.flatMap((k) => {
    const f = by.get(k)
    return f === undefined ? [] : [f]
  })
}

/** 官方事实表是哪天的（最新那格的日期；空表不写）。 */
export function factsAsOf(facts: readonly GeoOfficialFact[]): string | undefined {
  return facts
    .map((f) => f.as_of)
    .sort()
    .at(-1)
}

/** 价格带里的数（「$20–$80」→ [20, 80]；读不出回 `undefined`）。 */
export function priceRange(band: string): [number, number] | undefined {
  const nums = [...band.replace(/,/g, '').matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0]))
  if (nums.length === 0) return undefined
  return [Math.min(...nums), Math.max(...nums)]
}

/**
 * 一个说到的价是不是**以前的官方价**：说到的数都落在某个旧价格带里（宽 5%）、却不在现在的价格带里。
 * 价格带读不出数回 `false`。
 */
export function isOldPrice(said: string, fact: GeoOfficialFact): boolean {
  const nums = [...said.replace(/,/g, '').matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0]))
  if (nums.length === 0) return false
  const within = (band: string) => {
    const r = priceRange(band)
    return r !== undefined && nums.every((n) => n >= r[0] * 0.95 && n <= r[1] * 1.05)
  }
  return !within(fact.value) && (fact.previous ?? []).some((p) => within(p.value))
}
