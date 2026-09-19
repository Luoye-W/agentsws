/**
 * Amazon 那条路（70 §4.2）。
 *
 * **只抓公开页面**：一个 listing 页或一个店铺页，跟用户在浏览器里看到的
 * 是同一份 HTML。不登录、不用任何卖家 API、不碰 Seller Central。
 *
 * 与官网那条路的分工：
 *
 * | 贴进来的 | 拿到的 |
 * |---|---|
 * | 商品链接 / ASIN | 这一个 listing 的全部（标题、品牌、五点、价、评分、类目、变体） |
 * | 店铺链接 | 前 N 个商品的卡片（标题 + 价 + 图），**不逐个进 listing 页** |
 *
 * 第二行那个"不逐个进"是有意的：一个店铺 20 个商品就是 20 次请求，第一版
 * 档案根本用不上那么细。要细的，用户确认完之后再单独跑。
 *
 * **抓不到就说抓不到。** Amazon 会对机器人出验证码——出了就如实回
 * "Amazon 挡住了"，不绕、不重试、不编一份数据出来。
 */
import type { BrandIntakeProduct, BrandIntakeProfile } from '@agentsws/contracts'
import { BRAND_INTAKE_MAX_PRODUCTS, type BrandIntakePage } from '@agentsws/contracts'
import { field } from './field.js'
import { fetchPage, type PageFetch } from './fetch.js'
import { absolute, decodeEntities, jsonLdNodes, squash, visibleText } from './html.js'

/** 站点域名 → 国家码（长后缀在前，不然 `.com` 会先命中 `.com.au`）。 */
const HOST_COUNTRY: readonly [string, string][] = [
  ['amazon.com.au', 'AU'],
  ['amazon.com.mx', 'MX'],
  ['amazon.com.br', 'BR'],
  ['amazon.co.uk', 'GB'],
  ['amazon.co.jp', 'JP'],
  ['amazon.de', 'DE'],
  ['amazon.fr', 'FR'],
  ['amazon.it', 'IT'],
  ['amazon.es', 'ES'],
  ['amazon.ca', 'CA'],
  ['amazon.in', 'IN'],
  ['amazon.nl', 'NL'],
  ['amazon.se', 'SE'],
  ['amazon.com', 'US'],
]

export function countryOfHost(host: string): string | undefined {
  const lower = host.toLowerCase()
  return HOST_COUNTRY.find(([suffix]) => lower === suffix || lower.endsWith(`.${suffix}`))?.[1]
}

const ASIN_RE = /\/(?:dp|gp\/product|product)\/([A-Z0-9]{10})(?:[/?]|$)/i

export type AmazonEntry =
  | { kind: 'amazon_listing'; asin: string; country: string | undefined }
  | { kind: 'amazon_storefront'; country: string | undefined }

/** 这条链接是 listing 还是店铺。两个都不是就回 `undefined`（交给官网那条路）。 */
export function classifyAmazonUrl(url: string): AmazonEntry | undefined {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return undefined
  }
  const country = countryOfHost(u.hostname)
  if (country === undefined) return undefined
  const asin = ASIN_RE.exec(u.pathname)?.[1]
  if (asin !== undefined) return { kind: 'amazon_listing', asin: asin.toUpperCase(), country }
  if (/\/(stores|shops|s)\b/i.test(u.pathname) || u.searchParams.has('me'))
    return { kind: 'amazon_storefront', country }
  return undefined
}

/** 页面被验证码 / 机器人检测挡了。 */
export function isBlocked(html: string): boolean {
  return /captcha|api-services-support@amazon|Robot Check|Enter the characters you see/i.test(html)
}

/** 五点（`feature-bullets` 那一块里的 `<li>`）。 */
export function featureBullets(html: string): string[] {
  const block = /id=["']feature-bullets["'][\s\S]{0,8000}?<\/(?:div|ul)>/i.exec(html)?.[0]
  if (block === undefined) return []
  const out: string[] = []
  for (const m of block.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)) {
    const text = squash(decodeEntities((m[1] ?? '').replace(/<[^>]*>/g, ' ')))
    if (text !== '' && text.length > 3) out.push(text.slice(0, 300))
    if (out.length >= 5) break
  }
  return out
}

