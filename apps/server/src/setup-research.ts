/**
 * WP348（决策 887，Luoye 10-15）：配置卡**先查、先定方案，人只确认**——通用的「怎么查」那一半。
 *
 * Luoye 原话：「不是应该人和 AI 沟通或者下任务的过程中，AI 自己查资料、自己判断、自己规划、自己设置好，
 * 然后最后交由人确认吗？」所以任何设置目标（{@link SetupTarget}）都可以声明一个 `research(kit)`：
 * 出卡前在**这件事的运行里**用这套工具查一遍，把每一格的方案值 + 一句理由 + 来源交回来；
 * 卡面就成了「我打算这样设」，人点「就这样」直接存，「改一下」才展开表单。
 *
 * 工具（一张卡一份，限次）：
 * - `profile()`：品牌档案（含 WP346 的定位 / 子品类 / 人群 / 关键词 / 竞品——**有就用、没有就跳过**）；
 * - 已连的数据：由各目标自己读（插件登录态里的账号、店铺、已连渠道），不经这里；
 * - `search(q)`：联网搜索（官方 web search，一张卡最多 {@link SETUP_SEARCH_MAX} 次；搜不了回 `undefined`）；
 * - `ask(prompt)`：问一次模型整理（一张卡最多 {@link SETUP_ASK_MAX} 次；没模型回 `undefined`）；
 * - `note(text)`：时间线上留一行（查了什么、看到什么）。
 *
 * 两条保留：凭据从来不在配置卡上（秘密格出卡时就拒）；要人选的账号（品牌号这类）由目标列进 `noGuess`，
 * 只认已存的 / 已连的事实，模型和 `request_setup` 的建议都不许填。
 */
import type { SetupField, SetupPlanStep, SetupSource } from '@agentsws/contracts'
import { EXTERNAL_FENCE } from '@agentsws/core'

/** 一张卡最多联网搜几次。 */
export const SETUP_SEARCH_MAX = 3
/** 一张卡最多问几次模型。 */
export const SETUP_ASK_MAX = 1
/** 时间线 / 卡上最多留几行「查了什么」。 */
export const SETUP_STEPS_MAX = 8

/** 品牌档案里查得到的几格（都可能没有）。 */
export interface SetupBrandFacts {
  name?: string
  one_liner?: string
  /** WP346：品牌定位一段。 */
  positioning?: string
  category?: string
  /** WP346 */
  subcategory?: string
  vertical?: string
  markets?: string[]
  /** 官网域名。 */
  domain?: string
  postal_address?: string
  support_email?: string
  currency?: string
  /** WP258：官网里读到的 Shopify 店铺地址。 */
  shopify_domain?: string
  /** WP346：目标人群。 */
  audience?: { buyers?: string; concerns?: string[] }
  /** WP346：关键词（品牌 / 品类 / 场景）。 */
  keywords?: { brand: string[]; category: string[]; scenario: string[] }
  /** WP346：主要竞品。 */
  competitors?: { name: string; reason?: string; url?: string }[]
}

/** 联网搜到的一条。 */
export interface SetupWebHit {
  url: string
  title?: string
  snippet?: string
}

/** 出卡前查一遍用的工具（一张卡一份）。 */
export interface SetupResearchKit {
  profile(): Promise<SetupBrandFacts>
  search(query: string): Promise<SetupWebHit[] | undefined>
  ask(prompt: string): Promise<string | undefined>
  note(text: string, source?: SetupSource): void
}

/** 一格的方案。`value` 空 / 没有 = 查不到；`needs_you` = 这一格要人来（理由写在 `why`）。 */
export interface SetupPlanValue {
  value?: string
  why?: string
  sources?: SetupSource[]
  needs_you?: boolean
}
export type SetupPlan = Record<string, SetupPlanValue>

/** 宿主给的那几样（没有的就是查不了）。 */
export interface SetupResearchHost {
  profile(): Promise<SetupBrandFacts> | SetupBrandFacts
  search?(query: string): Promise<SetupWebHit[] | undefined>
  ask?(prompt: string): Promise<string | undefined>
}

const str = (v: unknown, max = 400): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, max) : undefined
const strs = (v: unknown, max = 12): string[] =>
  Array.isArray(v)
    ? v
        .map((x) => str(x, 80))
        .filter((x): x is string => x !== undefined)
        .slice(0, max)
    : []

