/**
 * 36 §5.7 的端到端用例：
 *
 * 打开首页 → 看到「退货窗口内」场景真产生的回复草稿卡与退款变更卡；
 * 独立站运营岗位的核心数据条有真数字（来自 mock connect 的订单）；
 * 点「发送 / 批准」走 14 的 decide；**事件日志里没有任何 `model.*` 事件**。
 */
import { resolve } from 'node:path'
import type { DeckCard, PositionTiles, StatTile } from '@agentsws/deck'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDemo, DEMO_SECOND_BRAND, type Demo, demoClockStart } from '../src/demo.js'

const ROOT = resolve(import.meta.dirname, '../../..')

let demo: Demo

const call = async (
  path: string,
  init: { method?: string; body?: unknown; assignment?: string } = {},
): Promise<Response> => {
  const headers = new Headers({
    Authorization: `Bearer ${demo.server.bootstrap.internalToken}`,
  })
  if (init.assignment !== undefined) headers.set('X-Assignment', init.assignment)
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  return demo.server.gateway.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method: init.method ?? 'GET',
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
  )
}

const data = async <T>(res: Response): Promise<T> => {
  expect(res.status).toBe(200)
  return ((await res.json()) as { data: T }).data
}

beforeAll(async () => {
  demo = await createDemo({
    root: ROOT,
    quiet: true,
    staticDir: resolve(ROOT, 'apps/workstation/dist'),
  })
}, 60_000)

afterAll(async () => {
  await demo.close()
})

