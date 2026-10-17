/**
 * WP396（docs/106 §13，A1 ②）：**自家 Listing 体检**要的那几格——从一页 Amazon 前台商品页 HTML 里读。
 *
 * 读页本身（内置浏览器、`Agent/AgentsWorkshop` 标识、配送邮编、被拦就停）不在这里：那是 WP394 的积木，
 * 这里只认它交回来的 HTML。和 {@link ./amazon.js} 的分工：那边是建档案要的（标题、品牌、五点、价、评分、
 * 类目），这里补体检要的（图片张数、视频、A+、描述、变体子体、有没有货、购物车谁卖、优惠券）。
 * 共用的那几样（五点、划线价、验证页）直接用那边的函数，不另写一份。
 *
 * **读不到的格子不出现，不猜**：页面 id 会变，变了那一格就是「没读到」，体检卡照实写。
 */
import type { AmazonListingFacts } from '@agentsws/contracts'
import { amazonListPrice, isBlocked } from './amazon.js'
import { decodeEntities, squash } from './html.js'

const strip = (s: string): string => squash(decodeEntities(s.replace(/<[^>]*>/g, ' ')))

/** 某个 id 起头的那一块（到下一个同级块之前，最多 `max` 字）。 */
function blockOfId(html: string, id: string, max = 20_000): string | undefined {
  const at = html.search(new RegExp(`id=["']${id}["']`, 'i'))
  if (at < 0) return undefined
  return html.slice(at, at + max)
}

/** 某个 id 的元素里的字（只到它自己的第一个闭合标签前后那一段，够标题、可售状态这类短字段）。 */
function textOfId(html: string, id: string, max = 2_000): string | undefined {
  const re = new RegExp(
    `id=["']${id}["'][^>]*>([\\s\\S]{0,${max}}?)<\\/(?:span|div|h1|a|p|td)>`,
    'i',
  )
  const raw = re.exec(html)?.[1]
  if (raw === undefined) return undefined
  const text = strip(raw)
  return text === '' ? undefined : text
}

/** 五点：`feature-bullets` 里的每个 `<li>`，**空的那条也留着**（体检要数「空了几条」）。 */
export function listingBullets(html: string): string[] {
  const block = /id=["']feature-bullets["'][\s\S]{0,12000}?<\/ul>/i.exec(html)?.[0]
  if (block === undefined) return []
  const out: string[] = []
  for (const m of block.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)) {
    // 「See more product details」那一行不是五点
    if (/a-declarative|see more product details/i.test(m[0])) continue
    out.push(strip(m[1] ?? ''))
    if (out.length >= 10) break
  }
  return out
}

/** 价格符号 → 币种（认不出不给）。 */
export function currencyOfPrice(price: string): string | undefined {
  if (/^\s*(?:US)?\$/.test(price) && !/^\s*(?:CA|C|A|AU|MX|S)\$/i.test(price)) return 'USD'
  if (/^\s*(?:CA|C)\$|CDN\$/i.test(price)) return 'CAD'
  if (/^\s*(?:A|AU)\$/i.test(price)) return 'AUD'
  if (/^\s*MX\$/i.test(price)) return 'MXN'
  if (/^\s*S\$/i.test(price)) return 'SGD'
  if (/£/.test(price)) return 'GBP'
  if (/€|EUR/.test(price)) return 'EUR'
  if (/¥|￥|JPY/.test(price)) return 'JPY'
  if (/₹/.test(price)) return 'INR'
  return undefined
}

