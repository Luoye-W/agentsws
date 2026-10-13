/**
 * WP301（决策 399 = A）：从**店里那一份 Shopify 官方 Horizon** 的 schema 现生成给模型看的目录。
 *
 * 工坊不再带任何主题代码（我们自己的 agentsws-theme 已改闭源）。起底时在店里复制一份 Horizon、拉到工作目录，
 * 再由这里读那份主题自带的 `{% schema %}`（`sections/*.liquid`、`blocks/*.liquid`）、`config/settings_schema.json`
 * 与 `locales/en.default.schema.json`，生成两份文件放在工作目录根上（`theme push` 不传根目录的文件）：
 *
 * - `CATALOG.index.json`：瘦目录（每个分区 / 块一行：id、名字、分类、收哪些块）——模型先读它；
 * - `CATALOG.json`：完整目录（每项的设置 id / 类型 / 选项 / 默认值、预设、静态块），`theme_read_file` 按 ids 挑着给。
 *
 * Horizon 的块体系（shopify.dev「Theme blocks」）：分区 / 块的 schema 里 `blocks: [{ "type": "@theme" }]` = 收这份主题
 * `blocks/` 里**所有不以 `_` 开头的公开块**；`@app` = 收应用块；`_` 开头的是**私有块**，只有点名列了它的父级才收；
 * 预设（presets）里 `"static": true` 的块是父级用 `{% content_for "block" %}` 固定渲染的静态块，模板里要原样留着。
 * 块最多嵌 8 层（不算分区那一层）。
 *
 * 这里只做纯计算（读口由调用方给），不联网、不碰店铺。生成物是这份主题自己的事实，只落在用户本机的工作目录里。
 */

/** 认作 Horizon 的主题名（`config/settings_schema.json` 第一项 `theme_info.theme_name`；改了后台显示名也不变）。 */
export const HORIZON_THEME_NAMES: readonly string[] = ['Horizon']

/** 旧的自带主题（v0.9.x / v0.10 起底的工作目录）。 */
export const LEGACY_THEME_NAME = 'agentsws-theme'

export interface ThemeInfo {
  theme_name: string
  theme_version?: string
  theme_author?: string
}

type Rec = Record<string, unknown>
const rec = (v: unknown): Rec | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/**
 * 去掉 JSON 里的 `/* … *\/` 与 `//` 注释（Shopify 的 JSON 模板开头有一段自动生成的注释头，`JSON.parse` 认不了）。
 * 字符串里的同样字符不动。
 */
export function stripJsonComments(text: string): string {
  let out = ''
  let i = 0
  let inStr = false
  while (i < text.length) {
    const c = text[i] as string
    if (inStr) {
      out += c
      if (c === '\\') {
        out += text[i + 1] ?? ''
        i += 2
        continue
      }
      if (c === '"') inStr = false
      i += 1
      continue
    }
    if (c === '"') {
      inStr = true
      out += c
      i += 1
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end < 0 ? text.length : end + 2
    } else if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i + 2)
      i = end < 0 ? text.length : end
    } else {
      out += c
      i += 1
    }
  }
  return out
}

/** 主题的 JSON 文件（模板 / section 组 / 设置）→ 对象；读不懂回 undefined。 */
export function parseThemeJson(text: string): unknown {
  try {
    return JSON.parse(stripJsonComments(text)) as unknown
  } catch {
    return undefined
  }
}

/** `.liquid` 文件里 `{% schema %} … {% endschema %}` 那一段（没有 / 读不懂回 undefined）。 */
export function liquidSchemaOf(text: string): Rec | undefined {
  const m = /\{%-?\s*schema\s*-?%\}([\s\S]*?)\{%-?\s*endschema\s*-?%\}/.exec(text)
  if (m === null) return undefined
  try {
    return rec(JSON.parse(m[1] as string))
  } catch {
    return undefined
  }
}

/** `config/settings_schema.json` 第一项的 `theme_info`。 */
export function themeInfoOf(settingsSchema: string | undefined): ThemeInfo | undefined {
  if (settingsSchema === undefined) return undefined
  const info = arr(parseThemeJson(settingsSchema))
    .map(rec)
    .find((x) => x?.name === 'theme_info')
  const name = str(info?.theme_name)
  if (info === undefined || name === undefined) return undefined
  const version = str(info.theme_version)
  const author = str(info.theme_author)
  return {
    theme_name: name,
    ...(version === undefined ? {} : { theme_version: version }),
    ...(author === undefined ? {} : { theme_author: author }),
  }
}

