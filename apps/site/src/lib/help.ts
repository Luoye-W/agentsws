/**
 * 文档区：直接读仓库里的 `docs/help/<slug>.md`（中文）与 `<slug>.en.md`（英文），**不复制一份**。
 *
 * 目录顺序照工作台 `apps/workstation/src/lib/help.ts` 的 `HELP_SLUGS`（加一篇教程只在那一处加）。
 * 这里不 import 工作台的源码（它带着工作台的路径别名），而是按字面把那个数组读出来；
 * `test/help.test.ts` 钉住「数组里每一篇都有中英两份、目录里没有漏的」。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Lang, type RenderedDoc, renderDoc } from './markdown.js'
import { repoRoot } from './paths.js'

export const HELP_SOURCE = 'apps/workstation/src/lib/help.ts'
export const HELP_DIR = 'docs/help'

/** 从工作台那份源码里按字面取出 `HELP_SLUGS`（顺序即目录顺序）。 */
export function parseHelpSlugs(source: string): string[] {
  const m = /export const HELP_SLUGS = \[([\s\S]*?)\] as const/u.exec(source)
  if (m?.[1] === undefined) throw new Error(`${HELP_SOURCE} 里没找到 HELP_SLUGS`)
  return [...m[1].replace(/\/\/.*$/gmu, '').matchAll(/'([a-z0-9-]+)'/gu)].map((x) => x[1] ?? '')
}

export function helpSlugs(root: string = repoRoot()): string[] {
  return parseHelpSlugs(readFileSync(join(root, HELP_SOURCE), 'utf8'))
}

export function helpFile(slug: string, lang: Lang, root: string = repoRoot()): string {
  return join(root, HELP_DIR, lang === 'en' ? `${slug}.en.md` : `${slug}.md`)
}

export interface HelpDoc extends RenderedDoc {
  slug: string
}

export function loadHelp(slug: string, lang: Lang, root: string = repoRoot()): HelpDoc {
  const text = readFileSync(helpFile(slug, lang, root), 'utf8')
  return { slug, ...renderDoc(text, { lang, helpSlugs: helpSlugs(root) }) }
}

/** 目录分组（只是摆法，不改顺序）：按 slug 前缀归到几类。 */
export function helpGroup(slug: string): 'start' | 'models' | 'tools' | 'connect' | 'channels' {
  if (slug === 'agentsws-credits') return 'start'
  if (slug.startsWith('model-')) return 'models'
  if (slug.startsWith('conn-') || slug === 'browser-extension' || slug === 'b2b-sending-domain')
    return 'connect'
  if (slug === 'im-channels' || slug === 'chat-window') return 'channels'
  return 'tools'
}
