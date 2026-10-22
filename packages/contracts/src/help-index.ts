/**
 * 教程上官网（私有 docs/113，Luoye 10-22 定）：**官网为主、软件从官网拉**。
 *
 * 官网（`apps/site`）出一份目录 `/help/index.json` 和每篇一份纯文本 `.md`；
 * 本机服务启动后与每 6 小时去拉、存在本机；安装包里另带一份完整教程做兜底。
 * 工坊 AI 的「查工坊帮助」也只在本机这份里搜——用户的问题不发到官网。
 *
 * 这里放三方共用的东西：目录的格式、读进来时的校验、文章开头元数据的写法、版本比较。
 * 不放网络、不放存储。
 */

/** 官网地址（软件只认这一个站上的链接；开发时可用 `AGENTSWS_HELP_SITE` 指到本机）。 */
export const HELP_SITE_URL = 'https://agentsws.com'
/** 目录文件在官网上的路径。 */
export const HELP_INDEX_PATH = '/help/index.json'
/** 目录格式版本（只增：读不懂的大版本整份不认，退回本机那份）。 */
export const HELP_INDEX_SCHEMA = 1
/** 软件多久去官网拉一次目录。 */
export const HELP_REFRESH_HOURS = 6
/**
 * 文章头上 `requires: next` = 这篇讲的东西**还没发版**。官网先不换（用上一个正式版时的文字），
 * 发版时 `scripts/help-stamp-release.mjs <版本>` 把它换成真实版本号。
 */
export const HELP_REQUIRES_NEXT = 'next'

/** 三种内容：教程、工坊笔记（思考与「为什么这样设计」）、更新日志（每种语言一整份）。 */
export const HELP_KINDS = ['guide', 'note', 'changelog'] as const
export type HelpKind = (typeof HELP_KINDS)[number]

export const HELP_LANGS = ['zh', 'en'] as const
export type HelpLang = (typeof HELP_LANGS)[number]

/** 教程的分组（官网目录与软件「全部」的摆法），顺序即摆的顺序。 */
export const HELP_GROUPS = ['start', 'models', 'connect', 'channels', 'tools'] as const
export type HelpGroup = (typeof HELP_GROUPS)[number]

/** 目录里的一条（一篇的一种语言）。 */
export interface HelpIndexItem {
  kind: HelpKind
  /** 英文小写、连字符；定了不改（改了写进新那篇的 `aliases`）。 */
  slug: string
  lang: HelpLang
  title: string
  /** 一两句话的答案（官网摘要、搜索结果、AI 引用都用它）。 */
  description: string
  /** 官网页面（完整网址）。 */
  url: string
  /** 纯文本版（完整网址）。 */
  md: string
  /** 归哪些岗位 / 职责（都空 = 通用）。 */
  positions: string[]
  roles: string[]
  /** 教程才有。 */
  group?: HelpGroup
  order?: number
  /** 这篇讲的东西从哪一版起有（没有 = 一直有）。 */
  requires?: string
  /** 改过名的旧 slug。 */
  aliases?: string[]
  /** 笔记的发表日（`YYYY-MM-DD`）。 */
  date?: string
  /** 最后修改日（`YYYY-MM-DD`）。 */
  updated: string
  /** 纯文本版的 sha256（十六进制）：软件据此判断要不要重新下载、下载的对不对。 */
  hash: string
}

export interface HelpIndex {
  schema: typeof HELP_INDEX_SCHEMA
  generated_at: string
  /** 官网教程对应的最新正式版（取不到就没有）。 */
  release?: string
  items: HelpIndexItem[]
}

const isStr = (x: unknown): x is string => typeof x === 'string'
const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x)
const strList = (x: unknown): string[] | undefined =>
  Array.isArray(x) && x.every(isStr) ? [...x] : undefined

export const HELP_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const DAY = /^\d{4}-\d{2}-\d{2}$/u
const HEX64 = /^[0-9a-f]{64}$/u

/** 链接只认 `site` 这个站（防目录被人改成指向别处）。 */
function onSite(url: unknown, site: string): url is string {
  return isStr(url) && (url === site || url.startsWith(`${site}/`))
}

