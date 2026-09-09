/**
 * Extracted from KefuAgent src/lib/support/policy/policy-boundaries.ts
 * (projectPolicyQuestionCard / buildContextZh) 与 src/lib/support/deck-card-model.ts
 * （卡片 = 待办的投影、去重键 = 只问一次），rewritten for agentsws contracts.
 *
 * 这里只产**审批项的 payload**，不建审批项本身——`ApprovalBus.create` 是宿主的事（14 §1）。
 * 三种形态：
 *   `policy_change`（问句形态，带 options）      ← 业务边界第一次遇到
 *   `knowledge_update`（可带候选写法 options）   ← 知识确认
 *   `ai_question`（缺资料提问，选择题形态）      ← 起草缺料
 */
import type { ApprovalKind, ObjectRef } from '@agentsws/contracts'
import type { KnowledgeCandidate } from './knowledge.js'
import { displayLine } from './text.js'
import type { BoundaryItem } from './types.js'

/** 36 §2.3 DeckCard 的选项。 */
export interface CardOption {
  id: string
  label: string
}

export interface CardHighlight {
  type: 'amount' | 'deadline' | 'commitment' | 'risk_term' | 'order_ref'
  text: string
}

/** 14 §4：去重键 = 只问一次。同一条边界在一个工作区只问一次。 */
export function boundaryDedupeKey(workspace_id: string, boundary_id: string): string {
  return `${workspace_id}:policy_change:${boundary_id}`
}

export interface PolicyQuestionPayload {
  form: 'policy_question'
  boundary_id: string
  question: string
  label: string
  options: CardOption[]
  /** 允许"其他…"：走 instruct 抽屉自述，落成 custom 答案。 */
  allows_custom: true
  /** 为什么现在问（给商家看的中文一句话）。 */
  context: string
  /** 触发它的那次运行 / 线程。 */
  trigger: { run_id?: string; conversation_id?: string; intent?: string }
}

export interface PolicyQuestionRequest {
  kind: Extract<ApprovalKind, 'policy_change'>
  title: string
  summary: string
  dedupe_key: string
  payload: PolicyQuestionPayload
  priority: 'immediate' | 'queue' | 'digest'
}

/**
 * 业务边界 → `policy_change` 审批项（问句形态）。
 *
 * 卡片上是选择题：`approve` 必须带 `selected_option_id`，裸 approve 由宿主拒
 * （36 §2.1 `OPTION_REQUIRED`）。答案由 `answerBoundary` 沉淀成策略。
 */
export function policyQuestionRequest(
  boundary: BoundaryItem,
  ctx: {
    workspace_id: string
    run_id?: string
    conversation_id?: string
    intent?: string
  },
): PolicyQuestionRequest {
  const context =
    `AI 第一次遇到与「${boundary.label}」有关的场景，这条业务边界还没有答案。` +
    '答过一次之后，AI 起草时就能直接按这个口径说，不用再问。'
  return {
    kind: 'policy_change',
    title: displayLine(boundary.question, 40),
    summary: context,
    dedupe_key: boundaryDedupeKey(ctx.workspace_id, boundary.id),
    priority: 'queue',
    payload: {
      form: 'policy_question',
      boundary_id: boundary.id,
      question: boundary.question,
      label: boundary.label,
      options: boundary.options.map((o) => ({ id: o.id, label: o.label })),
      allows_custom: true,
      context,
      trigger: {
        ...(ctx.run_id === undefined ? {} : { run_id: ctx.run_id }),
        ...(ctx.conversation_id === undefined ? {} : { conversation_id: ctx.conversation_id }),
        ...(ctx.intent === undefined ? {} : { intent: ctx.intent }),
      },
    },
  }
}

export interface KnowledgeUpdatePayload {
  form: 'knowledge_update'
  candidate_key: string
  layer: KnowledgeCandidate['layer']
  question: string
  statement: string
  category: string
  /** 候选写法（36 §2.2「可带候选写法选项」）。 */
  options: CardOption[]
  hold_reasons: string[]
  commitments: string[]
  deidentified: boolean
  provenance: KnowledgeCandidate['provenance']
}

export interface KnowledgeUpdateRequest {
  kind: Extract<ApprovalKind, 'knowledge_update'>
  title: string
  summary: string
  dedupe_key: string
  payload: KnowledgeUpdatePayload
  priority: 'immediate' | 'queue' | 'digest'
  subject: ObjectRef
}

