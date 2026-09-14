/**
 * Extracted from KefuAgent src/lib/support/chat.ts + src/lib/support/verticals/{render,goods/intents}.ts,
 * rewritten for agentsws contracts（48 §4 L3 #11 的本地部分，WP57）。
 *
 * 在线聊天与邮件是**两条流水线**，共用同一套知识、订单只读与围栏纪律，但判据不同：
 * 邮件是"慢、长、可以先查再答"，聊天是"秒回、短、一轮可能是三条消息"。
 * 所以这里另起一套意图与计划类型，而不是复用 `SupportIntent`——两边的冻结面互不牵连。
 *
 * 全部纯函数，零 IO、零模型（同 `support-core` 的纪律）。
 */
import type { Iso8601 } from '@agentsws/contracts'

/**
 * 聊天意图。取自 KefuAgent `CommerceChatIntent` 的冻结面（goods 垂直包的八值），
 * 名字不改——WP54 的垂直包按这些名字引用分类规则与缺料规则。
 */
export type ChatIntent =
  | 'presales_product'
  | 'order_tracking'
  | 'shipping_delay'
  | 'return_refund'
  | 'product_issue'
  | 'warranty_parts'
  | 'human_handoff'
  | 'general_support'

/** 一轮对话里说话的三种角色。`operator` = 商家在后台说话（教 AI），不直接对客。 */
export type ChatMessageRole = 'visitor' | 'agent' | 'operator'

/** 聊天里的一条消息（纯函数层只认这四个字段）。 */
export interface ChatTurnMessage {
  id: string
  role: ChatMessageRole
  /** 已围栏或未围栏都行：所有判定入口都会再清洗一次。 */
  text: string
  at: Iso8601
}

export type ChatRisk = 'normal' | 'high'

export interface ChatClassification {
  intent: ChatIntent
  /** 0..1（与 `Classification.confidence` 同量纲；KefuAgent 的 0..100 在这里除以 100）。 */
  confidence: number
  risk: ChatRisk
  /** 中文简短原因，进沙盒页与卡片 summary。 */
  reason: string
  /** 正文里认出来的订单号；认不出就没有这一格（绝不编）。 */
  order_ref?: string
  /** 命中的词面，按词表顺序（顺序稳定 → 断言可复现）。 */
  matched_terms: string[]
}

/**
 * 五种动作（48 §4 #11 的"词表分类 → 计划 → 轻模型答 / 求助 / 转人工 / 超时转邮件"）。
 *
 * - `answer`：低风险、资料齐，轻模型直接答；
 * - `collect_info`：缺关键资料，先追问（追问措辞按垂直包取）；
 * - `human_review`：涉钱 / 退款 / 改单 / 高风险——**聊天里只答不承诺**，出卡给人；
 * - `assist`：AI 答不了，向商家求助（T+3 提醒、T+10 转邮件）；
 * - `handoff`：客户点名要真人，或人已接管——AI 闭嘴。
 */
export type ChatPlanAction = 'answer' | 'collect_info' | 'human_review' | 'assist' | 'handoff'

export interface ChatResponsePlan {
  action: ChatPlanAction
  intent: ChatIntent
  risk: ChatRisk
  /** AI 能不能自己把这句话发出去（`human_review` / `assist` / `handoff` 一律 false）。 */
  can_auto_reply: boolean
  needs_human_review: boolean
  /** 还缺什么资料（中文短语，按包里的顺序——顺序会原样进对客追问句）。 */
  missing_info: string[]
  /** 给人看的一句中文，进沙盒页与卡片 summary。 */
  summary: string
  /** 下一句该问什么（中文；对客文案由轻模型按客户语言重写）。 */
  next_question: string
  /**
   * 这一轮碰到钱没有（退款 / 赔偿 / 改单 / 折扣）。
   *
   * 这是本 WP 的那条硬规则的机器可读形态：**碰到钱就不能在聊天里承诺**，
   * 一律转卡片或邮件。`true` 时 `can_auto_reply` 必为 false。
   */
  money_touch: boolean
}

/* ------------------------------------------------------------------ */
/* 垂直包（WP54 在做；本 WP 只留参数位与一套默认值）                        */
/* ------------------------------------------------------------------ */

/** 分类器一行：`terms` 命中即判 `intent`；最后一行没有 `terms`，是兜底。 */
export interface ChatClassifierRule {
  intent: ChatIntent
  terms: readonly string[]
  /** 0..1 */
  confidence: number
  risk: ChatRisk
  reason: string
  /** 细分：命中这些词面就改判成 `intent`（KefuAgent 的 `subIntent`）。 */
  sub_intent?: { terms: readonly string[]; intent: ChatIntent }
  /** 命中这些词面就抬到 high（KefuAgent 的 `riskEscalation`）。 */
  risk_escalation?: { terms: readonly string[]; risk: ChatRisk }
  /** 这一类判出来后订单号无意义（售前 / 要人工），丢掉。 */
  drop_order_ref?: boolean
  /** 提到工作区学到的商品词本身就算一次命中（售前那条）。 */
  match_product_terms?: boolean
}

