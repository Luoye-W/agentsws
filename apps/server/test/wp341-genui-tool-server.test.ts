/**
 * WP341（决策 847）：对话里点「调工具」的 genui 按钮——同 WP261 的真装配线（路由 → 端口 → 运行时 → 店铺工具 →
 * 变更账本 → 执行器），模型那一跳 stub、店是进程内替身，不联网、不碰真店。钉住：
 * - 只读的当场跑（结果回来就地画），时间线记一句；
 * - 会改外部的**只出审批卡**、账本里没有已施行、店里没变；卡挂进这件事的时间线（对话里就地批）；
 * - 在对话里批了（同一个审批对象），卡片流那条同步变已决；
 * - 不在这条职责里的工具、直接写外部的不收；别人的事项点不了。
 */
import type { ApprovalItem, Assignment, GenuiToolOutcome, MatterEvent } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import type { ProbeExec } from '../src/platform-cli.js'
import {
  demoShop,
  type FakeShop,
  shopAdminRunStandIn,
  shopAuthSpawnStandIn,
} from '../src/shop-admin-stand-in.js'

const T0 = '2026-10-08T09:00:00.000Z'
const SHOP = 'rollout-test.myshopify.com'

let server: Server
let store: Assignment
let shop: FakeShop
let installed: boolean
let now = T0