/** 知识候选 → `knowledge_update` 审批项。 */
export function knowledgeUpdateRequest(
  candidate: KnowledgeCandidate,
  ctx: { workspace_id: string; subject?: ObjectRef; alternatives?: readonly string[] },
): KnowledgeUpdateRequest {
  const options: CardOption[] = [
    { id: 'as_proposed', label: '按这条写法采纳' },
    ...(ctx.alternatives ?? []).map((label, i) => ({ id: `alt_${i + 1}`, label })),
  ]
  return {
    kind: 'knowledge_update',
    title: displayLine(`知识确认：${candidate.question}`, 60),
    summary:
      candidate.hold_reasons.length === 0
        ? '这条口径可以直接进知识库，采纳后 AI 起草时会引用它。'
        : `这条口径需要你确认（${candidate.hold_reasons.join('、')}），采纳后才会被引用。`,
    dedupe_key: `${ctx.workspace_id}:knowledge_update:${candidate.key}`,
    priority: 'queue',
    subject: ctx.subject ?? { type: 'fact_card', id: candidate.key },
    payload: {
      form: 'knowledge_update',
      candidate_key: candidate.key,
      layer: candidate.layer,
      question: candidate.question,
      statement: candidate.statement,
      category: candidate.category,
      options,
      hold_reasons: candidate.hold_reasons,
      commitments: candidate.commitments,
      deidentified: candidate.deidentified,
      provenance: candidate.provenance,
    },
  }
}

/** 缺资料提问的中文问法。 */
const NEED_QUESTIONS: Readonly<Record<string, { question: string; options: CardOption[] }>> = {
  order_ref: {
    question: '这封信没给订单号，要怎么办？',
    options: [
      { id: 'ask_customer', label: '回信问客户要订单号' },
      { id: 'search_by_email', label: '按邮箱去查最近的订单' },
      { id: 'i_will_handle', label: '我来处理这一条' },
    ],
  },
  photos: {
    question: '客户说东西坏了但没附照片，要怎么办？',
    options: [
      { id: 'ask_customer', label: '回信请客户补三张照片（商品、外箱、序列号）' },
      { id: 'skip_photos', label: '不要照片，直接按政策处理' },
      { id: 'i_will_handle', label: '我来处理这一条' },
    ],
  },
  tracking_number: {
    question: '要查物流但手上没有运单号，要怎么办？',
    options: [
      { id: 'ask_customer', label: '回信问客户要运单号' },
      { id: 'lookup_carrier', label: '按订单去承运商那边查' },
      { id: 'i_will_handle', label: '我来处理这一条' },
    ],
  },
}

export interface AiQuestionPayload {
  form: 'ai_question'
  need: string
  question: string
  options: CardOption[]
  allows_custom: true
  highlights: CardHighlight[]
}

export interface AiQuestionRequest {
  /**
   * 契约里还没有 `ai_question` 这一种 `ApprovalKind`（14 §1 只有 15 种）。
   * 36 §2.2 的选择题卡就是 `policy_change` 的问句形态，v1 借它渲染；
   * `payload.form = 'ai_question'` 让工作台区分两者。见报告"需要契约改动"。
   */
  kind: Extract<ApprovalKind, 'policy_change'>
  title: string
  summary: string
  dedupe_key: string
  payload: AiQuestionPayload
  priority: 'immediate' | 'queue' | 'digest'
}

/** 起草时发现缺资料 → 选择题卡。不认识的 need 返回 undefined（不编问题）。 */
export function aiQuestionRequest(
  need: string,
  ctx: { workspace_id: string; conversation_id?: string; highlights?: readonly CardHighlight[] },
): AiQuestionRequest | undefined {
  const spec = NEED_QUESTIONS[need]
  if (spec === undefined) return undefined
  const carrier = ctx.conversation_id ?? 'workspace'
  return {
    kind: 'policy_change',
    title: displayLine(spec.question, 40),
    summary: 'AI 起草到一半缺了这份资料，给它一个做法就能继续。',
    dedupe_key: `${ctx.workspace_id}:ai_question:${need}:${carrier}`,
    priority: 'queue',
    payload: {
      form: 'ai_question',
      need,
      question: spec.question,
      options: spec.options,
      allows_custom: true,
      highlights: [...(ctx.highlights ?? [])],
    },
  }
}
