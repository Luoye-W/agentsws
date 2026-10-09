/**
 * WP284（决策 275）：「以后都这样」落成职责规矩——纯的那一半。
 * 出卡形状、认卡（老卡也认）、批了取哪一句、进提示词那一节、规矩簿按来源卡去重。
 */
import type { ApprovalItem } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  approvedRuleText,
  createRoleRuleBook,
  instructionRuleCard,
  isInstructionRuleCard,
  ROLE_RULES_ORDER,
  roleRulesSection,
  ruleFromCard,
} from '../src/role-rules.js'

const AT = '2026-10-09T02:00:00.000Z'

function policyCard(over: Partial<ApprovalItem> = {}): ApprovalItem {
  const input = instructionRuleCard({
    workspace_id: 'ws_1',
    person_id: 'per_wang',
    assignment_id: 'asg_1',
    item: {
      id: 'apr_src',
      role_id: 'dtc.support',
      title: '回复 Anna 的退款',
      subject: { object: { type: 'thread', id: 'thr_1' }, matter_id: 'mat_1' },
    },
    text: '退款超过 50 美元先问我',
  })
  return {
    ...input,
    id: 'apr_rule',
    revision: 1,
    state: 'approved_edited',
    deliveries: [],
    links: { children: [], parent: 'apr_src' },
    automation: {
      level_at_creation: 'L1',
      auto_approved: false,
      mandate_check: { within: true, caps_hit: [] },
      sampling: { selected: false },
    },
    created_at: AT,
    updated_at: AT,
    decision: {
      by: 'per_wang',
      at: AT,
      action: 'approve_edited',
      via: 'workstation',
      edited_payload: { ...input.payload, selected_option_id: 'after' },
    },
    ...over,
  } as ApprovalItem
}

describe('WP284 「以后都这样」那张策略卡', () => {
  it('出卡形状与之前一样（对象、去重键、收件人是本人），多带来源卡标题', () => {
    const card = policyCard()
    expect(card.kind).toBe('policy_change')
    expect(card.subject.object).toEqual({ type: 'policy', id: 'instruction_apr_src' })
    expect(card.subject.matter_id).toBe('mat_1')
    expect(card.dedupe_key).toBe('ws_1:policy_change:instruction:apr_src')
    expect(card.routing.recipients).toEqual([{ person: 'per_wang', via: 'owner' }])
    expect(card.payload).toMatchObject({
      target: 'workspace_policy',
      after: { rule: '退款超过 50 美元先问我' },
      source_card_id: 'apr_src',
      source_title: '回复 Anna 的退款',
    })
    expect(isInstructionRuleCard(card)).toBe(true)
  })

  it('只认这种卡：别的策略卡（开公司通知、边界问题）不算', () => {
    expect(
      isInstructionRuleCard(policyCard({ subject: { object: { type: 'policy', id: 'bnd_x' } } })),
    ).toBe(false)
    expect(isInstructionRuleCard(policyCard({ payload: { form: 'company_notice' } }))).toBe(false)
  })

  it('批了「按提议改」才有那一句；维持现状 / 没批 / 系统自动的都没有；人改过就用改过的', () => {
    expect(approvedRuleText(policyCard())).toBe('退款超过 50 美元先问我')
    const kept = policyCard()
    kept.decision = {
      ...(kept.decision as NonNullable<ApprovalItem['decision']>),
      edited_payload: { selected_option_id: 'before' },
    }
    expect(approvedRuleText(kept)).toBeUndefined()
    expect(approvedRuleText(policyCard({ state: 'pending' }))).toBeUndefined()
    const edited = policyCard()
    edited.decision = {
      ...(edited.decision as NonNullable<ApprovalItem['decision']>),
      edited_payload: { selected_option_id: 'after', after: { rule: '退款都先问我' } },
    }
    expect(approvedRuleText(edited)).toBe('退款都先问我')
    const auto = policyCard()
    auto.decision = { ...(auto.decision as NonNullable<ApprovalItem['decision']>), by: 'mandate' }
    expect(ruleFromCard(auto, 'rr_1', AT)).toBeUndefined()
  })

  it('批了的卡 → 一条规矩：定的人、提的人、来源卡、挂的事项', () => {
    expect(ruleFromCard(policyCard(), 'rr_1', AT)).toEqual({
      id: 'rr_1',
      workspace_id: 'ws_1',
      role_id: 'dtc.support',
      text: '退款超过 50 美元先问我',
      by: 'per_wang',
      proposed_by: 'per_wang',
      source_card_id: 'apr_rule',
      source_title: '回复 Anna 的退款',
      matter_id: 'mat_1',
      created_at: AT,
    })
  })
})

describe('WP284 规矩簿与进提示词那一节', () => {
  it('一条都没有就不出；有就一句一行，排在职责角色定位后面', () => {
    expect(roleRulesSection([])).toBeUndefined()
    const s = roleRulesSection([{ text: '退款先问我' }, { text: ' 别提补偿 ' }])
    expect(s?.order).toBe(ROLE_RULES_ORDER)
    expect(s?.order).toBeGreaterThan(20)
    expect(s?.order).toBeLessThan(22)
    expect(s?.text.split('\n').slice(1)).toEqual(['- 退款先问我', '- 别提补偿'])
  })

  it('按品牌 + 职责分；同一张来源卡只落一次；删了就不进提示词', () => {
    const book = createRoleRuleBook()
    const rule = ruleFromCard(policyCard(), 'rr_1', AT)
    if (rule === undefined) throw new Error('该有一条')
    expect(book.add(rule).added).toBe(true)
    expect(book.add({ ...rule, id: 'rr_2' }).added).toBe(false)
    book.add({ ...rule, id: 'rr_3', source_card_id: 'apr_b', workspace_id: 'ws_2' })
    expect(book.list('ws_1', 'dtc.support').map((r) => r.id)).toEqual(['rr_1'])
    expect(book.list('ws_1', 'b2b.sales')).toEqual([])
    expect(book.section('ws_1', 'dtc.support')?.text).toContain('退款超过 50 美元先问我')
    book.remove('rr_1')
    expect(book.section('ws_1', 'dtc.support')).toBeUndefined()
  })
})
