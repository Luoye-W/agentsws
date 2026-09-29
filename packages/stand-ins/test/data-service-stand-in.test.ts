/**
 * WP192：官方数据接口统一能力口的契约替身——钱的几条口径与 HTTP 面（状态码、信封照契约）。
 */
import { describe, expect, it } from 'vitest'
import {
  CloudAccountsStandIn,
  cloudStandInFetch,
  DataServiceStandIn,
  SAMPLE_DATA_PRICES,
  StandInDataError,
  StandInWallet,
} from '../src/index.js'

const T0 = '2026-09-29T01:00:00.000Z'
let seq = 0
const newId = (p: string): string => `${p}_${String(++seq)}`
const me = {
  account_id: 'acc_1',
  org_id: 'org_1',
  workspace_id: 'ws_1',
  scopes: ['data'],
  region: 'global' as const,
}
const other = { ...me, account_id: 'acc_2', org_id: 'org_2', workspace_id: 'ws_2' }

function world(credits = 100): { wallet: StandInWallet; data: DataServiceStandIn } {
  const wallet = new StandInWallet({ now: () => T0, newId })
  wallet.topup({ org_id: me.org_id, credits, kind: 'purchased' })
  wallet.topup({ org_id: other.org_id, credits, kind: 'purchased' })
  return { wallet, data: new DataServiceStandIn({ wallet, now: () => T0, newId }) }
}

describe('WP192 替身 · 同步调用', () => {
  it('按次收；同一个问法第二次命中缓存照价收；白名单以外的字段丢掉', () => {
    const { wallet, data } = world()
    const input = { query: 'led strip', country: 'US', language: 'en', evil: 'x' }
    const first = data.call(me, 'serp.google', { input })
    expect(first).toMatchObject({ credits: 0.2, cached: false, quantity: 1, source: 'official' })
    const second = data.call(me, 'serp.google', { input: { ...input, country: 'us' } })
    expect(second).toMatchObject({ credits: 0.2, cached: true })
    expect(data.call(me, 'serp.google', { input, fresh: true }).cached).toBe(false)
    expect(wallet.balance(me.org_id).available).toBeCloseTo(100 - 0.6, 6)
  })

  it('按行计价的按回来的行数收；余额不够 402、一分不扣', () => {
    const { wallet, data } = world(0.02)
    expect(() =>
      data.call(me, 'seo.backlinks', { input: { target: 'a.com', limit: 100 } }),
    ).toThrow(StandInDataError)
    expect(wallet.balance(me.org_id).available).toBe(0.02)
    const ok = data.call(me, 'seo.backlinks', { input: { target: 'a.com', limit: 2 } })
    expect(ok).toMatchObject({ quantity: 2, credits: 0.02 })
  })

  it('默认关的能力与认不出的能力：501 / 404', () => {
    const { data } = world()
    expect(() => data.call(me, 'nope', { input: {} })).toThrow(/没有「nope」/u)
    try {
      data.submit(me, {
        capability: 'social.linkedin.profile',
        input: { profile_urls: ['https://x.test/in/a'] },
        idempotency_key: 'k0',
      })
      throw new Error('应该拒')
    } catch (err) {
      expect(err).toMatchObject({ code: 'not_implemented', status: 501 })
    }
  })
})

