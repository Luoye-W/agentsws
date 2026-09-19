/**
 * 官网那条路（70 §4.1）。
 *
 * **抓哪几个页面**，以及为什么就这几个：
 *
 * | 页面 | 为什么非它不可 |
 * |---|---|
 * | 首页 | 品牌名、logo、主色、一句话定位、社媒链接，八成都在这一页 |
 * | 关于 | 一句话定位与口吻样例最好的来源（首页是广告词，关于页是人话） |
 * | 联系 | 客服邮箱 |
 * | 政策页 ×4 | 退换货 / 物流 / 保修 —— 客服岗第一天就要用 |
 * | 商品页 ×N | 主打商品、币种、价格 |
 *
 * **政策页要硬探，不能只信 sitemap**：Shopify 的 `sitemap.xml` 里**没有**
 * `/policies/*`，但那几条固定路径全都 200。只从 sitemap 走一遍的结果是
 * 一条政策知识都建不起来——而那恰恰是客服岗最要的东西。
 *
 * 探政策页有一个坑：Shopify 会把**已删掉**的 `/policies/xxx` 302 回首页。
 * 跟着跳的话，我们会把首页正文当成退换货政策存进知识库。所以这里判定一条
 * 政策页"存在"的标准不是状态码，而是**内容自己得像一份政策**（够长、且
 * 命中政策词）——见 {@link looksLikePolicy}。
 */
