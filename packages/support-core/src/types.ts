/**
 * Extracted from KefuAgent src/lib/support/email-triage.ts + src/lib/support/verticals/goods/*,
 * rewritten for agentsws contracts.
 *
 * 客服共享包的公共类型（33 §1「同一份职责包代码，两种交付形态」）。
 * 全部与我们的契约对齐：意图类目沿用 KefuAgent 的冻结面（边界触发表按名字引用它们），
 * 其余对象重写成 14（审批项）/ 19（知识对象）/ 24（技能与学习回路）的形状。
 */
import type { ChangeKind, Iso8601, KnowledgeLayer, PersonId } from '@agentsws/contracts'

/**
 * 入站意图。取自 KefuAgent `EmailTriageResult['category']` 的冻结面
 * （业务边界注册表的 `applies_when.intents` 按这些名字引用，改名即破坏已答边界的关联），
 * 加上我们这边需要单列的两类：`cancellation`（取消 / 改单 / 改地址）与 `warranty`（保修）。
 */
export type SupportIntent =
  | 'pre_sales'
  | 'post_sales'
  | 'order_tracking'
  | 'returns_refunds'
  | 'product_question'
  | 'complaint'
  | 'cancellation'
  | 'warranty'
  | 'business'
  | 'supplier'
  | 'marketing'
  | 'platform_notification'
  | 'spam'
  | 'other'

/** 分流出来的语言（ISO 639-1 子集；判不出按 `en`）。 */
export type SupportLanguage = 'zh' | 'en' | 'es' | 'fr' | 'de' | 'ja' | 'pt' | 'it'

export type Urgency = 'low' | 'normal' | 'high'

/** 证据芯片（36 §2.1）：金额、期限、承诺、风险词、订单号。数字只从事实里取，不由模型生成。 */
export interface SupportEntities {
  /** 正文里出现的订单号（`#1001` → `#1001`；解析成内部 id 是宿主的事）。 */
  order_ref?: string
  /** 客户提到的金额。`currency` 判不出时省略，绝不猜。 */
  amount?: { value: number; currency?: string }
  /** 期限线索的原文片段（"before Friday" / "本周五前"）。 */
  deadline?: string
  /** 客户主张我们做过的承诺的原文片段（"you promised a refund"）。 */
  commitment?: string
  /** 风险词（词面来自 KefuAgent deriveRiskLevel 的冻结词集）。 */
  risk_terms: string[]
}

export interface Classification {
  intent: SupportIntent
  /** 该不该由客服职责接管（非客服邮件 = false，例如平台通知、商务合作）。 */
  is_customer_service: boolean
  /** 0..1。规则命中越强越高；模型结果覆盖时用模型的。 */
  confidence: number
  /** 哪一层给出的结论。 */
  classifier: 'thread_takeover' | 'model' | 'rules' | 'lexicon' | 'default'
  /** 中文简短原因（给人看，进卡片 summary）。 */
  reason: string
  language: SupportLanguage
  urgency: Urgency
  entities: SupportEntities
  /** 命中的词面，报告与回归用（顺序稳定：按词表顺序）。 */
  matched_terms: string[]
}

/**
 * 可注入的"模型分类"结果。**包内不调模型**（22 §模型只在网关后面）：
 * 宿主先把模型跑完，把结果作为提示喂进来，规则层负责裁剪与兜底。
 */
export interface ModelClassification {
  intent?: SupportIntent | string
  is_customer_service?: boolean
  confidence?: number
  language?: string
  reason?: string
}

export interface ClassifyContext {
  /** 时间经注入（不用 `Date.now()`）。目前只用于产出可复现的原因文本预留位。 */
  now: Iso8601
  subject?: string
  /** 来信人地址（平台通知、供应商靠它兜底）。 */
  from?: string
  /** 线程已被 AI 客服接管：后续来信默认继续（KefuAgent buildThreadTakeoverClassification）。 */
  thread_taken_over?: boolean
  /** 宿主先跑好的模型分类；不给就纯规则。 */
  model?: ModelClassification
}

