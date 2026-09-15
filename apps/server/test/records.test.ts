/**
 * WP53 真环境记录源与工具执行器。
 *
 * 09-14 真店验收撞上的那个洞：模型调 `get_order` 回 `no_tool_executor`，没有 `contactOf`
 * 就建不出回信草稿卡。这里钉住修好之后的行为：
 *
 * - 有活跃 Shopify 连接 → 四个只读工具真的跑到连接器上，每次**现签一张只含它的 token**，
 *   用完（成功与失败都）立刻吊销；
 * - 没连 Shopify → 一句人话的 `not_connected`，不假装查过；
 * - 返回体里的 `provenance` 是真回来的实体（15 §6），字段名对得上 support-core 起草要的那几格；
 * - **订单内容一个字节不进事件**：事件里只有工具名、成功与否、耗时、provenance 条数、失败原因码；
 * - `contactOf` 第一次建一条联系人、第二次命中同一条，而且与 `get_order` 带回来的是**同一个 ref**
 *   （31 §3.3 的收件人门禁靠这件事才过得去）。
 *
 * 用的是假 connect（记录 issueToken / execute / revokeTokens 的**顺序**与参数）与假知识层。
 */
import type {
  ActionMeta,
  Clock,
  ConnectToken,
  EventEnvelope,
  PermissionScope,
  RetrievalHit,
  RunRequest,
} from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import type { ConnectLike } from '../src/connections.js'
import { createServer } from '../src/index.js'
import {
  bareToolName,
  contactIdOf,
  createConnectRecordSource,
  failureReasonOf,
  orderRecordOf,
  orderRowOf,
  productRecordOf,
  shippingAddressOf,
  TOKEN_TTL_SECONDS,
  TOOLS_ASSIGNMENT,
} from '../src/records.js'

const T0 = '2026-09-14T09:00:00.000Z'
const WS = 'ws_wp53'
/** 客户邮箱 / 收件地址：泄漏没泄漏进事件，就盯这两串。 */
const CUSTOMER_EMAIL = 'wp53-customer-never-logged@example.com'
const STREET = '1 Never-Logged Street'

function makeClock(start = T0): Clock {
  return { now: () => start }
}

const ORDER_1001 = {
  id: 'gid://shopify/Order/1001',
  name: '#1001',
  email: CUSTOMER_EMAIL,
  currency: 'USD',
  created_at: '2026-09-10T02:00:00.000Z',
  total_price: '129.00',
  financial_status: 'paid',
  fulfillment_status: 'fulfilled',
  delivered_at: '2026-09-12T02:00:00.000Z',
  customer: { first_name: 'Anna', last_name: 'Lee' },
  shipping_address: {
    name: 'Anna Lee',
    address1: STREET,
    city: 'Portland',
    zip: '97205',
    country: 'US',
  },
  line_items: [{ id: 'li_1', product_id: 'p_1', title: '3C Charger', quantity: 2, price: '64.50' }],
}

// ── 假 connect（只记账，不连任何网络）─────────────────────────────────

type Step =
  | { kind: 'issue'; assignment_id: string; actions: string[]; connections: string[]; ttl?: number }
  | { kind: 'execute'; action_id: string; input: unknown; token: string }
  | { kind: 'revoke'; assignment_id: string }

interface FakeConnect extends ConnectLike {
  steps: Step[]
  /** 下一次 `execute` 抛这个（抛完清掉）。 */
  failNext?: Error
  /** 每个 action 回什么。 */
  replies: Map<string, unknown>
}

const ACTION_IDS = [
  'shopify_admin.get_order',
  'shopify_admin.list_orders',
  'shopify_admin.get_product',
  'shopify_admin.list_products',
  'shopify_admin.get_shop',
]

