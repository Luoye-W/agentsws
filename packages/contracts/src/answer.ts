/**
 * WP291（决策 356；docs/96 §3 P4、§4.2）：岗位里问一句、**当场答**——回答 = 一句话 + 组件。
 *
 * 组件只有契约里这几种（先做 一句话 / 表格清单 / 数字；趋势、对比、图集留口），
 * 工作台按 `kind` 渲染，**模型不吐 HTML**：它在回答末尾附一段 ```answer JSON（{@link QUICK_ANSWER_RULE}），
 * 宿主用 {@link splitAnswer} 取出来、按 {@link validateAnswerComponents} 逐格校验，不合格的整格丢掉。
 * 模型没写这一段、却在正文里画了 Markdown 表格的，也收成表格（真模型常这么答）。
 */

/** 一段字（一句话之外还有要说的）。 */
export interface AnswerText {
  kind: 'text'
  text: string
}

export type AnswerCell = string | number | null

/** 表格 / 清单（商品、订单、客户…）。 */
export interface AnswerTable {
  kind: 'table'
  columns: string[]
  rows: AnswerCell[][]
  /** 一共有多少行（只列了前 N 行时给；界面写「共 N 行」）。 */
  total?: number
}

export interface AnswerMetric {
  label: string
  value: number | string
  /** 单位（元、单、%…） */
  unit?: string
  /** 与上一期比的变化（%）。 */
  delta_pct?: number
}

/** 一组数字（最多 6 个）。 */
export interface AnswerMetrics {
  kind: 'metric'
  items: AnswerMetric[]
}

/**
 * 当场回答里的一块组件。**只加不改**：docs/96 §4.2 的趋势 / 对比 / 图集以后各加一个 `kind`；
 * 工作台认不得的 `kind` 不画（老工作台遇到新组件不会坏）。
 */
export type AnswerComponent = AnswerText | AnswerTable | AnswerMetrics

export const ANSWER_COMPONENT_KINDS: readonly AnswerComponent['kind'][] = [
  'text',
  'table',
  'metric',
]

/** 上限：模型给多了就截，不报错。 */
export const ANSWER_LIMITS = {
  components: 4,
  columns: 8,
  rows: 50,
  metrics: 6,
  cell: 200,
  label: 40,
  text: 4000,
  lead: 400,
} as const

/** 回答末尾那一段的围栏名（```answer）。 */
export const ANSWER_FENCE = 'answer'

/**
 * 给模型的规矩（宿主只在**当场问答**那一次运行里加进系统提示）：只查只答、第一句直接回答、
 * 有清单或关键数字时末尾附一段 ```answer JSON。数字照工具读回来的原样填。
 */
export const QUICK_ANSWER_RULE = [
  '这是岗位页上的一次当场问答：只查、只答，不改任何东西、不出卡、不起草对外内容。',
  '第一句话直接回答（不寒暄、不复述问题），整段尽量短。',
  '要列清单（商品、订单、客户…）或给关键数字时，在回答最后附一段：',
  '```answer',
  '{"components":[{"kind":"table","columns":["商品","价格"],"rows":[["示例商品",129]],"total":12},{"kind":"metric","items":[{"label":"今天订单","value":8,"unit":"单"}]}]}',
  '```',
  '表格最多 50 行 8 列（多了只列前 50 行、total 写一共几行），数字块最多 6 个；',
  '数字照工具读回来的原样填，读不到就不填、照实说读不到。没有清单和数字就不写这一段。',
].join('\n')

const isRecord = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === 'object' && !Array.isArray(x)

const clip = (s: string, max: number): string => {
  const chars = Array.from(s)
  return chars.length <= max ? s : `${chars.slice(0, max - 1).join('')}…`
}

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)

function cellOf(x: unknown): AnswerCell {
  if (x === null || x === undefined) return null
  if (finite(x)) return x
  if (typeof x === 'string') return clip(x.trim(), ANSWER_LIMITS.cell)
  if (typeof x === 'boolean') return x ? '是' : '否'
  return null
}

function tableOf(x: Record<string, unknown>): AnswerTable | undefined {
  if (!Array.isArray(x.columns) || !Array.isArray(x.rows)) return undefined
  const columns = x.columns
    .slice(0, ANSWER_LIMITS.columns)
    .map((c) =>
      typeof c === 'string' || finite(c) ? clip(String(c).trim(), ANSWER_LIMITS.label) : '',
    )
  if (columns.length === 0 || columns.every((c) => c === '')) return undefined
  const rows = x.rows
    .filter((r): r is unknown[] => Array.isArray(r))
    .slice(0, ANSWER_LIMITS.rows)
    .map((r) => columns.map((_, i) => cellOf(r[i])))
  if (rows.length === 0) return undefined
  const total = finite(x.total) && x.total > rows.length ? Math.floor(x.total) : undefined
  return { kind: 'table', columns, rows, ...(total === undefined ? {} : { total }) }
}

