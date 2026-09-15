import { describe, expect, it } from 'vitest'
import {
  advanceCollaboration,
  advanceDeliverable,
  canAdvanceCollaboration,
  collaborationFunnel,
  FUNNEL_ORDER,
  StageTransitionError,
} from '../src/index.js'

describe('合作阶段机（48 §5.1 那条链）', () => {
  it('主线一步一步走得通', () => {
    let stage = advanceCollaboration('sourced', 'contacted')
    stage = advanceCollaboration(stage, 'replied')
    stage = advanceCollaboration(stage, 'negotiating')
    stage = advanceCollaboration(stage, 'agreed')
    stage = advanceCollaboration(stage, 'delivering')
    stage = advanceCollaboration(stage, 'delivered')
    expect(advanceCollaboration(stage, 'closed')).toBe('closed')
  })

  it('任何一态都能掉到"已谢绝"（对方随时可以说不）', () => {
    for (const from of ['sourced', 'contacted', 'replied', 'negotiating', 'agreed'] as const)
      expect(canAdvanceCollaboration(from, 'declined')).toBe(true)
  })

  it('非法跳转抛人话，不是 "invalid transition"', () => {
    try {
      advanceCollaboration('sourced', 'delivered')
      expect.unreachable('应该抛')
    } catch (e) {
      expect(e).toBeInstanceOf(StageTransitionError)
      const err = e as StageTransitionError
      expect(err.message).toContain('已找到')
      expect(err.message).toContain('已交付')
      expect(err.message).toContain('只能走到')
      // 机器看的那两格也在
      expect(err.from).toBe('sourced')
      expect(err.to).toBe('delivered')
    }
  })

  it('原地不动也是非法：账本上多一行"从已建联改成已建联"，读的人会以为出过事', () => {
    expect(() => advanceCollaboration('contacted', 'contacted')).toThrow(StageTransitionError)
  })

  it('结案是终态：要再合作一次得新建一条（否则归因永远算不清）', () => {
    expect(() => advanceCollaboration('closed', 'contacted')).toThrow(/已经结案/)
  })

  it('谢绝之后可以重新建联（半年后再问一次是常事）', () => {
    expect(advanceCollaboration('declined', 'contacted')).toBe('contacted')
  })
})

describe('交付物审核阶段机', () => {
  it('待审 → 三种结论都行；打回去改完回到待审', () => {
    expect(advanceDeliverable('pending', 'approved')).toBe('approved')
    expect(advanceDeliverable('pending', 'changes_requested')).toBe('changes_requested')
    expect(advanceDeliverable('changes_requested', 'pending')).toBe('pending')
  })

  it('批过了还能打回（发出去才发现描述区链接是错的）', () => {
    expect(advanceDeliverable('approved', 'changes_requested')).toBe('changes_requested')
  })

  it('拒收是终态', () => {
    expect(() => advanceDeliverable('rejected', 'pending')).toThrow(/已经拒收/)
  })
})

describe('建联漏斗', () => {
  it('空的格子也出：面板上漏斗的形状不能随数据变', () => {
    const f = collaborationFunnel([{ stage: 'sourced' }, { stage: 'sourced' }, { stage: 'agreed' }])
    expect(f.map((b) => b.stage)).toEqual([...FUNNEL_ORDER])
    expect(f.find((b) => b.stage === 'sourced')?.count).toBe(2)
    expect(f.find((b) => b.stage === 'replied')?.count).toBe(0)
    expect(f.every((b) => b.label.length > 0)).toBe(true)
  })
})
