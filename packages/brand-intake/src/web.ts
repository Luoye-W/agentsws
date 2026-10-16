/**
 * WP349（Luoye 10-15 改决策 881）：品牌分析那一轮**联网查**——品牌评测 / 媒体 / 社区讨论，
 * 以及竞品（搜「同类品牌 / alternatives / vs」拿候选，再对前几个各搜一次核实）。
 *
 * Luoye 原话：竞品分析包括品牌分析，这些肯定是要联网去查询的，不可能只靠 AI 原生内置的知识。
 *
 * 这个包照旧**不联网**：搜索口由调用方注入（服务端给的是官方 web search，带 7 天缓存；测试给替身）。
 * 这里只管三件事：搜什么、按什么顺序搜（额度装不下时先让品牌评测、再让竞品）、搜到的编上号交给
 * 同一次 AI 归纳（{@link insightsPrompt}）。没有来源的竞品在 {@link insightFields} 里被丢。
 */
import {
  BRAND_INTAKE_WEB_SEARCH_MAX,
  type BrandIntakeProfile,
  type BrandIntakeWebPart,
  marketLanguage,
} from '@agentsws/contracts'

/** 搜到的一条。 */
export interface IntakeWebHit {
  url: string
  title?: string
  snippet?: string
}

/** 搜一句。搜不了 / 出错回 `undefined`（算「没搜成」）。 */
export type IntakeWebSearch = (query: string) => Promise<IntakeWebHit[] | undefined>

/** 编了号的一条（提示词里按号引用；`part` 是哪一部分搜到的，`about` 是核实哪个竞品时搜到的）。 */
export interface NumberedHit extends IntakeWebHit {
  n: number
  part: BrandIntakeWebPart
  about?: string
}

/** 每句搜索取前几条进提示词（再多只烧 token）。 */
const KEEP: Record<BrandIntakeWebPart, number> = { competitors: 5, verify: 3, brand: 4 }

const clip = (s: string | undefined, n: number): string | undefined => {
  const t = s?.replace(/\s+/g, ' ').trim()
  return t === undefined || t === '' ? undefined : t.slice(0, n)
}

/** 品牌名（没读到就用官网域名的那一段）。 */
export function brandNameOf(profile: BrandIntakeProfile, url?: string): string | undefined {
  const name = clip(profile.brand_name?.value, 60)
  if (name !== undefined) return name
  try {
    const host = new URL(url ?? '').hostname.replace(/^www\./, '')
    const label = host.split('.')[0]
    return label === undefined || label === '' ? undefined : label
  } catch {
    return undefined
  }
}

/** 品类那一句（读到了才带；Amazon 面包屑 / 已有档案）。 */
const whatOf = (profile: BrandIntakeProfile): string =>
  clip(profile.subcategory?.value ?? profile.category?.value, 40) ?? ''

const q = (...parts: string[]): string => parts.join(' ').replace(/\s+/g, ' ').trim()

/**
 * WP353（Luoye 10-16「搜索语言」）：查法按**品牌主市场的语言**出（档案 `markets` 第一个 → 那国第一语言），
 * 不再只有英文一套（WP349 决策 899 留的口子）。表里没有的语言、档案里没市场：英文。
 * 「reddit」那一句各语言都留着（Reddit 本身以英文为主，带上它是为了找社区讨论）。
 */
const QUERY_WORDS: Readonly<
  Record<
    string,
    { review: string; news: string; alt: string; best: string; like: string; official: string }
  >
> = {
  en: {
    review: 'review',
    news: 'brand news',
    alt: 'alternatives',
    best: 'best',
    like: 'brands like',
    official: 'official site price',
  },
  de: {
    review: 'Test',
    news: 'Marke News',
    alt: 'Alternativen',
    best: 'beste',
    like: 'Marken wie',
    official: 'offizielle Website Preis',
  },
  fr: {
    review: 'avis',
    news: 'actualités marque',
    alt: 'alternatives',
    best: 'meilleures',
    like: 'marques comme',
    official: 'site officiel prix',
  },
  es: {
    review: 'opiniones',
    news: 'noticias marca',
    alt: 'alternativas',
    best: 'mejores',
    like: 'marcas como',
    official: 'web oficial precio',
  },
  it: {
    review: 'recensione',
    news: 'notizie marchio',
    alt: 'alternative',
    best: 'migliori',
    like: 'marchi come',
    official: 'sito ufficiale prezzo',
  },
  pt: {
    review: 'avaliação',
    news: 'notícias marca',
    alt: 'alternativas',
    best: 'melhores',
    like: 'marcas como',
    official: 'site oficial preço',
  },
  nl: {
    review: 'review',
    news: 'merk nieuws',
    alt: 'alternatieven',
    best: 'beste',
    like: 'merken zoals',
    official: 'officiële website prijs',
  },
  ja: {
    review: 'レビュー',
    news: 'ニュース',
    alt: '代替',
    best: 'おすすめ',
    like: '似たブランド',
    official: '公式サイト 価格',
  },
  zh: {
    review: '测评',
    news: '品牌 新闻',
    alt: '同类品牌',
    best: '推荐',
    like: '类似品牌',
    official: '官网 价格',
  },
}

