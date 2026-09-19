/**
 * 存那份 `DESIGN.md`，并把三条来路的结果并进去（71，WP122）。
 *
 * 抽取、合并、序列化全在 `@agentsws/brand-design`（纯函数 + 注入的端口）；
 * 这里只管四件事：**存哪儿、版本怎么留、抓那一轮的页面从哪来、改一格怎么落**。
 *
 * ## 为什么这一份要落盘，而 WP121 的 run 不用
 *
 * 那边的 run 是**临时的**：活到用户点「看着没问题」为止，真正要留的东西在那一刻
 * 写进了工作区档案与知识库。这边不一样——`DESIGN.md` **自己就是那个要留的东西**。
 * 四个岗位每次出活都要读它，用户随时会在界面上改一格，版本历史要能翻回去。
 * 所以它有一张表，与 `apps/server/src/design.ts` 同一个形状
 * （`id TEXT PRIMARY KEY, json TEXT NOT NULL`，各包各自一个 `.sqlite` 文件）。
 *
 * ## `markdown` 是真源
 *
 * `tokens` 与 `profile` 是从它解析出来的投影，但反过来也成立（界面上改一个色块
 * 会重新序列化出 `markdown`）。所以这三格**永远一起写**——
 * {@link writeDoc} 是唯一的写入口，没有第二条路能只更新其中一格。
 * 两边不一致这种 bug，在这里是写不出来的。
 */

import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { BrandDesignActor, BrandDesignPort } from '@agentsws/api'
import {
  composeDesignProse,
  type DesignComposeModel,
  type DesignPageInput,
  type DesignPageKind,
  editValue,
  extractFileDesign,
  extractSiteDesign,
  fetchStylesheets,
  mergeDesignProfile,
  parseDesignMd,
  profileFromTokens,
  serializeDesignMd,
  tokensOf,
} from '@agentsws/brand-design'
import type { PageFetch } from '@agentsws/brand-intake'
import type {
  BrandDesignDoc,
  BrandDesignProfile,
  BrandDesignRevision,
  BrandDesignRun,
  Clock,
  PersonId,
  WorkspaceId,
} from '@agentsws/contracts'
import { BRAND_DESIGN_MAX_FILE_PAGES, DEFAULT_BRAND_DESIGN_CAP_CREDITS } from '@agentsws/contracts'
import type BetterSqlite3 from 'better-sqlite3'

/* ── 存储 ─────────────────────────────────────────────────────────────── */

/** 两张表：当前那一份，与它的每一版。 */
export type BrandDesignTable = 'brand_design_doc' | 'brand_design_revision'

export const BRAND_DESIGN_TABLES: readonly BrandDesignTable[] = [
  'brand_design_doc',
  'brand_design_revision',
]

const SCHEMA = BRAND_DESIGN_TABLES.map(
  (t) => `CREATE TABLE IF NOT EXISTS ${t} (id TEXT PRIMARY KEY, json TEXT NOT NULL);`,
).join('\n')

interface Backend {
  all<T>(table: BrandDesignTable): T[]
  get<T>(table: BrandDesignTable, id: string): T | undefined
  put(table: BrandDesignTable, id: string, row: unknown): void
  close(): void
}

function createMemoryBackend(): Backend {
  const tables = new Map<BrandDesignTable, Map<string, unknown>>()
  const of = (t: BrandDesignTable): Map<string, unknown> => {
    const found = tables.get(t)
    if (found !== undefined) return found
    const fresh = new Map<string, unknown>()
    tables.set(t, fresh)
    return fresh
  }
  return {
    all: <T>(t: BrandDesignTable) => [...of(t).values()].map((r) => structuredClone(r) as T),
    get: <T>(t: BrandDesignTable, id: string) => {
      const row = of(t).get(id)
      return row === undefined ? undefined : (structuredClone(row) as T)
    },
    put: (t, id, row) => {
      of(t).set(id, structuredClone(row))
    },
    close: () => tables.clear(),
  }
}

