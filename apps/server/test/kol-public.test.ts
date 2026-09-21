/**
 * WP68（49 M2 / 48 §5.3）：本地这一侧真的连上云端公共红人库，端到端。
 *
 * "端到端"是认真的：跑的是**真装配线**（本地路由 → 端口 → 加密库 → HTTP →
 * `packages/kol-public` 的**真路由** → 真钱包 → 真价目），只把最外面那一跳换成
 * 一个内存版的云进程。所以这条测试里**没有一处 mock 出来的形状**——
 * 路由名、参数名、响应字段、扣费口径全是那一份真代码说了算。
 *
 * 四条硬断言：
 * 1. 开关拨到 "用 agentsws 的" 之后，找人真的改查公共库（`source: public_library`）；
 * 2. **浏览 / 搜索按次收费、reveal 也花钱（WP126）**，而且价目在点之前就说出来（"这一步扣 N 积分"）；
 * 3. reveal 回来的明文**当场进本机加密库**，响应体里只有脱敏形态；
 * 4. 余额不够时回的是一句人话（云那边 402），不是一个红框。
 */

import type { CloudMail } from '@agentsws/cloud'
import { type CloudServer, createCloudServer, mountEntry, mountKolPublic } from '@agentsws/cloud'
import { DEFAULT_CLOUD_SCOPES } from '@agentsws/contracts'
import { MemoryKolStore } from '@agentsws/kol-public'
import { MemoryWalletStore } from '@agentsws/metering'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CLOUD_TOKEN_SECRET_ID, createServer, type Server } from '../src/index.js'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'

const T0 = '2026-09-15T00:00:00.000Z'
const SECRETS_KEY = 'f'.repeat(64)
const CLOUD_BASE = 'http://cloud.test'
/** 云侧那把邮箱密钥（32 字节）。仓库里没有真 key，这是测试自己造的。 */
const EMAIL_KEY = Buffer.alloc(32, 9).toString('base64url')

function seeded(seed = 682): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

let server: Server
let cloud: CloudServer
let url: string
let mails: CloudMail[]
let wallet: ReturnType<typeof mountEntry>['wallet']
let kolCloud: ReturnType<typeof mountKolPublic>
let assignment: string

const api = async (path: string, init: RequestInit = {}): Promise<Response> => {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${server.bootstrap.internalToken}`)
  headers.set('X-Assignment', assignment)
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  return fetch(`${url}${path}`, { ...init, headers })
}

/** 关联账号与改能力开关是 owner 的事，不是红人那条职责的事。 */
const asOwner = async (path: string, init: RequestInit = {}): Promise<Response> => {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${server.bootstrap.internalToken}`)
  headers.set('X-Assignment', server.bootstrap.ownerAssignment.id)
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  return fetch(`${url}${path}`, { ...init, headers })
}

const data = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data

/** 走完一次关联（发信 → 点链接），本地就有了这个品牌那把工作区服务令牌。 */
async function link(): Promise<void> {
  const started = await asOwner('/v1/cloud/account/link', {
    method: 'POST',
    body: JSON.stringify({ email: 'luoye@example.com' }),
  })
  expect(started.status).toBe(200)
  const last = mails.at(-1)
  if (last === undefined) throw new Error('还没发过信')
  const href = /https?:\/\/\S+/.exec(last.text)?.[0] ?? ''
  const link = new URL(href)
  const cb = await fetch(
    `${url}/v1/cloud/account/callback?token=${encodeURIComponent(link.searchParams.get('token') ?? '')}&state=${encodeURIComponent(link.searchParams.get('state') ?? '')}`,
  )
  expect(cb.status).toBe(200)
}

/** 直接往公共库里报一条观察（模拟别的工作区 / 插件贡献过这个人）。 */
function seedCreator(handle: string, hasContact = true): void {
  const principal = {
    account_id: 'acc_seed',
    org_id: 'org_seed',
    workspace_id: 'ws_seed',
    scopes: [...DEFAULT_CLOUD_SCOPES],
    region: 'global' as const,
  }
  kolCloud.service.contributeAs(principal, [
    {
      channel: 'youtube',
      handle,
      followers: 120_000,
      posts_30d: 6,
      engagement_rate: 0.035,
      categories: ['3c'],
      observed_at: '2026-09-14T00:00:00.000Z',
    },
  ])
  if (hasContact)
    kolCloud.service.saveContact(
      {
        id: `ws:${principal.workspace_id}`,
        workspace_id: principal.workspace_id,
        org_id: principal.org_id,
        kind: 'workspace',
      },
      { channel: 'youtube', handle },
      { email: `${handle}@creator.com` },
    )
}

