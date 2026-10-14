/**
 * WP323：记录去处的「定规矩」卡（docs/96 §4.1「定规矩」家族：记下 / 不用）。
 *
 * 复用 `policy_change`（不新造卡种）：批了施行的是「这个去处生效 / 换成新对照」，由 `log.onDecided` 做。
 * 卡面只放：标题（去处名字）+ 一行预览（列 → 值）+ 一句之后怎样。去处的种类不上卡。
 */
import type { CreateApprovalInput } from '@agentsws/contracts'
import { RECORD_SINK_FORM, RECORD_SINK_SUBJECT_PREFIX } from '@agentsws/contracts'
import type { SinkCardInput } from './log.js'

const FILTER_ZH: Readonly<Record<string, string>> = {
  reddit: 'Reddit',
  email: '邮件',
  reply: '回复',
  post: '发帖',
  comment: '评论',
}

/** 「只记哪些」说成人话（空 = 不说）。 */
export function filterLabel(input: SinkCardInput): string | undefined {
  const f = input.revision ? (input.sink.draft?.filter ?? input.sink.filter) : input.sink.filter
  const parts = [...(f.channels ?? []), ...(f.actions ?? []), ...(f.kinds ?? [])]
  return parts.length === 0 ? undefined : `只记：${parts.map((p) => FILTER_ZH[p] ?? p).join('、')}`
}

export function recordSinkCardInput(
  input: SinkCardInput,
  opts: { approver?: string; seq: string },
): CreateApprovalInput<Record<string, unknown>> {
  const { sink, actor } = input
  const name = input.revision ? (sink.draft?.name ?? sink.name) : sink.name
  const title =
    input.reason === 'columns_changed'
      ? `「${name}」的列变了，照新表头记？`
      : input.revision
        ? `改记录规矩：${name}`
        : `记录去处：${name}`
  const filter = filterLabel(input)
  const summary = [
    '之后每发出去一条，照这样记一行。',
    filter,
    input.sample ? '预览是示例。' : undefined,
  ]
    .filter(Boolean)
    .join(' ')
  return {
    workspace_id: input.workspace_id,
    schema_version: 1,
    kind: 'policy_change',
    role_id: (actor.role_id ?? 'common.owner') as never,
    proposer:
      actor.assignment_id === undefined
        ? { kind: 'person', id: actor.person_id }
        : { kind: 'agent', id: actor.assignment_id, assignment_id: actor.assignment_id as never },
    // 定规矩永远 L1：工具本身不让任何去处生效，人点了才算
    automation: { level_at_creation: 'L1' },
    routing: {
      recipients: [{ person: (opts.approver ?? actor.person_id) as never, via: 'owner' }],
      rule: 'owner',
      escalation: { after_hours: 48, business_hours: true, chain: ['owner'], escalated_at: [] },
      separation_of_duties: false,
    },
    priority: 'queue',
    subject: {
      object: { type: 'policy', id: `${RECORD_SINK_SUBJECT_PREFIX}${sink.id}` },
      ...(actor.matter_id === undefined ? {} : { matter_id: actor.matter_id as never }),
    },
    dedupe_key: `${input.workspace_id}:policy_change:record_sink:${sink.id}:${opts.seq}`,
    title,
    summary,
    payload: {
      form: RECORD_SINK_FORM,
      sink_id: sink.id,
      name,
      options: [
        { id: 'after', label: '记下' },
        { id: 'before', label: '不用' },
      ],
      target: 'workspace_policy',
      before: null,
      after: { name },
      preview: input.preview,
      sample: input.sample,
      ...(filter === undefined ? {} : { filter_label: filter }),
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    },
    evidence: {
      source_events: [],
      provenance: { seen: [{ type: 'record_sink', id: sink.id }] },
      precheck: { permission_diff: 'ok', semantic_diff: 'ok' },
    },
  } as CreateApprovalInput<Record<string, unknown>>
}
