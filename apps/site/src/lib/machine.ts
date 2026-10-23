/**
 * 给软件与 AI 读的那几样（私有 docs/113 §4.1、§6.2）：
 *
 * - `/help/index.json`：全部教程、笔记、更新日志的目录（软件定时拉、本机缓存，契约在 `@agentsws/contracts`）；
 * - `/docs/<slug>.md`、`/blog/<slug>.md`、`/changelog.md`（英文加 `/en`）：每篇的纯文本；
 * - `/llms.txt`、`/llms-full.txt`（英文 `/en/llms-full.txt`）：给各家 AI 一次读懂工坊。
 *
 * 纯文本 = 源文件去掉元数据，互链换成完整网址（`help:<slug>` → 官网那篇），工作台里的路径只留文字 +「在工作台里」，
 * 图片只留说明。软件读回来再把指向官网教程的链接换回右栏。
 */
import { createHash } from 'node:crypto'
import {
  HELP_INDEX_PATH,
  HELP_INDEX_SCHEMA,
  type HelpIndex,
  type HelpIndexItem,
  type HelpLang,
} from '@agentsws/contracts'
import { SITE_URL } from '../config.js'
import { type BlogPost, blogHref } from './blog.js'
import type { ChangelogEntry } from './changelog.js'
import type { HelpDoc } from './help.js'
import { docHref, type Lang } from './markdown.js'

export { HELP_INDEX_PATH }

const IN_APP: Record<Lang, string> = { zh: '（在工作台里）', en: ' (in the app)' }

/** 源文件正文 → 公开的纯文本（链接全部换成完整网址或文字）。 */
export function publicMarkdown(body: string, lang: Lang, slugs: readonly string[]): string {
  const out = body
    .replace(/!\[([^\]\n]*)\]\([^)\s]*\)/gu, '$1')
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/gu, (whole, text: string, href: string) => {
      if (/^https?:\/\//iu.test(href)) return whole
      if (href.startsWith('help:')) {
        const slug = href.slice(5)
        return slugs.includes(slug) ? `[${text}](${SITE_URL}${docHref(slug, lang)})` : text
      }
      if (href.startsWith('/') && !href.startsWith('//')) return `${text}${IN_APP[lang]}`
      return whole
    })
  return `${out.trim()}\n`
}

export const sha256Hex = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex')

const prefix = (lang: Lang): string => (lang === 'en' ? '/en' : '')

export const docMdPath = (slug: string, lang: Lang): string => `${prefix(lang)}/docs/${slug}.md`
export const blogMdPath = (slug: string, lang: Lang): string => `${prefix(lang)}/blog/${slug}.md`
export const changelogMdPath = (lang: Lang): string => `${prefix(lang)}/changelog.md`

/** 一篇教程的纯文本。 */
export function guideMarkdown(doc: HelpDoc, slugs: readonly string[]): string {
  return publicMarkdown(doc.body, doc.lang, slugs)
}

/** 更新日志整份的纯文本（新的在前）。 */
export function changelogMarkdown(entries: readonly ChangelogEntry[], lang: Lang): string {
  const head = lang === 'en' ? '# Agents Workshop changelog' : '# Agents 工坊更新日志'
  const parts = entries.map((e) => `## ${e.date} · ${e.title}\n\n${e.body.trim()}`)
  return `${[head, ...parts].join('\n\n')}\n`
}

export interface IndexInput {
  guides: readonly (HelpDoc & { markdown: string })[]
  notes: readonly (BlogPost & { markdown: string })[]
  changelog: readonly { lang: Lang; markdown: string; updated: string; description: string }[]
  release?: string
  generatedAt: string
}