export const isHorizon = (info: ThemeInfo | undefined): boolean =>
  info !== undefined && HORIZON_THEME_NAMES.includes(info.theme_name)

export const isLegacyTheme = (info: ThemeInfo | undefined): boolean =>
  info?.theme_name === LEGACY_THEME_NAME

// ── 目录的形状 ─────────────────────────────────────────────────────────

/** 一个设置（搭页面用得到的那几格；`header` / `paragraph` 这种排版用的不收）。 */
export interface CatalogSetting {
  id: string
  type: string
  label?: string
  default?: unknown
  options?: { value: unknown; label?: string }[]
  min?: number
  max?: number
  step?: number
  unit?: string
  /** Horizon 用 `visible_if` 控制什么时候显示（原样给，模型据此知道哪些设置是连着的）。 */
  visible_if?: string
}

/** 目录里的一项：分区或块（`theme-read.ts` 的目录页 / 按 ids 挑都认这个形状）。 */
export interface CatalogEntry {
  id: string
  kind: 'section' | 'block'
  file: string
  name: string
  category?: string
  /** `_` 开头的私有块：只有点名列了它的父级才收。 */
  private?: boolean
  /** 这一项收哪些块（schema 的 `blocks[].type` 原样：`@theme` / `@app` / 具体块名）。 */
  accepts_blocks?: string[]
  /** 分区自己定义的本地块（老写法；Horizon 很少用）。 */
  local_blocks?: { type: string; name: string; settings: CatalogSetting[] }[]
  /** 预设里标了 `"static": true` 的块（模板里要原样留着、带 `"static": true`）。 */
  static_blocks?: { id: string; type: string }[]
  max_blocks?: number
  enabled_on?: unknown
  disabled_on?: unknown
  settings: CatalogSetting[]
  presets?: {
    name: string
    category?: string
    settings?: unknown
    blocks?: unknown
    block_order?: unknown
  }[]
  /** 目录页那一行的「什么时候用」。 */
  use_when: string
}

export interface ThemeCatalog {
  /** 例如 `Horizon 4.2.0`。 */
  theme: string
  theme_name: string
  theme_version?: string
  generated_by: string
  how_to: string[]
  entries: CatalogEntry[]
  theme_settings: { group: string; settings: CatalogSetting[] }[]
  templates: string[]
  section_groups: { file: string; type?: string }[]
}

/** 读工作目录的口（测试用内存，`site-theme.ts` 用真目录）。`list` 回相对路径（含子目录），已排好序。 */
export interface CatalogIo {
  list(dir: 'sections' | 'blocks' | 'templates'): string[]
  read(rel: string): string | undefined
}

export const CATALOG_FILE = 'CATALOG.json'
export const CATALOG_INDEX_FILE = 'CATALOG.index.json'

/** `t:names.hero` → 英文编辑器标签（`locales/en.default.schema.json`）；找不到就把最后一段变成人话。 */
function translator(schemaLocale: Rec | undefined): (v: unknown) => string | undefined {
  return (v) => {
    const s = str(v)
    if (s === undefined) return undefined
    if (!s.startsWith('t:')) return s
    let cur: unknown = schemaLocale
    for (const k of s.slice(2).split('.')) cur = rec(cur)?.[k]
    if (typeof cur === 'string') return cur
    // 找不到：取最后一段有意义的名字（`t:sections.faq.name` → Faq）
    const parts = s.slice(2).split('.')
    while (
      parts.length > 1 &&
      /^(name|label|title|content|info)$/.test(parts[parts.length - 1] ?? '')
    )
      parts.pop()
    const last = parts[parts.length - 1] ?? s
    return last.replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
  }
}

function settingsOf(raw: unknown, t: (v: unknown) => string | undefined): CatalogSetting[] {
  const out: CatalogSetting[] = []
  for (const s of arr(raw).map(rec)) {
    const id = str(s?.id)
    const type = str(s?.type)
    if (s === undefined || id === undefined || type === undefined) continue
    const label = t(s.label)
    const options = arr(s.options)
      .map(rec)
      .filter((o): o is Rec => o !== undefined)
      .map((o) => {
        const l = t(o.label)
        return { value: o.value, ...(l === undefined ? {} : { label: l }) }
      })
    const num = (k: string): Partial<Record<string, number>> =>
      typeof s[k] === 'number' ? { [k]: s[k] as number } : {}
    out.push({
      id,
      type,
      ...(label === undefined ? {} : { label }),
      ...(s.default === undefined ? {} : { default: s.default }),
      ...(options.length === 0 ? {} : { options }),
      ...num('min'),
      ...num('max'),
      ...num('step'),
      ...(typeof s.unit === 'string' ? { unit: s.unit } : {}),
      ...(typeof s.visible_if === 'string' ? { visible_if: s.visible_if } : {}),
    })
  }
  return out
}