/* ------------------------------------------------------------------ */
/* 业务边界                                                             */
/* ------------------------------------------------------------------ */

export interface BoundaryOption {
  id: string
  /** 问句与选项恒中文：商户用中文管理 AI（KefuAgent 契约通用规则 2）。 */
  label: string
  value: Record<string, unknown>
}

/** 触发条件：任一维度命中即触发（OR）。 */
export interface BoundaryTriggers {
  intents?: SupportIntent[]
  risk_terms?: string[]
  change_kinds?: ChangeKind[]
}

export interface BoundaryItem {
  /** `policy.<boundary>`，snake_case，一经冻结不可改名（已答行以 id 关联）。 */
  id: string
  /** 问句形态的卡片正文（36 §2.2 policy_change 选择题卡）。 */
  question: string
  /** 短标签，进证据芯片与聚合读模型。 */
  label: string
  options: BoundaryOption[]
  /** 默认选项 id。没有共识的边界不给默认值——宁可多问一次。 */
  default?: string
  applies_when: BoundaryTriggers
  /**
   * `enforced` = 两个触发点会为它发卡；`declared` = 登记即合法，但本版不发卡
   * （KefuAgent 契约通用规则 5）。
   */
  wiring: 'enforced' | 'declared'
}

/**
 * 边界答案沉淀出来的策略对象。
 * `statement` 直接可做 19 §1.1 FactCard（`layer: 'policy'`）的正文；
 * 一条策略的产生路径是 36 §2.2 的选择题卡 → 14 的 `policy_change` 审批项。
 */
export interface SupportPolicy {
  boundary_id: string
  /** 选了哪个选项；商户走"其他…"自述时没有。 */
  option_id?: string
  value: Record<string, unknown>
  statement: string
  answered_by: PersonId | 'import'
  answered_at: Iso8601
  source: 'approval' | 'import' | 'default'
  approval_item_id?: string
}

/* ------------------------------------------------------------------ */
/* 起草                                                                 */
/* ------------------------------------------------------------------ */

/** 起草只认这些订单事实；数字全部来自这里，模型不产数字（29 原则 ③）。 */
export interface OrderFacts {
  id: string
  name: string
  currency: string
  total_price: number
  refunded_amount: number
  financial_status: string
  fulfillment_status: string
  email?: string
  delivered_at?: Iso8601
  customer_name?: string
}

/** 检索命中（19 §3 RetrievalHit 的起草侧投影）。 */
export interface KnowledgeHit {
  fact_card_id: string
  layer: KnowledgeLayer
  /** 已脱敏的正文。起草只把它当"依据"，不逐字回显。 */
  statement: string
  /** 结构化值（`return_window_days` 之类）。 */
  structured?: Record<string, unknown>
  score?: number
}

export interface DraftPersona {
  /** 落款。 */
  signature: string
  /** 收信人称呼；不给就按订单 / 邮箱推。 */
  customer_name?: string
}

/** 入站文本。传进来时可能已被围栏包过一层，起草前统一再清洗一次。 */
export interface InboundText {
  text: string
  subject?: string
  from?: string
}

export interface DraftReplyInput {
  inbound: InboundText
  classification: Classification
  order?: OrderFacts
  policies: readonly SupportPolicy[]
  knowledge_hits: readonly KnowledgeHit[]
  persona: DraftPersona
  locale: string
  /** 时间经注入。 */
  now: Iso8601
  /** 政策与知识里都读不到窗口时的兜底天数。 */
  default_return_window_days?: number
}

export interface DraftedReply {
  subject: string
  body: string
  citations: { fact_card_id: string; quote: string }[]
  /** 还缺什么资料才能往下走（照片、订单号、运单号……）。 */
  needs: string[]
  /** 起草时看见的风险（`risk:refund`、`boundary_unanswered:policy.…`）。 */
  risk_flags: string[]
  /** 用到的退货窗口天数与它的来源，卡片上要显示。 */
  return_window: { days: number; fact_card_id?: string }
}
