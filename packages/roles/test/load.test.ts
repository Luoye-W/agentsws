import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  BUNDLED_ROLES_DIR,
  loadBundledPosition,
  loadBundledRole,
  parsePosition,
  parseRole,
  RoleSchemaError,
} from '../src/index.js'

const AFTERSALES_YML = `${BUNDLED_ROLES_DIR}dtc/aftersales.yml`
const source = () => readFileSync(AFTERSALES_YML, 'utf8')

describe('loadRole (05 §5)', () => {
  it('loads the dtc.aftersales example in full', () => {
    const role = loadBundledRole('dtc.aftersales')
    expect(role.id).toBe('dtc.aftersales')
    expect(role.version).toBe('1.0.0')
    expect(role.domain).toBe('dtc')
    expect(role.name).toEqual({ zh: '独立站售后客服', en: 'DTC After-sales Support' })
    expect(role.scopes).toHaveLength(7)
    expect(role.scopes[0]).toEqual({
      domain: 'order',
      ops: ['read'],
      range: 'assigned',
      max_sensitivity: 'internal',
    })
    expect(role.connectors.filter((c) => c.required).map((c) => c.kind)).toEqual([
      'email',
      'shopify',
    ])
    expect(role.actions.map((a) => a.id)).toEqual([
      'reply_customer',
      'stage_refund',
      'stage_reship',
      'stage_address_change',
      'draft_chargeback_evidence',
    ])
    expect(role.actions[1]?.mandate).toEqual({
      caps: { max_auto_refund_amount: 50, currency: 'USD', within_policy_window_only: true },
      per_change_limits: { max_items: 1, no_repeat_target_field: true },
      window: { max_count: 20, per: 'day' },
    })
    // 没写 window 的动作不会被 schemastery 的对象默认值补出一个空 window
    expect(role.actions[3]?.mandate.window).toBeUndefined()
    expect(role.automation.reply_customer?.ceiling).toBe('L3')
    expect(role.automation.draft_chargeback_evidence?.hard_ceiling).toBe(true)
    expect(role.skills.map((s) => s.name)).toContain('customer-care')
    expect(role.grounding?.map((g) => g.tool)).toEqual(['get_order', 'search_policies'])
    expect(role.home_blocks).toHaveLength(4)
    expect(role.notifications).toHaveLength(5)
    expect(role.handover.fallback).toBe('scope_manager')
  })

  it('loads the two common roles (04 §7)', () => {
    const m = loadBundledRole('common.member')
    expect(m.domain).toBe('common')
    expect(m.actions).toEqual([])
    // 只读 + 提议（WP35 补的 stage）：没有 approve，也没有 apply
    expect(m.scopes.every((s) => s.ops.every((op) => op === 'read' || op === 'stage'))).toBe(true)
    expect(m.scopes.some((s) => s.ops.includes('approve'))).toBe(false)
    expect(m.scopes.find((s) => s.domain === 'approval')?.ops).toEqual(['read', 'stage'])
    expect(m.scopes.find((s) => s.domain === 'knowledge')?.ops).toEqual(['read', 'stage'])

    const o = loadBundledRole('common.owner')
    expect(o.scopes.find((s) => s.domain === 'policy')?.ops).toEqual(['read', 'stage', 'approve'])
    // WP35：14 §10「人也可提一张卡」、19 §4「答一条缺口」要的两条 stage
    expect(o.scopes.find((s) => s.domain === 'approval')?.ops).toEqual(['read', 'stage', 'approve'])
    expect(o.scopes.find((s) => s.domain === 'knowledge')?.ops).toEqual(['read', 'stage'])
    // 策略层动作永远 L1
    for (const spec of Object.values(o.automation)) {
      expect(spec.ceiling).toBe('L1')
      expect(spec.hard_ceiling).toBe(true)
    }
  })

  it('rejects a missing field and names it', () => {
    const broken = source().replace('  fallback: scope_manager\n', '')
    const error = (() => {
      try {
        parseRole(broken, 'broken.yml')
        return undefined
      } catch (e) {
        return e as RoleSchemaError
      }
    })()
    expect(error).toBeInstanceOf(RoleSchemaError)
    expect(error?.field).toBe('handover.fallback')
    expect(error?.message).toContain('handover.fallback')
    expect(error?.code).toBe('invalid_input')
  })

  it('names the exact path of a bad nested value', () => {
    const broken = source().replace(
      '{ domain: knowledge, ops: [read, stage], range: workspace, max_sensitivity: internal }',
      '{ domain: knowledge, ops: [read, stage], range: everywhere, max_sensitivity: internal }',
    )
    expect(() => parseRole(broken, 'broken.yml')).toThrow(/scopes\[3\]\.range/)
  })

  it('rejects unknown fields, including the withdrawn agent_max_sensitivity (31 §3.3)', () => {
    const broken = source().replace(
      '{ domain: customer, ops: [read, stage], range: assigned, max_sensitivity: internal }',
      '{ domain: customer, ops: [read, stage], range: assigned, max_sensitivity: internal, agent_max_sensitivity: confidential }',
    )
    expect(() => parseRole(broken, 'broken.yml')).toThrow(/scopes\[2\]\.agent_max_sensitivity/)
  })

  it('rejects malformed YAML and bad ids', () => {
    expect(() => parseRole('id: [', 'bad.yml')).toThrow(/invalid YAML/)
    expect(() => parseRole(source().replace('id: dtc.aftersales', 'id: Aftersales'))).toThrow(/id/)
  })
})

