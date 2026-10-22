/**
 * WP448（docs/109 §4.4）：技术体检的**规则表**（数据，不是代码分支）。
 *
 * 每条：查哪一块、多严重、交给建站的哪一条、给人看的一句话与怎么改（中英）。`tech-audit.ts` 只负责判「命中了哪条」，
 * 严重度、归属、文案都从这张表来——改口径改这里，不改判断代码。
 *
 * 检查项与严重度的思路借 claude-seo（MIT，github.com/AgriciDaniel/claude-seo @ 4b99de2）
 * `skills/seo-technical`、`seo-sitemap`、`seo-hreflang`、`seo-schema`、`seo-google`；按我们的口径重写、重定了严重度
 * （中小 Shopify 店：Shopify 自动生成站点地图与规范网址，最常见的是主题 / App 改坏的那几样）。
 */
import type { TechAuditArea, TechAuditOwner } from '@agentsws/contracts'

export interface TechAuditRule {
  area: TechAuditArea
  severity: 'high' | 'medium' | 'low'
  owner: TechAuditOwner
  title: { zh: string; en: string }
  fix: { zh: string; en: string }
}

/** 规则表的版本（改了严重度 / 归属就改日期，报告里写明照哪一版判的）。 */
export const TECH_AUDIT_RULES_VERSION = '2026-10-22'

const BUILD: TechAuditOwner = 'site.shopify-build'
const THEME: TechAuditOwner = 'site.shopify-theme'

