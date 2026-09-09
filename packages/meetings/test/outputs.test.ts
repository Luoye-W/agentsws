import type {
  Meeting,
  MeetingBoundaryAnswer,
  MeetingKnowledgeCandidate,
  MeetingOutputs,
  MeetingTodoProposal,
} from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  approvalRequestsFor,
  boundaryRequest,
  claimDedupeKey,
  claimRequest,
  fnv1a,
  knowledgeRequest,
} from '../src/outputs.js'
import { T0 } from './helpers.js'

const MEETING: Meeting = {
  id: 'mtg_1',
  schema_version: 1,
  workspace_id: 'ws_1',
  title: '周会',
  start: T0,
  end: T0,
  participants: [{ person_id: 'per_zhang', name: '张三' }],
  records: ['mrec_1'],
  sensitivity: 'internal',
  status: 'done',
  created_by: 'per_luo',
  created_at: T0,
  updated_at: T0,
  matter_id: 'mat_1',
}

const provenance = { record_id: 'mrec_1', quote: '让张三明天把周报发到群里。', speaker: '罗野' }

const OUTPUTS: MeetingOutputs = {
  meeting_id: 'mtg_1',
  record_id: 'mrec_1',
  decisions: [{ id: 'd1', text: '上线', provenance }],
  todos: [
    {
      id: 't1',
      text: '把周报发到群里',
      assignee_hint: '张三',
      assignee_person_id: 'per_zhang',
      speech_state: 'assigned',
      speech_state_reasons: [],
      due: '2026-09-10T09:00:00.000Z',
      provenance,
    },
    {
      id: 't2',
      text: '转账给供应商',
      assignee_hint: '张三',
      speech_state: 'suggested',
      speech_state_reasons: ['high_risk_action'],
      provenance,
    },
  ],
  boundary_answers: [{ id: 'b1', question: '退货窗口几天？', answer: '14 天', provenance }],
  knowledge: [
    {
      id: 'k1',
      layer: 'policy',
      question: '退货窗口',
      statement: '统一按 14 天算',
      hold_reasons: ['policy_sensitive', 'source_layer'],
      provenance: { ...provenance, at_ms: 12_000 },
    },
  ],
  processor: 'agentsws/default-meeting-assistant',
  produced_at: T0,
}

describe('产出 → 审批项 payload', () => {
  it('claim：source=meeting，带言语状态与原话，本人确认前不形成责任写在摘要里', () => {
    const req = claimRequest(OUTPUTS.todos[0] as MeetingTodoProposal, MEETING, {
      workspace_id: 'ws_1',
      record_id: 'mrec_1',
    })
    expect(req.kind).toBe('claim')
    expect(req.payload.source).toBe('meeting')
    expect(req.payload.claim_kind).toBe('action_item')
    expect(req.payload.speech_state).toBe('assigned')
    expect(req.payload.route_confidence).toBe(0.9)
    expect(req.payload.matter_id).toBe('mat_1')
    expect(req.payload.subject_ref).toEqual({ type: 'meeting_record', id: 'mrec_1' })
    expect(req.subject).toEqual({ type: 'meeting', id: 'mtg_1' })
    expect(req.summary).toContain('认下来才会变成你的待办')
    expect(req.payload.due).toBe('2026-09-10T09:00:00.000Z')
  })

  it('claim：降级过的待办把理由翻成人话，置信度也跟着降', () => {
    const req = claimRequest(OUTPUTS.todos[1] as MeetingTodoProposal, MEETING, {
      workspace_id: 'ws_1',
      record_id: 'mrec_1',
    })
    expect(req.payload.speech_state).toBe('suggested')
    expect(req.payload.route_confidence).toBe(0.4)
    expect(req.summary).toContain('涉及钱或价格')
  })

  it('claim：三种言语状态各有各的置信度；没有 matter_id 就不带', () => {
    const { matter_id: _drop, ...noMatter } = MEETING
    const confirmed = claimRequest(
      {
        ...(OUTPUTS.todos[0] as MeetingTodoProposal),
        speech_state: 'confirmed',
        speech_state_reasons: [],
      },
      noMatter as Meeting,
      { workspace_id: 'ws_1', record_id: 'mrec_1' },
    )
    expect(confirmed.payload.route_confidence).toBe(0.75)
    expect(confirmed.payload.matter_id).toBeUndefined()
  })

  it('claim 去重键 = (source, quote 哈希)：同一句话只问一次', () => {
    const a = claimDedupeKey('ws_1', 'meeting', '同一句话')
    expect(a).toBe(claimDedupeKey('ws_1', 'meeting', '同一句话'))
    expect(a).not.toBe(claimDedupeKey('ws_1', 'meeting', '另一句话'))
    expect(fnv1a('')).toMatch(/^[0-9a-f]{8}$/)
  })

  it('knowledge_update：带会议出处与时间点定位；hold 理由进摘要', () => {
    const req = knowledgeRequest(OUTPUTS.knowledge[0] as MeetingKnowledgeCandidate, MEETING, {
      workspace_id: 'ws_1',
      at: T0,
    })
    expect(req.payload.provenance).toMatchObject({
      source: 'meeting',
      ref: 'mtg_1',
      locator: '12s',
    })
    expect(req.summary).toContain('policy_sensitive')
    expect(req.payload.options.map((o) => o.id)).toEqual(['as_said', 'not_knowledge'])
  })

  it('knowledge_update：没有时间点就不带 locator', () => {
    const req = knowledgeRequest(
      { ...(OUTPUTS.knowledge[0] as MeetingKnowledgeCandidate), provenance },
      MEETING,
      { workspace_id: 'ws_1', at: T0 },
    )
    expect(req.payload.provenance.locator).toBeUndefined()
  })

  it('policy_change：会上听到的答案只是默认选项，人点头才成策略', () => {
    const req = boundaryRequest(OUTPUTS.boundary_answers[0] as MeetingBoundaryAnswer, MEETING, {
      workspace_id: 'ws_1',
    })
    expect(req.kind).toBe('policy_change')
    expect(req.payload.form).toBe('policy_question')
    expect(req.payload.answer_heard).toBe('14 天')
    expect(req.payload.allows_custom).toBe(true)
    expect(req.dedupe_key).toContain('policy_change')
  })

  it('一份产出 → 三类审批项 payload，条数对得上；决定不建审批项', () => {
    const reqs = approvalRequestsFor(OUTPUTS, MEETING)
    expect(reqs.claims).toHaveLength(2)
    expect(reqs.knowledge).toHaveLength(1)
    expect(reqs.boundaries).toHaveLength(1)
    expect(Object.keys(reqs)).not.toContain('decisions')
  })
})
