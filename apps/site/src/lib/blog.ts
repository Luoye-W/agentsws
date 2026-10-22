/**
 * 工坊笔记（`/blog/`，私有 docs/113 §2）：思考、「这个功能为什么这样设计」、产品取舍。
 *
 * 源文件：`apps/site/src/content/blog/<YYYY-MM-DD>-<slug>.md`（中文）与 `.en.md`（英文），
 * 头上 `title` / `description` / `date`，可选 `tags`、`draft: true`（草稿不上）。网址只用 `<slug>` 那一段。
 * 一篇都没有时整个栏目（目录页、顶栏入口）都不出。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readHelpArticle } from '@agentsws/contracts'
import { type SiteGit, siteGit } from './git.js'
import { type Lang, type RenderedDoc, renderDoc } from './markdown.js'
import { repoRoot } from './paths.js'

export const BLOG_DIR = 'apps/site/src/content/blog'

const NAME = /^(\d{4}-\d{2}-\d{2})-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/u

export interface BlogPost extends RenderedDoc {
  /** 文件名去掉 `.md`（`2026-10-23-why-approve`）。 */
  id: string
  /** 网址那一段（`why-approve`）。 */
  slug: string
  lang: Lang
  date: string
  description: string
  tags: string[]
  /** 去掉元数据的正文（`.md` 纯文本版用）。 */
  body: string
  updated: string
}

/** 全部（含草稿）的文件 id。 */
export function blogIds(root: string = repoRoot()): string[] {
  try {
    return readdirSync(join(root, BLOG_DIR))
      .filter((f) => NAME.test(f))
      .map((f) => f.replace(/\.md$/u, ''))
  } catch {
    return []
  }
}

export function blogPath(id: string, lang: Lang): string {
  return `${BLOG_DIR}/${lang === 'en' ? `${id}.en.md` : `${id}.md`}`
}

export function parsePost(
  id: string,
  text: string,
  lang: Lang,
  helpSlugs: readonly string[],
  updated: string,
): BlogPost & { draft: boolean } {
  const m = NAME.exec(`${id}.md`)
  if (m?.[1] === undefined || m[2] === undefined)
    throw new Error(`${id}：文件名要是 <日期>-<slug>.md`)
  const { meta, body } = readHelpArticle(text)
  const doc = renderDoc(body, { lang, helpSlugs })
  const title = meta.title ?? doc.title
  if (title === '') throw new Error(`${id}：缺 title`)
  const description = meta.description ?? doc.summary
  return {
    ...doc,
    id,
    slug: m[2],
    lang,
    title,
    summary: description,
    description,
    date: meta.date ?? m[1],
    tags: meta.tags,
    body,
    updated,
    draft: meta.draft,
  }
}

/** 已发表的（不含草稿），新的在前。 */
export function loadBlog(
  lang: Lang,
  helpSlugs: readonly string[],
  root: string = repoRoot(),
  git: SiteGit = siteGit(root),
): BlogPost[] {
  return blogIds(root)
    .map((id) => {
      const path = blogPath(id, lang)
      const text = readFileSync(join(root, path), 'utf8')
      return parsePost(id, text, lang, helpSlugs, git.lastModified(path) ?? id.slice(0, 10))
    })
    .filter((p) => !p.draft)
    .sort((a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug))
}

/** 官网上一篇笔记的地址。 */
export function blogHref(slug: string, lang: Lang): string {
  return `${lang === 'en' ? '/en' : ''}/blog/${slug}/`
}
