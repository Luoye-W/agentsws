/**
 * WP291（决策 356；docs/96 §3 P4、§4.2）：岗位里问一句、**当场答**——回答 = 一句话 + 组件。
 *
 * WP336（决策 810–812、823）：组件只剩两种——一段字（`text`）与一块 `genui`（模型写的 ```dsh-ui，
 * 宿主按 {@link filterGenuiSpec} 白名单过滤后交给 dsh-genui 渲染层画）。WP291 的 ```answer 写法
 * （表格 / 数字三种组件、Markdown 表格兜底、回退开关）已整体删除：还没有真实用户，不留老内容兼容。
 * 模型不吐 HTML；给模型的规矩见 `genui.ts` 的 `QUICK_ANSWER_RULE` / `GENUI_DISPLAY_RULE`。
 */
import { filterGenuiSpec, GENUI_FENCE, type GenuiNodeLite, type GenuiSpecLite } from './genui.js'
import { genuiNodes } from './genui-reply.js'

/** 一段字（一句话之外还有要说的）。 */
export interface AnswerText {
  kind: 'text'
  text: string
}

/**
 * 一段 ```dsh-ui 画成的组件块（dsh-genui 渲染层）。`spec` 是**过滤后**的描述——只剩白名单里的
 * 信息类组件，没有 action、没有自定义配色、没有外链。
 */
export interface AnswerGenui {
  kind: 'genui'
  spec: GenuiSpecLite
}

/** 当场回答里的一块组件。工作台认不得的 `kind` 不画。 */
export type AnswerComponent = AnswerText | AnswerGenui

export const ANSWER_COMPONENT_KINDS: readonly AnswerComponent['kind'][] = ['text', 'genui']

/** 上限：模型给多了就截，不报错。 */
export const ANSWER_LIMITS = {
  components: 4,
  text: 4000,
  lead: 400,
} as const

const isRecord = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === 'object' && !Array.isArray(x)

const clip = (s: string, max: number): string => {
  const chars = Array.from(s)
  return chars.length <= max ? s : `${chars.slice(0, max - 1).join('')}…`
}

