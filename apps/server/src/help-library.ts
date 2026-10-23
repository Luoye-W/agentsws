/**
 * 教程上官网（私有 docs/113 §4，Luoye 10-22 定）：本机这边的「帮助库」。
 *
 * - **随包那份**：安装包里带着全部教程（工作台构建时把 `docs/help/*.md` 原样收进 `help-snapshot.json`，
 *   和工作台产物放在一起；开发时直接读仓库的 `docs/help`）。断网、官网打不开时用它。
 * - **官网那份**：启动 30 秒后、之后每 6 小时去官网拉一次目录 `/help/index.json`（带 `If-None-Match`），
 *   指纹变了的那几篇再下纯文本；下回来的先对 sha256，对不上不收。存在工作区数据目录的 `help-cache/` 下。
 *   请求里**不带任何用户信息**：没有账号、没有设备号、没有 cookie，只有 `User-Agent: AgentsWorkshop/<版本>`。
 * - **挑哪一份**：官网那份讲的东西这台已经有（`requires` 不比本机新）→ 用官网的；讲的是新版 → 有随包的就用随包的
 *   （和这台对得上），顶上一句「新版里这部分变了」；随包里没有（整篇是新功能）→ 照样列，标「新版」。
 *
 * 工坊 AI 的「查工坊帮助」也只在这里搜（{@link HelpLibrary.corpus}）——问题不发到官网。
 */
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  HELP_GROUPS,
  HELP_INDEX_PATH,
  HELP_REFRESH_HOURS,
  HELP_REQUIRES_NEXT,
  HELP_SITE_URL,
  type HelpArticleView,
  type HelpCatalogEntry,
  type HelpCatalogView,
  type HelpIndex,
  type HelpIndexItem,
  type HelpKind,
  type HelpLang,
  helpNeedsNewerApp,
  parseHelpIndex,
  readHelpArticle,
} from '@agentsws/contracts'

/** 工作台构建产物里那份随包教程的文件名。 */
export const HELP_SNAPSHOT_FILE = 'help-snapshot.json'

export interface HelpSnapshot {
  schema: 1
  /** 文件名（`conn-shopify.md` / `conn-shopify.en.md`）→ 原文。 */
  files: Record<string, string>
}

export type HelpFetch = (url: string, init?: RequestInit) => Promise<Response>

export interface HelpLibraryOptions {
  appVersion: string
  /** 官网那份存在哪；不给 = 只存在内存里（演示、测试）。 */
  cacheDir?: string
  /** 去不去官网拉（测试、离线环境关掉）。 */
  online?: boolean
  site?: string
  fetch?: HelpFetch
  now?: () => number
  /** 随包那份（不给就按 {@link loadBundledHelpFiles} 找）。 */
  bundled?: Record<string, string>
  /** 工作台构建产物所在（找 `help-snapshot.json`）。 */
  staticDir?: string
  /** 单次请求的超时。 */
  timeoutMs?: number
}

/** 一篇（某种语言）挑好之后的样子。 */
interface Doc extends HelpCatalogEntry {
  markdown?: string
  newer_online: boolean
}

const HOUR = 3_600_000

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

/**
 * 找随包那份：先找工作台产物旁边的 `help-snapshot.json`，再往上找仓库的 `docs/help`（开发时）。
 * 都没有回空表（软件照样能用官网那份）。
 */
export function loadBundledHelpFiles(staticDir?: string): Record<string, string> {
  if (staticDir !== undefined) {
    const file = join(staticDir, HELP_SNAPSHOT_FILE)
    if (existsSync(file)) {
      try {
        const snap = JSON.parse(readFileSync(file, 'utf8')) as Partial<HelpSnapshot>
        if (snap.schema === 1 && typeof snap.files === 'object' && snap.files !== null)
          return { ...snap.files }
      } catch {
        // 坏了就当没有，退到下一处
      }
    }
  }
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 8; i += 1) {
    const help = join(dir, 'docs', 'help')
    if (existsSync(join(dir, 'pnpm-workspace.yaml')) && existsSync(help)) {
      const out: Record<string, string> = {}
      for (const f of readdirSync(help).filter((x) => x.endsWith('.md')))
        out[f] = readFileSync(join(help, f), 'utf8')
      return out
    }
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return {}
}

/** 官网纯文本里指向官网教程的完整网址换回 `help:<slug>`（右栏认的写法）。 */
export function localizeHelpLinks(markdown: string, site: string = HELP_SITE_URL): string {
  const esc = site.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const re = new RegExp(`\\]\\(${esc}(?:/en)?/docs/([a-z0-9]+(?:-[a-z0-9]+)*)/\\)`, 'gu')
  return markdown.replace(re, '](help:$1)')
}