beforeEach(async () => {
  let t = Date.parse(T0)
  mails = []
  cloud = createCloudServer({
    clock: { now: () => new Date(t).toISOString() },
    quiet: true,
    env: { AGENTSWS_CLOUD_BASE_URL: CLOUD_BASE },
    mail: async (mail) => {
      mails.push(mail)
    },
  })
  const entry = mountEntry(cloud, {
    clock: { now: () => new Date(t).toISOString() },
    walletStore: new MemoryWalletStore(),
  })
  wallet = entry.wallet
  kolCloud = mountKolPublic(cloud, {
    wallet: entry.wallet,
    pricing: entry.pricing,
    clock: { now: () => new Date(t).toISOString() },
    store: new MemoryKolStore(),
    env: { AGENTSWS_KOL_EMAIL_KEY: EMAIL_KEY },
  })

  server = await createServer({
    quiet: true,
    clock: {
      now: () => {
        t += 1000
        return new Date(t).toISOString()
      },
    },
    random: seeded(),
    scheduleIntervalMs: 0,
    startRun: false,
    env: {
      AGENTSWS_OWNER_EMAIL: 'luoye@example.com',
      [SECRETS_KEY_ENV]: SECRETS_KEY,
      AGENTSWS_CLOUD_BASE_URL: CLOUD_BASE,
    },
    // 本地 → 云的那一跳走内存服务端，全程不出网
    cloudFetch: async (input, init) => {
      const res = await cloud.fetch(
        new Request(input, {
          method: init?.method ?? 'GET',
          ...(init?.headers === undefined ? {} : { headers: init.headers }),
          ...(init?.body === undefined ? {} : { body: init.body }),
        }),
      )
      return { ok: res.ok, status: res.status, text: () => res.text(), json: () => res.json() }
    },
  })
  ;({ url } = await server.listen(0))
  assignment = server.roles.assignments.create({
    person_id: server.bootstrap.person.id,
    workspace_id: server.bootstrap.workspace.id,
    role_id: 'kol.youtube',
    granted_by: server.bootstrap.person.id,
    ranges: [{ kind: 'store', id: 'store_1' }],
  }).id
})

afterEach(async () => {
  await server.close()
  kolCloud.close()
  await cloud.close()
})

/** 把 `kol.youtube` 那个开关拨到「用 agentsws 的」。 */
async function useOurs(): Promise<void> {
  const res = await asOwner('/v1/settings/capability-sources', {
    method: 'PUT',
    body: JSON.stringify({ capability_sources: { 'kol.youtube': 'agentsws' } }),
  })
  expect(res.status).toBe(200)
}