/** 一块组件按契约校验；不合格回 `undefined`（整块丢，不半画）。genui 再过一遍白名单（幂等）。 */
export function validateAnswerComponent(x: unknown): AnswerComponent | undefined {
  if (!isRecord(x)) return undefined
  if (x.kind === 'text') {
    const text = typeof x.text === 'string' ? x.text.trim() : ''
    return text === '' ? undefined : { kind: 'text', text: clip(text, ANSWER_LIMITS.text) }
  }
  if (x.kind === 'genui') {
    const { spec } = filterGenuiSpec(x.spec)
    return spec === undefined ? undefined : { kind: 'genui', spec }
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

const textOf = (x: unknown): string =>
  typeof x === 'string' ? x : typeof x === 'number' && Number.isFinite(x) ? String(x) : ''

const recordOf = (x: unknown): Record<string, unknown> => (isRecord(x) ? x : {})

export interface GenuiTextOptions {
  /** `markdown`：表格写成 `| a | b |`、标题加粗（渲染层画不了时的退路）；`plain`：聊天软件里的几行字。 */
  style?: 'markdown' | 'plain'
  /** `plain` 时每张表最多列几行（多了写「共 N 行」）。 */
  maxRows?: number
  /**
   * WP341：聊天软件里按钮 / 单个选择题画成**编号选项**——编号接着这个数组往后排，选项那句话（人回这个编号时
   * 当作他说的话）推进来。不给就从 1 编、不收。
   */
  choices?: string[]
}

/**
 * 一段 genui 描述压成几行字：渲染层画不了时的退路（markdown）、发到聊天软件前（plain）都用它。
 * 数字一组一行（「标签 值（涨跌）」），表格成表 / 一行一条，图表成「标签：值」，字 / 提示 / 清单 / 键值 /
 * 时间线 / 步骤成几行；卡片 / 网格拆开取里面的。
 */
export function genuiToText(spec: GenuiSpecLite, options: GenuiTextOptions = {}): string {
  const md = (options.style ?? 'markdown') === 'markdown'
  const maxRows = options.maxRows ?? Number.POSITIVE_INFINITY
  const blocks: string[] = []
  let stats: string[] = []
  const flush = (): void => {
    if (stats.length > 0) blocks.push(stats.join(' · '))
    stats = []
  }
  const cell = (c: unknown): string => textOf(c).replace(/\|/gu, '/')
  const lines = (xs: string[]): void => {
    if (xs.length > 0) blocks.push(xs.join('\n'))
  }
  const choices = options.choices ?? []
  /** 有提交按钮的一块是一张表：格子画成「要回答的问题」，不编号。 */
  const form = JSON.stringify(spec.items).includes('"type":"submit"')
  let questions = 0
  let lastButton = -1
  const asked = new Set<string>()
  const choice = (label: string, said: string = label): string => {
    choices.push(said)
    return `${String(choices.length)}. ${label}`
  }
  const ask = (q: string): string => {
    questions += 1
    return `${String(questions)}）${q}`
  }
  const kids = (x: unknown): void => {
    for (const c of (x as GenuiNodeLite[] | undefined) ?? []) walk(c)
  }
  const walk = (n: GenuiNodeLite): void => {
    if (n.type !== 'stat') flush()
    if (more(n)) return
    switch (n.type) {
      case 'card':
      case 'grid':
        if (typeof n.title === 'string') blocks.push(md ? `**${n.title}**` : n.title)
        for (const c of (n.items as GenuiNodeLite[] | undefined) ?? []) walk(c)
        flush()
        return
      case 'stat':
        stats.push(
          `${textOf(n.label)} ${textOf(n.value)}${n.delta === undefined ? '' : `（${textOf(n.delta)}）`}`,
        )
        return
      case 'table': {
        const cols = (n.columns as unknown[] | undefined) ?? []
        const rows = (n.rows as unknown[][] | undefined) ?? []
        if (md)
          lines([
            `| ${cols.map(cell).join(' | ')} |`,
            `| ${cols.map(() => '---').join(' | ')} |`,
            ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`),
          ])
        else
          lines([
            ...rows.slice(0, maxRows).map((r) => `· ${r.map(textOf).join('，')}`),
            ...(rows.length > maxRows ? [`（共 ${rows.length} 行）`] : []),
          ])
        return
      }
      case 'chart':
      case 'echart': {
        type Datum = { label: string; value: number }
        const data = (n.data as Datum[] | undefined) ?? []
        const series = (n.series as { label: string; data: Datum[] }[] | undefined) ?? []
        lines([
          ...(typeof n.title === 'string' ? [n.title] : []),
          ...data.map((d) => `- ${d.label}：${d.value}`),
          ...series.flatMap((s) => s.data.map((d) => `- ${s.label} · ${d.label}：${d.value}`)),
        ])
        return
      }
      case 'text':
        blocks.push(textOf(n.content))
        return
      case 'badge':
        blocks.push(textOf(n.label))
        return
      case 'callout':
        blocks.push([textOf(n.title), textOf(n.content)].filter((t) => t !== '').join('：'))
        return
      case 'progress':
        blocks.push(`${textOf(n.label)} ${textOf(n.valueLabel) || `${textOf(n.value)}%`}`.trim())
        return
      case 'keyvalue':
        lines(
          ((n.pairs as unknown[] | undefined) ?? []).map(
            (p) => `- ${textOf(recordOf(p).key)}：${textOf(recordOf(p).value)}`,
          ),
        )
        return
      case 'list': {
        const own: string[] = []
        for (const it of (n.items as unknown[] | undefined) ?? []) {
          if (isRecord(it) && typeof it.type === 'string') {
            lines(own.splice(0))
            walk(it as GenuiNodeLite)
          } else
            own.push(
              `- ${isRecord(it) ? [textOf(it.title), textOf(it.desc)].filter((t) => t !== '').join('：') : textOf(it)}`,
            )
        }
        lines(own)
        flush()
        return
      }
      case 'timeline':
      case 'steps':
        lines(
          (((n.type === 'steps' ? n.steps : n.items) as unknown[] | undefined) ?? []).map((it) => {
            const r = recordOf(it)
            return `- ${[textOf(r.time), textOf(r.title), textOf(r.desc)].filter((t) => t !== '').join(' ')}`
          }),
        )
        return
    }
  }
  /** WP341 放开的那些组件：交互的画成编号选项 / 要回答的问题，媒体与图形给一句去处。认得回 `true`。 */
  function more(n: GenuiNodeLite): boolean {
    const label = textOf(n.label)
    switch (n.type) {
      case 'row':
      case 'col':
        kids(n.items)
        return true
      case 'tabs':
      case 'accordion':
        for (const t of ((n.type === 'tabs' ? n.tabs : n.items) as unknown[] | undefined) ?? []) {
          const r = recordOf(t)
          const head = textOf(r.label) || textOf(r.title)
          if (head !== '') blocks.push(md ? `**${head}**` : head)
          kids(r.items)
        }
        return true
      case 'hero':
        blocks.push(
          [textOf(n.title), textOf(n.value), textOf(n.subtitle)].filter((t) => t !== '').join(' '),
        )
        return true
      case 'button': {
        if (n.action === undefined) return true
        // 人回这个编号 = 他说了按钮上那句（`say:一句话` 就是那句话）
        const action = textOf(n.action)
        const said = action.startsWith('say:') ? action.slice(4) : label
        const line = md ? `- ${label}` : choice(label, said)
        // 挨着的几个按钮排成一组（一行一个）
        if (lastButton === blocks.length && blocks.length > 0)
          blocks[blocks.length - 1] += `\n${line}`
        else blocks.push(line)
        lastButton = blocks.length
        return true
      }
      case 'radio':
      case 'select': {
        const opts = ((n.options as unknown[] | undefined) ?? []).map(textOf)
        if (form || md)
          blocks.push(
            form ? ask(`${label}（${opts.join(' / ')}）`) : `${label}：${opts.join(' / ')}`,
          )
        else
          lines([
            ...(label === '' ? [] : [label]),
            ...opts.map((o) => choice(o, label === '' ? o : `${label}：${o}`)),
          ])
        return true
      }
      case 'quiz': {
        const q = textOf(n.question)
        const opts = ((n.options as unknown[] | undefined) ?? []).map((o) =>
          textOf(recordOf(o).label),
        )
        lines([q, ...opts.map((o) => (md ? `- ${o}` : choice(o, `${q}：${o}`)))])
        return true
      }
      case 'input':
      case 'textarea':
      case 'slider':
        if (form) blocks.push(ask(label || textOf(n.placeholder) || textOf(n.id)))
        return true
      case 'checkbox':
      case 'switch': {
        const group = textOf(n.group)
        if (form && group !== '') {
          // 多选组：整组一个问题（只在第一次遇到时出）
          if (asked.has(group)) return true
          asked.add(group)
          const opts = genuiNodes(spec)
            .filter((x) => x.type === 'checkbox' && x.group === group)
            .map((x) => textOf(x.label))
          blocks.push(ask(`${group}（${opts.join(' / ')}，可多选）`))
          return true
        }
        if (form) blocks.push(ask(`${label}（是 / 否）`))
        else if (n.action !== undefined && !md) blocks.push(choice(label, `选「${label}」`))
        return true
      }
      case 'submit':
        if (!md) blocks.push('按顺序回答就行，比如「1）… 2）…」。')
        return true
      case 'ws-secret':
        blocks.push(`${label}：请到工坊里填（口令不在聊天里发）`)
        return true
      case 'link': {
        const href = textOf(n.href)
        blocks.push(href === '' ? label : md ? `[${label}](${href})` : `${label}：${href}`)
        return true
      }
      case 'image':
      case 'audio':
      case 'video':
      case 'ws-media': {
        const alt = textOf(n.alt)
        blocks.push(`${alt === '' ? '' : `${alt}：`}${textOf(n.src)}`)
        return true
      }
      case 'code':
        blocks.push(md ? `\`\`\`\n${textOf(n.code)}\n\`\`\`` : textOf(n.code))
        return true
      case 'copy':
        blocks.push(textOf(n.text))
        return true
      case 'avatar':
        blocks.push(textOf(n.name))
        return true
      case 'breadcrumb':
        blocks.push(((n.items as unknown[] | undefined) ?? []).map(textOf).join(' / '))
        return true
      case 'svg':
      case 'mermaid':
      case 'scene3d':
      case 'plot':
      case 'diagram':
        blocks.push(`（${textOf(n.title) || '图'}，在工坊里看）`)
        return true
      case 'divider':
      case 'spacer':
      case 'json':
      case 'diff':
      case 'file-tree':
        return true
      default:
        return false
    }
  }
  if (spec.title !== undefined) blocks.push(md ? `**${spec.title}**` : spec.title)
  for (const n of spec.items) walk(n)
  flush()
  return blocks.filter((b) => b.trim() !== '').join('\n\n')
}

/** ```dsh-ui 那一段（围栏名同 {@link GENUI_FENCE}）。 */
const GENUI_FENCE_RE = /```[ \t]*dsh-ui[ \t]*\r?\n([\s\S]*?)(?:\r?\n)?```/giu

/**
 * 一段话里的 ```dsh-ui 都换成几行字（{@link genuiToText} 的 `plain`；坏的整段去掉）。发到聊天软件
 * （飞书 / 钉钉 / 企业微信 / 个人微信）这类画不了组件的地方前过一遍，不让 JSON 原样出去。
 * WP341：按钮 / 单个选择题成编号选项（`choices[i]` 是人回 `i+1` 时当作他说的那句话），表单成要回答的问题。
 */
export function genuiFencesToIm(raw: string): { text: string; choices: string[] } {
  const choices: string[] = []
  if (!raw.includes(`\`\`\`${GENUI_FENCE}`)) return { text: raw, choices }
  const text = raw
    .replace(GENUI_FENCE_RE, (_m, body: string) => {
      try {
        const { spec } = filterGenuiSpec(JSON.parse(body))
        return spec === undefined ? '' : genuiToText(spec, { style: 'plain', choices })
      } catch {
        return ''
      }
    })
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
  return {
    text: choices.length === 0 ? text : `${text}\n\n回编号就行。`,
    choices,
  }
}

/** 只要字（不管编号选项对应的话）。 */
export function genuiFencesToText(raw: string): string {
  return genuiFencesToIm(raw).text
}

/**
 * WP341：人在聊天软件里回了一个编号（「2」「2.」「选2」「第2个」）→ 当时那条回复里第几个选项那句话；
 * 不是编号 / 超了范围回 `undefined`（照原话处理）。
 */
export function pickImChoice(reply: string, choices: readonly string[]): string | undefined {
  const m = /^\s*(?:选|第)?\s*(\d{1,2})\s*(?:个|号|项)?\s*[.。、)）]?\s*$/u.exec(reply)
  if (m?.[1] === undefined) return undefined
  return choices[Number(m[1]) - 1]
}

export interface SplitAnswer {
  /** 一句话（正文的第一段） */
  lead: string
  /** 组件：```dsh-ui 过滤后的 `genui` 块；正文第一段之后还有话 → 末尾一块 `text` */
  components: AnswerComponent[]
  /** 去掉 ```dsh-ui 那段之后的正文 */
  text: string
}

/**
 * 从 AI 的一段回答里分出「一句话 + 组件」（当场回答用；别处的 AI 回话由工作台的正文渲染器就地画 ```dsh-ui）。
 */
export function splitAnswer(raw: string): SplitAnswer {
  let fenced: AnswerComponent[] = []
  const prose = raw
    .replace(GENUI_FENCE_RE, (_m, body: string) => {
      try {
        const { spec } = filterGenuiSpec(JSON.parse(body))
        if (spec !== undefined) fenced = [...fenced, { kind: 'genui', spec }]
      } catch {
        // 坏 JSON：这一段整个不要（不画半张表）
      }
      return ''
    })
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
  const paras = prose
    .split(/\n\s*\n/u)
    .map((p) => p.trim())
    .filter((p) => p !== '')
  const first = paras[0] ?? ''
  const lead = clip(first, ANSWER_LIMITS.lead)
  const more = [first.length > lead.length ? first : '', ...paras.slice(1)]
    .filter((p) => p !== '' && p !== lead)
    .join('\n\n')
  const components: AnswerComponent[] = [
    ...fenced,
    ...(more === '' ? [] : [{ kind: 'text', text: clip(more, ANSWER_LIMITS.text) } as const]),
  ].slice(0, ANSWER_LIMITS.components)
  return { lead, components, text: prose }
}
