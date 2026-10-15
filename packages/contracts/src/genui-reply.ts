/**
 * WP341（决策 847）：genui 里点了 / 交了之后怎么办——宿主处理器的**纯逻辑**（工作台用、测试钉住）。
 *
 * - {@link resolveGenuiAction}：插件交上来的（动作名 + 收集到的数据）→ 宿主做哪件事：发一句话、交一张表、
 *   开页面 / 第三栏、调工具、开连接卡 / 配置卡。动作名必须在**过滤后**的描述里找得到（找不到不做）。
 * - 表单交上来 → 用户在对话里的一条**结构化回话**：人看得懂的几行摘要 + 一段 ```dsh-reply（数据，给 AI）。
 *   口令格只写「已填好」，值从来不在这里（值在本机加密库）。
 */
import type { GenuiNodeLite, GenuiSpecLite } from './genui.js'
import { parseGenuiAction } from './genui-host.js'

/** 用户回话里那段数据的围栏名。 */
export const GENUI_REPLY_FENCE = 'dsh-reply'

/** 一次提交的结构化内容。 */
export interface GenuiReply {
  /** 按的是哪个（提交按钮 / 按钮上的字）。 */
  label: string
  /** 单选 / 多选组：组名 → 选了什么。 */
  answers?: Record<string, string | string[]>
  /** 格子：id → 填的值。 */
  fields?: Record<string, string>
  /** 口令格：哪几格已经填好（只有名字，没有值）。 */
  secrets?: string[]
}

/** 宿主要做的那件事。 */
export type GenuiDispatch =
  | { kind: 'say'; text: string }
  | { kind: 'reply'; reply: GenuiReply; text: string }
  | { kind: 'open'; to: string }
  | { kind: 'tool'; tool: string; args: Record<string, unknown>; label: string }
  | { kind: 'connect'; services: string[] }
  | { kind: 'setup'; target: string }
  | { kind: 'none' }

const isRecord = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === 'object' && !Array.isArray(x)

const textOf = (x: unknown): string =>
  typeof x === 'string' ? x : typeof x === 'number' && Number.isFinite(x) ? String(x) : ''

/** 描述里所有节点（深度优先，含 tabs / accordion / 表格展开行里的）。 */
export function genuiNodes(spec: GenuiSpecLite): GenuiNodeLite[] {
  const out: GenuiNodeLite[] = []
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) {
      for (const v of x) walk(v)
      return
    }
    if (!isRecord(x)) return
    if (typeof x.type === 'string') out.push(x as GenuiNodeLite)
    for (const key of ['items', 'tabs', 'details'] as const) if (key in x) walk(x[key])
  }
  walk(spec.items)
  return out
}

/** 格子 / 组的人话名字（标签；没有就用 id）。 */
export function genuiFieldLabels(spec: GenuiSpecLite): Record<string, string> {
  const out: Record<string, string> = {}
  for (const n of genuiNodes(spec)) {
    const key = textOf(n.id) || textOf(n.group)
    if (key === '' || key in out) continue
    // 多选组没有自己的标题（每个勾选框的字是选项），用组名
    out[key] = n.type === 'checkbox' ? key : textOf(n.label) || textOf(n.placeholder) || key
  }
  return out
}

/** 一条结构化回话写成对话里的那句话：摘要几行 + 一段 ```dsh-reply 数据。 */
export function genuiReplyToText(spec: GenuiSpecLite, reply: GenuiReply): string {
  const labels = genuiFieldLabels(spec)
  const lines: string[] = []
  for (const [k, v] of Object.entries(reply.answers ?? {}))
    lines.push(`- ${labels[k] ?? k}：${Array.isArray(v) ? v.join('、') : v}`)
  for (const [k, v] of Object.entries(reply.fields ?? {})) lines.push(`- ${labels[k] ?? k}：${v}`)
  for (const s of reply.secrets ?? []) lines.push(`- ${s}：已填好`)
  const head = lines.length === 0 ? reply.label : `${reply.label}：\n${lines.join('\n')}`
  return [head, '', `\`\`\`${GENUI_REPLY_FENCE}`, JSON.stringify(reply), '```'].join('\n')
}

const REPLY_RE = /\n*```[ \t]*dsh-reply[ \t]*\r?\n([\s\S]*?)\r?\n?```\s*$/u

/** 用户那句话拆成「摘要」与数据（认不出数据就整句当摘要）。 */
export function splitGenuiReply(text: string): { text: string; reply?: GenuiReply } {
  const m = REPLY_RE.exec(text)
  if (m?.[1] === undefined) return { text }
  try {
    const parsed: unknown = JSON.parse(m[1])
    if (!isRecord(parsed) || typeof parsed.label !== 'string') return { text }
    return { text: text.slice(0, m.index).trimEnd(), reply: parsed as unknown as GenuiReply }
  } catch {
    return { text }
  }
}

