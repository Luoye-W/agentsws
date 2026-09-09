/**
 * 三个运行时（stub / direct-llm / dsh）共用的两件小事：
 *
 * 1. **业务边界判定**（36 §2.2 / 33 §1）——从 RunRequest 的策略层与知识层推出"商家答过哪些边界"，
 *    再交给 `@agentsws/support-core` 的 `gateChange` 判断这次变更有没有被没答过的边界挡着。
 *    三个运行时都调这一份：`boundary-first-time` 那张选择题卡在哪个运行时下都得出来。
 * 2. **事项摘要**（17 §3 `RunResult.summary`）——一句人话，从工具调用与产出拼，
 *    不是 "stub 运行：2 次工具调用，1 项产物" 那种给机器看的字符串。
 *
 * 放在替身包里而不是各写一遍：一处改，三个运行时同时改（09 §0 "插拔 = 契约 + 一致性套件"）。
 */
import type { ContextItem, Iso8601, RunRequest } from '@agentsws/contracts'
import type { BoundaryItem, Classification, SupportPolicy } from '@agentsws/support-core'
import {
  classifyText,
  detectAnsweredBoundaries,
  gateChange,
  returnWindowPolicy,
} from '@agentsws/support-core'

// ---------- 上下文读取（三个运行时同一份口径） ----------

/** RunRequest 里某一类上下文项。 */
export function contextItemsOfKind(req: RunRequest, kind: ContextItem['kind']): ContextItem[] {
  return req.context.filter((c) => c.kind === kind)
}

/** 只认对象（不认数组、不认 null）。 */
export function asPlainRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined
}

/** 任意上下文内容 → 纯文本（优先取常见正文字段，其余按值拼）。 */
export function contextText(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === null || v === undefined) return ''
  if (Array.isArray(v)) return v.map(contextText).join('\n')
  const o = asPlainRecord(v)
  if (o === undefined) return String(v)
  const preferred = ['body', 'text', 'message', 'content', 'subject', 'summary']
  const picked = preferred.filter((k) => typeof o[k] === 'string').map((k) => o[k] as string)
  if (picked.length > 0) return picked.join('\n')
  return Object.values(o).map(contextText).join('\n')
}

/** 从 policy / fact_card 里读退货窗口天数（`14 days` / `14 天` / `return_window_days: 14`）。 */
export function returnWindowFrom(
  req: RunRequest,
  fallback: number,
): { days: number; source?: ContextItem } {
  const candidates = [...contextItemsOfKind(req, 'policy'), ...contextItemsOfKind(req, 'fact_card')]
  for (const item of candidates) {
    const o = asPlainRecord(item.content)
    const explicit = o?.return_window_days
    if (typeof explicit === 'number' && Number.isFinite(explicit)) {
      return { days: explicit, source: item }
    }
    const m = contextText(item.content).match(/(\d{1,3})\s*(?:days?|天)/i)
    if (m?.[1] !== undefined) return { days: Number.parseInt(m[1], 10), source: item }
  }
  return { days: fallback }
}

/** 线程正文（第一条 `thread` 上下文项）。 */
export function threadBodyOf(req: RunRequest): string {
  const item = contextItemsOfKind(req, 'thread')[0]
  return item === undefined ? '' : contextText(item.content)
}

/** 线程主题（补 `Re:` 前缀）。 */
export function threadSubjectOf(req: RunRequest): string | undefined {
  const item = contextItemsOfKind(req, 'thread')[0]
  const subject = item === undefined ? undefined : asPlainRecord(item.content)?.subject
  if (typeof subject !== 'string') return undefined
  return subject.startsWith('Re:') ? subject : `Re: ${subject}`
}

// ---------- 业务边界 ----------

/**
 * 商家**答过**的边界。只从策略层与知识层推（`detectAnsweredBoundaries`），
 * 绝不从线程正文推——客户信里写什么都不能算商家答过一条边界。
 */
export function answeredBoundaries(
  req: RunRequest,
  at: Iso8601,
  policy: { days: number; source?: ContextItem },
): SupportPolicy[] {
  const structured = contextItemsOfKind(req, 'policy').map((i) => i.content)
  const texts = [...contextItemsOfKind(req, 'policy'), ...contextItemsOfKind(req, 'fact_card')].map(
    (i) => contextText(i.content),
  )
  const answered = detectAnsweredBoundaries({ texts, structured, at })
  if (
    policy.source !== undefined &&
    !answered.some((p) => p.boundary_id === 'policy.refund_window')
  ) {
    answered.push(returnWindowPolicy(policy.days, at, policy.source.id))
  }
  return answered
}