function fakeConnect(): FakeConnect {
  let issued = 0
  const notImplemented = (): never => {
    throw new Error('not used in this test')
  }
  const fake: FakeConnect = {
    steps: [],
    replies: new Map<string, unknown>([
      ['shopify_admin.get_order', { order: ORDER_1001 }],
      ['shopify_admin.list_orders', { orders: [ORDER_1001] }],
      [
        'shopify_admin.get_product',
        { product: { id: 'p_1', title: '3C Charger', status: 'ACTIVE', vendor: 'Acme' } },
      ],
      ['shopify_admin.list_products', { products: [{ id: 'p_1', title: '3C Charger' }] }],
    ]),
    providers: notImplemented,
    connections: notImplemented,
    beginConnect: notImplemented,
    pollConnect: notImplemented,
    submitForm: notImplemented,
    removeConnection: notImplemented,
    async actions(service: string): Promise<ActionMeta[]> {
      return ACTION_IDS.map((id) => ({
        id,
        service,
        input_schema: {},
        side_effect: 'read' as const,
      }))
    },
    async issueToken(input): Promise<ConnectToken> {
      issued += 1
      fake.steps.push({
        kind: 'issue',
        assignment_id: input.assignment_id,
        actions: [...input.allowed_actions],
        connections: [...input.allowed_connections],
        ...(input.expires_in_seconds === undefined ? {} : { ttl: input.expires_in_seconds }),
      })
      return {
        token: `tok_${issued}`,
        kind: input.kind,
        assignment_id: input.assignment_id,
        expires_at: T0,
        allowed_actions: [...input.allowed_actions],
        allowed_connections: [...input.allowed_connections],
        allowed_proxies: [],
      }
    },
    async revokeTokens(assignment_id): Promise<void> {
      fake.steps.push({ kind: 'revoke', assignment_id })
    },
    async execute(action_id, input, opts) {
      fake.steps.push({ kind: 'execute', action_id, input, token: opts.token })
      const once = fake.failNext
      if (once !== undefined) {
        fake.failNext = undefined
        throw once
      }
      return { data: fake.replies.get(action_id), execution_id: `exe_${fake.steps.length}` }
    },
  }
  return fake
}

class UpstreamError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

// ── 假知识层 ───────────────────────────────────────────────────────────

function fakeKnowledge(hits: RetrievalHit[]): {
  search: (q: {
    text: string
    actor: { grants: PermissionScope[] }
  }) => Promise<{ hits: RetrievalHit[] }>
  seen: { text: string; grants: PermissionScope[] }[]
} {
  const seen: { text: string; grants: PermissionScope[] }[] = []
  return {
    seen,
    async search(q) {
      seen.push({ text: q.text, grants: [...q.actor.grants] })
      return { hits }
    },
  }
}

const SCOPE: PermissionScope = {
  domain: 'knowledge',
  ops: ['read'],
  range: 'workspace',
  max_sensitivity: 'internal',
}

// ── 装配 ───────────────────────────────────────────────────────────────

interface Setup {
  source: ReturnType<typeof createConnectRecordSource>
  connect: FakeConnect
  events: EventEnvelope[]
  knowledge: ReturnType<typeof fakeKnowledge>
}

function setup(
  opts: {
    connected?: boolean
    hits?: RetrievalHit[]
    /** WP62（51 §1 N0）：公司档案里的「网站是用什么搭的」；不给 = Shopify。 */
    platform?: 'shopify' | 'woocommerce' | 'magento' | 'other'
  } = {},
): Setup {
  const connect = fakeConnect()
  const events: EventEnvelope[] = []
  const knowledge = fakeKnowledge(opts.hits ?? [])
  const source = createConnectRecordSource({
    connect,
    connections: {
      liveConnections: () =>
        opts.connected === false
          ? []
          : [{ id: 'cxn_shop_1', service: 'shopify_admin', status: 'active' as const }],
    },
    clock: makeClock(),
    workspace_id: WS,
    knowledge,
    roles: { effectiveConfig: () => ({ scopes: [SCOPE], ranges: [] }) },
    appendEvent: (e) => {
      events.push({ id: `ev_${events.length}`, at: T0, ...e } as EventEnvelope)
    },
    ...(opts.platform === undefined ? {} : { storefrontPlatform: () => opts.platform }),
  })
  return { source, connect, events, knowledge }
}

