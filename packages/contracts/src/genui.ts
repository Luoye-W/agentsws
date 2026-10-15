/**
 * WP336（决策 810–812）：当场回答换用社区插件 dsh-genui（https://github.com/omdsh-dev/dsh-genui，MIT）
 * 的**写法协议**——模型在回答里写一段 ```dsh-ui JSON，工作台用它的 `/embed` 渲染层画出来。
 *
 * 这一份只在宿主这边做**白名单过滤**（服务进程、模拟、工作台共用同一份，三个运行时拿到同一个结果）：
 * 只留信息类组件（字 / 卡片 / 网格 / 数字 / 表格 / 清单 / 键值 / 时间线 / 步骤 / 提示 / 徽章 / 进度 / 图表），
 * 按钮、表单、图片音视频、链接、svg、mermaid、3D 等一律丢；所有 action、过滤 / 排序 / 导出、自定义配色
 * （accent / color / palette）去掉（决策 337），正文里的 Markdown 链接只留字。每种组件只认列出来的字段，
 * 别的字段（包括以后插件新加的）一律不带过去。
 */

/** 回答里那一段的围栏名（```dsh-ui）。 */
export const GENUI_FENCE = 'dsh-ui'

/** 白名单：能画的组件类型。`echart` 只开柱 / 线 / 饼 / 漏斗四种预设（{@link GENUI_ECHART_PRESETS}）。 */
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
] as const

export type GenuiAllowedType = (typeof GENUI_ALLOWED_TYPES)[number]

export const GENUI_ECHART_PRESETS = ['bar', 'line', 'pie', 'funnel'] as const

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
  nodes: 60,
  depth: 4,
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

const LINK_RE = /\[([^\]\n]*)\]\((?:[^()\s]|\([^()\s]*\))*\)/gu

/** 正文里的 Markdown 链接 `[字](地址)` 只留字（外链一律不画）；套着写的一层层剥到没有为止。 */
function unlink(s: string): string {
  let out = s
  for (let i = 0; i < 8; i += 1) {
    const next = out.replace(LINK_RE, '$1')
    if (next === out) return out
    out = next
  }
  return out
}

/** 一格字：字符串照收（去链接、截长），数字转成字；别的不要。 */
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

function tableOf(x: Record<string, unknown>): Record<string, unknown> | undefined {
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
  return pick({ columns, rows, types, total: x.total === true ? true : undefined })
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
      return tableOf(x)
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
      return items.length === 0 ? undefined : { items }
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
      })
    }
    case 'echart': {
      // 只开四种预设；完整 option（任意 ECharts 配置）一律不收
      const preset = oneOf(x.preset, GENUI_ECHART_PRESETS)
      const d = data(x.data)
      const s = preset === 'bar' || preset === 'line' ? series(x.series) : undefined
      if (preset === undefined || (d === undefined && s === undefined)) return undefined
      return pick({
        preset,
        title: str(x.title, GENUI_LIMITS.title),
        height: int(x.height, 160, 420),
        data: d,
        series: s,
      })
    }
  }
}

function filterNode(x: unknown, w: Walk, depth: number): GenuiNodeLite | undefined {
  if (!isRecord(x)) return undefined
  const type = typeof x.type === 'string' ? x.type : '?'
  if (!(GENUI_ALLOWED_TYPES as readonly string[]).includes(type)) return drop(w, type)
  if (depth > GENUI_LIMITS.depth || w.nodes >= GENUI_LIMITS.nodes) return drop(w, type)
  w.nodes += 1
  const fields = fieldsOf(type as GenuiAllowedType, x, w, depth)
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

/**
 * 模型写的 ```dsh-ui 内容（已 `JSON.parse`）按白名单过滤。认 `{ title?, items: [...] }`、
 * 单个组件（`{ "type": "table", … }`）和一串组件（`[...]`）。
 */
export function filterGenuiSpec(raw: unknown): GenuiFilterResult {
  const w: Walk = { nodes: 0, dropped: [] }
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
 */
export const QUICK_ANSWER_RULE = [
  '这是岗位页上的一次当场问答：只查、只答，不改任何东西、不出卡、不起草对外内容。',
  '第一句话直接回答（不寒暄、不复述问题），整段尽量短。',
  '要列清单（商品、订单、客户…）、给关键数字或画趋势时，在回答最后附一段（JSON，宿主画成组件）：',
  '```dsh-ui',
  '{"items":[{"type":"grid","cols":2,"items":[{"type":"stat","label":"今天订单","value":"8","delta":"+12%"},{"type":"stat","label":"销售额","value":"¥1,280"}]},{"type":"table","columns":["商品","价格"],"rows":[["示例商品",129]]}]}',
  '```',
  '只能用这些组件：text（content）、card（title, items）、grid（cols, items）、stat（label, value, delta）、',
  'table（columns, rows）、list（items）、keyvalue（pairs: [{key, value}]）、timeline（items: [{title, desc, time}]）、',
  'steps（steps: [{title, desc}]）、callout（tone: info / success / warning / error, content）、badge（label）、',
  'progress（value 0–100, label）、chart（kind: bars / line / donut, data: [{label, value}]）；漏斗用 echart（preset: funnel, data）。',
  '不写按钮、表单、图片、链接、颜色（写了也会被去掉）。表格最多 50 行 8 列，多了只列前 50 行、用 text 说一共几行。',
  '数字照工具读回来的原样填，读不到就不填、照实说读不到。没有清单和数字就不写这一段。',
].join('\n')

/**
 * WP336（Luoye 10-15 扩大范围）：**所有对话运行**（事项 / 线程、随便聊、问 AI）系统提示里带的精简版——
 * 回给工作台里的人看的正文可以放一段 ```dsh-ui。比 {@link QUICK_ANSWER_RULE} 短，不重复「只查只答」那几条。
 * 对外内容（邮件、帖子、给客户的回复）、卡片与工具参数里一律不用。
 */
export const GENUI_DISPLAY_RULE = [
  '回给工作台里的人看的话里，有清单、关键数字、对比或趋势时，可以在正文里放一段 ```dsh-ui（JSON，工作台画成组件），例如：',
  '```dsh-ui',
  '{"items":[{"type":"stat","label":"今天订单","value":"8"},{"type":"table","columns":["商品","价格"],"rows":[["示例商品",129]]}]}',
  '```',
  '只能用：text、card、grid、stat、table、list、keyvalue、timeline、steps、callout、badge、progress、chart（kind: bars / line / donut）；漏斗用 echart（preset: funnel）。不写按钮、表单、图片、链接、颜色。',
  '起草对外内容（邮件、帖子、给客户的回复）、卡片和工具参数里一律不用；数字照工具读回来的原样填。',
].join('\n')