export interface BoundaryGate {
  classification: Classification
  /** 这次来信是不是在要一笔变更（退款 / 退货）。 */
  wantsChange: boolean
  /** 管着这次变更的边界是否都答过。 */
  allowed: boolean
  /** 没答过的那些边界（每条对应一张选择题卡）。 */
  missing: BoundaryItem[]
  /** 读到的退货窗口。 */
  windowDays: number
  windowSource?: ContextItem
}

/**
 * 一次运行的边界判定。三个运行时都调它，判定逻辑只有这一份。
 *
 * `missing` 非空 = 第一次碰到一条没答过、又管着这次变更的边界：
 * 不自作主张（不 stage），起草"交给同事确认"的回信，另外发一张 `policy_change` 选择题卡。
 */
export function boundaryGate(input: {
  request: RunRequest
  now: Iso8601
  defaultReturnWindowDays: number
}): BoundaryGate {
  const { request, now } = input
  const policy = returnWindowFrom(request, input.defaultReturnWindowDays)
  const text = threadBodyOf(request)
  const subject = threadSubjectOf(request)
  const classification = classifyText(
    { text, ...(subject === undefined ? {} : { subject }) },
    { now },
  )
  const gate = gateChange({
    change_kind: 'refund',
    classification,
    policies: answeredBoundaries(request, now, policy),
    text,
  })
  return {
    classification,
    wantsChange: classification.intent === 'returns_refunds',
    allowed: gate.allowed,
    missing: gate.missing,
    windowDays: policy.days,
    ...(policy.source === undefined ? {} : { windowSource: policy.source }),
  }
}

// ---------- 事项摘要 ----------

export interface RunSummaryInput {
  /** 这次真的调用成功的读工具（按调用顺序，重复的算一次）。 */
  readTools: readonly string[]
  /** 读到的订单名（`#1001`）。 */
  orderName?: string
  /** 起草了回信。 */
  drafted: boolean
  /** 挂了一笔待批的变更。 */
  staged?: { kind: string; amount?: number; currency?: string }
  /** 问了口径（选择题卡）：边界的白话名字。 */
  askedBoundaries?: readonly string[]
  /** 预算耗尽的那一项。 */
  exhausted?: string
  /** 被中断。 */
  cancelled?: boolean
  /** 运行失败的原因（一句话）。 */
  failed?: string
}

const CHANGE_LABEL: Record<string, string> = {
  refund: '退款',
  goodwill_credit: '补偿',
  price_change: '改价',
  inventory_change: '改库存',
  order_edit: '改订单',
}

function toolLabel(name: string): string | undefined {
  const bare = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name
  switch (bare) {
    case 'get_order':
    case 'list_orders':
      return '订单'
    case 'search_policies':
      return '退货政策'
    case 'get_product':
      return '商品'
    case 'list_threads':
      return '会话记录'
    default:
      return undefined
  }
}

function moneyText(staged: NonNullable<RunSummaryInput['staged']>): string {
  const label = CHANGE_LABEL[staged.kind] ?? staged.kind
  if (staged.amount === undefined) return `一笔${label}`
  const amount = Number.isInteger(staged.amount) ? String(staged.amount) : staged.amount.toFixed(2)
  return `一笔 ${amount}${staged.currency === undefined ? '' : ` ${staged.currency}`} 的${label}`
}

/**
 * 一句人话的事项摘要（17 §3）：查了什么、出了什么、有没有挂着待批的东西。
 * 三个运行时同一份拼法，所以摘要读起来一样，不会因为换运行时变味。
 */
export function describeRun(input: RunSummaryInput): string {
  if (input.failed !== undefined) return `这次没跑完：${input.failed}。`
  if (input.cancelled === true) return '这次被中断了，没结的工具调用已经收尾。'

  const looked: string[] = []
  for (const name of input.readTools) {
    const label = toolLabel(name)
    if (label === undefined || looked.includes(label)) continue
    looked.push(
      label === '订单' && input.orderName !== undefined ? `订单 ${input.orderName}` : label,
    )
  }

  const parts: string[] = []
  if (looked.length > 0) parts.push(`查了${looked.join('、')}`)
  const made: string[] = []
  if (input.drafted) made.push('起草了回复')
  if (input.staged !== undefined) made.push(`挂了${moneyText(input.staged)}待批`)
  if (made.length > 0) parts.push(made.join('，'))

  const asked = input.askedBoundaries ?? []
  if (asked.length > 0) {
    parts.push(`另外问了${asked.map((a) => `「${a}」`).join('、')}的口径，等你定`)
  }

  if (input.exhausted !== undefined) {
    const head = parts.length > 0 ? `${parts.join('，')}；` : ''
    return `${head}预算不够（${input.exhausted}）就停了，没结的工具调用已经收尾。`
  }
  if (parts.length === 0) return '这次什么也没做：没查到东西，也没出草稿。'
  return `${parts.join('，')}。`
}
