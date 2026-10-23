/**
 * WP156（36 §7 第三档）：**教程文章**——卡片上拿下来的步骤清单、成段介绍与外链的去处。
 *
 * 文章是仓库里的 `docs/help/<slug>.md`（中文）与 `docs/help/<slug>.en.md`（英文），
 * 随工作台一起打包（`import.meta.glob`），**离线也能看**；每篇一个 chunk，没打开就不下载。
 * 卡片上的「看教程」= 在右栏「教程」面板里打开 `agentsws://help/<slug>`。
 */

import BUNDLED from 'virtual:agentsws-help'
import {
  HELP_GROUPS,
  HELP_SITE_URL,
  HELP_SLUG_PATTERN,
  type HelpCatalogEntry,
  readHelpArticle,
} from '@agentsws/contracts'
import type { Lang } from '@/lib/i18n'

/**
 * 教程上官网（私有 docs/113，Luoye 10-22 定）起：**目录、标题、摘要、分组、顺序、归哪些岗位 / 职责全写在文章自己头上**
 * （`docs/help/<slug>.md` 开头的 `group` / `order` / `description` / `positions` / `roles`），
 * 构建时由 `vite.config.ts` 的 `helpContent()` 读成 `virtual:agentsws-help`——这里不再手抄
 * `HELP_SLUGS` / `HELP_SCOPES` / 标题词条。
 *
 * 右栏平时显示的是本机服务挑好的那份目录（`GET /v1/help/catalog`：官网拉回来的 + 随包的，见
 * `components/help/use-help.ts`）；这里的随包目录是它没回来时的退路（演示、单测、服务还没起好）。
 *
 * 加一篇：`docs/help/` 里放中英两份 md，中文那份头上写好元数据（写法见 CONTRIBUTING「教程怎么写」）。
 */
export type HelpSlug = string

/** 随包目录的一条（中英两种标题 / 摘要都在）。 */
export type BundledHelp = (typeof BUNDLED)[number]

const groupRank = (g: string | undefined): number => {
  const i = HELP_GROUPS.indexOf(g as (typeof HELP_GROUPS)[number])
  return i < 0 ? HELP_GROUPS.length : i
}

/** 随包的全部教程，按分组、组内 `order` 排好。 */
export const BUNDLED_HELP: readonly BundledHelp[] = [...BUNDLED].sort(
  (a, b) =>
    groupRank(a.group) - groupRank(b.group) ||
    (a.order ?? 1e9) - (b.order ?? 1e9) ||
    a.slug.localeCompare(b.slug),
)

/** 随包的全部 slug（顺序 = 目录顺序）。 */
export const BUNDLED_HELP_SLUGS: readonly HelpSlug[] = BUNDLED_HELP.map((h) => h.slug)

/** 随包目录 → 和本机服务回的同一种形状（退路用）。 */
export function bundledHelpCatalog(lang: Lang): HelpCatalogEntry[] {
  return BUNDLED_HELP.map((h) => {
    const entry: HelpCatalogEntry = {
      kind: 'guide',
      slug: h.slug,
      lang,
      title: h.title[lang],
      description: h.description[lang],
      positions: [...h.positions],
      roles: [...h.roles],
      source: 'bundled',
      needs_newer_app: false,
    }
    if (h.group !== undefined) entry.group = h.group
    if (h.order !== undefined) entry.order = h.order
    if (h.requires !== undefined) entry.requires = h.requires
    if (h.aliases !== undefined) entry.aliases = [...h.aliases]
    return entry
  })
}

/** 随包里有没有这一篇（卡片上「看教程」那几处用它判断要不要出链接）。 */
export function isBundledHelp(slug: string): boolean {
  return BUNDLED_HELP_SLUGS.includes(slug)
}

/** 一篇的标题（先看给的目录，再看随包的，都没有回 slug 本身）。 */
export function helpTitle(
  slug: HelpSlug,
  lang: Lang,
  items: readonly HelpCatalogEntry[] = [],
): string {
  return (
    items.find((i) => i.slug === slug)?.title ??
    BUNDLED_HELP.find((h) => h.slug === slug)?.title[lang] ??
    slug
  )
}

/**
 * WP208：右栏「教程」按当前范围排目录。
 *
 * - 在职责上：先这条职责的，再它所属岗位的，再通用；
 * - 在岗位上：这个岗位的 + 通用；
 * - 哪儿都不在：只有通用。
 *
 * 一篇只出现一次（在最具体的那一组里）；组内照目录的顺序。其余的（别的岗位的）
 * 不在这里——搜索与「全部 N 篇」仍然看得到全部。只排教程（笔记、更新日志不进右栏）。
 */
