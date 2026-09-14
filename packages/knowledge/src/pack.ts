/**
 * Extracted from KefuAgent `src/lib/support/knowledge-pack.ts` +
 * `knowledge-pack-import.ts`（`kefu-knowledge-pack/v1` 的格式、极简 YAML 子集、
 * 标题切分、承诺类判定、上限），rewritten for agentsws（48 §4 #9）。
 *
 * **双向**：外面的包进得来，我们的库出得去。这不只是个导入功能——
 * D 期的迁移工具（把旧 SaaS 的知识搬过来）就站在这块地基上。
 *
 * 格式（v1）：
 *
 * ```text
 * pack.yaml                      # name, product, version, generatedAt, generator, languages
 * 01-product-overview.md
 * 02-features/<feature>.md
 * 03-pricing-and-billing.md      # 承诺类
 * 04-account-and-security.md
 * 05-integrations.md
 * 06-troubleshooting.md
 * 07-faq.md
 * 08-policies.md                 # 承诺类
 * 09-boundaries.md               # 承诺类
 * ```
 *
 * 每个 md 带 front matter：`title / category / audience / source_paths /
 * last_verified / confidence`（外加我们自己的 `stage_scope` 与 `verification`）。
 *
 * **为什么自己写 YAML**：要读的不是任意 YAML，是我们自己定义的一个子集——
 * 顶层 `key: value` 与 `- item` 列表，仅此而已。超出子集的行**告警而不报错**：
 * 用户的 AI 多写了一层嵌套，不该让整包导入失败。
 */
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import type { FactCard, Iso8601, KnowledgeStage, PersonId, RangeRef } from '@agentsws/contracts'
import { extractFactFingerprint } from './fact-fingerprint.js'
import { isCommitmentCard } from './provenance.js'

export const KNOWLEDGE_PACK_FORMAT = 'kefu-knowledge-pack/v1'
/** 整包 UTF-8 字节上限。文档不是网盘：2 MiB 的纯文本已经是几十万字。 */
export const PACK_MAX_TOTAL_BYTES = 2 * 1024 * 1024
export const PACK_MAX_FILES = 200
export const PACK_MAX_ENTRIES = 400
/** 单条正文上限（超出截断，不丢条目）。 */
export const PACK_MAX_ENTRY_CHARS = 20_000
export const PACK_MANIFEST_FILE = 'pack.yaml'

/**
 * 承诺类文件：这三类的条目**永不自动激活**，一律落候选等人确认。
 *
 * 判定按**文件名**，不按 front matter——front matter 是用户的 AI 写的，
 * 承诺类判定不能交给被审对象自己填。
 */
export const PACK_COMMITMENT_FILE_KEYS: readonly string[] = [
  '03-pricing-and-billing',
  '08-policies',
  '09-boundaries',
]

export type PackAudience = 'customer' | 'internal'
export type PackConfidence = 'low' | 'medium' | 'high'

export interface PackFile {
  path: string
  content: string
}

export interface PackManifest {
  name: string
  product: string | null
  version: string
  generated_at: string | null
  generator: string | null
  languages: string[]
}

export interface PackEntry {
  /** 确定性 slug：`kp-<包>-<文件>-<标题>`。同名标题必得同 slug（幂等锚）。 */
  slug: string
  title: string
  category: string
  audience: PackAudience
  source_paths: string[]
  /** `YYYY-MM-DD`；缺省 **null，绝不伪造成今天**。 */
  last_verified: string | null
  confidence: PackConfidence | null
  stage: KnowledgeStage
  verification: 'fresh' | 'stale'
  body: string
  /** sha256(标题 + 正文) 前 16 位，同版本重导入的 no-op 判据。 */
  content_hash: string
  file_path: string
  file_key: string
  /** 承诺类（03 / 08 / 09）→ 落候选等人确认。 */
  commitment: boolean
}

export type PackErrorCode =
  | 'PACK_MANIFEST_MISSING'
  | 'PACK_MANIFEST_INVALID'
  | 'PACK_EMPTY'
  | 'PACK_TOO_LARGE'
  | 'PACK_TOO_MANY_FILES'
  | 'PACK_TOO_MANY_ENTRIES'

export type PackParseResult =
  | { ok: true; manifest: PackManifest; entries: PackEntry[]; warnings: string[] }
  | { ok: false; code: PackErrorCode; message: string }

