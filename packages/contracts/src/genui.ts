/**
 * WP336（决策 810–812）：AI 回话里的 ```dsh-ui 段（社区插件 dsh-genui，https://github.com/omdsh-dev/dsh-genui，MIT）
 * ——模型写一段 JSON，工作台用它的 `/embed` 渲染层画出来。
 *
 * WP341（决策 847，Luoye 10-15）：**完全融合**——白名单放开到插件的全部组件（按钮、表单、图片音视频、链接、
 * svg、mermaid、3D、过滤 / 排序 / 导出），动作改接工坊自己的处理器（见 `genui-host.ts`）。只两条不动：
 * 口令格子的值不经 AI（换成宿主画的「口令格」，值进本机加密库）；会改外部的照旧进账本出审批。
 *
 * 这一份仍在宿主这边做**白名单过滤**（服务进程、模拟、工作台共用同一份，三个运行时拿到同一个结果）：
 * 每种组件只认列出来的字段，别的字段（包括以后插件新加的）一律不带过去；插件以后新加的**组件**也默认不过，
 * 升级时按 docs/42 评估后再加。自定义配色（accent / color / palette，决策 337）仍去掉。
 */
import {
  genuiMediaTrust,
  genuiUrlHost,
  isGenuiLinkHref,
  isSecretLikeGenuiField,
  normalizeGenuiAction,
} from './genui-host.js'

/** 回答里那一段的围栏名（```dsh-ui）。 */
export const GENUI_FENCE = 'dsh-ui'

/** 白名单：能画的组件类型。`echart` 只开预设（{@link GENUI_ECHART_PRESETS}），不收完整 option。 */
export const GENUI_ALLOWED_TYPES = [
  'text',
  'card',
  'grid',
  'stat',
  'table',
  'list',
  'keyvalue',
  'timeline',
  'steps',
  'callout',
  'badge',
  'progress',
  'chart',
  'echart',
  // WP341（决策 847）：布局 / 展示 / 交互 / 媒体 / 高级——插件 0.12.0 的全部组件
  'row',
  'col',
  'divider',
  'spacer',
  'hero',
  'tabs',
  'accordion',
  'avatar',
  'breadcrumb',
  'file-tree',
  'code',
  'json',
  'diff',
  'copy',
  'button',
  'input',
  'select',
  'checkbox',
  'radio',
  'switch',
  'textarea',
  'slider',
  'submit',
  'quiz',
  'link',
  'image',
  'audio',
  'video',
  'svg',
  'mermaid',
  'scene3d',
  'plot',
  'diagram',
  // 宿主自己画的两种（过滤时由别的组件换过来，模型直接写的不认）
  'ws-secret',
  'ws-media',
] as const

export type GenuiAllowedType = (typeof GENUI_ALLOWED_TYPES)[number]

export const GENUI_ECHART_PRESETS = [
  'bar',
  'line',
  'area',
  'pie',
  'funnel',
  'scatter',
  'radar',
  'gauge',
] as const

/** 宿主自己画的组件（不是插件的）：口令格、「点开看」的外部图片 / 媒体。模型写了也不认。 */
export const GENUI_HOST_TYPES = ['ws-secret', 'ws-media'] as const

/** 一个节点：`type` 在白名单里，其余字段是按类型过滤后的那几格。 */
export interface GenuiNodeLite {
  type: GenuiAllowedType
  [field: string]: unknown
}

/** 过滤后的描述（交给渲染层的那一份）。 */
export interface GenuiSpecLite {
  title?: string
  items: GenuiNodeLite[]
}

/** 上限：多了就截，不报错。 */
export const GENUI_LIMITS = {
  nodes: 120,
  depth: 6,
  string: 600,
  title: 80,
  tableRows: 50,
  tableCols: 8,
  listItems: 30,
  chartPoints: 24,
  series: 4,
  pairs: 16,
  steps: 12,
  gridCols: 4,
  options: 12,
  code: 6000,
  svg: 12000,
  args: 4000,
  meshes: 5,
} as const

export interface GenuiFilterResult {
  /** 过滤后的描述；一个能画的节点都没剩就是 `undefined`。 */
  spec: GenuiSpecLite | undefined
  /** 被丢掉的节点类型（含不认识的），按出现顺序、去重。测试与本机日志用。 */
  dropped: string[]
}

const isRecord = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === 'object' && !Array.isArray(x)

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)

const clip = (s: string, max: number): string => {
  const chars = Array.from(s)
  return chars.length <= max ? s : `${chars.slice(0, max - 1).join('')}…`
}

const LINK_RE = /\[([^[\]\n]*)\]\(((?:[^()\s]|\([^()\s]*\))*)\)/gu