/** 缺料规则一条。 */
export interface ChatMissingInfoRule {
  intents: readonly ChatIntent[]
  /** 中文短语，原样进追问句。 */
  label: string
  /** 同一条的英文说法（轻模型写英文回复时用）。 */
  label_en: string
  /** 这些信号任一有值即算不缺。 */
  satisfied_by: readonly ChatEvidenceSignal[]
  /** 词面兜底（朴素 `includes`，不走词首边界——与 KefuAgent 一致）。 */
  satisfied_by_terms?: readonly string[]
}

export type ChatEvidenceSignal = 'order_ref' | 'email' | 'product_context'

/**
 * 一个垂直包给聊天流水线的那一份。
 *
 * WP54 会为实物 / 虚拟各出一份；本 WP 只提供 `DEFAULT_CHAT_PACK`（实物那套，
 * 措辞取自现有 `support-core` 的常量），并保证每个入口都能收一个 `pack` 参数。
 */
export interface ChatPack {
  /** 包的名字（`goods` / `digital`）；进事件与报告。 */
  key: string
  classifier_rules: readonly ChatClassifierRule[]
  missing_info: readonly ChatMissingInfoRule[]
  /** 这些意图缺料也先答（售前是买家时刻，停下来先要型号是最贵的摩擦）。 */
  non_blocking_intents: readonly ChatIntent[]
  /** 这些意图一律人审（退款那类）。 */
  must_review_intents: readonly ChatIntent[]
  /** "要人工"那个意图的名字。 */
  handoff_intent: ChatIntent
  /** 什么都不缺时的收尾问句。 */
  default_next_question: string
  /** 追问句模板，`{items}` = 缺料清单。 */
  collect_info_template: string
  /** 答完再追问的模板。 */
  answer_then_ask_template: string
  /** 涉钱转卡时说给客户听的那句（中文；轻模型按客户语言重写）。 */
  money_handoff_reply: string
  /** 求助时说给客户听的那句。 */
  assist_reply: string
  /** 求助超时转邮件时说的那句。 */
  email_follow_up_reply: string
  /** T+3 提醒时说的那句。 */
  assist_reminder_reply: string
}

/* ------------------------------------------------------------------ */
/* 会话状态机                                                            */
/* ------------------------------------------------------------------ */

/**
 * 会话状态。比 KefuAgent 多一态 `human_takeover`：
 * 我们**保留**"人直接接管键盘"这条路（沙盒页上那个开关），因为本地档的商家
 * 就坐在工作台前面；接管期间 AI 一句都不答（`canChatAutoReply` 为 false）。
 */
export type ChatSessionStatus =
  | 'open'
  | 'assist_requested'
  | 'assist_answered'
  | 'human_takeover'
  | 'email_follow_up'
  | 'closed'

export const CHAT_SESSION_STATUSES: readonly ChatSessionStatus[] = [
  'open',
  'assist_requested',
  'assist_answered',
  'human_takeover',
  'email_follow_up',
  'closed',
]

/** 合法迁移表。表是真源：巡检的谓词从它算出来，不写字面量。 */
const TRANSITIONS: Readonly<Record<ChatSessionStatus, readonly ChatSessionStatus[]>> = {
  open: ['assist_requested', 'human_takeover', 'email_follow_up', 'closed'],
  assist_requested: ['assist_answered', 'human_takeover', 'email_follow_up', 'closed'],
  assist_answered: ['open', 'assist_requested', 'human_takeover', 'email_follow_up', 'closed'],
  human_takeover: ['open', 'email_follow_up', 'closed'],
  email_follow_up: ['closed'],
  closed: [],
}

export function isLegalChatTransition(from: ChatSessionStatus, to: ChatSessionStatus): boolean {
  return (TRANSITIONS[from] ?? []).includes(to)
}

/** 从哪几态可以被超时巡检降到"转邮件跟进"。 */
export const CHAT_DEMOTABLE_STATUSES: readonly ChatSessionStatus[] = CHAT_SESSION_STATUSES.filter(
  (s) => isLegalChatTransition(s, 'email_follow_up'),
)

/**
 * 这一态还让不让 AI 自动答。
 *
 * 人接管了就一句都不答（本 WP 的硬性要求）；等商家教、已转邮件、已关闭同理。
 */
export function canChatAutoReply(status: ChatSessionStatus): boolean {
  return status === 'open' || status === 'assist_answered'
}