describe('agentsws demo（合成世界当后端）', () => {
  it('岗位 = 世界里的 Assignment；身份就是 pack 里的人', async () => {
    expect(demo.server.bootstrap.person.id).toBe(demo.world.roleHolder)
    expect(demo.server.bootstrap.workspace.id).toBe(demo.world.workspace_id)
    const out = await data<{ positions: { role_id: string; role_name: string }[] }>(
      await call('/v1/positions', { assignment: demo.world.assignment.id }),
    )
    const roles = out.positions.map((p) => p.role_id).sort()
    expect(roles).toContain('dtc.support')
    expect(roles).toContain('dtc.analytics')
  })

  it('首页有场景真产生的回复草稿卡与退款变更卡', async () => {
    const home = await data<{ queue: DeckCard[]; alerts: DeckCard[]; estimated_minutes: number }>(
      await call('/v1/home', { assignment: demo.world.assignment.id }),
    )
    const cards = [...home.queue, ...home.alerts]
    const kinds = cards.map((c) => c.kind)
    expect(kinds).toContain('outbound_draft')
    expect(kinds).toContain('staged_change')
    // 36 §2.2：回复草稿卡的动词是「发送 / 不发 / 指导」
    const draft = cards.find((c) => c.kind === 'outbound_draft')
    expect(draft?.action_labels?.approve).toBe('发送')
    expect(draft?.customer_label).toBe('Anna Meyer')
    // 退款卡的金额来自结构化字段。
    // WP63 起 demo 里还有几条店铺侧的变更卡（改价 / 上架），所以要**按目标挑**——
    // 只按 kind 挑会随便拿到一张改价卡，那张上本来就没有金额高亮。
    const refund = cards.find((c) => c.kind === 'staged_change' && c.title.includes('退款'))
    expect(refund?.highlights.some((h) => h.type === 'amount')).toBe(true)
    expect(home.estimated_minutes).toBeGreaterThan(0)
  })

  it('选择题卡在队列里，而且带 options', async () => {
    const home = await data<{ queue: DeckCard[]; alerts: DeckCard[] }>(
      await call('/v1/home', { assignment: demo.world.assignment.id }),
    )
    const question = [...home.queue, ...home.alerts].find((c) => c.kind === 'policy_change')
    expect(question?.options?.map((o) => o.id)).toEqual(['grace_7', 'store_credit', 'refuse'])
  })

  it('独立站运营的数据条有真数字（来自 mock connect 的订单）', async () => {
    const home = await data<{ tiles: PositionTiles[] }>(
      await call('/v1/home?range=last_7d', { assignment: demo.world.assignment.id }),
    )
    const ops = home.tiles.find((t) => t.role_id === 'dtc.analytics')
    expect(ops).toBeDefined()
    expect(ops?.tiles.map((t: StatTile) => t.id)).toEqual([
      'sales_total',
      'orders_count',
      'refunds_total',
      'conversion_rate',
    ])
    const sales = ops?.tiles[0]
    expect(sales?.status).toBe('ok')
    expect(sales?.value).toBeGreaterThan(0)
    expect(sales?.currency).toBe('USD')
    // 没接 GA4 → 转化率是「去连接」，不是编一个 0
    expect(ops?.tiles[3]?.status).toBe('not_connected')
    // 没有默认数字块的职责不出数据条（首页形状不随岗位数变）
    expect(home.tiles.some((t) => t.role_id === 'common.owner')).toBe(false)
  })

  it('选择题卡裸 approve 被拒（OPTION_REQUIRED）', async () => {
    const home = await data<{ queue: DeckCard[]; alerts: DeckCard[] }>(
      await call('/v1/home', { assignment: demo.world.assignment.id }),
    )
    const question = [...home.queue, ...home.alerts].find((c) => c.kind === 'policy_change')
    const res = await call(`/v1/approvals/${question?.id}/decide`, {
      method: 'POST',
      assignment: demo.world.assignment.id,
      body: { action: 'approve' },
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { code: string; details: { reason: string } }
    expect(body.code).toBe('invalid_input')
    expect(body.details.reason).toBe('OPTION_REQUIRED')
  })

  it('点「批准」走 decide，退款真的被施行；全程没有任何 model.* 事件', async () => {
    const home = await data<{ queue: DeckCard[]; alerts: DeckCard[] }>(
      await call('/v1/home', { assignment: demo.world.assignment.id }),
    )
    // WP63 起首页上还有几条店铺侧的变更卡（首页是**跨岗位**的队列）——
    // 只按 kind 挑会随手点掉一张改价卡，"退款真的被施行"就无从谈起
    const refund = [...home.queue, ...home.alerts].find(
      (c) => c.kind === 'staged_change' && c.title.includes('退款'),
    )
    expect(refund).toBeDefined()

    const decided = await call(`/v1/approvals/${refund?.id}/decide`, {
      method: 'POST',
      assignment: demo.world.assignment.id,
      body: { action: 'approve', version: refund?.version },
    })
    expect(decided.status).toBe(200)

    // 15 §5：通过 ≠ 施行；执行器过了取消窗口才动手
    await demo.drain()
    await demo.drain()
    const applied = demo.world.txn.runtime.store
      .listApprovals({ workspace_id: demo.world.workspace_id })
      .find((i) => i.id === refund?.id)
    expect(['approved', 'applying', 'applied']).toContain(applied?.state)

    // 36 §5.7 / 29 §7 用例 6：动作按钮不产生任何模型调用
    const modelEvents = demo.world.events.filter((e) => e.type.startsWith('model.'))
    expect(modelEvents).toEqual([])
    expect(demo.world.events.some((e) => e.type === 'approval.decided')).toBe(true)
  })

  it('已决定的卡再点一次「批准」被动作矩阵挡住', async () => {
    const cards = await data<{ cards: DeckCard[] }>(
      await call(`/v1/positions/${demo.world.assignment.id}/cards`, {
        assignment: demo.world.assignment.id,
      }),
    )
    // 队列里已经没有那条退款卡了（它不在 pending / in_review）。
    // 店铺那几条待审改动仍在队列里——它们是另一回事，别被顺手算进来（WP63）
    expect(cards.cards.some((c) => c.kind === 'staged_change' && c.title.includes('退款'))).toBe(
      false,
    )
  })

  it('岗位面板按数据源分块；未连接的数据源不给完整报告链接', async () => {
    // 售后客服：只有店铺后台（它的职责里没有 analytics 域，19 §3 过滤下推）
    const care = await data<{ sections: { source: string; connected: boolean }[] }>(
      await call(`/v1/positions/${demo.world.assignment.id}/view`, {
        assignment: demo.world.assignment.id,
      }),
    )
    expect(care.sections.map((s) => s.source)).toEqual(['shop'])
    expect(care.sections[0]?.connected).toBe(true)

    // 独立站运营：店铺后台 / GA4 / Search Console 三块，后两块未连接
    const ops = demo.world.roles.assignments
      .listByPerson(demo.world.roleHolder, { workspace_id: demo.world.workspace_id })
      .find((a) => a.role_id === 'dtc.analytics')
    const view = await data<{
      sections: { source: string; connected: boolean; report_url?: string }[]
    }>(await call(`/v1/positions/${ops?.id}/view`, { assignment: ops?.id ?? '' }))
    expect(view.sections.map((s) => s.source)).toEqual(['shop', 'ga4', 'gsc'])
    expect(view.sections[1]?.connected).toBe(false)
    expect(view.sections[1]?.report_url).toBeUndefined()
  })

  /**
   * WP77（59 §3）：**建站岗位在 demo 里不是空的**——截图 `docs/assets/workstation/
   * site-position.png` 里那一屏的可断言版本。
   *
   * 钉两件事：面板上一块店铺后台的积木都没有（四条职责的 scopes 里订单与分析
   * 是只读的，19 §3 过滤下推），以及上线检查单上**真的有缺项**（`seedDemoSite`
   * 造的是一家刚开起来、还差几项的店——全绿的清单演示不出"缺项高亮"）。
   */
  it('建站岗位的面板只有建站那一块，检查单上真的有缺项', async () => {
    const build = demo.world.roles.assignments
      .listByPerson(demo.world.roleHolder, { workspace_id: demo.world.workspace_id })
      .find((a) => a.role_id === 'site.shopify-build')
    expect(build).toBeDefined()
    const view = await data<{ sections: { source: string; connected: boolean }[] }>(
      await call(`/v1/positions/${build?.id}/view`, { assignment: build?.id ?? '' }),
    )
    // 建站库是我们自己的库，永远算连上；店铺后台一块都没有
    expect(view.sections.map((s) => s.source)).toEqual(['site'])
    expect(view.sections[0]?.connected).toBe(true)

    const block = await data<{
      status: string
      payload: { rows: { item: string; state: string }[] }
    }>(await call('/v1/blocks/site.checklist/data', { assignment: build?.id ?? '' }))
    expect(block.status).toBe('ok')
    // 八项全在，运费那一项是缺的——而且面板上写的是"买不成"，不是一个色块
    expect(block.payload.rows).toHaveLength(8)
    expect(block.payload.rows.find((r) => r.item === '运费')?.state).toBe('缺（买不成）')
    // 支付与税是过了的：那两项建站岗位改不了，留成缺口只会刷屏同一句话
    expect(block.payload.rows.find((r) => r.item === '收款方式')?.state).toBe('过了')
  })

  it('积木数据过 29 §2 的管线；未注册的积木被拒', async () => {
    const block = await data<{ status: string; payload: { rows: unknown[] } }>(
      await call('/v1/blocks/shop.recent_orders/data?range=last_7d', {
        assignment: demo.world.assignment.id,
      }),
    )
    expect(block.status).toBe('ok')
    expect(block.payload.rows.length).toBeGreaterThan(0)

    const bad = await call('/v1/blocks/evil.block/data', {
      assignment: demo.world.assignment.id,
    })
    expect(bad.status).toBe(400)
  })

  it('工作台构建产物由服务进程托管，并给 demo 一份自动登录的 bootstrap', async () => {
    const bootstrap = await demo.server.gateway.fetch(
      new Request('http://127.0.0.1/app/bootstrap.json'),
    )
    expect(bootstrap.status).toBe(200)
    const body = (await bootstrap.json()) as { owner_email: string; demo: boolean }
    expect(body.owner_email).toBe(demo.server.bootstrap.person.email)
    expect(body.demo).toBe(true)

    // SPA fallback：没有后缀的路径回 index.html（构建过才有）
    const page = await demo.server.gateway.fetch(new Request('http://127.0.0.1/positions/asg_x'))
    expect([200, 404]).toContain(page.status)

    // /v1 仍然归网关，静态托管不抢
    const missing = await demo.server.gateway.fetch(new Request('http://127.0.0.1/v1/nope'))
    expect(missing.status).toBe(404)
    expect(((await missing.json()) as { code: string }).code).toBe('not_found')
  })
})

/**
 * WP66（52 O1）：`agentsws demo --two-brands` 把"一个进程装多套品牌模块"演出来。
 *
 * 这一档只钉两件事：两行**各自**算出自己的三个数，以及两边的数据互相看不见。
 */
describe('agentsws demo --two-brands（WP66）', () => {
  it('品牌一览两行，各自的今日销售与待审卡都是自己算的', { timeout: 60_000 }, async () => {
    const two = await createDemo({ root: ROOT, quiet: true, twoBrands: true })
    try {
      const actor = {
        person_id: two.server.bootstrap.person.id,
        workspace_id: two.server.bootstrap.workspace.id,
        assignment_id: two.server.bootstrap.ownerAssignment.id,
        role_id: two.server.bootstrap.ownerAssignment.role_id,
      }
      const org = two.server.identity.organizationsOf(actor.person_id)[0]
      if (org === undefined) throw new Error('demo 里应该有一个组织')
      const rows = await two.server.organizations.port.brands(actor, org.id)
      expect(rows.map((r) => r.name).sort()).toEqual(['NordVolt Gear', DEMO_SECOND_BRAND].sort())
      const first = rows.find((r) => r.current)
      const second = rows.find((r) => r.name === DEMO_SECOND_BRAND)
      if (first === undefined || second === undefined) throw new Error('两行都该在')
      // 两个品牌各有各的数据源：第二个品牌今天真有三张单
      expect(second.sales_today?.amount).toBe(467)
      // 第一个品牌那一格也算得出来（合成世界那批订单不在"今天"，所以是 0）
      expect(first.sales_today).toBeDefined()
      // 待审卡是两条队列各自数出来的，不是同一份显示两遍
      expect(first.pending_approvals).toBeGreaterThan(0)
      expect(second.pending_approvals).toBe(1)
    } finally {
      await two.close()
    }
  })
})

/**
 * WP100：**demo 的"今天"就是启动那天**。
 *
 * 之前 demo 的钟停在场景 yml 写死的 2026-09-07，而界面读的是这台机器的真实时间——
 * 于是卡片满屏"已过期"、日历把所有到期堆在同一天。挪的只有 demo 这一处起点：
 * 场景 yml、`packs/` 下的文件、`agentsws simulate` 的虚拟时钟一个字没动。
 */
describe('demo 的钟锚在启动那天（WP100）', () => {
  it('整天平移：钟点照旧是场景那个钟点，只有日期换成今天', () => {
    // 场景是 2026-09-07 09:00+08:00，启动那天是 09-18 → 还是 09:00+08:00，只是 09-18
    expect(
      demoClockStart('2026-09-07T09:00:00+08:00', Date.parse('2026-09-18T05:00:00+08:00')),
    ).toBe('2026-09-18T01:00:00.000Z')
    // 同一天启动 = 一点不挪
    expect(
      demoClockStart('2026-09-07T09:00:00+08:00', Date.parse('2026-09-07T23:00:00+08:00')),
    ).toBe('2026-09-07T01:00:00.000Z')
    // 日界按场景自己那个时区算（东八区的 00:30 还算这一天，不按 UTC 提前一天）
    expect(
      demoClockStart('2026-09-07T09:00:00+08:00', Date.parse('2026-09-18T00:30:00+08:00')),
    ).toBe('2026-09-18T01:00:00.000Z')
  })

  it('跑起来的这个 demo，世界的钟就在今天（不是 2026-09-07）', () => {
    const worldNow = Date.parse(demo.world.clock.now())
    expect(Math.abs(worldNow - Date.now())).toBeLessThan(2 * 24 * 3_600_000)
  })

  it('摆拍数据跟着挪同样的天数：那一单还是"钟点之前 N 天"下的', () => {
    const order = demo.world.connect.state.orders.find((o) => o.id === 'ord_1001')
    if (order === undefined) throw new Error('demo 里应该有 #1001 这一单')
    // pack 里 #1001 是 2026-08-28 下的、09-04 签收，场景开钟是 09-07 09:00+08。
    // 「启动那天」要跟 demo 起来时用的同一个钟——demo 是在这个文件顶部 setup 时起的，
    // 那一刻的 Date.now() 才是它挪数据用的锚。这里若再取一次 Date.now()，跨过午夜跑
    // 这条测试就会多出一天（09-24 真红过：expected 11 to be 10）。
    const start = Date.parse(
      demoClockStart('2026-09-07T09:00:00+08:00', Date.parse(demo.world.clock.now())),
    )
    const days = (iso: string): number => Math.round((start - Date.parse(iso)) / (24 * 3_600_000))
    expect(days(order.created_at)).toBe(10)
    expect(order.delivered_at).toBeDefined()
    expect(days(order.delivered_at as string)).toBe(3)
  })
})
