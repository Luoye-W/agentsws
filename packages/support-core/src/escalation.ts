/**
 * Extracted from KefuAgent src/lib/support/escalation-events.ts（EVENT_CONFIG 的
 * severity 表与 buildSupportEscalationDedupeKey）、src/lib/support/escalation-dedupe.ts
 * （family 语义）与 src/lib/support/amazon-sla.ts（AMAZON_MANUAL_REVIEW_KEYWORDS），
 * rewritten for agentsws contracts.
 *
 * 舍掉的：DB 行、卡片投影、外部通知渠道选择、usage 计费。
 * 留下的是**什么时候必须转人工、转给谁、去重键长什么样**。
 */
import type { Iso8601 } from '@agentsws/contracts'
import type { AnsweredBoundaryRef } from './boundaries.js'
import { findUnansweredBoundary } from './boundaries.js'
import type { SlaState } from './sla.js'
import { sanitizeExternal } from './text.js'
import type { Classification } from './types.js'

/**
 * 强制人工复核的词面（KefuAgent `AMAZON_MANUAL_REVIEW_KEYWORDS` 的移植）。
 * `rule` 进证据，**永远不进原文摘录**。
 */
export const MANUAL_REVIEW_RULES: readonly { rule: string; re: RegExp }[] = [
  { rule: 'negative_feedback', re: /\bnegative\s+feedback\b/i },
  { rule: 'negative_review', re: /\bnegative\s+review\b/i },
  { rule: 'bad_review', re: /\bbad\s+(?:review|feedback)\b/i },
  { rule: 'poor_review', re: /\bpoor\s+(?:review|feedback)\b/i },
  { rule: 'one_star', re: /\b(?:1|one)[\s-]*star\b/i },
  {
    rule: 'leave_feedback_threat',
    re: /\bleave\s+(?:a\s+)?(?:bad|negative|1|one)[\s-]*(?:star\s+)?(?:review|feedback)\b/i,
  },
  { rule: 'a_to_z', re: /\ba[\s-]*to[\s-]*z\b/i },
  { rule: 'a2z', re: /\ba2z\b/i },
  { rule: 'marketplace_guarantee', re: /\bguarantee\s+claim\b/i },
  { rule: 'chargeback', re: /\bcharge[\s-]?backs?\b/i },
  { rule: 'legal', re: /\b(?:lawsuit|lawyer|attorney|sue\s+you)\b/i },
  { rule: 'legal_zh', re: /(?:起诉|律师函|消协|工商局)/ },
]

/** 扫描上限，与 KefuAgent 一致：超长正文只看前 20000 字。 */
export const MANUAL_REVIEW_SCAN_CHARS = 20_000

export interface ManualReviewResult {
  required: boolean
  rules: string[]
}

/** 只返回规则 id，不返回命中的原文（原文进不了证据，避免把注入词面搬进卡片）。 */
export function evaluateManualReview(...texts: (string | undefined)[]): ManualReviewResult {
  const haystack = sanitizeExternal(
    texts.filter((t): t is string => t !== undefined && t.length > 0).join('\n'),
  ).slice(0, MANUAL_REVIEW_SCAN_CHARS)
  const rules = MANUAL_REVIEW_RULES.filter(({ re }) => re.test(haystack)).map((r) => r.rule)
  return { required: rules.length > 0, rules }
}

export interface ThreadState {
  /** 线程上的消息条数（含来信与回信）。 */
  messages: number
  /** 我们已经回过几次。 */
  agent_replies: number
  /** 客户重新开的次数（同一问题反复来信）。 */
  reopened?: number
  /** 起草文本（转人工要连回复一起扫，KefuAgent 的 scanTexts 同口径）。 */
  draft_text?: string
  /** 最近一条客户来信正文。 */
  inbound_text?: string
  sla?: SlaState
  /** 关系授权门禁已经把这条挡下（15 §6.1）——一律人工核验。 */
  authorization_blocked?: boolean
}

export type EscalationTarget = 'role_holder' | 'manager'

export interface EscalationDecision {
  escalate: boolean
  /** 机器可读的原因（进证据、进去重键），不是给客户看的文案。 */
  reason: string
  to: EscalationTarget
  /** 命中的全部原因，报告与卡片证据用。 */
  reasons: string[]
  severity: 'medium' | 'high'
}

/** 同一个原因只发一次卡：`<workspace>:<family>:<carrier>`（KefuAgent 去重键形状）。 */
export function escalationDedupeKey(args: {
  workspace_id: string
  family: string
  thread_id?: string
  conversation_id?: string
  operation_id?: string
}): string {
  const carrier = args.thread_id ?? args.conversation_id ?? args.operation_id ?? 'workspace'
  return [args.workspace_id, args.family, carrier].join(':')
}

const NO_ESCALATION: EscalationDecision = {
  escalate: false,
  reason: 'none',
  to: 'role_holder',
  reasons: [],
  severity: 'medium',
}

/**
 * 要不要转人工。
 *
 * 顺序即优先级：关系授权门禁 > 强制人工词面 > 未答边界 > SLA 破线 > 反复来信。
 * `manager` 只留给"钱与法律"这一档；其余交给职责持有人自己。
 */
export function shouldEscalate(
  classification: Classification,
  thread: ThreadState,
  policies: readonly AnsweredBoundaryRef[],
): EscalationDecision {
  const reasons: string[] = []
  let to: EscalationTarget = 'role_holder'
  let severity: 'medium' | 'high' = 'medium'

  if (thread.authorization_blocked === true) {
    reasons.push('authorization_check_failed')
    to = 'manager'
    severity = 'high'
  }

  const manual = evaluateManualReview(thread.inbound_text, thread.draft_text)
  for (const rule of manual.rules) {
    reasons.push(`manual_review:${rule}`)
    severity = 'high'
    if (rule === 'chargeback' || rule === 'legal' || rule === 'legal_zh') to = 'manager'
  }

  const unanswered = findUnansweredBoundary(classification, policies)
  if (unanswered !== undefined) {
    reasons.push(`boundary_unanswered:${unanswered.id}`)
  }

  const sla = thread.sla
  if (sla !== undefined && !sla.stopped) {
    if (sla.first_response_breached) {
      reasons.push('sla_first_response_breached')
      severity = 'high'
      to = 'manager'
    } else if (sla.tier === 'critical') {
      reasons.push('sla_critical')
      severity = 'high'
    } else if (sla.tier === 'reminder') {
      reasons.push('sla_reminder')
    }
  }

  if ((thread.reopened ?? 0) >= 2) {
    reasons.push('repeated_reopen')
  }
  if (thread.agent_replies >= 3 && thread.messages >= 6) {
    reasons.push('conversation_stalled')
  }
  if (classification.entities.commitment !== undefined) {
    reasons.push('claimed_commitment')
    severity = 'high'
  }

  if (reasons.length === 0) return NO_ESCALATION
  const reason = reasons[0] ?? 'none'
  return { escalate: true, reason, to, reasons, severity }
}

/** 停表：我们已经回过、且回复晚于最后一条客户来信。 */
export function deEscalated(sla: SlaState | undefined, at: Iso8601): boolean {
  if (sla === undefined) return false
  return sla.stopped && Date.parse(at) >= Date.parse(sla.anchor_at)
}
