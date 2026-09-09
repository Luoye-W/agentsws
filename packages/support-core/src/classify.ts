/**
 * Extracted from KefuAgent src/lib/support/email-triage.ts
 * (classifyEmailHeuristically / buildThreadTakeoverClassification / normalizeCategory),
 * rewritten for agentsws contracts.
 *
 * 两层 + 一个可注入口：
 *   ① 强规则（线程接管、发件人域、平台通知）——不看词表就能定
 *   ② 词表（SUPPORT_TERMS 命中后再细分）
 *   ③ 宿主先跑好的模型分类（`ctx.model`）——**包内不调模型**（22：模型只在网关后面）
 *
 * 注入指令进不来这里的判定：所有文本先过 `sanitizeExternal`（围栏清洗），
 * 而且判定只看**词面命中**，从不解释文本里的祈使句。
 */
import type { InboundEvent } from '@agentsws/contracts'
import { extractEntities } from './entities.js'
import {
  BUSINESS_TERMS,
  CANCELLATION_TERMS,
  COMPLAINT_TERMS,
  DAMAGE_TERMS,
  MARKETING_TERMS,
  PLATFORM_TERMS,
  PRODUCT_QUESTION_TERMS,
  RETURN_REFUND_TERMS,
  SPAM_TERMS,
  SUPPORT_TERMS,
  TRACKING_TERMS,
  URGENCY_TERMS,
  WARRANTY_TERMS,
} from './lexicon.js'
import { detectLanguage, haystack, includesAny, matchTerms, sanitizeExternal } from './text.js'
import type {
  Classification,
  ClassifyContext,
  InboundText,
  SupportEntities,
  SupportIntent,
  Urgency,
} from './types.js'

const INTENTS: readonly SupportIntent[] = [
  'pre_sales',
  'post_sales',
  'order_tracking',
  'returns_refunds',
  'product_question',
  'complaint',
  'cancellation',
  'warranty',
  'business',
  'supplier',
  'marketing',
  'platform_notification',
  'spam',
  'other',
]

const NON_SUPPORT_INTENTS: ReadonlySet<SupportIntent> = new Set<SupportIntent>([
  'business',
  'supplier',
  'marketing',
  'platform_notification',
  'spam',
  'other',
])

/** 未知值一律 `other`（KefuAgent normalizeCategory 的同口径）。 */
export function normalizeIntent(value: unknown): SupportIntent {
  return typeof value === 'string' && (INTENTS as readonly string[]).includes(value)
    ? (value as SupportIntent)
    : 'other'
}

/** `InboundEvent` → 起草与分类都认得的纯文本。`parts` 里的非文本部分只留类型提示。 */
export function inboundText(event: InboundEvent): InboundText {
  const text = event.parts
    .map((p) => {
      if (p.type === 'text') return p.text
      if (p.type === 'image' || p.type === 'file') return `[attachment:${p.mime ?? p.type}]`
      return ''
    })
    .filter((t) => t.length > 0)
    .join('\n')
  const from = event.actor?.external_id
  return { text: sanitizeExternal(text), ...(from === undefined ? {} : { from }) }
}

function urgencyOf(text: string, intent: SupportIntent, entities: SupportEntities): Urgency {
  if (intent === 'complaint') return 'high'
  if (entities.deadline !== undefined && includesAny(text, URGENCY_TERMS)) return 'high'
  if (entities.commitment !== undefined) return 'high'
  if (includesAny(text, URGENCY_TERMS) || entities.deadline !== undefined) return 'normal'
  return intent === 'spam' || intent === 'marketing' ? 'low' : 'normal'
}

interface Verdict {
  intent: SupportIntent
  is_customer_service: boolean
  confidence: number
  reason: string
  terms: readonly string[]
}

/**
 * 词表层。分支顺序即优先级，与 KefuAgent 一致：
 * 先看是不是客服诉求（SUPPORT_TERMS），命中后按 退换退款 → 物流 → 破损 → … 细分；
 * 没命中再依次排除平台通知、推广、商务。
 */