/**
 * 正文里的 Markdown 链接 `[字](地址)`：WP341 起 `http(s)` / `mailto` / 站内 `/…` 留着（工作台悬停显示真实域名、
 * 外部浏览器打开）；别的地址（`javascript:`、`data:`、`//`）只留字；套着写的一层层剥到只剩最里面那一条。
 */
function unlink(s: string): string {
  const kept: string[] = []
  const token = (i: number): string => `\uE000${String(i)}\uE000`
  let out = s
  for (let i = 0; i < 8; i += 1) {
    const next = out.replace(LINK_RE, (_m, text: string, href: string) => {
      if (text.includes('\uE000') || !isGenuiLinkHref(href) || text.trim() === '') return text
      kept.push(`[${text}](${href})`)
      return token(kept.length - 1)
    })
    if (next === out) break
    out = next
  }
  return out.replace(/\uE000(\d+)\uE000/gu, (_m, i: string) => kept[Number(i)] ?? '')
}

/** 一格字：字符串照收（不安全的链接只留字、截长），数字转成字；别的不要。 */
function str(x: unknown, max: number = GENUI_LIMITS.string): string | undefined {
  if (typeof x === 'string') {
    const s = unlink(x).trim()
    return s === '' ? undefined : clip(s, max)
  }
  if (finite(x)) return String(x)
  return undefined
}

function oneOf<T extends string>(x: unknown, allowed: readonly T[]): T | undefined {
  return typeof x === 'string' && (allowed as readonly string[]).includes(x) ? (x as T) : undefined
}

function int(x: unknown, min: number, max: number): number | undefined {
  return finite(x) ? Math.min(max, Math.max(min, Math.round(x))) : undefined
}

/** 只把有值的格子放进去（exactOptionalPropertyTypes 下不写 `undefined`）。 */
function pick(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) out[k] = v
  return out
}

interface Walk {
  nodes: number
  dropped: string[]
  /** 这一块里有 `submit`：表单格子的单独动作去掉，统一由提交交上来。 */
  form: boolean
  /** 工具动作的序号（`tool:名字#n`，同一工具不同参数的几个按钮分得开）。 */
  tools: number
}

/** 一份 JSON 值按上限复制（只要纯数据：字符串截长、数组截短、层数有限）；放不下回 `undefined`。 */
function jsonSafe(x: unknown, depth = 6): unknown {
  if (typeof x === 'string') return clip(x, GENUI_LIMITS.string)
  if (typeof x === 'boolean' || x === null) return x
  if (finite(x)) return x
  if (depth <= 0) return undefined
  if (Array.isArray(x))
    return x
      .slice(0, 60)
      .map((v) => jsonSafe(v, depth - 1))
      .filter((v) => v !== undefined)
  if (isRecord(x)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(x).slice(0, 40)) {
      if (/^(?:__proto__|constructor|prototype)$/u.test(k)) continue
      const safe = jsonSafe(v, depth - 1)
      if (safe !== undefined) out[k] = safe
    }
    return out
  }
  return undefined
}

/**
 * 一个组件上的动作：认成宿主写法（`genui-host.ts`）；认不出的去掉（按钮画成禁用的）。
 * 工具动作带上 `args`（纯数据、有上限）并编号；表单格子在有提交按钮的块里不单独发。
 */
function actionOf(x: Record<string, unknown>, w: Walk, member = false): Record<string, unknown> {
  if (member && w.form) return {}
  const action = normalizeGenuiAction(x.action)
  if (action === undefined) return {}
  if (!action.startsWith('tool:')) return { action }
  w.tools += 1
  const args = jsonSafe(x.args)
  const ok = isRecord(args) && JSON.stringify(args).length <= GENUI_LIMITS.args
  return { action: `${action}#${String(w.tools)}`, ...(ok ? { args } : {}) }
}

const FIELD_ID_RE = /^[A-Za-z0-9_.-]{1,40}$/u
const fieldId = (x: unknown): string | undefined =>
  typeof x === 'string' && FIELD_ID_RE.test(x) ? x : undefined

function options(x: unknown): string[] | undefined {
  if (!Array.isArray(x)) return undefined
  const out = x
    .map((o) => str(o, GENUI_LIMITS.title))
    .filter((o): o is string => o !== undefined)
    .slice(0, GENUI_LIMITS.options)
  return out.length === 0 ? undefined : out
}

