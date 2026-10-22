/**
 * WP441（docs/108 §5.1.2）：消息规则的两种卡。
 *
 * 1. **「要建这条规则吗」**——复用 `policy_change`（「定规矩」家族，与记录去处同一种卡）：卡面一行白话、
 *    试跑（过去 30 天会命中几封、前 5 封、**会被改掉去向的那几封**）、用工坊积分时会花多少；按钮「建 / 不要」，
 *    一个勾「也处理过去 30 天的」默认不勾（勾了点「建」= 选项 `after_past`）。建规则 = 拍板，永远 L1。
 * 2. **规则起草的回信**——`outbound_draft`（`payload.form = message_rule_draft`）：按来信语言、接口吻；
 *    批了才从收信那只邮箱回（`messages.deliverRuleDraft`），出站门照旧。规则自己永远不发信。
 */
import type {
  ApprovalItem,
  CreateApprovalInput,
  MessageRuleDraft,
  MessageRuleTrial,
} from '@agentsws/contracts'
import { MESSAGE_RULE_FORM, MESSAGE_RULE_SUBJECT_PREFIX } from '@agentsws/contracts'

/** 规则起草的回信卡上 `payload.form` 的记号。 */
export const MESSAGE_RULE_DRAFT_FORM = 'message_rule_draft'

/** 出「要建这条规则吗」卡要的那一份。 */
export interface MessageRuleCardRequest {
  workspace_id: string
  actor: { person_id: string; assignment_id?: string; role_id?: string; matter_id?: string }
  draft: MessageRuleDraft
  /** 一行白话。 */
  plain: string
  trial: MessageRuleTrial
  /** 改哪一条（「在对话里改」）；不给 = 新建。 */
  rule_id?: string
  revision?: number
  /** 共用模式里批的人（不给 = 提的人自己）。 */
  approver?: string
  seq: string
}

export function messageRuleCardInput(
  input: MessageRuleCardRequest,
): CreateApprovalInput<Record<string, unknown>> {
  const { actor, draft, trial } = input
  const editing = input.rule_id !== undefined
  const title = editing ? `改这条规则吗：${draft.name}` : `要建这条规则吗：${draft.name}`
  const summary = [
    input.plain,
    `过去 30 天会命中 ${trial.matched} 封${trial.changed.length > 0 ? `，其中 ${trial.changed.length} 封会改掉去向` : ''}。`,
  ].join(' ')
  return {
    workspace_id: input.workspace_id,
    schema_version: 1,
    kind: 'policy_change',
    role_id: (actor.role_id ?? 'common.owner') as never,
    proposer:
      actor.assignment_id === undefined
        ? { kind: 'person', id: actor.person_id }
        : { kind: 'agent', id: actor.assignment_id, assignment_id: actor.assignment_id as never },
    // 建规则 = 拍板：永远 L1，工具 / 输入框本身不让任何规则生效
    automation: { level_at_creation: 'L1' },
    routing: {
      recipients: [{ person: (input.approver ?? actor.person_id) as never, via: 'owner' }],
      rule: 'owner',
      escalation: { after_hours: 48, business_hours: true, chain: ['owner'], escalated_at: [] },
      separation_of_duties: false,
    },
    priority: 'queue',
    subject: {
      object: { type: 'policy', id: `${MESSAGE_RULE_SUBJECT_PREFIX}${input.rule_id ?? 'new'}` },
      ...(actor.matter_id === undefined ? {} : { matter_id: actor.matter_id as never }),
    },
    dedupe_key: `${input.workspace_id}:policy_change:message_rule:${input.seq}`,
    title,
    summary,
    payload: {
      form: MESSAGE_RULE_FORM,
      draft,
      plain: input.plain,
      trial,
      ...(input.rule_id === undefined ? {} : { rule_id: input.rule_id }),
      ...(input.revision === undefined ? {} : { revision: input.revision }),
      // 「也处理过去 30 天的」是卡身里的一个勾（默认不勾）：勾了点「建」= 选 `after_past`
      options: [
        { id: 'after', label: '建' },
        { id: 'after_past', label: '建，也处理过去 30 天的' },
        { id: 'before', label: '不要' },
      ],
      target: 'workspace_policy',
      before: null,
      after: { name: draft.name },
    },
    evidence: {
      source_events: [],
      provenance: {
        seen: [{ type: 'policy', id: `${MESSAGE_RULE_SUBJECT_PREFIX}${input.rule_id ?? 'new'}` }],
      },
      precheck: { permission_diff: 'ok', semantic_diff: 'ok' },
    },
  } as CreateApprovalInput<Record<string, unknown>>
}

