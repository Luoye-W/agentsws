import type { WorkspacePolicy } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { createRoleStore, RoleError, riskClassOf } from '../src/index.js'
import { aftersales, fixedClock, owner } from './helpers.js'

const CONNECTED = ['email', 'shopify']

function store() {
  const clock = fixedClock()
  const s = createRoleStore({ clock, roles: [aftersales(), owner()] })
  return { s, clock }
}

const policy = (max: number): WorkspacePolicy => ({
  workspace_id: 'ws_1',
  mandates: { stage_refund: { caps: { max_auto_refund_amount: max } } },
  global_caps: {},
})

describe('effectiveConfig 额度解析 (05 §3)', () => {
  it('policy 80 overrides role 50; assignment 200 is ignored; assignment 30 wins', () => {
    const { s } = store()
    s.policies.set(policy(80))
    const base = s.assignments.create({
      person_id: 'p_cs',
      workspace_id: 'ws_1',
      role_id: 'dtc.aftersales',
      ranges: [{ kind: 'store', id: 'shop_a' }],
      granted_by: 'p_owner',
    })
    const capOf = (id: string) =>
      s.effectiveConfig(id, { connected: CONNECTED }).actions.find((a) => a.id === 'stage_refund')
        ?.mandate.caps.max_auto_refund_amount

    expect(capOf(base.id)).toBe(80)

    const looser = s.assignments.create({
      person_id: 'p_cs2',
      workspace_id: 'ws_1',
      role_id: 'dtc.aftersales',
      ranges: [{ kind: 'store', id: 'shop_a' }],
      granted_by: 'p_owner',
      mandate_overrides: { caps: { max_auto_refund_amount: 200 } },
    })
    expect(capOf(looser.id)).toBe(80)

    const tighter = s.assignments.create({
      person_id: 'p_cs3',
      workspace_id: 'ws_1',
      role_id: 'dtc.aftersales',
      ranges: [{ kind: 'store', id: 'shop_a' }],
      granted_by: 'p_owner',
      mandate_overrides: { caps: { max_auto_refund_amount: 30 } },
    })
    expect(capOf(tighter.id)).toBe(30)
  })

  it('falls back to the role default when the workspace has no policy', () => {
    const { s } = store()
    const a = s.assignments.create({
      person_id: 'p_cs',
      workspace_id: 'ws_1',
      role_id: 'dtc.aftersales',
      ranges: [{ kind: 'store', id: 'shop_a' }],
      granted_by: 'p_owner',
    })
    const cfg = s.effectiveConfig(a.id, { connected: CONNECTED })
    expect(cfg.actions.find((x) => x.id === 'stage_refund')?.mandate.caps).toMatchObject({
      max_auto_refund_amount: 50,
      currency: 'USD',
    })
  })
})

