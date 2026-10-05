/**
 * WP156（36 §7 第三档）：**教程文章**——卡片上拿下来的步骤清单、成段介绍与外链的去处。
 *
 * 文章是仓库里的 `docs/help/<slug>.md`（中文）与 `docs/help/<slug>.en.md`（英文），
 * 随工作台一起打包（`import.meta.glob`），**离线也能看**；每篇一个 chunk，没打开就不下载。
 * 卡片上的「看教程」= 在右栏「教程」面板里打开 `agentsws://help/<slug>`。
 */
import type { Lang } from '@/lib/i18n'

/**
 * 这一轮写了的教程（顺序 = 右栏「教程」目录的顺序）。
 *
 * 加一篇：`docs/help/` 里放中英两份 md（WP208：中文那份开头写 `positions` / `roles`，都空 = 通用），
 * 这里加一个 slug、`HELP_SCOPES` 照抄一行，i18n 加 `help.<slug>.title`。
 */
export const HELP_SLUGS = [
  'agentsws-credits',
  'model-deepseek',
  'model-openai-compatible',
  'model-bailian',
  'model-openai',
  'model-anthropic',
  'browser',
  'computer-use',
  'search-data',
  // WP157：连接页（每类连接一篇，能合并的合并）
  'conn-shopify',
  'conn-email',
  'conn-google',
  'conn-meta',
  'conn-tiktok',
  'conn-x',
  // WP191（docs/86 §4）：社媒运营的 LinkedIn 那条
  'conn-linkedin',
  'conn-community',
  'conn-marketing-logistics',
  'browser-extension',
  // WP157：消息渠道与网站聊天窗
  'im-channels',
  // WP211：飞书 / 钉钉建应用
  'im-feishu',
  'im-dingtalk',
  'chat-window',
  // WP173：开发信的发信域名（怎么买、怎么配、体检看什么）
  'b2b-sending-domain',
  // WP184：切换 dsh 场景（官方场景开在哪、用户自己装的官方桌面端）
  'dsh-scenes',
  // WP207：对话与任务的归档与找回（左栏三级「+」、状态小点、自动归档、AI 找回）
  'archive',
  // WP218：桌面版安装（Windows SmartScreen / Mac 右键打开）与应用内一键更新
  'install-update',
] as const

export type HelpSlug = (typeof HELP_SLUGS)[number]

/**
 * WP208（Luoye 09-30）：一篇教程归哪些岗位 / 职责。
 *
 * **真源是文章自己的 frontmatter**（`docs/help/<slug>.md` 开头 `positions: [...]` / `roles: [...]`，
 * 中文那份上写；英文那份跟着中文走）。这里是它的镜像：右栏要在**不下载文章**的前提下按上下文排目录，
 * 而文章是各自一个 chunk、点开才下（WP156）。两份对不上时 `test/help-context.test.tsx` 会红——
 * 加一篇教程时在文章头上写好，再照抄到这里。两个都空 = 通用（谁都看得到）。
 */
export interface HelpScope {
  positions: readonly string[]
  roles: readonly string[]
}