function createSqliteBackend(dbPath: string): Backend {
  const require = createRequire(import.meta.url)
  const Database = require('better-sqlite3') as typeof BetterSqlite3
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA)
  return {
    all: <T>(t: BrandDesignTable) =>
      (db.prepare(`SELECT json FROM ${t} ORDER BY id`).all() as { json: string }[]).map(
        (r) => JSON.parse(r.json) as T,
      ),
    get: <T>(t: BrandDesignTable, id: string) => {
      const row = db.prepare(`SELECT json FROM ${t} WHERE id = ?`).get(id) as
        | { json: string }
        | undefined
      return row === undefined ? undefined : (JSON.parse(row.json) as T)
    },
    put: (t, id, row) => {
      db.prepare(
        `INSERT INTO ${t} (id, json) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET json = excluded.json`,
      ).run(id, JSON.stringify(row))
    },
    close: () => {
      db.close()
    },
  }
}

/* ── 装配 ─────────────────────────────────────────────────────────────── */

/** 抓那一轮要的页面。**默认从 WP121 最近那一次分析手上拿**，一个页面都不重抓。 */
export type DesignPageSource = () =>
  | Promise<readonly DesignPageInput[]>
  | readonly DesignPageInput[]

/** 一份已经传上来的手册的字节（WP99 的上传链路给）。 */
export type UploadReader = (
  upload_id: string,
) => Promise<{ filename: string; bytes: Uint8Array } | undefined>

export interface BrandDesignOptions {
  clock: Clock
  workspace_id: WorkspaceId
  /** 这个品牌的落盘目录。不给就全内存（测试与"还没选品牌"时）。 */
  dbDir?: string
  /** 抓外链样式表那一口。生产传 `globalThis.fetch`，测试传夹具。 */
  fetch: PageFetch
  /** 页面从哪来（见 {@link DesignPageSource}）。 */
  pages: DesignPageSource
  /** 传上来的手册从哪读。不给就 `/v1/brand-design/files` 回"这个进程没装上传"。 */
  readUpload?: UploadReader
  /** 成文那一口。不给就退回按令牌直述（见 `composeDesignProse`）。 */
  model?: DesignComposeModel
  newId: (prefix: string) => string
}

export interface BrandDesignAssembly {
  port: BrandDesignPort
  close(): void
}

/** 库里那一份的 id：**一个工作区一份**，所以 id 就是工作区 id。 */
const docIdOf = (workspace_id: string): string => workspace_id

