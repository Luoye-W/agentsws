/**
 * WP215：分配建了 / 改了 / 撤了要喊一声——服务端拿它即时建 / 停"有人担这条职责才建"的定时。
 */
import { describe, expect, it } from 'vitest'
import { createRoleStore } from '../src/index.js'
import { aftersales, fixedClock, owner } from './helpers.js'

describe('WP215 onAssignmentChanged', () => {
  it('建、改、撤各喊一次；退订之后不再喊；订阅者抛错不拦写库', () => {
    const s = createRoleStore({ clock: fixedClock(), roles: [aftersales(), owner()] })
    const seen: string[] = []
    s.onAssignmentChanged?.(() => {
      throw new Error('订阅者坏了')
    })
    const off = s.onAssignmentChanged?.((a) => {
      seen.push(`${a.role_id}:${a.revoked_at === undefined ? 'live' : 'revoked'}`)
    })
    const a = s.assignments.create({
      person_id: 'p_li',
      workspace_id: 'ws_b',
      role_id: aftersales().id,
      granted_by: 'p_li',
    })
    s.assignments.update(a.id, { ranges: [] })
    s.assignments.revoke(a.id)
    expect(seen).toEqual([
      `${aftersales().id}:live`,
      `${aftersales().id}:live`,
      `${aftersales().id}:revoked`,
    ])
    off?.()
    s.assignments.create({
      person_id: 'p_li',
      workspace_id: 'ws_b',
      role_id: aftersales().id,
      granted_by: 'p_li',
    })
    expect(seen).toHaveLength(3)
  })
})
