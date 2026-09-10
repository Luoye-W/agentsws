import { describe, expect, it } from 'vitest'
import type { MockOpenConnector } from '../src/index.js'
import { createStandIns, isStandInError, StandInError, SyntheticClock } from '../src/index.js'

const WORKSPACE = 'ws_stand_in'

function fresh() {
  const s = createStandIns({ seed: 7 })
  return s
}

async function readToken(
  connect: MockOpenConnector,
  actions: string[] = ['shopify_admin.get_order'],
) {
  return connect.issueToken({
    assignment_id: 'asg_1',
    kind: 'role-read',
    allowed_actions: actions,
    allowed_connections: ['conn_shopify_admin'],
  })
}

async function applyToken(
  connect: MockOpenConnector,
  actions: string[] = ['shopify_admin.create_refund'],
) {
  return connect.issueToken({
    assignment_id: 'asg_1',
    kind: 'role-apply',
    allowed_actions: actions,
    allowed_connections: ['conn_shopify_admin'],
  })
}

describe('mock OpenConnector：发现与连接', () => {
  it('providers / actions 逐条带 side_effect（18 §1）', async () => {
    const { connect } = fresh()
    const providers = await connect.providers()
    expect(providers.map((p) => p.service).sort()).toEqual([
      'gmail',
      'klaviyo',
      'meta',
      'shopify_admin',
      'whatsapp',
    ])
    const shopify = await connect.actions('shopify_admin')
    // WP46 起多了一条只读的 `get_shop`（工作台拿它算币种与日界线）
    expect(shopify).toHaveLength(8)
    expect(shopify.find((a) => a.id === 'shopify_admin.get_shop')?.side_effect).toBe('read')
    expect(shopify.find((a) => a.id === 'shopify_admin.get_order')?.side_effect).toBe('read')
    expect(shopify.find((a) => a.id === 'shopify_admin.create_refund')?.side_effect).toBe('write')
    expect((await connect.actions('whatsapp')).map((a) => a.id)).toEqual([
      'whatsapp.send_message',
      'whatsapp.send_template',
    ])
  })

  it('beginConnect / pollConnect / transferConnection', async () => {
    const { connect } = fresh()
    const oauth = await connect.beginConnect('gmail', {
      workspace_id: WORKSPACE,
      ownership: 'workspace',
      alias: 'ops gmail',
      mode: 'agentsws_connect',
    })
    expect(oauth.authorization_url).toContain('gmail')
    expect(oauth.secure_form).toBeUndefined()
    const key = await connect.beginConnect('klaviyo', {
      workspace_id: WORKSPACE,
      ownership: 'workspace',
      alias: 'klaviyo',
      mode: 'own_app',
    })
    expect(key.secure_form?.fields.some((f) => f.name === 'api_key' && f.secret)).toBe(true)

    expect(await connect.pollConnect(oauth.request_id)).toBe('initiated')
    expect(await connect.pollConnect(oauth.request_id)).toBe('connected')
    expect(await connect.pollConnect('creq_nope')).toBe('expired')

    const conns = await connect.connections(WORKSPACE)
    expect(conns.some((c) => c.id === `conn_gmail_${oauth.request_id}`)).toBe(true)

    const moved = await connect.transferConnection('conn_gmail', 'ws_other')
    expect(moved.workspace_id).toBe('ws_other')
    expect((await connect.connections(WORKSPACE)).some((c) => c.id === 'conn_gmail')).toBe(false)
  })

  it('未知 provider / 未知连接报 not_found', async () => {
    const { connect } = fresh()
    await expect(
      connect.beginConnect('tiktok', {
        workspace_id: WORKSPACE,
        ownership: 'workspace',
        alias: 'x',
        mode: 'own_app',
      }),
    ).rejects.toMatchObject({ code: 'not_found' })
    await expect(connect.transferConnection('conn_nope', 'ws_x')).rejects.toMatchObject({
      code: 'not_found',
    })
  })
})

