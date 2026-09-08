import type { Clock, FactCard, MemoryFactRecord, PermissionScope } from '@agentsws/contracts'
import { createKnowledge, type GrantedActor, type Knowledge } from '../src/index.js'

export const WS = 'ws_1'
export const T0 = '2026-09-09T09:00:00.000Z'

export interface TestClock extends Clock {
  set(iso: string): void
  advanceDays(days: number): void
}

export function testClock(start = T0): TestClock {
  let cur = start
  return {
    now: () => cur,
    set: (iso) => {
      cur = iso
    },
    advanceDays: (days) => {
      cur = new Date(Date.parse(cur) + days * 86_400_000).toISOString()
    },
  }
}

const read = (
  domain: PermissionScope['domain'],
  max_sensitivity: PermissionScope['max_sensitivity'],
  range: PermissionScope['range'] = 'workspace',
): PermissionScope => ({ domain, ops: ['read'], range, max_sensitivity })

/** 售后客服：没有 finance 域的任何 scope（19 §7 用例 1 的主角）。 */
export const aftersales = (workspace_id = WS): GrantedActor => ({
  person_id: 'per_aftersales',
  assignment_id: 'asg_aftersales',
  role_id: 'dtc.aftersales',
  workspace_id,
  grants: [
    read('customer', 'internal', 'assigned'),
    read('order', 'internal', 'assigned'),
    read('knowledge', 'internal'),
  ],
  ranges: [{ kind: 'store', id: 'shop_de' }],
})

/** 财务负责人：有 finance 域、可读到 confidential。 */
export const finance = (workspace_id = WS): GrantedActor => ({
  person_id: 'per_cfo',
  assignment_id: 'asg_cfo',
  role_id: 'common.finance',
  workspace_id,
  grants: [read('finance', 'confidential'), read('knowledge', 'confidential')],
  ranges: [{ kind: 'store', id: 'shop_de' }],
})

/** 工作区管理员：知识 / 策略 / 财务全域可读到 restricted。 */
export const admin = (workspace_id = WS): GrantedActor => ({
  person_id: 'per_owner',
  assignment_id: 'asg_owner',
  role_id: 'common.owner',
  workspace_id,
  grants: [
    read('knowledge', 'restricted'),
    read('policy', 'restricted'),
    read('finance', 'restricted'),
  ],
  ranges: [{ kind: 'store', id: 'shop_de' }],
})

export type ProposeInput = Omit<FactCard, 'id' | 'status' | 'usage' | 'created_at' | 'updated_at'>

export function cardInput(over: Partial<ProposeInput> = {}): ProposeInput {
  return {
    schema_version: 1,
    workspace_id: WS,
    layer: 'fact',
    domain: 'knowledge',
    scope: [{ kind: 'store', id: 'shop_de' }],
    sensitivity: 'internal',
    subject: { type: 'fact_card', key: 'policy.return_window.de' },
    statement: '德国站退货窗口 14 天',
    structured: { return_window_days: 14 },
    provenance: [{ source: 'document', ref: 'policy-de.md', locator: 'p2', at: T0 }],
    confidence: { value: 0.8, state: 'probable' },
    valid: {},
    owner: 'per_owner',
    created_by: { kind: 'agent', id: 'agent_1' },
    ...over,
  }
}

export function memoryFact(over: Partial<MemoryFactRecord> = {}): MemoryFactRecord {
  return {
    key: 'preferred_language',
    value: '德语',
    category: 'preference',
    subject: { type: 'customer', id: 'cus_1' },
    source_run_hash: 'a1b2c3d4e5f6',
    expires_at: '2027-01-01T00:00:00.000Z',
    workspace_id: WS,
    ...over,
  }
}

/** 建库 + 一张已激活的卡（大部分用例都要）。 */
export async function withKnowledge(clock: TestClock = testClock()): Promise<Knowledge> {
  return createKnowledge({ clock, workspace_id: WS })
}

export async function activated(k: Knowledge, input: ProposeInput): Promise<FactCard> {
  const card = await k.store.propose(input)
  return k.store.activate(card.id, card.owner)
}
