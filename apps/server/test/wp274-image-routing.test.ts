/**
 * WP274（决策 255）：生图跟着用户自己的模型走——起真服务进程，假上游（不联网、不花钱）。
 *
 * 解析顺序：单独指定的生图接口 > 文字模型同厂商且带生图 > Agents 工坊积分。
 * - 文字模型是自己的 OpenAI key → GPT Image 2.5（出图 flare、改图 sunburst），打 api.openai.com，用那把 key；
 * - 文字模型是自己的 Google key → Nano Banana 2.1，打 Google 原生 interactions 口，key 进 x-goog-api-key；
 * - 不带生图（DeepSeek）→ 关联过账号就走云（按积分）；没关联 → 说「生图还没配」；
 * - 设置里单独指定（含只生图的自定义接口）覆盖自动；那一条坏了退回自动并说清楚；
 * - 新品牌「跟随公司默认」时，生图跟着公司那一份走。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ModelDefaultsView, ModelImageView, ModelProviderView } from '@agentsws/api'
import type { FetchLike } from '@agentsws/model-gateway'
import { NANO_BANANA_MODEL } from '@agentsws/model-gateway'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import { CLOUD_TOKEN_SECRET_ID } from '../src/models.js'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'

const T0 = '2026-10-08T09:00:00.000Z'
const SECRETS_KEY = 'b'.repeat(64)
const OPENAI_KEY = 'sk-wp274-openai-never-leaves'
const GOOGLE_KEY = 'g-wp274-google-never-leaves'
const CUSTOM_KEY = 'sk-wp274-custom-image-endpoint'
const DEEPSEEK_KEY = 'sk-wp274-deepseek'
const CLOUD_TOKEN = 'wst_wp274_cloud'

const meta = { workspace_id: 'ws', run_id: 'run_1', purpose: 'run' } as never
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1])

interface Call {
  url: string
  auth: string | undefined
  google: string | undefined
  model: string | undefined
}

function fakeUpstream(): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = []
  const img = { data: [{ b64_json: Buffer.from([1, 2]).toString('base64') }] }
  const fetch: FetchLike = async (url, init) => {
    let model: string | undefined
    if (typeof init.body === 'string') {
      try {
        model = (JSON.parse(init.body) as { model?: string }).model
      } catch {
        model = undefined
      }
    } else if (init.body instanceof FormData) {
      model = String(init.body.get('model'))
    }
    calls.push({
      url,
      auth: init.headers.authorization ?? init.headers.Authorization,
      google: init.headers['x-goog-api-key'],
      model,
    })
    const ok = (body: unknown) => ({
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    })
    if (url.endsWith('/models')) return ok({ object: 'list', data: [{ id: 'm-1' }] })
    if (url.includes('/images/')) return ok(img)
    if (url.endsWith('/interactions'))
      return ok({
        status: 'completed',
        steps: [
          {
            type: 'model_output',
            content: [
              { type: 'image', data: Buffer.from([3]).toString('base64'), mime_type: 'image/png' },
            ],
          },
        ],
      })
    return ok({
      choices: [{ message: { content: '好' } }],
      usage: { prompt_tokens: 9, completion_tokens: 1 },
    })
  }
  return { fetch, calls }
}

const servers: Server[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
})

async function boot(): Promise<{ server: Server; calls: Call[] }> {
  let t = Date.parse(T0)
  const upstream = fakeUpstream()
  const server = await createServer({
    dbDir: mkdtempSync(join(tmpdir(), 'agentsws-wp274-')),
    clock: { now: () => new Date(t).toISOString() },
    random: () => {
      t += 1
      return 0.5
    },
    quiet: true,
    startRun: false,
    tokenRefreshIntervalMs: 0,
    scheduleIntervalMs: 0,
    liveDataIntervalMs: 0,
    env: {
      AGENTSWS_OWNER_EMAIL: 'owner@example.test',
      AGENTSWS_WORKSPACE_NAME: '测试品牌',
      [SECRETS_KEY_ENV]: SECRETS_KEY,
    },
    mdns: () => ({ reason: '测试里不开局域网' }),
    modelFetch: upstream.fetch,
    cloudFetch: async () => ({
      ok: false,
      status: 404,
      json: async () => ({}),
      text: async () => '',
    }),
  })
  servers.push(server)
  return { server, calls: upstream.calls }
}

interface Who {
  token: string
  assignment: string
}
const owner = (server: Server): Who => ({
  token: server.bootstrap.internalToken,
  assignment: server.bootstrap.ownerAssignment.id,
})

async function call<T>(
  server: Server,
  who: Who,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data?: T; message?: string }> {
  const headers = new Headers({ 'content-type': 'application/json' })
  headers.set('Authorization', `Bearer ${who.token}`)
  headers.set('X-Assignment', who.assignment)
  const res = await server.gateway.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
  const parsed = (await res.json()) as { data?: T; message?: string }
  return {
    status: res.status,
    ...(parsed.data === undefined ? {} : { data: parsed.data }),
    ...(parsed.message === undefined ? {} : { message: parsed.message }),
  }
}

const OPENAI = {
  kind: 'openai_compatible',
  base_url: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  region: 'global',
  api_key: OPENAI_KEY,
}
const GOOGLE = {
  kind: 'openai_compatible',
  label: 'Google Gemini',
  base_url: 'https://generativelanguage.googleapis.com/v1beta/openai',
  model: 'gemini-3.8-flash',
  region: 'global',
  api_key: GOOGLE_KEY,
}
const DEEPSEEK = {
  kind: 'deepseek',
  base_url: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  api_key: DEEPSEEK_KEY,
}

const imageView = async (server: Server, who = owner(server)): Promise<ModelImageView> =>
  (await call<ModelImageView>(server, who, 'GET', '/v1/models/image')).data as ModelImageView

describe('WP274 自动解析：文字模型同厂商且带生图', () => {
  it('自己的 OpenAI key → GPT Image 2.5：出图 flare、改图 sunburst，打 api.openai.com、用那把 key、不扣积分', async () => {
    const { server, calls } = await boot()
    expect(
      (await call(server, owner(server), 'PUT', '/v1/models/providers/openai', OPENAI)).status,
    ).toBe(200)
    const view = await imageView(server)
    expect(view.configured).toBe(true)
    expect(view.override).toBe(false)
    expect(view.official).toBe(false)
    expect(view.using).toEqual({
      source: 'own_openai',
      provider_id: 'openai',
      label: '你的 OpenAI 账号（GPT Image 2.5）',
      generate_model: 'gpt-image-2.5-flare',
      edit_model: 'gpt-image-2.5-sunburst',
      own_key: true,
    })
    const images = server.models.images
    expect(images.available).toBe(true)
    await images.generate({ prompt: 'banner', size: '1536x1024', meta })
    await images.edit?.({
      prompt: 'swap bg',
      images: [{ bytes: png, content_type: 'image/png' }],
      meta,
    })
    const gen = calls.find((c) => c.url.endsWith('/images/generations'))
    const edit = calls.find((c) => c.url.endsWith('/images/edits'))
    expect(gen).toMatchObject({
      url: 'https://api.openai.com/v1/images/generations',
      auth: `Bearer ${OPENAI_KEY}`,
      model: 'gpt-image-2.5-flare',
    })
    expect(edit).toMatchObject({
      url: 'https://api.openai.com/v1/images/edits',
      auth: `Bearer ${OPENAI_KEY}`,
      model: 'gpt-image-2.5-sunburst',
    })
  })

  it('自己的 Google key → Nano Banana 2.1：打 Google 原生 interactions 口，key 只进 x-goog-api-key', async () => {
    const { server, calls } = await boot()
    await call(server, owner(server), 'PUT', '/v1/models/providers/google', GOOGLE)
    const view = await imageView(server)
    expect(view.using).toMatchObject({
      source: 'own_google',
      label: '你的 Google 账号（Nano Banana 2.1）',
      generate_model: NANO_BANANA_MODEL,
      edit_model: NANO_BANANA_MODEL,
      own_key: true,
    })
    const out = await server.models.images.generate({ prompt: 'banner', meta })
    expect(out.assets).toHaveLength(1)
    const hit = calls.find((c) => c.url.endsWith('/interactions'))
    expect(hit).toMatchObject({
      url: 'https://generativelanguage.googleapis.com/v1beta/interactions',
      google: GOOGLE_KEY,
      auth: undefined,
      model: NANO_BANANA_MODEL,
    })
    expect(server.models.images.max_reference_images).toBe(10)
  })

  it('文字模型不带生图（DeepSeek）且没关联账号：说「生图还没配」，一张都不出', async () => {
    const { server } = await boot()
    await call(server, owner(server), 'PUT', '/v1/models/providers/deepseek', DEEPSEEK)
    const view = await imageView(server)
    expect(view.configured).toBe(false)
    expect(view.using).toBeUndefined()
    expect(view.unavailable_reason).toContain('生图还没配')
    expect(server.models.images.available).toBe(false)
  })

  it('DeepSeek + 关联过账号（设置里没加积分那张卡）→ 走 Agents 工坊云，按积分', async () => {
    const { server, calls } = await boot()
    await call(server, owner(server), 'PUT', '/v1/models/providers/deepseek', DEEPSEEK)
    server.secrets.put(CLOUD_TOKEN_SECRET_ID, { token: CLOUD_TOKEN })
    // 关联账号不经过模型设置：现取，不用等下一次保存
    const view = await imageView(server)
    expect(view.using).toMatchObject({
      source: 'cloud',
      provider_id: 'agentsws-cloud',
      own_key: false,
    })
    expect(view.using?.label).toContain('Agents 工坊积分')
    expect(view.official).toBe(true)
    await server.models.images.generate({ prompt: 'x', meta })
    const hit = calls.find((c) => c.url.endsWith('/v1/ai/images/generations'))
    expect(hit?.auth).toBe(`Bearer ${CLOUD_TOKEN}`)
    expect(hit?.model).toBe('gpt-image-2.5-flare')
  })

  it('OpenAI key 填的是中转地址（不是官方主机）：不当它带生图，退到云 / 没配', async () => {
    const { server } = await boot()
    await call(server, owner(server), 'PUT', '/v1/models/providers/relay', {
      ...OPENAI,
      base_url: 'https://relay.example.com/v1',
    })
    expect((await imageView(server)).configured).toBe(false)
  })
})

describe('WP274 单独指定的生图接口覆盖自动', () => {
  it('文字用自己的 OpenAI，但设置里指定走积分那张卡 → 走云；改回空串 → 回到自己的 OpenAI', async () => {
    const { server } = await boot()
    const me = owner(server)
    await call(server, me, 'PUT', '/v1/models/providers/openai', OPENAI)
    server.secrets.put(CLOUD_TOKEN_SECRET_ID, { token: CLOUD_TOKEN })
    await call(server, me, 'PUT', '/v1/models/providers/agentsws', {
      kind: 'agentsws_cloud',
      model: 'deepseek-flash',
    })
    const picked = (
      await call<ModelImageView>(server, me, 'PUT', '/v1/models/image', {
        provider_id: 'agentsws',
      })
    ).data
    expect(picked?.override).toBe(true)
    expect(picked?.using).toMatchObject({
      source: 'override',
      provider_id: 'agentsws',
      own_key: false,
    })
    expect(picked?.auto?.source).toBe('own_openai')
    expect(picked?.official).toBe(true)
    const back = (
      await call<ModelImageView>(server, me, 'PUT', '/v1/models/image', { provider_id: '' })
    ).data
    expect(back?.override).toBe(false)
    expect(back?.using?.source).toBe('own_openai')
  })

  it('只生图的自定义接口：不挂文字模型、不进默认下拉、不当默认；出图打它；删掉就回到自动', async () => {
    const { server, calls } = await boot()
    const me = owner(server)
    await call(server, me, 'PUT', '/v1/models/providers/deepseek', DEEPSEEK)
    const saved = await call<ModelProviderView>(
      server,
      me,
      'PUT',
      '/v1/models/providers/seedream',
      {
        kind: 'openai_compatible',
        label: '我的生图接口',
        base_url: 'https://images.example.com/api/v3',
        model: 'doubao-seedream-5-0-pro-260628',
        region: 'global',
        api_key: CUSTOM_KEY,
        image_only: true,
      },
    )
    expect(saved.data?.image_only).toBe(true)
    const view = (
      await call<ModelImageView>(server, me, 'PUT', '/v1/models/image', {
        provider_id: 'seedream',
        model: 'doubao-seedream-5-0-pro-260628',
      })
    ).data
    expect(view?.using).toMatchObject({
      source: 'override',
      provider_id: 'seedream',
      generate_model: 'doubao-seedream-5-0-pro-260628',
      own_key: true,
    })
    expect(view?.choices.find((c) => c.provider_id === 'seedream')?.image_only).toBe(true)
    // 文字那一侧看不见它
    const defaults = (await call<ModelDefaultsView>(server, me, 'GET', '/v1/models/defaults')).data
    expect(defaults?.default.startsWith('deepseek/')).toBe(true)
    expect(defaults?.choices.some((c) => c.id.startsWith('seedream/'))).toBe(false)
    // 只生图的那条没有拉文字模型清单（一次 /models 都没打它）
    expect(calls.some((c) => c.url === 'https://images.example.com/api/v3/models')).toBe(false)
    // 测试按钮不真出图（会花钱）
    const test = await call(server, me, 'POST', '/v1/models/providers/seedream/test')
    expect(test.status).toBe(400)
    expect(test.message).toContain('只用来生图')
    await server.models.images.generate({ prompt: 'x', meta })
    expect(calls.at(-1)).toMatchObject({
      url: 'https://images.example.com/api/v3/images/generations',
      auth: `Bearer ${CUSTOM_KEY}`,
    })
    await call(server, me, 'DELETE', '/v1/models/providers/seedream')
    const after = await imageView(server)
    expect(after.override).toBe(false)
    expect(after.configured).toBe(false)
  })

  it('指定的那一条坏了（key 没了）：先按自动的走，并说清楚', async () => {
    const { server } = await boot()
    const me = owner(server)
    await call(server, me, 'PUT', '/v1/models/providers/openai', OPENAI)
    await call(server, me, 'PUT', '/v1/models/providers/google', GOOGLE)
    await call(server, me, 'PUT', '/v1/models/image', { provider_id: 'google' })
    expect((await imageView(server)).using?.source).toBe('override')
    // 只删 key（配置还在）：那一条挂不上了
    for (const brand of await server.brands.all())
      for (const r of brand.secrets.list())
        if (r.connection_id.endsWith('google')) brand.secrets.remove(r.connection_id)
    const view = await imageView(server)
    expect(view.override).toBe(true)
    expect(view.using?.source).toBe('own_openai')
    expect(view.unavailable_reason).toContain('单独指定的那一条（google）现在用不了')
  })
})

describe('WP274 跟随公司默认', () => {
  it('新品牌跟随公司默认：生图读公司那一份；改生图一样被写保护挡住', async () => {
    const { server } = await boot()
    const a = owner(server)
    await call(server, a, 'PUT', '/v1/models/providers/google', GOOGLE)
    const orgs = await call<{ id: string }[]>(server, a, 'GET', '/v1/orgs')
    const org = orgs.data?.[0]?.id as string
    const created = await call<{ workspace_id: string }>(
      server,
      a,
      'POST',
      `/v1/orgs/${org}/brands`,
      {
        name: '第二个品牌',
      },
    )
    const ws = created.data?.workspace_id as string
    const switched = await call<{ session_token: string }>(
      server,
      a,
      'POST',
      `/v1/orgs/${org}/brands/${ws}/switch`,
    )
    const assignment = server.roles.assignments
      .listByPerson(server.bootstrap.person.id, { workspace_id: ws as never })
      .find((x) => x.revoked_at === undefined)
    const b: Who = {
      token: switched.data?.session_token as string,
      assignment: assignment?.id as string,
    }
    const view = await imageView(server, b)
    expect(view.using?.source).toBe('own_google')
    const denied = await call(server, b, 'PUT', '/v1/models/image', { provider_id: '' })
    expect(denied.status).toBe(400)
    expect(denied.message).toContain('跟随公司默认')
  })
})
