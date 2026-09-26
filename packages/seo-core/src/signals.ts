/**
 * 读 Search Console：**只算六个信号，其余一律不看**（文章《how we 47x'd our SEO》第 1 步）。
 *
 * 纯函数、同输入同输出。阈值全部可调（`SignalOptions`），默认值就是文章里那几个数：
 * 排名 3–20、曝光 > 500 且点击率 < 0.5%、周环比降 30%、7 个词以上。
 *
 * 为什么判断写成规则而不交给模型：这几件事有标准答案（排名是不是 3–20 不需要"理解"），
 * 而交给模型的每一个数都可能被改写。模型的活在后面——写那句改好的标题、那个小节。
 */
import type { GscRow, SearchIntent, SeoSignalId, SitePage } from '@agentsws/contracts'

export interface SignalOptions {
  /** 品牌词（品牌名、店名、域名主体）。含这些词的查询不算 `almost_there`——那是自己人在找你。 */
  brand_terms: readonly string[]
  /** `almost_there` 的排名窗口，默认 3–20。 */
  min_position?: number
  max_position?: number
  /** `no_clicks`：曝光大于它（默认 500）…… */
  no_clicks_impressions?: number
  /** ……且点击率低于它（默认 0.005 = 0.5%）。 */
  no_clicks_ctr?: number
  /** `decaying`：周环比降幅（%，默认 30）。 */
  decay_pct?: number
  /**
   * `decaying`：上周点击至少这么多（默认 10）才算。上周 2 次这周 1 次是"降 50%"，
   * 但那是噪声，不是衰退——拿它占一个名额等于把真正在掉的页面挤出去。
   */
  decay_min_prev_clicks?: number
  /** `ai_mode`：几个词以上（默认 7）。 */
  ai_mode_words?: number
}

export const DEFAULT_SIGNAL_OPTIONS = {
  min_position: 3,
  max_position: 20,
  no_clicks_impressions: 500,
  no_clicks_ctr: 0.005,
  decay_pct: 30,
  decay_min_prev_clicks: 10,
  ai_mode_words: 7,
} as const

/** 一次命中：哪个信号、哪一行、落在哪一页（店里找得到才有）。 */
export interface SignalHit {
  signal: SeoSignalId
  row: GscRow
  page?: SitePage
  /** `wrong_intent` 才有：两边各是什么。 */
  intents?: { query: SearchIntent; page: SearchIntent }
  /** 周环比（%）；有上周数才有。 */
  wow_pct?: number
}

const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/

/**
 * 一个查询有几个词。空格分隔的语言按空格数；中日韩按分词器（`Intl.Segmenter`）数"词样"的段。
 *
 * 中文的"7 个词"没有空格可数——按字数算会把"充电宝推荐"算成 5 个词，按分词算是 2 个，
 * 后者才是文章里那条信号的意思（像在跟 ChatGPT 说话的长句）。
 */
export function wordCount(query: string): number {
  const q = query.trim()
  if (q === '') return 0
  if (!CJK.test(q)) return q.split(/\s+/).filter((w) => w !== '').length
  const seg = new Intl.Segmenter('zh', { granularity: 'word' })
  let n = 0
  for (const s of seg.segment(q)) if (s.isWordLike === true) n += 1
  return n
}

/** 归一：小写、去首尾空白、把连续空白压成一个。 */
export function normalizeQuery(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, ' ')
}

export function isBrandQuery(query: string, brand_terms: readonly string[]): boolean {
  const q = normalizeQuery(query)
  return brand_terms.some((t) => t.trim() !== '' && q.includes(normalizeQuery(t)))
}

const INTENT_RULES: { intent: SearchIntent; terms: string[] }[] = [
  {
    intent: 'comparison',
    terms: [
      ' vs ',
      ' vs. ',
      'versus',
      'compare',
      'comparison',
      'alternative',
      '对比',
      '区别',
      '哪个好',
      '比较',
    ],
  },
  {
    intent: 'pricing',
    terms: [
      'how much',
      'price',
      'cost',
      'cheap',
      'calculator',
      '多少钱',
      '价格',
      '价钱',
      '费用',
      '计算',
    ],
  },
  {
    intent: 'transactional',
    terms: [
      'buy',
      'coupon',
      'discount',
      'deal',
      'order',
      'for sale',
      '购买',
      '优惠',
      '折扣',
      '下单',
      '哪里买',
    ],
  },
  {
    intent: 'navigational',
    terms: ['login', 'log in', 'sign in', 'contact', '登录', '官网', '客服电话'],
  },
]

/**
 * 这个查询想要什么（纯规则；认不出就当"想知道点什么"）。
 *
 * 文章第 4 步：对比类查询要一页对比，"多少钱"要一个计算器或价格页——
 * 给想要一个按钮的人写一篇随笔，标题怎么改都救不回来。
 */
export function queryIntent(query: string): SearchIntent {
  const q = ` ${normalizeQuery(query)} `
  for (const r of INTENT_RULES) if (r.terms.some((t) => q.includes(t))) return r.intent
  return 'informational'
}

