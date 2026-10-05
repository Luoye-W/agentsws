/**
 * WP237：「这件事该走哪条职责」卡（`claim` 类、`form: 'route_choice'`）是选择题，不是转交卡。
 *
 * Fable 10-06 真机：WP237 之前出的这张卡把选项放在卡本身（`item.options`），投影只读载荷里的，
 * 于是卡上是「认领 / 不是客户问题」、点了也不带选项。老卡也要按候选职责出选项。
 */
import { describe, expect, it } from 'vitest'
import { isRouteChoiceItem, projectCard, resolveDecision } from '../src/index.js'
import { item, NOW } from './fixtures.js'

const ctx = { now: NOW, position_id: 'asg_1' }

const legacy = () =>
  item({
    kind: 'claim',
    payload: {
      form: 'route_choice',
      matter_id: 'mat_1',
      candidates: [
        { role_id: 'social.reddit', role_name: 'Reddit 运营', score: 0.51, why: [] },
        { role_id: 'pr.reddit', role_name: 'Reddit 营销', score: 0.49, why: [] },
      ],
    },
    options: [
      { id: 'social.reddit', label: 'Reddit 运营' },
      { id: 'pr.reddit', label: 'Reddit 营销' },
    ],
  })

describe('WP237 走哪条职责的卡', () => {
  it('老卡（选项在卡本身）：选择题排版，按钮是「走 X」', () => {
    const card = projectCard(legacy(), ctx)
    expect(isRouteChoiceItem(legacy())).toBe(true)
    expect(card.layout).toBe('choice')
    expect(card.options).toEqual([
      { id: 'social.reddit', label: '走「Reddit 运营」' },
      { id: 'pr.reddit', label: '走「Reddit 营销」' },
    ])
  })

  it('新卡（选项在载荷里，已经写成「走 X」）不重复加字', () => {
    const fresh = item({
      kind: 'claim',
      payload: {
        form: 'route_choice',
        options: [{ id: 'pr.reddit', label: '走「Reddit 营销」' }],
      },
    })
    expect(projectCard(fresh, ctx).options).toEqual([
      { id: 'pr.reddit', label: '走「Reddit 营销」' },
    ])
  })

  it('选了一条 = 带着选项批（approve_edited），不选不让批', () => {
    const card = projectCard(legacy(), ctx)
    expect(
      resolveDecision(card, { action: 'approve', selected_option_id: 'pr.reddit' }, { now: NOW }),
    ).toMatchObject({
      action: 'approve_edited',
      edited_payload: { selected_option_id: 'pr.reddit' },
    })
    expect(() => resolveDecision(card, { action: 'approve' }, { now: NOW })).toThrow()
  })

  it('普通认领卡（会议里的 form: claim）不受影响', () => {
    const claim = item({ kind: 'claim', payload: { form: 'claim', text: '跟进报价' } })
    const card = projectCard(claim, ctx)
    expect(isRouteChoiceItem(claim)).toBe(false)
    expect(card.layout).toBe('handoff')
    expect(card.options).toBeUndefined()
  })
})