/** 现价：买框里那个 `a-price` 的 `a-offscreen`（原样带符号）；退到第一个 `a-price-whole`。 */
export function listingPrice(html: string): string | undefined {
  const core =
    blockOfId(html, 'corePriceDisplay_desktop_feature_div', 6_000) ??
    blockOfId(html, 'corePrice_feature_div', 6_000) ??
    html
  const off =
    /class=["'][^"']*\ba-price\b(?![^"']*a-text-price)[^"']*["'][^>]*>\s*<span[^>]*class=["'][^"']*a-offscreen[^"']*["'][^>]*>([^<]+)</i.exec(
      core,
    )?.[1]
  if (off !== undefined && strip(off) !== '') return strip(off)
  const whole = /class=["'][^"']*a-price-whole[^"']*["'][^>]*>([^<]+)</i.exec(core)?.[1]
  if (whole === undefined) return undefined
  const symbol = /class=["'][^"']*a-price-symbol[^"']*["'][^>]*>([^<]+)</i.exec(core)?.[1]
  const fraction = /class=["'][^"']*a-price-fraction[^"']*["'][^>]*>([^<]+)</i.exec(core)?.[1]
  const w = strip(whole).replace(/[.,]$/, '')
  return `${strip(symbol ?? '')}${w}${fraction === undefined ? '' : `.${strip(fraction)}`}`
}

/** 图片：页面脚本里 `colorImages.initial` 那一串（每张一个 `"variant":"MAIN|PT01…"`）；退到左边缩略图。 */
function images(html: string): { count?: number; main: boolean } {
  const initial = /['"]colorImages['"]\s*:\s*\{\s*['"]initial['"]\s*:\s*\[([\s\S]*?)\]\s*\}/i.exec(
    html,
  )?.[1]
  if (initial !== undefined) {
    const variants = [...initial.matchAll(/["']variant["']\s*:\s*["']([A-Z0-9]+)["']/g)].map(
      (m) => m[1] ?? '',
    )
    return { count: variants.length, main: variants.includes('MAIN') || variants.length > 0 }
  }
  const alt = blockOfId(html, 'altImages', 30_000)
  if (alt !== undefined) {
    const thumbs = [...alt.matchAll(/<li[^>]*class=["'][^"']*\bimageThumbnail\b[^"']*["']/gi)]
      .length
    return { count: thumbs, main: thumbs > 0 || /id=["']landingImage["']/i.test(html) }
  }
  if (/id=["']landingImage["']/i.test(html)) return { main: true }
  return { main: false }
}

function hasVideo(html: string): boolean {
  if (/class=["'][^"']*\bvideoThumbnail\b/i.test(html)) return true
  if (/["']videos["']\s*:\s*\[\s*\{/i.test(html)) return true
  const count = /id=["']videoCount["'][^>]*>\s*(\d+)/i.exec(html)?.[1]
  return count !== undefined && Number(count) > 0
}

function hasAplus(html: string): boolean {
  const block = blockOfId(html, 'aplus', 40_000) ?? blockOfId(html, 'aplus_feature_div', 40_000)
  if (block !== undefined && /aplus-module|aplus-v2|celwidget/i.test(block)) return true
  return /id=["']aplusBrandStory_feature_div["'][\s\S]{0,4000}?aplus-module/i.test(html)
}

function hasDescription(html: string): boolean {
  const raw = /id=["']productDescription["'][^>]*>([\s\S]{0,8000}?)<\/div>/i.exec(html)?.[1]
  return raw !== undefined && strip(raw).length > 0
}

/** 变体：`twister` 那一块 + 脚本里的子体表（`dimensionValuesDisplayData` 的键就是子体 ASIN）。 */
function variants(html: string): AmazonListingFacts['variants'] {
  const twAt = html.search(
    /id=["'](?:twister|twister_feature_div|inline-twister-expander-content)[^"']*["']/i,
  )
  const twister = twAt >= 0
  const children = new Set<string>()
  const map = /["']dimensionValuesDisplayData["']\s*:\s*\{([\s\S]*?)\}/i.exec(html)?.[1]
  if (map !== undefined)
    for (const m of map.matchAll(/["']([A-Z0-9]{10})["']\s*:/g)) children.add(m[1] ?? '')
  const tw = twister ? html.slice(twAt, twAt + 60_000) : ''
  for (const m of tw.matchAll(
    /data-(?:defaultasin|asin|dp-url)=["'][^"']*?([A-Z0-9]{10})[^"']*["']/gi,
  ))
    children.add((m[1] ?? '').toUpperCase())
  children.delete('')
  // 一个子体一个 `<li>`：数带「买不了」标记的 `<li>`（里面的按钮也带同一个标记，别数两次）
  const items = [...tw.matchAll(/<li\b[^>]*>[\s\S]*?<\/li>/gi)].map((m) => m[0])
  const unavailable = items.filter((li) =>
    /class=["'][^"']*\b(?:swatchUnavailable|a-button-unavailable|unavailable)\b/i.test(li),
  ).length
  return {
    present: twister && (children.size > 1 || /variation_/i.test(tw)),
    child_asins: [...children].sort(),
    unavailable_count: unavailable,
  }
}

function availability(
  html: string,
): Pick<AmazonListingFacts, 'availability' | 'availability_text'> {
  const text =
    textOfId(html, 'availability') ??
    (/id=["']outOfStock["']/i.test(html) ? textOfId(html, 'outOfStock') : undefined)
  if (text === undefined) return { availability: 'unknown' }
  const t = text.slice(0, 160)
  if (
    /currently unavailable|out of stock|nicht verfügbar|actuellement indisponible|non disponibile|no disponible|在庫切れ|現在お取り扱いできません/i.test(
      t,
    )
  )
    return { availability: 'out_of_stock', availability_text: t }
  if (
    /in stock|only \d+ left|auf lager|en stock|disponibilità immediata|en stock|在庫あり|usually ships|available to ship/i.test(
      t,
    )
  )
    return { availability: 'in_stock', availability_text: t }
  return { availability: 'unknown', availability_text: t }
}

/** 购物车：「Sold by / Ships from」两格（新版 `offer-display-feature`，老版 `merchant-info`）。 */
function buybox(html: string): AmazonListingFacts['buybox'] {
  const hasCart = /id=["'](?:add-to-cart-button|buy-now-button)["']/i.test(html)
  const featureText = (id: string): string | undefined => {
    const block = blockOfId(html, id, 4_000)
    if (block === undefined) return undefined
    const m =
      /class=["'][^"']*offer-display-feature-text-message[^"']*["'][^>]*>([\s\S]*?)<\/span>/i.exec(
        block,
      )?.[1]
    const t = m === undefined ? undefined : strip(m)
    return t === '' ? undefined : t
  }
  let seller =
    featureText('merchantInfoFeature_feature_div') ?? textOfId(html, 'sellerProfileTriggerId')
  let ships = featureText('fulfillerInfoFeature_feature_div')
  const legacy = textOfId(html, 'merchant-info', 600)
  if (seller === undefined && legacy !== undefined) {
    const both = /ships from and sold by\s+(.+?)\.?$/i.exec(legacy)?.[1]
    const sold = /sold by\s+(.+?)(?:\s+and\s+|\.|$)/i.exec(legacy)?.[1]
    const from = /ships from\s+(.+?)(?:\s+and\s+|\.|$)/i.exec(legacy)?.[1]
    seller = both ?? sold
    ships = both ?? from
  }
  return {
    present: hasCart,
    ...(seller === undefined ? {} : { seller: seller.slice(0, 120) }),
    ...(ships === undefined ? {} : { ships_from: ships.slice(0, 120) }),
  }
}

function coupon(html: string): string | undefined {
  const block =
    blockOfId(html, 'promoPriceBlockMessage_feature_div', 3_000) ??
    blockOfId(html, 'couponBadgeRegularVpc', 3_000)
  const scope = block ?? html
  const m =
    /((?:apply|save)\s+[^<]{0,40}?coupon[^<]{0,30}|[^<>]{0,20}coupon\s+applied[^<]{0,20})/i.exec(
      scope,
    )?.[1]
  const t = m === undefined ? undefined : strip(m)
  return t === undefined || t === '' ? undefined : t.slice(0, 120)
}

function rating(html: string): number | undefined {
  const pop =
    /id=["']acrPopover["'][^>]*title=["']([0-9.,]+)\s*(?:out of|von|sur|su|de|5つ星のうち)/i.exec(
      html,
    )?.[1]
  const raw = pop ?? /([0-9.,]+)\s*out of\s*5\s*stars/i.exec(html)?.[1]
  if (raw === undefined) return undefined
  const n = Number(raw.replace(',', '.'))
  return Number.isFinite(n) && n >= 0 && n <= 5 ? n : undefined
}

function reviews(html: string): number | undefined {
  const text = textOfId(html, 'acrCustomerReviewText')
  const raw = /([\d.,\s]+)/.exec(text ?? '')?.[1]
  if (raw === undefined) return undefined
  const n = Number(raw.replace(/[.,\s]/g, ''))
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/**
 * 一页商品页 → 体检要的那几格。验证页回 `undefined`（调用方照实说「被拦了」，不重试）。
 */
export function readAmazonListingFacts(
  html: string,
  at: { asin: string; marketplace: string; url: string; read_at: string },
): AmazonListingFacts | undefined {
  if (isBlocked(html)) return undefined
  const title = textOfId(html, 'productTitle', 1_000)
  const byline = textOfId(html, 'bylineInfo')
  const brand = byline
    ?.replace(/^(?:Brand|品牌|Marke|Marque|Marca)\s*[:：]\s*/i, '')
    .replace(/^Visit the\s+/i, '')
    .replace(/\s+Store$/i, '')
    .trim()
  const price = listingPrice(html)
  const listPrice = amazonListPrice(html)
  const currency = price === undefined ? undefined : currencyOfPrice(price)
  const img = images(html)
  const r = rating(html)
  const n = reviews(html)
  const c = coupon(html)
  return {
    asin: at.asin,
    marketplace: at.marketplace,
    url: at.url,
    read_at: at.read_at,
    ...(title === undefined ? {} : { title }),
    ...(brand === undefined || brand === '' ? {} : { brand }),
    bullets: listingBullets(html),
    has_description: hasDescription(html),
    has_aplus: hasAplus(html),
    ...(img.count === undefined ? {} : { image_count: img.count }),
    has_main_image: img.main,
    has_video: hasVideo(html),
    variants: variants(html),
    ...(r === undefined ? {} : { rating: r }),
    ...(n === undefined ? {} : { reviews_count: n }),
    ...(price === undefined ? {} : { price }),
    ...(listPrice === undefined || listPrice === price ? {} : { list_price: listPrice }),
    ...(currency === undefined ? {} : { currency }),
    ...(c === undefined ? {} : { coupon: c }),
    ...availability(html),
    buybox: buybox(html),
    undeliverable:
      /cannot be shipped to your selected delivery location|doesn['’]t ship to your selected location|kann nicht an den ausgewählten Lieferort|ne peut pas être expédié/i.test(
        html,
      ),
  }
}