/** 这个品牌用哪种语言写查询（主市场的第一语言；认不出 / 没有：英文）。 */
export function queryLanguageOf(profile: BrandIntakeProfile): string {
  const market = profile.markets?.value?.[0]
  const lang = market === undefined ? undefined : marketLanguage(market)?.split('-')[0]
  return lang !== undefined && QUERY_WORDS[lang] !== undefined ? lang : 'en'
}

const wordsOf = (profile: BrandIntakeProfile) =>
  QUERY_WORDS[queryLanguageOf(profile)] ??
  (QUERY_WORDS.en as NonNullable<(typeof QUERY_WORDS)['en']>)

/** 品牌本身：评测、社区讨论、媒体报道（最多 3 句）。 */
export function brandQueries(name: string, profile: BrandIntakeProfile): string[] {
  const what = whatOf(profile)
  const w = wordsOf(profile)
  return [q(name, what, w.review), q(name, 'reddit'), q(name, w.news)].slice(
    0,
    BRAND_INTAKE_WEB_SEARCH_MAX.brand,
  )
}

/** 竞品发现：同类品牌 / alternatives / vs（最多 2 句）。 */
export function competitorQueries(name: string, profile: BrandIntakeProfile): string[] {
  const what = whatOf(profile)
  const w = wordsOf(profile)
  return [q(name, w.alt, what), what === '' ? q(name, 'vs') : q(w.best, what, w.like, name)].slice(
    0,
    BRAND_INTAKE_WEB_SEARCH_MAX.competitors,
  )
}

/** 核实一个竞品：官网、价格带、主打卖点。 */
export function verifyQuery(candidate: string, profile: BrandIntakeProfile): string {
  return q(candidate, whatOf(profile), wordsOf(profile).official)
}

/** 认成候选名时要扔掉的泛词（标题里常见的大写词）。 */
const GENERIC = new Set(
  [
    'best',
    'top',
    'the',
    'a',
    'an',
    'review',
    'reviews',
    'vs',
    'versus',
    'alternative',
    'alternatives',
    'amazon',
    'reddit',
    'youtube',
    'which',
    'why',
    'how',
    'what',
    'guide',
    'comparison',
    'compared',
    'our',
    'buying',
    'is',
    'are',
    'should',
    'i',
    'we',
    'you',
    'brands',
    'brand',
    'similar',
    'other',
    'more',
    'and',
    'or',
    'with',
    'for',
    'in',
    'new',
  ].map((w) => w.toLowerCase()),
)

/** 一段的开头 / 结尾那个像品牌名的词组（1–3 个大写开头的词）。 */
const NAME = "[A-Z0-9][\\w'&.+-]*(?:\\s+[A-Z0-9][\\w'&.+-]*){0,2}"
const LEADING = new RegExp(`^[\\s"'“(]*(${NAME})`, 'u')
/** 两个以上并列的名字（「A、B、C」「A / B」）。 */
const LISTED = new RegExp(`${NAME}(?:\\s*[、,，/]\\s*${NAME})+`, 'gu')
const TRAILING = new RegExp(`(${NAME})[\\s"'”)?]*$`, 'u')

const tidy = (raw: string | undefined): string | undefined => {
  if (raw === undefined) return undefined
  const words = raw
    .replace(/[.,:;!?]+$/u, '')
    .split(/\s+/)
    .filter((w) => w !== '')
  // 头尾的泛词剥掉（「Best Osprey」→「Osprey」、「Osprey Review」→「Osprey」）
  while (words.length > 0 && GENERIC.has((words[0] ?? '').toLowerCase())) words.shift()
  while (words.length > 0 && GENERIC.has((words[words.length - 1] ?? '').toLowerCase())) words.pop()
  const name = words.join(' ')
  if (name.length < 2 || /^\d+$/.test(name)) return undefined
  return name
}

/** 名字归一（比大小写、空格、标点之外的那一串）。 */
export const nameKey = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

/**
 * 从「竞品发现」那几条里认出候选竞品名（只用来决定核实谁；最后收不收由 AI 归纳 + 来源核对定）。
 * 认法：「A vs B」里另一边、「alternatives: A, B, C」「like / such as A, B」后面那串、「A、B、C」并列。
 * 按出现次数排（同一段字里只算一次）。
 */
