/**
 * WP192（docs/83 §4、docs/75）：本机的官方数据接口统一能力口，端到端。
 *
 * 本机跑真装配线（本地路由 → 按品牌的云客户端 → HTTP），最外面那一跳是云端 HTTP 面的契约替身
 * （`@agentsws/stand-ins` 的 `DataServiceStandIn`）。钉四件事：
 *
 * 1. 没关联账号：一句人话（去关联），不编数据；
 * 2. 关联之后：能力清单、同步调用（按次扣积分）、异步任务（预扣 → 跑完按实际条数结算）都走得通；
 * 3. 数据来源路由（`data.<能力>`）：把「Agents 工坊（用积分）」那一级关掉就不打云；
 * 4. 路由设置里 `data.*` 只认「自带数据接口」与「Agents 工坊」两级，别的级丢掉。
 */
import {
  CloudAccountsStandIn,
  cloudStandInFetch,
  DataServiceStandIn,
  type StandInMail,
  StandInWallet,
} from '@agentsws/stand-ins'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'

const T0 = '2026-09-29T00:00:00.000Z'
const CLOUD_BASE = 'http://cloud.test'

let server: Server
let url: string
let mails: StandInMail[]
let accounts: CloudAccountsStandIn
let wallet: StandInWallet
let calls: string[]

const asOwner = async (path: string, init: RequestInit = {}): Promise<Response> => {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${server.bootstrap.internalToken}`)
  headers.set('X-Assignment', server.bootstrap.ownerAssignment.id)
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  return fetch(`${url}${path}`, { ...init, headers })
}
const json = async <T>(res: Response): Promise<T> => (await res.json()) as T

async function link(): Promise<void> {
  const started = await asOwner('/v1/cloud/account/link', {
    method: 'POST',
    body: JSON.stringify({ email: 'luoye@example.com' }),
  })
  expect(started.status).toBe(200)
  const last = mails.at(-1)
  if (last === undefined) throw new Error('还没发过信')
  const href = new URL(/https?:\/\/\S+/.exec(last.text)?.[0] ?? '')
  const cb = await fetch(
    `${url}/v1/cloud/account/callback?token=${encodeURIComponent(href.searchParams.get('token') ?? '')}&state=${encodeURIComponent(href.searchParams.get('state') ?? '')}`,
  )
  expect(cb.status).toBe(200)
  const org = accounts.ensureAccount('luoye@example.com').org_id
  wallet.topup({ org_id: org, credits: 50, kind: 'purchased' })
}

beforeEach(async () => {
  let t = Date.parse(T0)
  let seq = 0
  const newId = (prefix: string): string => `${prefix}_${String(++seq)}`
  const now = (): string => new Date(t).toISOString()
  accounts = new CloudAccountsStandIn({ now })
  mails = accounts.mails
  wallet = new StandInWallet({ now, newId })
  const dataService = new DataServiceStandIn({ wallet, now, newId })
  const wire = cloudStandInFetch({ accounts, dataService })
  calls = wire.calls
  server = await createServer({
    quiet: true,
    clock: {
      now: () => {
        t += 1000
        return new Date(t).toISOString()
      },
    },
    scheduleIntervalMs: 0,
    startRun: false,
    env: {
      AGENTSWS_OWNER_EMAIL: 'luoye@example.com',
      [SECRETS_KEY_ENV]: 'e'.repeat(64),
      AGENTSWS_CLOUD_BASE_URL: CLOUD_BASE,
    },
    cloudFetch: wire.fetch as never,
  })
  ;({ url } = await server.listen(0))
})

afterEach(async () => {
  await server.close()
})

describe('WP192 本机 · 数据能力口', () => {
  it('没关联账号：一句人话（去关联），一个字节不打云', async () => {
    const res = await asOwner('/v1/data-service/call/serp.google', {
      method: 'POST',
      body: JSON.stringify({ input: { query: 'x', country: 'us', language: 'en' } }),
    })
    expect(res.status).toBe(501)
    expect((await json<{ message: string }>(res)).message).toContain('关联')
    expect(calls.filter((c) => c.includes('/v1/data/'))).toEqual([])
  })

  it('关联之后：清单、同步调用扣积分、异步任务预扣 → 结算 → 取结果', async () => {
    await link()
    const caps = await asOwner('/v1/data-service/capabilities')
    expect(caps.status).toBe(200)
    const list = (await json<{ data: { capabilities: { id: string }[] } }>(caps)).data
    expect(list.capabilities.map((c) => c.id)).toContain('maps.places')

    const call = await asOwner('/v1/data-service/call/serp.google', {
      method: 'POST',
      body: JSON.stringify({ input: { query: 'led strip', country: 'us', language: 'en' } }),
    })
    expect(call.status).toBe(200)
    expect((await json<{ data: { credits: number; source: string } }>(call)).data).toMatchObject({
      credits: 0.2,
      source: 'official',
    })

    const submitted = await asOwner('/v1/data-service/tasks', {
      method: 'POST',
      body: JSON.stringify({
        capability: 'maps.places',
        input: { query: 'led wholesaler', location: 'Berlin' },
        max_items: 10,
        idempotency_key: 'wp192-local-1',
      }),
    })
    expect(submitted.status).toBe(200)
    const task = (await json<{ data: { id: string; status: string } }>(submitted)).data
    expect(task.status).toBe('queued')
    await asOwner(`/v1/data-service/tasks/${task.id}`)
    const done = (
      await json<{ data: { status: string; item_count: number } }>(
        await asOwner(`/v1/data-service/tasks/${task.id}`),
      )
    ).data
    expect(done.status).toBe('succeeded')
    const page = (
      await json<{ data: { total: number; items: unknown[] } }>(
        await asOwner(`/v1/data-service/tasks/${task.id}/items`),
      )
    ).data
    expect(page.items).toHaveLength(done.item_count)
    // 别的任务号：云上的 404 原样带回
    expect((await asOwner('/v1/data-service/tasks/dt_nope')).status).toBe(404)
  })

  it('把「Agents 工坊（用积分）」那一级关掉：不打云，说清楚来源都关了', async () => {
    await link()
    const set = await asOwner('/v1/settings/capability-sources', {
      method: 'PUT',
      body: JSON.stringify({
        capability_sources: {},
        data_source_routing: {
          'data.maps.places': { order: ['official_key', 'workshop'], disabled: ['workshop'] },
        },
      }),
    })
    expect(set.status).toBe(200)
    const saved = (
      await json<{ data: { data_source_routing?: Record<string, { order: string[] }> } }>(set)
    ).data
    // data.* 只认两级：official_key 被丢掉
    expect(saved.data_source_routing?.['data.maps.places']?.order).toEqual(['workshop'])
    const before = calls.length
    const res = await asOwner('/v1/data-service/tasks', {
      method: 'POST',
      body: JSON.stringify({ capability: 'maps.places', input: { query: 'x' } }),
    })
    expect(res.status).toBe(501)
    expect((await json<{ message: string }>(res)).message).toContain('关掉')
    expect(calls.slice(before).filter((c) => c.includes('/v1/data/'))).toEqual([])
  })
})
