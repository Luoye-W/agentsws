/**
 * 更新日志：`apps/site/src/content/changelog/<日期>-<名字>.md`（中文）与 `.en.md`（英文）。
 * 从 docs/35 挑对外能说的，写成人话；**不自动搬 docs/35**（那是派工记录，太内部）。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Lang, renderDoc, splitFrontmatter } from './markdown.js'
import { repoRoot } from './paths.js'

export const CHANGELOG_DIR = 'apps/site/src/content/changelog'

export interface ChangelogEntry {
  id: string
  date: string
  title: string
  summary: string
  html: string
}

const NAME = /^(\d{4}-\d{2}-\d{2})-([a-z0-9-]+)\.md$/u

export function changelogIds(root: string = repoRoot()): string[] {
  return readdirSync(join(root, CHANGELOG_DIR))
    .filter((f) => NAME.test(f))
    .map((f) => f.replace(/\.md$/u, ''))
}

export function parseEntry(id: string, text: string, lang: Lang): ChangelogEntry {
  const { data, body } = splitFrontmatter(text)
  const date = data.date ?? id.slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) throw new Error(`${id}：date 不是 YYYY-MM-DD`)
  if (!data.title) throw new Error(`${id}：缺 title`)
  const doc = renderDoc(body, { lang, helpSlugs: [] })
  return { id, date, title: data.title, summary: data.summary ?? doc.summary, html: doc.html }
}

/** 全部条目，新的在前；同一天按文件名排。 */
export function loadChangelog(lang: Lang, root: string = repoRoot()): ChangelogEntry[] {
  const dir = join(root, CHANGELOG_DIR)
  return changelogIds(root)
    .sort((a, b) => (a.slice(0, 10) === b.slice(0, 10) ? a.localeCompare(b) : b.localeCompare(a)))
    .map((id) =>
      parseEntry(
        id,
        readFileSync(join(dir, lang === 'en' ? `${id}.en.md` : `${id}.md`), 'utf8'),
        lang,
      ),
    )
}