/* -------------------------------------------------------------------- */
/* 极简 YAML 子集                                                        */
/* -------------------------------------------------------------------- */

export type MiniYamlValue = string | string[]

function stripQuotes(raw: string): string {
  const v = raw.trim()
  if (v.length >= 2) {
    const a = v[0]
    const b = v[v.length - 1]
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) return v.slice(1, -1)
  }
  return v
}

function stripInlineComment(raw: string): string {
  const v = raw.trim()
  if (v.startsWith('"') || v.startsWith("'")) return v
  const i = v.indexOf(' #')
  return i === -1 ? v : v.slice(0, i)
}

function parseInlineList(raw: string): string[] | null {
  const v = raw.trim()
  if (!v.startsWith('[') || !v.endsWith(']')) return null
  const inner = v.slice(1, -1).trim()
  if (inner === '') return []
  return inner
    .split(',')
    .map(stripQuotes)
    .filter((x) => x.length > 0)
}

const KEY_RE = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/

export function parseMiniYaml(source: string): {
  values: Record<string, MiniYamlValue>
  warnings: string[]
} {
  const values: Record<string, MiniYamlValue> = {}
  const warnings: string[] = []
  let pendingListKey: string | null = null
  for (const rawLine of source.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.replace(/\s+$/, '')
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue

    if (trimmed.startsWith('- ') || trimmed === '-') {
      if (pendingListKey === null) {
        warnings.push(`忽略无归属的列表项：${trimmed.slice(0, 60)}`)
        continue
      }
      const item = stripQuotes(stripInlineComment(trimmed.replace(/^-\s*/, '')))
      if (item !== '') (values[pendingListKey] as string[]).push(item)
      continue
    }
    if (line.length - line.trimStart().length > 0) {
      warnings.push(`忽略不支持的缩进行：${trimmed.slice(0, 60)}`)
      continue
    }
    const m = KEY_RE.exec(trimmed)
    if (m === null) {
      warnings.push(`忽略无法解析的行：${trimmed.slice(0, 60)}`)
      continue
    }
    const key = m[1] as string
    const value = stripInlineComment(m[2] ?? '')
    if (value === '') {
      values[key] = []
      pendingListKey = key
      continue
    }
    pendingListKey = null
    values[key] = parseInlineList(value) ?? stripQuotes(value)
  }
  return { values, warnings }
}

const asString = (v: MiniYamlValue | undefined): string | null => {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t === '' ? null : t
}
const asList = (v: MiniYamlValue | undefined): string[] => {
  if (Array.isArray(v)) return v.map((x) => x.trim()).filter((x) => x !== '')
  const one = asString(v)
  return one === null ? [] : [one]
}

const FRONT_MATTER_RE = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/

export function splitFrontMatter(source: string): {
  values: Record<string, MiniYamlValue>
  body: string
  warnings: string[]
} {
  const normalized = source.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  const m = FRONT_MATTER_RE.exec(normalized)
  if (m === null) return { values: {}, body: normalized, warnings: [] }
  const parsed = parseMiniYaml(m[1] ?? '')
  return { values: parsed.values, body: normalized.slice(m[0].length), warnings: parsed.warnings }
}

/* -------------------------------------------------------------------- */
/* 标题切分                                                              */
/* -------------------------------------------------------------------- */

interface HeadingHit {
  level: number
  title: string
  line: number
}

