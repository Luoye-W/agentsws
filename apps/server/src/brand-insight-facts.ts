/**
 * WP346（决策 872）：品牌档案第二版那几格怎么写进档案——归一化、清空、「AI 建议」标记。
 *
 * 一条规矩：**AI 填的值由人确认**。品牌分析确认时写进来的那几格记在 `ai_suggested` 里
 * （界面挂「AI 建议」）；人在设置页改了那一格、或点了「对」，它就从 `ai_suggested` 里拿掉。
 * 下游照样读这些值（档案里有总比各处自己猜强），但界面一直提醒人这一格还没核过。
 *
 * 写入口有两个，走的是同一个函数：品牌分析确认 / 逐格采纳（服务端内部，带 `ai_suggested`）、
 * 设置页保存（HTTP，不带——人给的值一律算人的）。
 */
import {
  BRAND_COMPETITORS_MAX,
  BRAND_INSIGHT_FIELDS,
  BRAND_KEYWORDS_PER_GROUP_MAX,
  BRAND_SOURCES_PER_FIELD_MAX,
  type BrandAudience,
  type BrandCompetitor,
  type BrandInsightField,
  type BrandIntakeField,
  type BrandIntakeProfile,
  type BrandKeywords,
  type BrandSource,
  type WorkspaceProfile,
} from '@agentsws/contracts'

/** 第二版那几格的写入形状（不给 = 不改；空串 / `null` / 空数组 = 清空）。 */
export interface BrandInsightFactsInput {
  subcategory?: string | undefined
  positioning?: string | undefined
  price_band?: string | undefined
  audience?: BrandAudience | null | undefined
  keywords?: BrandKeywords | null | undefined
  competitors?: BrandCompetitor[] | undefined
  /** 品牌分析读的那个官网（设置页「重新分析一次」默认用它）。空串 = 清空。 */
  website?: string | undefined
  /**
   * 这一次写进来的格子里**哪几格是 AI 建议的**（服务端内部用：品牌分析确认 / 采纳时给）。
   * 没列的、这一次给了值的那几格 = 人给的（拿掉 AI 标）。
   */
  ai_suggested?: BrandInsightField[] | undefined
  /** 人点了「对」的那几格（值不变，只拿掉 AI 标）。 */
  confirm_fields?: BrandInsightField[] | undefined
}

export type BrandInsightFactKey =
  | 'subcategory'
  | 'positioning'
  | 'price_band'
  | 'audience'
  | 'keywords'
  | 'competitors'
  | 'website'
  | 'ai_suggested'

export const BRAND_INSIGHT_FACT_KEYS: readonly BrandInsightFactKey[] = [
  'subcategory',
  'positioning',
  'price_band',
  'audience',
  'keywords',
  'competitors',
  'website',
  'ai_suggested',
]

const line = (v: unknown, max: number): string | undefined => {
  if (typeof v !== 'string') return undefined
  const s = v.replace(/\s+/g, ' ').trim()
  return s === '' ? undefined : s.slice(0, max)
}

const words = (v: unknown, max: number, len: number): string[] => {
  const out: string[] = []
  for (const x of Array.isArray(v) ? v : []) {
    const s = line(x, len)
    if (s !== undefined && !out.some((o) => o.toLowerCase() === s.toLowerCase())) out.push(s)
  }
  return out.slice(0, max)
}

export function normalizeAudience(v: BrandAudience | null): BrandAudience | undefined {
  if (v === null || typeof v !== 'object') return undefined
  const buyers = line(v.buyers, 400)
  if (buyers === undefined) return undefined
  const payer = line(v.payer, 200)
  const concerns = words(v.concerns, 6, 120)
  return {
    buyers,
    ...(payer === undefined ? {} : { payer }),
    ...(concerns.length === 0 ? {} : { concerns }),
  }
}

export function normalizeKeywords(v: BrandKeywords | null): BrandKeywords | undefined {
  if (v === null || typeof v !== 'object') return undefined
  const k: BrandKeywords = {
    brand: words(v.brand, BRAND_KEYWORDS_PER_GROUP_MAX, 60),
    category: words(v.category, BRAND_KEYWORDS_PER_GROUP_MAX, 60),
    scenario: words(v.scenario, BRAND_KEYWORDS_PER_GROUP_MAX, 60),
  }
  return k.brand.length + k.category.length + k.scenario.length === 0 ? undefined : k
}