function request(allow: string[] = ['get_order', 'list_orders', 'get_product', 'search_policies']) {
  return {
    actor: { person_id: 'per_1', assignment_id: 'asg_1', role_id: 'dtc.support' },
    tools: { allow, connect_token: '', side_effect_policy: 'executor' },
  } as unknown as RunRequest
}

const call = (source: Setup['source'], name: string, input: Record<string, unknown> = {}) => {
  const executeTool = source.executeTool
  if (executeTool === undefined) throw new Error('no executor')
  return executeTool({ name, input, request: request() })
}

/** 事件与落盘里有没有出现过订单内容。 */
const dump = (events: EventEnvelope[]): string => JSON.stringify(events)

// ── 映射单测（真店碰不到，只能对着形状钉）──────────────────────────────

describe('上游那一坨 → 起草要的字段', () => {
  it('get_order 的包装层认得出来，字段名与 support-core 的 OrderFacts 逐字一致', () => {
    const row = orderRowOf({ data: { order: ORDER_1001 } })
    expect(row).toBeDefined()
    const record = orderRecordOf(row as Record<string, unknown>, 'USD')
    expect(record).toMatchObject({
      id: 'gid://shopify/Order/1001',
      name: '#1001',
      currency: 'USD',
      total_price: 129,
      refunded_amount: 0,
      financial_status: 'paid',
      fulfillment_status: 'fulfilled',
      email: CUSTOMER_EMAIL,
      customer_name: 'Anna Lee',
      created_at: '2026-09-10T02:00:00.000Z',
      delivered_at: '2026-09-12T02:00:00.000Z',
    })
    expect(record?.line_items?.[0]).toMatchObject({ product_id: 'p_1', quantity: 2 })
    expect(record?.shipping_address).toMatchObject({ city: 'Portland', country: 'US' })
  })

  it('收件地址只留起草用得上的那几格（电话不进）', () => {
    const address = shippingAddressOf({
      shipping_address: { name: 'Anna Lee', address1: STREET, phone: '+1-555-0100' },
    })
    expect(address).toEqual({ name: 'Anna Lee', address1: STREET })
  })

  it('认不出来的一律 undefined（不编一张订单出来）', () => {
    expect(orderRowOf({ hello: 'world' })).toBeUndefined()
    expect(productRecordOf({ hello: 'world' })).toBeUndefined()
    expect(orderRecordOf({ id: 'o_1' }, 'USD')).toBeUndefined()
  })

  it('光杆工具名与失败分档', () => {
    expect(bareToolName('shopify_admin.get_order')).toBe('get_order')
    expect(bareToolName('get_order')).toBe('get_order')
    expect(failureReasonOf(new UpstreamError('not_found', 'x'))).toBe('not_found')
    expect(failureReasonOf(new Error('HTTP 404'))).toBe('not_found')
    expect(failureReasonOf(new UpstreamError('rate_limited', 'slow down'))).toBe('upstream_error')
  })
})

// ── 令牌纪律（18 §1）──────────────────────────────────────────────────

