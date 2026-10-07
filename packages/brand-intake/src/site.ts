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
  type BrandIntakeFailureKind,
  type BrandIntakePage,
  type BrandIntakePolicy,
  type BrandIntakeProduct,
  type BrandIntakeProfile,
  type BrandIntakeSocialLink,
  type StorefrontPlatform,
} from '@agentsws/contracts'
import {
  fetchPage,
  fetchRobots,
  isDisallowed,
  isShopifyPasswordPage,
  type PageFetch,
} from './fetch.js'
import { field, type IntakeLayer } from './field.js'
import {
  absolute,
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
import { inferMarkets } from './markets.js'

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
/**
 * WP251（决策 106）：中日韩文字一个字顶英文好几个字母——同样一段「七天无理由退货」的政策，
 * 中文八十来个字就说完了，按 200 个字符卡会把真政策当成不够长丢掉。按文字类型分门槛。
 */
export const POLICY_MIN_CHARS_CJK = 80
const POLICY_WORDS =
  /refund|return|exchange|shipping|deliver|warranty|privacy|terms|退货|退款|换货|运费|物流|配送|保修|隐私|条款|返品|配送料|保証|プライバシー|환불|반품|배송|교환|개인정보/i
/** 中日韩文字（汉字、平假名、片假名、谚文）。 */
const CJK_CHAR = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af\u1100-\u11ff]/gu
/** 算「字」的那些：字母、数字、中日韩文字（空白与标点不算）。 */
const WORD_CHAR = /[\p{L}\p{N}]/gu

/**
 * WP251（决策 106）：这段文字按哪种门槛算——中日韩文字占了字母数字的一半以上就是中日韩。
 * 回门槛与按它算出来的长度：中日韩数**字**（不算空白标点），其他照旧数字符。
 */
export function policyLength(text: string): { length: number; min: number; cjk: boolean } {
  const cjk = text.match(CJK_CHAR)?.length ?? 0
  const words = text.match(WORD_CHAR)?.length ?? 0
  if (cjk > 0 && cjk * 2 >= words) return { length: words, min: POLICY_MIN_CHARS_CJK, cjk: true }
  return { length: text.length, min: POLICY_MIN_CHARS, cjk: false }
}

/**
 * 这一页真的是政策页吗。
 *
 * **不看状态码，看内容**：Shopify 把删掉的政策 302 回首页，那一跳是 200，
 * 首页正文也够长——唯一分得开的办法是问"这段话像不像一份政策"。
 * WP251：门槛按文字类型分（中日韩 80 字，其他 200 字符）。
 */
export function looksLikePolicy(text: string): boolean {
  const { length, min } = policyLength(text)
  return length >= min && POLICY_WORDS.test(text)
}

/**
 * WP244：Shopify 新开店的默认店名（后台没改过名字时页面上就是它）。
 * 认到它就不当品牌名——那不是品牌，是 Shopify 替你起的占位名。
 */
export const SHOPIFY_PLACEHOLDER_NAMES: readonly string[] = ['My Store', 'My store', 'My Shop']

/**
 * Shopify 默认主题首页上的占位文字（新店没动过首页时会有好几句）。
 * 单独一句「Welcome to our store」正式店也可能写，所以**要对上两句**才算。
 */
const SHOPIFY_PLACEHOLDER_TEXT: readonly RegExp[] = [
  /welcome to our store/i,
  /talk about your brand/i,
  /example product title/i,
  /your content goes here/i,
  /\bimage banner\b/i,
  /pair text with an image/i,
  /share information about your brand with your customers/i,
  /use this text to share information/i,
]

/** 这个名字是不是 Shopify 的占位店名。 */
export function isPlaceholderStoreName(name: string | undefined): boolean {
  if (name === undefined) return false
  const n = name.trim().toLowerCase()
  return SHOPIFY_PLACEHOLDER_NAMES.some((p) => p.toLowerCase() === n)
}

