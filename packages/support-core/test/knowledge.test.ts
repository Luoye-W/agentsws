import { describe, expect, it } from 'vitest'
import type { CandidateInput } from '../src/index.js'
import {
  aiQuestionRequest,
  answerBoundary,
  boundaryDedupeKey,
  canAutoPropose,
  categorize,
  classifyText,
  findBoundary,
  isNoInfoAnswer,
  knowledgeCandidate,
  knowledgeCandidates,
  knowledgeUpdateRequest,
  MIN_CANDIDATE_CHARS,
  policyQuestionRequest,
  scanPolicySensitiveText,
  toFactCardDraft,
} from '../src/index.js'

const AT = '2026-09-07T01:00:00.000Z'

const base: CandidateInput = {
  text: '我们这边的做法是先请客户拍三张照片再判断，不需要客户先寄回。',
  source: 'human_reply',
  ref: 'thr_1',
  at: AT,
}

describe('空答案与政策敏感扫描', () => {
  it('空答案一律丢掉', () => {
    expect(isNoInfoAnswer(undefined)).toBe(true)
    expect(isNoInfoAnswer('   ')).toBe(true)
    expect(isNoInfoAnswer('The page does not provide this information.')).toBe(true)
    expect(isNoInfoAnswer('未提供相关说明')).toBe(true)
    expect(isNoInfoAnswer('Returns are accepted for two weeks.')).toBe(false)
  })

  it('政策敏感 + 承诺片段（同时扫原文与 NFKC 归一形）', () => {
    const plain = scanPolicySensitiveText('我们的政策是这样的')
    expect(plain.policy_sensitive).toBe(true)
    expect(plain.commitments).toEqual([])

    const commit = scanPolicySensitiveText('Refunds are issued within 14 days, free of charge.')
    expect(commit.policy_sensitive).toBe(true)
    expect(commit.commitments.length).toBeGreaterThan(0)

    const zh = scanPolicySensitiveText('退款一律 7 天内到账')
    expect(zh.commitments.length).toBeGreaterThan(0)

    const clean = scanPolicySensitiveText('客户很满意，谢谢')
    expect(clean.policy_sensitive).toBe(false)
    expect(clean.commitments).toEqual([])
  })

  it('主题分类：首条命中即返回', () => {
    expect(categorize('where is my package')).toBe('order_tracking')
    expect(categorize('customs delay')).toBe('order_tracking')
    expect(categorize('I want a refund')).toBe('returns_refunds')
    expect(categorize('warranty repair')).toBe('warranty')
    expect(categorize('how to use it')).toBe('product_question')
    expect(categorize('this is a complaint')).toBe('complaint')
    expect(categorize('nothing in particular here')).toBe('other')
  })
})

describe('知识候选', () => {
  it('太短的句子成不了知识', () => {
    expect(knowledgeCandidate({ ...base, text: 'ok' })).toBeUndefined()
    expect('ok'.length).toBeLessThan(MIN_CANDIDATE_CHARS)
    expect(knowledgeCandidate({ ...base, text: '这里未提供任何说明信息' })).toBeUndefined()
  })

  it('人工回复里的口径 → fact 层候选，可自动进', () => {
    const c = knowledgeCandidate(base)
    if (c === undefined) throw new Error('候选缺失')
    expect(c.layer).toBe('fact')
    expect(c.hold_reasons).toEqual([])
    expect(c.deidentified).toBe(true)
    expect(c.provenance.source).toBe('human')
    expect(canAutoPropose(c)).toBe(true)
    expect(canAutoPropose(c, 0.99)).toBe(false)
  })

  it('含承诺 → policy 层，必须人审', () => {
    const c = knowledgeCandidate({ ...base, text: '退款一律 7 天内到账，运费我们出。' })
    if (c === undefined) throw new Error('候选缺失')
    expect(c.layer).toBe('policy')
    expect(c.hold_reasons).toContain('policy_sensitive')
    expect(c.hold_reasons).toContain('contains_commitment')
    expect(canAutoPropose(c)).toBe(false)
  })

  it('未脱敏 / 来自客户对话 → 人审', () => {
    const pii = knowledgeCandidate({ ...base, text: '有问题写信到 support@example.invalid 就行' })
    expect(pii?.hold_reasons).toContain('not_deidentified')
    const fromCustomer = knowledgeCandidate({
      ...base,
      source: 'conversation',
      text: '客户说他更喜欢黑色的那一款包装',
    })
    expect(fromCustomer?.hold_reasons).toContain('source_layer')
    expect(fromCustomer?.provenance.source).toBe('email')
  })

  it('分类结果可以覆盖关键词分类；question 缺省用 statement', () => {
    const c = knowledgeCandidate({
      ...base,
      classification: classifyText({ text: 'this is a complaint about my order' }, { now: AT }),
      question: '缺件怎么处理？',
    })
    expect(c?.category).toBe('complaint')
    expect(c?.question).toBe('缺件怎么处理？')
    const noQuestion = knowledgeCandidate(base)
    expect(noQuestion?.question).toBe(noQuestion?.statement)
  })

  it('批量：按 key 去重，顺序稳定', () => {
    const list = knowledgeCandidates([
      base,
      base,
      { ...base, text: '另一条完全不同的内部口径说明。' },
    ])
    expect(list).toHaveLength(2)
    expect(new Set(list.map((c) => c.key)).size).toBe(2)
    expect(knowledgeCandidates([{ ...base, text: 'no' }])).toEqual([])
  })

  it('候选 → 19 §1.1 事实卡草稿', () => {
    const c = knowledgeCandidate(base)
    if (c === undefined) throw new Error('候选缺失')
    const draft = toFactCardDraft(c, {
      workspace_id: 'ws_test',
      owner: 'p_wang',
      scope: [{ kind: 'store', id: 'st_1' }],
      created_by_id: 'agent_aftersales',
    })
    expect(draft.layer).toBe('fact')
    expect(draft.domain).toBe('knowledge')
    expect(draft.confidence.state).toBe('unverified')
    expect(draft.provenance).toHaveLength(1)
    expect(draft.created_by).toEqual({ kind: 'agent', id: 'agent_aftersales' })
  })
})