const strings = (x: unknown): Record<string, string | string[]> => {
  const out: Record<string, string | string[]> = {}
  if (!isRecord(x)) return out
  for (const [k, v] of Object.entries(x)) {
    if (typeof v === 'string') out[k] = v.slice(0, 2000)
    else if (Array.isArray(v)) out[k] = v.filter((s) => typeof s === 'string').slice(0, 30)
  }
  return out
}

/**
 * 插件交上来的一次动作 → 宿主做哪件事。`secretsDone`：这一块里已经填好的口令格名字（宿主自己记的）。
 * 动作名在过滤后的描述里找不到（被篡改 / 过期）→ `none`。
 */
export function resolveGenuiAction(
  spec: GenuiSpecLite,
  action: string,
  payload: Record<string, unknown>,
  secretsDone: readonly string[] = [],
): GenuiDispatch {
  const node = genuiNodes(spec).find(
    (n) => n.action === action || (n.type === 'submit' && n.resetAction === action),
  )
  const parsed = parseGenuiAction(action)
  if (node === undefined || parsed === undefined) return { kind: 'none' }
  const label = textOf(payload.label) || textOf(node.label) || textOf(node.question)
  const type = textOf(payload.type)
  if (type === 'submit-reset') return { kind: 'none' }
  if (parsed.kind === 'open') return { kind: 'open', to: parsed.to }
  if (parsed.kind === 'connect') return { kind: 'connect', services: parsed.services }
  if (parsed.kind === 'setup') return { kind: 'setup', target: parsed.target }
  if (type === 'submit') {
    const answers = strings(payload.answers)
    const fields = strings(payload.fields) as Record<string, string>
    const reply: GenuiReply = {
      label: label || '提交',
      ...(Object.keys(answers).length === 0 ? {} : { answers }),
      ...(Object.keys(fields).length === 0 ? {} : { fields }),
      ...(secretsDone.length === 0 ? {} : { secrets: [...secretsDone] }),
    }
    if (parsed.kind === 'tool')
      return {
        kind: 'tool',
        tool: parsed.tool,
        args: { ...(isRecord(node.args) ? node.args : {}), ...answers, ...fields },
        label: reply.label,
      }
    return { kind: 'reply', reply, text: genuiReplyToText(spec, reply) }
  }
  if (parsed.kind === 'tool')
    return { kind: 'tool', tool: parsed.tool, args: isRecord(node.args) ? node.args : {}, label }
  // 发一句话：按钮用写好的那句 / 按钮上的字；单个格子用「标签：值」
  if (parsed.kind === 'say' && parsed.text !== undefined) return { kind: 'say', text: parsed.text }
  if (type === 'button' || type === '')
    return label === '' ? { kind: 'none' } : { kind: 'say', text: label }
  if ((type === 'input' || type === 'textarea') && payload.submit !== true) return { kind: 'none' }
  if (type === 'quiz')
    return { kind: 'say', text: `${textOf(node.question)}：${textOf(payload.answer)}` }
  const name = textOf(node.label)
  if (type === 'checkbox')
    return { kind: 'say', text: `${payload.checked === true ? '选' : '不选'}「${name}」` }
  const value = type === 'switch' ? (payload.checked === true ? '开' : '关') : textOf(payload.value)
  if (value.trim() === '') return { kind: 'none' }
  return { kind: 'say', text: name === '' ? value : `${name}：${value}` }
}

/** WP341：对话里点了一个「调工具」的按钮（事项 / 线程里才有；随便聊等没有工具的地方当一句话发）。 */
export interface GenuiToolInput {
  tool: string
  args: Record<string, unknown>
  /** 按钮上的字（时间线那一句用）。 */
  label: string
  /** 出这个按钮的那一次运行（「改前必读」按那次运行读过的算）。 */
  run_id?: string
}

/**
 * 点了之后：`read` 只读、当场跑了（`data` 就地画）；`staged` 会改外部、出了审批卡（批了才做，卡就地画在对话里、
 * 卡片流同一张）；`refused` 这个按钮不能直接做（不在这条职责的工具里、或会直接写外部）。
 */
export interface GenuiToolOutcome {
  effect: 'read' | 'staged' | 'refused'
  status: 'ok' | 'error' | 'blocked'
  message?: string
  data?: unknown
  approval_item_ids?: string[]
}