describe('令牌短命：现签、只含这一个 Action、用完即吊销', () => {
  it('一次 get_order = 签一张 → 执行 → 吊销，顺序就是这个', async () => {
    const { source, connect } = setup()
    const out = await call(source, 'get_order', { order_id: 'gid://shopify/Order/1001' })
    expect(out.status).toBe('ok')
    expect(connect.steps.map((s) => s.kind)).toEqual(['issue', 'execute', 'revoke'])
    const issue = connect.steps[0]
    expect(issue).toMatchObject({
      kind: 'issue',
      assignment_id: TOOLS_ASSIGNMENT,
      actions: ['shopify_admin.get_order'],
      connections: ['cxn_shop_1'],
      ttl: TOKEN_TTL_SECONDS,
    })
    // 执行用的就是刚签出来那一张
    expect(connect.steps[1]).toMatchObject({ token: 'tok_1' })
    expect(connect.steps[2]).toMatchObject({ kind: 'revoke', assignment_id: TOOLS_ASSIGNMENT })
  })

  it('get_order 拿到订单号 #1001：先 list_orders 按 name 查成 id，再拉那一张（两张令牌各自用完即吊销）', async () => {
    const { source, connect } = setup()
    const out = await call(source, 'get_order', { order_id: '#1001' })
    expect(out.status).toBe('ok')
    const executes = connect.steps.filter((s) => s.kind === 'execute')
    expect(executes[0]).toMatchObject({
      action_id: 'shopify_admin.list_orders',
      input: { first: 5, query: 'name:#1001' },
    })
    expect(executes[1]).toMatchObject({
      action_id: 'shopify_admin.get_order',
      input: { id: 'gid://shopify/Order/1001' },
    })
    expect(connect.steps.map((s) => s.kind)).toEqual([
      'issue',
      'execute',
      'revoke',
      'issue',
      'execute',
      'revoke',
    ])
  })

  it('get_product 拿到的是关键词不是 id：按 list_products 查', async () => {
    const { source, connect } = setup()
    await call(source, 'get_product', { query: 'snowboard' })
    expect(connect.steps.find((s) => s.kind === 'execute')).toMatchObject({
      action_id: 'shopify_admin.list_products',
      input: { first: 20, query: 'snowboard' },
    })
  })

  it('上游抛了也吊销（失败不该把令牌留在外面）', async () => {
    const { source, connect } = setup()
    connect.failNext = new UpstreamError('rate_limited', 'slow down')
    const out = await call(source, 'list_orders')
    expect(out.status).toBe('error')
    expect(out.reason).toContain('upstream_error')
    expect(connect.steps.map((s) => s.kind)).toEqual(['issue', 'execute', 'revoke'])
  })

  it('入参按上游 schema 现造，不把模型给的杂键透传下去', async () => {
    const { source, connect } = setup()
    await call(source, 'get_order', { order_id: 'o_1', bogus: 'drop me' })
    expect(connect.steps.find((s) => s.kind === 'execute')).toMatchObject({
      input: { id: 'o_1' },
    })
    await call(source, 'list_orders', { limit: 999, query: 'status:open' })
    const last = [...connect.steps].reverse().find((s) => s.kind === 'execute')
    expect(last).toMatchObject({ input: { first: 20, query: 'status:open' } })
  })
})

// ── provenance 与返回体（15 §6）────────────────────────────────────────

describe('返回体与 provenance', () => {
  it('get_order 回一张订单 + 订单与联系人两条出处', async () => {
    const { source } = setup()
    const out = await call(source, 'get_order', { order_id: 'gid://shopify/Order/1001' })
    expect(out.status).toBe('ok')
    expect(out.data).toMatchObject({ name: '#1001', total_price: 129, email: CUSTOMER_EMAIL })
    expect(out.provenance?.[0]).toEqual({ type: 'order', id: 'gid://shopify/Order/1001' })
    expect(out.provenance?.[1]?.type).toBe('contact')
  })

  it('list_orders 每一张都进出处；search_policies 出 fact_card 出处并带岗位身份下推', async () => {
    const hits: RetrievalHit[] = [
      {
        fact_card_id: 'fc_return',
        score: 0.9,
        layer: 'company',
        statement_redacted: '退货窗口 30 天',
        provenance_summary: 'policy',
        sensitivity: 'internal',
      },
    ]
    const { source, knowledge } = setup({ hits })
    const orders = await call(source, 'list_orders')
    expect(orders.provenance?.some((r) => r.type === 'order')).toBe(true)

    const policies = await call(source, 'search_policies', { query: '退货窗口' })
    expect(policies.status).toBe('ok')
    expect(policies.data).toMatchObject({
      hits: [{ id: 'fc_return', statement: '退货窗口 30 天' }],
    })
    expect(policies.provenance).toEqual([{ type: 'fact_card', id: 'fc_return' }])
    // 19 §3 过滤下推：本次 Assignment 的 scopes 原样传下去
    expect(knowledge.seen[0]?.grants).toEqual([SCOPE])
  })

  it('不在 allowlist 的工具不到达工具（17 §6.3）', async () => {
    const { source, connect } = setup()
    const executeTool = source.executeTool
    if (executeTool === undefined) throw new Error('no executor')
    const out = await executeTool({
      name: 'list_products',
      input: {},
      request: request(['get_order']),
    })
    expect(out).toMatchObject({ status: 'blocked' })
    expect(connect.steps).toEqual([])
  })
})