const SVG_BAD =
  /<\s*(?:script|foreignObject|iframe|object|embed|use)\b|\son[a-z]+\s*=|javascript:|data:(?!image\/(?:png|jpe?g|gif|webp);base64,)|(?:xlink:)?href\s*=\s*["']\s*(?:https?:)?\/\//iu

/** svg 消毒：只收一整份 `<svg …>…</svg>`；脚本、事件、外部引用、嵌别的文档一律整块不要。 */
function svgCode(x: unknown): string | undefined {
  if (typeof x !== 'string') return undefined
  const code = x.trim()
  if (code.length > GENUI_LIMITS.svg || !/^<svg[\s>]/iu.test(code) || !/<\/svg>$/iu.test(code))
    return undefined
  return SVG_BAD.test(code) ? undefined : code
}

/** mermaid 源码：去掉改配置（`%%{init…}%%`）与点击回调那几行（严格模式下也不留）。 */
function mermaidCode(x: unknown): string | undefined {
  if (typeof x !== 'string') return undefined
  const code = x
    .split('\n')
    .filter((l) => !/^\s*(?:%%\{|click\s)/iu.test(l))
    .join('\n')
    .trim()
  return code === '' || code.length > GENUI_LIMITS.code ? undefined : code
}

/** 图片 / 媒体：直接加载的照收；外部别处的换成宿主的「点开看」；不安全的不画。 */
function mediaOf(type: 'image' | 'audio' | 'video', x: Record<string, unknown>) {
  const trust = genuiMediaTrust(x.src)
  if (trust === undefined) return undefined
  const src = x.src as string
  const alt = str(x.alt ?? x.title, GENUI_LIMITS.title)
  if (trust === 'gate')
    return {
      type: 'ws-media' as const,
      fields: pick({ media: type, src, alt, host: genuiUrlHost(src) }),
    }
  const poster = type === 'video' && genuiMediaTrust(x.poster) === 'direct' ? x.poster : undefined
  return {
    type,
    fields: pick({
      src,
      alt,
      poster,
      loop: type !== 'image' && x.loop === true ? true : undefined,
      muted: type === 'video' && x.muted === true ? true : undefined,
      aspectRatio:
        type === 'video'
          ? oneOf(x.aspectRatio, ['16:9', '4:3', '1:1', '9:16'] as const)
          : undefined,
    }),
  }
}

const drop = (w: Walk, type: string): undefined => {
  if (!w.dropped.includes(type)) w.dropped.push(type)
  return undefined
}

const TABLE_CELL_TYPES = ['text', 'num', 'delta', 'bar', 'badge', 'spark', 'ring', 'index'] as const

function datum(x: unknown): { label: string; value: number } | undefined {
  if (!isRecord(x)) return undefined
  const label = str(x.label, GENUI_LIMITS.title)
  return label === undefined || !finite(x.value) ? undefined : { label, value: x.value }
}

function data(x: unknown): { label: string; value: number }[] | undefined {
  if (!Array.isArray(x)) return undefined
  const out = x
    .map(datum)
    .filter((d) => d !== undefined)
    .slice(0, GENUI_LIMITS.chartPoints)
  return out.length === 0 ? undefined : out
}

function series(
  x: unknown,
): { label: string; data: { label: string; value: number }[] }[] | undefined {
  if (!Array.isArray(x)) return undefined
  const out = x
    .flatMap((s) => {
      if (!isRecord(s)) return []
      const label = str(s.label, GENUI_LIMITS.title)
      const d = data(s.data)
      return label === undefined || d === undefined ? [] : [{ label, data: d }]
    })
    .slice(0, GENUI_LIMITS.series)
  return out.length === 0 ? undefined : out
}

function records<T>(
  x: unknown,
  max: number,
  each: (r: Record<string, unknown>) => T | undefined,
): T[] {
  if (!Array.isArray(x)) return []
  return x
    .filter(isRecord)
    .map(each)
    .filter((r): r is T => r !== undefined)
    .slice(0, max)
}

function children(x: unknown, w: Walk, depth: number): GenuiNodeLite[] {
  if (!Array.isArray(x)) return []
  return x.map((n) => filterNode(n, w, depth)).filter((n) => n !== undefined)
}

function tableOf(
  x: Record<string, unknown>,
  w: Walk,
  depth: number,
): Record<string, unknown> | undefined {
  const rawCols = Array.isArray(x.columns) ? x.columns : Array.isArray(x.headers) ? x.headers : []
  const columns = rawCols
    .slice(0, GENUI_LIMITS.tableCols)
    .map((c) => str(c, GENUI_LIMITS.title) ?? '')
  if (columns.length === 0 || columns.every((c) => c === '')) return undefined
  const rawRows = Array.isArray(x.rows) ? x.rows : Array.isArray(x.data) ? x.data : []
  const rows = rawRows
    .filter((r): r is unknown[] => Array.isArray(r))
    .slice(0, GENUI_LIMITS.tableRows)
    .map((r) => columns.map((_, i) => (finite(r[i]) ? (r[i] as number) : (str(r[i]) ?? ''))))
  if (rows.length === 0) return undefined
  const types = Array.isArray(x.types)
    ? x.types.slice(0, columns.length).map((t) => oneOf(t, TABLE_CELL_TYPES) ?? 'text')
    : undefined
  // WP341：过滤 / 排序 / 导出 / 展开行放开（都在本机做，不回模型）
  const details = Array.isArray(x.details)
    ? x.details
        .slice(0, rows.length)
        .map((d) => (Array.isArray(d) ? children(d, w, depth + 1) : null))
        .map((d) => (d === null || d.length === 0 ? null : d))
    : undefined
  return pick({
    columns,
    rows,
    types,
    total: x.total === true ? true : undefined,
    export: x.export === true ? true : undefined,
    filter: fieldId(x.filter),
    filterColumn: int(x.filterColumn, 0, columns.length - 1),
    sortField: fieldId(x.sortField),
    details: details?.some((d) => d !== null) === true ? details : undefined,
  })
}

/** 一个节点按白名单过滤；不在白名单 / 缺必填 / 超了上限 → `undefined`（整个节点丢，不半画）。 */
function fieldsOf(type: GenuiAllowedType, x: Record<string, unknown>, w: Walk, depth: number) {
  switch (type) {
    case 'text': {
      const content = str(x.content ?? x.text)
      if (content === undefined) return undefined
      const size = oneOf(x.size, ['h1', 'h2', 'h3', 'body', 'muted', 'caption'] as const)
      return pick({ content, size, center: x.center === true ? true : undefined })
    }
    case 'card': {
      const items = children(x.items ?? x.content, w, depth + 1)
      if (items.length === 0) return undefined
      const tone = oneOf(x.tone, ['info', 'success', 'warning', 'danger'] as const)
      return pick({ title: str(x.title ?? x.label, GENUI_LIMITS.title), tone, items })
    }
    case 'grid': {
      const items = children(x.items, w, depth + 1)
      if (items.length === 0) return undefined
      return { cols: int(x.cols, 1, GENUI_LIMITS.gridCols) ?? Math.min(items.length, 2), items }
    }
    case 'stat': {
      const label = str(x.label, GENUI_LIMITS.title)
      const value = str(x.value, GENUI_LIMITS.title)
      if (label === undefined || value === undefined) return undefined
      const spark = Array.isArray(x.spark) ? x.spark.filter(finite).slice(0, 30) : []
      return pick({
        label,
        value,
        delta: str(x.delta, 16),
        spark: spark.length >= 2 ? spark : undefined,
        size: x.size === 'hero' ? 'hero' : undefined,
      })
    }
    case 'table':
      return tableOf(x, w, depth)
    case 'list': {
      if (!Array.isArray(x.items)) return undefined
      const items = x.items
        .slice(0, GENUI_LIMITS.listItems)
        .map((it): unknown => {
          if (typeof it === 'string' || finite(it)) return str(it)
          if (!isRecord(it)) return undefined
          if (typeof it.type === 'string') return filterNode(it, w, depth + 1)
          const title = str(it.title, GENUI_LIMITS.title)
          return title === undefined ? undefined : pick({ title, desc: str(it.desc) })
        })
        .filter((it) => it !== undefined)
      return items.length === 0 ? undefined : pick({ items, filter: fieldId(x.filter) })
    }
    case 'keyvalue': {
      const pairs = records(x.pairs ?? x.items ?? x.rows ?? x.entries, GENUI_LIMITS.pairs, (r) => {
        const key = str(r.key ?? r.label, GENUI_LIMITS.title)
        const value = str(r.value)
        return key === undefined || value === undefined ? undefined : { key, value }
      })
      return pairs.length === 0 ? undefined : { pairs }
    }
    case 'timeline': {
      const items = records(x.items, GENUI_LIMITS.steps, (r) => {
        const title = str(r.title, GENUI_LIMITS.title)
        return title === undefined
          ? undefined
          : pick({ title, desc: str(r.desc), time: str(r.time, 24) })
      })
      return items.length === 0 ? undefined : { items }
    }
    case 'steps': {
      const steps = records(x.steps ?? x.items, GENUI_LIMITS.steps, (r) => {
        const title = str(r.title, GENUI_LIMITS.title)
        return title === undefined ? undefined : pick({ title, desc: str(r.desc) })
      })
      if (steps.length === 0) return undefined
      return pick({ steps, current: int(x.current, 0, steps.length) })
    }
    case 'callout': {
      const content = str(x.content ?? x.text ?? x.body ?? x.desc)
      if (content === undefined) return undefined
      const raw = x.tone === 'danger' ? 'error' : x.tone === 'warn' ? 'warning' : x.tone
      const tone = oneOf(raw, ['info', 'success', 'warning', 'error'] as const)
      return pick({ title: str(x.title, GENUI_LIMITS.title), content, tone })
    }
    case 'badge': {
      const label = str(x.label ?? x.text ?? x.value, GENUI_LIMITS.title)
      if (label === undefined) return undefined
      return pick({ label, tone: oneOf(x.tone, ['success', 'warn', 'danger', 'accent'] as const) })
    }
    case 'progress': {
      if (!finite(x.value)) return undefined
      return pick({
        value: Math.min(100, Math.max(0, x.value)),
        label: str(x.label, GENUI_LIMITS.title),
        valueLabel: str(x.valueLabel, 24),
        variant: oneOf(x.variant, ['bar', 'ring'] as const),
        target: finite(x.target) ? Math.min(100, Math.max(0, x.target)) : undefined,
      })
    }
    case 'chart': {
      const kind = oneOf(x.kind, ['bars', 'line', 'donut'] as const)
      const d = data(x.data)
      const s = kind === 'donut' ? undefined : series(x.series)
      if (d === undefined && s === undefined) return undefined
      return pick({
        kind,
        data: d ?? [],
        series: s,
        horizontal: x.horizontal === true ? true : undefined,
        stacked: x.stacked === true ? true : undefined,
        filter: fieldId(x.filter),
      })
    }
    case 'echart': {
      // 只开预设（本机打包的那几种图）；完整 option（任意 ECharts 配置）一律不收
      const preset = oneOf(x.preset, GENUI_ECHART_PRESETS)
      const d = data(x.data)
      const s =
        preset === 'bar' || preset === 'line' || preset === 'area' || preset === 'radar'
          ? series(x.series)
          : undefined
      if (preset === undefined || (d === undefined && s === undefined)) return undefined
      return pick({
        preset,
        title: str(x.title, GENUI_LIMITS.title),
        height: int(x.height, 160, 420),
        data: d,
        series: s,
      })
    }
    default:
      return moreFieldsOf(type, x, w, depth)
  }
}

const T = GENUI_LIMITS.title
const bool = (x: unknown): true | undefined => (x === true ? true : undefined)

/** WP341 放开的那些组件（布局 / 交互 / 媒体 / 高级）。 */
function moreFieldsOf(
  type: GenuiAllowedType,
  x: Record<string, unknown>,
  w: Walk,
  depth: number,
): Record<string, unknown> | undefined {
  switch (type) {
    case 'row':
    case 'col': {
      const items = children(x.items, w, depth + 1)
      if (items.length === 0) return undefined
      return type === 'row'
        ? pick({ items, wrap: bool(x.wrap), spacer: bool(x.spacer) })
        : pick({ items, gap: int(x.gap, 0, 48) })
    }
    case 'divider':
    case 'spacer':
      return {}
    case 'hero': {
      const title = str(x.title, T)
      if (title === undefined) return undefined
      const spark = Array.isArray(x.spark) ? x.spark.filter(finite).slice(0, 30) : []
      return pick({
        title,
        subtitle: str(x.subtitle),
        value: str(x.value, T),
        label: str(x.label, T),
        delta: str(x.delta, 16),
        spark: spark.length >= 2 ? spark : undefined,
        tone: oneOf(x.tone, ['accent', 'success', 'warning', 'danger'] as const),
      })
    }
    case 'tabs': {
      const tabs = records(x.tabs, 8, (t) => {
        const label = str(t.label, T)
        return label === undefined ? undefined : { label, items: children(t.items, w, depth + 1) }
      })
      return tabs.length === 0 ? undefined : { tabs }
    }
    case 'accordion': {
      const items = records(x.items, 12, (t) => {
        const title = str(t.title, T)
        return title === undefined ? undefined : { title, items: children(t.items, w, depth + 1) }
      })
      return items.length === 0 ? undefined : { items }
    }
    case 'avatar': {
      const name = str(x.name, T)
      return name === undefined ? undefined : { name }
    }
    case 'breadcrumb': {
      const items = options(x.items)
      return items === undefined ? undefined : { items }
    }
    case 'file-tree':
    case 'json': {
      const v = jsonSafe(type === 'json' ? x.value : x.items)
      if (v === undefined) return undefined
      return type === 'json'
        ? { value: v }
        : Array.isArray(v) && v.length > 0
          ? { items: v }
          : undefined
    }
    case 'code': {
      const code = typeof x.code === 'string' ? clip(x.code, GENUI_LIMITS.code) : undefined
      return code === undefined || code.trim() === ''
        ? undefined
        : pick({ code, lang: str(x.lang, 20) })
    }
    case 'diff': {
      const diffs = records(x.diffs, 8, (d) => {
        const path = str(d.path, 200)
        const newText =
          typeof d.newText === 'string' ? clip(d.newText, GENUI_LIMITS.code) : undefined
        if (path === undefined || newText === undefined) return undefined
        const oldText = typeof d.oldText === 'string' ? clip(d.oldText, GENUI_LIMITS.code) : null
        return { path, oldText, newText }
      })
      return diffs.length === 0 ? undefined : { diffs }
    }
    case 'copy': {
      const text = str(x.text, GENUI_LIMITS.code)
      return text === undefined ? undefined : pick({ text, label: str(x.label, T) })
    }
    case 'button': {
      const label = str(x.label, T)
      if (label === undefined) return undefined
      return pick({
        label,
        tone: oneOf(x.tone, ['primary', 'danger', 'success', 'ghost'] as const),
        full: bool(x.full),
        small: bool(x.small),
        ...actionOf(x, w),
      })
    }
    default:
      return formFieldsOf(type, x, w)
  }
}

/** 表单格子、链接、高级图形、宿主自己画的两种。 */
function formFieldsOf(
  type: GenuiAllowedType,
  x: Record<string, unknown>,
  w: Walk,
): Record<string, unknown> | undefined {
  switch (type) {
    case 'input': {
      // 日期 / 数字是宿主补的两种（插件只认 text / email / color；工作台画之前再接回去）
      const inputType = oneOf(x.inputType, ['text', 'email', 'color', 'date', 'number'] as const)
      return pick({
        label: str(x.label, T),
        placeholder: str(x.placeholder, T),
        value: str(x.value, T),
        inputType,
        id: fieldId(x.id),
        ...actionOf(x, w, true),
      })
    }
    case 'textarea':
      return pick({
        label: str(x.label, T),
        placeholder: str(x.placeholder, T),
        value: str(x.value),
        rows: int(x.rows, 2, 12),
        id: fieldId(x.id),
        ...actionOf(x, w, true),
      })
    case 'select':
    case 'radio': {
      const opts = options(x.options)
      if (opts === undefined) return undefined
      const quiz =
        type === 'radio'
          ? {
              group: fieldId(x.group),
              answer: finite(x.answer) ? int(x.answer, 0, opts.length - 1) : str(x.answer, T),
              explanation: str(x.explanation),
            }
          : { id: fieldId(x.id) }
      return pick({
        label: str(x.label, T),
        options: opts,
        selected: int(x.selected, 0, opts.length - 1),
        ...quiz,
        ...actionOf(x, w, true),
      })
    }
    case 'checkbox':
    case 'switch': {
      const label = str(x.label, T)
      if (label === undefined) return undefined
      return pick({
        label,
        checked: bool(x.checked),
        group: type === 'checkbox' ? fieldId(x.group) : undefined,
        ...actionOf(x, w, true),
      })
    }
    case 'slider': {
      const min = finite(x.min) ? x.min : 0
      const max = finite(x.max) && x.max > min ? x.max : min + 100
      return pick({
        label: str(x.label, T),
        min,
        max,
        step: finite(x.step) && x.step > 0 ? x.step : undefined,
        value: finite(x.value) ? Math.min(max, Math.max(min, x.value)) : undefined,
        id: fieldId(x.id),
        ...actionOf(x, w, true),
      })
    }
    case 'submit': {
      const label = str(x.label, T) ?? '提交'
      const groups = Array.isArray(x.groups)
        ? x.groups
            .map(fieldId)
            .filter((g): g is string => g !== undefined)
            .slice(0, 20)
        : undefined
      const own = actionOf(x, w)
      return pick({
        label,
        groups: groups === undefined || groups.length === 0 ? undefined : groups,
        ...(own.action === undefined ? { action: 'submit' } : own),
      })
    }
    case 'quiz': {
      const question = str(x.question)
      const opts = records(x.options, GENUI_LIMITS.options, (o) => {
        const label = str(o.label, T)
        return label === undefined
          ? undefined
          : pick({ label, correct: bool(o.correct), feedback: str(o.feedback) })
      })
      if (question === undefined || opts.length < 2) return undefined
      return pick({
        question,
        options: opts,
        explanation: str(x.explanation),
        id: fieldId(x.id),
        ...actionOf(x, w),
      })
    }
    case 'link': {
      const label = str(x.label, T)
      if (label === undefined) return undefined
      return pick({ label, href: isGenuiLinkHref(x.href) ? x.href : undefined })
    }
    case 'svg': {
      const code = svgCode(x.code ?? x.content)
      return code === undefined
        ? undefined
        : pick({ code, title: str(x.title, T), height: int(x.height, 100, 800) })
    }
    case 'mermaid': {
      const code = mermaidCode(x.code ?? x.source)
      return code === undefined ? undefined : { code }
    }
    case 'scene3d': {
      const meshes = jsonSafe(x.meshes, 4)
      if (!Array.isArray(meshes) || meshes.length === 0) return undefined
      return pick({
        title: str(x.title, T),
        meshes: meshes.slice(0, GENUI_LIMITS.meshes),
        ambient: finite(x.ambient) ? Math.min(2, Math.max(0, x.ambient)) : undefined,
      })
    }
    case 'plot': {
      const series = jsonSafe(x.series, 5)
      if (!Array.isArray(series) || series.length === 0) return undefined
      const num = (v: unknown): number | undefined => (finite(v) ? v : undefined)
      return pick({
        series: series.slice(0, 4),
        xMin: num(x.xMin),
        xMax: num(x.xMax),
        yMin: num(x.yMin),
        yMax: num(x.yMax),
        title: str(x.title, T),
      })
    }
    case 'diagram': {
      const nodes = jsonSafe(x.nodes, 3)
      if (typeof x.kind !== 'string' || !Array.isArray(nodes) || nodes.length === 0)
        return undefined
      return pick({
        kind: x.kind.slice(0, 40),
        title: str(x.title, T),
        variant: oneOf(x.variant, ['light', 'dark', 'editorial'] as const),
        nodes,
        edges: jsonSafe(x.edges, 3),
        zones: jsonSafe(x.zones, 3),
      })
    }
    case 'ws-secret': {
      const label = str(x.label ?? x.placeholder, T) ?? '口令'
      const service =
        typeof x.service === 'string' && /^[a-z][a-z0-9_.:-]{0,63}$/u.test(x.service)
          ? x.service
          : undefined
      return pick({ id: fieldId(x.id), label, service })
    }
    case 'ws-media': {
      const media = oneOf(x.media, ['image', 'audio', 'video'] as const)
      if (media === undefined || genuiMediaTrust(x.src) === undefined) return undefined
      const src = x.src as string
      return pick({ media, src, alt: str(x.alt, T), host: genuiUrlHost(src) })
    }
    default:
      return undefined
  }
}

function filterNode(x: unknown, w: Walk, depth: number): GenuiNodeLite | undefined {
  if (!isRecord(x)) return undefined
  let type = typeof x.type === 'string' ? x.type : '?'
  if (!(GENUI_ALLOWED_TYPES as readonly string[]).includes(type)) return drop(w, type)
  if (depth > GENUI_LIMITS.depth || w.nodes >= GENUI_LIMITS.nodes) return drop(w, type)
  w.nodes += 1
  let fields: Record<string, unknown> | undefined
  if (type === 'image' || type === 'audio' || type === 'video') {
    // 外部别处的图片 / 媒体换成宿主的「点开看」
    const media = mediaOf(type, x)
    if (media !== undefined) {
      type = media.type
      fields = media.fields
    }
  } else if ((type === 'input' || type === 'textarea') && isSecretLikeGenuiField(x)) {
    // 决策 814：口令格子换成宿主画的「口令格」——值进本机加密库，不经插件、不经 AI
    type = 'ws-secret'
    fields = fieldsOf('ws-secret', x, w, depth)
  } else fields = fieldsOf(type as GenuiAllowedType, x, w, depth)
  if (fields === undefined) return drop(w, type)
  const span = int(x.span, 1, GENUI_LIMITS.gridCols)
  return { type: type as GenuiAllowedType, ...fields, ...(span === undefined ? {} : { span }) }
}

/** 插件里带 `items` 的组件（它们的 `items` 是子节点或条目，不是信封）。 */
const ITEMS_COMPONENTS = new Set<string>([
  ...GENUI_ALLOWED_TYPES,
  'row',
  'col',
  'accordion',
  'file-tree',
  'breadcrumb',
  'tabs',
])

/**
 * 同插件的读法：根上带 `type` 的是单个组件；带 `items` 的只有认得的组件类型才算组件，
 * 别的（`{"type":"genui","items":[…]}`）当信封读。
 */
function isComponentRoot(x: Record<string, unknown>): boolean {
  if (typeof x.type !== 'string' || x.type === '') return false
  return !Array.isArray(x.items) || ITEMS_COMPONENTS.has(x.type)
}

/** 这一块里有没有提交按钮（有就是一张表：格子不单独发动作）。 */
function hasSubmit(x: unknown, depth: number): boolean {
  if (depth > 8) return false
  if (Array.isArray(x)) return x.some((v) => hasSubmit(v, depth + 1))
  if (!isRecord(x)) return false
  if (x.type === 'submit') return true
  return Object.values(x).some(
    (v) => typeof v === 'object' && v !== null && hasSubmit(v, depth + 1),
  )
}

/**
 * 模型写的 ```dsh-ui 内容（已 `JSON.parse`）按白名单过滤。认 `{ title?, items: [...] }`、
 * 单个组件（`{ "type": "table", … }`）和一串组件（`[...]`）。
 */
export function filterGenuiSpec(raw: unknown): GenuiFilterResult {
  const w: Walk = { nodes: 0, dropped: [], form: hasSubmit(raw, 0), tools: 0 }
  const root: Record<string, unknown> | undefined = Array.isArray(raw)
    ? { items: raw }
    : isRecord(raw) && isComponentRoot(raw)
      ? { items: [raw] }
      : isRecord(raw)
        ? raw
        : undefined
  const items = root === undefined ? [] : children(root.items, w, 1)
  if (items.length === 0) return { spec: undefined, dropped: w.dropped }
  const title = root === undefined ? undefined : str(root.title, GENUI_LIMITS.title)
  return { spec: { ...(title === undefined ? {} : { title }), items }, dropped: w.dropped }
}

/**
 * 给模型的规矩（宿主只在**当场问答**那一次运行里加进系统提示）：只查只答、第一句直接回答、
 * 有清单或关键数字时末尾附一段 ```dsh-ui。只教白名单里这几种，不塞插件整份 SKILL.md。
 * WP336（决策 823）：WP291 那段教 ```answer 的规矩已删，不留回退。
 * WP341（决策 847）：可以带一两个「接着问」的按钮（`say:`）、图片与链接。
 */
export const QUICK_ANSWER_RULE = [
  '这是岗位页上的一次当场问答：只查、只答，不改任何东西、不出卡、不起草对外内容。',
  '第一句话直接回答（不寒暄、不复述问题），整段尽量短。',
  '要列清单（商品、订单、客户…）、给关键数字或画趋势时，在回答最后附一段（JSON，宿主画成组件）：',
  '```dsh-ui',
  '{"items":[{"type":"grid","cols":2,"items":[{"type":"stat","label":"今天订单","value":"8","delta":"+12%"},{"type":"stat","label":"销售额","value":"¥1,280"}]},{"type":"table","columns":["商品","价格"],"rows":[["示例商品",129]]},{"type":"button","label":"看看哪件卖得最好","action":"say"}]}',
  '```',
  '能用：text、card、grid、stat（label, value, delta）、table（columns, rows）、list、keyvalue（pairs: [{key, value}]）、timeline、',
  'steps、callout（tone: info / success / warning / error, content）、badge、progress（value 0–100）、chart（kind: bars / line / donut, data: [{label, value}]）、',
  'echart（preset: funnel 等, data）、image（src）、link（label, href）。表格最多 50 行 8 列，多了只列前 50 行、用 text 说一共几行。',
  '可以在最后放一两个 button（action: say:接着问的那句话）让人一点就接着问；不写表单、口令格、颜色。',
  '数字照工具读回来的原样填，读不到就不填、照实说读不到。没有清单和数字就不写这一段。',
].join('\n')

/**
 * WP336（Luoye 10-15 扩大范围）：**所有对话运行**（事项 / 线程、随便聊、问 AI）系统提示里带的精简版——
 * 回给工作台里的人看的正文可以放一段 ```dsh-ui。比 {@link QUICK_ANSWER_RULE} 短，不重复「只查只答」那几条。
 * 对外内容（邮件、帖子、给客户的回复）、卡片与工具参数里一律不用。
 * WP341（决策 847）：教完整写法（仍是精简说明，不塞插件整份 SKILL.md）——按钮 / 表单什么时候用、动作怎么写、
 * 口令不进输入框。
 */
export const GENUI_DISPLAY_RULE = [
  '回给工作台里的人看的话里，可以在正文里放一段 ```dsh-ui（JSON，工作台画成组件、按钮和表单就地能点），例如：',
  '```dsh-ui',
  '{"items":[{"type":"stat","label":"今天订单","value":"8"},{"type":"radio","group":"first","label":"先做哪件","options":["改价","上新"]},{"type":"input","id":"budget","label":"预算","inputType":"number"},{"type":"submit","label":"就这样"}]}',
  '```',
  '展示：text、card、grid、row、col、stat、hero、table（export / filter）、list、keyvalue、timeline、steps、callout、badge、progress、chart（kind: bars / line / donut）、echart（preset: bar / line / area / pie / funnel / scatter / radar / gauge）、tabs、accordion、image / audio / video（src）、link（label, href）、svg（code）、mermaid（code）、code。',
  '交互：button、input（inputType: text / email / date / number）、textarea、select、radio、checkbox、switch、slider、submit。格子带 id、单选 / 多选带 group，最后放一个 submit；人交上来你会收到一条带 ```dsh-reply 的回话，照着接着做。',
  '什么时候用：要人从几个里挑（button / radio / checkbox）、要人填几样（表单 + submit）、要人确认（「就这样」「再改改」两个 button）时用；只是告诉人的事不加按钮。',
  'button 的 action：say:一句话（替人说这句、接着聊）；open:/页面；connect:服务（就地连上）；tool:工具名 + args（替人点「去做」：只读的当场查，会改外部的照样出审批卡）。',
  '不写口令 / key / token 的输入框（要连什么用 connect: 按钮），不写颜色。起草对外内容（邮件、帖子、给客户的回复）、卡片和工具参数里一律不用；数字照工具读回来的原样填。',
].join('\n')