export interface AmazonIntakeResult {
  pages: BrandIntakePage[]
  profile: BrandIntakeProfile
}

/**
 * 一个 listing 页。
 *
 * 优先读 JSON-LD（Amazon 有时有），没有就退到页面上那几个**稳定了十几年**的
 * 元素 id（`productTitle`、`bylineInfo`、`acrPopover`）。这些 id 会变，变了
 * 这几格就抓不到——抓不到的那一格不出现，不猜。
 */
export async function analyzeAmazonListing(
  doFetch: PageFetch,
  url: string,
  entry: Extract<AmazonEntry, { kind: 'amazon_listing' }>,
): Promise<AmazonIntakeResult> {
  const pages: BrandIntakePage[] = []
  const profile: BrandIntakeProfile = {}
  const res = await fetchPage(doFetch, url)
  if (!res.ok) {
    pages.push({ url, kind: 'product', ok: false, ...(res.reason === undefined ? {} : { reason: res.reason }) })
    return { pages, profile }
  }
  if (isBlocked(res.html)) {
    pages.push({ url, kind: 'product', ok: false, reason: 'Amazon 把我们挡住了（验证码），这一条没抓着' })
    return { pages, profile }
  }
  pages.push({ url, kind: 'product', ok: true })
  const html = res.html

  const node = jsonLdNodes(html).find(
    (n) => typeof n['@type'] === 'string' && /product/i.test(n['@type'] as string),
  )
  const title =
    (typeof node?.name === 'string' ? squash(node.name) : undefined) ??
    textOfId(html, 'productTitle')
  const brand =
    (typeof node?.brand === 'object' && node.brand !== null
      ? squash(String((node.brand as Record<string, unknown>).name ?? ''))
      : undefined) ?? brandFromByline(html)

  if (brand !== undefined && brand !== '')
    profile.brand_name = field(brand, node?.brand === undefined ? 'selector' : 'jsonld', {
      url,
      locator: node?.brand === undefined ? 'selector:#bylineInfo' : 'jsonld:Product.brand',
      quote: brand,
    })

  const bullets = featureBullets(html)
  const price = priceOf(html)
  if (title !== undefined && title !== '') {
    const product: BrandIntakeProduct = {
      title: title.slice(0, 200),
      asin: entry.asin,
      url,
      ...(price === undefined ? {} : { price_snapshot: price }),
      ...(bullets.length === 0 ? {} : { selling_points: bullets }),
      ...(/twister|variationValues/i.test(html) ? { has_variants: true } : {}),
    }
    profile.products = field([product], 'selector', { url, locator: 'selector:#productTitle', quote: title })
  }

  const rating = Number(/([0-9.]+)\s*out of\s*5\s*stars/i.exec(html)?.[1] ?? Number.NaN)
  if (Number.isFinite(rating))
    profile.rating = field(rating, 'selector', { url, locator: 'selector:#acrPopover' })

  const reviews = Number(
    (/([\d,]+)\s*(?:ratings|reviews|global ratings)/i.exec(html)?.[1] ?? '').replace(/,/g, ''),
  )
  if (Number.isFinite(reviews) && reviews > 0)
    profile.reviews_count = field(reviews, 'selector', { url, locator: 'selector:#acrCustomerReviewText' })

  if (entry.country !== undefined)
    profile.markets = field([entry.country], 'selector', { url, locator: 'url:host' })

  const category = breadcrumbCategory(html)
  if (category !== undefined)
    profile.category = field(category, 'selector', {
      url,
      locator: 'selector:#wayfinding-breadcrumbs',
      quote: category,
    })

  return { pages, profile }
}

function textOfId(html: string, id: string): string | undefined {
  const re = new RegExp(`id=["']${id}["'][^>]*>([\\s\\S]{0,600}?)<\\/`, 'i')
  const raw = re.exec(html)?.[1]
  if (raw === undefined) return undefined
  const text = squash(decodeEntities(raw.replace(/<[^>]*>/g, ' ')))
  return text === '' ? undefined : text
}

function brandFromByline(html: string): string | undefined {
  const raw = textOfId(html, 'bylineInfo')
  if (raw === undefined) return undefined
  // "Visit the ACME Store" / "Brand: ACME" / "品牌: ACME"
  const m = /(?:Visit the\s+)?(.+?)(?:\s+Store)?$/i.exec(raw.replace(/^(?:Brand|品牌)\s*[:：]\s*/i, ''))
  return m?.[1]?.trim()
}