/** `/help/index.json`。 */
export function buildHelpIndex(input: IndexInput): HelpIndex {
  const items: HelpIndexItem[] = []
  for (const g of input.guides) {
    items.push({
      kind: 'guide',
      slug: g.slug,
      lang: g.lang as HelpLang,
      title: g.title,
      description: g.description,
      url: `${SITE_URL}${docHref(g.slug, g.lang)}`,
      md: `${SITE_URL}${docMdPath(g.slug, g.lang)}`,
      positions: g.positions,
      roles: g.roles,
      group: g.group,
      ...(g.order === undefined ? {} : { order: g.order }),
      ...(g.requires === undefined ? {} : { requires: g.requires }),
      ...(g.aliases.length === 0 ? {} : { aliases: g.aliases }),
      updated: g.updated,
      hash: sha256Hex(g.markdown),
    })
  }
  for (const n of input.notes) {
    items.push({
      kind: 'note',
      slug: n.slug,
      lang: n.lang as HelpLang,
      title: n.title,
      description: n.description,
      url: `${SITE_URL}${blogHref(n.slug, n.lang)}`,
      md: `${SITE_URL}${blogMdPath(n.slug, n.lang)}`,
      positions: [],
      roles: [],
      date: n.date,
      updated: n.updated,
      hash: sha256Hex(n.markdown),
    })
  }
  for (const c of input.changelog) {
    items.push({
      kind: 'changelog',
      slug: 'changelog',
      lang: c.lang as HelpLang,
      title: c.lang === 'en' ? 'Changelog' : '更新日志',
      description: c.description,
      url: `${SITE_URL}${prefix(c.lang)}/changelog/`,
      md: `${SITE_URL}${changelogMdPath(c.lang)}`,
      positions: [],
      roles: [],
      updated: c.updated,
      hash: sha256Hex(c.markdown),
    })
  }
  return {
    schema: HELP_INDEX_SCHEMA,
    generated_at: input.generatedAt,
    ...(input.release === undefined ? {} : { release: input.release }),
    items,
  }
}

const LLMS_INTRO = {
  zh: 'Agents 工坊是专为跨境电商 / 出海卖家打造的开源 AI Agents 工作台（桌面软件，Windows / macOS）：客服、网站运营、投放、红人营销、社媒、B2B、建站等岗位各自干活，要发出去、花钱、改价的事都先出一张卡等人点头。',
  en: 'Agents Workshop is an open-source AI agents workspace for cross-border e-commerce sellers (desktop app for Windows and macOS). Positions such as support, store ops, ads, influencer marketing, social, B2B and site building each do their own work, and anything that sends, spends or changes prices waits for a human to approve a card first.',
} as const

/** `/llms.txt`：一页纸说工坊是什么，再列全部教程与笔记（中英两组）。 */
export function llmsTxt(index: HelpIndex): string {
  const lines = ['# Agents 工坊 / Agents Workshop', '', `> ${LLMS_INTRO.en}`, '', LLMS_INTRO.zh, '']
  const section = (title: string, kind: HelpIndexItem['kind'], lang: Lang) => {
    const list = index.items.filter((i) => i.kind === kind && i.lang === lang)
    if (list.length === 0) return
    lines.push(`## ${title}`, '')
    for (const i of list) lines.push(`- [${i.title}](${i.md}): ${i.description}`)
    lines.push('')
  }
  section('Guides (English)', 'guide', 'en')
  section('教程（中文）', 'guide', 'zh')
  section('Notes (English)', 'note', 'en')
  section('工坊笔记（中文）', 'note', 'zh')
  lines.push(
    '## Optional',
    '',
    `- [Full text of all guides (English)](${SITE_URL}/en/llms-full.txt)`,
    `- [全部教程全文（中文）](${SITE_URL}/llms-full.txt)`,
    `- [Changelog](${SITE_URL}/en/changelog.md)`,
    `- [更新日志](${SITE_URL}/changelog.md)`,
    `- [Machine-readable index](${SITE_URL}${HELP_INDEX_PATH})`,
    '',
  )
  return lines.join('\n')
}

/** `/llms-full.txt`（中文）与 `/en/llms-full.txt`：全部教程与笔记的全文，每篇前面一行出处。 */
export function llmsFullTxt(
  lang: Lang,
  docs: readonly { title: string; url: string; markdown: string; updated: string }[],
): string {
  const head = `# ${lang === 'en' ? 'Agents Workshop — all guides and notes' : 'Agents 工坊 · 全部教程与笔记'}\n\n${LLMS_INTRO[lang]}\n`
  const parts = docs.map(
    (d) =>
      `\n---\n\n${lang === 'en' ? 'Source' : '出处'}: ${d.url} (${lang === 'en' ? 'updated' : '更新于'} ${d.updated})\n\n${d.markdown.trim()}\n`,
  )
  return head + parts.join('')
}