// ── 没连 Shopify（36 §3）──────────────────────────────────────────────

describe('没连 Shopify 就说没连', () => {
  it('回一句人话的 not_connected，一张令牌都不签', async () => {
    const { source, connect } = setup({ connected: false })
    const out = await call(source, 'get_order', { order_id: 'o_1' })
    expect(out.status).toBe('error')
    expect(out.reason).toContain('not_connected')
    expect(out.reason).toContain('连接')
    expect(connect.steps).toEqual([])
  })

  // WP62（51 §1 N0 ③）
  it('平台是 WooCommerce：连着一条 Shopify 也不认，人话说的是"这个平台还没接"', async () => {
    // 库里明明有一条活着的 shopify_admin 连接——但这个工作区的网站不是 Shopify 搭的，
    // 拿它去查订单查出来的是**别人家的数据**，所以一张令牌都不签
    const { source, connect } = setup({ platform: 'woocommerce' })
    const out = await call(source, 'get_order', { order_id: 'o_1' })
    expect(out.status).toBe('error')
    // 对模型是同一个错误码
    expect(out.reason).toContain('not_connected')
    // 对人是两件事："你还没连"与"我们还没做"
    expect(out.reason).toContain('这个平台还没接')
    expect(out.reason).toContain('WooCommerce')
    expect(out.reason).not.toContain('先去「连接」页')
    expect(connect.steps).toEqual([])
  })

  it('平台是"其它 / 自己搭的"：说的是没有店铺后台可以连', async () => {
    const { source } = setup({ platform: 'other' })
    const out = await call(source, 'list_orders')
    expect(out.status).toBe('error')
    expect(out.reason).toContain('没有店铺后台可以连')
  })

  it('readToken 回空串（拿不到写口，也不瞎签）', async () => {
    const { source, connect } = setup({ connected: false })
    expect(await source.readToken?.('asg_1')).toBe('')
    expect(connect.steps).toEqual([])
  })

  it('连上了就签一张只读的（含四个只读 Action、只含这条连接）', async () => {
    const { source, connect } = setup()
    const token = await source.readToken?.('asg_1')
    expect(token).toBe('tok_1')
    expect(connect.steps[0]).toMatchObject({
      kind: 'issue',
      assignment_id: 'asg_1',
      connections: ['cxn_shop_1'],
    })
    expect((connect.steps[0] as { actions: string[] }).actions).toHaveLength(4)
  })
})

// ── PII 不进事件（21 §1）──────────────────────────────────────────────