function lexiconVerdict(text: string): Verdict {
  if (includesAny(text, SPAM_TERMS)) {
    return {
      intent: 'spam',
      is_customer_service: false,
      confidence: 0.92,
      reason: '命中垃圾邮件词面，不进客服队列。',
      terms: SPAM_TERMS,
    }
  }
  if (includesAny(text, SUPPORT_TERMS)) {
    if (includesAny(text, COMPLAINT_TERMS)) {
      return {
        intent: 'complaint',
        is_customer_service: true,
        confidence: 0.95,
        reason: '邮件包含投诉、差评或争议信号，应由客服职责接管。',
        terms: COMPLAINT_TERMS,
      }
    }
    if (includesAny(text, RETURN_REFUND_TERMS)) {
      return {
        intent: 'returns_refunds',
        is_customer_service: true,
        confidence: 0.94,
        reason: '邮件包含退货、退款或换货相关诉求，应由客服职责接管。',
        terms: RETURN_REFUND_TERMS,
      }
    }
    if (includesAny(text, CANCELLATION_TERMS)) {
      return {
        intent: 'cancellation',
        is_customer_service: true,
        confidence: 0.93,
        reason: '邮件在要求取消订单或修改地址，应由客服职责接管。',
        terms: CANCELLATION_TERMS,
      }
    }
    if (includesAny(text, TRACKING_TERMS)) {
      return {
        intent: 'order_tracking',
        is_customer_service: true,
        confidence: 0.96,
        reason: '邮件在询问订单、物流、包裹或配送状态，应由客服职责接管。',
        terms: TRACKING_TERMS,
      }
    }
    if (includesAny(text, DAMAGE_TERMS)) {
      return {
        intent: 'complaint',
        is_customer_service: true,
        confidence: 0.95,
        reason: '邮件包含损坏、错发或少件信号，应由客服职责接管。',
        terms: DAMAGE_TERMS,
      }
    }
    if (includesAny(text, WARRANTY_TERMS)) {
      return {
        intent: 'warranty',
        is_customer_service: true,
        confidence: 0.92,
        reason: '邮件在问保修或维修，应由客服职责接管。',
        terms: WARRANTY_TERMS,
      }
    }
    if (includesAny(text, PRODUCT_QUESTION_TERMS)) {
      return {
        intent: 'product_question',
        is_customer_service: true,
        confidence: 0.9,
        reason: '邮件在问产品用法、尺寸或兼容性，应由客服职责接管。',
        terms: PRODUCT_QUESTION_TERMS,
      }
    }
    return {
      intent: 'post_sales',
      is_customer_service: true,
      confidence: 0.91,
      reason: '邮件包含典型售前/售后客服问题，应由客服职责接管。',
      terms: SUPPORT_TERMS,
    }
  }
  if (includesAny(text, PLATFORM_TERMS)) {
    return {
      intent: 'platform_notification',
      is_customer_service: false,
      confidence: 0.9,
      reason: '邮件更像平台、安全或账单通知，不进客服队列。',
      terms: PLATFORM_TERMS,
    }
  }
  if (includesAny(text, MARKETING_TERMS)) {
    return {
      intent: 'marketing',
      is_customer_service: false,
      confidence: 0.89,
      reason: '邮件更像推广、SEO、广告或合作邀约，不进客服队列。',
      terms: MARKETING_TERMS,
    }
  }
  if (includesAny(text, BUSINESS_TERMS)) {
    return {
      intent: 'business',
      is_customer_service: false,
      confidence: 0.86,
      reason: '邮件更像商务合作或供应链沟通，不进客服队列。',
      terms: BUSINESS_TERMS,
    }
  }
  return {
    intent: 'other',
    is_customer_service: false,
    confidence: 0.75,
    reason: '未发现明确售前/售后客服诉求，默认保持在原收件箱。',
    terms: [],
  }
}

/** 分类一封来信。纯函数：同输入同输出，不看时钟也不看随机。 */
export function classifyText(inbound: InboundText, ctx: ClassifyContext): Classification {
  const text = haystack(inbound.subject ?? ctx.subject, inbound.text, inbound.from ?? ctx.from)
  const entities = extractEntities(inbound.subject ?? ctx.subject, inbound.text)
  const language = detectLanguage(inbound.subject ?? ctx.subject, inbound.text)

  if (ctx.thread_taken_over === true) {
    return {
      intent: 'post_sales',
      is_customer_service: true,
      confidence: 1,
      classifier: 'thread_takeover',
      reason: '该邮件属于已被客服职责接管的线程，后续回复默认继续由它处理。',
      language,
      urgency: urgencyOf(text, 'post_sales', entities),
      entities,
      matched_terms: [],
    }
  }

  const lexicon = lexiconVerdict(text)
  const matched_terms = matchTerms(text, lexicon.terms)

  const model = ctx.model
  if (
    model !== undefined &&
    (model.intent !== undefined || model.is_customer_service !== undefined)
  ) {
    const intent = model.intent === undefined ? lexicon.intent : normalizeIntent(model.intent)
    const raw = model.confidence
    const confidence =
      typeof raw === 'number' && Number.isFinite(raw)
        ? Math.max(0, Math.min(1, raw > 1 ? raw / 100 : raw))
        : lexicon.confidence
    return {
      intent,
      is_customer_service: model.is_customer_service ?? !NON_SUPPORT_INTENTS.has(intent),
      confidence,
      classifier: 'model',
      reason: model.reason === undefined || model.reason === '' ? lexicon.reason : model.reason,
      language,
      urgency: urgencyOf(text, intent, entities),
      entities,
      matched_terms,
    }
  }

  return {
    intent: lexicon.intent,
    is_customer_service: lexicon.is_customer_service,
    confidence: lexicon.confidence,
    classifier: lexicon.intent === 'other' ? 'default' : 'lexicon',
    reason: lexicon.reason,
    language,
    urgency: urgencyOf(text, lexicon.intent, entities),
    entities,
    matched_terms,
  }
}

/** 18 §2 `InboundEvent` 的入口。 */
export function classifyInbound(event: InboundEvent, ctx: ClassifyContext): Classification {
  const parsed = inboundText(event)
  return classifyText(parsed, {
    ...ctx,
    ...(parsed.from === undefined ? {} : { from: parsed.from }),
  })
}
