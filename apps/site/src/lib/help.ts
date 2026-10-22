/**
 * 文档区：直接读仓库里的 `docs/help/<slug>.md`（中文）与 `<slug>.en.md`（英文），**不复制一份**。
 *
 * 教程上官网（私有 docs/113）起，目录、分组、顺序、摘要、归哪些岗位全写在**文章自己头上**
 * （`group` / `order` / `description` / `positions` / `roles`，格式见 `@agentsws/contracts` 的 `readHelpArticle`），
 * 官网与软件都从这里读，不再照抄工作台的清单。
 *
 * 头上写 `requires: next` 的（讲的是还没发版的功能）：官网用最新正式版时的文字；那时还没有这篇就先不上。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  HELP_GROUPS,
  HELP_REQUIRES_NEXT,
  type HelpArticleMeta,
  type HelpGroup,
  readHelpArticle,
} from '@agentsws/contracts'
import { type SiteGit, siteGit, today } from './git.js'
import { type Lang, type RenderedDoc, renderDoc } from './markdown.js'
import { repoRoot } from './paths.js'

export const HELP_DIR = 'docs/help'
/** 这几个名字被官网自己的页面占了（`/docs/roles/` 是岗位汇总页），教程不能叫这些。 */
export const RESERVED_HELP_SLUGS = ['roles'] as const

const ZH_FILE = /^([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/u

export function helpPath(slug: string, lang: Lang): string {
  return `${HELP_DIR}/${lang === 'en' ? `${slug}.en.md` : `${slug}.md`}`
}

export function helpFile(slug: string, lang: Lang, root: string = repoRoot()): string {
  return join(root, helpPath(slug, lang))
}

/** 官网上实际用的那一版原文（已按 `requires: next` 处理）。 */
export interface HelpSource {
  slug: string
  lang: Lang
  /** 中文那份的元数据；英文那份只覆盖 `title` / `description`。 */
  meta: HelpArticleMeta
  /** 去掉元数据的正文（第一行是 `# 标题`）。 */
  body: string
  /** 这篇讲的东西从哪一版起有（`next` 已换成那个正式版的版本号）。 */
  requires?: string
  /** 最后修改日。 */
  updated: string
}

const sources = new Map<string, HelpSource | null>()

/**
 * 读一篇。还没发版、上一个正式版里也没有的回 `undefined`（官网先不上）。
 * `git` 可以换成替身（测试用）。
 */
export function helpSource(
  slug: string,
  lang: Lang,
  root: string = repoRoot(),
  git: SiteGit = siteGit(root),
): HelpSource | undefined {
  const key = `${root}\0${slug}\0${lang}`
  const hit = sources.get(key)
  if (hit !== undefined) return hit ?? undefined
  const found = resolveSource(slug, lang, root, git)
  sources.set(key, found ?? null)
  return found
}

/** 只给测试用：清掉读过的缓存。 */
export function clearHelpCache(): void {
  sources.clear()
}

function resolveSource(
  slug: string,
  lang: Lang,
  root: string,
  git: SiteGit,
): HelpSource | undefined {
  const readNow = (l: Lang): string | undefined => {
    try {
      return readFileSync(helpFile(slug, l, root), 'utf8')
    } catch {
      return undefined
    }
  }
  let zhText = readNow('zh')
  if (zhText === undefined) return undefined
  let enText = readNow('en')
  let releasedAs: string | undefined
  if (readHelpArticle(zhText).meta.requires === HELP_REQUIRES_NEXT) {
    // 讲的是还没发版的功能：用最新正式版时的文字；那时还没有这篇就先不上
    const tag = git.latestRelease()
    const old = tag === undefined ? undefined : git.showAt(tag, helpPath(slug, 'zh'))
    if (tag === undefined || old === undefined) return undefined
    zhText = old
    enText = git.showAt(tag, helpPath(slug, 'en')) ?? enText
    releasedAs = tag.replace(/^v/u, '')
  }
  const zh = readHelpArticle(zhText)
  const own = lang === 'en' && enText !== undefined ? readHelpArticle(enText) : zh
  const meta: HelpArticleMeta = { ...zh.meta }
  if (lang === 'en') {
    delete meta.title
    delete meta.description
    if (own.meta.title !== undefined) meta.title = own.meta.title
    if (own.meta.description !== undefined) meta.description = own.meta.description
  }
  // 那一版里也还写着 next：就是那一版起有的
  const requires = meta.requires === HELP_REQUIRES_NEXT ? releasedAs : meta.requires
  delete meta.requires
  const updated =
    git.lastModified(helpPath(slug, lang === 'en' && enText !== undefined ? 'en' : 'zh')) ?? today()
  return {
    slug,
    lang,
    meta,
    body: own.body,
    ...(requires === undefined ? {} : { requires }),
    updated,
  }
}

const groupRank = (g: HelpGroup | undefined): number =>
  g === undefined ? HELP_GROUPS.length : HELP_GROUPS.indexOf(g)

/** 官网上的全部教程（顺序 = 分组的顺序，组内按 `order`）。 */
export function helpSlugs(root: string = repoRoot(), git: SiteGit = siteGit(root)): string[] {
  const list = readdirSync(join(root, HELP_DIR))
    .map((f) => ZH_FILE.exec(f)?.[1])
    .filter((s): s is string => s !== undefined)
    .flatMap((slug) => {
      const src = helpSource(slug, 'zh', root, git)
      return src === undefined ? [] : [src]
    })
  return list
    .sort(
      (a, b) =>
        groupRank(a.meta.group) - groupRank(b.meta.group) ||
        (a.meta.order ?? 1e9) - (b.meta.order ?? 1e9) ||
        a.slug.localeCompare(b.slug),
    )
    .map((s) => s.slug)
}

export interface HelpDoc extends RenderedDoc {
  slug: string
  lang: Lang
  /** 去掉元数据的正文原文（纯文本版用）。 */
  body: string
  group: HelpGroup
  order?: number
  aliases: string[]
  /** 头上的 `description`；没写就是正文第一段。 */
  description: string
  positions: string[]
  roles: string[]
  requires?: string
  updated: string
}

export function loadHelp(slug: string, lang: Lang, root: string = repoRoot()): HelpDoc {
  const src = helpSource(slug, lang, root)
  if (src === undefined) throw new Error(`没有这一篇教程（或还没发版）：${slug}`)
  const doc = renderDoc(src.body, { lang, helpSlugs: helpSlugs(root) })
  return {
    slug,
    lang,
    body: src.body,
    ...doc,
    ...(src.meta.order === undefined ? {} : { order: src.meta.order }),
    aliases: src.meta.aliases,
    summary: src.meta.description ?? doc.summary,
    description: src.meta.description ?? doc.summary,
    group: src.meta.group ?? 'tools',
    positions: src.meta.positions,
    roles: src.meta.roles,
    ...(src.requires === undefined ? {} : { requires: src.requires }),
    updated: src.updated,
  }
}

/** 目录分组（只是摆法）。 */
export function helpGroup(slug: string, root: string = repoRoot()): HelpGroup {
  return helpSource(slug, 'zh', root)?.meta.group ?? 'tools'
}
