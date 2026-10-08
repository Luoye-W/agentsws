/**
 * WP261 端到端（真装配线：路由 → 端口 → 店铺授权 → 运行时 → 运营工具 → 变更账本 → 执行器）。
 *
 * 模型那一跳是 stub；`shopify store auth / execute` 是进程内替身 + 假店（`shop-admin-stand-in.ts`）——不联网、不碰真店。
 * 钉住：岗位页那一行 没装 → 不知道哪家店 → 没授权 → 授权中 → 已授权（权限、过期时间）；AI 运行调不了授权；
 * 没授权时工具面里没有运营工具；授权后「改商品标题」→ 只出一张卡、店里没变；人批了过撤回窗口 → 执行器改店、读回。
 */
import type { Assignment, RunEvent } from '@agentsws/contracts'
import { SHOP_TOOL_NAMES } from '@agentsws/stand-ins'
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
const runEvents = (run_id: string) =>
  server.kernel.eventLog
    .readSync({ workspace_id: server.bootstrap.workspace.id })
    .filter((e) => e.correlation?.run_id === run_id)
const toolsCalled = (run_id: string): string[] =>
  runEvents(run_id)
    .filter((e) => e.type === 'tool.call')
    .map((e) => (e.payload as Extract<RunEvent, { type: 'tool.call' }>).tool)

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

describe('WP261 独立站运营端到端（stub）', () => {
  it('授权那一行 → 没授权时没有运营工具 → 授权后改商品只出卡 → 批了才改店、读回', async () => {
    // ① 那一行：没装 → 不知道哪家店 → 没授权
    expect((await view()).state).toBe('no_cli')
    installed = true
    await call('POST', '/v1/platform-kit/cli/check', {})
    const noStore = await dataOf<View>(await call('GET', '/v1/shop-admin?roles=dtc.store'))
    expect(['no_store', 'no_cli']).toContain(noStore.state)
    // 检测有缓存：fresh 一次
    await server.gateway.fetch(
      new Request('http://127.0.0.1/v1/site/theme?fresh=1', {
        headers: {
          Authorization: `Bearer ${server.bootstrap.internalToken}`,
          'X-Assignment': store.id,
        },
      }),
    )
    expect(
      (
        await dataOf<View>(
          await call('PUT', '/v1/shop-admin/store', { store: SHOP, roles: ['dtc.store'] }),
        )
      ).state,
    ).toBe('unauthorized')

    // ② 没授权：工具面里一个运营工具都没有
    const before = await dataOf<{ run_id?: string }>(
      await call('POST', `/v1/positions/${store.id}/matters`, {
        title: '把收纳箱的商品标题改一下',
        role_id: 'dtc.store',
      }),
    )
    // （stub 的剧本只在工具面里有运营工具时才去调：一个都没调 = 一个都没摆）
    expect(toolsCalled(before.run_id ?? '').filter((t) => SHOP_TOOL_NAMES.includes(t))).toEqual([])

    // ③ AI 运行调不了授权；人点了才起
    const { person, workspace } = server.bootstrap
    const runtimeToken = server.identity.issue('runtime', person.id, workspace.id).token
    expect(
      (
        await call(
          'POST',
          '/v1/shop-admin/run',
          { action: 'authorize', roles: ['dtc.store'] },
          runtimeToken,
        )
      ).status,
    ).toBe(403)
    const started = await dataOf<View>(
      await call('POST', '/v1/shop-admin/run', { action: 'authorize', roles: ['dtc.store'] }),
    )
    expect(started.state).toBe('authorizing')
    for (let i = 0; i < 100 && (await view()).state !== 'authorized'; i++)
      await new Promise((r) => setTimeout(r, 10))
    const ok = await view()
    expect(ok).toMatchObject({ state: 'authorized', store: SHOP, missing: [] })
    expect(ok.scopes_granted).toEqual(
      expect.arrayContaining(['write_products', 'read_products', 'write_discounts']),
    )
    expect(ok.expires_at).toBeDefined()

    // ④ 授权后：「改商品标题」→ 列 → 读 → 只出一张卡；店里没变
    const out = await dataOf<{ run_id?: string }>(
      await call('POST', `/v1/positions/${store.id}/matters`, {
        title: '把第一个商品的标题改一下',
        role_id: 'dtc.store',
      }),
    )
    expect(toolsCalled(out.run_id ?? '')).toEqual([
      'shop_list_products',
      'shop_get_product',
      'shop_save_product',
    ])
    expect(shop.products[0]?.title).toBe('Rollout 折叠收纳箱')
    const pending = (
      await server.txn.approvals.queue({
        workspace_id: server.bootstrap.workspace.id,
        person_id: server.bootstrap.person.id,
        lane: 'mine',
      })
    ).filter((a) => (a.payload as { kind?: string } | undefined)?.kind === 'listing_edit')
    if (pending.length !== 1) {
      const res = runEvents(out.run_id ?? '')
        .filter((e) => e.type === 'tool.result' || e.type === 'run.completed')
        .map((e) => JSON.stringify(e.payload).slice(0, 400))
      throw new Error(res.join('\n'))
    }
    expect(pending).toHaveLength(1)
    const card = pending[0]
    expect(card?.state).toBe('pending')
    expect(card?.title).toBe('改商品「Rollout 折叠收纳箱」：标题')
    expect(card?.summary).toContain('标题：Rollout 折叠收纳箱 → Rollout 折叠收纳箱（新版）')

    // ⑤ 人批了、过撤回窗口：执行器去改店，读回对上
    const id = card?.id ?? ''
    await server.txn.approvals.decide(id, card?.deliveries[0]?.to as never, {
      action: 'approve',
      decision_token: card?.deliveries[0]?.decision_token ?? '',
      via: 'workstation',
    })
    now = new Date(Date.parse(T0) + 60 * 60 * 1000).toISOString()
    await server.txn.executor.applyApproval(id)
    expect(shop.products[0]?.title).toBe('Rollout 折叠收纳箱（新版）')
    const types = server.kernel.eventLog
      .readSync({ workspace_id: server.bootstrap.workspace.id })
      .map((e) => e.type)
    expect(types).toContain('shop_ops.applied')
    expect(types).toContain('shop_admin.auth_finished')
  })
})
