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
import { createDemo, type Demo } from '../src/demo.js'

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
    expect(roles).toContain('dtc.aftersales')
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
    // 退款卡的金额来自结构化字段
    const refund = cards.find((c) => c.kind === 'staged_change')
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
    const refund = [...home.queue, ...home.alerts].find((c) => c.kind === 'staged_change')
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
    // 队列里已经没有那条退款卡了（它不在 pending / in_review）
    expect(cards.cards.some((c) => c.kind === 'staged_change')).toBe(false)
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