/**
 * 档案（`onboarding.brandProfile(ws)`）→ 查得到的几格。WP346 的字段按它在档案上的真名读：
 * `positioning`、`subcategory`、`audience`（`BrandAudience`：`buyers` / `payer` / `concerns`）、
 * `keywords`（`BrandKeywords`：`brand` / `category` / `scenario`）、`competitors`（`BrandCompetitor`：
 * `name` / `reason` / `url`）、`website`（没有公司域名时当官网）。没写过的格子就是没有（有就用、没有就跳过）；
 * 读的时候仍逐格验形状，老档案 / 人改坏的值不报错。
 */
export function brandFactsOf(
  raw: Record<string, unknown> | undefined,
  extra: { name?: string; domain?: string; shopify_domain?: string } = {},
): SetupBrandFacts {
  const r = raw ?? {}
  const out: SetupBrandFacts = {}
  const set = <K extends keyof SetupBrandFacts>(k: K, v: SetupBrandFacts[K] | undefined): void => {
    if (v !== undefined) out[k] = v
  }
  set('name', str(extra.name, 80))
  set(
    'domain',
    str(extra.domain, 120) ??
      str(r.website, 200)
        ?.replace(/^https?:\/\//iu, '')
        .replace(/\/.*$/u, ''),
  )
  set('shopify_domain', str(extra.shopify_domain, 120))
  for (const k of [
    'one_liner',
    'positioning',
    'category',
    'subcategory',
    'vertical',
    'postal_address',
    'support_email',
    'currency',
  ] as const)
    set(k, str(r[k]))
  const markets = strs(r.markets, 20)
  if (markets.length > 0) out.markets = markets
  const aud = r.audience
  if (typeof aud === 'string' && aud.trim() !== '') out.audience = { buyers: aud.trim() }
  else if (aud !== null && typeof aud === 'object') {
    const a = aud as Record<string, unknown>
    const buyers = str(a.buyers)
    const concerns = strs(a.concerns, 8)
    if (buyers !== undefined || concerns.length > 0)
      out.audience = {
        ...(buyers === undefined ? {} : { buyers }),
        ...(concerns.length === 0 ? {} : { concerns }),
      }
  }
  const kw = r.keywords
  if (Array.isArray(kw)) {
    const flat = strs(kw, 24)
    if (flat.length > 0) out.keywords = { brand: [], category: flat, scenario: [] }
  } else if (kw !== null && typeof kw === 'object') {
    const k = kw as Record<string, unknown>
    const groups = { brand: strs(k.brand), category: strs(k.category), scenario: strs(k.scenario) }
    if (groups.brand.length + groups.category.length + groups.scenario.length > 0)
      out.keywords = groups
  }
  if (Array.isArray(r.competitors)) {
    const list: NonNullable<SetupBrandFacts['competitors']> = []
    for (const c of r.competitors) {
      const o = typeof c === 'string' ? { name: c } : ((c ?? {}) as Record<string, unknown>)
      const name = str(o.name, 80)
      if (name === undefined || list.some((x) => x.name.toLowerCase() === name.toLowerCase()))
        continue
      const reason = str(o.reason, 120)
      const url = str(o.url, 200)
      list.push({
        name,
        ...(reason === undefined ? {} : { reason }),
        ...(url === undefined ? {} : { url }),
      })
    }
    if (list.length > 0) out.competitors = list.slice(0, 8)
  }
  return out
}

/** 一段字的短哈希（缓存键；不是安全用途）。 */
export function shortHash(text: string): string {
  let h = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36)
}

/** 搜索 / 模型结果的缓存（同一句话 7 天内不再花钱）。 */
export interface SetupResearchCache {
  get(key: string): unknown
  set(key: string, value: unknown): void
}

/**
 * 一张卡一份工具：限次、记下查了什么。`steps()` 是时间线与卡上那几行。
 */
