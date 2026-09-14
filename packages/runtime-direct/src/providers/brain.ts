import type { ChatMessage, Clock, ModelProvider, ModelRef } from '@agentsws/contracts'
import { marketplaceLinkSlip } from '@agentsws/stand-ins'
import type { Vertical } from '@agentsws/support-core'
import {
  classifyText,
  detectAnsweredBoundaries,
  gateChange,
  renderReplyBody,
  returnWindowPolicy,
} from '@agentsws/support-core'
import { DRAFT_REPLY_TOOL, STAGE_REFUND_TOOL } from '../assemble.js'
import { asRecord, type OrderView, orderIdFromText, orderView } from '../view.js'
import type { ScriptedTurn, ScriptFn } from './scripted.js'
import { scriptedProvider } from './scripted.js'

/**
 * 售后"规则脑"：一个**确定性的** ModelProvider，用工具协议说话。
 *
 * 它不是模型，是模拟档的模型替身（26 §3）——22 的 stub provider 只出文本、不出 tool_calls，
 * turn loop 跑不起来。判定逻辑与 stub 运行时同一套（先查单 → 查政策 → 窗口内提退款 → 起草），
 * 差别只在"决定"是经工具协议表达的：换掉 dsh 之后同一条场景照样走完。
 */
export interface AftersalesBrainOptions {
  clock: Clock
  /** 政策里读不到窗口时的默认天数。 */
  defaultReturnWindowDays?: number
  signature?: string
  /**
   * 48 v2 L2（WP54）：这个工作区卖的是什么。规则脑是**按工作区装配**的
   * （一个进程一个工作区），所以垂直在装配那一刻就定了，不用每条消息再带一次。
   * 不给就实物——与 WP54 之前逐字节相同。
   */
  vertical?: Vertical
}

const DAY = 86_400_000
const BLOCK = /^\[([a-z_]+):([^\]]*)\]\n?([\s\S]*)$/
const FENCED = /<external_data>\n([\s\S]*)\n<\/external_data>/
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/

interface Block {
  kind: string
  id: string
  body: string
}

function blocksOf(messages: readonly ChatMessage[]): Block[] {
  const out: Block[] = []
  for (const m of messages) {
    if (m.role === 'tool' || m.role === 'assistant') continue
    const match = BLOCK.exec(m.content)
    if (match?.[1] !== undefined && match[2] !== undefined && match[3] !== undefined) {
      out.push({ kind: match[1], id: match[2], body: match[3] })
    }
  }
  return out
}

function toolMessages(messages: readonly ChatMessage[], name: string): ChatMessage[] {
  return messages.filter(
    (m) => m.role === 'tool' && (m.name === name || m.name?.endsWith(`.${name}`)),
  )
}

function fencedJson(content: string): unknown {
  const inner = FENCED.exec(content)?.[1]
  if (inner === undefined) return undefined
  try {
    return JSON.parse(inner) as unknown
  } catch {
    return undefined
  }
}

/** 政策 / 事实卡里的退货窗口天数（`14 days` / `14 天`）。 */
function windowDaysOf(blocks: readonly Block[], fallback: number): { days: number; card?: Block } {
  const candidates = [
    ...blocks.filter((b) => b.kind === 'fact_card'),
    ...blocks.filter((b) => b.kind === 'policy'),
  ]
  for (const b of candidates) {
    const m = b.body.match(/(\d{1,3})\s*(?:days?|天)/i)
    if (m?.[1] !== undefined) return { days: Number.parseInt(m[1], 10), card: b }
  }
  return { days: fallback }
}

function lastLine(text: string): string {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  return lines[lines.length - 1] ?? ''
}

