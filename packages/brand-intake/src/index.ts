/**
 * 贴一个网址，把品牌档案填出来（70 §3，WP121）。
 *
 * **这个包不联网、不碰库、不认识模型。** 它只有三样东西：
 *
 * - 一个抓取口（{@link PageFetch}，测试塞夹具）；
 * - 两个解析器（官网 / Amazon），纯函数，输入 HTML 输出字段；
 * - 一个编排器（{@link analyzeBrand}），负责分流、算钱、封顶。
 *
 * 库、路由、模型那一步都在调用方（`apps/server`）。这样这一整包的测试可以
 * 全用本地 HTML 夹具跑完，**一个字节都不出这台机器**。
 *
 * ## 封顶这件事
 *
 * 第一步用官方接口的用户，手上只有注册送的 10 积分。分析这一步计入那 10 积分，
 * 所以 {@link analyzeBrand} 开跑前先报预估、跑的过程里累计、**到顶就停**。
 *
 * 停下来的时候**已经抓到的照样交**——一个填了一半的档案卡仍然帮用户省了事，
 * 而"超预算了所以什么都不给你"是两头落空。
 */
export type { AmazonEntry, AmazonIntakeResult } from './amazon.js'
export {
  analyzeAmazonListing,
  analyzeAmazonStorefront,
  classifyAmazonUrl,
  countryOfHost,
  featureBullets,
  isBlocked,
  storefrontCards,
} from './amazon.js'
// WP335（决策 659）：品类一格——AI 填、人可改
export {
  CATEGORY_MAX_CHARS,
  categoryPrompt,
  modelCategoryField,
  parseCategoryReply,
  wantsModelCategory,
} from './category.js'
export type {
  FetchedPage,
  FetchFailureKind,
  PageFetch,
  StorefrontPasswordPost,
} from './fetch.js'
export {
  BRAND_INTAKE_TIMEOUT_MS,
  BRAND_INTAKE_USER_AGENT,
  causeCodeOf,
  failureKindOf,
  fetchPage,
  fetchRobots,
  isBotChallengePage,
  isDisallowed,
  isShopifyPasswordPage,
  MAX_PAGE_CHARS,
  parseRobotsDisallow,
  ROBOTS_TIMEOUT_MS,
  unlockShopifyStorefront,
} from './fetch.js'
export type { IntakeLayer } from './field.js'
export {
  applyEdits,
  confidenceOf,
  field,
  MAX_QUOTE_CHARS,
  mergeProfile,
  needsConfirm,
} from './field.js'
export {
  absolute,
  decodeEntities,
  hrefs,
  isType,
  jsonLdNodes,
  linkHref,
  mainText,
  metaContent,
  squash,
  themeColor,
  titleOf,
  visibleText,
} from './html.js'
export type { MarketInputs } from './markets.js'
export {
  countriesIn,
  hreflangCountries,
  inferMarkets,
  localizationCountries,
  MARKET_SELECTOR_MAX,
  MARKETS_MANY_DEFAULT,
  MARKETS_MANY_LOCATOR,
  MARKETS_MANY_THRESHOLD,
  shippingCountries,
  tldCountry,
} from './markets.js'
export type { ShopifyDefaultText } from './shopify-default-texts.js'
export { SHOPIFY_DEFAULT_HOME_TEXTS } from './shopify-default-texts.js'
export type { SiteIntakeOptions, SiteIntakeResult } from './site.js'
export {
  analyzeSite,
  detectPlatform,
  isFreshShopifyStore,
  isPlaceholderStoreName,
  looksLikeDefaultPolicy,
  looksLikePolicy,
  POLICY_MIN_CHARS_CJK,
  POLICY_PROBE_PATHS,
  placeholderTextHits,
  policyLength,
  SHOPIFY_PLACEHOLDER_NAMES,
  shopifyShopDomain,
} from './site.js'
export {
  hashSentence,
  normalizeForMatch,
  pageSentenceHashes,
  sentencesOf,
  textHashes,
} from './text-hash.js'

import {
  BRAND_INTAKE_INSIGHTS_CREDITS,
  BRAND_INTAKE_SEARCH_CREDITS,
  BRAND_INTAKE_WEB_SEARCH_MAX,
  type BrandIntakeBudget,
  type BrandIntakeFailureKind,
  type BrandIntakeInsightsStatus,
  type BrandIntakePage,
  type BrandIntakeProfile,
  type BrandIntakeSourceKind,
  type BrandIntakeWebReport,
  DEFAULT_BRAND_INTAKE_CAP_CREDITS,
} from '@agentsws/contracts'
import { analyzeAmazonListing, analyzeAmazonStorefront, classifyAmazonUrl } from './amazon.js'
import type { PageFetch } from './fetch.js'
import { mergeProfile } from './field.js'
import {
  digestText,
  type InsightsModel,
  type InsightsPage,
  insightFields,
  insightsPrompt,
  pageDigest,
  parseInsightsReply,
} from './insights.js'
import { analyzeSite } from './site.js'
import { brandNameOf, type IntakeWebSearch, type NumberedHit, webResearch } from './web.js'

