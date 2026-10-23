/** 移植自 agentsws-extension `src/contents/utils/commerceSignals.ts` @ 57fca9c（源自 KOLAgents 旧插件 d25b877）。决策 1739 A：只搬采集器与指标算法；开源仓这一份只改 import 路径（与注释里点名私有插件 / 模板的几个词），本体逐字不动。 */
/**
 * 视频 / 帖子页上平台**自己打的**两个标识（WP130，本仓新写，旧插件没有）：
 *
 * - `paidPromotion`：「含付费推广」/「Paid partnership」——平台强制创作者声明的那一条；
 * - `shoppable`：带货入口——商品标签、购物车、商品货架。
 *
 * 它们随内容观测走（`paid_promotion` / `shoppable`，WP129 开的两格），登录了云账号就
 * 进公共库。**只报「看到了」**：看到就是 `true`；没看到**不报**（不写 `false`）。
 * 原因是这两个标识出现得不稳定——YouTube 的付费推广浮层只在播放头几秒出现、
 * 商品货架懒加载——「这一刻没看到」不等于「这条视频没有」，写 `false` 就是说错话。
 *
 * 只读页面上已经渲染出来的元素与文字，不请求、不滚动、不点开任何东西。
 * 选择器是按各平台 2026 年 9 月的公开页面结构写的**启发式**，平台改版会失灵——
 * 失灵的后果是「不报」，不会报错。
 */
import type { CapturePlatform } from "../kol/utils/creatorSnapshot.js"

export type CommerceSignals = {
  paidPromotion?: true
  shoppable?: true
}

/** 各平台「含付费推广」那条标识的元素。 */
const PAID_SELECTORS: Record<CapturePlatform, string[]> = {
  youtube: [
    "ytd-paid-content-overlay-renderer",
    ".ytp-paid-content-overlay",
    "yt-paid-content-overlay-view-model",
  ],
  tiktok: ['[data-e2e="video-ad-tag"]', '[data-e2e="paid-partnership-tag"]', '[data-e2e="branded-content-tag"]'],
  instagram: ['a[href*="/paid_partnership"]'],
}

/** 标识上的字（各平台中英两种界面语言）。只比**整段文字**，不在正文里搜——正文里说一句「这不是广告」不算。 */
const PAID_TEXTS = [
  /^includes paid promotion$/i,
  /^paid partnership(?: with .+)?$/i,
  /^paid promotion$/i,
  /^包含付费推广内容$/,
  /^含付费推广$/,
  /^付费合作(?:伙伴)?(?:[：:·\s].+)?$/,
  /^付费推广$/,
  // 不收「广告」「Ad」「Sponsored」：那是播放器里贴片广告的角标，不是创作者的推广声明
]

/** 各平台带货入口的元素。 */
const SHOP_SELECTORS: Record<CapturePlatform, string[]> = {
  youtube: [
    "ytd-merch-shelf-renderer",
    "ytd-product-list-item-renderer",
    "yt-shopping-product-card-view-model",
    ".ytp-featured-product",
    ".ytp-shopping-button",
  ],
  tiktok: [
    '[data-e2e="product-anchor"]',
    '[data-e2e="anchor-tag"][href*="product"]',
    'a[href*="/view/product/"]',
    'a[href*="shop.tiktok.com"]',
  ],
  instagram: ['a[href*="/shopping/product/"]', 'a[href*="/p/"][href*="product_id="]', '[aria-label="View products"]', '[aria-label="查看商品"]'],
}

/** 标识通常是几个字的短标签；长于这个的元素是正文段落，不看。 */
const LABEL_MAX = 60

function hasPaidLabel(root: ParentNode, platform: CapturePlatform): boolean {
  for (const selector of PAID_SELECTORS[platform]) {
    const el = root.querySelector(selector)
    if (el) return true
  }
  // 文字兜底：只看短小的叶子标签（span / a / div 里只有字的那种）
  for (const el of Array.from(root.querySelectorAll("span, a, div, p"))) {
    if (el.children.length > 0) continue
    const text = el.textContent?.replace(/\s+/g, " ").trim() ?? ""
    if (text === "" || text.length > LABEL_MAX) continue
    if (PAID_TEXTS.some((re) => re.test(text))) return true
  }
  return false
}

function hasShopEntry(root: ParentNode, platform: CapturePlatform): boolean {
  return SHOP_SELECTORS[platform].some((selector) => root.querySelector(selector) !== null)
}

export function readCommerceSignals(
  platform: CapturePlatform,
  root: ParentNode = document,
): CommerceSignals {
  return {
    ...(hasPaidLabel(root, platform) ? { paidPromotion: true as const } : {}),
    ...(hasShopEntry(root, platform) ? { shoppable: true as const } : {}),
  }
}

/** 给一份内容快照补上两个标识（读不到快照就原样回 null）。 */
export function withCommerceSignals<T extends object>(
  snapshot: T | null,
  platform: CapturePlatform,
  root: ParentNode = document,
): T | null {
  if (snapshot === null) return null
  return { ...snapshot, ...readCommerceSignals(platform, root) }
}
