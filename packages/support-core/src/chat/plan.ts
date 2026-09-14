/**
 * Extracted from KefuAgent src/lib/support/verticals/render.ts (buildChatPlan),
 * rewritten for agentsws contracts.
 *
 * 回复计划：这一轮该做什么。五种动作，判定顺序即优先级：
 *
 * | # | 条件 | 动作 |
 * |---|---|---|
 * | 1 | 人已接管（`takeover`）或会话已关 | `handoff`（AI 一句都不答） |
 * | 2 | 客户点名要真人 | `assist`（向商家求助，起超时钟） |
 * | 3 | **涉钱**（退款 / 赔偿 / 折扣 / 改单 / 改地址 / 补发）或高风险或包里的必审意图 | `human_review`（出卡，聊天里只安抚不承诺） |
 * | 4 | 缺关键资料且这一类缺了就走不下去 | `collect_info` |
 * | 5 | 其余 | `answer`（轻模型按知识与订单事实答） |
 *
 * 第 3 条是 48 §3 L1 那句"聊天里只答不承诺，涉钱一律转卡片 / 邮件"的落点，
 * 不是可配置项：`money_touch` 为真时 `can_auto_reply` 恒为 false，
 * 任何包都覆盖不了它（包只能决定措辞，决定不了要不要过人）。
 */
import { haystack } from '../text.js'
import { matchesChatTerm } from './classify.js'
import { CHAT_MONEY_TERMS, DEFAULT_CHAT_PACK } from './pack.js'
import type {
  ChatClassification,
  ChatEvidenceSignal,
  ChatPack,
  ChatResponsePlan,
  ChatSessionStatus,
} from './types.js'
import { canChatAutoReply } from './types.js'

/** 访客文本里的邮箱（对**未小写**的原文求值，与 KefuAgent 一致）。 */
const CHAT_EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/

/** 客户描述了具体产品或使用场景 = 售前有上下文。 */
const PRODUCT_CONTEXT_TERMS = [
  'model',
  'version',
  'color',
  'colour',
  'inch',
  'cm',
  'mm',
  'kid',
  'child',
  'beginner',
  'commute',
  'height',
  'weight',
  '型号',
  '颜色',
  '版本',
  '尺寸',
  '孩子',
  '新手',
  '通勤',
  '身高',
  '体重',
] as const

const MODEL_TOKEN = /\b[a-z]{1,4}[-\s]?\d{1,4}(?:\s?(?:pro|plus|max|lite|s))?\b/

export interface ChatPlanInput {
  classification: ChatClassification
  /** 这一轮的原文（聚合后的）。 */
  turn_text: string
  pack?: ChatPack
  product_terms?: readonly string[]
  /** 会话现在什么状态；不给按 `open`。 */
  status?: ChatSessionStatus
  /** 人是不是正接管着这条会话（沙盒页上那个开关）。 */
  takeover?: boolean
}

/** 这一轮碰到钱没有。词表命中即真——宁可多过一次人，也不要在聊天里承诺一笔钱。 */
export function touchesMoney(turn_text: string): boolean {
  const text = haystack(turn_text)
  return CHAT_MONEY_TERMS.some((t) => matchesChatTerm(text, t))
}

function fill(template: string, items: readonly string[]): string {
  return template.replace('{items}', items.join('、'))
}

export function buildChatPlan(input: ChatPlanInput): ChatResponsePlan {
  const pack = input.pack ?? DEFAULT_CHAT_PACK
  const { classification: cls } = input
  const text = haystack(input.turn_text)
  const status: ChatSessionStatus = input.status ?? 'open'
  const money_touch = touchesMoney(input.turn_text)

  // ── 缺料（每一支都要报，`answer` 也报——答完再在结尾追问）
  const cache = new Map<ChatEvidenceSignal, boolean>()
  const hasSignal = (signal: ChatEvidenceSignal): boolean => {
    const cached = cache.get(signal)
    if (cached !== undefined) return cached
    const value =
      signal === 'order_ref'
        ? cls.order_ref !== undefined
        : signal === 'email'
          ? CHAT_EMAIL_RE.test(input.turn_text)
          : PRODUCT_CONTEXT_TERMS.some((t) => matchesChatTerm(text, t)) ||
            MODEL_TOKEN.test(text) ||
            (input.product_terms ?? []).some(
              (t) => t.length >= 3 && matchesChatTerm(text, t.toLowerCase()),
            )
    cache.set(signal, value)
    return value
  }
  const missing_info: string[] = []
  for (const rule of pack.missing_info) {
    if (!rule.intents.includes(cls.intent)) continue
    if (missing_info.includes(rule.label)) continue
    const satisfied =
      rule.satisfied_by.some(hasSignal) ||
      (rule.satisfied_by_terms?.some((t) => text.includes(t)) ?? false)
    if (!satisfied) missing_info.push(rule.label)
  }

  const head = { intent: cls.intent, risk: cls.risk, missing_info, money_touch }

  // ① 人接管了（或会话已不接受自动回复）→ AI 闭嘴
  if (input.takeover === true || !canChatAutoReply(status)) {
    return {
      ...head,
      action: 'handoff',
      can_auto_reply: false,
      needs_human_review: true,
      summary:
        input.takeover === true
          ? '人工已接管这条会话，AI 不再自动回复。'
          : `会话现在是「${status}」，不接受自动回复。`,
      next_question: '',
    }
  }

  // ② 客户点名要真人 → 求助（起 T+3 / T+10 的钟）
  if (cls.intent === pack.handoff_intent) {
    return {
      ...head,
      action: 'assist',
      can_auto_reply: false,
      needs_human_review: true,
      summary: '访客明确要求人工，转求助并通知值班的人。',
      next_question: pack.assist_reply,
    }
  }

  // ③ 涉钱 / 高风险 / 包里的必审意图 → 出卡，聊天里只安抚不承诺
  if (money_touch || cls.risk === 'high' || pack.must_review_intents.includes(cls.intent)) {
    return {
      ...head,
      action: 'human_review',
      can_auto_reply: false,
      needs_human_review: true,
      summary: money_touch
        ? '这一轮碰到了钱或订单变更：聊天里只答不承诺，出卡给人定。'
        : '这一轮属于高风险或必审意图，AI 只能先收集信息与安抚。',
      next_question: pack.money_handoff_reply,
    }
  }

  // ④ 缺关键资料且这一类缺了就走不下去
  const blocks = !pack.non_blocking_intents.includes(cls.intent)
  if (missing_info.length > 0 && blocks) {
    return {
      ...head,
      action: 'collect_info',
      can_auto_reply: true,
      needs_human_review: false,
      summary: '这个问题 AI 能继续处理，但要先补齐关键上下文。',
      next_question: fill(pack.collect_info_template, missing_info),
    }
  }

  // ⑤ 低风险、能答
  return {
    ...head,
    action: 'answer',
    can_auto_reply: true,
    needs_human_review: false,
    summary:
      missing_info.length > 0
        ? '低风险问题：先按现有信息作答，再在结尾追问缺的那一项。'
        : '低风险问题，可以按知识与订单事实直接回复。',
    next_question:
      missing_info.length > 0
        ? fill(pack.answer_then_ask_template, missing_info)
        : pack.default_next_question,
  }
}