describe('effectiveConfig 不并集 (05 §4 / 31 §3.1)', () => {
  it('two assignments of one person keep their own scopes', () => {
    const { s } = store()
    const cs = s.assignments.create({
      person_id: 'p_boss',
      workspace_id: 'ws_1',
      role_id: 'dtc.aftersales',
      ranges: [{ kind: 'store', id: 'shop_a' }],
      granted_by: 'p_boss',
    })
    const own = s.assignments.create({
      person_id: 'p_boss',
      workspace_id: 'ws_1',
      role_id: 'common.owner',
      granted_by: 'p_boss',
    })
    expect(s.assignments.listByPerson('p_boss')).toHaveLength(2)

    const csCfg = s.effectiveConfig(cs.id, { connected: CONNECTED })
    const ownCfg = s.effectiveConfig(own.id)
    expect(csCfg.scopes.map((x) => x.domain).sort()).toEqual([
      'approval',
      'customer',
      'discount',
      'knowledge',
      'order',
      'shipment',
    ])
    expect(ownCfg.scopes.map((x) => x.domain)).not.toContain('order')
    expect(ownCfg.scopes.find((x) => x.domain === 'policy')?.max_sensitivity).toBe('restricted')
    // 售后的 assignment 拿不到 owner 的 restricted 读权限
    expect(csCfg.scopes.every((x) => x.max_sensitivity === 'internal')).toBe(true)
    expect(csCfg.assignment_id).not.toBe(ownCfg.assignment_id)
  })

  it('marks unassigned_range when ranges are empty but the role needs them', () => {
    const { s } = store()
    const a = s.assignments.create({
      person_id: 'p_cs',
      workspace_id: 'ws_1',
      role_id: 'dtc.aftersales',
      granted_by: 'p_owner',
    })
    const cfg = s.effectiveConfig(a.id, { connected: CONNECTED })
    expect(cfg.unassigned_range).toBe(true)
    expect(cfg.ranges).toEqual([])
    expect(s.can(a.id, 'order', 'read', { range: 'assigned', sensitivity: 'internal' })).toBe(false)

    // 不需要 assigned 范围的职责（common.owner 全是 workspace 范围）不算未分配
    const own = s.assignments.create({
      person_id: 'p_cs',
      workspace_id: 'ws_1',
      role_id: 'common.owner',
      granted_by: 'p_owner',
    })
    expect(s.effectiveConfig(own.id).unassigned_range).toBe(false)
  })

  it('reports readiness from the required connectors the caller has connected', () => {
    const { s } = store()
    const a = s.assignments.create({
      person_id: 'p_cs',
      workspace_id: 'ws_1',
      role_id: 'dtc.aftersales',
      ranges: [{ kind: 'store', id: 'shop_a' }],
      granted_by: 'p_owner',
    })
    expect(s.effectiveConfig(a.id, { connected: CONNECTED }).ready).toBe(true)
    const partial = s.effectiveConfig(a.id, { connected: ['email'] })
    expect(partial.ready).toBe(false)
    expect(partial.missing_connectors).toEqual(['shopify'])
    // 可选连接器缺失不影响就绪
    expect(partial.missing_connectors).not.toContain('tracking')
  })

  it('carries grounding, skills and home blocks straight through', () => {
    const { s } = store()
    const a = s.assignments.create({
      person_id: 'p_cs',
      workspace_id: 'ws_1',
      role_id: 'dtc.aftersales',
      ranges: [{ kind: 'store', id: 'shop_a' }],
      granted_by: 'p_owner',
    })
    const cfg = s.effectiveConfig(a.id, { connected: CONNECTED })
    expect(cfg.grounding.map((g) => g.name)).toEqual(['order_status', 'policy'])
    expect(cfg.skills.map((x) => x.name)).toEqual([
      'customer-care',
      'returns-policy-calc',
      'chargeback-evidence',
    ])
    expect(cfg.home_blocks.map((b) => b.placement)).toEqual(['queue', 'queue', 'focus', 'alert'])
    expect(cfg.persona).toBeUndefined()
  })

  it('is refused for a revoked assignment (05 §3)', () => {
    const { s } = store()
    const a = s.assignments.create({
      person_id: 'p_cs',
      workspace_id: 'ws_1',
      role_id: 'dtc.aftersales',
      ranges: [{ kind: 'store', id: 'shop_a' }],
      granted_by: 'p_owner',
    })
    s.assignments.revoke(a.id, { handover_to: 'p_boss' })
    expect(() => s.effectiveConfig(a.id, { connected: CONNECTED })).toThrow(RoleError)
    expect(() => s.effectiveConfig(a.id, { connected: CONNECTED })).toThrow(/revoked/)
  })
})

describe('automation 收紧 (31 §3.4)', () => {
  it('keeps medium / high risk actions at L1 no matter the recorded level', () => {
    const { s } = store()
    const a = s.assignments.create({
      person_id: 'p_cs',
      workspace_id: 'ws_1',
      role_id: 'dtc.aftersales',
      ranges: [{ kind: 'store', id: 'shop_a' }],
      granted_by: 'p_owner',
    })
    const cfg = s.effectiveConfig(a.id, { connected: CONNECTED })
    expect(cfg.automation.stage_refund).toMatchObject({
      level: 'L1',
      ceiling: 'L2',
      risk_class: 'medium',
    })
    expect(cfg.automation.reply_customer).toMatchObject({ risk_class: 'low', ceiling: 'L3' })
    expect(cfg.automation.draft_chargeback_evidence).toMatchObject({
      risk_class: 'high',
      hard_ceiling: true,
      level: 'L1',
    })
  })

  it('classifies actions by ChangeKind, with outbound messages low and unknown writes high', () => {
    expect(riskClassOf({ id: 'stage_refund', kind: 'staged_change' })).toBe('medium')
    expect(riskClassOf({ id: 'stage_publish_theme', kind: 'staged_change' })).toBe('high')
    expect(riskClassOf({ id: 'stage_discount_code', kind: 'staged_change' })).toBe('low')
    expect(riskClassOf({ id: 'reply_customer', kind: 'outbound_message' })).toBe('low')
    expect(riskClassOf({ id: 'draft_chargeback_evidence', kind: 'staged_change' })).toBe('high')
  })
})