/** 校验一条；不合格回 `undefined`（只丢这一条，不连累整份）。 */
export function parseHelpIndexItem(
  raw: unknown,
  site: string = HELP_SITE_URL,
): HelpIndexItem | undefined {
  if (!isObj(raw)) return undefined
  const { kind, slug, lang, title, description, url, md, updated, hash } = raw
  if (!isStr(kind) || !(HELP_KINDS as readonly string[]).includes(kind)) return undefined
  if (!isStr(slug) || !HELP_SLUG_PATTERN.test(slug)) return undefined
  if (!isStr(lang) || !(HELP_LANGS as readonly string[]).includes(lang)) return undefined
  if (!isStr(title) || title.trim() === '' || !isStr(description)) return undefined
  if (!onSite(url, site) || !onSite(md, site)) return undefined
  if (!isStr(updated) || !DAY.test(updated) || !isStr(hash) || !HEX64.test(hash)) return undefined
  const positions = strList(raw.positions) ?? []
  const roles = strList(raw.roles) ?? []
  const item: HelpIndexItem = {
    kind: kind as HelpKind,
    slug,
    lang: lang as HelpLang,
    title,
    description,
    url,
    md,
    positions,
    roles,
    updated,
    hash,
  }
  if (isStr(raw.group) && (HELP_GROUPS as readonly string[]).includes(raw.group))
    item.group = raw.group as HelpGroup
  if (typeof raw.order === 'number' && Number.isFinite(raw.order)) item.order = raw.order
  if (isStr(raw.requires) && raw.requires !== '') item.requires = raw.requires
  const aliases = strList(raw.aliases)?.filter((a) => HELP_SLUG_PATTERN.test(a))
  if (aliases !== undefined && aliases.length > 0) item.aliases = aliases
  if (isStr(raw.date) && DAY.test(raw.date)) item.date = raw.date
  return item
}

/** 读官网拉回来的目录：格式版本不对整份不认（回 `undefined`），单条不合格只丢那一条。 */
export function parseHelpIndex(raw: unknown, site: string = HELP_SITE_URL): HelpIndex | undefined {
  if (!isObj(raw) || raw.schema !== HELP_INDEX_SCHEMA || !Array.isArray(raw.items)) return undefined
  if (!isStr(raw.generated_at)) return undefined
  const items: HelpIndexItem[] = []
  for (const x of raw.items) {
    const item = parseHelpIndexItem(x, site)
    if (item !== undefined) items.push(item)
  }
  return {
    schema: HELP_INDEX_SCHEMA,
    generated_at: raw.generated_at,
    ...(isStr(raw.release) && raw.release !== '' ? { release: raw.release } : {}),
    items,
  }
}

// ── 文章开头的元数据 ─────────────────────────────────────────────────────

/**
 * 文章头上那段 `---` 包着的元数据（只认最简的写法：一行一个 `key: value`，列表写成 `[a, b]`）。
 *
 * 教程（`docs/help/<slug>.md`）：`description`、`group`、`order`、`positions`、`roles`，可选
 * `requires`、`aliases`；英文那份（`.en.md`）只写 `description`，其余跟中文走。
 * 笔记（`apps/site/src/content/blog/<日期>-<slug>.md`）：`title`、`description`、`date`，可选 `tags`、`draft`。
 * 标题默认取正文第一个 `#`。
 */
export interface HelpArticleMeta {
  title?: string
  description?: string
  group?: HelpGroup
  order?: number
  positions: string[]
  roles: string[]
  requires?: string
  aliases: string[]
  date?: string
  tags: string[]
  draft: boolean
}