/**
 * WP244（Fable 10-07 真机，rolloutgear.com）：**刚开的 Shopify 空店**。
 *
 * 店名还是 My Store、首页还是 Welcome to our store、只有 Shopify 自动生成的那份隐私政策——
 * 这时读出来的「品牌名 = My Store（把握度高）」「一句话 = My Store」全是占位，
 * 照填等于让人把占位名当品牌名确认下去。认出来就这几格不填、默认政策不进知识库，
 * 界面明说「店铺还是 Shopify 初始状态，品牌资料请自己填」，推荐里加上建站。
 *
 * 判据：是 Shopify，并且（店名是占位名 **或** 首页正文里对上两句以上默认主题的占位文字）。
 */
export function isFreshShopifyStore(home: string, siteName: string | undefined): boolean {
  if (detectPlatform(home)?.platform !== 'shopify') return false
  if (isPlaceholderStoreName(siteName) || isPlaceholderStoreName(titleOf(home))) return true
  const text = mainText(home, 20_000)
  return SHOPIFY_PLACEHOLDER_TEXT.filter((re) => re.test(text)).length >= 2
}

/**
 * WP244：这份政策是不是 Shopify 替空店自动生成的那份（正文里带着占位店名，或是模板原话）。
 * 只在认出空店时用——正式店里自动生成的隐私政策也是这家店的政策，照常进知识库。
 */