export const TECH_AUDIT_RULES = {
  // ── 没收录（Search Console 网址检查） ──
  'indexing.not_indexed': {
    area: 'indexing',
    severity: 'high',
    owner: BUILD,
    title: { zh: '没被 Google 收录', en: 'Not indexed by Google' },
    fix: {
      zh: '看是不是 noindex、被 robots 挡或规范网址指走了；改完在 Search Console 请求编入索引',
      en: 'Check noindex, robots and canonical; then request indexing in Search Console',
    },
  },
  'indexing.redirect': {
    area: 'indexing',
    severity: 'medium',
    owner: BUILD,
    title: { zh: '排名落在跳转前的旧地址上', en: 'Ranking URL redirects' },
    fix: {
      zh: '站内链接与站点地图改指最终地址',
      en: 'Point internal links and the sitemap at the final URL',
    },
  },
  'indexing.canonical_mismatch': {
    area: 'indexing',
    severity: 'high',
    owner: THEME,
    title: { zh: 'Google 选的规范网址和我们写的不一样', en: 'Google picked a different canonical' },
    fix: {
      zh: '核对模板里的 canonical 与重复页（带参数的、/collections/…/products/… 那种）',
      en: 'Check the theme canonical and duplicate URLs',
    },
  },
  // ── 规范网址 ──
  'canonical.missing': {
    area: 'canonical',
    severity: 'medium',
    owner: THEME,
    title: { zh: '没写规范网址', en: 'No canonical tag' },
    fix: {
      zh: '主题 <head> 里加 canonical（Shopify 默认是 {{ canonical_url }}）',
      en: 'Add canonical in the theme head ({{ canonical_url }})',
    },
  },
  'canonical.multiple': {
    area: 'canonical',
    severity: 'high',
    owner: THEME,
    title: { zh: '写了不止一个规范网址', en: 'Multiple canonical tags' },
    fix: {
      zh: '多半是主题和某个 App 各加了一个，删到只剩一个',
      en: 'Usually the theme and an app both add one; keep one',
    },
  },
  'canonical.points_elsewhere': {
    area: 'canonical',
    severity: 'high',
    owner: THEME,
    title: { zh: '规范网址指向了别的页', en: 'Canonical points to another page' },
    fix: {
      zh: '确认是故意的；不是就改回指向自己',
      en: 'Confirm it is intended; otherwise self-reference',
    },
  },
  'canonical.target_broken': {
    area: 'canonical',
    severity: 'high',
    owner: THEME,
    title: {
      zh: '规范网址指到打不开或在跳转的地址',
      en: 'Canonical target is broken or redirects',
    },
    fix: { zh: '改指能直接打开的最终地址', en: 'Point it at a live final URL' },
  },
  'canonical.noindex_conflict': {
    area: 'canonical',
    severity: 'medium',
    owner: THEME,
    title: { zh: '同一页既 noindex 又写规范网址', en: 'noindex together with canonical' },
    fix: { zh: '二选一：要收录就去掉 noindex', en: 'Pick one; drop noindex if it should rank' },
  },
  // ── 跳转与死链 ──
  'redirect.chain': {
    area: 'redirect',
    severity: 'medium',
    owner: BUILD,
    title: { zh: '跳转链（跳了不止一次）', en: 'Redirect chain' },
    fix: {
      zh: '旧地址直接跳到最终地址（清单可直接出「改跳转」卡）',
      en: 'Redirect straight to the final URL',
    },
  },
  'redirect.loop': {
    area: 'redirect',
    severity: 'high',
    owner: BUILD,
    title: { zh: '跳转绕成了圈', en: 'Redirect loop' },
    fix: { zh: '拆掉其中一条跳转', en: 'Remove one of the redirects' },
  },
  'redirect.temporary': {
    area: 'redirect',
    severity: 'low',
    owner: BUILD,
    title: { zh: '用了临时跳转（302 / 307）', en: 'Temporary redirect (302/307)' },
    fix: {
      zh: '长期搬家改成永久跳转（Shopify 网址跳转默认就是 301）',
      en: 'Use a permanent redirect for moves',
    },
  },
  'link.dead_internal': {
    area: 'redirect',
    severity: 'high',
    owner: BUILD,
    title: { zh: '站内链接点开是 404', en: 'Internal link returns 404' },
    fix: {
      zh: '定一个最接近的页，加一条跳转；或改掉那个链接',
      en: 'Redirect to the closest page or fix the link',
    },
  },
  'link.server_error': {
    area: 'redirect',
    severity: 'high',
    owner: BUILD,
    title: { zh: '页面打开报服务器错误（5xx）', en: 'Page returns 5xx' },
    fix: {
      zh: '多半是某个 App 或模板出错，先看最近改了什么',
      en: 'Usually an app or template error',
    },
  },
  // ── 站点地图 ──
  'sitemap.missing': {
    area: 'sitemap',
    severity: 'high',
    owner: BUILD,
    title: { zh: '找不到站点地图', en: 'No sitemap found' },
    fix: {
      zh: 'Shopify 自带 /sitemap.xml；打不开多半是店铺有访问密码或域名设置不对',
      en: 'Shopify serves /sitemap.xml; check password protection and domain',
    },
  },
  'sitemap.unreadable': {
    area: 'sitemap',
    severity: 'high',
    owner: BUILD,
    title: { zh: '站点地图读不出来', en: 'Sitemap is not valid XML' },
    fix: {
      zh: '看是不是被 App 或代理改坏了',
      en: 'Check whether an app or proxy altered it',
    },
  },
  'sitemap.not_in_robots': {
    area: 'sitemap',
    severity: 'low',
    owner: BUILD,
    title: { zh: 'robots.txt 里没写站点地图', en: 'Sitemap not referenced in robots.txt' },
    fix: {
      zh: 'robots.txt 加一行 Sitemap: …/sitemap.xml',
      en: 'Add a Sitemap: line to robots.txt',
    },
  },
  'sitemap.bad_url': {
    area: 'sitemap',
    severity: 'medium',
    owner: BUILD,
    title: {
      zh: '站点地图里有打不开 / 在跳转 / 不让收录的地址',
      en: 'Sitemap lists broken, redirecting or noindex URLs',
    },
    fix: {
      zh: '把那几页下架、改回或加跳转；站点地图只留能收录的',
      en: 'Only list indexable final URLs',
    },
  },
  'sitemap.missing_page': {
    area: 'sitemap',
    severity: 'medium',
    owner: BUILD,
    title: { zh: '在卖的页不在站点地图里', en: 'Live page missing from sitemap' },
    fix: {
      zh: '多半是商品没发布到「在线商店」渠道，或被 App 设成隐藏',
      en: 'Usually not published to the Online Store channel',
    },
  },
  // ── hreflang（多个市场时） ──
  'hreflang.missing': {
    area: 'hreflang',
    severity: 'medium',
    owner: THEME,
    title: { zh: '卖好几个市场，页面却没写 hreflang', en: 'Several markets but no hreflang' },
    fix: {
      zh: '在 Shopify「市场」里给各市场开语言 / 子目录，主题会自动写 hreflang',
      en: 'Enable market languages/subfolders in Shopify Markets',
    },
  },
  'hreflang.invalid_code': {
    area: 'hreflang',
    severity: 'high',
    owner: THEME,
    title: { zh: 'hreflang 语言 / 地区码写错了', en: 'Invalid hreflang code' },
    fix: {
      zh: '语言用 ISO 639-1（en、de），地区用 ISO 3166-1（GB 不是 UK）',
      en: 'Use ISO 639-1 language and ISO 3166-1 region (GB, not UK)',
    },
  },
  'hreflang.no_self': {
    area: 'hreflang',
    severity: 'high',
    owner: THEME,
    title: { zh: 'hreflang 没写自己这一页', en: 'hreflang missing self-reference' },
    fix: {
      zh: '每个语言版本都要列上自己（Shopify Markets 默认会写）',
      en: 'Each version must list itself',
    },
  },
  'hreflang.no_return': {
    area: 'hreflang',
    severity: 'high',
    owner: THEME,
    title: { zh: 'hreflang 没互指', en: 'hreflang return tag missing' },
    fix: {
      zh: 'A 指 B，B 也要指回 A，否则整组不算',
      en: 'If A points to B, B must point back',
    },
  },
  'hreflang.canonical_mismatch': {
    area: 'hreflang',
    severity: 'medium',
    owner: THEME,
    title: { zh: 'hreflang 写的地址和规范网址不一致', en: 'hreflang URL differs from canonical' },
    fix: {
      zh: 'hreflang 里只放规范网址（含结尾斜杠也要一样）',
      en: 'Only list canonical URLs in hreflang',
    },
  },
  'hreflang.no_x_default': {
    area: 'hreflang',
    severity: 'low',
    owner: THEME,
    title: { zh: '没写 x-default', en: 'No x-default' },
    fix: { zh: '加一条 x-default 指向默认语言版', en: 'Add x-default for the fallback version' },
  },
  // ── 结构化数据 ──
  'schema.broken_json': {
    area: 'schema',
    severity: 'high',
    owner: THEME,
    title: { zh: '结构化数据写坏了（JSON 读不出）', en: 'Broken JSON-LD' },
    fix: {
      zh: '多半是模板里少了逗号或引号没转义',
      en: 'Usually a missing comma or unescaped quote',
    },
  },
  'schema.product_missing': {
    area: 'schema',
    severity: 'high',
    owner: THEME,
    title: { zh: '商品页没有 Product 结构化数据', en: 'Product page has no Product markup' },
    fix: {
      zh: '主题里加 Product / Offer（价格、币种、库存）',
      en: 'Add Product/Offer markup to the theme',
    },
  },
  'schema.invalid': {
    area: 'schema',
    severity: 'medium',
    owner: THEME,
    title: {
      zh: '结构化数据缺 Google 要求的字段',
      en: 'Structured data misses required fields',
    },
    fix: {
      zh: '按 Google 富媒体结果要求补齐（缺哪格写在后面）',
      en: 'Fill the required fields listed',
    },
  },
  'schema.article_recommended': {
    area: 'schema',
    severity: 'low',
    owner: THEME,
    title: { zh: '文章的结构化数据缺推荐字段', en: 'Article markup misses recommended fields' },
    fix: {
      zh: 'Google 对 Article 没有必填项；补上标题、图片、发布日期更容易被正确展示',
      en: 'No required fields; headline, image and datePublished help',
    },
  },
  // ── 页面速度 ──
  'speed.lcp': {
    area: 'speed',
    severity: 'medium',
    owner: THEME,
    title: { zh: '最大内容出来得慢（LCP）', en: 'Slow Largest Contentful Paint' },
    fix: {
      zh: '首屏大图压小、别懒加载首屏图、少放首屏轮播',
      en: 'Compress the hero image; do not lazy-load it',
    },
  },
  'speed.inp': {
    area: 'speed',
    severity: 'medium',
    owner: THEME,
    title: { zh: '点了反应慢（INP）', en: 'Slow Interaction to Next Paint' },
    fix: {
      zh: '看哪些 App 脚本在抢主线程，停掉不用的',
      en: 'Remove heavy app scripts',
    },
  },
  'speed.cls': {
    area: 'speed',
    severity: 'medium',
    owner: THEME,
    title: { zh: '页面加载时乱跳（CLS）', en: 'Layout shifts (CLS)' },
    fix: {
      zh: '图片写明宽高、弹窗与横幅别把内容往下推',
      en: 'Set image sizes; do not push content with banners',
    },
  },
  'speed.tbt': {
    area: 'speed',
    severity: 'low',
    owner: THEME,
    title: { zh: '脚本占主线程太久（实验室）', en: 'Long Total Blocking Time (lab)' },
    fix: {
      zh: '看哪些 App 脚本在抢主线程，停掉不用的',
      en: 'Remove heavy app scripts',
    },
  },
} as const satisfies Record<string, TechAuditRule>

export type TechAuditRuleId = keyof typeof TECH_AUDIT_RULES

/**
 * Core Web Vitals 的线（Google 现行口径：p75，好 / 要改进 / 差）。
 * INP 2024-03 取代了 FID。实验室数里没有 INP，用 TBT 看个大概（标「实验室」）。
 */
export const CWV_THRESHOLDS = {
  lcp_ms: { good: 2500, poor: 4000 },
  inp_ms: { good: 200, poor: 500 },
  cls: { good: 0.1, poor: 0.25 },
  tbt_ms: { good: 200, poor: 600 },
} as const
