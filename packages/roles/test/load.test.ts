import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  BUNDLED_ROLES_DIR,
  loadBundledPosition,
  loadBundledRole,
  parsePosition,
  parseRole,
  RoleSchemaError,
  resolveRoleId,
} from '../src/index.js'

const SUPPORT_YML = `${BUNDLED_ROLES_DIR}dtc/support.yml`
const source = () => readFileSync(SUPPORT_YML, 'utf8')

describe('loadRole (05 §5)', () => {
  it('loads the dtc.support example in full', () => {
    const role = loadBundledRole('dtc.support')
    expect(role.id).toBe('dtc.support')
    // WP54：售前 + 售后合并成网站客服，major 跟着升（已有分配要重新确认）
    expect(role.version).toBe('2.0.0')
    expect(role.domain).toBe('dtc')
    expect(role.name).toEqual({ zh: '网站客服', en: 'DTC Website Support' })
    // 7 条原有 + 并自售前的 product / inventory 两条只读
    expect(role.scopes).toHaveLength(9)
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
      // WP54：并自 `dtc.presales`，额度按动作分（折扣 ≤ 10%）
      'stage_discount_code',
      'draft_chargeback_evidence',
    ])
    expect(role.actions[1]?.mandate).toEqual({
      caps: { max_auto_refund_amount: 50, currency: 'USD', within_policy_window_only: true },
      per_change_limits: { max_items: 1, no_repeat_target_field: true },
      window: { max_count: 20, per: 'day' },
    })
    // 没写 window 的动作不会被 schemastery 的对象默认值补出一个空 window
    expect(role.actions[3]?.mandate.window).toBeUndefined()
    // 48 v2 L1「额度按动作分」：折扣码那条的上限不跟退款那条共用
    expect(role.actions[4]?.mandate.caps).toEqual({
      max_presales_discount_pct: 10,
      single_use_per_customer: true,
    })
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
    expect(() => parseRole(source().replace('id: dtc.support', 'id: Aftersales'))).toThrow(/id/)
  })
})