export function createBrandDesign(options: BrandDesignOptions): BrandDesignAssembly {
  const backend =
    options.dbDir === undefined
      ? createMemoryBackend()
      : createSqliteBackend(join(options.dbDir, 'brand-design.sqlite'))

  const now = (): string => options.clock.now()

  /** 这一份是这个工作区的吗。不是就当**不存在**——不泄露"有这么个 id"。 */
  const read = (actor: BrandDesignActor): BrandDesignDoc | undefined => {
    const doc = backend.get<BrandDesignDoc>('brand_design_doc', docIdOf(actor.workspace_id))
    return doc?.workspace_id === actor.workspace_id ? doc : undefined
  }

  /**
   * **唯一的写入口。**
   *
   * `markdown` / `tokens` / `profile` 三格一起算、一起落，外面没有第二条路能
   * 只更新其中一格——"界面上的色块和文件里的色值对不上"这种 bug 在这里写不出来。
   */
  const writeDoc = (
    actor: BrandDesignActor,
    next: { profile: BrandDesignProfile; markdown?: string },
    reason: BrandDesignRevision['reason'],
    note?: string,
  ): BrandDesignDoc => {
    const previous = read(actor)
    const markdown = next.markdown ?? serializeDesignMd(next.profile, proseOf(previous))
    const at = now()
    const doc: BrandDesignDoc = {
      id: docIdOf(actor.workspace_id),
      schema_version: 1,
      workspace_id: actor.workspace_id as WorkspaceId,
      revision: (previous?.revision ?? 0) + 1,
      markdown,
      tokens: tokensOf(next.profile),
      profile: next.profile,
      created_at: previous?.created_at ?? at,
      updated_at: at,
      ...(reason === 'manual_edit' || reason === 'paste_replace'
        ? { updated_by: actor.person_id as PersonId }
        : {}),
    }
    backend.put('brand_design_doc', doc.id, doc)
    const revision: BrandDesignRevision = {
      doc_id: doc.id,
      revision: doc.revision,
      markdown,
      at,
      reason,
      ...(doc.updated_by === undefined ? {} : { by: doc.updated_by }),
      ...(note === undefined ? {} : { note }),
    }
    // 版本行的 id 带上零填充的版本号，这样 `ORDER BY id` 就是版本序
    backend.put(
      'brand_design_revision',
      `${doc.id}:${String(doc.revision).padStart(6, '0')}`,
      revision,
    )
    return doc
  }

  /** 上一版的正文（重抓时留着——散文不该因为色值刷新了就丢掉）。 */
  const proseOf = (doc: BrandDesignDoc | undefined): Record<string, string> =>
    doc === undefined ? {} : (parseDesignMd(doc.markdown).prose as Record<string, string>)

  const runOf = (
    status: BrandDesignRun['status'],
    extra: Partial<BrandDesignRun>,
    actor: BrandDesignActor,
  ): BrandDesignRun => ({
    id: options.newId('bdr'),
    schema_version: 1,
    workspace_id: actor.workspace_id as WorkspaceId,
    status,
    origins: [],
    pages: [],
    files: [],
    profile: {},
    budget: {
      estimated_credits: 0,
      cap_credits: DEFAULT_BRAND_DESIGN_CAP_CREDITS,
      spent_credits: 0,
    },
    created_at: now(),
    updated_at: now(),
    ...extra,
  })

  const port: BrandDesignPort = {
    get: (actor) => read(actor),

    revisions: (actor) =>
      backend
        .all<BrandDesignRevision>('brand_design_revision')
        .filter((r) => r.doc_id === docIdOf(actor.workspace_id)),

    /**
     * 从官网抓一轮。
     *
     * **同步跑完再回**，与 WP121 的后台跑不同：那一轮要抓十几个页面、几十秒；
     * 这一轮的页面已经在手上了，只多几份样式表。让用户看着一个转圈等两秒，
     * 比给他一个要轮询的 run id 简单得多。
     */
    extract: async (actor, input) => {
      const cap = input.cap_credits ?? DEFAULT_BRAND_DESIGN_CAP_CREDITS
      const pages = await options.pages()
      if (pages.length === 0)
        return runOf(
          'failed',
          { origins: ['site'], failure: '还没有抓回来的页面。先在品牌设置里填上网址跑一轮分析。' },
          actor,
        )

      const sheets = await fetchStylesheets(options.fetch, pages)
      const withSheets: DesignPageInput[] = pages.map((p) => ({
        ...p,
        sheets: sheets.get(p.url) ?? [],
      }))
      const fresh = extractSiteDesign(withSheets)
      const previous = read(actor)
      const merged = mergeDesignProfile(previous?.profile ?? {}, fresh)

      const composed = await composeDesignProse({
        profile: merged,
        capCredits: cap,
        ...(options.model === undefined ? {} : { model: options.model }),
      })
      writeDoc(
        actor,
        { profile: merged, markdown: composed.markdown },
        'site_extract',
        noteOf(fresh),
      )

      return runOf(
        composed.stopped_for_budget ? 'budget_exceeded' : 'awaiting_confirm',
        {
          origins: ['site'],
          pages: withSheets.map((p) => ({ url: p.url, ok: true })),
          profile: merged,
          budget: composed.budget,
        },
        actor,
      )
    },

    /** 读一份已经传上来的手册。**手册里写的优先级高于官网抓到的**（71 §2）。 */
    ingestFile: async (actor, input) => {
      if (options.readUpload === undefined)
        return runOf(
          'failed',
          { origins: ['file'], failure: '这个服务进程没有装配文件上传' },
          actor,
        )
      const file = await options.readUpload(input.upload_id)
      if (file === undefined)
        return runOf('failed', { origins: ['file'], failure: '找不到这个文件，重新传一次' }, actor)

      const got = extractFileDesign({
        filename: file.filename,
        bytes: file.bytes,
        maxPages: BRAND_DESIGN_MAX_FILE_PAGES,
      })
      if (got.failure !== undefined)
        return runOf(
          'failed',
          {
            origins: ['file'],
            files: [
              {
                upload_id: input.upload_id,
                filename: file.filename,
                contributed: [],
                failure: got.failure,
              },
            ],
            failure: got.failure,
          },
          actor,
        )

      const previous = read(actor)
      // 方向是 (库里的, 手册的)：手册赢，但输的那个留在 `conflict` 里
      const merged = mergeDesignProfile(previous?.profile ?? {}, got.profile)
      writeDoc(
        actor,
        { profile: merged },
        'file_extract',
        `${file.filename}：${noteOf(got.profile)}`,
      )

      return runOf(
        'awaiting_confirm',
        {
          origins: ['file'],
          files: [
            {
              upload_id: input.upload_id,
              filename: file.filename,
              pages: got.pagesRead,
              contributed: got.contributed,
            },
          ],
          profile: merged,
        },
        actor,
      )
    },

    /** 改一格。值给 `null` = 这一格我不要，删掉而不是留一个空值。 */
    edit: (actor, input) => {
      const doc = read(actor)
      if (doc === undefined)
        throw Object.assign(new Error('这个品牌还没有设计规范'), { code: 'not_found' })
      const profile = setAt(doc.profile, input.path, input.value, now())
      return writeDoc(actor, { profile }, 'manual_edit', `改了 ${input.path}`)
    },

    /** 整份粘贴替换。**粘进来什么就是什么**——每一格标 `edited`，重抓时不动。 */
    replace: (actor, input) => {
      const parsed = parseDesignMd(input.markdown)
      const profile = profileFromTokens(parsed.tokens)
      return writeDoc(
        actor,
        { profile, markdown: input.markdown },
        'paste_replace',
        parsed.failure ?? '整份替换',
      )
    },
  }

  return { port, close: () => backend.close() }
}