export function helpForContext(
  ctx: { role_id?: string; position_id?: string },
  items: readonly Pick<
    HelpCatalogEntry,
    'slug' | 'kind' | 'positions' | 'roles'
  >[] = bundledHelpCatalog('zh'),
): {
  role: HelpSlug[]
  position: HelpSlug[]
  general: HelpSlug[]
} {
  const role: HelpSlug[] = []
  const position: HelpSlug[] = []
  const general: HelpSlug[] = []
  for (const item of items) {
    if (item.kind !== 'guide') continue
    if (ctx.role_id !== undefined && item.roles.includes(ctx.role_id)) role.push(item.slug)
    else if (ctx.position_id !== undefined && item.positions.includes(ctx.position_id))
      position.push(item.slug)
    else if (item.positions.length === 0 && item.roles.length === 0) general.push(item.slug)
  }
  return { role, position, general }
}

/** 搜索：标题、摘要、slug 里有没有这几个字（只搜教程）；标题 / slug 里有的排前面。 */
export function searchHelp(items: readonly HelpCatalogEntry[], query: string): HelpSlug[] {
  const q = query.trim().toLowerCase()
  if (q === '') return []
  const guides = items.filter((i) => i.kind === 'guide')
  const strong = guides.filter((i) => `${i.title} ${i.slug}`.toLowerCase().includes(q))
  const weak = guides.filter((i) => !strong.includes(i) && i.description.toLowerCase().includes(q))
  return [...strong, ...weak].map((i) => i.slug)
}

/** 本机服务目录里见过的（官网新加、随包里没有的）——正文里的 `help:` 互链也认它们。 */
const seenOnline = new Set<string>()

export function rememberHelpSlugs(slugs: readonly string[]): void {
  for (const s of slugs) seenOnline.add(s)
}

/** 正文里的 `help:<slug>` 能不能做成链接：随包里有，或本机服务的目录里见过。 */
export function isKnownHelp(slug: string): boolean {
  return isBundledHelp(slug) || seenOnline.has(slug)
}

/**
 * 写法像不像一篇教程的名字（`help:<slug>` 链接与 `agentsws://help/<slug>` 地址用它）。
 * 官网新加的、随包里没有的也算——面板打开时由本机服务去取，真没有就照实说「还没写」。
 */
export function isHelpSlug(value: string): value is HelpSlug {
  return HELP_SLUG_PATTERN.test(value)
}

/** 官网上那一篇（中文在根下、英文加 `/en`；与官网 `docHref` 同一套网址）。 */
export function helpSiteUrl(slug: HelpSlug, lang: Lang): string {
  return `${HELP_SITE_URL}${lang === 'en' ? '/en' : ''}/docs/${slug}/`
}

/** 右栏认的资源地址（`registry.ts` 的 `matches` 用 `agentsws://help/*`）。 */
export const HELP_ADDRESS_PATTERN = 'agentsws://help/*'

export function helpAddress(slug: HelpSlug): string {
  return `agentsws://help/${slug}`
}

/** 地址 → slug；不是教程地址、或者是一篇不存在的，回 `undefined`。 */
export function helpSlugOf(address: string | undefined): HelpSlug | undefined {
  if (address === undefined) return undefined
  const m = /^agentsws:\/\/help\/([a-z0-9-]+)$/.exec(address)
  const slug = m?.[1]
  return slug !== undefined && isHelpSlug(slug) ? slug : undefined
}

/**
 * 模型「加一个」的厂商卡（服务端模板的 `vendor`）→ 哪一篇教程。
 *
 * 没列在这里的（第三方加的模板）卡上就不出「看教程」——它的步骤仍在模板的 `steps` 里，
 * 由那一方自己的文档负责。
 */
export const HELP_BY_VENDOR: Readonly<Record<string, HelpSlug>> = {
  deepseek: 'model-deepseek',
  'openai-compatible': 'model-openai-compatible',
  // WP374：Anthropic 兼容（Claude 中转站等）和 OpenAI 兼容同一篇（那篇里单有一节）
  'anthropic-compatible': 'model-openai-compatible',
  bailian: 'model-bailian',
  openai: 'model-openai',
  anthropic: 'model-anthropic',
  google: 'model-google',
  'agentsws-cloud': 'agentsws-credits',
}

/**
 * WP157：连接页的 provider 卡（`ProviderView.service`）→ 哪一篇教程。
 *
 * 服务端连接目录（`apps/server/src/catalog.ts`）的 `setup_guide` 里的步骤、成段介绍与外链
 * 全在这些文章里（服务端测试 `help-tutorials.test.ts` 盯着外链不丢，那边有同一份对照）。
 * 没列在这里的（将来新加的、第三方的）卡：步骤与外链在「看教程」的对话框里现拼（`templateGuide`）。
 */
