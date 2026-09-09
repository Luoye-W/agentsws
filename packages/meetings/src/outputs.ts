/**
 * 产出 → 审批项 **payload**（14 §3）。形态照 `@agentsws/support-core/approvals.ts` 来：
 * 这里只产 payload 与去重键，**不建审批项本身**——`ApprovalBus.create` 是宿主的事（14 §1）。
 *
 * 三条去处（37 §4.1）：
 * - 待办提案 → `claim`（06 §2 认领管道，`payload.source = 'meeting'`，本人确认前不形成责任）
 * - 知识候选 → `knowledge_update`
 * - 边界答案 → `policy_change`
 *
 * 决定（`decisions`）不建审批项：它进纪要与事项时间线，属于记录不属于待决。
 */
import type {
  ApprovalKind,
  ClaimPayload,
  Meeting,
  MeetingBoundaryAnswer,
  MeetingKnowledgeCandidate,
  MeetingOutputs,
  MeetingTodoProposal,
  ObjectRef,
} from '@agentsws/contracts'
import { displayLine } from '@agentsws/support-core'

export interface ApprovalRequest<K extends ApprovalKind, P> {
  kind: K
  title: string
  summary: string
  dedupe_key: string
  priority: 'immediate' | 'queue' | 'digest'
  subject: ObjectRef
  payload: P
}

/** 14 §5：`claim` 的 discriminator 是 `(source, quote_hash)`——同一句话只问一次。 */
export function claimDedupeKey(workspace_id: string, source: string, quote: string): string {
  return `${workspace_id}:claim:${source}:${fnv1a(quote)}`
}

/** 短哈希；只为去重键稳定，不做安全用途。 */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

const SPEECH_STATE_ZH: Readonly<Record<MeetingTodoProposal['speech_state'], string>> = {
  suggested: '会上有人提到',
  confirmed: '本人在会上认下了',
  assigned: '会上点名指派给你',
}

const REASON_ZH: Readonly<Record<string, string>> = {
  assignee_not_in_meeting: '被点名的人不在与会名单里',
  speaker_unknown: '这份记录没有说话人，认不出是谁说的',
  high_risk_action: '涉及钱或价格，会上一句话不算指派',
}

function why(reasons: readonly string[]): string {
  const hits = reasons.map((r) => REASON_ZH[r]).filter((s): s is string => s !== undefined)
  return hits.length === 0 ? '' : `（${hits.join('；')}）`
}

export type ClaimRequest = ApprovalRequest<'claim', ClaimPayload>

/**
 * 待办提案 → `claim` 认领卡。
 *
 * 卡面上写清三件事：会上原话、言语状态、**不确认就不算你的**（31 I13）。
 * 路由结果（route_confidence）不得用于考核——这条写在 payload 的注释里，也写在 06。
 */
export function claimRequest(
  todo: MeetingTodoProposal,
  meeting: Meeting,
  ctx: { workspace_id: string; record_id: string },
): ClaimRequest {
  const state = SPEECH_STATE_ZH[todo.speech_state]
  return {
    kind: 'claim',
    title: displayLine(`会议待办：${todo.text}`, 60),
    summary:
      `${state}：「${displayLine(todo.provenance.quote, 80)}」${why(todo.speech_state_reasons)}。` +
      '认下来才会变成你的待办；不是你的可以转给别人或标"不是事"。',
    dedupe_key: claimDedupeKey(ctx.workspace_id, 'meeting', todo.provenance.quote),
    priority: 'queue',
    subject: { type: 'meeting', id: meeting.id },
    payload: {
      form: 'claim',
      claim_kind: 'action_item',
      source: 'meeting',
      source_id: meeting.id,
      text: todo.text,
      quote: todo.provenance.quote,
      ...(todo.provenance.speaker === undefined ? {} : { speaker: todo.provenance.speaker }),
      speech_state: todo.speech_state,
      speech_state_reasons: todo.speech_state_reasons,
      // 明确指派最可信，本人认下的次之，泛泛的建议最低
      route_confidence:
        todo.speech_state === 'assigned' ? 0.9 : todo.speech_state === 'confirmed' ? 0.75 : 0.4,
      ...(todo.due === undefined ? {} : { due: todo.due }),
      ...(meeting.matter_id === undefined ? {} : { matter_id: meeting.matter_id }),
      subject_ref: { type: 'meeting_record', id: ctx.record_id },
    },
  }
}