/** WP349：一轮最多搜几次（品牌 3 + 竞品发现 2 + 核实 4）。 */
const WEB_SEARCH_TOTAL =
  BRAND_INTAKE_WEB_SEARCH_MAX.brand +
  BRAND_INTAKE_WEB_SEARCH_MAX.competitors +
  BRAND_INTAKE_WEB_SEARCH_MAX.verify

/** WP349：没联网能力时那一句（调用方没给更具体的原因时用）。 */
export const WEB_OFF_REASON = '没联网，查不了竞品。'

/**
 * 一个页面按多少积分算。
 *
 * 这个数是**抽取那一步**的单价（抓取本身不要钱，要钱的是喂给便宜档模型的
 * 那些 token）。0.15 × 12 页 ≈ 1.8，正好压在 2 积分的封顶下面——封顶不是
 * 摆设，但也不该在正常情况下就撞上。
 */
export const CREDITS_PER_PAGE = 0.15

/** 贴进来的一条链接是什么。 */
export function classifyUrl(url: string): BrandIntakeSourceKind {
  const amazon = classifyAmazonUrl(url)
  if (amazon !== undefined) return amazon.kind
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? 'website' : 'none'
  } catch {
    return 'none'
  }
}

/**
 * 开跑前给用户看的那个数（界面上"大约 N 积分"）。
 * WP346：接了模型（`insights`）再加 AI 归纳那一次（{@link BRAND_INTAKE_INSIGHTS_CREDITS}）。
 */
export function estimateCredits(urls: string[], options: { insights?: boolean } = {}): number {
  let pages = 0
  for (const url of urls) {
    const kind = classifyUrl(url)
    if (kind === 'website') pages += 12
    else if (kind === 'amazon_storefront') pages += 1
    else if (kind === 'amazon_listing') pages += 1
  }
  const extra = options.insights === true && pages > 0 ? BRAND_INTAKE_INSIGHTS_CREDITS : 0
  return Math.round((pages * CREDITS_PER_PAGE + extra) * 100) / 100
}

export interface AnalyzeBrandResult {
  pages: BrandIntakePage[]
  profile: BrandIntakeProfile
  budget: BrandIntakeBudget
  /** 撞上封顶停下来的。界面上要说一句"分析到这儿就停了"。 */
  stopped_for_budget: boolean
  /** 抓回来的 HTML 原文（只在 `keepHtml` 时有；见 {@link SiteIntakeResult.documents}）。 */
  documents?: { url: string; kind: BrandIntakePage['kind']; html: string }[]
  /** WP240：官网首页就读不到时是哪一种（第一条官网链接的）。 */
  failure_kind?: BrandIntakeFailureKind
  /** WP240：官网开着 Shopify 访问密码。 */
  password_protected?: boolean
  /** WP244：官网是刚开的 Shopify 空店（占位店名 / 默认首页）。 */
  fresh_store?: boolean
  /** WP346：AI 归纳那一步怎么样了（没给 `insights` 选项就是 `no_model`）。 */
  insights: BrandIntakeInsightsStatus
  /** WP349：联网查那一步怎么样了。 */
  web: BrandIntakeWebReport
}

/**
 * 跑一遍。
 *
 * 链接按顺序处理，**每处理完一条就结一次账**；结完发现到顶了就不再开下一条。
 * 不做"跑到一半掐断"——一条链接跑到一半的结果比没跑更难解释。
 */