export const HELP_BY_SERVICE: Readonly<Record<string, HelpSlug>> = {
  shopify_admin: 'conn-shopify',
  imap_smtp: 'conn-email',
  gmail: 'conn-google',
  ga4: 'conn-google',
  gsc: 'conn-google',
  youtube_data: 'conn-google',
  google_ads: 'conn-google',
  google_alerts: 'conn-google',
  meta_ads: 'conn-meta',
  instagram_graph: 'conn-meta',
  facebook_graph: 'conn-meta',
  meta_graph: 'conn-meta',
  // WP191（docs/86 §5）：Threads 与 FB / IG 同属 Meta 那一篇；LinkedIn 自己一篇
  threads_api: 'conn-meta',
  linkedin_api: 'conn-linkedin',
  meta_marketing: 'conn-meta',
  whatsapp_business: 'conn-meta',
  tiktok_research: 'conn-tiktok',
  tiktok_content: 'conn-tiktok',
  tiktok_ads: 'conn-tiktok',
  // WP447：六个新平台这一期不用连，卡上的「看教程」打开导出那一篇
  microsoft_ads: 'ads-export',
  pinterest_ads: 'ads-export',
  reddit_ads: 'ads-export',
  linkedin_ads: 'ads-export',
  snapchat_ads: 'ads-export',
  apple_ads: 'ads-export',
  x_api: 'conn-x',
  x_ads: 'conn-x',
  reddit: 'conn-community',
  discord_bot: 'conn-community',
  telegram_bot: 'conn-community',
  klaviyo: 'conn-marketing-logistics',
  shopify_email: 'conn-marketing-logistics',
  aftership: 'conn-marketing-logistics',
  track17: 'conn-marketing-logistics',
}

/**
 * 没写成教程文章的模板（第三方应用包加的），把它自带的步骤与外链拼成一小篇，
 * 在「看教程」的对话框里排出来——卡面上不铺，信息也一条不丢。
 */
export function templateGuide(plan: {
  steps: readonly string[]
  links: readonly { label: string; url: string }[]
}): string {
  const steps = plan.steps.map((step, i) => `${String(i + 1)}. ${step}`)
  const links = plan.links.map((link) => `- [${link.label}](${link.url})`)
  return [...steps, '', ...links].join('\n')
}

/** 一段话的第一句（到第一个句号 / 冒号为止）；本来就一句的原样回。卡面上那一句的退路。 */
export function firstSentence(text: string): string {
  const m = /^[^。：:！？!?]*[。！？!?]?/.exec(text.trim())
  const head = (m?.[0] ?? '').replace(/[：:]$/, '')
  return head === '' ? text.trim() : head
}

/**
 * 一句状态的短说法（「暂时不能连：____」那一格）：到第一个冒号、破折号、句号或分号为止；
 * 整句原话放进旁边的问号。
 */
export function shortReason(text: string): string {
  const m = /^(.+?)(?:：|:|——|。|；)/.exec(text.trim())
  const head = m?.[1]?.trim() ?? ''
  return head.length >= 2 ? head : text.trim()
}

/** 懒加载：键是相对这个文件的路径，值是一个回原文的函数。 */
const ARTICLES = import.meta.glob('../../../../docs/help/*.md', {
  query: '?raw',
  import: 'default',
}) as Record<string, () => Promise<string>>

function loaderFor(slug: HelpSlug, lang: Lang): (() => Promise<string>) | undefined {
  const base = '../../../../docs/help/'
  if (lang === 'en') {
    const en = ARTICLES[`${base}${slug}.en.md`]
    if (en !== undefined) return en
  }
  return ARTICLES[`${base}${slug}.md`]
}

/**
 * 取一篇的原文。英文没写就退回中文（与 `translate()` 同一条退路）；
 * 一篇都没有回 `undefined`（面板照实说"这篇还没写"）。
 */
export async function loadHelpArticle(slug: HelpSlug, lang: Lang): Promise<string | undefined> {
  const load = loaderFor(slug, lang)
  // WP208：开头的元数据（归哪些岗位 / 职责）不是正文，不上页面
  return load === undefined ? undefined : readHelpArticle(await load()).body
}

/** 只给测试用：打包进来的文章文件名（不带目录）。 */
export function bundledHelpFiles(): string[] {
  return Object.keys(ARTICLES).map((k) => k.slice(k.lastIndexOf('/') + 1))
}