/** 预设里（任意层）标了 `static: true` 的块。 */
function staticBlocksOf(presets: unknown[]): { id: string; type: string }[] {
  const out = new Map<string, string>()
  const walk = (blocks: unknown): void => {
    const map = rec(blocks)
    const list = Array.isArray(blocks) ? blocks.map((b, i) => [String(i), b] as const) : []
    const pairs = map === undefined ? list : Object.entries(map)
    for (const [id, b] of pairs) {
      const r = rec(b)
      const type = str(r?.type)
      if (r === undefined || type === undefined) continue
      const bid = str(r.id) ?? id
      if (r.static === true && !out.has(bid)) out.set(bid, type)
      walk(r.blocks)
    }
  }
  for (const p of presets) walk(rec(p)?.blocks)
  return [...out].map(([id, type]) => ({ id, type }))
}

/** 「收哪些块」说成一句短话（目录页用）：`@theme` = 全部公开块。 */
export function acceptsText(accepts: readonly string[] | undefined): string {
  if (accepts === undefined || accepts.length === 0) return '不收块'
  const theme = accepts.includes('@theme')
  const parts = [
    ...(theme ? ['全部公开块'] : []),
    ...(accepts.includes('@app') ? ['应用块'] : []),
    // 有 @theme 时公开块已经都收了，只把私有块点出来
    ...accepts.filter((a) => !a.startsWith('@') && (!theme || a.startsWith('_'))),
  ]
  return parts.join('、')
}

function entryOf(
  kind: 'section' | 'block',
  file: string,
  schema: Rec,
  t: (v: unknown) => string | undefined,
): CatalogEntry {
  const id = (file.split('/').pop() ?? file).replace(/\.liquid$/, '')
  const name = t(schema.name) ?? id
  const presets = arr(schema.presets)
    .map(rec)
    .filter((p): p is Rec => p !== undefined)
  const category = t(presets[0]?.category)
  const blockDefs = arr(schema.blocks)
    .map(rec)
    .filter((b): b is Rec => b !== undefined && typeof b.type === 'string')
  const accepts = blockDefs.map((b) => b.type as string)
  const local = blockDefs
    .filter((b) => typeof b.name === 'string')
    .map((b) => ({
      type: b.type as string,
      name: t(b.name) ?? String(b.type),
      settings: settingsOf(b.settings, t),
    }))
  const statics = staticBlocksOf(presets)
  const when = [name, ...(category === undefined ? [] : [category])].join(' · ')
  return {
    id,
    kind,
    file,
    name,
    ...(category === undefined ? {} : { category }),
    ...(kind === 'block' && id.startsWith('_') ? { private: true } : {}),
    ...(accepts.length === 0 ? {} : { accepts_blocks: accepts }),
    ...(local.length === 0 ? {} : { local_blocks: local }),
    ...(statics.length === 0 ? {} : { static_blocks: statics }),
    ...(typeof schema.max_blocks === 'number' ? { max_blocks: schema.max_blocks } : {}),
    ...(schema.enabled_on === undefined ? {} : { enabled_on: schema.enabled_on }),
    ...(schema.disabled_on === undefined ? {} : { disabled_on: schema.disabled_on }),
    settings: settingsOf(schema.settings, t),
    ...(presets.length === 0
      ? {}
      : {
          presets: presets.map((p) => {
            const pc = t(p.category)
            return {
              name: t(p.name) ?? name,
              ...(pc === undefined ? {} : { category: pc }),
              ...(p.settings === undefined ? {} : { settings: p.settings }),
              ...(p.blocks === undefined ? {} : { blocks: p.blocks }),
              ...(p.block_order === undefined ? {} : { block_order: p.block_order }),
            }
          }),
        }),
    use_when: kind === 'section' ? `${when}｜收：${acceptsText(accepts)}` : when,
  }
}

