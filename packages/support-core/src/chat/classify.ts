/**
 * Extracted from KefuAgent src/lib/support/verticals/render.ts (classifyChatTurn / matchesTerm)
 * 与 src/lib/support/chat.ts (detectChatOrderRef), rewritten for agentsws contracts。
 *
 * **零模型**的聊天分类：一张顺序词表，先命中先返回，末条兜底。
 *
 * 为什么聊天这一条一定要零模型：秒回是它的全部价值，起手先等一次模型往返
 * 就把这条产品做没了。模型只在 `answer` 这一支里出现，而且只写那句话——
 * "这一轮属于哪一类、能不能自动答"永远是我们自己的代码判的。
 *
 * 注入进不来判定：所有文本先过 `sanitizeExternal`（围栏清洗），判定只看**词面命中**，
 * 从不解释文本里的祈使句。
 */
import { haystack, sanitizeExternal } from '../text.js'
import { DEFAULT_CHAT_PACK } from './pack.js'
import type { ChatClassification, ChatClassifierRule, ChatPack } from './types.js'

/**
 * 词面匹配：ASCII 词要求左边界不是字母（"I stopped by" 不该命中 "stopped"），
 * 非 ASCII（中文）走朴素 `includes`。从 KefuAgent 原样搬来，语义未动。
 */
export function matchesChatTerm(text: string, term: string): boolean {
  if (term.length === 0) return false
  if (!/^[\x20-\x7e]+$/.test(term)) return text.includes(term)
  let from = 0
  for (;;) {
    const at = text.indexOf(term, from)
    if (at === -1) return false
    if (at === 0 || !/[a-z]/.test(text[at - 1] as string)) return true
    from = at + 1
  }
}

/** 命中的词面，按词表顺序（顺序稳定 → 断言可复现）。 */
function matchedOf(text: string, terms: readonly string[]): string[] {
  return terms.filter((t) => matchesChatTerm(text, t))
}

/**
 * 访客文本里的订单号，**一处定义**。
 *
 * 两份正则不会报错，只会让商家点开的那一单和 AI 查的那一单不是同一单
 * （KefuAgent 把它从分类器里提出来就是为了这个）。
 */
export function detectChatOrderRef(text: string): string | undefined {
  const clean = sanitizeExternal(text)
  return clean.match(/(?:order|订单|#)\s*[:#-]?\s*([a-z0-9-]{4,})/i)?.[1]
}

export interface ChatClassifyContext {
  pack?: ChatPack
  /** 工作区学到的商品 / 品牌词（提到它本身就是售前信号）。 */
  product_terms?: readonly string[]
}

function ruleMatches(
  rule: ChatClassifierRule,
  text: string,
  product_terms: readonly string[],
): boolean {
  if (rule.terms.some((t) => matchesChatTerm(text, t))) return true
  return (
    rule.match_product_terms === true &&
    product_terms.some((t) => t.length >= 3 && text.includes(t.toLowerCase()))
  )
}

/** 一轮访客发言 → 意图 / 置信度 / 风险 / 中文原因 / 订单号。 */
export function classifyChatTurn(
  turn_text: string,
  ctx: ChatClassifyContext = {},
): ChatClassification {
  const pack = ctx.pack ?? DEFAULT_CHAT_PACK
  const product_terms = ctx.product_terms ?? []
  const text = haystack(turn_text)
  const order_ref = detectChatOrderRef(turn_text)
  const rules = pack.classifier_rules

  for (const [index, rule] of rules.entries()) {
    const isFallback = index === rules.length - 1
    if (!isFallback && !ruleMatches(rule, text, product_terms)) continue

    const subHit = rule.sub_intent?.terms.some((t) => matchesChatTerm(text, t)) ?? false
    const riskHit = rule.risk_escalation?.terms.some((t) => matchesChatTerm(text, t)) ?? false

    const matched = [
      ...matchedOf(text, rule.terms),
      ...(subHit ? matchedOf(text, rule.sub_intent?.terms ?? []) : []),
      ...(riskHit ? matchedOf(text, rule.risk_escalation?.terms ?? []) : []),
    ]

    return {
      intent: subHit ? (rule.sub_intent?.intent ?? rule.intent) : rule.intent,
      confidence: rule.confidence,
      risk: riskHit ? (rule.risk_escalation?.risk ?? rule.risk) : rule.risk,
      reason: rule.reason,
      matched_terms: matched,
      ...(rule.drop_order_ref === true || order_ref === undefined ? {} : { order_ref }),
    }
  }

  // 包里最后一条必须是兜底（没有 terms）。走到这里说明包写坏了。
  throw new Error(`聊天垂直包 ${pack.key} 缺兜底分类规则`)
}
