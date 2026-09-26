/**
 * GEO：买家去问 AI 的时候，各平台提不提我们（WP154 §5）。
 *
 * 每周一次，拿一组**买家会问的问题**调 `SearchDataPort.aiAnswers`，看三件事：
 * 我们有没有被提到、引用了哪些站、提到了哪些竞品。缺位的出建议——改哪页（我们有相关页面
 * 但没被引用）/ 交公关（被引用的都是站外，缺的是别人提到我们）。
 *
 * 问题清单从哪来：品牌档案（品牌名 + 品类 + 主推商品）套几句买家常问的话，再加上
 * Search Console 里排在前面、本来就像问句的查询；人可以在面板里改（关掉、改字、加）。
 * **人改过的永远赢**：下一次自动生成不会把人删掉的加回来、不会覆盖人改的字。
 *
 * 站点门面（llms.txt、结构化数据、允许 AI 爬虫）不在这里改——那是建站的事，
 * 服务端会开一件交给「建站」的事项（`SITE_FACADE_NOTE`）。
 */
import type {
  AiAnswerResult,
  AiPlatform,
  GeoGap,
  GeoProbeRow,
  GeoQuestion,
  SitePage,
} from '@agentsws/contracts'
import { normalizeQuery, pageTargets, wordCount } from './signals.js'

/** 默认探测的平台（WP155 定的那五个）。 */
export const GEO_PLATFORMS: readonly AiPlatform[] = [
  'chatgpt',
  'perplexity',
  'gemini',
  'google_ai_overview',
  'copilot',
]

/** 一次最多几个问题（每个问题 × 每个平台按次计费，WP155 `data.search.ai_answer`）。 */
export const MAX_GEO_QUESTIONS = 8

export const SITE_FACADE_NOTE =
  '让 AI 更容易读懂我们的网站：放一份 llms.txt、商品与 FAQ 页加结构化数据（schema.org）、robots.txt 别挡 GPTBot / PerplexityBot / Google-Extended。这三样是网站门面，不在内容这边改。'

export interface BrandProfileLike {
  name: string
  /** 品类（"户外电源" / "power station"）。 */
  category?: string
  /** 主推商品名（最多取两个）。 */
  products?: readonly string[]
  language: 'zh' | 'en'
}

const QUESTION_WORDS = [
  'how',
  'what',
  'which',
  'why',
  'best',
  'should',
  'can',
  'is',
  'are',
  'does',
  '怎么',
  '什么',
  '哪个',
  '哪款',
  '为什么',
  '推荐',
  '值得',
  '能不能',
  '可以',
]

/** 一个查询本来就像在提问（问句词开头 / 含问句词，且至少 4 个词）。 */
export function looksLikeQuestion(query: string): boolean {
  const q = normalizeQuery(query)
  return (
    wordCount(q) >= 4 &&
    QUESTION_WORDS.some(
      (w) =>
        q.startsWith(w) || q.includes(` ${w} `) || (/[\u3400-\u9fff]/.test(w) && q.includes(w)),
    )
  )
}

const qid = (text: string): string => {
  let h = 0
  for (const ch of normalizeQuery(text)) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return `gq_${h.toString(36)}`
}

function fromBrand(b: BrandProfileLike): string[] {
  const cat = b.category?.trim()
  const products = (b.products ?? []).slice(0, 2)
  if (b.language === 'zh') {
    return [
      ...(cat === undefined || cat === '' ? [] : [`${cat}哪个牌子好？`, `买${cat}要注意什么？`]),
      `${b.name}怎么样，值得买吗？`,
      ...products.map((p) => `${p}和同类比怎么样？`),
    ]
  }
  return [
    ...(cat === undefined || cat === ''
      ? []
      : [`What is the best ${cat}?`, `What should I look for when buying a ${cat}?`]),
    `Is ${b.name} worth it?`,
    ...products.map((p) => `How does ${p} compare to alternatives?`),
  ]
}

const asQuestion = (q: string): string => {
  const t = q.trim()
  if (/[?？]$/.test(t)) return t
  return /[\u3400-\u9fff]/.test(t) ? `${t}？` : `${t.charAt(0).toUpperCase()}${t.slice(1)}?`
}

/**
 * 生成 / 刷新问题清单。
 *
 * `existing` 里人动过的（`origin: 'human'`，或者被关掉的）原样留着；自动来的按这次重新算，
 * 但**被人关掉的那一句不会以"新的"身份回来**（按归一后的字面比）。
 */