/** 读工作目录里的这份主题 → 目录（不是 Horizon 也照样生成，`theme` 写它自己的名字）。 */
export function buildThemeCatalog(io: CatalogIo): ThemeCatalog {
  const t = translator(rec(parseThemeJson(io.read('locales/en.default.schema.json') ?? '')))
  const info = themeInfoOf(io.read('config/settings_schema.json'))
  const entries: CatalogEntry[] = []
  for (const kind of ['section', 'block'] as const) {
    const dir = kind === 'section' ? 'sections' : 'blocks'
    for (const rel of io.list(dir)) {
      if (!rel.endsWith('.liquid') || rel.split('/').length !== 2) continue
      const schema = liquidSchemaOf(io.read(rel) ?? '')
      if (schema !== undefined) entries.push(entryOf(kind, rel, schema, t))
    }
  }
  const theme_settings = arr(parseThemeJson(io.read('config/settings_schema.json') ?? ''))
    .map(rec)
    .filter((g): g is Rec => g !== undefined && g.name !== 'theme_info')
    .map((g) => ({ group: t(g.name) ?? 'Settings', settings: settingsOf(g.settings, t) }))
  const section_groups = io
    .list('sections')
    .filter((rel) => rel.endsWith('.json'))
    .map((file) => {
      const type = str(rec(parseThemeJson(io.read(file) ?? ''))?.type)
      return { file, ...(type === undefined ? {} : { type }) }
    })
  const name = info?.theme_name ?? 'theme'
  return {
    theme: [name, info?.theme_version].filter((x) => x !== undefined).join(' '),
    theme_name: name,
    ...(info?.theme_version === undefined ? {} : { theme_version: info.theme_version }),
    generated_by: 'Agents 工坊按这份主题自带的 schema 现生成（不是主题的一部分，不会推到店里）',
    how_to: CATALOG_HOW_TO,
    entries,
    theme_settings,
    templates: io.list('templates').map((rel) => rel.replace(/^templates\//, '')),
    section_groups,
  }
}

/** 目录开头那几句「怎么搭」（index 与完整目录都带）。 */
export const CATALOG_HOW_TO: string[] = [
  '页面 = templates/<页>.json：{"sections":{"<分区实例id>":{"type":"<分区id>","settings":{…},"blocks":{"<块实例id>":{"type":"<块id>","settings":{…}}},"block_order":["<块实例id>"]}},"order":["<分区实例id>"]}；块里还能再嵌 blocks / block_order（最多 8 层）。',
  '分区只收它 accepts_blocks 里的块：@theme = 所有不以 _ 开头的公开块，@app = 应用块；_ 开头的私有块只放进点名列了它的父级。',
  'static_blocks 里的块是父级固定渲染的：模板里照预设原样留着，带 "static": true。照着 presets 搭最稳。',
  '页头页尾在 sections/header-group.json、footer-group.json；颜色、字体等在 config/settings_data.json 的 current 里（设置 id 见 theme_settings）。',
]

/** 瘦目录（`CATALOG.index.json`）：每个分区 / 块一行。 */
export function catalogIndexOf(c: ThemeCatalog): Rec {
  return {
    theme: c.theme,
    generated_by: c.generated_by,
    how_to: c.how_to,
    next: '要某几项的完整设置与预设：theme_read_file 读 CATALOG.json 并给 ids（主题设置给 ids=["theme_settings"]）。',
    sections: c.entries
      .filter((e) => e.kind === 'section')
      .map((e) => ({
        id: e.id,
        name: e.name,
        ...(e.category === undefined ? {} : { category: e.category }),
        accepts: acceptsText(e.accepts_blocks),
        ...(e.static_blocks === undefined ? {} : { static: e.static_blocks.map((s) => s.type) }),
      })),
    blocks: c.entries
      .filter((e) => e.kind === 'block')
      .map((e) => ({
        id: e.id,
        name: e.name,
        ...(e.private === true ? { private: true } : {}),
        ...(e.accepts_blocks === undefined ? {} : { accepts: acceptsText(e.accepts_blocks) }),
      })),
    templates: c.templates,
    section_groups: c.section_groups.map((g) => g.file),
    theme_settings: c.theme_settings.map((g) => g.group),
  }
}

// ── 写模板时对着目录查一遍 ────────────────────────────────────────────

/** 要查的文件：`templates/*.json`（含子目录）与 section 组 `sections/*.json`。 */
export const isLayoutJson = (rel: string): boolean =>
  /^templates\/.+\.json$/.test(rel) || /^sections\/[^/]+\.json$/.test(rel)

const MAX_PROBLEMS = 30

/**
 * 模板 / section 组对着目录查：分区类型在不在、块是不是父级收的（私有块要点名、`@theme` 只收公开块）、
 * 设置 id 是不是这一项有的、`order` / `block_order` 指的实例在不在。回人话清单（空 = 没发现问题）。
 * **只提醒、不拦**（目录算不准的地方由官方 theme check 兜）。
 */
export function templateProblems(rel: string, text: string, c: ThemeCatalog): string[] {
  const root = rec(parseThemeJson(text))
  if (root === undefined) return [`${rel} 不是合法的 JSON（开头的注释可以留，其余要是 JSON）`]
  const out: string[] = []
  const add = (s: string): void => {
    if (out.length < MAX_PROBLEMS) out.push(`${rel}：${s}`)
  }
  const byId = new Map<string, CatalogEntry>()
  for (const e of c.entries) byId.set(`${e.kind}:${e.id}`, e)
  const isApp = (type: string): boolean => type.startsWith('shopify://apps/')
  const checkSettings = (
    where: string,
    settings: unknown,
    known: CatalogSetting[] | undefined,
  ): void => {
    const s = rec(settings)
    if (s === undefined || known === undefined) return
    const ids = new Set(known.map((k) => k.id))
    const unknown = Object.keys(s).filter((k) => !ids.has(k))
    if (unknown.length > 0)
      add(
        `${where} 的设置 ${unknown.join('、')} 在目录里没有（照 CATALOG.json 那一项的 settings 抄 id）`,
      )
  }
  const checkOrder = (where: string, order: unknown, map: Rec | undefined): void => {
    for (const id of arr(order))
      if (typeof id === 'string' && map?.[id] === undefined)
        add(`${where} 的顺序里有 ${id}，但没有这个实例`)
  }
  const walkBlocks = (
    where: string,
    parent: CatalogEntry | undefined,
    blocks: unknown,
    depth: number,
  ): void => {
    const map = rec(blocks)
    if (map === undefined) return
    if (depth > 8) {
      add(`${where} 的块嵌了超过 8 层`)
      return
    }
    for (const [bid, raw] of Object.entries(map)) {
      const b = rec(raw)
      const type = str(b?.type)
      if (b === undefined || type === undefined) {
        add(`${where} 里的块 ${bid} 没写 type`)
        continue
      }
      if (isApp(type)) {
        if (parent !== undefined && !(parent.accepts_blocks ?? []).includes('@app'))
          add(`${where} 里的块 ${bid} 是应用块，但 ${parent.id} 不收应用块`)
        continue
      }
      const local = parent?.local_blocks?.find((l) => l.type === type)
      const entry = byId.get(`block:${type}`)
      if (local === undefined && entry === undefined) {
        add(`${where} 里的块 ${bid} 用了 ${type}，这份主题没有这个块`)
        continue
      }
      if (parent !== undefined && local === undefined && b.static !== true) {
        const accepts = parent.accepts_blocks ?? []
        const ok = accepts.includes(type) || (accepts.includes('@theme') && !type.startsWith('_'))
        if (!ok)
          add(
            `${where} 里的块 ${bid}（${type}）放错了地方：${parent.id} 收的是 ${acceptsText(accepts)}`,
          )
      }
      checkSettings(`${where} › ${bid}`, b.settings, local?.settings ?? entry?.settings)
      checkOrder(`${where} › ${bid}`, b.block_order, rec(b.blocks))
      walkBlocks(`${where} › ${bid}`, entry, b.blocks, depth + 1)
    }
  }
  const sections = rec(root.sections)
  if (sections === undefined) return [`${rel} 没有 sections`]
  for (const [sid, raw] of Object.entries(sections)) {
    const s = rec(raw)
    const type = str(s?.type)
    if (s === undefined || type === undefined) {
      add(`分区实例 ${sid} 没写 type`)
      continue
    }
    if (isApp(type)) continue
    const entry = byId.get(`section:${type}`)
    if (entry === undefined) {
      add(`分区实例 ${sid} 用了 ${type}，这份主题没有这个分区`)
      continue
    }
    checkSettings(`分区 ${sid}（${type}）`, s.settings, entry.settings)
    checkOrder(`分区 ${sid}（${type}）`, s.block_order, rec(s.blocks))
    walkBlocks(`分区 ${sid}（${type}）`, entry, s.blocks, 1)
  }
  checkOrder('页面', root.order, sections)
  return out
}
