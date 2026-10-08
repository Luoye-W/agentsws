import { describe, expect, it } from 'vitest'
import {
  hasApprovalFlow,
  positionOfRole,
  reconfirmReasonText,
  resolveScopeManager,
  type SupervisedPosition,
  scopeManagerReasonText,
} from '../src/index.js'

const B2B: SupervisedPosition = {
  id: 'b2b',
  name: { zh: 'B2B', en: 'B2B' },
  roles: [
    { role: 'b2b.sales', default: true },
    { role: 'common.member', default: false },
  ],
  supervisor_person_id: 'p_lin',
}
const MEMBER: SupervisedPosition = {
  id: 'member',
  roles: [{ role: 'common.member', default: true }],
}

describe('WP174 scope_manager 解析：岗位上级 → 老板', () => {
  it('岗位设了上级 → 落上级', () => {
    const r = resolveScopeManager({
      role_id: 'b2b.sales',
      proposer: 'p_he',
      owner: 'p_zhou',
      positions: [B2B],
    })
    expect(r).toEqual({
      person: 'p_lin',
      via: 'scope_manager',
      reason: 'supervisor',
      position_id: 'b2b',
    })
    expect(scopeManagerReasonText(r, { person: '林峰', position: 'B2B' })).toBe(
      '转给了「B2B」岗位的上级林峰',
    )
  })

  it('没设上级 / 上级是本人 / 上级已离开 / 职责不在岗位里 → 老板', () => {
    const base = { proposer: 'p_he', owner: 'p_zhou' }
    const none = resolveScopeManager({
      ...base,
      role_id: 'b2b.sales',
      positions: [{ id: B2B.id, roles: B2B.roles }],
    })
    expect(none).toMatchObject({ person: 'p_zhou', via: 'owner', reason: 'no_supervisor' })
    const self = resolveScopeManager({
      ...base,
      proposer: 'p_lin',
      role_id: 'b2b.sales',
      positions: [B2B],
    })
    expect(self).toMatchObject({ person: 'p_zhou', via: 'owner', reason: 'self' })
    const gone = resolveScopeManager({
      ...base,
      role_id: 'b2b.sales',
      positions: [B2B],
      isActive: (p) => p !== 'p_lin',
    })
    expect(gone).toMatchObject({ person: 'p_zhou', via: 'owner', reason: 'inactive' })
    const orphan = resolveScopeManager({ ...base, role_id: 'x.custom', positions: [B2B] })
    expect(orphan).toEqual({ person: 'p_zhou', via: 'owner', reason: 'no_position' })
    expect(scopeManagerReasonText(none, { person: '周岚', position: 'B2B' })).toBe(
      '「B2B」岗位没设上级，转给了老板周岚',
    )
    expect(scopeManagerReasonText(gone, {})).toBe('这个岗位的上级已经不在工作区，转给了老板')
  })

  it('一条职责挂在几个岗位里：先看本人在做的，再看默认勾上的那个', () => {
    expect(positionOfRole('common.member', [B2B, MEMBER])?.id).toBe('member')
    expect(positionOfRole('common.member', [MEMBER, B2B], ['b2b'])?.id).toBe('b2b')
    expect(positionOfRole('nope', [B2B, MEMBER])).toBeUndefined()
  })
})

describe('WP275 有没有审批流（docs/95 §5）', () => {
  it('只有 ③ 公司集体有；① ② 只有安全闸', () => {
    expect(hasApprovalFlow('company')).toBe(true)
    expect(hasApprovalFlow('peers')).toBe(false)
    expect(hasApprovalFlow('solo')).toBe(false)
  })

  it('① ② 落回本人：卡上不写那一句；超了上限的那句不提上级 / 老板', () => {
    expect(
      scopeManagerReasonText({ person: 'p_he', via: 'scope_manager', reason: 'own' }, {}),
    ).toBe('')
    expect(reconfirmReasonText('金额、毛利')).toBe('超了你设的上限（金额、毛利），要你再确认一次')
    expect(reconfirmReasonText()).toBe('超了你设的上限，要你再确认一次')
    for (const text of [reconfirmReasonText('金额'), reconfirmReasonText()])
      expect(text).not.toMatch(/上级|老板|主管|转给/)
  })
})