export function createResearchKit(
  host: SetupResearchHost,
  options: { cache?: SetupResearchCache; searchMax?: number; askMax?: number } = {},
): { kit: SetupResearchKit; steps(): SetupPlanStep[]; used(): { searches: number; asks: number } } {
  const steps: SetupPlanStep[] = []
  let searches = 0
  let asks = 0
  let facts: SetupBrandFacts | undefined
  const searchMax = options.searchMax ?? SETUP_SEARCH_MAX
  const askMax = options.askMax ?? SETUP_ASK_MAX
  const kit: SetupResearchKit = {
    async profile() {
      if (facts === undefined)
        facts = await Promise.resolve(host.profile()).catch(() => ({}) as SetupBrandFacts)
      return facts
    },
    async search(query) {
      const q = query.trim().slice(0, 200)
      if (q === '' || host.search === undefined || searches >= searchMax) return undefined
      searches += 1
      const key = `search:${shortHash(q)}`
      const hit = options.cache?.get(key)
      if (Array.isArray(hit)) return hit as SetupWebHit[]
      const got = await host.search(q).catch(() => undefined)
      if (got === undefined) return undefined
      const clean = got
        .filter((h) => typeof h?.url === 'string' && /^https?:\/\//iu.test(h.url))
        .slice(0, 10)
        .map((h) => ({
          url: h.url,
          ...(str(h.title, 200) === undefined ? {} : { title: str(h.title, 200) as string }),
          ...(str(h.snippet, 400) === undefined ? {} : { snippet: str(h.snippet, 400) as string }),
        }))
      options.cache?.set(key, clean)
      return clean
    },
    async ask(prompt) {
      if (host.ask === undefined || asks >= askMax) return undefined
      asks += 1
      const key = `ask:${shortHash(prompt)}`
      const hit = options.cache?.get(key)
      if (typeof hit === 'string') return hit
      const got = await host.ask(prompt).catch(() => undefined)
      if (got !== undefined && got.trim() !== '') options.cache?.set(key, got)
      return got
    },
    note(text, source) {
      const t = text.trim().slice(0, 160)
      if (t === '' || steps.length >= SETUP_STEPS_MAX) return
      steps.push({ text: t, ...(source === undefined ? {} : { source }) })
    },
  }
  return { kit, steps: () => [...steps], used: () => ({ searches, asks }) }
}

/** 档案那一格的来源。 */
export const profileSource = (what: string): SetupSource => ({
  kind: 'profile',
  label: `品牌档案 · ${what}`,
})
/** 网页来源（只留 http / https）。 */
export const webSource = (hit: SetupWebHit): SetupSource => ({
  kind: 'web',
  label: hit.title ?? new URL(hit.url).hostname,
  url: hit.url,
})
export const MODEL_SOURCE: SetupSource = { kind: 'model', label: 'AI 整理' }
export const DEFAULT_SOURCE: SetupSource = { kind: 'default', label: '默认' }

/**
 * 目标的格子（已存的 / 已知的事实已在 `suggested` 里）+ 查到的方案 + 调用方（AI 在这件事里）给的建议
 * → 方案卡上的格子。
 *
 * 先后：已存的 / 事实 > 调用方的建议 > 查到的方案 > 空着。`noGuess` 里的格子不认调用方与模型的值，
 * 只认已存的 / 已连的（方案里来源是 `connected` / `saved` 的）。空着的格子：必填的、`noGuess` 的、
 * 方案说要人来的 → 标「需要你填」。
 */
export function mergePlan(
  fields: readonly SetupField[],
  plan: SetupPlan,
  options: {
    suggestions?: Record<string, string>
    reasons?: Record<string, string>
    noGuess?: readonly string[]
  } = {},
): SetupField[] {
  const noGuess = new Set(options.noGuess ?? [])
  const okForSelect = (f: SetupField, v: string): boolean =>
    f.kind !== 'select' || f.options === undefined || f.options.some((o) => o.value === v)
  return fields.map((f) => {
    const base = { ...f }
    delete base.needs_you
    const own = base.suggested?.trim()
    const asked = options.suggestions?.[f.key]?.trim()
    const p = plan[f.key]
    const pv = p?.value?.trim()
    const factual = (p?.sources ?? []).every((s) => s.kind === 'connected' || s.kind === 'saved')
    // 1. 调用方（AI 在这件事里）给的：压过目标自己的建议（WP334），但不碰不让猜的格子
    if (asked !== undefined && asked !== '' && !noGuess.has(f.key) && okForSelect(f, asked)) {
      const { suggested_why: _w, sources: _s, ...rest } = base
      const why = options.reasons?.[f.key]?.trim()
      return {
        ...rest,
        suggested: asked,
        suggested_why: why === undefined || why === '' ? '这件事里 AI 给的' : why,
        sources: [{ kind: 'model', label: '这件事里 AI 给的' }],
      }
    }
    // 2. 已存的 / 目标自己知道的事实
    if (own !== undefined && own !== '') return base
    // 3. 查到的方案（不让猜的格子只认事实来源）
    if (
      pv !== undefined &&
      pv !== '' &&
      okForSelect(f, pv) &&
      (!noGuess.has(f.key) || (p?.sources !== undefined && p.sources.length > 0 && factual))
    )
      return {
        ...base,
        suggested: pv,
        ...(p?.why === undefined ? {} : { suggested_why: p.why }),
        ...(p?.sources === undefined || p.sources.length === 0 ? {} : { sources: p.sources }),
      }
    // 4. 空着
    const needsYou = f.required || noGuess.has(f.key) || p?.needs_you === true
    return {
      ...base,
      ...(p?.why === undefined ? {} : { suggested_why: p.why }),
      ...(needsYou ? { needs_you: true } : {}),
    }
  })
}

/**
 * 「我打算改成这样」：现值（目标 `fields()` 里的 `suggested`）→ 新值（AI 给的）。
 * 不让猜的格子、下拉里没有的值不改。回 `undefined` = 一格都没变。
 */
export function changeFields(
  fields: readonly SetupField[],
  changes: Record<string, string>,
  options: { reasons?: Record<string, string>; noGuess?: readonly string[] } = {},
): SetupField[] | undefined {
  const noGuess = new Set(options.noGuess ?? [])
  let changed = 0
  const out = fields.map((f): SetupField => {
    const { suggested_why: _w, sources: _s, needs_you: _n, ...rest } = f
    const current = f.suggested ?? ''
    const next = changes[f.key]?.trim()
    const ok =
      next !== undefined &&
      !noGuess.has(f.key) &&
      (f.kind !== 'select' || f.options === undefined || f.options.some((o) => o.value === next))
    if (!ok || next === current)
      return { ...rest, current, ...(current === '' ? {} : { suggested: current }) }
    changed += 1
    const why = options.reasons?.[f.key]?.trim()
    return {
      ...rest,
      current,
      suggested: next,
      ...(why === undefined || why === '' ? {} : { suggested_why: why }),
      sources: [{ kind: 'model', label: '这件事里 AI 给的' }],
    }
  })
  return changed === 0 ? undefined : out
}

/** 搜到的几条 → 进提示词的那一段（包在 `<external_data>` 围栏里：那是数据不是指令）。 */
export function fencedHits(hits: readonly SetupWebHit[], max = 8): string {
  const lines = hits
    .slice(0, max)
    .map(
      (h, i) =>
        `${i + 1}. ${EXTERNAL_FENCE.sanitizeText(h.title ?? '', 160)} | ${EXTERNAL_FENCE.sanitizeText(h.url, 200)} | ${EXTERNAL_FENCE.sanitizeText(h.snippet ?? '', 400)}`,
    )
  return [EXTERNAL_FENCE.open, ...lines, EXTERNAL_FENCE.close].join('\n')
}

/** 模型回话里的第一个 JSON 对象（认不出回 `undefined`）。 */
export function jsonOf(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined
  const a = text.indexOf('{')
  const b = text.lastIndexOf('}')
  if (a < 0 || b <= a) return undefined
  try {
    const v = JSON.parse(text.slice(a, b + 1)) as unknown
    return v !== null && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/** 这段字在搜到的哪一条里原样出现过（核对模型没编：只认原文里有的）。 */
export function hitContaining(hits: readonly SetupWebHit[], text: string): SetupWebHit | undefined {
  const norm = (s: string): string =>
    s
      .toLowerCase()
      .replace(/[\s,，.。]+/gu, ' ')
      .trim()
  const t = norm(text)
  if (t.length < 4) return undefined
  return hits.find((h) => norm(`${h.title ?? ''} ${h.snippet ?? ''}`).includes(t))
}
