/**
 * WP313：插件动作通道在**网关这一层**的形状。
 *
 * 守四条：
 * 1. 插件那几条与 `/v1/extension/*` 同一道闸：令牌 + Origin 同时对，网页拿到令牌也没用；
 * 2. 令牌上要有 `ads.act`（老令牌没有，要重新配对）；
 * 3. **没有任何一条 HTTP 路由能往队里塞活**（进队只由审批执行器调端口）；
 * 4. 急停（outbound）时一件活都不发、卡上的「确认提交」也按不下去。
 */
import { describe, expect, it } from 'vitest'
import type { ExtensionActionsPort, ExtensionPort } from '../src/index.js'
import { collectRoutes, createGateway, createMemoryExtensionStore } from '../src/index.js'
import { harness, makeClock, seeded } from './helpers.js'

const EXT_ORIGIN = 'chrome-extension://abcdefghijklmnop'

const SETTINGS = {
  zones: {
    payment: false,
    billing: false,
    balance: false,
    users: false,
    business_settings: false,
    verification: false,
    appeal: false,
    new_account: false,
    pixel_conversion: false,
    delete_campaign: false,
  },
  consent: {},
}

async function wired() {
  const h = await harness()
  const store = createMemoryExtensionStore({ clock: makeClock(), random: seeded(3) })
  const calls: string[] = []
  const actions: ExtensionActionsPort = {
    next: async (s, input) => {
      calls.push(`next:${s.workspace_id}:${input.platforms.join('+')}:${input.wait_ms}`)
      return { retry_after_ms: 60_000 }
    },
    sheet: () => undefined,
    progress: (_s, id) => (id === 'job_1' ? { stop: false, confirmed: false } : undefined),
    evidence: async () => ({ id: 'ev_1', kept_until: '2027-04-12T00:00:00.000Z' }),
    download: () => ({ recorded: true }),
    result: () => undefined,
    consent: (_s, input) => {
      calls.push(`consent:${input.platform}:${input.text_version}`)
      return SETTINGS
    },
    settings: () => SETTINGS,
    setZone: (_ws, zone, enabled) => {
      calls.push(`zone:${zone}:${enabled}`)
      return SETTINGS
    },
    revokeConsent: () => SETTINGS,
    jobs: () => [],
    stop: () => undefined,
    confirm: () => undefined,
    enqueue: async () => ({ ok: false, why: 'unused' }),
  }
  const gateway = createGateway({
    ...h.deps,
    extension: { store } as unknown as ExtensionPort,
    extensionActions: actions,
  })
  const owner = (method: string, path: string, body?: unknown) => {
    const headers = new Headers({
      Authorization: `Bearer ${h.token}`,
      'X-Assignment': h.assignment.id,
    })
    if (body !== undefined) headers.set('content-type', 'application/json')
    return gateway.fetch(
      new Request(`http://127.0.0.1${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  }
  const plugin = (
    method: string,
    path: string,
    init: { token?: string; origin?: string; body?: unknown } = {},
  ) => {
    const headers = new Headers()
    if (init.token !== undefined) headers.set('Authorization', `Bearer ${init.token}`)
    if (init.origin !== undefined) headers.set('Origin', init.origin)
    if (init.body !== undefined) headers.set('content-type', 'application/json')
    return gateway.fetch(
      new Request(`http://127.0.0.1${path}`, {
        method,
        headers,
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      }),
    )
  }
  const made = await owner('POST', '/v1/extension/pairings', {})
  const code = ((await made.json()) as { data: { code: string } }).data.code
  const res = await plugin('POST', '/v1/extension/pair', { origin: EXT_ORIGIN, body: { code } })
  const issued = ((await res.json()) as { data: { token: string; scopes: string[] } }).data
  return { h, calls, owner, plugin, token: issued.token, scopes: issued.scopes }
}