function priceOf(html: string): string | undefined {
  const whole = /class=["'][^"']*a-price-whole[^"']*["'][^>]*>([^<]+)</i.exec(html)?.[1]
  const symbol = /class=["'][^"']*a-price-symbol[^"']*["'][^>]*>([^<]+)</i.exec(html)?.[1]
  if (whole === undefined) return undefined
  return `${symbol ?? ''}${squash(decodeEntities(whole))}`
}

function breadcrumbCategory(html: string): string | undefined {
  const block = /id=["']wayfinding-breadcrumbs[^"']*["'][\s\S]{0,3000}?<\/div>/i.exec(html)?.[0]
  if (block === undefined) return undefined
  const parts: string[] = []
  for (const m of block.matchAll(/<a[^>]*>([\s\S]*?)<\/a>/gi)) {
    const t = squash(decodeEntities((m[1] ?? '').replace(/<[^>]*>/g, ' ')))
    if (t !== '') parts.push(t)
  }
  return parts.length === 0 ? undefined : parts.join(' › ').slice(0, 200)
}

/**
 * 一个店铺页：**只枚举卡片，不逐个进 listing**。
 *
 * 卡片上的 `data-asin` + 标题 + 价格已经够画出"主打商品"那一排缩略图了；
 * 要更细的等用户确认完档案再说。
 */
export async function analyzeAmazonStorefront(
  doFetch: PageFetch,
  url: string,
  entry: Extract<AmazonEntry, { kind: 'amazon_storefront' }>,
): Promise<AmazonIntakeResult> {
  const pages: BrandIntakePage[] = []
  const profile: BrandIntakeProfile = {}
  const res = await fetchPage(doFetch, url)
  if (!res.ok) {
    pages.push({ url, kind: 'collection', ok: false, ...(res.reason === undefined ? {} : { reason: res.reason }) })
    return { pages, profile }
  }
  if (isBlocked(res.html)) {
    pages.push({ url, kind: 'collection', ok: false, reason: 'Amazon 把我们挡住了（验证码），这一条没抓着' })
    return { pages, profile }
  }
  pages.push({ url, kind: 'collection', ok: true })

  const products = storefrontCards(res.html, url)
  if (products.length > 0)
    profile.products = field(products, 'selector', { url, locator: 'selector:[data-asin]' })
  if (entry.country !== undefined)
    profile.markets = field([entry.country], 'selector', { url, locator: 'url:host' })

  const heading = squash(visibleText(res.html, 200))
  if (heading !== '') profile.one_liner = field(heading.slice(0, 200), 'selector', { url, locator: 'selector:body', quote: heading })

  return { pages, profile }
}

/** 店铺页上那些 `data-asin` 卡片。 */
export function storefrontCards(html: string, base: string): BrandIntakeProduct[] {
  const out: BrandIntakeProduct[] = []
  const seen = new Set<string>()
  for (const m of html.matchAll(/data-asin=["']([A-Z0-9]{10})["']([\s\S]{0,4000}?)(?=data-asin=|$)/gi)) {
    const asin = (m[1] ?? '').toUpperCase()
    const block = m[2] ?? ''
    if (asin === '' || seen.has(asin)) continue
    const title =
      squash(decodeEntities((/<h2[^>]*>([\s\S]*?)<\/h2>/i.exec(block)?.[1] ?? '').replace(/<[^>]*>/g, ' '))) ||
      squash(decodeEntities(/alt=["']([^"']{4,200})["']/i.exec(block)?.[1] ?? ''))
    if (title === '') continue
    seen.add(asin)
    const img = /<img[^>]+src=["']([^"']+)["']/i.exec(block)?.[1]
    const price = priceOf(block)
    out.push({
      title: title.slice(0, 200),
      asin,
      ...(price === undefined ? {} : { price_snapshot: price }),
      ...(img === undefined ? {} : { image_url: absolute(img, base) ?? img }),
    })
    if (out.length >= BRAND_INTAKE_MAX_PRODUCTS) break
  }
  return out
}