describe('事件里只有计数与原因码', () => {
  it('订单内容、邮箱、收件地址一个字节都不进事件', async () => {
    const { source, events } = setup()
    await call(source, 'get_order', { order_id: 'gid://shopify/Order/1001' })
    const text = dump(events)
    expect(text).not.toContain(CUSTOMER_EMAIL)
    expect(text).not.toContain(STREET)
    expect(text).not.toContain('129')
    expect(text).not.toContain('Anna')
    const tool = events.find((e) => e.type === 'tool.executed')
    expect(tool?.payload).toMatchObject({ tool: 'get_order', status: 'ok', provenance: 2 })
    const toolPayload = tool?.payload as { duration_ms?: number } | undefined
    expect(typeof toolPayload?.duration_ms).toBe('number')
    // 联系人事件里只有不可逆的 id
    const contact = events.find((e) => e.type === 'contact.noted')
    expect(contact?.payload).toMatchObject({ contact_id: contactIdOf(CUSTOMER_EMAIL) })
  })

  it('失败原因分 not_connected / upstream_error / not_found 三档', async () => {
    const offline = setup({ connected: false })
    await call(offline.source, 'get_order', { order_id: 'o_1' })
    expect(offline.events.at(-1)?.payload).toMatchObject({
      status: 'error',
      reason: 'not_connected',
    })

    const boom = setup()
    boom.connect.failNext = new UpstreamError('rate_limited', 'slow down')
    await call(boom.source, 'get_order', { order_id: 'o_1' })
    expect(boom.events.at(-1)?.payload).toMatchObject({ reason: 'upstream_error' })

    const missing = setup()
    missing.connect.replies.set('shopify_admin.get_order', { order: null })
    await call(missing.source, 'get_order', { order_id: 'o_nope' })
    expect(missing.events.at(-1)?.payload).toMatchObject({ reason: 'not_found' })
  })
})

// ── 收件人门禁（31 §3.3）──────────────────────────────────────────────

describe('contactOf：来信人就是台账里的联系人', () => {
  it('第一次建一条，第二次命中同一条（大小写、空格都算同一个人）', () => {
    const { source, events } = setup()
    const first = source.contactOf?.(CUSTOMER_EMAIL)
    expect(first).toEqual({ type: 'contact', id: contactIdOf(CUSTOMER_EMAIL) })
    const again = source.contactOf?.(`  ${CUSTOMER_EMAIL.toUpperCase()} `)
    expect(again).toEqual(first)
    expect(source.contacts()).toHaveLength(1)
    expect(events.filter((e) => e.type === 'contact.noted')).toHaveLength(1)
  })

  it('先来信、后 get_order：用的仍是同一个 ref（不造第二份）', async () => {
    const { source } = setup()
    const fromInbound = source.contactOf?.(CUSTOMER_EMAIL)
    const out = await call(source, 'get_order', { order_id: 'gid://shopify/Order/1001' })
    // provenance 里的联系人 = contactOf 回的那一个，否则收件人门禁永远过不去
    expect(out.provenance?.[1]).toEqual(fromInbound)
    expect(source.contacts()).toHaveLength(1)
  })

  it('先 get_order、后来信：同样是同一个 ref，而且认得出名字', async () => {
    const { source } = setup()
    const out = await call(source, 'get_order', { order_id: 'gid://shopify/Order/1001' })
    expect(source.contactOf?.(CUSTOMER_EMAIL)).toEqual(out.provenance?.[1])
    expect(source.label?.(out.provenance?.[1] as { type: 'contact'; id: string })).toBe('Anna Lee')
  })

  it('空邮箱不建记录', () => {
    const { source } = setup()
    expect(source.contactOf?.('   ')).toBeUndefined()
    expect(source.contacts()).toHaveLength(0)
  })
})

// ── record / label ─────────────────────────────────────────────────────