const groupRank = (g: string | undefined): number => {
  const i = HELP_GROUPS.indexOf(g as (typeof HELP_GROUPS)[number])
  return i < 0 ? HELP_GROUPS.length : i
}
const kindRank: Record<HelpKind, number> = { guide: 0, note: 1, changelog: 2 }

function sortEntries<T extends HelpCatalogEntry>(list: T[]): T[] {
  return list.sort(
    (a, b) =>
      kindRank[a.kind] - kindRank[b.kind] ||
      (a.kind === 'note' ? (b.date ?? '').localeCompare(a.date ?? '') : 0) ||
      groupRank(a.group) - groupRank(b.group) ||
      (a.order ?? 1e9) - (b.order ?? 1e9) ||
      a.slug.localeCompare(b.slug),
  )
}

interface CacheState {
  etag?: string
  fetched_at?: string
}

export class HelpLibrary {
  private readonly site: string
  private readonly online: boolean
  private readonly fetchImpl: HelpFetch
  private readonly now: () => number
  private readonly timeoutMs: number
  private readonly bundledFiles: Record<string, string>
  private index: HelpIndex | undefined
  private state: CacheState = {}
  /** 下回来、对过指纹的纯文本（sha256 → 文字）。 */
  private readonly texts = new Map<string, string>()
  private inflight: Promise<boolean> | undefined
  private timers: ReturnType<typeof setTimeout>[] = []