export async function analyzeBrand(
  doFetch: PageFetch,
  urls: string[],
  options: {
    capCredits?: number
    keepHtml?: boolean
    /** WP240：每抓完一页回一次（界面进度跟着动）。 */
    onPage?: (page: BrandIntakePage) => void
    /** WP240：店铺访问密码与解开它的那一下（见 `SiteIntakeOptions`）。 */
    storefrontPassword?: string
    unlock?: (origin: string, password: string) => Promise<string | undefined>
    /**
     * WP346（决策 872）：AI 归纳（人群 / 关键词 / 价格带 / 子品类 / 定位 / 竞品 / 商品规格）。
     * 不给 = 这个品牌没接模型：那几格跳过，照旧出解析结果。一次分析**只问一次**，计入积分、
     * 沿用封顶（先留出这一份，页面预算相应少一份）；只喂这一轮抓到的页面文字。
     */
    insights?: { model: InsightsModel; language?: 'zh' | 'en' }
    /**
     * WP349（Luoye 10-15 改决策 881）：联网查（品牌评测 / 社区 / 媒体 + 竞品发现与核实），结果进同一次
     * AI 归纳。`search` 不给 = 没联网能力：竞品一格留空，`reason` 是照实说的那一句。
     * 每次按 `creditsPerSearch`（默认 {@link BRAND_INTAKE_SEARCH_CREDITS}）计入积分；封顶装不下时
     * 先保官网解析（与 AI 那一次），再竞品，最后品牌评测。
     */
    web?: { search?: IntakeWebSearch; reason?: string; creditsPerSearch?: number }
  } = {},
): Promise<AnalyzeBrandResult> {
  const cap = options.capCredits ?? DEFAULT_BRAND_INTAKE_CAP_CREDITS
  // WP346：给 AI 归纳那一步先留出一份（页面花到 cap − reserve 为止）
  const reserve = options.insights === undefined ? 0 : BRAND_INTAKE_INSIGHTS_CREDITS
  const pageCap = Math.max(0, cap - reserve)
  /*
   * WP346：AI 归纳要读这一轮抓到的页面原文。在抓取口上顺手留一份（官网与 Amazon 两条路都经过它），
   * 不另抓一遍；只在接了模型时留。
   */
  const seen = new Map<string, string>()
  const doGet: PageFetch =
    options.insights === undefined
      ? doFetch
      : async (url, init) => {
          const res = await doFetch(url, init)
          return {
            ...res,
            text: async () => {
              const t = await res.text()
              if (res.ok) seen.set(url, t)
              return t
            },
          }
        }
  const pages: BrandIntakePage[] = []
  const documents: NonNullable<AnalyzeBrandResult['documents']> = []
  let profile: BrandIntakeProfile = {}
  let spent = 0
  let stopped = false
  let failure: BrandIntakeFailureKind | undefined
  let locked = false
  let fresh = false

  for (const url of urls) {
    if (spent >= pageCap) {
      stopped = true
      break
    }
    const kind = classifyUrl(url)
    if (kind === 'none') continue

    let got: { pages: BrandIntakePage[]; profile: BrandIntakeProfile }
    if (kind === 'website') {
      // 还剩多少页的预算，就最多抓多少页
      const affordable = Math.max(1, Math.floor((pageCap - spent + 1e-9) / CREDITS_PER_PAGE))
      const site = await analyzeSite(doGet, url, {
        maxPages: affordable,
        ...(options.keepHtml === true ? { keepHtml: true } : {}),
        ...(options.onPage === undefined ? {} : { onPage: options.onPage }),
        ...(options.storefrontPassword === undefined
          ? {}
          : { storefrontPassword: options.storefrontPassword }),
        ...(options.unlock === undefined ? {} : { unlock: options.unlock }),
      })
      documents.push(...(site.documents ?? []))
      failure ??= site.failure_kind
      if (site.password_protected === true) locked = true
      if (site.fresh_store === true) fresh = true
      got = site
    } else {
      const entry = classifyAmazonUrl(url)
      if (entry === undefined) continue
      got =
        entry.kind === 'amazon_listing'
          ? await analyzeAmazonListing(doGet, url, entry)
          : await analyzeAmazonStorefront(doGet, url, entry)
    }

    pages.push(...got.pages)
    /*
     * 合并方向是**先到的在前**：第一条链接通常是用户心里的主来源（官网），
     * 后面补的那些只填它没填上的格子。`mergeProfile` 里"改过的不动"那条
     * 在这里还用不上（都是机器填的），但用同一个函数省得两套规则。
     */
    // WP166：目标市场是例外——官网配送到的国家与 Amazon 站点所在国**都是**市场，合在一起（去重、保序）
    const both =
      profile.markets !== undefined && got.profile.markets !== undefined
        ? {
            value: [...new Set([...profile.markets.value, ...got.profile.markets.value])],
            confidence:
              profile.markets.confidence === 'low'
                ? got.profile.markets.confidence
                : profile.markets.confidence,
            evidence: [...profile.markets.evidence, ...got.profile.markets.evidence],
          }
        : undefined
    profile = mergeProfile(profile, dropFilled(profile, got.profile))
    if (both !== undefined) profile.markets = both
    // 只有真抓着的页面才算钱
    spent = Math.round(pages.filter((p) => p.ok).length * CREDITS_PER_PAGE * 100) / 100
    if (spent >= pageCap) stopped = true
  }

  // ── WP346：AI 归纳（一次调用；读到页面、不是空店、预算还容得下才问）──────────
  let insights: BrandIntakeInsightsStatus = 'no_model'
  const webSearch = options.web?.search
  let web: BrandIntakeWebReport = { status: 'skipped', searches: 0, credits: 0 }
  if (options.insights !== undefined) {
    const read: InsightsPage[] = pages
      .filter((p) => p.ok && seen.has(p.url))
      .map((p) => ({ url: p.url, kind: p.kind, html: seen.get(p.url) ?? '' }))
    if (read.length === 0 || fresh) insights = 'skipped'
    else if (Math.round((spent + BRAND_INTAKE_INSIGHTS_CREDITS) * 100) / 100 > cap)
      insights = 'budget'
    else {
      spent = Math.round((spent + BRAND_INTAKE_INSIGHTS_CREDITS) * 100) / 100
      // ── WP349：联网查（AI 那一次已经留好；剩下的额度按「竞品 → 品牌评测」的顺序给搜索）──
      let hits: NumberedHit[] = []
      const name = brandNameOf(profile, urls[0])
      if (webSearch === undefined)
        web = {
          status: 'off',
          reason: options.web?.reason ?? WEB_OFF_REASON,
          searches: 0,
          credits: 0,
        }
      else if (name !== undefined) {
        const price = options.web?.creditsPerSearch ?? BRAND_INTAKE_SEARCH_CREDITS
        const allowed =
          price <= 0
            ? WEB_SEARCH_TOTAL
            : Math.min(WEB_SEARCH_TOTAL, Math.floor((cap - spent) / price + 1e-9))
        const found = await webResearch({ name, profile, search: webSearch, allowed })
        hits = found.hits
        const credits = Math.round(found.searches * price * 100) / 100
        spent = Math.round((spent + credits) * 100) / 100
        web = {
          status:
            found.searches > 0 && found.ok === 0 ? 'failed' : found.ok > 0 ? 'done' : 'skipped',
          searches: found.searches,
          credits,
          ...(found.cut.length === 0 ? {} : { cut: found.cut }),
        }
      }
      try {
        const prompt = insightsPrompt({
          profile,
          digest: pageDigest(read),
          ...(options.insights.language === undefined
            ? {}
            : { language: options.insights.language }),
          ...(hits.length === 0 ? {} : { web: hits }),
        })
        const reply = parseInsightsReply(
          (await options.insights.model({ prompt })).text,
          profile.brand_name?.value,
        )
        if (reply === undefined) insights = 'failed'
        else {
          profile = {
            ...profile,
            ...insightFields(profile, reply, {
              url: read[0]?.url ?? urls[0] ?? '',
              pageText: digestText(read),
              web: hits,
            }),
          }
          insights = 'done'
        }
      } catch {
        // 模型出错：解析结果照给，AI 那几格空着（调用方按 `failed` 说一句）
        insights = 'failed'
      }
    }
  }

  return {
    pages,
    profile,
    budget: {
      estimated_credits: estimateCredits(urls, { insights: options.insights !== undefined }),
      cap_credits: cap,
      spent_credits: spent,
    },
    stopped_for_budget: stopped,
    ...(options.keepHtml === true ? { documents } : {}),
    ...(failure === undefined ? {} : { failure_kind: failure }),
    ...(locked ? { password_protected: true } : {}),
    ...(fresh ? { fresh_store: true } : {}),
    insights,
    web,
  }
}