/** 一句人话（「抓到 6 色 2 字体」），进版本历史。 */
function noteOf(profile: BrandDesignProfile): string {
  const colors = Object.keys(profile.colors ?? {}).length
  const fonts = new Set(
    Object.values(profile.typography ?? {})
      .map((v) => v.value.fontFamily)
      .filter((x): x is string => x !== undefined),
  ).size
  const logos = profile.logos?.value.length ?? 0
  return `抓到 ${String(colors)} 色 · ${String(fonts)} 字体 · ${String(logos)} 个 logo`
}

/**
 * 按令牌路径写一格。
 *
 * 只认两层（`colors.primary`）与三层（`components.button-primary.rounded`），
 * 因为档案里就只有这两种深度。路径不认得就抛——**不悄悄往一个新建的格子里写**，
 * 那样界面上会冒出一个谁也不认识的令牌。
 */
export function setAt(
  profile: BrandDesignProfile,
  path: string,
  value: unknown,
  at: string,
): BrandDesignProfile {
  const parts = path.split('.')
  const out = structuredClone(profile) as Record<string, unknown>
  const [group, key, sub] = parts

  if (parts.length === 1 && group !== undefined) {
    if (value === null || value === undefined) delete out[group]
    else out[group] = editValue(value, at)
    return out as BrandDesignProfile
  }

  if (parts.length === 2 && group !== undefined && key !== undefined) {
    const bucket = (out[group] ?? {}) as Record<string, unknown>
    if (value === null || value === undefined) delete bucket[key]
    else bucket[key] = editValue(value, at)
    if (Object.keys(bucket).length === 0) delete out[group]
    else out[group] = bucket
    return out as BrandDesignProfile
  }

  if (parts.length === 3 && group !== undefined && key !== undefined && sub !== undefined) {
    const bucket = (out[group] ?? {}) as Record<string, Record<string, unknown>>
    const inner = bucket[key] ?? {}
    if (value === null || value === undefined) delete inner[sub]
    else inner[sub] = editValue(value, at)
    if (Object.keys(inner).length === 0) delete bucket[key]
    else bucket[key] = inner
    if (Object.keys(bucket).length === 0) delete out[group]
    else out[group] = bucket
    return out as BrandDesignProfile
  }

  throw Object.assign(new Error(`认不得这个令牌路径：${path}`), { code: 'invalid_argument' })
}

/** 这一页是什么页（抓取那一轮按它挑取样页）。 */
export function designPageKindOf(url: string): DesignPageKind {
  if (/\/products?\//i.test(url)) return 'product'
  if (/\/collections?\/|\/category\//i.test(url)) return 'collection'
  if (/\/blogs?\/|\/news\//i.test(url)) return 'blog'
  return 'home'
}