/** 规则脑的一步决策：纯函数（messages + clock → 下一轮说什么）。 */
export function aftersalesBrain(options: AftersalesBrainOptions): ScriptFn {
  const fallbackWindow = options.defaultReturnWindowDays ?? 14
  const signature = options.signature ?? 'Customer Care'
  const vertical = options.vertical

  return ({ messages, tools }): ScriptedTurn => {
    const available = new Set((tools ?? []).map((t) => t.name))
    const blocks = blocksOf(messages)
    const thread = blocks.find((b) => b.kind === 'thread')
    const threadBody = thread?.body ?? ''
    const subjectLine = lastLine(threadBody)
    const policy = windowDaysOf(blocks, fallbackWindow)

    const orderResults = toolMessages(messages, 'get_order')
    const lastOrderResult = orderResults[orderResults.length - 1]
    const order =
      lastOrderResult === undefined ? undefined : orderView(fencedJson(lastOrderResult.content))
    const orderId = order?.id ?? orderIdFromText(threadBody)

    const askedPolicy = toolMessages(messages, 'search_policies').length > 0
    const stageResults = toolMessages(messages, STAGE_REFUND_TOOL)
    const draftResults = toolMessages(messages, DRAFT_REPLY_TOOL)

    // 1) 先查单（grounding 命中时运行时已经强制过一轮，这里就跳过）
    if (orderResults.length === 0 && available.has('get_order') && orderId !== undefined) {
      return { tool_calls: [{ name: 'get_order', input: { order_id: orderId } }] }
    }

    // 2) 查政策：退货窗口只来自知识层，不从模型脑子里编
    if (!askedPolicy && available.has('search_policies')) {
      return { tool_calls: [{ name: 'search_policies', input: { query: 'return window' } }] }
    }

    // 1c：分类 / 起草 / 边界判定统一走客服共享包（33 §1），与 stub 运行时同一套判定
    const classification = classifyText(
      { text: threadBody, subject: subjectLine },
      { now: options.clock.now(), ...(vertical === undefined ? {} : { vertical }) },
    )
    const wantsChange = classification.intent === 'returns_refunds'
    const answered = detectAnsweredBoundaries({
      texts: blocks.filter((b) => b.kind === 'policy' || b.kind === 'fact_card').map((b) => b.body),
      at: options.clock.now(),
    })
    if (
      policy.card !== undefined &&
      !answered.some((p) => p.boundary_id === 'policy.refund_window')
    ) {
      answered.push(returnWindowPolicy(policy.days, options.clock.now(), policy.card.id))
    }
    // 没答过的边界挡着：不提退款，只起草"交给同事确认"的回信（不自作主张）
    const gate = gateChange({
      change_kind: 'refund',
      ...(vertical === undefined ? {} : { vertical }),
      classification,
      policies: answered,
      text: threadBody,
    })
    const nowMs = Date.parse(options.clock.now())
    const deliveredMs =
      order?.delivered_at === undefined ? undefined : Date.parse(order.delivered_at)
    const daysSince =
      deliveredMs === undefined ? undefined : Math.floor((nowMs - deliveredMs) / DAY)
    const withinWindow = daysSince !== undefined && daysSince <= policy.days
    const refundAmount =
      order === undefined
        ? undefined
        : Math.round((order.total_price - order.refunded_amount) * 100) / 100

    // 3) 窗口内的变更请求 → 提一条待批的退款（stage，不是写外部）
    if (
      stageResults.length === 0 &&
      available.has(STAGE_REFUND_TOOL) &&
      wantsChange &&
      gate.allowed &&
      withinWindow &&
      order !== undefined &&
      refundAmount !== undefined &&
      refundAmount > 0
    ) {
      return {
        tool_calls: [
          {
            name: STAGE_REFUND_TOOL,
            input: {
              order_id: order.id,
              amount: refundAmount,
              currency: order.currency,
              notes: [
                `退货窗口 ${policy.days} 天内（签收 ${daysSince ?? '?'} 天）`,
                '由 direct-llm 运行时按政策提出',
              ],
            },
          },
        ],
      }
    }

    // 4) 起草回复
    if (draftResults.length === 0 && available.has(DRAFT_REPLY_TOOL)) {
      const stagedOk = stageResults.some((m) => m.content.includes('change_id'))
      const to = order?.email ?? EMAIL.exec(threadBody)?.[0]
      const customer =
        order?.customer_name ?? order?.email?.split('@')[0] ?? to?.split('@')[0] ?? 'there'
      const subject = subjectLine.startsWith('Re:') ? subjectLine : `Re: ${subjectLine}`
      const recipients = to === undefined ? [] : [to]
      // WP55 / 48 §4 L3 #2：Amazon 站内信上真模型最常犯的那一次违规（把官网链接
      // 原样抄进正文）。三个运行时共用同一份复现，硬闸那条路才在每个运行时下
      // 都真的走一遍。WP54：模板按垂直包取。
      const body = marketplaceLinkSlip(
        renderReplyBody({
          windowDays: policy.days,
          withinWindow,
          windowFromFact: policy.card !== undefined,
          customer,
          signature,
          ...(vertical === undefined ? {} : { vertical }),
          ...(order === undefined ? {} : { order }),
          ...(daysSince === undefined ? {} : { daysSinceDelivery: daysSince }),
          ...(stagedOk && refundAmount !== undefined ? { refundAmount } : {}),
        }),
        recipients,
      )
      return {
        tool_calls: [
          {
            name: DRAFT_REPLY_TOOL,
            input: {
              to: recipients,
              subject,
              body,
              citations:
                policy.card === undefined
                  ? []
                  : [
                      {
                        fact_card_id: policy.card.id,
                        quote: `returns within ${policy.days} days of delivery`,
                      },
                    ],
            },
          },
        ],
      }
    }

    return {
      text: `Handled: order ${order?.name ?? orderId ?? 'unknown'}, return window ${policy.days} days.`,
    }
  }
}

export interface AftersalesBrainProviderOptions extends AftersalesBrainOptions {
  ref?: ModelRef
  seed?: number
}

/** 规则脑 + 确定性 usage → 一个可以直接挂进模型网关的 provider。 */
export function aftersalesBrainProvider(options: AftersalesBrainProviderOptions): ModelProvider {
  return scriptedProvider({
    script: aftersalesBrain(options),
    ...(options.ref === undefined ? {} : { ref: options.ref }),
    ...(options.seed === undefined ? {} : { seed: options.seed }),
  })
}

/** 强制工具轮里给工具补参数（`withToolChoice` 的 `inputFor`）。 */
export function groundingInputFor(
  tool: string,
  messages: readonly ChatMessage[],
): Record<string, unknown> {
  const blocks = blocksOf(messages)
  const thread = blocks.find((b) => b.kind === 'thread')
  const bare = tool.includes('.') ? tool.slice(tool.indexOf('.') + 1) : tool
  if (bare === 'get_order') {
    const id = orderIdFromText(thread?.body ?? '')
    return id === undefined ? {} : { order_id: id }
  }
  if (bare === 'search_policies') return { query: 'return window' }
  return {}
}

/** 工具结果里的订单（测试与宿主装配用）。 */
export function orderFromToolMessage(message: ChatMessage): OrderView | undefined {
  const data = fencedJson(message.content)
  return asRecord(data) === undefined ? undefined : orderView(data)
}
