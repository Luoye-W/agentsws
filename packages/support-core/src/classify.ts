/**
 * Extracted from KefuAgent src/lib/support/email-triage.ts
 * (classifyEmailHeuristically / buildThreadTakeoverClassification / normalizeCategory),
 * rewritten for agentsws contracts.
 *
 * 两层 + 一个可注入口：
 *   ① 强规则（线程接管）——不看词表就能定
 *   ② 词表（**按垂直包取**：实物先过"是不是客服诉求"那道门再细分；虚拟产品按方向判）
 *   ③ 宿主先跑好的模型分类（`ctx.model`）——**包内不调模型**（22：模型只在网关后面）
 *
 * WP54（48 v2 L2）：词表不再写在这个文件里，从 `getVerticalPack(vertical).triage` 取。
 * 这个文件里**不许出现 `vertical === 'digital'` 这种字面比较**
 * （`test/vertical-no-literal.test.ts` 扫源码钉住）。
 *
 * 注入指令进不来这里的判定：所有文本先过 `sanitizeExternal`（围栏清洗），
 * 而且判定只看**词面命中**，从不解释文本里的祈使句。
 */
import type { InboundEvent } from '@agentsws/contracts'
import { extractEntitiesIn } from './entities.js'
import { URGENCY_TERMS } from './lexicon.js'
import { detectLanguage, haystack, includesAny, matchTerms, sanitizeExternal } from './text.js'
import type {
  Classification,
  ClassifyContext,
  InboundText,
  SupportEntities,
  SupportIntent,
  Urgency,
} from './types.js'
import { getVerticalPack } from './verticals/index.js'
import type { Vertical } from './verticals/types.js'

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
  // WP54：虚拟产品与服务那一套（`digital` 垂直包产出它们）
  'billing',
  'account_access',
  'bug_report',
  'how_to',
  'integration',
  'data_privacy',
  'feature_request',
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
 * 词表层。规则顺序即优先级，先命中先返回；`requires` 是那道"先确认是客服诉求"的门。
 *
 * 表在垂直包里（`triage.rules`），这里只跑它。实物那张表与 WP54 之前的分支顺序、
 * 置信度、原因文案逐条相同——搬家不改一个字节。
 */
function lexiconVerdict(text: string, vertical: Vertical | undefined): Verdict {
  const pack = getVerticalPack(vertical).triage
  for (const rule of pack.rules) {
    if (rule.requires !== undefined && !includesAny(text, rule.requires)) continue
    if (!includesAny(text, rule.terms)) continue
    return {
      intent: rule.intent,
      is_customer_service: rule.is_customer_service,
      confidence: rule.confidence,
      reason: rule.reason,
      terms: rule.terms,
    }
  }
  return { ...pack.fallback, terms: [] }
}

/** 分类一封来信。纯函数：同输入同输出，不看时钟也不看随机。 */
export function classifyText(inbound: InboundText, ctx: ClassifyContext): Classification {
  const vertical = ctx.vertical
  const pack = getVerticalPack(vertical)
  const text = haystack(inbound.subject ?? ctx.subject, inbound.text, inbound.from ?? ctx.from)
  const entities = extractEntitiesIn(vertical, inbound.subject ?? ctx.subject, inbound.text)
  const language = detectLanguage(inbound.subject ?? ctx.subject, inbound.text)

  if (ctx.thread_taken_over === true) {
    const taken = pack.triage.takenOverIntent
    return {
      intent: taken,
      is_customer_service: true,
      confidence: 1,
      classifier: 'thread_takeover',
      reason: '该邮件属于已被客服职责接管的线程，后续回复默认继续由它处理。',
      language,
      urgency: urgencyOf(text, taken, entities),
      entities,
      matched_terms: [],
    }
  }

  const lexicon = lexiconVerdict(text, vertical)
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
