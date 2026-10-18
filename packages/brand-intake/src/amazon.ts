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
import type {
  BrandIntakeProduct,
  BrandIntakeProductSpec,
  BrandIntakeProfile,
  CatalogBsr,
} from '@agentsws/contracts'
import { BRAND_INTAKE_MAX_PRODUCTS, type BrandIntakePage } from '@agentsws/contracts'
import { fetchPage, type PageFetch } from './fetch.js'
import { field } from './field.js'
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
  // WP394：docs/106 目标站点补齐（与 `amz/store.yml` 的 `browser_scope` 对得上）；长后缀仍在 `.com` 前
  ['amazon.com.be', 'BE'],
  ['amazon.com.tr', 'TR'],
  ['amazon.pl', 'PL'],
  ['amazon.ae', 'AE'],
  ['amazon.sa', 'SA'],
  ['amazon.eg', 'EG'],
  ['amazon.sg', 'SG'],
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
    pages.push({
      url,
      kind: 'product',
      ok: false,
      ...(res.reason === undefined ? {} : { reason: res.reason }),
    })
    return { pages, profile }
  }
  if (isBlocked(res.html)) {
    pages.push({
      url,
      kind: 'product',
      ok: false,
      reason: 'Amazon 把我们挡住了（验证码），这一条没抓着',
    })
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
  const listPrice = amazonListPrice(html)
  const specs = amazonSpecs(html)
  if (title !== undefined && title !== '') {
    const product: BrandIntakeProduct = {
      title: title.slice(0, 200),
      asin: entry.asin,
      url,
      ...(price === undefined ? {} : { price_snapshot: price }),
      ...(bullets.length === 0 ? {} : { selling_points: bullets }),
      ...(/twister|variationValues/i.test(html) ? { has_variants: true } : {}),
      // WP346：划线价（List Price / Typical price）与售价分开；规格表
      ...(listPrice !== undefined && price !== undefined && listPrice !== price
        ? { list_price_snapshot: listPrice, sale_price_snapshot: price }
        : {}),
      ...(specs.length === 0 ? {} : { specs }),
    }
    profile.products = field([product], 'selector', {
      url,
      locator: 'selector:#productTitle',
      quote: title,
    })
  }

  const rating = Number(/([0-9.]+)\s*out of\s*5\s*stars/i.exec(html)?.[1] ?? Number.NaN)
  if (Number.isFinite(rating))
    profile.rating = field(rating, 'selector', { url, locator: 'selector:#acrPopover' })

  const reviews = Number(
    (/([\d,]+)\s*(?:ratings|reviews|global ratings)/i.exec(html)?.[1] ?? '').replace(/,/g, ''),
  )
  if (Number.isFinite(reviews) && reviews > 0)
    profile.reviews_count = field(reviews, 'selector', {
      url,
      locator: 'selector:#acrCustomerReviewText',
    })

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
  const m = /(?:Visit the\s+)?(.+?)(?:\s+Store)?$/i.exec(
    raw.replace(/^(?:Brand|品牌)\s*[:：]\s*/i, ''),
  )
  return m?.[1]?.trim()
}