const call = async (
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<Response> => {
  const headers = new Headers({
    Authorization: `Bearer ${token ?? server.bootstrap.internalToken}`,
  })
  headers.set('X-Assignment', store.id)
  if (body !== undefined) headers.set('content-type', 'application/json')
  return server.gateway.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
}
const dataOf = async <T>(res: Response): Promise<T> => {
  const parsed = (await res.json()) as { data?: unknown; code?: string; message?: string }
  if (parsed.data === undefined)
    throw new Error(`没有 data：${res.status} ${parsed.code} ${parsed.message}`)
  return parsed.data as T
}
type View = {
  applicable: boolean
  state?: string
  store?: string
  missing: string[]
  scopes_granted: string[]
  expires_at?: string
  job?: { phase: string }
}
const view = async () => dataOf<View>(await call('GET', '/v1/shop-admin?roles=dtc.store'))

beforeEach(async () => {
  installed = false
  now = T0
  shop = demoShop()
  const exec: ProbeExec = async (bin) => {
    if (bin === 'node') return { ok: true, stdout: 'v22.12.0' }
    return installed
      ? { ok: true, stdout: 'Current Shopify CLI version: 4.8.5' }
      : { ok: false, stdout: '', missing: true }
  }
  server = await createServer({
    quiet: true,
    clock: { now: () => now },
    random: () => 0.42,
    scheduleIntervalMs: 0,
    tokenRefreshIntervalMs: 0,
    mdns: () => ({ mdns: { publish() {}, browse() {}, stop() {} } }),
    env: { AGENTSWS_OWNER_EMAIL: 'owner@example.test' },
    platformCliExec: exec,
    shopAdmin: {
      run: shopAdminRunStandIn(shop),
      spawn: shopAuthSpawnStandIn(shop, { delayMs: 20 }),
    },
  })
  const ws = server.bootstrap.workspace.id
  store = server.roles.assignments.create({
    person_id: server.bootstrap.person.id,
    workspace_id: ws,
    role_id: 'dtc.store',
    granted_by: server.bootstrap.person.id,
    ranges: [{ kind: 'brand', id: ws }],
  })
  const owner = server.bootstrap.ownerAssignment.id
  const res = await server.gateway.fetch(
    new Request('http://127.0.0.1/v1/workspace/profile', {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${server.bootstrap.internalToken}`,
        'X-Assignment': owner,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ legal_name: 'Rollout', storefront_platform: 'shopify' }),
    }),
  )
  await dataOf(res)
})

afterEach(async () => {
  await server.close()
})

async function authorize(): Promise<void> {
  installed = true
  await call('POST', '/v1/platform-kit/cli/check', {})
  await server.gateway.fetch(
    new Request('http://127.0.0.1/v1/site/theme?fresh=1', {
      headers: {
        Authorization: `Bearer ${server.bootstrap.internalToken}`,
        'X-Assignment': store.id,
      },
    }),
  )
  await call('PUT', '/v1/shop-admin/store', { store: SHOP, roles: ['dtc.store'] })
  await call('POST', '/v1/shop-admin/run', { action: 'authorize', roles: ['dtc.store'] })
  for (let i = 0; i < 200 && (await view()).state !== 'authorized'; i++)
    await new Promise((r) => setTimeout(r, 10))
  expect((await view()).state).toBe('authorized')
}

const click = async (matter_id: string, input: Record<string, unknown>) =>
  dataOf<GenuiToolOutcome>(await call('POST', `/v1/matters/${matter_id}/genui-tool`, input))

const timeline = async (matter_id: string) =>
  (await dataOf<{ events: MatterEvent[] }>(await call('GET', `/v1/matters/${matter_id}/timeline`)))
    .events

describe('WP341 对话里的工具按钮', () => {
  it('只读当场跑；改价只出卡、账本没施行；在对话里批了，卡片流同一张变已决', async () => {
    await authorize()
    const out = await dataOf<{ run_id?: string; matter: { id: string } }>(
      await call('POST', `/v1/positions/${store.id}/matters`, {
        title: '把第一个商品的标题改一下',
        role_id: 'dtc.store',
      }),
    )
    const matter_id = out.matter.id
    const run_id = out.run_id ?? ''
    for (let i = 0; i < 200 && server.runtime?.activeRuns().length !== 0; i++)
      await new Promise((r) => setTimeout(r, 10))

    // ① 只读：当场跑，数据回来；时间线记一句
    const read = await click(matter_id, {
      tool: 'shop_list_products',
      args: {},
      label: '看看店里的商品',
      run_id,
    })
    expect(read).toMatchObject({ effect: 'read', status: 'ok' })
    expect(JSON.stringify(read.data)).toContain('Rollout 折叠收纳箱')
    expect((await timeline(matter_id)).map((e) => e.text)).toContain(
      '你点了「看看店里的商品」，查好了。',
    )

    // ② 会改外部：只出卡，店里不变、账本没有已施行
    const before = shop.products[0]?.variants[0]?.price
    const staged = await click(matter_id, {
      tool: 'shop_set_price',
      args: {
        product_id: 'gid://shopify/Product/1001',
        variant_id: 'gid://shopify/ProductVariant/2001',
        price: 25.9,
      },
      label: '大号改到 25.9',
      run_id,
    })
    expect(staged.effect).toBe('staged')
    expect(staged.approval_item_ids).toHaveLength(1)
    const card_id = staged.approval_item_ids?.[0] ?? ''
    expect(shop.products[0]?.variants[0]?.price).toBe(before)
    const types = () =>
      server.kernel.eventLog
        .readSync({ workspace_id: server.bootstrap.workspace.id })
        .map((e) => e.type)
    expect(types()).not.toContain('shop_ops.applied')
    const card = await server.txn.approvals.get(card_id)
    expect(card?.state).toBe('pending')
    // 卡挂进这件事的时间线（对话里就地画），卡片流里同一张
    const events = await timeline(matter_id)
    expect(events.filter((e) => e.approval_item_id === card_id && e.kind === 'card')).toHaveLength(
      1,
    )
    const deck = async (): Promise<ApprovalItem[]> =>
      server.txn.approvals.queue({
        workspace_id: server.bootstrap.workspace.id,
        person_id: server.bootstrap.person.id,
        lane: 'mine',
      })
    expect((await deck()).map((a) => a.id)).toContain(card_id)

    // ③ 在对话里批（同一个审批对象）→ 卡片流那条同步变已决；批之前没施行
    const decided = await call('POST', `/v1/approvals/${card_id}/decide`, {
      action: 'approve',
      version: card?.version,
    })
    expect(decided.status).toBe(200)
    expect((await server.txn.approvals.get(card_id))?.state).not.toBe('pending')
    expect((await deck()).find((a) => a.id === card_id && a.state === 'pending')).toBeUndefined()
  })

  it('不在这条职责里的工具、直接写外部的不收；别人的事项点不了', async () => {
    await authorize()
    const out = await dataOf<{ run_id?: string; matter: { id: string } }>(
      await call('POST', `/v1/positions/${store.id}/matters`, {
        title: '把第一个商品的标题改一下',
        role_id: 'dtc.store',
      }),
    )
    const refused = await click(out.matter.id, {
      tool: 'delete_all_products',
      args: {},
      label: '全删了',
      ...(out.run_id === undefined ? {} : { run_id: out.run_id }),
    })
    expect(refused).toMatchObject({ effect: 'refused', status: 'blocked' })
    const other = server.work.createMatter({
      title: '别人的事',
      participants: ['per_someone_else' as never],
    })
    const res = await call('POST', `/v1/matters/${other.id}/genui-tool`, {
      tool: 'shop_list_products',
      args: {},
      label: '看',
    })
    expect(res.status).toBe(403)
  })
})
