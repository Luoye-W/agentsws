/** WP510（决策 1515）：处理留名（`decided_by` 只在宿主给了名字时出）、「给我的 / 全部」。 */
import { describe, expect, it } from 'vitest'
import { handledAction, type InboxItem, projectCard, scopeInbox } from '../src/index.js'
import { item, NOW } from './fixtures.js'

const decided = item({
  state: 'approved',
  decision: { action: 'approve', by: 'per_lin', at: NOW, via: 'workstation' },
})

describe('处理留名', () => {
  it('宿主给了名字（② / ③）才写；看的人自己定的、AI 自动批的、① 里都不写', () => {
    const names = (id: string): string | undefined => (id === 'per_lin' ? '林峰' : undefined)
    expect(
      projectCard(decided, { now: NOW, position_id: 'asg_1', personName: names }).decided_by,
    ).toEqual({
      person_id: 'per_lin',
      name: '林峰',
    })
    expect('decided_by' in projectCard(decided, { now: NOW, position_id: 'asg_1' })).toBe(false)
    const self = item({
      state: 'approved',
      decision: { action: 'approve', by: 'per_me', at: NOW, via: 'workstation' },
    })
    expect(
      projectCard(self, { now: NOW, position_id: 'asg_1', personName: names }).decided_by,
    ).toBeUndefined()
    const auto = item({
      state: 'approved',
      decision: { action: 'approve', by: 'mandate', at: NOW, via: 'api' },
    })
    expect(
      projectCard(auto, { now: NOW, position_id: 'asg_1', personName: names }).decided_by,
    ).toBeUndefined()
  })

  it('决定 → 「刚处理」里那个动词', () => {
    expect(handledAction('approve_edited')).toBe('approve')
    expect(handledAction('reject')).toBe('reject')
    expect(handledAction('defer')).toBe('defer')
    expect(handledAction('redirect')).toBe('other')
  })
})

describe('给我的 / 全部', () => {
  it('「给我的」去掉 mine=false 的；没有团队那一面的行（mine 不在）照旧都在', () => {
    const rows = [{ id: 'a', mine: true }, { id: 'b', mine: false }, { id: 'c' }] as InboxItem[]
    expect(scopeInbox(rows, 'mine').map((i) => i.id)).toEqual(['a', 'c'])
    expect(scopeInbox(rows, 'all').map((i) => i.id)).toEqual(['a', 'b', 'c'])
  })
})