import {
  BRAND_INTAKE_MAX_PAGES,
  BRAND_INTAKE_MAX_PRODUCTS,
  type BrandIntakePage,
  type BrandIntakePolicy,
  type BrandIntakeProduct,
  type BrandIntakeProfile,
  type BrandIntakeSocialLink,
  type StorefrontPlatform,
} from '@agentsws/contracts'
import { field, type IntakeLayer } from './field.js'
import { fetchPage, fetchRobots, isDisallowed, type PageFetch } from './fetch.js'
import {
  absolute,
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

/** Shopify / 自建页两套约定（KefuAgent 那边按真站验过的顺序）。 */
export const POLICY_PROBE_PATHS: readonly { path: string; kind: BrandIntakePolicy['kind'] }[] = [
  { path: '/policies/refund-policy', kind: 'refund' },
  { path: '/policies/shipping-policy', kind: 'shipping' },
  { path: '/policies/terms-of-service', kind: 'terms' },
  { path: '/policies/privacy-policy', kind: 'privacy' },
  { path: '/pages/warranty', kind: 'warranty' },
]

/** 关于 / 联系页的常见路径。 */
const ABOUT_PATHS = ['/pages/about', '/about', '/about-us', '/pages/about-us']
const CONTACT_PATHS = ['/pages/contact', '/contact', '/contact-us', '/pages/contact-us']

/** 一份政策至少得有这么长，且命中一个政策词。 */
const POLICY_MIN_CHARS = 200
const POLICY_WORDS =
  /refund|return|exchange|shipping|deliver|warranty|privacy|terms|退货|退款|换货|运费|物流|配送|保修|隐私|条款/i

/**
 * 这一页真的是政策页吗。
 *
 * **不看状态码，看内容**：Shopify 把删掉的政策 302 回首页，那一跳是 200，
 * 首页正文也够长——唯一分得开的办法是问"这段话像不像一份政策"。
 */
export function looksLikePolicy(text: string): boolean {
  return text.length >= POLICY_MIN_CHARS && POLICY_WORDS.test(text)
}

/** 认得出来的社媒域名 → 平台名。认不出来的照样留着，`platform` 记 `other`。 */
const SOCIAL_HOSTS: readonly [RegExp, string][] = [
  [/(^|\.)instagram\.com$/i, 'instagram'],
  [/(^|\.)facebook\.com$/i, 'facebook'],
  [/(^|\.)tiktok\.com$/i, 'tiktok'],
  [/(^|\.)youtube\.com$/i, 'youtube'],
  [/(^|\.)(twitter|x)\.com$/i, 'x'],
  [/(^|\.)pinterest\.com$/i, 'pinterest'],
  [/(^|\.)linkedin\.com$/i, 'linkedin'],
  [/(^|\.)weibo\.com$/i, 'weibo'],
  [/(^|\.)xiaohongshu\.com$/i, 'xiaohongshu'],
]

/**
 * 建站平台。
 *
 * 看的是**页面自己漏出来的那几样**，不是猜路径：Shopify 的页面上一定有
 * `cdn.shopify.com` 与 `Shopify.theme`；WooCommerce 一定带 `woocommerce`
 * 的 class 或 `wp-content/plugins/woocommerce`。
 *
 * 认不出来回 `undefined` 而不是 `'other'`——`'other'` 是用户自己选的一个答案，
 * 我们没资格替他选。
 */
export function detectPlatform(html: string): { platform: StorefrontPlatform; hint: string } | undefined {
  if (/cdn\.shopify\.com|Shopify\.theme|shopify-section/i.test(html))
    return { platform: 'shopify', hint: 'cdn.shopify.com' }
  if (/woocommerce|wp-content\/plugins\/woocommerce/i.test(html))
    return { platform: 'woocommerce', hint: 'woocommerce' }
  if (/\/skin\/frontend\/|Magento_|mage\/cookies/i.test(html))
    return { platform: 'magento', hint: 'Magento' }
  return undefined
}

/** 从 JSON-LD 的 `Product` 节点上取一张商品卡。 */
function productFromJsonLd(node: Record<string, unknown>, url: string): BrandIntakeProduct | undefined {
  const title = typeof node.name === 'string' ? squash(node.name) : undefined
  if (title === undefined || title === '') return undefined
  const offers = node.offers
  const offer = Array.isArray(offers) ? offers[0] : offers
  const o = typeof offer === 'object' && offer !== null ? (offer as Record<string, unknown>) : {}
  const price = o.price
  const currency = o.priceCurrency
  const image = firstImage(node.image)
  return {
    title: title.slice(0, 200),
    ...(typeof price === 'string' || typeof price === 'number'
      ? { price_snapshot: String(price) }
      : {}),
    ...(typeof currency === 'string' ? { currency } : {}),
    ...(image === undefined ? {} : { image_url: image }),
    url,
    ...(node.hasVariant !== undefined ? { has_variants: true } : {}),
  }
}

function firstImage(image: unknown): string | undefined {
  if (typeof image === 'string') return image
  if (Array.isArray(image)) return firstImage(image[0])
  if (typeof image === 'object' && image !== null) {
    const url = (image as Record<string, unknown>).url
    if (typeof url === 'string') return url
  }
  return undefined
}

/** logo：`Organization.logo` → `og:image` 之外的 icon 链（og:image 是分享banner，不是 logo）。 */
function logoOf(html: string, base: string): { url: string; layer: IntakeLayer } | undefined {
  for (const node of jsonLdNodes(html)) {
    if (!isType(node, /organization|brand/i)) continue
    const logo = firstImage(node.logo)
    const abs = logo === undefined ? undefined : absolute(logo, base)
    if (abs !== undefined) return { url: abs, layer: 'jsonld' }
  }
  const icon = linkHref(html, /apple-touch-icon|^icon$|shortcut icon/i)
  const abs = icon === undefined ? undefined : absolute(icon, base)
  return abs === undefined ? undefined : { url: abs, layer: 'selector' }
}

export interface SiteIntakeResult {
  pages: BrandIntakePage[]
  profile: BrandIntakeProfile
}

/**
 * 跑一遍官网。
 *
 * **顺序是故意的**：先首页（它决定了后面还值不值得抓），再关于 / 联系，
 * 再政策，最后商品。页面预算（{@link BRAND_INTAKE_MAX_PAGES}）用完就停在
 * 那儿——已经抓到的照样交，不会因为没抓完就什么都不给。
 */
export async function analyzeSite(
  doFetch: PageFetch,
  entryUrl: string,
  options: { maxPages?: number } = {},
): Promise<SiteIntakeResult> {
  const maxPages = options.maxPages ?? BRAND_INTAKE_MAX_PAGES
  const base = new URL(entryUrl)
  const origin = base.origin
  const disallow = await fetchRobots(doFetch, origin)
  const pages: BrandIntakePage[] = []
  const profile: BrandIntakeProfile = {}

  const get = async (
    url: string,
    kind: BrandIntakePage['kind'],
  ): Promise<string | undefined> => {
    if (pages.length >= maxPages) return undefined
    const path = new URL(url).pathname
    if (isDisallowed(path, disallow)) {
      pages.push({ url, kind, ok: false, reason: 'robots.txt 不让抓这一页' })
      return undefined
    }
    const res = await fetchPage(doFetch, url)
    pages.push({
      url,
      kind,
      ok: res.ok,
      ...(res.reason === undefined ? {} : { reason: res.reason }),
    })
    return res.ok ? res.html : undefined
  }

  // ── 首页 ────────────────────────────────────────────────────────────
  const home = await get(entryUrl, 'home')
  if (home === undefined) return { pages, profile }

  const org = jsonLdNodes(home).find((n) => isType(n, /organization|brand|onlinestore/i))
  const siteName =
    (typeof org?.name === 'string' ? squash(org.name) : undefined) ??
    metaContent(home, 'og:site_name')
  if (siteName !== undefined && siteName !== '') {
    profile.brand_name = field(
      siteName,
      org?.name === undefined ? 'og' : 'jsonld',
      { url: entryUrl, locator: org?.name === undefined ? 'og:site_name' : 'jsonld:Organization.name', quote: siteName },
    )
  }
  const legal = typeof org?.legalName === 'string' ? squash(org.legalName) : undefined
  if (legal !== undefined && legal !== '')
    profile.legal_name = field(legal, 'jsonld', {
      url: entryUrl,
      locator: 'jsonld:Organization.legalName',
      quote: legal,
    })

  const logo = logoOf(home, entryUrl)
  if (logo !== undefined)
    profile.logo_url = field(logo.url, logo.layer, { url: entryUrl, locator: `${logo.layer}:logo` })

  const color = themeColor(home)
  if (color !== undefined)
    profile.primary_color = field(color, 'selector', { url: entryUrl, locator: 'meta:theme-color', quote: color })

  const tagline = metaContent(home, 'og:description') ?? metaContent(home, 'description')
  if (tagline !== undefined)
    profile.one_liner = field(squash(tagline).slice(0, 200), 'og', {
      url: entryUrl,
      locator: 'og:description',
      quote: tagline,
    })

  const locale = metaContent(home, 'og:locale')
  if (locale !== undefined)
    profile.languages = field([locale.replace('_', '-')], 'og', {
      url: entryUrl,
      locator: 'og:locale',
      quote: locale,
    })

  const platform = detectPlatform(home)
  if (platform !== undefined)
    profile.storefront_platform = field(platform.platform, 'selector', {
      url: entryUrl,
      locator: `page:${platform.hint}`,
      quote: platform.hint,
    })

  // 社媒：首页上指向那几个域的链接
  const socials = new Map<string, BrandIntakeSocialLink>()
  for (const href of hrefs(home)) {
    const abs = absolute(href, entryUrl)
    if (abs === undefined) continue
    let host: string
    try {
      host = new URL(abs).hostname
    } catch {
      continue
    }
    const hit = SOCIAL_HOSTS.find(([re]) => re.test(host))
    if (hit === undefined) continue
    if (!socials.has(abs)) socials.set(abs, { platform: hit[1], url: abs })
  }
  if (socials.size > 0)
    profile.social_links = field([...socials.values()], 'selector', {
      url: entryUrl,
      locator: 'selector:a[href]',
    })

  // ── 关于（一句话定位与口吻样例最好的来源）─────────────────────────
  for (const path of ABOUT_PATHS) {
    const html = await get(`${origin}${path}`, 'about')
    if (html === undefined) continue
    const text = visibleText(html, 2000)
    if (text.length < 80) continue
    profile.tone_samples = field([text.slice(0, 400)], 'selector', {
      url: `${origin}${path}`,
      locator: 'selector:body',
      quote: text,
    })
    break
  }

  // ── 联系（客服邮箱）──────────────────────────────────────────────
  for (const path of CONTACT_PATHS) {
    const html = await get(`${origin}${path}`, 'contact')
    if (html === undefined) continue
    const mail = /mailto:([^"'?\s>]+@[^"'?\s>]+)/i.exec(html)?.[1]
    if (mail === undefined) continue
    profile.support_email = field(mail.toLowerCase(), 'selector', {
      url: `${origin}${path}`,
      locator: 'selector:a[href^=mailto]',
      quote: mail,
    })
    break
  }

  // ── 政策（硬探那几条固定路径）────────────────────────────────────
  const policies: BrandIntakePolicy[] = []
  for (const probe of POLICY_PROBE_PATHS) {
    const url = `${origin}${probe.path}`
    const html = await get(url, 'policy')
    if (html === undefined) continue
    const text = visibleText(html, 4000)
    // 内容说了算：302 回首页的那种在这里被挡掉
    if (!looksLikePolicy(text)) continue
    policies.push({ kind: probe.kind, summary: text.slice(0, 300), url })
  }
  if (policies.length > 0)
    profile.policies = field(policies, 'selector', { url: origin, locator: 'probe:/policies/*' })

  // ── 商品（首页上的商品链接，取前 N 个）──────────────────────────
  const productUrls: string[] = []
  for (const href of hrefs(home)) {
    const abs = absolute(href, entryUrl)
    if (abs === undefined) continue
    if (!/\/products?\//i.test(abs)) continue
    if (new URL(abs).origin !== origin) continue
    if (!productUrls.includes(abs)) productUrls.push(abs)
    if (productUrls.length >= BRAND_INTAKE_MAX_PRODUCTS) break
  }
  const products: BrandIntakeProduct[] = []
  for (const url of productUrls) {
    const html = await get(url, 'product')
    if (html === undefined) continue
    const node = jsonLdNodes(html).find((n) => isType(n, /product/i))
    const card = node === undefined ? undefined : productFromJsonLd(node, url)
    if (card === undefined) continue
    products.push(card)
  }
  if (products.length > 0) {
    profile.products = field(products, 'jsonld', { url: origin, locator: 'jsonld:Product' })
    const currency = products.find((p) => p.currency !== undefined)?.currency
    if (currency !== undefined)
      profile.currency = field(currency, 'jsonld', {
        url: products[0]?.url ?? origin,
        locator: 'jsonld:Offer.priceCurrency',
        quote: currency,
      })
  }

  // 品牌名一个都没取到的时候，退到 `<title>`（把握度只能是 medium）
  if (profile.brand_name === undefined) {
    const title = titleOf(home)
    if (title !== undefined && title !== '')
      profile.brand_name = field(title.split(/[|–—-]/)[0]?.trim() ?? title, 'selector', {
        url: entryUrl,
        locator: 'selector:title',
        quote: title,
      })
  }

  return { pages, profile }
}
