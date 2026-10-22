/**
 * 一次构建里全站共用的一份「有哪些内容」：教程、笔记、更新日志，各带公开纯文本，
 * 外加 `/help/index.json`（私有 docs/113 §4.1）。按仓库缓存，页面各自来取不重复读。
 */
import type { HelpIndex } from '@agentsws/contracts'
import { type BlogPost, loadBlog } from './blog.js'
import { type ChangelogEntry, loadChangelog } from './changelog.js'
import { type SiteGit, siteGit, today } from './git.js'
import { type HelpDoc, helpSlugs, loadHelp } from './help.js'
import { buildHelpIndex, changelogMarkdown, publicMarkdown } from './machine.js'
import type { Lang } from './markdown.js'
import { repoRoot } from './paths.js'

export interface SiteCatalog {
  slugs: string[]
  guides: Record<Lang, (HelpDoc & { markdown: string })[]>
  notes: Record<Lang, (BlogPost & { markdown: string })[]>
  changelog: Record<Lang, { entries: ChangelogEntry[]; markdown: string; updated: string }>
  index: HelpIndex
}

const LANGS: readonly Lang[] = ['zh', 'en']
const cache = new Map<string, SiteCatalog>()

export function siteCatalog(root: string = repoRoot(), git: SiteGit = siteGit(root)): SiteCatalog {
  const hit = cache.get(root)
  if (hit !== undefined) return hit
  const slugs = helpSlugs(root, git)
  const per = <T>(f: (lang: Lang) => T): Record<Lang, T> => ({ zh: f('zh'), en: f('en') })
  const guides = per((lang) =>
    slugs.map((s) => {
      const doc = loadHelp(s, lang, root)
      return { ...doc, markdown: publicMarkdown(doc.body, lang, slugs) }
    }),
  )
  const notes = per((lang) =>
    loadBlog(lang, slugs, root, git).map((p) => ({
      ...p,
      markdown: publicMarkdown(`# ${p.title}\n\n${p.body.replace(/^#\s+.*\n+/u, '')}`, lang, slugs),
    })),
  )
  const changelog = per((lang) => {
    const entries = loadChangelog(lang, root)
    return {
      entries,
      markdown: changelogMarkdown(entries, lang),
      updated: entries[0]?.date ?? today(),
    }
  })
  const release = git.latestRelease()?.replace(/^v/u, '')
  const index = buildHelpIndex({
    guides: LANGS.flatMap((l) => guides[l]),
    notes: LANGS.flatMap((l) => notes[l]),
    changelog: LANGS.map((lang) => ({
      lang,
      markdown: changelog[lang].markdown,
      updated: changelog[lang].updated,
      description:
        lang === 'en'
          ? 'What changed in each Agents Workshop release, newest first.'
          : 'Agents 工坊每次更新了什么，新的在前。',
    })),
    ...(release === undefined ? {} : { release }),
    generatedAt: new Date().toISOString(),
  })
  const out = { slugs, guides, notes, changelog, index }
  cache.set(root, out)
  return out
}