describe('审批项 payload', () => {
  it('业务边界 → policy_change 问句形态卡，带选项与"只问一次"的去重键', () => {
    const boundary = findBoundary('policy.lost_package_liability')
    if (boundary === undefined) throw new Error('缺边界')
    const req = policyQuestionRequest(boundary, {
      workspace_id: 'ws_test',
      run_id: 'run_1',
      conversation_id: 'thr_1',
      intent: 'returns_refunds',
    })
    expect(req.kind).toBe('policy_change')
    expect(req.payload.form).toBe('policy_question')
    expect(req.payload.options.map((o) => o.id)).toEqual(boundary.options.map((o) => o.id))
    expect(req.payload.allows_custom).toBe(true)
    expect(req.dedupe_key).toBe(boundaryDedupeKey('ws_test', boundary.id))
    expect(req.title.length).toBeLessThanOrEqual(40)
    expect(req.payload.trigger).toEqual({
      run_id: 'run_1',
      conversation_id: 'thr_1',
      intent: 'returns_refunds',
    })
    const bare = policyQuestionRequest(boundary, { workspace_id: 'ws_test' })
    expect(bare.payload.trigger).toEqual({})
    // 答案沉淀回策略
    const policy = answerBoundary(
      boundary.id,
      { kind: 'option', option_id: 'carrier_first' },
      { by: 'p_wang', at: AT, approval_item_id: 'ai_1' },
    )
    expect(policy?.approval_item_id).toBe('ai_1')
  })

  it('知识候选 → knowledge_update，可带候选写法', () => {
    const c = knowledgeCandidate({ ...base, text: '退款一律 7 天内到账。' })
    if (c === undefined) throw new Error('候选缺失')
    const req = knowledgeUpdateRequest(c, { workspace_id: 'ws_test', alternatives: ['换个说法'] })
    expect(req.kind).toBe('knowledge_update')
    expect(req.payload.options.map((o) => o.id)).toEqual(['as_proposed', 'alt_1'])
    expect(req.summary).toContain('需要你确认')
    expect(req.subject).toEqual({ type: 'fact_card', id: c.key })

    const clean = knowledgeCandidate(base)
    if (clean === undefined) throw new Error('候选缺失')
    const req2 = knowledgeUpdateRequest(clean, {
      workspace_id: 'ws_test',
      subject: { type: 'thread', id: 'thr_1' },
    })
    expect(req2.summary).toContain('可以直接进知识库')
    expect(req2.payload.options).toHaveLength(1)
    expect(req2.subject).toEqual({ type: 'thread', id: 'thr_1' })
  })

  it('缺资料 → ai_question 选择题；不认识的 need 不编问题', () => {
    for (const need of ['order_ref', 'photos', 'tracking_number']) {
      const req = aiQuestionRequest(need, { workspace_id: 'ws_test', conversation_id: 'thr_1' })
      expect(req?.payload.form).toBe('ai_question')
      expect(req?.payload.options.length).toBeGreaterThanOrEqual(3)
      expect(req?.dedupe_key).toBe(`ws_test:ai_question:${need}:thr_1`)
    }
    expect(aiQuestionRequest('nonsense', { workspace_id: 'ws_test' })).toBeUndefined()
    const noThread = aiQuestionRequest('photos', {
      workspace_id: 'ws_test',
      highlights: [{ type: 'order_ref', text: '#4101' }],
    })
    expect(noThread?.dedupe_key).toBe('ws_test:ai_question:photos:workspace')
    expect(noThread?.payload.highlights).toEqual([{ type: 'order_ref', text: '#4101' }])
  })
})