export interface MeetingKnowledgePayload {
  form: 'knowledge_update'
  source: 'meeting'
  candidate_key: string
  layer: MeetingKnowledgeCandidate['layer']
  question: string
  statement: string
  hold_reasons: string[]
  options: { id: string; label: string }[]
  provenance: {
    source: 'meeting'
    ref: string
    locator?: string
    quote: string
    at: string
  }
}

export type KnowledgeRequest = ApprovalRequest<'knowledge_update', MeetingKnowledgePayload>

/** 知识候选 → `knowledge_update`。会上原话永远只是原料，必须人审才进知识库（06 §2.6）。 */
export function knowledgeRequest(
  candidate: MeetingKnowledgeCandidate,
  meeting: Meeting,
  ctx: { workspace_id: string; at: string },
): KnowledgeRequest {
  return {
    kind: 'knowledge_update',
    title: displayLine(`会上说的口径：${candidate.question}`, 60),
    summary: `采纳后 AI 起草时会引用它。需要你确认（${candidate.hold_reasons.join('、')}）。`,
    dedupe_key: `${ctx.workspace_id}:knowledge_update:${candidate.id}`,
    priority: 'queue',
    subject: { type: 'fact_card', id: candidate.id },
    payload: {
      form: 'knowledge_update',
      source: 'meeting',
      candidate_key: candidate.id,
      layer: candidate.layer,
      question: candidate.question,
      statement: candidate.statement,
      hold_reasons: candidate.hold_reasons,
      options: [
        { id: 'as_said', label: '按会上说的采纳' },
        { id: 'not_knowledge', label: '这不是知识' },
      ],
      provenance: {
        source: 'meeting',
        ref: meeting.id,
        ...(candidate.provenance.at_ms === undefined
          ? {}
          : { locator: `${Math.round(candidate.provenance.at_ms / 1000)}s` }),
        quote: candidate.provenance.quote,
        at: ctx.at,
      },
    },
  }
}

export interface MeetingBoundaryPayload {
  form: 'policy_question'
  source: 'meeting'
  boundary_id: string
  question: string
  label: string
  options: { id: string; label: string }[]
  allows_custom: true
  context: string
  answer_heard: string
  quote: string
}

export type BoundaryRequest = ApprovalRequest<'policy_change', MeetingBoundaryPayload>

/**
 * 边界答案 → `policy_change`（问句形态，与 support-core 的 `policyQuestionRequest` 同形）。
 * 会上说了不等于定了：卡面把"会上听到的答案"作为**默认选项**摆出来，人点头才成策略。
 */
export function boundaryRequest(
  answer: MeetingBoundaryAnswer,
  meeting: Meeting,
  ctx: { workspace_id: string },
): BoundaryRequest {
  const boundary_id = `meeting_${fnv1a(answer.question)}`
  return {
    kind: 'policy_change',
    title: displayLine(answer.question, 40),
    summary: '会上有人给了答案。确认一下就沉淀成口径，以后 AI 起草直接按它说。',
    dedupe_key: `${ctx.workspace_id}:policy_change:${boundary_id}`,
    priority: 'queue',
    subject: { type: 'meeting', id: meeting.id },
    payload: {
      form: 'policy_question',
      source: 'meeting',
      boundary_id,
      question: answer.question,
      label: displayLine(answer.question, 40),
      options: [
        { id: 'as_said', label: displayLine(`按会上说的：${answer.answer}`, 60) },
        { id: 'not_a_policy', label: '这不是一条口径' },
      ],
      allows_custom: true,
      context: `会上被问到「${displayLine(answer.question, 60)}」，有人当场答了。`,
      answer_heard: answer.answer,
      quote: answer.provenance.quote,
    },
  }
}

export interface MeetingApprovalRequests {
  claims: ClaimRequest[]
  knowledge: KnowledgeRequest[]
  boundaries: BoundaryRequest[]
}

/** 一份产出 → 该发的全部审批项 payload。宿主拿去调 `ApprovalBus.create`。 */
export function approvalRequestsFor(
  outputs: MeetingOutputs,
  meeting: Meeting,
): MeetingApprovalRequests {
  const ctx = { workspace_id: meeting.workspace_id, record_id: outputs.record_id }
  return {
    claims: outputs.todos.map((t) => claimRequest(t, meeting, ctx)),
    knowledge: outputs.knowledge.map((k) =>
      knowledgeRequest(k, meeting, { workspace_id: meeting.workspace_id, at: outputs.produced_at }),
    ),
    boundaries: outputs.boundary_answers.map((b) =>
      boundaryRequest(b, meeting, { workspace_id: meeting.workspace_id }),
    ),
  }
}