export const isMessageRuleCard = (item: Pick<ApprovalItem, 'kind' | 'payload'>): boolean =>
  item.kind === 'policy_change' &&
  typeof item.payload === 'object' &&
  item.payload !== null &&
  (item.payload as Record<string, unknown>).form === MESSAGE_RULE_FORM

/** 出规则起草的回信卡要的那一份。 */
export interface MessageRuleDraftCardRequest {
  workspace_id: string
  /** 卡给谁（对口岗位的人；没有就是写规则的人 / 品牌负责人）。 */
  to: { person_id: string; assignment_id?: string; role_id: string }
  message_id: string
  thread_id: string
  account: string
  from: { email: string; name?: string }
  subject: string
  text: string
  rule: { id: string; name: string }
  seq: string
}

export function messageRuleDraftCardInput(
  input: MessageRuleDraftCardRequest,
): CreateApprovalInput<Record<string, unknown>> {
  const contact = { type: 'contact' as const, id: input.from.email }
  const thread = { type: 'thread' as const, id: input.thread_id }
  const who = input.from.name ?? input.from.email
  const subject = /^re:/i.test(input.subject) ? input.subject : `Re: ${input.subject}`
  return {
    workspace_id: input.workspace_id,
    schema_version: 1,
    kind: 'outbound_draft',
    role_id: input.to.role_id as never,
    subject: { object: thread },
    dedupe_key: `${input.workspace_id}:message_rule_draft:${input.message_id}:${input.rule.id}`,
    title: `回复 ${who}：${input.subject}`,
    summary: `按规则「${input.rule.name}」起草的，批了才发。`,
    payload: {
      form: MESSAGE_RULE_DRAFT_FORM,
      channel: 'email',
      to: contact,
      body: { subject, text: input.text },
      thread_ref: input.thread_id,
      message_id: input.message_id,
      account: input.account,
      rule: input.rule,
    },
    evidence: {
      source_events: [],
      provenance: { seen: [thread, contact] },
      precheck: {},
    },
    proposer:
      input.to.assignment_id === undefined
        ? { kind: 'person', id: input.to.person_id }
        : {
            kind: 'agent',
            id: input.to.assignment_id,
            assignment_id: input.to.assignment_id as never,
          },
    // 规则起草的回信一律要人批（规则里没有直接发）
    automation: {
      level_at_creation: 'L1',
      auto_approved: false,
      mandate_check: { within: true, caps_hit: [] },
      sampling: { selected: false },
    },
    routing: {
      recipients: [{ person: input.to.person_id as never, via: 'role_holder' }],
      rule: 'role_holder',
      escalation: { after_hours: 24, business_hours: true, chain: ['owner'], escalated_at: [] },
      separation_of_duties: false,
    },
    priority: 'queue',
    context: {
      thread_participants: [contact.id],
      verified_contacts: [contact.id],
    },
  } as CreateApprovalInput<Record<string, unknown>>
}

export const isMessageRuleDraftCard = (item: Pick<ApprovalItem, 'kind' | 'payload'>): boolean =>
  item.kind === 'outbound_draft' &&
  typeof item.payload === 'object' &&
  item.payload !== null &&
  (item.payload as Record<string, unknown>).form === MESSAGE_RULE_DRAFT_FORM