/** 这一页是什么类型的页（登记过就用登记的，没有就按种类推）。 */
export function pageIntent(page: SitePage): SearchIntent {
  if (page.intent !== undefined) return page.intent
  switch (page.kind) {
    case 'product':
    case 'collection':
      return 'transactional'
    case 'home':
      return 'navigational'
    default:
      return 'informational'
  }
}

/**
 * 查询意图与页面类型对不对得上。
 *
 * 宽的那一边：信息类查询落在任何一页都行（商品页也能回答"这个怎么用"）；
 * 窄的那几边：对比要对比页、价格要价格页或商品页、交易要商品 / 集合页。
 */
export function intentsCompatible(query: SearchIntent, page: SearchIntent): boolean {
  if (query === page) return true
  switch (query) {
    case 'informational':
      return page !== 'navigational'
    case 'pricing':
      return page === 'transactional'
    case 'navigational':
      return true
    default:
      return false
  }
}

/** 按 URL 找店里那一页（忽略协议、`www.`、结尾斜杠、查询串）。 */
export function pageKey(url: string): string {
  try {
    const u = new URL(url)
    const path = u.pathname.replace(/\/+$/, '') || '/'
    return `${u.hostname.replace(/^www\./, '').toLowerCase()}${path.toLowerCase()}`
  } catch {
    return url.trim().toLowerCase().replace(/\/+$/, '')
  }
}

export function findPage(pages: readonly SitePage[], url: string): SitePage | undefined {
  const k = pageKey(url)
  return pages.find((p) => pageKey(p.url) === k)
}

/** 这一页是不是**专门**写这个查询的（登记的目标词命中，或者标题把每个词都包含了）。 */
export function pageTargets(page: SitePage, query: string): boolean {
  const q = normalizeQuery(query)
  if ((page.target_queries ?? []).some((t) => normalizeQuery(t) === q)) return true
  if (page.title === undefined) return false
  const title = normalizeQuery(page.title)
  if (CJK.test(q)) return title.includes(q.replace(/\s+/g, ''))
  const words = q.split(' ').filter((w) => w.length > 2)
  return words.length > 0 && words.every((w) => title.includes(w))
}

/** 周环比（%）；没有上周数或上周是 0 就没有（不编一个无穷大）。 */
export function weekOverWeek(row: GscRow): number | undefined {
  const prev = row.clicks_prev_week
  if (prev === undefined || prev <= 0) return undefined
  return Math.round(((row.clicks - prev) / prev) * 1000) / 10
}

/**
 * 六个信号，逐行判。一行可以同时命中好几个（排名 15 的 8 个词长尾 = `almost_there` + `ai_mode`），
 * 挑哪一个当这件事的"主信号"是 `picks.ts` 的事。
 */
export function detectSignals(
  rows: readonly GscRow[],
  pages: readonly SitePage[],
  opts: SignalOptions,
): SignalHit[] {
  const o = { ...DEFAULT_SIGNAL_OPTIONS, ...opts }
  const hits: SignalHit[] = []
  for (const row of rows) {
    const page = findPage(pages, row.page)
    const base = page === undefined ? { row } : { row, page }
    const wow = weekOverWeek(row)
    const brand = isBrandQuery(row.query, o.brand_terms)
    if (!brand && row.position >= o.min_position && row.position <= o.max_position)
      hits.push({ signal: 'almost_there', ...base })
    if (row.impressions > o.no_clicks_impressions && row.ctr < o.no_clicks_ctr)
      hits.push({ signal: 'no_clicks', ...base })
    if (
      wow !== undefined &&
      (row.clicks_prev_week ?? 0) >= o.decay_min_prev_clicks &&
      wow <= -o.decay_pct
    )
      hits.push({ signal: 'decaying', ...base, wow_pct: wow })
    // 「有排名」= 进了前 max_position（默认 20）；排在第 60 位的词没有一页写它是常态，不是信号
    // 品牌词不算：搜品牌名的人要的是首页，不是一页新的
    if (!brand && row.position <= o.max_position && !pages.some((p) => pageTargets(p, row.query)))
      hits.push({ signal: 'untargeted', ...base })
    // 品牌词落在首页是对的（搜品牌名的人要的就是那一页），不判意图
    if (page !== undefined && !brand) {
      const qi = queryIntent(row.query)
      const pi = pageIntent(page)
      if (!intentsCompatible(qi, pi))
        hits.push({ signal: 'wrong_intent', ...base, intents: { query: qi, page: pi } })
    }
    if (wordCount(row.query) >= o.ai_mode_words) hits.push({ signal: 'ai_mode', ...base })
  }
  return hits
}

/** 每个信号命中几条（卡上只报数，不列行）。 */
export function countSignals(hits: readonly SignalHit[]): Record<SeoSignalId, number> {
  const out: Record<SeoSignalId, number> = {
    almost_there: 0,
    no_clicks: 0,
    decaying: 0,
    untargeted: 0,
    wrong_intent: 0,
    ai_mode: 0,
  }
  for (const h of hits) out[h.signal] += 1
  return out
}
