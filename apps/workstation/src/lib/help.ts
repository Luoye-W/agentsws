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
 * 加一篇：`docs/help/` 里放中英两份 md，这里加一个 slug，i18n 加 `help.<slug>.title`。
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
] as const

export type HelpSlug = (typeof HELP_SLUGS)[number]

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
  return load === undefined ? undefined : await load()
}

/** 只给测试用：打包进来的文章文件名（不带目录）。 */
export function bundledHelpFiles(): string[] {
  return Object.keys(ARTICLES).map((k) => k.slice(k.lastIndexOf('/') + 1))
}