  constructor(private readonly options: HelpLibraryOptions) {
    this.site = (options.site ?? HELP_SITE_URL).replace(/\/+$/u, '')
    this.online = options.online ?? true
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init))
    this.now = options.now ?? Date.now
    this.timeoutMs = options.timeoutMs ?? 10_000
    this.bundledFiles = options.bundled ?? loadBundledHelpFiles(options.staticDir)
    this.restore()
  }

  get appVersion(): string {
    return this.options.appVersion
  }

  // ── 本机存的 ──────────────────────────────────────────────────────────

  private dir(...parts: string[]): string | undefined {
    const root = this.options.cacheDir
    return root === undefined ? undefined : join(root, ...parts)
  }

  private writeAtomic(path: string, text: string): void {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    writeFileSync(tmp, text)
    renameSync(tmp, path)
  }

  /** 启动时把上次存的读回来（坏了就当没有，下次拉了再说）。 */
  private restore(): void {
    const indexFile = this.dir('index.json')
    if (indexFile === undefined || !existsSync(indexFile)) return
    try {
      this.index = parseHelpIndex(JSON.parse(readFileSync(indexFile, 'utf8')), this.site)
      const stateFile = this.dir('state.json')
      if (stateFile !== undefined && existsSync(stateFile))
        this.state = JSON.parse(readFileSync(stateFile, 'utf8')) as CacheState
    } catch {
      this.index = undefined
      this.state = {}
    }
  }

  private cachedText(hash: string): string | undefined {
    const hit = this.texts.get(hash)
    if (hit !== undefined) return hit
    const file = this.dir('md', `${hash}.md`)
    if (file === undefined || !existsSync(file)) return undefined
    const text = readFileSync(file, 'utf8')
    if (sha256(text) !== hash) return undefined
    this.texts.set(hash, text)
    return text
  }

  private keepText(hash: string, text: string): void {
    this.texts.set(hash, text)
    const file = this.dir('md', `${hash}.md`)
    if (file !== undefined) this.writeAtomic(file, text)
  }

  // ── 去官网拉 ──────────────────────────────────────────────────────────

  private async get(url: string, headers: Record<string, string> = {}): Promise<Response> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => {
      ctrl.abort()
    }, this.timeoutMs)
    timer.unref?.()
    try {
      return await this.fetchImpl(url, {
        headers: { 'user-agent': `AgentsWorkshop/${this.options.appVersion}`, ...headers },
        credentials: 'omit',
        signal: ctrl.signal,
      })
    } finally {
      clearTimeout(timer)
    }
  }

  /** 下一篇的纯文本并对指纹；对不上回 `undefined`。 */
  private async download(item: HelpIndexItem): Promise<string | undefined> {
    const have = this.cachedText(item.hash)
    if (have !== undefined) return have
    try {
      const res = await this.get(item.md)
      if (!res.ok) return undefined
      const text = await res.text()
      if (sha256(text) !== item.hash) return undefined
      this.keepText(item.hash, text)
      return text
    } catch {
      return undefined
    }
  }

  /**
   * 拉一次。回「这次拉成了没有」（304 也算成）。同时只有一次在跑；不抛错。
   * 官网改坏了（格式版本不对）就当没拉到，继续用上次的。
   */
  refresh(): Promise<boolean> {
    if (!this.online) return Promise.resolve(false)
    this.inflight ??= this.doRefresh().finally(() => {
      this.inflight = undefined
    })
    return this.inflight
  }

  private async doRefresh(): Promise<boolean> {
    try {
      const res = await this.get(
        `${this.site}${HELP_INDEX_PATH}`,
        this.index !== undefined && this.state.etag !== undefined
          ? { 'if-none-match': this.state.etag }
          : {},
      )
      if (res.status !== 304) {
        if (!res.ok) return false
        const parsed = parseHelpIndex(await res.json(), this.site)
        if (parsed === undefined) return false
        this.index = parsed
        const etag = res.headers.get('etag')
        this.state = etag === null ? {} : { etag }
        const file = this.dir('index.json')
        if (file !== undefined) this.writeAtomic(file, `${JSON.stringify(parsed)}\n`)
      }
      // 指纹变了的那几篇（4 个一起下）
      const queue = [...(this.index?.items ?? [])]
      const worker = async (): Promise<void> => {
        for (let item = queue.shift(); item !== undefined; item = queue.shift())
          await this.download(item)
      }
      await Promise.all([worker(), worker(), worker(), worker()])
      this.prune()
      this.state.fetched_at = new Date(this.now()).toISOString()
      const stateFile = this.dir('state.json')
      if (stateFile !== undefined) this.writeAtomic(stateFile, `${JSON.stringify(this.state)}\n`)
      return true
    } catch {
      return false
    }
  }

  /** 目录里已经没有的旧文删掉。 */
  private prune(): void {
    const keep = new Set((this.index?.items ?? []).map((i) => i.hash))
    for (const hash of [...this.texts.keys()]) if (!keep.has(hash)) this.texts.delete(hash)
    const dir = this.dir('md')
    if (dir === undefined || !existsSync(dir)) return
    for (const f of readdirSync(dir))
      if (f.endsWith('.md') && !keep.has(f.slice(0, -3))) rmSync(join(dir, f), { force: true })
  }

  /** 上次拉成超过 `maxAgeMs`（或从没拉成过）就在后台拉一次（不等）。 */
  refreshIfStale(maxAgeMs: number = 24 * HOUR): void {
    const at = this.state.fetched_at === undefined ? Number.NaN : Date.parse(this.state.fetched_at)
    if (Number.isNaN(at) || this.now() - at > maxAgeMs) void this.refresh()
  }

  /** 起定时：30 秒后一次，之后每 6 小时一次（不拖住进程退出）。 */
  start(): void {
    if (!this.online || this.timers.length > 0) return
    const first = setTimeout(() => void this.refresh(), 30_000)
    const every = setInterval(() => void this.refresh(), HELP_REFRESH_HOURS * HOUR)
    first.unref?.()
    every.unref?.()
    this.timers = [first, every]
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t)
    this.timers = []
  }

  // ── 随包那份 ──────────────────────────────────────────────────────────

  private bundledGuide(slug: string, lang: HelpLang): Doc | undefined {
    const zhText = this.bundledFiles[`${slug}.md`]
    if (zhText === undefined) return undefined
    const zh = readHelpArticle(zhText)
    const enText = lang === 'en' ? this.bundledFiles[`${slug}.en.md`] : undefined
    const own = enText === undefined ? zh : readHelpArticle(enText)
    const meta = zh.meta
    const title = own.meta.title ?? meta.title ?? slug
    const requires = meta.requires
    const doc: Doc = {
      kind: 'guide',
      slug,
      lang,
      title,
      description: own.meta.description ?? meta.description ?? '',
      positions: meta.positions,
      roles: meta.roles,
      source: 'bundled',
      needs_newer_app: helpNeedsNewerApp(requires, this.options.appVersion),
      newer_online: false,
      markdown: own.body,
    }
    if (requires !== HELP_REQUIRES_NEXT)
      doc.url = `${this.site}${lang === 'en' ? '/en' : ''}/docs/${slug}/`
    if (meta.group !== undefined) doc.group = meta.group
    if (meta.order !== undefined) doc.order = meta.order
    if (requires !== undefined) doc.requires = requires
    if (meta.aliases.length > 0) doc.aliases = meta.aliases
    return doc
  }

  private bundledSlugs(): string[] {
    return Object.keys(this.bundledFiles)
      .filter((f) => f.endsWith('.md') && !f.endsWith('.en.md'))
      .map((f) => f.slice(0, -3))
  }

  // ── 挑哪一份 ──────────────────────────────────────────────────────────

  private fromOnline(item: HelpIndexItem): Doc {
    const doc: Doc = {
      kind: item.kind,
      slug: item.slug,
      lang: item.lang,
      title: item.title,
      description: item.description,
      url: item.url,
      positions: item.positions,
      roles: item.roles,
      updated: item.updated,
      source: 'online',
      needs_newer_app: helpNeedsNewerApp(item.requires, this.options.appVersion),
      newer_online: false,
    }
    const text = this.cachedText(item.hash)
    if (text !== undefined) doc.markdown = localizeHelpLinks(text, this.site)
    if (item.group !== undefined) doc.group = item.group
    if (item.order !== undefined) doc.order = item.order
    if (item.requires !== undefined) doc.requires = item.requires
    if (item.aliases !== undefined) doc.aliases = item.aliases
    if (item.date !== undefined) doc.date = item.date
    return doc
  }

  /** 一种语言的全部（每篇挑好用哪一份）。 */
  private docs(lang: HelpLang): Doc[] {
    const out: Doc[] = []
    const covered = new Set<string>()
    for (const item of this.index?.items ?? []) {
      if (item.lang !== lang) continue
      if (item.kind !== 'guide') {
        out.push(this.fromOnline(item))
        continue
      }
      covered.add(item.slug)
      for (const a of item.aliases ?? []) covered.add(a)
      const online = this.fromOnline(item)
      const bundled =
        this.bundledGuide(item.slug, lang) ??
        (item.aliases ?? []).map((a) => this.bundledGuide(a, lang)).find((d) => d !== undefined)
      if (online.needs_newer_app && bundled !== undefined && !bundled.needs_newer_app) {
        // 官网讲的是新版：先给和这台对得上的那份，顶上一句「新版里这部分变了」
        out.push({ ...bundled, slug: item.slug, url: item.url, newer_online: true })
      } else if (online.markdown === undefined && bundled?.markdown !== undefined) {
        // 正文还没下回来：先用随包的，目录信息照官网
        out.push({ ...online, markdown: bundled.markdown, source: 'bundled' })
      } else {
        out.push(online)
      }
    }
    for (const slug of this.bundledSlugs()) {
      if (covered.has(slug)) continue
      const doc = this.bundledGuide(slug, lang)
      if (doc !== undefined) out.push(doc)
    }
    return sortEntries(out)
  }

  private entry(doc: Doc): HelpCatalogEntry {
    const { markdown: _m, newer_online: _n, ...rest } = doc
    return rest
  }

  /** 右栏「教程」的目录。 */
  catalog(lang: HelpLang): HelpCatalogView {
    const view: HelpCatalogView = {
      lang,
      app_version: this.options.appVersion,
      items: this.docs(lang).map((d) => this.entry(d)),
    }
    if (this.state.fetched_at !== undefined) view.fetched_at = this.state.fetched_at
    if (this.index?.release !== undefined) view.release = this.index.release
    return view
  }

  /**
   * 一篇的正文。旧名（`aliases`）也认。官网那份还没下回来就现下一次（等不到就退回随包的）；
   * 哪份都没有回 `undefined`。
   */
  async article(
    slug: string,
    lang: HelpLang,
    kind: HelpKind = 'guide',
  ): Promise<HelpArticleView | undefined> {
    const docs = this.docs(lang).filter((d) => d.kind === kind)
    const doc =
      docs.find((d) => d.slug === slug) ?? docs.find((d) => d.aliases?.includes(slug) === true)
    if (doc === undefined) return undefined
    let markdown = doc.markdown
    if (markdown === undefined && doc.source === 'online') {
      const item = this.index?.items.find(
        (i) => i.kind === kind && i.lang === lang && i.slug === doc.slug,
      )
      const text = item === undefined ? undefined : await this.download(item)
      if (text !== undefined) markdown = localizeHelpLinks(text, this.site)
    }
    if (markdown === undefined) return undefined
    return { ...this.entry(doc), markdown, newer_online: doc.newer_online }
  }

  /** 给「查工坊帮助」：一种语言里全部有正文的（教程、笔记、更新日志）。 */
  corpus(lang: HelpLang): (HelpCatalogEntry & { markdown: string })[] {
    return this.docs(lang).flatMap((d) =>
      d.markdown === undefined ? [] : [{ ...this.entry(d), markdown: d.markdown }],
    )
  }
}

export function createHelpLibrary(options: HelpLibraryOptions): HelpLibrary {
  return new HelpLibrary(options)
}