/** 找 ATX 标题行，**跳过围栏代码块内部**——`# 注释` 在 shell 代码块里到处都是。 */
function findHeadings(lines: readonly string[]): HeadingHit[] {
  const hits: HeadingHit[] = []
  let fence: string | null = null
  for (const [i, line] of lines.entries()) {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (fenceMatch !== null) {
      const marker = (fenceMatch[1] as string)[0] as string
      if (fence === null) fence = marker
      else if (fence === marker) fence = null
      continue
    }
    if (fence !== null) continue
    const h = /^(#{1,6})\s+(.*\S)\s*$/.exec(line)
    if (h !== null)
      hits.push({ level: (h[1] as string).length, title: (h[2] as string).trim(), line: i })
  }
  return hits
}

/**
 * 取最浅的标题层级；但那一层**只出现一次且是全文第一个标题**时它是文档标题，
 * 不是条目分界（`# 产品概览` + 一串 `## 功能` 是生成 prompt 的常见产物），下沉一级再判。
 */
function resolveSplitLevel(headings: readonly HeadingHit[]): number | null {
  if (headings.length === 0) return null
  const levels = [...new Set(headings.map((h) => h.level))].sort((a, b) => a - b)
  for (const [i, level] of levels.entries()) {
    const atLevel = headings.filter((h) => h.level === level)
    const loneDocTitle =
      atLevel.length === 1 && headings[0]?.level === level && i < levels.length - 1
    if (!loneDocTitle) return level
  }
  return levels[levels.length - 1] ?? null
}

export interface PackSection {
  title: string
  body: string
}

export function splitMarkdownSections(markdown: string, fallbackTitle: string): PackSection[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const headings = findHeadings(lines)
  const splitLevel = resolveSplitLevel(headings)
  const boundaries = splitLevel === null ? [] : headings.filter((h) => h.level === splitLevel)
  const first = boundaries[0]
  if (first === undefined) {
    const body = markdown.trim()
    return body === '' ? [] : [{ title: fallbackTitle, body }]
  }
  const sections: PackSection[] = []
  const docTitle = headings.find(
    (h) => splitLevel !== null && h.level < splitLevel && h.line < first.line,
  )
  const preamble = lines
    .slice(docTitle === undefined ? 0 : docTitle.line + 1, first.line)
    .join('\n')
    .trim()
  if (preamble !== '') sections.push({ title: fallbackTitle, body: preamble })
  for (const [i, b] of boundaries.entries()) {
    const end = boundaries[i + 1]?.line ?? lines.length
    sections.push({
      title: b.title,
      body: lines
        .slice(b.line + 1, end)
        .join('\n')
        .trim(),
    })
  }
  return sections.filter((s) => s.title !== '' || s.body !== '')
}

/* -------------------------------------------------------------------- */
/* slug / hash / 文件键                                                  */
/* -------------------------------------------------------------------- */

const sha = (v: string): string => createHash('sha256').update(v).digest('hex')

/** ASCII 化后小写连字符；中文标题 ASCII 化后为空 → 落回哈希前 8 位（仍然确定性）。 */
export function slugifyPackSegment(value: string): string {
  const ascii = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return ascii === '' ? `h${sha(value.trim()).slice(0, 8)}` : ascii.slice(0, 48)
}

export const PACK_SLUG_PREFIX = 'kp-'

export function buildPackSlug(args: { pack: string; file_path: string; title: string }): string {
  const file = args.file_path.replace(/\.mdx?$/i, '')
  const body = [
    slugifyPackSegment(args.pack),
    slugifyPackSegment(file),
    slugifyPackSegment(args.title),
  ].join('-')
  return `${PACK_SLUG_PREFIX}${body}`.slice(0, 150)
}

export const packContentHash = (title: string, body: string): string =>
  sha(`${title.trim()}\n\n${body.replace(/\r\n?/g, '\n').trim()}`).slice(0, 16)

/** `02-features/webhooks.md` → `02-features`；`08-policies.md` → `08-policies`。 */
export function packFileKey(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/').replace(/^\.?\//, '')
  return (normalized.split('/')[0] ?? normalized).replace(/\.mdx?$/i, '')
}

export const isCommitmentFileKey = (key: string): boolean => PACK_COMMITMENT_FILE_KEYS.includes(key)

/* -------------------------------------------------------------------- */
/* 解析                                                                  */
/* -------------------------------------------------------------------- */

const normalizeAudience = (raw: string | null): PackAudience =>
  raw?.toLowerCase() === 'internal' ? 'internal' : 'customer'

const normalizeConfidence = (raw: string | null): PackConfidence | null => {
  const v = raw?.toLowerCase()
  return v === 'low' || v === 'medium' || v === 'high' ? v : null
}

const normalizeStage = (raw: string | null): KnowledgeStage => {
  const v = raw?.toLowerCase()
  return v === 'presales' || v === 'postsales' ? v : 'both'
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/
const normalizeLastVerified = (raw: string | null): string | null => {
  if (raw === null) return null
  const v = raw.slice(0, 10)
  return DATE_ONLY_RE.test(v) ? v : null
}

const isManifestPath = (path: string): boolean => {
  const base = path.replace(/\\/g, '/').split('/').pop() ?? path
  return base === PACK_MANIFEST_FILE || base === 'pack.yml'
}
const isMarkdownPath = (path: string): boolean => /\.mdx?$/i.test(path)

/**
 * 上传的包常带一层顶层目录（`kefu-knowledge-pack/pack.yaml`）。以清单所在目录为根
 * 改写路径——否则文件键会变成那个目录名，承诺类判定与 slug 全部错位。
 */
function stripPackRoot(files: readonly PackFile[]): PackFile[] {
  const flat = files.map((f) => ({
    ...f,
    path: f.path.replace(/\\/g, '/').replace(/^\.?\//, ''),
  }))
  const manifest = flat.find((f) => isManifestPath(f.path))
  if (manifest === undefined) return flat
  const slash = manifest.path.lastIndexOf('/')
  if (slash === -1) return flat
  const prefix = `${manifest.path.slice(0, slash)}/`
  return flat.map((f) => ({
    ...f,
    path: f.path.startsWith(prefix) ? f.path.slice(prefix.length) : f.path,
  }))
}

export function parseKnowledgePack(inputFiles: readonly PackFile[]): PackParseResult {
  if (inputFiles.length === 0)
    return { ok: false, code: 'PACK_EMPTY', message: '知识包里没有任何文件。' }
  if (inputFiles.length > PACK_MAX_FILES)
    return {
      ok: false,
      code: 'PACK_TOO_MANY_FILES',
      message: `知识包文件数超过上限（${PACK_MAX_FILES}）。`,
    }
  const totalBytes = inputFiles.reduce((n, f) => n + Buffer.byteLength(f.content ?? '', 'utf8'), 0)
  if (totalBytes > PACK_MAX_TOTAL_BYTES)
    return {
      ok: false,
      code: 'PACK_TOO_LARGE',
      message: `知识包超过大小上限（${Math.floor(PACK_MAX_TOTAL_BYTES / 1024)} KB）。`,
    }

  const files = stripPackRoot(inputFiles)
  const manifestFile = files.find((f) => isManifestPath(f.path))
  if (manifestFile === undefined)
    return {
      ok: false,
      code: 'PACK_MANIFEST_MISSING',
      message: `知识包缺少 ${PACK_MANIFEST_FILE}。`,
    }

  const warnings: string[] = []
  const parsed = parseMiniYaml(manifestFile.content ?? '')
  warnings.push(...parsed.warnings.map((w) => `pack.yaml: ${w}`))
  const name = asString(parsed.values.name)
  const version = asString(parsed.values.version)
  if (name === null || version === null)
    return {
      ok: false,
      code: 'PACK_MANIFEST_INVALID',
      message: 'pack.yaml 至少需要 name 与 version 两个字段。',
    }
  const manifest: PackManifest = {
    name,
    version,
    product: asString(parsed.values.product),
    generated_at: asString(parsed.values.generatedAt) ?? asString(parsed.values.generated_at),
    generator: asString(parsed.values.generator),
    languages: asList(parsed.values.languages),
  }

  const entries: PackEntry[] = []
  const seen = new Map<string, number>()
  for (const file of files
    .filter((f) => isMarkdownPath(f.path))
    .sort((a, b) => (a.path < b.path ? -1 : 1))) {
    const fm = splitFrontMatter(file.content ?? '')
    warnings.push(...fm.warnings.map((w) => `${file.path}: ${w}`))
    const fileKey = packFileKey(file.path)
    const fallbackTitle = asString(fm.values.title) ?? file.path.replace(/\.mdx?$/i, '')
    const category = asString(fm.values.category) ?? fileKey
    const commitment = isCommitmentFileKey(fileKey) || isCommitmentFileKey(category)

    for (const section of splitMarkdownSections(fm.body, fallbackTitle)) {
      const title = (section.title === '' ? fallbackTitle : section.title).slice(0, 160)
      const body = section.body.slice(0, PACK_MAX_ENTRY_CHARS)
      if (body.trim() === '') continue
      let slug = buildPackSlug({ pack: manifest.name, file_path: file.path, title })
      const n = seen.get(slug)
      if (n === undefined) seen.set(slug, 1)
      else {
        seen.set(slug, n + 1)
        slug = `${slug}-${n + 1}`
      }
      entries.push({
        slug,
        title,
        category: category.slice(0, 100),
        audience: normalizeAudience(asString(fm.values.audience)),
        source_paths: asList(fm.values.source_paths ?? fm.values.sourcePaths),
        last_verified: normalizeLastVerified(
          asString(fm.values.last_verified) ?? asString(fm.values.lastVerified),
        ),
        confidence: normalizeConfidence(asString(fm.values.confidence)),
        stage: normalizeStage(asString(fm.values.stage_scope) ?? asString(fm.values.stage)),
        verification:
          asString(fm.values.verification)?.toLowerCase() === 'stale' ? 'stale' : 'fresh',
        body,
        content_hash: packContentHash(title, body),
        file_path: file.path,
        file_key: fileKey,
        commitment,
      })
    }
  }
  if (entries.length === 0)
    return {
      ok: false,
      code: 'PACK_EMPTY',
      message: '知识包里没有解析出任何条目（md 文件为空或只有 front matter）。',
    }
  if (entries.length > PACK_MAX_ENTRIES)
    return {
      ok: false,
      code: 'PACK_TOO_MANY_ENTRIES',
      message: `知识包条目数超过上限（${PACK_MAX_ENTRIES}）。`,
    }
  return { ok: true, manifest, entries, warnings }
}

/* -------------------------------------------------------------------- */
/* 包 → 事实卡                                                           */
/* -------------------------------------------------------------------- */

const CONFIDENCE_VALUE: Record<PackConfidence, number> = { low: 0.4, medium: 0.65, high: 0.85 }

export interface PackImportContext {
  workspace_id: string
  owner: PersonId
  scope: RangeRef[]
  created_by_id: string
  /** 包不带时间时用它（`generated_at` 或现在）。 */
  at: Iso8601
}

export type FactCardDraft = Omit<FactCard, 'id' | 'status' | 'usage' | 'created_at' | 'updated_at'>

/**
 * 48 §5.1 v1 的字段对照表，落成代码：
 *
 * | 知识包 v1 | FactCard |
 * |---|---|
 * | `body`（md 正文） | `statement` |
 * | `title` | `subject.key` |
 * | `category` | `subject.type` |
 * | `stage_scope` | `stage` |
 * | `audience: internal` | `sensitivity: 'internal'`（`customer` → `public`） |
 * | `source_paths[]` | `provenance[].ref` |
 * | `last_verified` | `last_verified_at` + `valid.from` |
 * | 条目内容 hash | `source_content_hash` + `fact_fingerprint`（从正文抽） |
 * | `verification: stale` | `verification_state` |
 * | 承诺类文件（03 / 08 / 09） | 不自动激活：留在 `proposed`（候选） |
 * | `confidence` low/medium/high | `confidence.value` 0.4 / 0.65 / 0.85 |
 */
export function packEntryToCard(entry: PackEntry, ctx: PackImportContext): FactCardDraft {
  const at = entry.last_verified === null ? ctx.at : `${entry.last_verified}T00:00:00.000Z`
  const refs = entry.source_paths.length > 0 ? entry.source_paths : [entry.file_path]
  const confidence = entry.confidence === null ? 0.5 : CONFIDENCE_VALUE[entry.confidence]
  return {
    schema_version: 1,
    workspace_id: ctx.workspace_id,
    // 承诺类进来就是 policy 层（19 §2：只有 owner 能决）
    layer: entry.commitment ? 'policy' : 'fact',
    domain: 'knowledge',
    scope: ctx.scope,
    // audience=internal → 内部层；对客的条目本来就是要念给客户听的，公开级
    sensitivity: entry.audience === 'internal' ? 'internal' : 'public',
    subject: { type: entry.category, key: entry.title },
    statement: entry.body,
    structured: { pack_slug: entry.slug, file_key: entry.file_key },
    provenance: refs.map((ref) => ({ source: 'document' as const, ref, at })),
    confidence: { value: confidence, state: 'unverified' as const },
    valid: entry.last_verified === null ? {} : { from: at },
    stage: entry.stage,
    fact_fingerprint: extractFactFingerprint(`${entry.title}\n\n${entry.body}`),
    verification_state: entry.verification,
    source_content_hash: entry.content_hash,
    ...(entry.last_verified === null ? {} : { last_verified_at: at }),
    owner: ctx.owner,
    created_by: { kind: 'agent' as const, id: ctx.created_by_id },
  }
}

/**
 * 这条进来之后能不能自动激活。
 *
 * 承诺类不行（§4 #6）。其余的也只在 front matter 说了 `confidence: high` 且
 * 带了核实日期时才行——包是别人的 AI 生成的，默认当候选看。
 */
export function canActivatePackEntry(entry: PackEntry): boolean {
  if (entry.commitment) return false
  return entry.confidence === 'high' && entry.last_verified !== null
}

/* -------------------------------------------------------------------- */
/* 事实卡 → 包                                                           */
/* -------------------------------------------------------------------- */

const yamlValue = (v: string): string => (/^[\w./-]+$/.test(v) ? v : JSON.stringify(v))

/** 一张卡该写进包里的哪个文件（层与主题决定，反过来读时承诺类判定才对得上）。 */
export function packFileOf(card: FactCard): string {
  if (card.layer === 'policy') return '08-policies.md'
  if (card.layer === 'phrasing') return '07-faq.md'
  if (card.layer === 'historical_case') return '06-troubleshooting.md'
  const key = `${card.subject.type} ${card.subject.key}`.toLowerCase()
  if (/(pricing|price|billing|定价|价格|账单)/.test(key)) return '03-pricing-and-billing.md'
  if (/(account|security|账号|安全)/.test(key)) return '04-account-and-security.md'
  if (/(integration|api|集成|对接)/.test(key)) return '05-integrations.md'
  if (/(boundary|boundaries|边界)/.test(key)) return '09-boundaries.md'
  return '01-product-overview.md'
}

/**
 * 整库 → `kefu-knowledge-pack/v1`。
 *
 * 往返（导出 → 导入）后 `stage` / `audience` / 出处 / 核实日期 / stale 一字不差；
 * 卡 id 不在包里——**包是给别的系统看的**，id 的往返靠 19 §5 的 markdown 导出
 * （那一份带机器可读信封）。
 */
export function cardsToPack(
  cards: readonly FactCard[],
  manifest: { name: string; version: string; product?: string; generated_at: string },
): PackFile[] {
  const byFile = new Map<string, FactCard[]>()
  for (const card of cards) {
    const file = packFileOf(card)
    byFile.set(file, [...(byFile.get(file) ?? []), card])
  }
  const files: PackFile[] = [
    {
      path: PACK_MANIFEST_FILE,
      content: [
        `format: ${KNOWLEDGE_PACK_FORMAT}`,
        `name: ${yamlValue(manifest.name)}`,
        `version: ${yamlValue(manifest.version)}`,
        ...(manifest.product === undefined ? [] : [`product: ${yamlValue(manifest.product)}`]),
        `generatedAt: ${manifest.generated_at}`,
        'generator: agentsws',
        'languages:',
        '  - zh',
        '',
      ].join('\n'),
    },
  ]
  for (const [path, list] of [...byFile].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const first = list[0] as FactCard
    const lastVerified = list
      .map((c) => c.last_verified_at)
      .filter((x): x is string => x !== undefined)
      .sort()
      .pop()
    const sourcePaths = [...new Set(list.flatMap((c) => c.provenance.map((p) => p.ref)))].slice(
      0,
      20,
    )
    const front = [
      '---',
      `title: ${yamlValue(path.replace(/^\d+-/, '').replace(/\.md$/, ''))}`,
      `category: ${yamlValue(path.replace(/\.md$/, ''))}`,
      `audience: ${first.sensitivity === 'public' ? 'customer' : 'internal'}`,
      'source_paths:',
      ...sourcePaths.map((p) => `  - ${yamlValue(p)}`),
      ...(lastVerified === undefined ? [] : [`last_verified: ${lastVerified.slice(0, 10)}`]),
      `stage_scope: ${first.stage ?? 'both'}`,
      `verification: ${first.verification_state ?? 'fresh'}`,
      'confidence: medium',
      '---',
      '',
    ]
    const body: string[] = []
    for (const card of list) {
      body.push(`## ${card.subject.key}`, '')
      body.push(card.statement.trim(), '')
    }
    files.push({ path, content: [...front, ...body].join('\n') })
  }
  return files
}

/** 一条卡是不是承诺类（导出时也据它决定进哪个文件；与 `isCommitmentCard` 同口径）。 */
export const isCommitmentExport = (card: FactCard): boolean => isCommitmentCard(card)