describe('WP68 / 49 M2：用我的 / 用 agentsws 的', () => {
  it('默认用我的：没连 YouTube 就照实说没连，一跳云都不打', async () => {
    const out = await data<{ ok: boolean; source: string; reason?: string }>(
      await api('/v1/kol/search?channel=youtube&q=3c'),
    )
    expect(out.ok).toBe(false)
    expect(out.source).toBe('channel')
    expect(out.reason).toBe('not_connected')
  })

  it('拨到 agentsws 但没关联账号：说的是"去关联一次"，不是"搜到 0 个"', async () => {
    await useOurs()
    const out = await data<{ ok: boolean; source: string; reason?: string; message?: string }>(
      await api('/v1/kol/search?channel=youtube&q=3c'),
    )
    expect(out.ok).toBe(false)
    expect(out.source).toBe('public_library')
    expect(out.reason).toBe('not_linked')
    expect(out.message).toContain('账号与积分')
  })

  it('关联之后：搜索按次收费（WP126）、价目在点之前就说出来', async () => {
    await link()
    await useOurs()
    seedCreator('gadgetjonas')
    // WP126：搜索本身也按次扣积分，先充一点
    wallet.topup({ org_id: cloud.store.ensureAccount('luoye@example.com').org.id, credits: 10, kind: 'purchased' })

    const before = wallet.balance(cloud.store.ensureAccount('luoye@example.com').org.id).available
    const out = await data<{
      ok: boolean
      source: string
      rows: { handle: string; has_contact?: boolean; in_library?: boolean }[]
      reveal_price?: { capability: string; credits: number; note: string }
    }>(await api('/v1/kol/search?channel=youtube&q=gadgetjonas'))
    expect(out.ok).toBe(true)
    expect(out.source).toBe('public_library')
    expect(out.rows.map((r) => r.handle)).toEqual(['gadgetjonas'])
    // 库里有联系方式，但**只说有没有**
    expect(out.rows[0]?.has_contact).toBe(true)
    expect(out.rows[0]?.in_library).toBe(false)
    // 49 M4 的价目：这一步扣多少，点之前就看得见
    expect(out.reveal_price?.capability).toBe('data.kol.lookup')
    expect(out.reveal_price?.credits).toBeGreaterThan(0)
    expect(out.reveal_price?.note).toContain('积分')
    // WP126：搜索本身也按 data.kol.lookup 扣了一次（0.2）——官方接口没有免费动作了
    expect(
      before - wallet.balance(cloud.store.ensureAccount('luoye@example.com').org.id).available,
    ).toBeCloseTo(0.2, 6)
  })

  it('reveal：扣积分、明文当场进本机加密库、响应体里只有脱敏形态', async () => {
    await link()
    await useOurs()
    seedCreator('gadgetjonas')
    const org = cloud.store.ensureAccount('luoye@example.com').org.id
    wallet.topup({ org_id: org, credits: 100, kind: 'purchased' })
    const before = wallet.balance(org).available

    const res = await api('/v1/kol/public/reveal', {
      method: 'POST',
      body: JSON.stringify({ channel: 'youtube', handle: 'gadgetjonas' }),
    })
    expect(res.status).toBe(200)
    const out = await data<{
      ok: boolean
      creator_id?: string
      credits_spent?: number
      contact?: { id: string; masked: string }
    }>(res)
    expect(out.ok).toBe(true)
    expect(out.credits_spent).toBeGreaterThan(0)
    expect(wallet.balance(org).available).toBe(before - (out.credits_spent as number))
    // 响应体里没有明文，只有脱敏形态
    expect(out.contact?.masked).toBe('g***@creator.com')
    expect(JSON.stringify(out)).not.toContain('gadgetjonas@creator.com')

    // 明文真的在本机加密库里（起草开发信那一跳靠它）
    const brand = await server.brands.forWorkspace(server.bootstrap.workspace.id)
    expect(brand.kolService.revealContact(out.contact?.id as string)).toBe(
      'gadgetjonas@creator.com',
    )
    // 库里那一行只有 key 名
    const row = brand.kol.contacts(out.creator_id as string)[0]
    expect(row?.value_ref).toBe(`kol.contact.${out.contact?.id}`)
    expect(row?.source).toBe('public_library')
    expect(JSON.stringify(row)).not.toContain('@creator.com')

    // 这个人进了本地库，下一次浏览会标成"你已经有了"
    const again = await data<{ rows: { in_library?: boolean }[] }>(
      await api('/v1/kol/search?channel=youtube&q=gadgetjonas'),
    )
    expect(again.rows[0]?.in_library).toBe(true)
  })

  it('余额不够：回一句人话（云那边 402），本地不建任何记录', async () => {
    await link()
    await useOurs()
    seedCreator('deskrosa')
    // 一分钱都不充
    const out = await data<{ ok: boolean; reason?: string; message?: string }>(
      await api('/v1/kol/public/reveal', {
        method: 'POST',
        body: JSON.stringify({ channel: 'youtube', handle: 'deskrosa' }),
      }),
    )
    expect(out.ok).toBe(false)
    expect(out.reason).toBe('insufficient_credits')
    expect((out.message ?? '').length).toBeGreaterThan(5)
    const brand = await server.brands.forWorkspace(server.bootstrap.workspace.id)
    expect(brand.kol.contacts()).toHaveLength(0)
  })

  it('库里没有这个人的联系方式：不收钱，也不在本地建一条空的', async () => {
    await link()
    await useOurs()
    seedCreator('nomail', false)
    const org = cloud.store.ensureAccount('luoye@example.com').org.id
    wallet.topup({ org_id: org, credits: 100, kind: 'purchased' })
    const before = wallet.balance(org).available

    const out = await data<{ ok: boolean; reason?: string }>(
      await api('/v1/kol/public/reveal', {
        method: 'POST',
        body: JSON.stringify({ channel: 'youtube', handle: 'nomail' }),
      }),
    )
    expect(out.ok).toBe(false)
    expect(out.reason).toBe('not_found')
    expect(wallet.balance(org).available).toBe(before)
  })

  it('那把令牌没有 data 权限：说的是"重新关联一次"，不是一个 403', async () => {
    await link()
    await useOurs()
    seedCreator('gadgetjonas')
    // 把云上那条关联换成一把**没有 data** 的令牌，本地那一把也换掉
    const { account, org } = cloud.store.ensureAccount('luoye@example.com')
    const issued = cloud.store.createLink({
      workspace_id: 'ws_no_data',
      cloud_org_id: org.id,
      created_by: account.id,
      scopes: DEFAULT_CLOUD_SCOPES.filter((s) => s !== 'data'),
    })
    server.secrets.put(CLOUD_TOKEN_SECRET_ID, { token: issued.token })

    const out = await data<{ ok: boolean; reason?: string; message?: string }>(
      await api('/v1/kol/search?channel=youtube&q=gadgetjonas'),
    )
    expect(out.ok).toBe(false)
    expect(out.reason).toBe('not_linked')
    expect(out.message).toContain('数据服务')
  })
})