function priceOf(html: string): string | undefined {
  const whole = /class=["'][^"']*a-price-whole[^"']*["'][^>]*>([^<]+)</i.exec(html)?.[1]
  const symbol = /class=["'][^"']*a-price-symbol[^"']*["'][^>]*>([^<]+)</i.exec(html)?.[1]
  if (whole === undefined) return undefined
  return `${symbol ?? ''}${squash(decodeEntities(whole))}`
}

/**
 * WP346：划线价。Amazon 把它放在 `a-text-price`（带 `data-a-strike`）里那个 `a-offscreen`：
 * 「List Price: $59.99」「Typical price」。没有就是没打折。
 */
export function amazonListPrice(html: string): string | undefined {
  const m =
    /class=["'][^"']*a-text-price[^"']*["'][^>]*data-a-strike=["']true["'][^>]*>\s*<span[^>]*class=["'][^"']*a-offscreen[^"']*["'][^>]*>([^<]+)</i.exec(
      html,
    ) ??
    /id=["']listPrice["'][^>]*>([^<]+)</i.exec(html) ??
    /class=["'][^"']*basisPrice[^"']*["'][\s\S]{0,400}?class=["'][^"']*a-offscreen[^"']*["'][^>]*>([^<]+)</i.exec(
      html,
    )
  const v = m?.[1] === undefined ? undefined : squash(decodeEntities(m[1]))
  return v === undefined || v === '' ? undefined : v
}

/**
 * WP346：规格。商品概览（`productOverview_feature_div`）与技术参数表（`productDetails_techSpec_*`）
 * 里的一行行「名 / 值」。最多 12 条。
 */
export function amazonSpecs(html: string): BrandIntakeProductSpec[] {
  const out: BrandIntakeProductSpec[] = []
  const blocks = [
    /id=["']productOverview_feature_div["'][\s\S]*?<\/table>/i.exec(html)?.[0],
    /id=["']productDetails_techSpec_section_1["'][\s\S]*?<\/table>/i.exec(html)?.[0],
  ]
  const clean = (s: string): string => squash(decodeEntities(s.replace(/<[^>]*>/g, ' ')))
  for (const block of blocks) {
    if (block === undefined) continue
    for (const row of block.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...(row[1] ?? '').matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((c) =>
        clean(c[1] ?? ''),
      )
      const [name, value] = cells
      if (name === undefined || value === undefined || name === '' || value === '') continue
      if (out.some((x) => x.name === name)) continue
      out.push({
        name: name.slice(0, 40),
        value: value
          .replace(/\u200e|&lrm;/g, '')
          .trim()
          .slice(0, 80),
      })
      if (out.length >= 12) return out
    }
  }
  return out
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
    pages.push({
      url,
      kind: 'collection',
      ok: false,
      ...(res.reason === undefined ? {} : { reason: res.reason }),
    })
    return { pages, profile }
  }
  if (isBlocked(res.html)) {
    pages.push({
      url,
      kind: 'collection',
      ok: false,
      reason: 'Amazon 把我们挡住了（验证码），这一条没抓着',
    })
    return { pages, profile }
  }
  pages.push({ url, kind: 'collection', ok: true })

  const products = storefrontCards(res.html, url)
  if (products.length > 0)
    profile.products = field(products, 'selector', { url, locator: 'selector:[data-asin]' })
  if (entry.country !== undefined)
    profile.markets = field([entry.country], 'selector', { url, locator: 'url:host' })

  const heading = squash(visibleText(res.html, 200))
  if (heading !== '')
    profile.one_liner = field(heading.slice(0, 200), 'selector', {
      url,
      locator: 'selector:body',
      quote: heading,
    })

  return { pages, profile }
}

/** 店铺页上那些 `data-asin` 卡片。 */
export function storefrontCards(html: string, base: string): BrandIntakeProduct[] {
  const out: BrandIntakeProduct[] = []
  const seen = new Set<string>()
  for (const m of html.matchAll(
    /data-asin=["']([A-Z0-9]{10})["']([\s\S]{0,4000}?)(?=data-asin=|$)/gi,
  )) {
    const asin = (m[1] ?? '').toUpperCase()
    const block = m[2] ?? ''
    if (asin === '' || seen.has(asin)) continue
    const title =
      squash(
        decodeEntities(
          (/<h2[^>]*>([\s\S]*?)<\/h2>/i.exec(block)?.[1] ?? '').replace(/<[^>]*>/g, ' '),
        ),
      ) || squash(decodeEntities(/alt=["']([^"']{4,200})["']/i.exec(block)?.[1] ?? ''))
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

/* ── WP394（docs/104 一期 B、docs/106 §13 A9）：读 Amazon 前台的积木——站点、地址、商品页那几格 ─────────
 *
 * 这一段只认 HTML / JSON 原文（谁去打开页面、带什么身份、被拦了怎么办在 `amazon-watch.ts` 与服务端读页那一块）。
 * WP396（自家 Listing 体检）、WP398（词库）直接用这里的函数，不另写一份。读不到的格子不出现，不猜。
 */

/** Amazon 的图片 / 脚本资源域（内置浏览器对它们的请求也自报 Agent 身份）。 */
export const AMAZON_RESOURCE_HOSTS: readonly string[] = [
  'media-amazon.com',
  'ssl-images-amazon.com',
  'images-amazon.com',
  'amazon-adsystem.com',
]

/** 各站域名后缀（`amazon.com`、`amazon.co.uk`…）。 */
export const AMAZON_SITE_HOSTS: readonly string[] = HOST_COUNTRY.map(([suffix]) => suffix)

/** 这个主机名是不是 Amazon 的（各站前台、联想词、资源域都算）。 */
export function isAmazonHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '')
  return [...AMAZON_SITE_HOSTS, ...AMAZON_RESOURCE_HOSTS].some(
    (suffix) => h === suffix || h.endsWith(`.${suffix}`),
  )
}

/** 站点国家码 → 前台域名（`US` → `www.amazon.com`；`UK` 当 `GB`）。认不出回 `undefined`。 */
export function amazonHostOfMarket(marketplace: string): string | undefined {
  const mk = marketplace.trim().toUpperCase()
  const cc = mk === 'UK' ? 'GB' : mk
  const hit = HOST_COUNTRY.find(([, c]) => c === cc)
  return hit === undefined ? undefined : `www.${hit[0]}`
}

export function amazonProductUrlOf(marketplace: string, asin: string): string | undefined {
  const host = amazonHostOfMarket(marketplace)
  return host === undefined ? undefined : `https://${host}/dp/${asin.trim().toUpperCase()}`
}

export function amazonSearchUrlOf(marketplace: string, query: string): string | undefined {
  const host = amazonHostOfMarket(marketplace)
  return host === undefined ? undefined : `https://${host}/s?k=${encodeURIComponent(query.trim())}`
}

/** 站点 → 那个站标价用的币种（读到的对不上 = 配送地址没设对，这次读数作废）。 */
const MARKET_CURRENCY: Readonly<Record<string, string>> = {
  US: 'USD',
  CA: 'CAD',
  MX: 'MXN',
  BR: 'BRL',
  GB: 'GBP',
  UK: 'GBP',
  DE: 'EUR',
  FR: 'EUR',
  IT: 'EUR',
  ES: 'EUR',
  NL: 'EUR',
  BE: 'EUR',
  SE: 'SEK',
  PL: 'PLN',
  TR: 'TRY',
  AE: 'AED',
  SA: 'SAR',
  EG: 'EGP',
  IN: 'INR',
  JP: 'JPY',
  AU: 'AUD',
  SG: 'SGD',
}

export function amazonMarketCurrency(marketplace: string): string | undefined {
  return MARKET_CURRENCY[marketplace.trim().toUpperCase()]
}

/** 价格文字里的币种（`$1,599.00` → USD；`CDN$ 1,299` → CAD）。认不出不给。 */
export function currencyOfAmazonPrice(text: string): string | undefined {
  const t = text.trim()
  if (/^(?:CDN\$|CA\$|C\$)/i.test(t)) return 'CAD'
  if (/^(?:A\$|AU\$)/i.test(t)) return 'AUD'
  if (/^(?:MX\$)/i.test(t)) return 'MXN'
  if (/^(?:S\$)/i.test(t)) return 'SGD'
  if (/^R\$/i.test(t)) return 'BRL'
  if (/^(?:US)?\$/.test(t)) return 'USD'
  if (/£/.test(t)) return 'GBP'
  if (/€|\bEUR\b/.test(t)) return 'EUR'
  if (/[¥￥]|\bJPY\b/.test(t)) return 'JPY'
  if (/₹/.test(t)) return 'INR'
  if (/\bkr\b|\bSEK\b/i.test(t)) return 'SEK'
  if (/zł|\bPLN\b/i.test(t)) return 'PLN'
  if (/\bAED\b/.test(t)) return 'AED'
  if (/\bSAR\b/.test(t)) return 'SAR'
  if (/\bEGP\b/.test(t)) return 'EGP'
  if (/₺|\bTL\b/.test(t)) return 'TRY'
  return undefined
}

/**
 * 价格文字 → 数（主币种单位）。`$1,599.00` → 1599；`1.599,99 €` → 1599.99；`￥12,800` → 12800。
 * 认不出回 `undefined`。
 */
export function amazonMoney(text: string): { value: number; currency?: string } | undefined {
  const raw = squash(decodeEntities(text))
  const digits = /\d[\d.,\s  ]*/.exec(raw)?.[0]?.replace(/[\s  ]/g, '')
  if (digits === undefined || digits === '') return undefined
  const lastDot = digits.lastIndexOf('.')
  const lastComma = digits.lastIndexOf(',')
  const decimalAt = Math.max(lastDot, lastComma)
  // 最后一个分隔符后面正好 1–2 位 = 小数点；否则都是千分位
  const isDecimal = decimalAt >= 0 && digits.length - decimalAt - 1 <= 2
  const whole = (isDecimal ? digits.slice(0, decimalAt) : digits).replace(/[.,]/g, '')
  const frac = isDecimal ? digits.slice(decimalAt + 1) : ''
  const value = Number(frac === '' ? whole : `${whole}.${frac}`)
  if (!Number.isFinite(value)) return undefined
  const currency = currencyOfAmazonPrice(raw)
  return currency === undefined ? { value } : { value, currency }
}

const stripTags = (s: string): string => squash(decodeEntities(s.replace(/<[^>]*>/g, ' ')))

/** 某个 id 起头的那一段原文（最多 `max` 字）。 */
function sliceOfId(html: string, id: string, max: number): string | undefined {
  const at = html.search(new RegExp(`id=["']${id}["']`, 'i'))
  return at < 0 ? undefined : html.slice(at, at + max)
}

/**
 * Amazon 的人机验证页（「Enter the characters you see below」/ `validateCaptcha` 表单 / Robot Check）。
 * 比 {@link isBlocked} 窄：商品页脚本里偶尔带 `captcha` 字样，不能凭那一个词就当被拦。
 */
export function isAmazonChallenge(html: string): boolean {
  return (
    /action=["'][^"']*validateCaptcha/i.test(html) ||
    /Enter the characters you see below|Type the characters you see in this image/i.test(html) ||
    /<title>\s*Robot Check\s*<\/title>/i.test(html) ||
    /api-services-support@amazon\.com/i.test(html) ||
    /To discuss automated access to Amazon data/i.test(html)
  )
}

/** 「找不到这一页」（ASIN 下架 / 写错）。 */
export function isAmazonMissingPage(html: string): boolean {
  return /<title>\s*(?:Page Not Found|Amazon\.[a-z.]+ Page Not Found)|Sorry! We couldn'?t find that page|looking for something\?\s*<\/b>/i.test(
    html,
  )
}

/** 现价（买框那一块里第一个不是划线价的 `a-price` → `a-offscreen`；退到 `a-price-whole` 拼）。 */
export function amazonPriceText(html: string): string | undefined {
  const core =
    sliceOfId(html, 'corePriceDisplay_desktop_feature_div', 8000) ??
    sliceOfId(html, 'corePrice_feature_div', 8000) ??
    sliceOfId(html, 'apex_desktop', 8000) ??
    html
  const off =
    /class=["'](?![^"']*a-text-price)[^"']*\ba-price\b[^"']*["'][^>]*>\s*<span[^>]*class=["'][^"']*a-offscreen[^"']*["'][^>]*>([^<]+)</i.exec(
      core,
    )?.[1]
  if (off !== undefined && stripTags(off) !== '') return stripTags(off)
  const whole = /class=["'][^"']*a-price-whole[^"']*["'][^>]*>([^<]+)</i.exec(core)?.[1]
  if (whole === undefined) return undefined
  const symbol = /class=["'][^"']*a-price-symbol[^"']*["'][^>]*>([^<]+)</i.exec(core)?.[1]
  const fraction = /class=["'][^"']*a-price-fraction[^"']*["'][^>]*>([^<]+)</i.exec(core)?.[1]
  const w = stripTags(whole).replace(/[.,]$/, '')
  return `${stripTags(symbol ?? '')}${w}${fraction === undefined ? '' : `.${stripTags(fraction)}`}`
}

/** 优惠券那一句（`Apply $100 coupon` / `Save 10% with coupon`）；没有不给。 */
export function amazonCoupon(html: string): string | undefined {
  const scope =
    sliceOfId(html, 'promoPriceBlockMessage_feature_div', 6000) ??
    sliceOfId(html, 'vpcButton', 3000) ??
    html
  const m =
    /(?:id=["']couponText[^"']*["']|class=["'][^"']*couponLabelText[^"']*["'])[^>]*>([\s\S]{0,300}?)<\/(?:label|span)>/i.exec(
      scope,
    )?.[1] ?? /((?:Apply|Save)\s[^<]{1,40}?coupon)/i.exec(scope)?.[1]
  if (m === undefined) return undefined
  const text = stripTags(m).replace(/\s*(?:Terms|Shop items)\s*$/i, '')
  return text === '' ? undefined : text.slice(0, 120)
}

/**
 * BSR（「Best Sellers Rank」）：详情区要点列表（`detailBullets`）或参数表（`productDetails_*`）里那一格，
 * 第一项是大类，其余是小类。读不到回空数组。
 */
export function amazonBsr(html: string): CatalogBsr[] {
  const at = html.search(/Best\s*Sellers\s*Rank|Amazon Bestseller|Amazon Best Sellers Rank/i)
  if (at < 0) return []
  const block = html.slice(at, at + 4000)
  const end = block.search(
    /<\/(?:td|tr)>|<li[^>]*>\s*<span[^>]*>\s*<span[^>]*class=["'][^"']*a-text-bold/i,
  )
  const text = stripTags(end > 0 ? block.slice(0, end) : block)
  const out: CatalogBsr[] = []
  for (const m of text.matchAll(/#\s?([\d.,]+)\s+in\s+([^#(]+?)(?=\s*\(|\s*#|$)/gi)) {
    const rank = Number((m[1] ?? '').replace(/[.,]/g, ''))
    const category = squash(m[2] ?? '').replace(/[:;,.]+$/, '')
    if (!Number.isFinite(rank) || rank <= 0 || category === '') continue
    if (out.some((x) => x.category === category)) continue
    out.push({ rank, category: category.slice(0, 120) })
    if (out.length >= 4) break
  }
  return out
}

/** 有没有货：`#availability` 那一句；`#outOfStock` 块在就是没货。读不到不给。 */
export function amazonAvailable(html: string): boolean | undefined {
  if (/id=["']outOfStock["']/i.test(html)) return false
  const raw = /id=["']availability["'][^>]*>([\s\S]{0,800}?)<\/div>/i.exec(html)?.[1]
  const text = raw === undefined ? '' : stripTags(raw)
  if (/currently unavailable|out of stock|temporarily out of stock|not available/i.test(text))
    return false
  if (/in stock|only \d+ left|usually ships|available to ship/i.test(text)) return true
  if (/id=["']add-to-cart-button["']/i.test(html)) return true
  return undefined
}

/** 页面写着「这件不能配送到你选的地址」。 */
export function amazonUndeliverable(html: string): boolean {
  return /cannot be shipped to your selected delivery location|doesn'?t ship to your selected|exports_desktop_undeliverable/i.test(
    html,
  )
}

/** 页头「配送到」那一行（`New York 10001` / `Canada`）。 */
export function amazonDeliverTo(html: string): string | undefined {
  const raw = /id=["']glow-ingress-line2["'][^>]*>([^<]{1,120})</i.exec(html)?.[1]
  const text = raw === undefined ? '' : stripTags(raw)
  return text === '' ? undefined : text
}

/** 一页商品页读到的（读不到的格子不出现）。 */
export interface AmazonProductFacts {
  asin: string
  url?: string
  title?: string
  brand?: string
  image?: string
  /** 现价原文（`$1,599.00`）与数。 */
  price_text?: string
  price?: number
  currency?: string
  /** 划线价（List Price / Was / Typical price）。 */
  list_price?: number
  coupon?: string
  rating?: number
  reviews?: number
  /** 第一项大类、其余小类；读不到是空数组。 */
  bsr: CatalogBsr[]
  available?: boolean
  /** 五点（WP398 拆词用）。 */
  bullets: string[]
  /** 页头「配送到」那一行。 */
  deliver_to?: string
  /** 页面写着不能配送到选的地址（= 配送地址没设对）。 */
  undeliverable: boolean
}

/**
 * 读一页商品页 `/dp/{ASIN}`。验证页 / 找不到这一页回 `undefined`（由调用方照实说，不猜）。
 * 标题、品牌、五点、划线价沿用上面建档案那几个函数。
 */
export function parseAmazonProduct(
  html: string,
  input: { asin: string; url?: string },
): AmazonProductFacts | undefined {
  if (isAmazonChallenge(html) || isAmazonMissingPage(html)) return undefined
  const title = textOfId(html, 'productTitle')
  const brand = brandFromByline(html)
  const image =
    /id=["']landingImage["'][^>]*data-old-hires=["'](https?:[^"']+)["']/i.exec(html)?.[1] ??
    /id=["']landingImage["'][^>]*\ssrc=["'](https?:[^"']+)["']/i.exec(html)?.[1] ??
    /id=["']imgBlkFront["'][^>]*\ssrc=["'](https?:[^"']+)["']/i.exec(html)?.[1]
  const priceText = amazonPriceText(html)
  const price = priceText === undefined ? undefined : amazonMoney(priceText)
  const listText = amazonListPrice(html)
  const list = listText === undefined ? undefined : amazonMoney(listText)
  const rating = Number(
    /id=["']acrPopover["'][^>]*title=["']([0-9.,]+)\s/i.exec(html)?.[1]?.replace(',', '.') ??
      /([0-9.]+)\s*out of\s*5\s*stars/i.exec(html)?.[1] ??
      Number.NaN,
  )
  const reviewsRaw =
    /id=["']acrCustomerReviewText["'][^>]*>\s*\(?([\d.,]+)/i.exec(html)?.[1] ??
    /([\d,]+)\s*(?:global ratings|ratings)\b/i.exec(html)?.[1]
  const reviews = reviewsRaw === undefined ? Number.NaN : Number(reviewsRaw.replace(/[.,]/g, ''))
  const coupon = amazonCoupon(html)
  const available = amazonAvailable(html)
  const deliverTo = amazonDeliverTo(html)
  return {
    asin: input.asin.trim().toUpperCase(),
    ...(input.url === undefined ? {} : { url: input.url }),
    ...(title === undefined ? {} : { title: title.slice(0, 300) }),
    ...(brand === undefined || brand === '' ? {} : { brand }),
    ...(image === undefined ? {} : { image }),
    ...(priceText === undefined ? {} : { price_text: priceText }),
    ...(price === undefined ? {} : { price: price.value }),
    ...(price?.currency === undefined ? {} : { currency: price.currency }),
    ...(list !== undefined && price !== undefined && list.value > price.value
      ? { list_price: list.value }
      : {}),
    ...(coupon === undefined ? {} : { coupon }),
    ...(Number.isFinite(rating) && rating > 0 && rating <= 5 ? { rating } : {}),
    ...(Number.isFinite(reviews) && reviews >= 0 ? { reviews } : {}),
    bsr: amazonBsr(html),
    ...(available === undefined ? {} : { available }),
    bullets: featureBullets(html),
    ...(deliverTo === undefined ? {} : { deliver_to: deliverTo }),
    undeliverable: amazonUndeliverable(html),
  }
}

/** 搜索结果页上的一张卡片（挑对标款用）。 */
export interface AmazonSearchCard {
  asin: string
  title: string
  /** 第几张（从 1 起，广告位也算）。 */
  position: number
  price?: number
  currency?: string
  rating?: number
  reviews?: number
  image?: string
  /** 广告位（挑对标款时不优先）。 */
  sponsored: boolean
}

/** 搜索结果页 `/s?k=` 里那些 `data-component-type="s-search-result"` 卡片。 */
export function amazonSearchCards(html: string): AmazonSearchCard[] {
  const out: AmazonSearchCard[] = []
  const seen = new Set<string>()
  const re =
    /<div[^>]*data-asin=["']([A-Z0-9]{10})["'][^>]*data-component-type=["']s-search-result["'][^>]*>([\s\S]*?)(?=<div[^>]*data-asin=["'][A-Z0-9]{10}["'][^>]*data-component-type=|$)/gi
  for (const m of html.matchAll(re)) {
    const asin = (m[1] ?? '').toUpperCase()
    const block = m[2] ?? ''
    if (seen.has(asin)) continue
    const title = stripTags(/<h2[^>]*>([\s\S]*?)<\/h2>/i.exec(block)?.[1] ?? '')
    if (title === '') continue
    seen.add(asin)
    const priceText =
      /class=["'][^"']*\ba-price\b(?![^"']*a-text-price)[^"']*["'][^>]*>\s*<span[^>]*a-offscreen[^>]*>([^<]+)</i.exec(
        block,
      )?.[1]
    const price = priceText === undefined ? undefined : amazonMoney(priceText)
    const rating = Number(/([0-9.]+)\s*out of\s*5\s*stars/i.exec(block)?.[1] ?? Number.NaN)
    const reviewsRaw =
      /aria-label=["']([\d,.]+)\s*(?:ratings|reviews)["']/i.exec(block)?.[1] ??
      /class=["'][^"']*s-underline-text[^"']*["'][^>]*>\s*\(?([\d,.]+)\)?\s*</i.exec(block)?.[1]
    const reviews = reviewsRaw === undefined ? Number.NaN : Number(reviewsRaw.replace(/[.,]/g, ''))
    const image = /<img[^>]+class=["'][^"']*s-image[^"']*["'][^>]*src=["']([^"']+)["']/i.exec(
      block,
    )?.[1]
    out.push({
      asin,
      title: title.slice(0, 300),
      position: out.length + 1,
      ...(price === undefined ? {} : { price: price.value }),
      ...(price?.currency === undefined ? {} : { currency: price.currency }),
      ...(Number.isFinite(rating) && rating > 0 ? { rating } : {}),
      ...(Number.isFinite(reviews) ? { reviews } : {}),
      ...(image === undefined ? {} : { image }),
      sponsored: /\bSponsored\b|puis-sponsored-label|s-sponsored-label/i.test(block),
    })
    if (out.length >= 48) break
  }
  return out
}