describe('loadPosition (05 §2)', () => {
  it('loads dtc-ops with 8 defaults and 2 optional roles (04 §1.11)', () => {
    const position = loadBundledPosition('dtc-ops')
    expect(position.id).toBe('dtc-ops')
    expect(position.roles).toHaveLength(10)
    expect(position.roles.filter((r) => r.default)).toHaveLength(8)
    expect(position.roles.filter((r) => !r.default).map((r) => r.role)).toEqual([
      'dtc.reviews',
      'dtc.fulfillment',
    ])
  })

  it('rejects a position without role defaults', () => {
    expect(() => parsePosition('id: x\nversion: 1.0.0\nname: {zh: a, en: b}\n', 'p.yml')).toThrow(
      /roles/,
    )
  })
})

/* ------------------------------------------------------------------ */
/* WP44：建站与主题职责（12 §2）                                        */
/* ------------------------------------------------------------------ */

describe('site.builder（12 §2 建站岗位）', () => {
  const builder = () => loadBundledRole('site.builder')

  it('装得进来，八个 scope、四条写动作', () => {
    const role = builder()
    expect(role.id).toBe('site.builder')
    expect(role.domain).toBe('dev')
    expect(role.scopes).toHaveLength(8)
    expect(role.actions.map((a) => a.id)).toEqual([
      'stage_theme_preview',
      'stage_publish_theme',
      'stage_page_edit',
      'stage_dev_task',
    ])
  })

  it('发布主题永远 L1：hard_ceiling + 复核不可关（15 §2）', () => {
    const role = builder()
    const publish = role.automation.stage_publish_theme
    expect(publish?.ceiling).toBe('L1')
    expect(publish?.initial).toBe('L1')
    expect(publish?.hard_ceiling).toBe(true)
    expect(
      role.actions.find((a) => a.id === 'stage_publish_theme')?.review_cannot_be_disabled,
    ).toBe(true)
    // 发布要惊动所有者，而且是立刻，不是攒到日报里
    const note = role.notifications.find((n) => n.event.includes('stage_publish_theme'))
    expect(note?.mode).toBe('immediate')
    expect(note?.recipients).toEqual(['owner'])
  })

  it('推未发布副本可以升到 L3：它不动线上，只是造一个预览给人看', () => {
    expect(builder().automation.stage_theme_preview?.ceiling).toBe('L3')
  })

  it('商品只读：改价不是这个岗位的事（那是 dtc.ops）', () => {
    const product = builder().scopes.find((s) => s.domain === 'product')
    expect(product?.ops).toEqual(['read'])
  })

  it('连接器要主题读写权限', () => {
    const shopify = builder().connectors.find((c) => c.kind === 'shopify')
    expect(shopify?.required).toBe(true)
    expect(shopify?.grants).toContain('read_themes')
    expect(shopify?.grants).toContain('write_themes')
  })
})
