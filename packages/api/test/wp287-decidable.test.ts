/**
 * WP287：发给他的卡他必须点得动；点不动的不进他的「要你处理」（`decidableBy`，与决定那一道同一把尺子）。
 */
import type { ApprovalItem } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { decidableBy } from '../src/routes/approvals.js'
import type { GatewayDeps } from '../src/types.js'

const item = (form?: string): ApprovalItem =>
  ({
    id: 'apr_1',
    kind: form === 'handoff' ? 'claim' : 'review',
    payload: form === undefined ? {} : { form },
    routing: { recipients: [{ person: 'per_1', via: 'explicit' }] },
  }) as unknown as ApprovalItem

const deps = (able: boolean, peers = false): GatewayDeps =>
  ({
    peerAccess: () => peers,
    roles: {
      can: (id: string) => able && id === 'asg_duty',
      listAssignments: () => [{ id: 'asg_member' }, { id: 'asg_duty' }],
    },
  }) as unknown as GatewayDeps

describe('WP287 decidableBy', () => {
  it('名下有一条分配能批 → 发给他的卡都点得动', () => {
    expect(decidableBy(deps(true), 'per_1', 'ws_1')(item())).toBe(true)
  })
  it('一条能批的都没有 → 只有关于他本人的卡（交给你）', () => {
    const can = decidableBy(deps(false), 'per_1', 'ws_1')
    expect(can(item())).toBe(false)
    expect(can(item('handoff'))).toBe(true)
  })
  it('② 同事互联一律点得动', () => {
    expect(decidableBy(deps(false, true), 'per_1', 'ws_1')(item())).toBe(true)
  })
})
