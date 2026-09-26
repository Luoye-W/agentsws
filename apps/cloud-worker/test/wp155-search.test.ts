/**
 * WP155：Workers 形态下的搜索数据（官方数据接口）。
 *
 * 钉三件事：
 * 1. `/v1/data/search/*` 走钱那一层（`WalletDO(org)`）——预扣、打上游、结算在同一个对象里做完；
 * 2. key 只从 `AGENTSWS_SEARCH_DATA_KEY` 取（`wrangler secret put`，不在仓库里）；没配就如实说没开通、一分不扣；
 * 3. 服务商名是 `[vars]`，认不出的名字当没开通（不猜）。
 *
 * 上游是替身（不联网、不用真 key）。
 */
import { DEFAULT_CLOUD_SCOPES } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { route } from '../src/index.js'
import { isWalletPath } from '../src/worker.js'
import { type FakeCloud, fakeCloud, req, tokenFromMail } from './helpers.js'

const CALLBACK = 'http://127.0.0.1:3000/v1/cloud/account/callback'
const FAKE_KEY = 'svc-login:not-a-real-password'

async function call(
  cloud: FakeCloud,
  path: string,
  init: { method?: string; body?: unknown; token?: string } = {},
) {
  const headers = new Headers()
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  if (init.token !== undefined) headers.set('Authorization', `Bearer ${init.token}`)
  const res = await route(
    req(path, {
      method: init.method ?? 'GET',
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
    cloud.env,
  )
  const text = await res.text()
  return {
    status: res.status,
    body: (text === '' ? {} : JSON.parse(text)) as Record<string, unknown>,
  }
}

async function issueToken(
  cloud: FakeCloud,
  email: string,
): Promise<{ token: string; org: string }> {
  await call(cloud, '/v1/cloud/auth/magic-link', {
    method: 'POST',
    body: { email, callback_url: CALLBACK },
  })
  const oneTime = tokenFromMail(cloud.mails[cloud.mails.length - 1] as never)
  const verified = await call(cloud, '/v1/cloud/auth/verify', {
    method: 'POST',
    body: { token: oneTime },
  })
  const data = verified.body.data as { session_token: string; org: { id: string } }
  const link = await call(cloud, '/v1/cloud/links', {
    method: 'POST',
    token: data.session_token,
    body: { workspace_id: 'ws_a', scopes: DEFAULT_CLOUD_SCOPES },
  })
  return { token: (link.body.data as { token: string }).token, org: data.org.id }
}

const SERP_REPLY = {
  status_code: 20000,
  tasks: [
    {
      status_code: 20000,
      result: [
        {
          items: [
            { type: 'organic', url: 'https://www.example.com/a', title: 'A', description: 'a' },
          ],
        },
      ],
    },
  ],
}

describe('WP155 Workers 形态 · 搜索数据', () => {
  it('路径归钱那一层', () => {
    expect(isWalletPath('/v1/data/search/serp')).toBe(true)
    expect(isWalletPath('/v1/data/search/status')).toBe(true)
    expect(isWalletPath('/v1/data/kol/creators')).toBe(false)
  })

  it('配了 key：预扣 → 打上游（Basic 鉴权）→ 结算 0.2 积分；key 不进响应', async () => {
    const seen: { url: string; auth: string | null }[] = []
    const cloud = fakeCloud({
      env: { AGENTSWS_SEARCH_DATA_KEY: FAKE_KEY },
      fetch: async (url, init) => {
        seen.push({ url, auth: new Headers(init.headers).get('authorization') })
        return new Response(JSON.stringify(SERP_REPLY), { status: 200 })
      },
    })
    const { token, org } = await issueToken(cloud, 'a@example.com')
    const before = cloud.wallet(org).wallet.balance(org).available
    const status = await call(cloud, '/v1/data/search/status', { token })
    expect(status.body).toMatchObject({ configured: true, route: 'official' })
    const res = await call(cloud, '/v1/data/search/serp', {
      method: 'POST',
      token,
      body: { query: 'x', engine: 'google', country: 'us', language: 'en' },
    })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ source: 'official', credits: 0.2 })
    expect(JSON.stringify(res.body)).not.toContain(FAKE_KEY)
    expect(seen[0]?.url).toBe('https://api.dataforseo.com/v3/serp/google/organic/live/advanced')
    expect(seen[0]?.auth).toBe(`Basic ${btoa(FAKE_KEY)}`)
    expect(cloud.wallet(org).wallet.balance(org).available).toBeCloseTo(before - 0.2, 6)
  })

  it('没配 key / 服务商名认不出：状态如实说没开通，查询 501 一分不扣、上游一下都不打', async () => {
    for (const env of [
      {},
      { AGENTSWS_SEARCH_DATA_KEY: FAKE_KEY, AGENTSWS_SEARCH_DATA_PROVIDER: 'nope' },
    ]) {
      const cloud = fakeCloud({
        env,
        fetch: async () => {
          throw new Error('这条用例不该打上游')
        },
      })
      const { token, org } = await issueToken(cloud, 'b@example.com')
      const before = cloud.wallet(org).wallet.balance(org).available
      expect((await call(cloud, '/v1/data/search/status', { token })).body).toMatchObject({
        configured: false,
      })
      const res = await call(cloud, '/v1/data/search/serp', {
        method: 'POST',
        token,
        body: { query: 'x', engine: 'google', country: 'us', language: 'en' },
      })
      expect(res.status).toBe(501)
      expect(cloud.wallet(org).wallet.balance(org).available).toBe(before)
    }
  })
})