export function looksLikeDefaultPolicy(text: string): boolean {
  if (SHOPIFY_PLACEHOLDER_NAMES.some((n) => text.includes(n))) return true
  return /operates this store and website|this privacy policy describes how .{0,40}\(the "site"|shopify inc\. ?provides/i.test(
    text,
  )
}

/** 认得出来的社媒域名 → 平台名。认不出来的照样留着，`platform` 记 `other`。 */
const SOCIAL_HOSTS: readonly [RegExp, string][] = [
  [/(^|\.)instagram\.com$/i, 'instagram'],
  [/(^|\.)facebook\.com$/i, 'facebook'],
  // WP191（docs/86 §5）：Threads 从 Meta 里拆出来成了一条社媒职责，首页挂着它就要认得出来
  [/(^|\.)threads\.(net|com)$/i, 'threads'],
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
export function detectPlatform(
  html: string,
): { platform: StorefrontPlatform; hint: string } | undefined {
  if (/cdn\.shopify\.com|Shopify\.theme|shopify-section/i.test(html))
    return { platform: 'shopify', hint: 'cdn.shopify.com' }
  if (/woocommerce|wp-content\/plugins\/woocommerce/i.test(html))
    return { platform: 'woocommerce', hint: 'woocommerce' }
  if (/\/skin\/frontend\/|Magento_|mage\/cookies/i.test(html))
    return { platform: 'magento', hint: 'Magento' }
  return undefined
}

/** 从 JSON-LD 的 `Product` 节点上取一张商品卡。 */
function productFromJsonLd(
  node: Record<string, unknown>,
  url: string,
): BrandIntakeProduct | undefined {
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
  /**
   * 抓回来的 HTML 原文（只在 `keepHtml` 时有，WP122 加）。
   *
   * 为什么是一个**开关**而不是一直带着：一页 HTML 最多 400 KB，一轮 12 页就是
   * 5 MB。品牌档案那条路（WP121）解析完就不要它了，让它跟着结果一路传到界面
   * 是白费内存。要它的只有一个调用方——设计规范抽取（71 §2 第一条）要在
   * **同一次抓取**上再读一遍 CSS，重抓一遍别人的站是我们不该做的事。
   */
  documents?: { url: string; kind: BrandIntakePage['kind']; html: string }[]
  /** WP240：首页就读不到时是哪一种（界面按它给下一步）。读到了就没有。 */
  failure_kind?: BrandIntakeFailureKind
  /** WP240：入口是 Shopify 密码页（解开了也照样带着，界面据此不再问密码）。 */
  password_protected?: boolean
  /** WP244：认出是刚开的 Shopify 空店（见 {@link isFreshShopifyStore}）。 */
  fresh_store?: boolean
}

/** WP240：`analyzeSite` 的可选项。 */
export interface SiteIntakeOptions {
  maxPages?: number
  keepHtml?: boolean
  /** 每抓完一页回一次（界面「已经读了 N 页」靠它跟着动，不等整轮跑完）。 */
  onPage?: (page: BrandIntakePage) => void
  /**
   * 用户在原生表单里填的店铺访问密码 + 解开它的那一下（`unlockShopifyStorefront`）。
   * 两样都给才会去解；密码只交给 `unlock`，不进结果、不进页面记录。
   */
  storefrontPassword?: string
  unlock?: (origin: string, password: string) => Promise<string | undefined>
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
  options: SiteIntakeOptions = {},
): Promise<SiteIntakeResult> {
  const maxPages = options.maxPages ?? BRAND_INTAKE_MAX_PAGES
  const documents: { url: string; kind: BrandIntakePage['kind']; html: string }[] = []
  const base = new URL(entryUrl)
  const origin = base.origin
  const disallow = await fetchRobots(doFetch, origin)
  const pages: BrandIntakePage[] = []
  const profile: BrandIntakeProfile = {}
  /** WP240：解开店铺密码之后这一次抓取带的 cookie（只活在这个函数里）。 */
  let cookie: string | undefined
  let failure: BrandIntakeFailureKind | undefined
  let passwordProtected = false
  let homeLocked = false
  let fresh = false

  const record = (page: BrandIntakePage): void => {
    pages.push(page)
    options.onPage?.(page)
  }

  const get = async (url: string, kind: BrandIntakePage['kind']): Promise<string | undefined> => {
    if (pages.length >= maxPages) return undefined
    const path = new URL(url).pathname
    if (isDisallowed(path, disallow)) {
      record({ url, kind, ok: false, reason: 'robots.txt 不让抓这一页' })
      return undefined
    }
    const res = await fetchPage(doFetch, url, cookie === undefined ? {} : { cookie })
    // 解开之前读到的密码页不算读到（首页那一跳在下面单独处理）
    if (res.ok && kind !== 'home' && isShopifyPasswordPage(res.html, res.final_url)) {
      record({ url, kind, ok: false, reason: '店铺有访问密码，这一页读不到' })
      return undefined
    }
    if (!res.ok && kind === 'home' && res.failure_kind !== undefined) failure = res.failure_kind
    // 首页是密码页：先不记这一页（解开了算读到，解不开下面记一条「有访问密码」）
    if (res.ok && kind === 'home' && isShopifyPasswordPage(res.html, res.final_url)) {
      homeLocked = true
      return res.html
    }
    record({
      url,
      kind,
      ok: res.ok,
      ...(res.reason === undefined ? {} : { reason: res.reason }),
    })
    if (res.ok && options.keepHtml === true) documents.push({ url, kind, html: res.html })
    return res.ok ? res.html : undefined
  }

  /** 收尾：`keepHtml` 关着的时候，结果里连这一格都不该出现。 */
  const done = (profile: BrandIntakeProfile): SiteIntakeResult => ({
    pages,
    profile,
    ...(options.keepHtml === true ? { documents } : {}),
    ...(failure === undefined ? {} : { failure_kind: failure }),
    ...(passwordProtected ? { password_protected: true } : {}),
    ...(fresh ? { fresh_store: true } : {}),
  })

  // ── 首页 ────────────────────────────────────────────────────────────
  let home = await get(entryUrl, 'home')
  if (home === undefined) return done(profile)
  /*
   * WP240：Shopify 开着访问密码。用户填了密码就解一次再读；没填 / 解不开就**当场停**，
   * 照实说「店铺有访问密码」——后面那十来页全会被跳到密码页，接着抓只是让人干等。
   */
  if (homeLocked) {
    passwordProtected = true
    const password = options.storefrontPassword
    cookie =
      password === undefined || password === '' || options.unlock === undefined
        ? undefined
        : await options.unlock(origin, password)
    if (cookie !== undefined) {
      const opened = await fetchPage(doFetch, entryUrl, { cookie })
      home =
        opened.ok && !isShopifyPasswordPage(opened.html, opened.final_url) ? opened.html : undefined
    } else home = undefined
    if (home === undefined) {
      failure = password === undefined || password === '' ? 'password' : 'password_wrong'
      record({
        url: entryUrl,
        kind: 'home',
        ok: false,
        reason: failure === 'password' ? '店铺开着访问密码，读到的是密码页' : '店铺密码没能解开',
      })
      return done(profile)
    }
    if (options.keepHtml === true) documents.push({ url: entryUrl, kind: 'home', html: home })
    record({ url: entryUrl, kind: 'home', ok: true })
  }

  const org = jsonLdNodes(home).find((n) => isType(n, /organization|brand|onlinestore/i))
  const siteName =
    (typeof org?.name === 'string' ? squash(org.name) : undefined) ??
    metaContent(home, 'og:site_name')
  // WP244：空店——占位店名、默认一句话都不填（下面那几格各自看 `fresh`）
  fresh = isFreshShopifyStore(home, siteName)
  if (siteName !== undefined && siteName !== '' && !isPlaceholderStoreName(siteName)) {
    profile.brand_name = field(siteName, org?.name === undefined ? 'og' : 'jsonld', {
      url: entryUrl,
      locator: org?.name === undefined ? 'og:site_name' : 'jsonld:Organization.name',
      quote: siteName,
    })
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
    profile.primary_color = field(color, 'selector', {
      url: entryUrl,
      locator: 'meta:theme-color',
      quote: color,
    })

  const tagline = metaContent(home, 'og:description') ?? metaContent(home, 'description')
  /*
   * WP244：一句话等于店名（新店的 og:description 就是店名）不算定位——那不是一句话，是又一遍店名。
   * 空店的那一句一律不填（默认主题的描述也是占位）。
   */
  const sameAsName =
    tagline !== undefined &&
    siteName !== undefined &&
    squash(tagline).toLowerCase() === siteName.trim().toLowerCase()
  if (tagline !== undefined && !sameAsName && !fresh && !isPlaceholderStoreName(tagline))
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
    // WP244：只取正文（不带页头导航）
    const text = mainText(html, 2000)
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
  // WP166：配送政策正文留一份，推目标市场要看它写了送到哪些国家
  let shippingPolicy: { url: string; text: string } | undefined
  for (const probe of POLICY_PROBE_PATHS) {
    const url = `${origin}${probe.path}`
    const html = await get(url, 'policy')
    if (html === undefined) continue
    // WP244：摘要只取正文——去掉页头导航（Skip to content / Home Catalog Contact / Cart 0），实体解码
    const text = mainText(html, 4000)
    // 内容说了算：302 回首页的那种在这里被挡掉
    if (!looksLikePolicy(text)) continue
    // WP244：空店里 Shopify 自动生成的那份不进知识库（那不是这个品牌定的规矩）
    if (fresh && looksLikeDefaultPolicy(text)) continue
    if (probe.kind === 'shipping') shippingPolicy = { url, text: visibleText(html, 12_000) }
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
  const productPages: { url: string; html: string }[] = []
  for (const url of productUrls) {
    const html = await get(url, 'product')
    if (html === undefined) continue
    productPages.push({ url, html })
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

  // ── 目标市场（WP166）：站上自己写明的那几样，推不出就空着 ─────────
  const currencyCode = profile.currency?.value
  const markets = inferMarkets({
    entryUrl,
    home,
    ...(shippingPolicy === undefined ? {} : { shipping: shippingPolicy }),
    products: productPages,
    ...(currencyCode === undefined
      ? {}
      : { currency: { code: currencyCode, url: profile.currency?.evidence[0]?.url ?? origin } }),
  })
  if (markets !== undefined) profile.markets = markets

  // 品牌名一个都没取到的时候，退到 `<title>`（把握度只能是 medium）
  // WP244：空店的标题也是占位店名，不退
  if (profile.brand_name === undefined && !fresh) {
    const title = titleOf(home)
    if (title !== undefined && title !== '' && !isPlaceholderStoreName(title.split(/[|–—-]/)[0]))
      profile.brand_name = field(title.split(/[|–—-]/)[0]?.trim() ?? title, 'selector', {
        url: entryUrl,
        locator: 'selector:title',
        quote: title,
      })
  }

  return done(profile)
}