function metricOf(x: unknown): AnswerMetric | undefined {
  if (!isRecord(x) || typeof x.label !== 'string' || x.label.trim() === '') return undefined
  const value = finite(x.value)
    ? x.value
    : typeof x.value === 'string' && x.value.trim() !== ''
      ? clip(x.value.trim(), ANSWER_LIMITS.label)
      : undefined
  if (value === undefined) return undefined
  return {
    label: clip(x.label.trim(), ANSWER_LIMITS.label),
    value,
    ...(typeof x.unit === 'string' && x.unit.trim() !== '' ? { unit: clip(x.unit.trim(), 8) } : {}),
    ...(finite(x.delta_pct) ? { delta_pct: Math.round(x.delta_pct * 10) / 10 } : {}),
  }
}

/** 一块组件按契约校验；不合格回 `undefined`（整块丢，不半画）。 */
export function validateAnswerComponent(x: unknown): AnswerComponent | undefined {
  if (!isRecord(x)) return undefined
  if (x.kind === 'text') {
    const text = typeof x.text === 'string' ? x.text.trim() : ''
    return text === '' ? undefined : { kind: 'text', text: clip(text, ANSWER_LIMITS.text) }
  }
  if (x.kind === 'table') return tableOf(x)
  if (x.kind === 'metric') {
    const raw = Array.isArray(x.items) ? x.items : []
    const items = raw
      .map(metricOf)
      .filter((m): m is AnswerMetric => m !== undefined)
      .slice(0, ANSWER_LIMITS.metrics)
    return items.length === 0 ? undefined : { kind: 'metric', items }
  }
  return undefined
}

/** 一串组件：认 `[...]` 或 `{ components: [...] }`；不合格的丢掉，最多 {@link ANSWER_LIMITS.components} 块。 */
export function validateAnswerComponents(x: unknown): AnswerComponent[] {
  const list = Array.isArray(x) ? x : isRecord(x) && Array.isArray(x.components) ? x.components : []
  return list
    .map(validateAnswerComponent)
    .filter((c): c is AnswerComponent => c !== undefined)
    .slice(0, ANSWER_LIMITS.components)
}

const FENCE_RE = /```[ \t]*answer[ \t]*\r?\n([\s\S]*?)(?:\r?\n)?```/giu

/** 正文里的 Markdown 表格（`| a | b |` + `|---|---|`）收成表格组件；拿走表格后的正文另回。 */
function markdownTables(text: string): { text: string; tables: AnswerTable[] } {
  const lines = text.split(/\r?\n/u)
  const out: string[] = []
  const tables: AnswerTable[] = []
  const cells = (line: string): string[] =>
    line
      .trim()
      .replace(/^\|/u, '')
      .replace(/\|$/u, '')
      .split('|')
      .map((c) => c.trim().replace(/^\*\*(.*)\*\*$/u, '$1'))
  let i = 0
  while (i < lines.length) {
    const head = lines[i] ?? ''
    const sep = lines[i + 1] ?? ''
    if (
      /^\s*\|.*\|\s*$/u.test(head) &&
      /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/u.test(sep)
    ) {
      const columns = cells(head)
      const rows: AnswerCell[][] = []
      let j = i + 2
      while (j < lines.length && /^\s*\|.*\|\s*$/u.test(lines[j] ?? '')) {
        rows.push(cells(lines[j] ?? ''))
        j += 1
      }
      const table = tableOf({ columns, rows })
      if (table !== undefined) {
        tables.push(table)
        i = j
        continue
      }
    }
    out.push(head)
    i += 1
  }
  return { text: out.join('\n'), tables }
}

export interface SplitAnswer {
  /** 一句话（正文的第一段） */
  lead: string
  /** 组件：```answer 里的那几块；没有就是正文里的 Markdown 表格；正文第一段之后还有话 → 末尾一块 `text` */
  components: AnswerComponent[]
  /** 去掉 ```answer 那段之后的正文（线程里显示这一份） */
  text: string
}

/**
 * 从 AI 的一段回答里分出「一句话 + 组件」。宿主与工作台同一份（线程里的那段话也按它画）。
 */
export function splitAnswer(raw: string): SplitAnswer {
  let fenced: AnswerComponent[] = []
  let sawFence = false
  const prose = raw
    .replace(FENCE_RE, (_m, body: string) => {
      sawFence = true
      try {
        fenced = [...fenced, ...validateAnswerComponents(JSON.parse(body))]
      } catch {
        // 坏 JSON：这一段整个不要（不画半张表）
      }
      return ''
    })
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
  const { text: rest, tables } = sawFence ? { text: prose, tables: [] } : markdownTables(prose)
  const paras = rest
    .split(/\n\s*\n/u)
    .map((p) => p.trim())
    .filter((p) => p !== '')
  const first = paras[0] ?? ''
  const lead = clip(first, ANSWER_LIMITS.lead)
  const more = [first.length > lead.length ? first : '', ...paras.slice(1)]
    .filter((p) => p !== '' && p !== lead)
    .join('\n\n')
  const components: AnswerComponent[] = [
    ...(fenced.length > 0 ? fenced : tables),
    ...(more === '' ? [] : [{ kind: 'text', text: clip(more, ANSWER_LIMITS.text) } as const]),
  ].slice(0, ANSWER_LIMITS.components)
  return { lead, components, text: prose }
}