/** 已经有值的格子不让后面的链接覆盖。 */
function dropFilled(have: BrandIntakeProfile, incoming: BrandIntakeProfile): BrandIntakeProfile {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(incoming)) {
    if ((have as Record<string, unknown>)[key] !== undefined) continue
    out[key] = value
  }
  return out as BrandIntakeProfile
}

export { amazonListPrice, amazonSpecs } from './amazon.js'
// WP346（决策 872）：AI 归纳那一步（移植自 KOLAgents enrichment.ts）
export type { InsightsModel, InsightsPage, InsightsReply, SourcedField } from './insights.js'
export {
  digestText,
  INSIGHTS_MAX_PAGE_CHARS,
  insightFields,
  insightsPrompt,
  mentions,
  pageDigest,
  parseInsightsReply,
  sourcedCompetitors,
} from './insights.js'
// WP246：网页转文字（本机那一级）——任意网页 → 干净正文 markdown
export type { ReadableResult } from './readable.js'
export { htmlToReadable, parseHtmlTree, READABLE_MAX_CHARS } from './readable.js'
// WP349：品牌分析联网查（搜什么、按什么顺序、竞品候选怎么认、没来源的竞品怎么丢）
export type { IntakeWebHit, IntakeWebSearch, NumberedHit, WebResearch } from './web.js'
export {
  brandNameOf,
  brandQueries,
  competitorCandidates,
  competitorQueries,
  nameKey,
  verifyQuery,
  webResearch,
} from './web.js'
