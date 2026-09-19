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
export type { IntakeLayer } from './field.js'
export {
  applyEdits,
  confidenceOf,
  field,
  MAX_QUOTE_CHARS,
  mergeProfile,
  needsConfirm,
} from './field.js'
export type { FetchedPage, PageFetch } from './fetch.js'
export {
  BRAND_INTAKE_TIMEOUT_MS,
  BRAND_INTAKE_USER_AGENT,
  fetchPage,
  fetchRobots,
  isDisallowed,
  MAX_PAGE_CHARS,
  parseRobotsDisallow,
} from './fetch.js'
export {
  absolute,
  decodeEntities,
  hrefs,
  isType,
  jsonLdNodes,
  linkHref,
  metaContent,
  squash,
  themeColor,
  titleOf,
  visibleText,
} from './html.js'
export type { SiteIntakeResult } from './site.js'
export { analyzeSite, detectPlatform, looksLikePolicy, POLICY_PROBE_PATHS } from './site.js'

import {
  type BrandIntakeBudget,
  type BrandIntakePage,
  type BrandIntakeProfile,
  type BrandIntakeSourceKind,
  DEFAULT_BRAND_INTAKE_CAP_CREDITS,
} from '@agentsws/contracts'
import { analyzeAmazonListing, analyzeAmazonStorefront, classifyAmazonUrl } from './amazon.js'
import { mergeProfile } from './field.js'
import type { PageFetch } from './fetch.js'
import { analyzeSite } from './site.js'

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

/** 开跑前给用户看的那个数（界面上"大约 N 积分"）。 */
export function estimateCredits(urls: string[]): number {
  let pages = 0
  for (const url of urls) {
    const kind = classifyUrl(url)
    if (kind === 'website') pages += 12
    else if (kind === 'amazon_storefront') pages += 1
    else if (kind === 'amazon_listing') pages += 1
  }
  return Math.round(pages * CREDITS_PER_PAGE * 100) / 100
}

export interface AnalyzeBrandResult {
  pages: BrandIntakePage[]
  profile: BrandIntakeProfile
  budget: BrandIntakeBudget
  /** 撞上封顶停下来的。界面上要说一句"分析到这儿就停了"。 */
  stopped_for_budget: boolean
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
  options: { capCredits?: number } = {},
): Promise<AnalyzeBrandResult> {
  const cap = options.capCredits ?? DEFAULT_BRAND_INTAKE_CAP_CREDITS
  const pages: BrandIntakePage[] = []
  let profile: BrandIntakeProfile = {}
  let spent = 0
  let stopped = false

  for (const url of urls) {
    if (spent >= cap) {
      stopped = true
      break
    }
    const kind = classifyUrl(url)
    if (kind === 'none') continue

    let got: { pages: BrandIntakePage[]; profile: BrandIntakeProfile }
    if (kind === 'website') {
      // 还剩多少页的预算，就最多抓多少页
      const affordable = Math.max(1, Math.floor((cap - spent) / CREDITS_PER_PAGE))
      got = await analyzeSite(doFetch, url, { maxPages: affordable })
    } else {
      const entry = classifyAmazonUrl(url)
      if (entry === undefined) continue
      got =
        entry.kind === 'amazon_listing'
          ? await analyzeAmazonListing(doFetch, url, entry)
          : await analyzeAmazonStorefront(doFetch, url, entry)
    }

    pages.push(...got.pages)
    /*
     * 合并方向是**先到的在前**：第一条链接通常是用户心里的主来源（官网），
     * 后面补的那些只填它没填上的格子。`mergeProfile` 里"改过的不动"那条
     * 在这里还用不上（都是机器填的），但用同一个函数省得两套规则。
     */
    profile = mergeProfile(profile, dropFilled(profile, got.profile))
    // 只有真抓着的页面才算钱
    spent = Math.round(pages.filter((p) => p.ok).length * CREDITS_PER_PAGE * 100) / 100
    if (spent >= cap) stopped = true
  }

  return {
    pages,
    profile,
    budget: {
      estimated_credits: estimateCredits(urls),
      cap_credits: cap,
      spent_credits: spent,
    },
    stopped_for_budget: stopped,
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