export const HELP_SCOPES: Readonly<Record<HelpSlug, HelpScope>> = {
  'agentsws-credits': { positions: [], roles: [] },
  'model-deepseek': { positions: [], roles: [] },
  'model-openai-compatible': { positions: [], roles: [] },
  'model-bailian': { positions: [], roles: [] },
  'model-openai': { positions: [], roles: [] },
  'model-anthropic': { positions: [], roles: [] },
  browser: {
    positions: ['kol-marketing'],
    roles: ['kol.youtube', 'kol.instagram', 'kol.tiktok', 'kol.facebook', 'kol.x', 'amz.support'],
  },
  'computer-use': { positions: [], roles: [] },
  'search-data': { positions: ['web-ops', 'dtc-ops'], roles: ['dtc.content'] },
  'conn-shopify': {
    positions: ['dtc-ops', 'web-ops', 'customer-care', 'site'],
    roles: [
      'dtc.store',
      'dtc.store-config',
      'dtc.catalog',
      'dtc.support',
      'site.shopify-build',
      'site.shopify-theme',
      'site.shopify-apps',
    ],
  },
  'conn-email': {
    positions: ['customer-care', 'kol-marketing', 'b2b', 'pr'],
    roles: ['dtc.support', 'b2b.sales', 'b2b.outbound', 'pr.press'],
  },
  'conn-google': {
    positions: ['web-ops', 'dtc-ops', 'ads', 'pr'],
    roles: [
      'ads.google',
      'kol.youtube',
      'social.youtube',
      'dtc.analytics',
      'dtc.content',
      'pr.monitoring',
    ],
  },
  'conn-meta': {
    positions: ['ads', 'social-media', 'kol-marketing'],
    roles: [
      'ads.meta',
      'kol.instagram',
      'kol.facebook',
      'social.facebook',
      'social.instagram',
      'social.threads',
      'social.whatsapp',
      'social.facebook-group',
    ],
  },
  'conn-tiktok': {
    positions: ['ads', 'social-media', 'kol-marketing'],
    roles: ['ads.tiktok', 'social.tiktok', 'kol.tiktok'],
  },
  'conn-x': {
    positions: ['ads', 'social-media', 'kol-marketing'],
    roles: ['ads.x', 'social.x', 'kol.x'],
  },
  'conn-linkedin': { positions: ['social-media'], roles: ['social.linkedin'] },
  'conn-community': {
    positions: ['social-media', 'pr'],
    roles: ['social.reddit', 'social.discord', 'social.telegram-group', 'pr.reddit', 'pr.forums'],
  },
  'conn-marketing-logistics': {
    positions: ['dtc-ops', 'web-ops', 'customer-care', 'site'],
    roles: ['dtc.email-marketing', 'dtc.fulfillment', 'site.shopify-email', 'dtc.support'],
  },
  'browser-extension': {
    positions: ['kol-marketing'],
    roles: ['kol.youtube', 'kol.instagram', 'kol.tiktok', 'kol.facebook', 'kol.x'],
  },
  'im-channels': { positions: [], roles: [] },
  // WP211：飞书 / 钉钉建应用（团队渠道，谁都可能要看）
  'im-feishu': { positions: [], roles: [] },
  'im-dingtalk': { positions: [], roles: [] },
  'chat-window': { positions: ['customer-care'], roles: ['dtc.live-chat'] },
  'b2b-sending-domain': { positions: ['b2b'], roles: ['b2b.outbound'] },
  'dsh-scenes': { positions: [], roles: [] },
  // WP207：通用（谁都看得到）
  archive: { positions: [], roles: [] },
  // WP218：通用
  'install-update': { positions: [], roles: [] },
}

/**
 * 文章开头那段 `---` 包着的元数据拿掉，并读出 `positions` / `roles`。
 *
 * 只认最简的写法（`key: [a, b]` 一行一个），与站点那边 `splitFrontmatter` 同一种。
 * 没有 frontmatter 的（英文那份）原样回，元数据两个空。
 */
export function splitHelpFrontmatter(text: string): { meta: HelpScope; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/u.exec(text)
  if (m === null) return { meta: { positions: [], roles: [] }, body: text }
  const list = (key: string): string[] => {
    const line = new RegExp(`^${key}:\\s*\\[(.*)\\]\\s*$`, 'mu').exec(m[1] ?? '')
    return (line?.[1] ?? '')
      .split(',')
      .map((x) => x.trim().replace(/^['"]|['"]$/gu, ''))
      .filter((x) => x !== '')
  }
  return {
    meta: { positions: list('positions'), roles: list('roles') },
    body: text.slice(m[0].length),
  }
}

/**
 * WP208：右栏「教程」按当前范围排目录。
 *
 * - 在职责上：先这条职责的，再它所属岗位的，再通用；
 * - 在岗位上：这个岗位的 + 通用；
 * - 哪儿都不在：只有通用。
 *
 * 一篇只出现一次（在最具体的那一组里）；组内照 `HELP_SLUGS` 的顺序。其余的（别的岗位的）
 * 不在这里——搜索与「全部 N 篇」仍然看得到全部。
 */
export function helpForContext(ctx: { role_id?: string; position_id?: string }): {
  role: HelpSlug[]
  position: HelpSlug[]
  general: HelpSlug[]
} {
  const role: HelpSlug[] = []
  const position: HelpSlug[] = []
  const general: HelpSlug[] = []
  for (const slug of HELP_SLUGS) {
    const scope = HELP_SCOPES[slug]
    if (ctx.role_id !== undefined && scope.roles.includes(ctx.role_id)) role.push(slug)
    else if (ctx.position_id !== undefined && scope.positions.includes(ctx.position_id))
      position.push(slug)
    else if (scope.positions.length === 0 && scope.roles.length === 0) general.push(slug)
  }
  return { role, position, general }
}

export function isHelpSlug(value: string): value is HelpSlug {
  return (HELP_SLUGS as readonly string[]).includes(value)
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
  bailian: 'model-bailian',
  openai: 'model-openai',
  anthropic: 'model-anthropic',
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
  return load === undefined ? undefined : splitHelpFrontmatter(await load()).body
}

/** 只给测试用：打包进来的文章文件名（不带目录）。 */
export function bundledHelpFiles(): string[] {
  return Object.keys(ARTICLES).map((k) => k.slice(k.lastIndexOf('/') + 1))
}