/** 拆出元数据（原样的键值）与正文；没有元数据的原样回。 */
export function splitHelpFrontmatter(text: string): {
  data: Record<string, string | string[]>
  body: string
} {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u.exec(text)
  if (m === null) return { data: {}, body: text }
  const data: Record<string, string | string[]> = {}
  const unquote = (s: string): string => s.trim().replace(/^(['"])(.*)\1$/u, '$2')
  for (const line of (m[1] ?? '').split(/\r?\n/u)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/u.exec(line.trim())
    if (kv?.[1] === undefined) continue
    const value = (kv[2] ?? '').trim()
    const list = /^\[(.*)\]$/u.exec(value)
    data[kv[1]] =
      list === null
        ? unquote(value)
        : (list[1] ?? '')
            .split(',')
            .map(unquote)
            .filter((x) => x !== '')
  }
  return { data, body: text.slice(m[0].length) }
}

/** 拆出元数据（按 {@link HelpArticleMeta} 认好）与正文。 */
export function readHelpArticle(text: string): { meta: HelpArticleMeta; body: string } {
  const { data, body } = splitHelpFrontmatter(text)
  const str = (k: string): string | undefined => {
    const v = data[k]
    return typeof v === 'string' && v !== '' ? v : undefined
  }
  const list = (k: string): string[] => {
    const v = data[k]
    return Array.isArray(v) ? v : []
  }
  const meta: HelpArticleMeta = {
    positions: list('positions'),
    roles: list('roles'),
    aliases: list('aliases'),
    tags: list('tags'),
    draft: str('draft') === 'true',
  }
  const title = str('title') ?? helpTitleOf(body)
  if (title !== undefined) meta.title = title
  const description = str('description')
  if (description !== undefined) meta.description = description
  const group = str('group')
  if (group !== undefined && (HELP_GROUPS as readonly string[]).includes(group))
    meta.group = group as HelpGroup
  const order = Number(str('order'))
  if (str('order') !== undefined && Number.isFinite(order)) meta.order = order
  const requires = str('requires')
  if (requires !== undefined) meta.requires = requires
  const date = str('date')
  if (date !== undefined && DAY.test(date)) meta.date = date
  return { meta, body }
}

/** 正文第一个 `#` 标题（去掉行内记号）；没有回 `undefined`。 */
export function helpTitleOf(body: string): string | undefined {
  const m = /^#\s+(.+?)\s*$/mu.exec(body)
  if (m?.[1] === undefined) return undefined
  return m[1].replace(/\*\*|__|`/gu, '').trim()
}

// ── 版本 ─────────────────────────────────────────────────────────────────

/**
 * `0.2.1-beta.7` 这一类的比较（与桌面壳 `updater.ts` 的 `compareVersions` 同一套规矩：
 * 数字段逐个比，带预发布段的小于同号正式版，预发布段按点分段比）。
 */
export function compareHelpVersion(a: string, b: string): number {
  const split = (v: string): { nums: number[]; pre: string[] } => {
    const [core = '', ...rest] = v.trim().replace(/^v/u, '').split('-')
    const pre = rest.join('-')
    return {
      nums: core.split('.').map((n) => Number.parseInt(n, 10) || 0),
      pre: pre === '' ? [] : pre.split('.'),
    }
  }
  const x = split(a)
  const y = split(b)
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i += 1) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  if (x.pre.length === 0 && y.pre.length > 0) return 1
  if (x.pre.length > 0 && y.pre.length === 0) return -1
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i += 1) {
    const l = x.pre[i]
    const r = y.pre[i]
    if (l === r) continue
    if (l === undefined) return -1
    if (r === undefined) return 1
    const ln = Number.parseInt(l, 10)
    const rn = Number.parseInt(r, 10)
    if (Number.isNaN(ln) || Number.isNaN(rn)) return l < r ? -1 : 1
    return ln < rn ? -1 : 1
  }
  return 0
}

/**
 * 这篇讲的东西这台还没有吗（`requires` 比本机版本新）。`next` 一律算「还没有」；
 * 开发版（`0.0.0` / `0.0.0-dev`）一律算「有」——开发时看的就是最新的。
 */
export function helpNeedsNewerApp(requires: string | undefined, appVersion: string): boolean {
  if (requires === undefined || requires === '') return false
  if (/^0\.0\.0(?:-|$)/u.test(appVersion.replace(/^v/u, ''))) return false
  if (requires === HELP_REQUIRES_NEXT) return true
  return compareHelpVersion(appVersion, requires) < 0
}

// ── 本机服务给工作台的视图（`GET /v1/help/catalog`、`GET /v1/help/articles/:slug`）──────────

/** 软件里显示的这一份从哪来：官网拉回来存在本机的，还是安装包自带的。 */
export type HelpSourceKind = 'online' | 'bundled'

/** 目录里的一条（已按本机版本挑好用哪一份）。 */
export interface HelpCatalogEntry {
  kind: HelpKind
  slug: string
  lang: HelpLang
  title: string
  description: string
  /** 官网页面（安装包自带、官网还没有的那几篇没有）。 */
  url?: string
  positions: string[]
  roles: string[]
  group?: HelpGroup
  order?: number
  requires?: string
  aliases?: string[]
  date?: string
  updated?: string
  source: HelpSourceKind
  /** 这篇讲的东西这台还没有（新版才有，目录里标「新版」）。 */
  needs_newer_app: boolean
}

export interface HelpCatalogView {
  lang: HelpLang
  app_version: string
  items: HelpCatalogEntry[]
  /** 最近一次从官网拉成功的时间；从没拉成功过就没有。 */
  fetched_at?: string
  /** 官网教程对应的最新正式版。 */
  release?: string
}

/** 一篇的正文。 */
export interface HelpArticleView extends HelpCatalogEntry {
  /** 去掉元数据的 markdown（教程互链是 `help:<slug>`）。 */
  markdown: string
  /**
   * 显示的是安装包自带那份（和这台的版本对得上），官网上那份讲的是新版——
   * 顶上一句「新版里这部分变了 · 去更新」。
   */
  newer_online: boolean
}