describe('插件这一侧', () => {
  it('新配的令牌带 ads.act；长轮询按令牌上的品牌领活，wait 最多 25 秒', async () => {
    const w = await wired()
    expect(w.scopes).toContain('ads.act')
    const res = await w.plugin(
      'GET',
      '/v1/extension/actions/next?platforms=google_ads,meta_ads,bogus&wait=99',
      {
        token: w.token,
        origin: EXT_ORIGIN,
      },
    )
    expect(res.status).toBe(200)
    expect(w.calls).toEqual([`next:${w.h.assignment.workspace_id}:google_ads+meta_ads:25000`])
  })

  it('网页拿到令牌也没用（Origin 不是扩展的）', async () => {
    const w = await wired()
    const res = await w.plugin('GET', '/v1/extension/actions/next?platforms=google_ads', {
      token: w.token,
      origin: 'https://ads.google.com',
    })
    expect(res.status).toBe(401)
    expect(w.calls).toEqual([])
  })

  it('一家都没说就不领', async () => {
    const w = await wired()
    const res = await w.plugin('GET', '/v1/extension/actions/next?platforms=', {
      token: w.token,
      origin: EXT_ORIGIN,
    })
    expect(res.status).toBe(400)
  })

  it('进度：活不存在回 404；多一个键整批拒', async () => {
    const w = await wired()
    const ok = await w.plugin('POST', '/v1/extension/actions/job_1/progress', {
      token: w.token,
      origin: EXT_ORIGIN,
      body: { step: 1, of: 6, label: '打开页面' },
    })
    expect(ok.status).toBe(200)
    const gone = await w.plugin('POST', '/v1/extension/actions/job_x/progress', {
      token: w.token,
      origin: EXT_ORIGIN,
      body: { step: 1, of: 6, label: '打开页面' },
    })
    expect(gone.status).toBe(404)
    const extra = await w.plugin('POST', '/v1/extension/actions/job_1/progress', {
      token: w.token,
      origin: EXT_ORIGIN,
      body: { step: 1, of: 6, label: 'x', url: 'https://evil' },
    })
    expect(extra.status).toBe(400)
  })

  it('同意记录只认两家后台', async () => {
    const w = await wired()
    const bad = await w.plugin('POST', '/v1/extension/ads-consent', {
      token: w.token,
      origin: EXT_ORIGIN,
      body: { platform: 'tiktok_ads', text_version: 'v1' },
    })
    expect(bad.status).toBe(400)
    const good = await w.plugin('POST', '/v1/extension/ads-consent', {
      token: w.token,
      origin: EXT_ORIGIN,
      body: { platform: 'meta_ads', text_version: 'v1' },
    })
    expect(good.status).toBe(200)
    expect(w.calls).toEqual(['consent:meta_ads:v1'])
  })

  it('急停（outbound）时一件都不发', async () => {
    const w = await wired()
    w.h.halt.set('outbound', true)
    const res = await w.plugin('GET', '/v1/extension/actions/next?platforms=google_ads', {
      token: w.token,
      origin: EXT_ORIGIN,
    })
    expect(res.status).toBe(503)
    expect(w.calls).toEqual([])
  })
})

describe('工作台这一侧', () => {
  it('逐项放开一个区域；认不得的区域 400', async () => {
    const w = await wired()
    expect((await w.owner('PUT', '/v1/ads-actions/zones/billing', { enabled: true })).status).toBe(
      200,
    )
    expect(
      (await w.owner('PUT', '/v1/ads-actions/zones/everything', { enabled: true })).status,
    ).toBe(400)
    expect(w.calls).toEqual(['zone:billing:true'])
  })
})

describe('进队没有 HTTP 入口', () => {
  it('动作通道的路由里，插件只能领 / 报，工作台只能看 / 停 / 确认 / 开关', () => {
    const paths = collectRoutes()
      .map((r) => `${r.spec.method.toUpperCase()} ${r.spec.path}`)
      .filter(
        (p) => p.includes('/actions') || p.includes('ads-actions') || p.includes('ads-consent'),
      )
    expect(paths.sort()).toEqual(
      [
        'GET /v1/extension/actions/next',
        'GET /v1/extension/actions/:id/sheet',
        'POST /v1/extension/actions/:id/progress',
        'POST /v1/extension/actions/:id/evidence',
        'POST /v1/extension/actions/:id/download',
        'POST /v1/extension/actions/:id/result',
        'POST /v1/extension/ads-consent',
        'GET /v1/ads-actions/settings',
        'PUT /v1/ads-actions/zones/:zone',
        'POST /v1/ads-actions/consent/:platform/revoke',
        'GET /v1/ads-actions/jobs',
        'POST /v1/ads-actions/jobs/:id/stop',
        'POST /v1/ads-actions/jobs/:id/confirm',
      ].sort(),
    )
  })
})