export function generateGeoQuestions(input: {
  brand: BrandProfileLike
  top_queries: readonly string[]
  existing?: readonly GeoQuestion[]
  max?: number
}): GeoQuestion[] {
  const max = input.max ?? MAX_GEO_QUESTIONS
  const existing = input.existing ?? []
  const kept = existing.filter((q) => q.origin === 'human' || !q.enabled)
  const seen = new Set(kept.map((q) => normalizeQuery(q.text)))
  const out: GeoQuestion[] = [...kept]
  const add = (text: string, origin: GeoQuestion['origin']) => {
    const k = normalizeQuery(text)
    if (seen.has(k)) return
    seen.add(k)
    out.push({ id: qid(text), text, origin, enabled: true })
  }
  for (const t of fromBrand(input.brand)) add(t, 'brand')
  for (const q of input.top_queries) if (looksLikeQuestion(q)) add(asQuestion(q), 'top_query')
  // 开着的不超过 max（人加的优先占位，然后是品牌档案来的，再是查询来的）
  let enabled = 0
  return out.map((q) => {
    if (!q.enabled) return q
    enabled += 1
    return enabled <= max ? q : { ...q, enabled: false }
  })
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return url
      .trim()
      .toLowerCase()
      .replace(/^www\./, '')
  }
}

/** 一个问题在各平台的结果 → 面板上的行（只留判断要的几格）。 */
export function probeRows(question: string, results: readonly AiAnswerResult[]): GeoProbeRow[] {
  return results.map((r) => ({
    question,
    platform: r.platform,
    brand_mentioned: r.brand_mentioned,
    our_domain_cited: r.our_domain_cited,
    cited_domains: [...new Set(r.cited_urls.map(domainOf))],
    competitors_mentioned: [...r.competitors_mentioned],
  }))
}

/**
 * 缺位 → 建议。一个问题只要有一个平台**既没提我们、也没引我们的站**就算缺位。
 *
 * - 店里有一页在写这件事 → `fix_page`：把问题原话做小标题、答案放头两行、加 FAQ 结构化数据
 *   ——AI 引用的是"一句话能摘出去的答案"；
 * - 没有这样一页、被引用的都是站外 → `pr_handoff`：让那些被引用的站提到我们；
 * - 两样都没有 → `fix_page` 且不指页：先要有一页回答它（下一张每日卡的新页面选题会接）。
 */
export function geoGaps(
  rows: readonly GeoProbeRow[],
  pages: readonly SitePage[],
  our_domains: readonly string[],
): GeoGap[] {
  const ours = new Set(our_domains.map((d) => d.toLowerCase().replace(/^www\./, '')))
  const byQuestion = new Map<string, GeoProbeRow[]>()
  for (const r of rows) byQuestion.set(r.question, [...(byQuestion.get(r.question) ?? []), r])
  const gaps: GeoGap[] = []
  for (const [question, rs] of byQuestion) {
    const missing = rs.filter((r) => !r.brand_mentioned && !r.our_domain_cited)
    if (missing.length === 0) continue
    const cited = [...new Set(missing.flatMap((r) => r.cited_domains))].filter((d) => !ours.has(d))
    const competitors = [...new Set(missing.flatMap((r) => r.competitors_mentioned))]
    const page = pages.find(
      (p) => pageTargets(p, question.replace(/[?？]$/, '')) || overlaps(p, question),
    )
    const platforms = missing.map((r) => r.platform)
    const base = { question, platforms, cited_domains: cited, competitors }
    if (page !== undefined)
      gaps.push({
        ...base,
        lane: 'fix_page',
        page: page.url,
        suggestion: `「${page.title ?? page.url}」在写这件事但没被引用：把这个问题原话做成小标题，答案放在头两行，加上 FAQ 结构化数据。`,
      })
    else if (cited.length > 0)
      gaps.push({
        ...base,
        lane: 'pr_handoff',
        suggestion: `AI 引用的是 ${cited.slice(0, 3).join('、')}——缺的是这些站提到我们。交给公关（评测、论坛、Reddit）。`,
      })
    else
      gaps.push({
        ...base,
        lane: 'fix_page',
        suggestion: '店里还没有一页回答这个问题——先要有一页，下一张每日卡的新页面选题会接住它。',
      })
  }
  return gaps
}

/** 标题与问题的词重合过半（问题一般比标题长，`pageTargets` 的"每个词都在"太严）。 */
function overlaps(page: SitePage, question: string): boolean {
  if (page.title === undefined) return false
  const seg = new Intl.Segmenter('zh', { granularity: 'word' })
  const words = (s: string) => {
    const text = normalizeQuery(s).replace(/[?？，,。.!！]/g, ' ')
    if (/[\u3400-\u9fff]/.test(text))
      return new Set(
        [...seg.segment(text)]
          .filter((x) => x.isWordLike === true && x.segment.length >= 2)
          .map((x) => x.segment),
      )
    return new Set(text.split(' ').filter((w) => w.length > 3))
  }
  const t = words(page.title)
  const q = [...words(question)]
  if (q.length === 0 || t.size === 0) return false
  return q.filter((w) => t.has(w)).length / Math.min(q.length, t.size) >= 0.5
}