describe('mock OpenConnector：token（18 §1 09-08 改）', () => {
  it('空 allowed_connections 拒签', async () => {
    const { connect } = fresh()
    await expect(
      connect.issueToken({
        assignment_id: 'asg_1',
        kind: 'role-read',
        allowed_actions: ['shopify_admin.get_order'],
        allowed_connections: [],
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('空 allowed_actions、未知连接同样拒签', async () => {
    const { connect } = fresh()
    await expect(
      connect.issueToken({
        assignment_id: 'asg_1',
        kind: 'role-read',
        allowed_actions: [],
        allowed_connections: ['conn_shopify_admin'],
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(
      connect.issueToken({
        assignment_id: 'asg_1',
        kind: 'role-read',
        allowed_actions: ['shopify_admin.get_order'],
        allowed_connections: ['conn_ghost'],
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('role-read 调写 Action → 拒（18 §5 用例 4）', async () => {
    const { connect } = fresh()
    const token = await readToken(connect, [
      'shopify_admin.get_order',
      'shopify_admin.create_refund',
    ])
    await expect(
      connect.execute(
        'shopify_admin.create_refund',
        { order_id: 'ord_1001', amount: 10 },
        {
          token: token.token,
        },
      ),
    ).rejects.toMatchObject({ code: 'forbidden', status: 403 })
    expect(connect.state.orders[0]?.refunded_amount).toBe(0)
  })

  it('禁 proxy：role-read token 走原始代理被拒', async () => {
    const { connect } = fresh()
    const token = await readToken(connect)
    await expect(connect.proxy('shopify_admin', {}, { token: token.token })).rejects.toMatchObject({
      code: 'forbidden',
    })
  })

  it('不在 allowed_actions / allowed_connections / 已吊销 / 已过期 一律拒', async () => {
    const clock = new SyntheticClock('2026-09-07T01:00:00.000Z')
    const { connect } = createStandIns({ seed: 3, clock })
    const token = await readToken(connect)
    await expect(
      connect.execute('shopify_admin.list_orders', {}, { token: token.token }),
    ).rejects.toMatchObject({ code: 'forbidden' })
    await expect(
      connect.execute(
        'shopify_admin.get_order',
        { order_id: 'ord_1001' },
        { token: token.token, connection: 'conn_gmail' },
      ),
    ).rejects.toMatchObject({ code: 'connection_not_allowed' })
    await expect(
      connect.execute('shopify_admin.get_order', { order_id: 'ord_1001' }, { token: 'tok_bogus' }),
    ).rejects.toMatchObject({ code: 'forbidden' })

    clock.advance(2 * 3600 * 1000)
    await expect(
      connect.execute('shopify_admin.get_order', { order_id: 'ord_1001' }, { token: token.token }),
    ).rejects.toMatchObject({ code: 'forbidden' })

    const t2 = await readToken(connect)
    await connect.revokeTokens('asg_1')
    await expect(
      connect.execute('shopify_admin.get_order', { order_id: 'ord_1001' }, { token: t2.token }),
    ).rejects.toMatchObject({ code: 'forbidden' })
  })
})

describe('mock OpenConnector：写 Action 真的改内存状态', () => {
  it('退款后 refunded 增加、financial_status 变、record_version 推进', async () => {
    const { connect } = fresh()
    const token = await applyToken(connect)
    const before = connect.state.orders.find((o) => o.id === 'ord_1001')
    expect(before?.financial_status).toBe('paid')

    const partial = await connect.execute<{ financial_status: string; refunded_amount: number }>(
      'shopify_admin.create_refund',
      { order_id: 'ord_1001', amount: 29, reason: 'return within window' },
      { token: token.token },
    )
    expect(partial.data.refunded_amount).toBe(29)
    expect(partial.data.financial_status).toBe('partially_refunded')
    expect(connect.state.orders.find((o) => o.id === 'ord_1001')?.record_version).toBe('v2')

    await connect.execute(
      'shopify_admin.create_refund',
      { order_id: 'ord_1001', amount: 100 },
      {
        token: token.token,
      },
    )
    const after = connect.state.orders.find((o) => o.id === 'ord_1001')
    expect(after?.refunded_amount).toBe(129)
    expect(after?.financial_status).toBe('refunded')
    expect(after?.record_version).toBe('v3')

    await expect(
      connect.execute(
        'shopify_admin.create_refund',
        { order_id: 'ord_1001', amount: 1 },
        {
          token: token.token,
        },
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('地址 / 价格 / 折扣码 / 邮件 / 帖子 / 名单 / WhatsApp 都落到状态里', async () => {
    const { connect } = fresh()
    const shopify = await applyToken(connect, [
      'shopify_admin.update_order_shipping_address',
      'shopify_admin.update_product_price',
      'shopify_admin.create_discount_code',
    ])
    const addr = await connect.execute<{ after: { city: string } }>(
      'shopify_admin.update_order_shipping_address',
      { order_id: 'ord_1003', address: { city: 'Porto', zip: '4000-001' } },
      { token: shopify.token },
    )
    expect(addr.data.after.city).toBe('Porto')
    await expect(
      connect.execute(
        'shopify_admin.update_order_shipping_address',
        { order_id: 'ord_1001', address: { city: 'X' } },
        { token: shopify.token },
      ),
    ).rejects.toMatchObject({ code: 'conflict' })

    await connect.execute(
      'shopify_admin.update_product_price',
      { product_id: 'prod_1', price: 99 },
      {
        token: shopify.token,
      },
    )
    expect(connect.state.products.find((p) => p.id === 'prod_1')?.price).toBe(99)

    await connect.execute(
      'shopify_admin.create_discount_code',
      { code: 'WELCOME', percentage: 10 },
      {
        token: shopify.token,
      },
    )
    expect(connect.state.discounts).toHaveLength(1)
    await expect(
      connect.execute(
        'shopify_admin.create_discount_code',
        { code: 'WELCOME', percentage: 20 },
        {
          token: shopify.token,
        },
      ),
    ).rejects.toMatchObject({ code: 'conflict' })

    const gmail = await connect.issueToken({
      assignment_id: 'asg_1',
      kind: 'role-apply',
      allowed_actions: ['gmail.send_message', 'gmail.list_threads'],
      allowed_connections: ['conn_gmail'],
    })
    const sent = await connect.execute<{ thread_id: string }>(
      'gmail.send_message',
      { thread_id: 'thr_1', to: ['anna@example.com'], body: 'On its way.' },
      { token: gmail.token, connection: 'conn_gmail' },
    )
    expect(sent.data.thread_id).toBe('thr_1')
    expect(connect.state.messages.filter((m) => m.direction === 'outbound')).toHaveLength(1)
    const threads = await connect.execute<{ count: number }>(
      'gmail.list_threads',
      { participant: 'anna@example.com' },
      { token: gmail.token, connection: 'conn_gmail' },
    )
    expect(threads.data.count).toBe(1)

    const meta = await connect.issueToken({
      assignment_id: 'asg_1',
      kind: 'role-apply',
      allowed_actions: ['meta.publish_post'],
      allowed_connections: ['conn_meta'],
    })
    await connect.execute(
      'meta.publish_post',
      { page: 'brand', message: 'New drop' },
      {
        token: meta.token,
        connection: 'conn_meta',
      },
    )
    expect(connect.state.posts).toHaveLength(1)

    const klaviyo = await connect.issueToken({
      assignment_id: 'asg_1',
      kind: 'role-apply',
      allowed_actions: ['klaviyo.add_to_segment'],
      allowed_connections: ['conn_klaviyo'],
    })
    const first = await connect.execute<{ added: boolean }>(
      'klaviyo.add_to_segment',
      { segment: 'vip', email: 'anna@example.com' },
      { token: klaviyo.token, connection: 'conn_klaviyo' },
    )
    const again = await connect.execute<{ added: boolean }>(
      'klaviyo.add_to_segment',
      { segment: 'vip', email: 'anna@example.com' },
      { token: klaviyo.token, connection: 'conn_klaviyo' },
    )
    expect([first.data.added, again.data.added]).toEqual([true, false])

    const wa = await connect.issueToken({
      assignment_id: 'asg_1',
      kind: 'role-apply',
      allowed_actions: ['whatsapp.send_message', 'whatsapp.send_template'],
      allowed_connections: ['conn_whatsapp'],
    })
    await connect.execute(
      'whatsapp.send_message',
      { to: '+4915100', body: 'hi' },
      {
        token: wa.token,
        connection: 'conn_whatsapp',
      },
    )
    const tpl = await connect.execute<{ template_used: boolean }>(
      'whatsapp.send_template',
      { to: '+4915100', template: 'shipping_update', variables: ['#1001'] },
      { token: wa.token, connection: 'conn_whatsapp' },
    )
    expect(tpl.data.template_used).toBe(true)
    expect(connect.state.whatsapp).toHaveLength(2)
  })

  it('输入校验与未知实体', async () => {
    const { connect } = fresh()
    const token = await applyToken(connect, [
      'shopify_admin.create_refund',
      'shopify_admin.get_order',
      'shopify_admin.get_product',
    ])
    await expect(
      connect.execute('shopify_admin.get_order', { order_id: 'ord_nope' }, { token: token.token }),
    ).rejects.toMatchObject({ code: 'not_found' })
    await expect(
      connect.execute('shopify_admin.get_product', {}, { token: token.token }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(
      connect.execute(
        'shopify_admin.create_refund',
        { order_id: 'ord_1001', amount: -1 },
        {
          token: token.token,
        },
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(
      connect.execute('shopify_admin.get_order', 'not-an-object', { token: token.token }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(
      connect.execute('shopify_admin.nope', {}, { token: token.token }),
    ).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('mock OpenConnector：故障注入（26 §3）', () => {
  it('429 注入两次后第三次成功', async () => {
    const { connect } = fresh()
    const token = await readToken(connect)
    connect.inject({ action: 'get_order', code: 429, times: 2 })
    for (const _attempt of [1, 2]) {
      await expect(
        connect.execute(
          'shopify_admin.get_order',
          { order_id: 'ord_1001' },
          { token: token.token },
        ),
      ).rejects.toMatchObject({ code: 'rate_limited', status: 429 })
    }
    const ok = await connect.execute<{ id: string }>(
      'shopify_admin.get_order',
      { order_id: 'ord_1001' },
      { token: token.token },
    )
    expect(ok.data.id).toBe('ord_1001')
    expect(connect.pendingFaults()).toHaveLength(0)
  })

  it('500 / timeout 也能注入；注入的调用不改状态', async () => {
    const { connect } = fresh()
    const token = await applyToken(connect)
    connect.inject({ action: 'shopify_admin.create_refund', code: 500, times: 1 })
    connect.inject({ action: 'shopify_admin.create_refund', code: 'timeout', times: 1 })
    await expect(
      connect.execute(
        'shopify_admin.create_refund',
        { order_id: 'ord_1001', amount: 5 },
        {
          token: token.token,
        },
      ),
    ).rejects.toMatchObject({ code: 'provider_error', status: 500 })
    await expect(
      connect.execute(
        'shopify_admin.create_refund',
        { order_id: 'ord_1001', amount: 5 },
        {
          token: token.token,
        },
      ),
    ).rejects.toMatchObject({ code: 'timeout', status: 504 })
    expect(connect.state.orders[0]?.refunded_amount).toBe(0)
    connect.clearFaults()
    expect(connect.pendingFaults()).toEqual([])
    expect(() => connect.inject({ action: 'get_order', code: 429, times: 0 })).toThrow(StandInError)
  })
})

describe('mock OpenConnector：幂等（18 §1）', () => {
  it('同 Idempotency-Key 重放原结果，不二次退款', async () => {
    const { connect } = fresh()
    const token = await applyToken(connect)
    const first = await connect.execute<{ refund_id: string }>(
      'shopify_admin.create_refund',
      { order_id: 'ord_1001', amount: 20 },
      { token: token.token, idempotencyKey: 'chg_1' },
    )
    const second = await connect.execute<{ refund_id: string }>(
      'shopify_admin.create_refund',
      { order_id: 'ord_1001', amount: 20 },
      { token: token.token, idempotencyKey: 'chg_1' },
    )
    expect(second.execution_id).toBe(first.execution_id)
    expect(second.data.refund_id).toBe(first.data.refund_id)
    expect(second.meta?.idempotent_replay).toBe(true)
    expect(connect.state.orders.find((o) => o.id === 'ord_1001')?.refunded_amount).toBe(20)
    expect(connect.observations.byAction('shopify_admin.create_refund')).toHaveLength(2)
    expect(connect.observations.byAction('shopify_admin.create_refund')[1]?.replayed).toBe(true)
  })

  it('同键换 Action → 409 语义；失败的调用不占键；窗口过期后重新执行', async () => {
    const clock = new SyntheticClock('2026-09-07T01:00:00.000Z')
    const { connect } = createStandIns({ seed: 5, clock })
    const token = await applyToken(connect, [
      'shopify_admin.create_refund',
      'shopify_admin.update_product_price',
    ])
    await connect.execute(
      'shopify_admin.create_refund',
      { order_id: 'ord_1001', amount: 10 },
      {
        token: token.token,
        idempotencyKey: 'k1',
      },
    )
    await expect(
      connect.execute(
        'shopify_admin.update_product_price',
        { product_id: 'prod_1', price: 1 },
        {
          token: token.token,
          idempotencyKey: 'k1',
        },
      ),
    ).rejects.toMatchObject({ code: 'idempotency_conflict', status: 409 })

    connect.inject({ action: 'shopify_admin.create_refund', code: 429, times: 1 })
    await expect(
      connect.execute(
        'shopify_admin.create_refund',
        { order_id: 'ord_1001', amount: 5 },
        {
          token: token.token,
          idempotencyKey: 'k2',
        },
      ),
    ).rejects.toMatchObject({ code: 'rate_limited' })
    await connect.execute(
      'shopify_admin.create_refund',
      { order_id: 'ord_1001', amount: 5 },
      {
        token: token.token,
        idempotencyKey: 'k2',
      },
    )
    expect(connect.state.orders.find((o) => o.id === 'ord_1001')?.refunded_amount).toBe(15)

    clock.advance(25 * 3600 * 1000)
    const t2 = await applyToken(connect)
    await connect.execute(
      'shopify_admin.create_refund',
      { order_id: 'ord_1001', amount: 5 },
      {
        token: t2.token,
        idempotencyKey: 'k1',
      },
    )
    expect(connect.state.orders.find((o) => o.id === 'ord_1001')?.refunded_amount).toBe(20)
  })
})

describe('mock OpenConnector：连接状态与超时对账', () => {
  it('连接不可用（reauth_required / disabled）→ 拒', async () => {
    const { connect } = fresh()
    connect.putConnection({
      id: 'conn_broken',
      service: 'shopify_admin',
      alias: 'broken',
      ownership: 'workspace',
      workspace_id: WORKSPACE,
      status: 'reauth_required',
    })
    const token = await connect.issueToken({
      assignment_id: 'asg_1',
      kind: 'role-read',
      allowed_actions: ['shopify_admin.get_order'],
      allowed_connections: ['conn_broken'],
    })
    await expect(
      connect.execute(
        'shopify_admin.get_order',
        { order_id: 'ord_1001' },
        { token: token.token, connection: 'conn_broken' },
      ),
    ).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('超时后结果未知：同键重试拿 409，对账后才放行（15 §5.8）', async () => {
    const { connect } = fresh()
    const token = await applyToken(connect)
    connect.inject({ action: 'shopify_admin.create_refund', code: 'timeout', times: 1 })
    await expect(
      connect.execute(
        'shopify_admin.create_refund',
        { order_id: 'ord_1001', amount: 7 },
        {
          token: token.token,
          idempotencyKey: 'k_timeout',
        },
      ),
    ).rejects.toMatchObject({ code: 'timeout' })
    await expect(
      connect.execute(
        'shopify_admin.create_refund',
        { order_id: 'ord_1001', amount: 7 },
        {
          token: token.token,
          idempotencyKey: 'k_timeout',
        },
      ),
    ).rejects.toMatchObject({ code: 'idempotency_conflict', status: 409 })
    expect(connect.state.orders[0]?.refunded_amount).toBe(0)

    expect(connect.settleIdempotency('k_timeout')).toBe(true)
    expect(connect.settleIdempotency('k_timeout')).toBe(false)
    await connect.execute(
      'shopify_admin.create_refund',
      { order_id: 'ord_1001', amount: 7 },
      {
        token: token.token,
        idempotencyKey: 'k_timeout',
      },
    )
    expect(connect.state.orders[0]?.refunded_amount).toBe(7)
  })
})

describe('mock OpenConnector：出站观察（16 §3）', () => {
  it('每一次 execute 都被记录：动作、输入摘要、token kind、结果', async () => {
    const { connect, observations } = fresh()
    const read = await readToken(connect)
    const write = await applyToken(connect)
    await connect.execute(
      'shopify_admin.get_order',
      { order_id: 'ord_1001' },
      { token: read.token },
    )
    await connect
      .execute(
        'shopify_admin.create_refund',
        { order_id: 'ord_1001', amount: 9 },
        {
          token: read.token,
        },
      )
      .catch(() => undefined)
    await connect.execute(
      'shopify_admin.create_refund',
      { order_id: 'ord_1001', amount: 9 },
      {
        token: write.token,
        idempotencyKey: 'chg_9',
      },
    )

    const all = observations.all()
    expect(all).toHaveLength(3)
    expect(all.map((o) => o.seq)).toEqual([1, 2, 3])
    expect(all[0]).toMatchObject({
      action_id: 'shopify_admin.get_order',
      side_effect: 'read',
      category: 'read_external',
      token_kind: 'role-read',
      assignment_id: 'asg_1',
      status: 'ok',
      connection_id: 'conn_shopify_admin',
    })
    expect(all[0]?.input_summary).toEqual({ order_id: 'ord_1001' })
    expect(all[1]).toMatchObject({ status: 'blocked', error_code: 'forbidden' })
    expect(all[2]).toMatchObject({
      category: 'write_external',
      token_kind: 'role-apply',
      idempotency_key: 'chg_9',
      status: 'ok',
    })
    expect(all[2]?.execution_id).toBeDefined()

    expect(observations.writes().map((o) => o.action_id)).toEqual([
      'shopify_admin.create_refund',
      'shopify_admin.create_refund',
    ])
    expect(observations.audit()).toEqual([
      { action_id: 'shopify_admin.create_refund', category: 'write_external', ok: 1, error: 1 },
      { action_id: 'shopify_admin.get_order', category: 'read_external', ok: 1, error: 0 },
    ])
    expect(observations.length).toBe(3)
    observations.clear()
    expect(observations.all()).toEqual([])
  })

  it('输入摘要只留短标量与形状，长文本截断', async () => {
    const { connect, observations } = fresh()
    const gmail = await connect.issueToken({
      assignment_id: 'asg_1',
      kind: 'role-apply',
      allowed_actions: ['gmail.send_message'],
      allowed_connections: ['conn_gmail'],
    })
    await connect.execute(
      'gmail.send_message',
      { to: ['anna@example.com'], body: 'x'.repeat(500), meta: { a: 1 } },
      { token: gmail.token, connection: 'conn_gmail' },
    )
    const summary = observations.all()[0]?.input_summary ?? {}
    expect(summary.to).toBe('[array:1]')
    expect(summary.meta).toBe('{object:1}')
    expect(summary.body?.endsWith('…')).toBe(true)
    expect((summary.body ?? '').length).toBeLessThan(200)
  })
})

describe('mock OpenConnector：名字解析', () => {
  it('裸名与全名都能解析，未知报错', () => {
    const { connect } = fresh()
    expect(connect.resolveActionId('get_order')).toBe('shopify_admin.get_order')
    expect(connect.resolveActionId('shopify_admin.get_order')).toBe('shopify_admin.get_order')
    expect(() => connect.resolveActionId('send_message')).toThrowError(/歧义/)
    expect(() => connect.resolveActionId('nope')).toThrowError(/未知 Action/)
    expect(connect.allActions()).toHaveLength(14)
    try {
      connect.resolveActionId('nope')
    } catch (e) {
      expect(isStandInError(e)).toBe(true)
      expect(isStandInError(new Error('x'))).toBe(false)
    }
  })
})