export function normalizeCompetitors(v: BrandCompetitor[]): BrandCompetitor[] | undefined {
  const out: BrandCompetitor[] = []
  for (const c of Array.isArray(v) ? v : []) {
    const name = line(c?.name, 80)
    if (name === undefined || out.some((x) => x.name.toLowerCase() === name.toLowerCase())) continue
    const reason = line(c.reason, 200) ?? ''
    const url = normalizeWebsite(c.url ?? '')
    // WP349：联网查到的来源跟着竞品进档案（设置页可点开）；只认 http(s)，最多几条
    const sources: BrandSource[] = []
    for (const x of Array.isArray(c.sources) ? c.sources : []) {
      const href = typeof x?.url === 'string' ? x.url.trim() : ''
      if (!/^https?:\/\//iu.test(href) || sources.some((y) => y.url === href)) continue
      const title = line(x.title, 160)
      sources.push({ url: href.slice(0, 500), ...(title === undefined ? {} : { title }) })
    }
    out.push({
      name,
      reason,
      ...(url === undefined ? {} : { url }),
      ...(sources.length === 0 ? {} : { sources: sources.slice(0, BRAND_SOURCES_PER_FIELD_MAX) }),
    })
  }
  return out.length === 0 ? undefined : out.slice(0, BRAND_COMPETITORS_MAX)
}

/** 网址：只认 http(s)；不带协议的补 https。 */
export function normalizeWebsite(v: string): string | undefined {
  const s = v.trim()
  if (s === '') return undefined
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : undefined
  } catch {
    return undefined
  }
}

type Facts = Pick<WorkspaceProfile, BrandInsightFactKey | 'category'>

/**
 * 下一份档案上的第二版几格：给了的按归一化结果（空 = 去掉），没给的沿用上一次；`ai_suggested`
 * 跟着「这一次谁给的值」走。`category` 的值由 `nextBrandFacts` 管，这里只管它的 AI 标。
 */
export function nextInsightFacts(
  previous: Partial<Facts> | undefined,
  input: BrandInsightFactsInput & { category?: string | undefined },
  category: string | undefined,
): Omit<Facts, 'category'> {
  const pick = <T, I>(given: I | undefined, old: T | undefined, norm: (v: I) => T | undefined) =>
    given === undefined ? old : norm(given)
  const out: Omit<Facts, 'category'> = {}
  const subcategory = pick(input.subcategory, previous?.subcategory, (v) => line(v, 80))
  const positioning = pick(input.positioning, previous?.positioning, (v) => line(v, 800))
  const price_band = pick(input.price_band, previous?.price_band, (v) => line(v, 60))
  const audience = pick(input.audience, previous?.audience, normalizeAudience)
  const keywords = pick(input.keywords, previous?.keywords, normalizeKeywords)
  const competitors = pick(input.competitors, previous?.competitors, normalizeCompetitors)
  const website = pick(input.website, previous?.website, normalizeWebsite)
  if (subcategory !== undefined) out.subcategory = subcategory
  if (positioning !== undefined) out.positioning = positioning
  if (price_band !== undefined) out.price_band = price_band
  if (audience !== undefined) out.audience = audience
  if (keywords !== undefined) out.keywords = keywords
  if (competitors !== undefined) out.competitors = competitors
  if (website !== undefined) out.website = website

  const ai = new Set(previous?.ai_suggested ?? [])
  const given = input as Record<string, unknown>
  for (const key of BRAND_INSIGHT_FIELDS) {
    if (given[key] === undefined) continue
    if (input.ai_suggested?.includes(key) === true) ai.add(key)
    else ai.delete(key)
  }
  for (const key of input.confirm_fields ?? []) ai.delete(key)
  const has = { ...out, category } as Record<string, unknown>
  const flagged = BRAND_INSIGHT_FIELDS.filter((k) => ai.has(k) && has[k] !== undefined)
  if (flagged.length > 0) out.ai_suggested = flagged
  return out
}

/**
 * 一次分析的结果 → 写档案用的第二版那几格 + `ai_suggested`。
 *
 * 哪一格算 AI 建议：模型那一层出的（`evidence[0].locator === 'model'`）、而且人没在卡上改过的。
 * 品类也按这条算（Amazon 面包屑读到的品类不是 AI 猜的，不挂标）。
 */
export function insightFactsFromIntake(profile: BrandIntakeProfile): BrandInsightFactsInput {
  const ai: BrandInsightField[] = []
  const isAi = (f: BrandIntakeField<unknown> | undefined): boolean =>
    f !== undefined && f.edited !== true && f.evidence[0]?.locator === 'model'
  const out: BrandInsightFactsInput = {}
  const text = (f: BrandIntakeField<unknown> | undefined): string | undefined =>
    typeof f?.value === 'string' && f.value.trim() !== '' ? f.value : undefined
  const subcategory = text(profile.subcategory)
  const positioning = text(profile.positioning)
  const price_band = text(profile.price_band)
  if (subcategory !== undefined) out.subcategory = subcategory
  if (positioning !== undefined) out.positioning = positioning
  if (price_band !== undefined) out.price_band = price_band
  if (profile.audience !== undefined) out.audience = profile.audience.value
  if (profile.keywords !== undefined) out.keywords = profile.keywords.value
  if (profile.competitors !== undefined) out.competitors = profile.competitors.value
  for (const key of BRAND_INSIGHT_FIELDS)
    if (isAi(profile[key] as BrandIntakeField<unknown> | undefined)) ai.push(key)
  if (ai.length > 0) out.ai_suggested = ai
  return out
}