describe('loadPosition (05 §2)', () => {
  // WP54：售前 + 售后并成 `dtc.support`，十条变九条、八个默认变七个
  it('loads dtc-ops with 7 defaults and 2 optional roles (04 §1.11)', () => {
    const position = loadBundledPosition('dtc-ops')
    expect(position.id).toBe('dtc-ops')
    expect(position.roles).toHaveLength(9)
    expect(position.roles.filter((r) => r.default)).toHaveLength(7)
    expect(position.roles.filter((r) => !r.default).map((r) => r.role)).toEqual([
      'dtc.reviews',
      'dtc.fulfillment',
    ])
  })

  // WP54（48 v2 L1）：客服岗位 = 三条职责，默认全勾
  it('loads the customer-care position with all three support roles ticked (48 v2 L1)', () => {
    const position = loadBundledPosition('customer-care')
    expect(position.name.zh).toBe('客服')
    expect(position.roles.map((r) => r.role)).toEqual([
      'dtc.support',
      'dtc.live-chat',
      'amz.support',
    ])
    expect(position.roles.every((r) => r.default)).toBe(true)
  })

  // WP54：三条职责各自都能 load，且新建的两条形状合法
  it('loads the two new support roles (48 v2 L1)', () => {
    const chat = loadBundledRole('dtc.live-chat')
    expect(chat.name.zh).toBe('网站在线客服')
    // 「写动作默认无」：聊天里只答不承诺，一条 staged_change 都没有
    expect(chat.actions.every((a) => a.kind === 'outbound_message')).toBe(true)
    expect(chat.connectors.filter((c) => c.required).map((c) => c.kind)).toEqual(['chat_widget'])

    const amz = loadBundledRole('amz.support')
    expect(amz.domain).toBe('amz')
    expect(amz.name.zh).toBe('Amazon 客服')
    // 出站硬闸标注在额度上；退款走 SP-API 之前永远人审
    expect(amz.actions[0]?.mandate.caps).toMatchObject({
      no_external_links: true,
      no_contact_details: true,
      no_marketing: true,
    })
    expect(amz.automation.stage_refund?.hard_ceiling).toBe(true)
  })

  // WP54：旧 id 读得进来（分配、审批项、导出包里已经写着它们）
  it('still resolves the old role ids through the alias table (48 v2 L1)', () => {
    expect(resolveRoleId('dtc.aftersales')).toBe('dtc.support')
    expect(resolveRoleId('dtc.presales')).toBe('dtc.support')
    expect(resolveRoleId('amz.buyer-messages')).toBe('amz.support')
    expect(resolveRoleId('common.owner')).toBe('common.owner')
    expect(loadBundledRole('dtc.aftersales').id).toBe('dtc.support')
    expect(loadBundledRole('amz.buyer-messages').id).toBe('amz.support')
  })

  // WP62（51 §2）：`dtc.ops` → `dtc.store`
  it('旧的 `dtc.ops` 解析到内置的 `dtc.store`（店铺管理）', () => {
    expect(resolveRoleId('dtc.ops')).toBe('dtc.store')
    const role = loadBundledRole('dtc.ops')
    expect(role.id).toBe('dtc.store')
    expect(role.name.zh).toBe('店铺管理')
    // 51 §1 N0：连接器是平台中立的 `shop`，不写死 Shopify；
    // 评价应用（Judge.me / Loox）待增加，所以 `required: false`
    expect(role.connectors.map((c) => c.kind)).toEqual(['shop', 'reviews'])
    expect(role.connectors.find((c) => c.kind === 'reviews')?.required).toBe(false)
  })

  // WP63（51 §2.1）：五个能力面补齐 —— 额度**按动作**分，不按能力面分
  it('`dtc.store` 五个能力面：十一条写动作，额度各挂各的', () => {
    const role = loadBundledRole('dtc.store')
    expect(role.actions.map((a) => a.id)).toEqual([
      'stage_listing_edit',
      'stage_price_change',
      'stage_publish_product',
      'stage_unpublish_product',
      'stage_collection_edit',
      'stage_inventory_adjust',
      'stage_discount_code',
      'stage_promotion',
      'stage_publish_theme',
      'stage_review_reply',
      'stage_review_invite',
    ])
    const caps = (id: string): Record<string, unknown> =>
      role.actions.find((a) => a.id === id)?.mandate.caps ?? {}
    // 51 §5 N5 那四个默认值，一个不少、一个不串
    expect(caps('stage_price_change')).toMatchObject({ max_price_delta_pct: 20 })
    expect(caps('stage_inventory_adjust')).toMatchObject({ max_inventory_adjust: 50 })
    expect(caps('stage_discount_code')).toMatchObject({ max_promo_discount_pct: 30 })
    // 改价那条里**没有**库存的额度：额度按动作分，不是一份套全部
    expect(caps('stage_price_change').max_inventory_adjust).toBeUndefined()

    // 自动化上限（51 §2.1 那张表的最后一栏）
    expect(role.automation.stage_listing_edit?.ceiling).toBe('L2')
    // 改价上限给到 L2：额内自动、超额由 guardrail 拉回人审
    expect(role.automation.stage_price_change?.ceiling).toBe('L2')
    expect(role.actions.find((a) => a.id === 'stage_price_change')?.review_cannot_be_disabled).toBe(
      true,
    )
    // 上下架 / 全站活动 / 主题发布：永远 L1
    for (const id of [
      'stage_publish_product',
      'stage_unpublish_product',
      'stage_promotion',
      'stage_publish_theme',
    ]) {
      expect(role.automation[id]?.ceiling, id).toBe('L1')
      expect(role.automation[id]?.hard_ceiling, id).toBe(true)
    }
    // 差评转客服：回复那条动作路由到 `dtc.support`
    expect(role.actions.find((a) => a.id === 'stage_review_reply')?.route_to).toEqual({
      role: 'dtc.support',
    })
    // 结账 / 支付 / 税不给写动作：`store_config` 域只有 read
    expect(role.scopes.find((s) => s.domain === 'store_config')?.ops).toEqual(['read'])
    // 异常卡的阈值进职责 yml（51 §2.1）
    expect(role.thresholds?.low_stock_quantity).toBe(5)
    expect(role.thresholds?.sales_drop_pct).toBe(30)
  })

  // WP63（51 §2.2）：内容与博客
  it('`dtc.content` 内容与博客：草稿 L2、发布 L1、每天两篇', () => {
    const role = loadBundledRole('dtc.content')
    expect(role.name.zh).toBe('内容与博客')
    expect(role.actions.map((a) => a.id)).toEqual(['stage_publish_post', 'stage_listing_edit'])
    expect(role.actions[0]?.mandate.caps).toMatchObject({ max_posts_per_day: 2 })
    // 上限 L2 —— 草稿够得着自动；发布那一半由 guardrail 每次拉回人审
    expect(role.automation.stage_publish_post?.ceiling).toBe('L2')
    expect(role.actions[0]?.review_cannot_be_disabled).toBe(true)
    // 19：能读知识库，但不能写（内容可以引用事实卡，不能编数字）
    expect(role.scopes.find((s) => s.domain === 'knowledge')?.ops).toEqual(['read'])
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

  it('商品只读：改价不是这个岗位的事（那是 dtc.store）', () => {
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