describe('record 与 label', () => {
  it('订单：缓存命中不打上游，没命中经 get_order 拉一张', async () => {
    const { source, connect } = setup()
    // 没命中 → 现拉（record 回的是 Promise，buildRequest 会 await）
    const fetched = await source.record?.({ type: 'order', id: 'gid://shopify/Order/1001' })
    expect(fetched).toMatchObject({ name: '#1001', total_price: 129 })
    expect(connect.steps.filter((s) => s.kind === 'execute')).toHaveLength(1)
    // 再问一次 → 命中缓存，上游一次都不打
    const cached = await source.record?.({ type: 'order', id: 'gid://shopify/Order/1001' })
    expect(cached).toMatchObject({ name: '#1001' })
    expect(connect.steps.filter((s) => s.kind === 'execute')).toHaveLength(1)
    expect(source.label?.({ type: 'order', id: 'gid://shopify/Order/1001' })).toBe('订单 #1001')
  })

  it('活数据源缓存命中就直接用，一次上游都不打', async () => {
    const connect = fakeConnect()
    const source = createConnectRecordSource({
      connect,
      connections: {
        liveConnections: () => [
          { id: 'cxn_shop_1', service: 'shopify_admin', status: 'active' as const },
        ],
      },
      clock: makeClock(),
      workspace_id: WS,
      liveData: {
        orders: () => [
          {
            id: 'o_live',
            name: '#2002',
            email: CUSTOMER_EMAIL,
            currency: 'USD',
            created_at: '2026-09-13T00:00:00.000Z',
            total_price: 42,
            refunded_amount: 0,
            financial_status: 'paid',
            fulfillment_status: 'unfulfilled',
          },
        ],
      },
    })
    expect(await source.record?.({ type: 'order', id: 'o_live' })).toMatchObject({ name: '#2002' })
    expect(connect.steps).toEqual([])
    expect(source.label?.({ type: 'order', id: 'o_live' })).toBe('订单 #2002')
  })

  it('商品、知识卡、认不出来的三种', async () => {
    const hits: RetrievalHit[] = [
      {
        fact_card_id: 'fc_return',
        score: 0.9,
        layer: 'company',
        statement_redacted: '退货窗口 30 天',
        provenance_summary: 'policy',
        sensitivity: 'internal',
      },
    ]
    const { source } = setup({ hits })
    await call(source, 'get_product', { product_id: 'p_1' })
    expect(source.record?.({ type: 'product', id: 'p_1' })).toMatchObject({ title: '3C Charger' })
    expect(source.label?.({ type: 'product', id: 'p_1' })).toBe('3C Charger')

    await call(source, 'search_policies', { query: '退货' })
    expect(source.record?.({ type: 'fact_card', id: 'fc_return' })).toMatchObject({
      statement: '退货窗口 30 天',
    })

    expect(source.record?.({ type: 'campaign', id: 'x' })).toBeUndefined()
    expect(source.label?.({ type: 'campaign', id: 'x' })).toBeUndefined()
    // 拉不到就回 undefined（不编造）
    const other = setup({ connected: false })
    expect(await other.source.record?.({ type: 'order', id: 'o_missing' })).toBeUndefined()
  })
})

// ── 服务进程装配（交付二）─────────────────────────────────────────────

describe('真环境自动装上记录源（WP53 交付二）', () => {
  it('一次事项运行里的工具调用不再是 no_tool_executor', async () => {
    const server = await createServer({
      quiet: true,
      clock: { now: () => T0 },
      random: () => 0.5,
      env: { AGENTSWS_OWNER_EMAIL: 'luoye@example.com' },
    })
    try {
      const matter = server.work.createMatter({
        kind: 'conversation',
        title: '与客户的往来',
        // 钉一张订单：运行时会把它注进上下文，运行时里的工具循环就会去查它
        pinned: [{ type: 'order', id: 'ord_1001' }],
      })
      await server.work.say(matter.id, {
        person_id: server.bootstrap.person.id,
        assignment_id: server.bootstrap.ownerAssignment.id,
        text: '客户问订单 #1001 什么时候到',
      })

      const events: EventEnvelope[] = []
      for await (const e of server.kernel.eventLog.read({
        workspace_id: server.bootstrap.workspace.id,
        limit: 2000,
      })) {
        events.push(e)
      }
      const results = events.filter((e) => e.type === 'tool.result')
      expect(results.length).toBeGreaterThan(0)
      // 09-14 真店验收里就是这一句
      expect(
        results.some((e) => (e.payload as { reason?: string }).reason === 'no_tool_executor'),
      ).toBe(false)
      // 记录源真的接上了：没连 Shopify，它说的是"没连"，不是"没有执行器"
      const executed = events.filter((e) => e.type === 'tool.executed')
      expect(executed.length).toBeGreaterThan(0)
      expect(executed[0]?.payload).toMatchObject({ status: 'error', reason: 'not_connected' })
    } finally {
      await server.close()
    }
  })
})