describe('WP192 替身 · 异步任务', () => {
  it('按上限预扣 → 跑完按实际条数结算、多扣的退回；幂等键重发回同一个', () => {
    const { wallet, data } = world()
    const body = {
      capability: 'maps.places',
      input: { query: 'led wholesaler', location: 'Berlin' },
      max_items: 20,
      idempotency_key: 'k1',
    }
    const { task, created } = data.submit(me, body)
    expect(created).toBe(true)
    expect(task).toMatchObject({ status: 'queued', max_items: 20, reserved_credits: 1 })
    expect(wallet.balance(me.org_id).reserved).toBe(1)
    const again = data.submit(me, body)
    expect(again).toMatchObject({ created: false, task: { id: task.id } })
    expect(data.task(me, task.id).status).toBe('running')
    const done = data.task(me, task.id)
    expect(done.status).toBe('succeeded')
    const price = SAMPLE_DATA_PRICES['maps.places'] ?? 0
    expect(done.credits).toBeCloseTo(price * done.item_count, 6)
    expect(done.refunded_credits).toBeCloseTo(1 - done.credits, 6)
    expect(wallet.balance(me.org_id)).toMatchObject({ reserved: 0 })
    expect(wallet.balance(me.org_id).available).toBeCloseTo(100 - done.credits, 6)
    const page = data.items(me, task.id)
    expect(page.total).toBe(done.item_count)
    expect(page.items).toHaveLength(done.item_count)
  })

  it('失败全退；别的组织看不到；还没跑完取结果 409', () => {
    const { wallet, data } = world()
    data.failNext = true
    const { task } = data.submit(me, {
      capability: 'amazon.reviews',
      input: { asin: 'B0TEST1234', marketplace: 'US' },
      idempotency_key: 'k2',
    })
    expect(() => data.items(me, task.id)).toThrow(/还没跑完/u)
    expect(() => data.task(other, task.id)).toThrow(/没有这个任务/u)
    data.task(me, task.id)
    expect(data.task(me, task.id)).toMatchObject({ status: 'failed', credits: 0 })
    expect(wallet.balance(me.org_id).available).toBe(100)
  })

  it('取消：还没拿到的全退', () => {
    const { wallet, data } = world()
    const { task } = data.submit(me, {
      capability: 'social.tiktok.profile',
      input: { usernames: ['@Someone'] },
      idempotency_key: 'k3',
    })
    expect(data.cancel(me, task.id)).toMatchObject({ status: 'cancelled', credits: 0 })
    expect(wallet.balance(me.org_id)).toMatchObject({ reserved: 0, available: 100 })
  })
})

describe('WP192 替身 · HTTP 面', () => {
  it('信封与状态码照契约：202 受理、200 幂等重放、401、403、404', async () => {
    const accounts = new CloudAccountsStandIn({ now: () => T0 })
    const who = accounts.ensureAccount('a@example.com')
    const { token } = accounts.issue({
      workspace_id: 'ws_1',
      cloud_org_id: who.org_id,
      created_by: who.account_id,
    })
    const { token: noData } = accounts.issue({
      workspace_id: 'ws_2',
      cloud_org_id: who.org_id,
      created_by: who.account_id,
      scopes: ['ai'],
    })
    const wallet = new StandInWallet({ now: () => T0, newId })
    wallet.topup({ org_id: who.org_id, credits: 50, kind: 'purchased' })
    const data = new DataServiceStandIn({ wallet, now: () => T0, newId })
    const { fetch } = cloudStandInFetch({ accounts, dataService: data })
    const base = 'https://cloud.example.test'
    const auth = (t: string) => ({ Authorization: `Bearer ${t}` })

    const caps = await fetch(`${base}/v1/data/capabilities`, { headers: auth(token) })
    expect(caps.status).toBe(200)
    expect(
      ((await caps.json()) as { data: { capabilities: unknown[] } }).data.capabilities.length,
    ).toBeGreaterThan(10)
    expect((await fetch(`${base}/v1/data/capabilities`)).status).toBe(401)
    expect((await fetch(`${base}/v1/data/capabilities`, { headers: auth(noData) })).status).toBe(
      403,
    )
    const body = JSON.stringify({
      capability: 'amazon.product',
      input: { asins: ['B0TEST1234'], marketplace: 'us' },
      idempotency_key: 'k-http',
    })
    const submitted = await fetch(`${base}/v1/data/tasks`, {
      method: 'POST',
      headers: auth(token),
      body,
    })
    expect(submitted.status).toBe(202)
    const id = ((await submitted.json()) as { data: { id: string } }).data.id
    expect(
      (await fetch(`${base}/v1/data/tasks`, { method: 'POST', headers: auth(token), body })).status,
    ).toBe(200)
    expect(
      (await fetch(`${base}/v1/data/tasks/${id}/items`, { headers: auth(token) })).status,
    ).toBe(409)
    await fetch(`${base}/v1/data/tasks/${id}`, { headers: auth(token) })
    await fetch(`${base}/v1/data/tasks/${id}`, { headers: auth(token) })
    const items = await fetch(`${base}/v1/data/tasks/${id}/items`, { headers: auth(token) })
    expect(items.status).toBe(200)
    expect((await fetch(`${base}/v1/data/tasks/nope`, { headers: auth(token) })).status).toBe(404)
    const call = await fetch(`${base}/v1/data/call/serp.bing`, {
      method: 'POST',
      headers: auth(token),
      body: JSON.stringify({ input: { query: 'x', country: 'de', language: 'de' } }),
    })
    expect(call.status).toBe(200)
    expect(((await call.json()) as { data: { credits: number } }).data.credits).toBe(0.2)
  })
})