export function competitorCandidates(hits: readonly IntakeWebHit[], self: string): string[] {
  const me = nameKey(self)
  const score = new Map<string, { name: string; n: number; first: number }>()
  let order = 0
  /** 同一段字里同一个名字只算一次（几种认法可能认出同一个）。 */
  let here = new Set<string>()
  const add = (raw: string | undefined): void => {
    const name = tidy(raw)
    if (name === undefined) return
    const key = nameKey(name)
    if (key === '' || key === me || key.includes(me) || me.includes(key)) return
    if (GENERIC.has(name.toLowerCase()) || here.has(key)) return
    here.add(key)
    const had = score.get(key)
    if (had === undefined) score.set(key, { name, n: 1, first: order++ })
    else had.n += 1
  }
  for (const hit of hits) {
    for (const text of [hit.title ?? '', hit.snippet ?? '']) {
      here = new Set()
      // 「A vs B」：与自己相邻的另一边是候选；两边都不是自己时两边都算
      const sides = text.split(/\s+(?:vs\.?|versus)\s+/iu)
      for (let i = 0; i + 1 < sides.length; i++) {
        const left = TRAILING.exec(sides[i] ?? '')?.[1]
        const right = LEADING.exec(sides[i + 1] ?? '')?.[1]
        add(left)
        add(right)
      }
      // 「alternatives (to X): A, B and C」「like A, B」「such as A, B」
      const list =
        /(?:alternatives?(?:\s+to\s+[^:：]{1,40})?\s*[:：]|\blike\b|such as|including)\s*([^.;!?]+)/iu.exec(
          text,
        )?.[1]
      if (list !== undefined)
        for (const item of list.split(/,|，|、|\band\b|\bor\b|&/u)) add(LEADING.exec(item)?.[1])
      // 中文标题常见的并列：「EcoFlow、Jackery、BLUETTI 横评」（两个以上用顿号 / 逗号 / 斜杠连着的名字）
      for (const run of text.matchAll(LISTED))
        for (const item of run[0].split(/[、,，/]/u)) add(item)
    }
  }
  return [...score.values()].sort((a, b) => b.n - a.n || a.first - b.first).map((c) => c.name)
}

/** 联网查一轮的结果。 */
export interface WebResearch {
  hits: NumberedHit[]
  /** 一共搜了几次（含没搜成的）。 */
  searches: number
  /** 搜成了几次。 */
  ok: number
  /** 因为额度没查 / 没查全的几部分。 */
  cut: BrandIntakeWebPart[]
}

/**
 * 按顺序搜：竞品发现 → 竞品核实（前几个候选）→ 品牌评测。`allowed` 是这一次额度容得下的次数：
 * 装不下时从后往前让——先让品牌评测，再让核实，最后才让竞品发现（官网解析在调用方那里已经保住了）。
 */
export async function webResearch(input: {
  name: string
  profile: BrandIntakeProfile
  search: IntakeWebSearch
  allowed: number
}): Promise<WebResearch> {
  const { name, profile, search } = input
  let left = Math.max(0, Math.floor(input.allowed))
  const out: WebResearch = { hits: [], searches: 0, ok: 0, cut: [] }
  const seen = new Set<string>()
  const keep = (part: BrandIntakeWebPart, got: IntakeWebHit[] | undefined, about?: string) => {
    if (got === undefined) return
    out.ok += 1
    for (const h of got.slice(0, KEEP[part])) {
      if (typeof h?.url !== 'string' || !/^https?:\/\//iu.test(h.url) || seen.has(h.url)) continue
      seen.add(h.url)
      const title = clip(h.title, 160)
      const snippet = clip(h.snippet, 300)
      out.hits.push({
        n: out.hits.length + 1,
        url: h.url,
        part,
        ...(title === undefined ? {} : { title }),
        ...(snippet === undefined ? {} : { snippet }),
        ...(about === undefined ? {} : { about }),
      })
    }
  }
  /** 一批（同一部分）一起搜，按原顺序编号。 */
  const batch = async (
    part: BrandIntakeWebPart,
    queries: { query: string; about?: string }[],
  ): Promise<void> => {
    const take = queries.slice(0, left)
    if (take.length < queries.length) out.cut.push(part)
    left -= take.length
    out.searches += take.length
    const got = await Promise.all(take.map((x) => search(x.query).catch(() => undefined)))
    take.forEach((x, i) => {
      keep(part, got[i], x.about)
    })
  }

  await batch(
    'competitors',
    competitorQueries(name, profile).map((query) => ({ query })),
  )
  const candidates = competitorCandidates(
    out.hits.filter((h) => h.part === 'competitors'),
    name,
  ).slice(0, BRAND_INTAKE_WEB_SEARCH_MAX.verify)
  if (out.cut.includes('competitors')) {
    // 发现都没搜全：核实那一步照实也算没查
    if (!out.cut.includes('verify')) out.cut.push('verify')
  } else
    await batch(
      'verify',
      candidates.map((c) => ({ query: verifyQuery(c, profile), about: c })),
    )
  await batch(
    'brand',
    brandQueries(name, profile).map((query) => ({ query })),
  )
  return out
}
