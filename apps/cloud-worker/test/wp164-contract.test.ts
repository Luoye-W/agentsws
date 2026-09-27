/**
 * WP164：云端对外契约（`packages/contracts/cloud-openapi.json`）↔ 真云服务。
 *
 * 起的是**真的** Workers 形态：每一条都从入口 Worker（`route`）进，经过擦头、验令牌、
 * 选对象，落到真的 AccountsDO / WalletDO / KolPublicDO / KolTenantDO / ChatRelayDO /
 * HostedInstanceDO 上（存储是 `helpers.ts` 那套 better-sqlite3 假 DO）。上游全是替身：
 * 模型汇聚层、Stripe、搜索数据服务商都是本文件里的一个 `fetch`，一个字节不出这台机器。
 *
 * 每个响应都过 `ContractRecorder.check`：路由在不在契约里、状态码写没写、正文过不过
 * schema（严格档：多一个没登记的字段也算不过）。最后一条用例核**覆盖**：
 * 契约里除值守以外的每一条路由，至少打到过一次成功响应（值守只在 Node 形态，
 * 由 `packages/standby/test/wp164-contract.test.ts` 核）。
 *
 * 这份测试随云端代码搬进私有仓，在那边继续跑（docs/83 §8 第 3 步）。
 */
import { beforeAll, describe, expect, it } from 'vitest'
import {
  ChatRelayDoCore,
  type RelayDoStateLike,
  type RelayWebSocket,
} from '../src/chat-relay-do.js'
import type { DoNamespaceLike, SnapshotBucketLike, WorkerEnv } from '../src/env.js'
import { type ContainerLike, HostedInstanceCore } from '../src/hosted-instance-do.js'
import { route } from '../src/worker.js'
import { ContractRecorder, loadCloudContract, validate } from './contract/conformance.js'
import { type FakeCloud, FakeDoStorage, fakeCloud, req, tokenFromMail, zeroOut } from './helpers.js'

const CALLBACK = 'http://127.0.0.1:3000/v1/cloud/account/callback'
const ORIGIN = 'https://shop.example.com'
/** 测试替身用的假值（都不是真密钥）。 */
const FAKE = {
  newapi: 'newapi-contract-test-key-not-real',
  stripe: 'sk_test_contract_fake_not_real',
  search: 'svc-login:contract-fake-not-real',
  relay: 'wp164-contract-relay-key-0123456789abcdef',
  emailKey: 'b'.repeat(64),
}

const contract = loadCloudContract()
const rec = new ContractRecorder(contract)

/* ------------------------------------------------------------------ */
/* 上游替身                                                             */
/* ------------------------------------------------------------------ */

const USAGE = { prompt_tokens: 12, completion_tokens: 30, total_tokens: 42 }

function sseOf(chunks: unknown[]): Response {
  const text = `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** 模型汇聚层 + Stripe + 搜索数据服务商，全在这一个 fetch 里。 */
async function upstream(url: string, init: RequestInit): Promise<Response> {
  if (url.includes('stripe.com'))
    return json({ id: 'cs_test_contract', url: 'https://checkout.stripe.test/c/1' })
  // Stripe 那一条的正文是表单，不是 JSON——所以它排在解析之前
  const body =
    typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {}
  if (url.includes('dataforseo.com') && url.includes('/serp/'))
    return json({
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
    })
  if (url.includes('dataforseo.com'))
    return json({
      status_code: 20000,
      tasks: [
        {
          status_code: 20000,
          result: [
            {
              markdown: 'Voltbrick is a solid pick (voltbrick.com).',
              sources: [{ url: 'https://voltbrick.com/p' }],
            },
          ],
        },
      ],
    })
  if (url.endsWith('/chat/completions')) {
    if (body.stream === true)
      return sseOf([
        {
          id: 'c1',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { content: '你好' } }],
        },
        { id: 'c1', object: 'chat.completion.chunk', choices: [], usage: USAGE },
      ])
    return json({
      id: 'c1',
      object: 'chat.completion',
      model: String(body.model),
      choices: [
        { index: 0, message: { role: 'assistant', content: '你好' }, finish_reason: 'stop' },
      ],
      usage: USAGE,
    })
  }
  if (url.endsWith('/embeddings'))
    return json({
      object: 'list',
      data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }],
      model: String(body.model),
      usage: USAGE,
    })
  if (url.endsWith('/images/generations')) return json({ created: 1, data: [{ b64_json: 'aGk=' }] })
  if (url.endsWith('/models'))
    return json({
      object: 'list',
      data: [
        { id: 'deepseek-chat', object: 'model' },
        { id: 'gpt-4o-mini', object: 'model' },
      ],
    })
  throw new Error(`这条用例不该打到 ${url}`)
}

/* ------------------------------------------------------------------ */
/* 转发器与托管对象的替身宿主                                             */
/* ------------------------------------------------------------------ */

class FakeContainer implements ContainerLike {
  running = false
  readonly starts: Record<string, string>[] = []
  start(options?: { env?: Record<string, string> }): void {
    this.running = true
    this.starts.push(options?.env ?? {})
  }
  monitor(): Promise<void> {
    return new Promise(() => {})
  }
  async destroy(): Promise<void> {
    this.running = false
  }
  signal(): void {}
  getTcpPort(): { fetch(url: string): Promise<Response> } {
    return { fetch: async () => new Response('{}', { status: 200 }) }
  }
}

class FakeBucket implements SnapshotBucketLike {
  readonly objects = new Map<string, Uint8Array>()
  async put(key: string, value: ArrayBuffer | Uint8Array): Promise<unknown> {
    this.objects.set(key, value instanceof Uint8Array ? value : new Uint8Array(value))
    return {}
  }
  async get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; size: number } | null> {
    const found = this.objects.get(key)
    if (found === undefined) return null
    return {
      size: found.byteLength,
      arrayBuffer: async () =>
        found.buffer.slice(found.byteOffset, found.byteOffset + found.byteLength) as ArrayBuffer,
    }
  }
  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key)
  }
}

class FakeSocket implements RelayWebSocket {
  readonly sent: string[] = []
  handlers: { message?: (e: { data: unknown }) => void; close?: () => void } = {}
  send(text: string): void {
    this.sent.push(text)
  }
  close(): void {
    this.handlers.close?.()
  }
  addEventListener(type: 'message', handler: (event: { data: unknown }) => void): void
  addEventListener(type: 'close', handler: () => void): void
  addEventListener(type: 'message' | 'close', handler: (event?: { data: unknown }) => void): void {
    if (type === 'message') this.handlers.message = handler as (e: { data: unknown }) => void
    else this.handlers.close = handler as () => void
  }
  emit(frame: unknown): void {
    this.handlers.message?.({ data: JSON.stringify(frame) })
  }
}

/* ------------------------------------------------------------------ */
/* 一整朵云                                                             */
/* ------------------------------------------------------------------ */

interface World {
  cloud: FakeCloud
  env: WorkerEnv
  containers: Map<string, FakeContainer>
  /** 最近一次 `connect` 建出来的那对 socket 的服务端那头。 */
  lastSocket(): FakeSocket
}

function makeWorld(): World {
  const cloud = fakeCloud({
    kol: true,
    kolTenant: true,
    fetch: upstream,
    env: {
      AGENTSWS_NEWAPI_KEY: FAKE.newapi,
      STRIPE_SECRET_KEY: FAKE.stripe,
      AGENTSWS_SEARCH_DATA_KEY: FAKE.search,
      AGENTSWS_CHAT_RELAY_KEY: FAKE.relay,
      AGENTSWS_HOSTED_KEY_SEED: 'wp164-hosted-seed',
      AGENTSWS_KOL_EMAIL_KEY: FAKE.emailKey,
    },
  })
  const env = cloud.env
  const bucket = new FakeBucket()
  env.HOSTED_SNAPSHOTS = bucket
  const containers = new Map<string, FakeContainer>()
  const hostedCores = new Map<string, HostedInstanceCore>()
  const relayCores = new Map<string, ChatRelayDoCore>()
  let socket: FakeSocket | undefined

  const hostedNs: DoNamespaceLike = {
    idFromName: (name) => ({ toString: () => name }),
    get: (id) => {
      const name = id.toString()
      let core = hostedCores.get(name)
      if (core === undefined) {
        const container = new FakeContainer()
        containers.set(name, container)
        core = new HostedInstanceCore({ storage: new FakeDoStorage() } as never, env, {
          container,
          bucket,
        })
        hostedCores.set(name, core)
      }
      const found = core
      return { fetch: (r: Request) => found.fetch(r) }
    },
  }
  const relayNs: DoNamespaceLike = {
    idFromName: (name) => ({ toString: () => name }),
    get: (id) => {
      const name = id.toString()
      let core = relayCores.get(name)
      if (core === undefined) {
        core = new ChatRelayDoCore(
          {
            storage: new FakeDoStorage(),
            acceptWebSocket: () => {},
          } as unknown as RelayDoStateLike,
          env,
          {
            sessionRate: { per_minute: 10_000, per_hour: 10_000 },
            makeSocketPair: () => {
              socket = new FakeSocket()
              return { client: new FakeSocket(), server: socket }
            },
          },
        )
        relayCores.set(name, core)
      }
      const found = core
      return { fetch: (r: Request) => found.fetch(r) }
    },
  }
  env.HOSTED_INSTANCE = hostedNs
  env.CHAT_RELAY = relayNs
  return {
    cloud,
    env,
    containers,
    lastSocket: () => {
      if (socket === undefined) throw new Error('还没连过')
      return socket
    },
  }
}

interface CallInit {
  method?: string
  body?: unknown
  raw?: BodyInit
  token?: string
  headers?: Record<string, string>
  /** SSE：读够几块就停（长连接不会自己结束）。 */
  sseEvents?: number
}

/** 从入口 Worker 打一条，过一遍契约，再把正文交回来。 */
async function hit(
  w: World,
  path: string,
  init: CallInit = {},
): Promise<{ status: number; body: Record<string, unknown>; res: Response }> {
  const method = init.method ?? 'GET'
  const headers = new Headers(init.headers ?? {})
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  if (init.token !== undefined) headers.set('Authorization', `Bearer ${init.token}`)
  const res = await route(
    req(path, {
      method,
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      ...(init.raw === undefined ? {} : { body: init.raw }),
    }),
    w.env,
  )
  const copy = res.clone()
  await rec.check(
    method,
    path,
    res,
    init.sseEvents === undefined ? {} : { sseEvents: init.sseEvents },
  )
  const type = copy.headers.get('content-type') ?? ''
  if (!type.includes('application/json')) return { status: copy.status, body: {}, res: copy }
  const text = await copy.text()
  return {
    status: copy.status,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
    res: copy,
  }
}

const dataOf = <T>(r: { body: Record<string, unknown> }): T => r.body.data as T

/** 走一遍 magic link → 会话 → 签一把工作区令牌。 */
async function signIn(
  w: World,
  email: string,
  workspace_id: string,
  scopes: string[] = ['ai', 'wallet:read', 'wallet:topup', 'data', 'kol'],
): Promise<{ token: string; session: string; org: string; linkId: string }> {
  await hit(w, '/v1/cloud/auth/magic-link', {
    method: 'POST',
    body: { email, callback_url: CALLBACK },
  })
  const oneTime = tokenFromMail(w.cloud.mails[w.cloud.mails.length - 1] as never)
  const verified = await hit(w, '/v1/cloud/auth/verify', {
    method: 'POST',
    body: { token: oneTime },
  })
  const session = dataOf<{ session_token: string; org: { id: string } }>(verified)
  const link = await hit(w, '/v1/cloud/links', {
    method: 'POST',
    token: session.session_token,
    body: { workspace_id, scopes },
  })
  expect(link.status).toBe(201)
  const issued = dataOf<{ token: string; link: { id: string } }>(link)
  return {
    token: issued.token,
    session: session.session_token,
    org: session.org.id,
    linkId: issued.link.id,
  }
}

/* ------------------------------------------------------------------ */
/* 用例                                                                 */
/* ------------------------------------------------------------------ */

let w: World
let me: { token: string; session: string; org: string; linkId: string }

beforeAll(async () => {
  w = makeWorld()
  me = await signIn(w, 'owner@example.com', 'ws_main')
  w.cloud.wallet(me.org).wallet.topup({ org_id: me.org, credits: 1000, kind: 'purchased' })
})

describe('WP164 契约 ↔ Workers 形态 · 账号与关联', () => {
  it('health / me / 关联的签、列、认自己、补签、续期、撤、自撤、注销', async () => {
    expect((await hit(w, '/v1/cloud/health')).status).toBe(200)
    expect((await hit(w, '/v1/cloud/me', { token: me.session })).status).toBe(200)
    expect((await hit(w, '/v1/cloud/me')).status).toBe(401)
    expect(
      (await hit(w, '/v1/cloud/auth/verify', { method: 'POST', body: { token: 'nope' } })).status,
    ).toBe(401)
    expect((await hit(w, '/v1/cloud/links', { token: me.session })).status).toBe(200)
    expect((await hit(w, '/v1/cloud/links/current', { token: me.token })).status).toBe(200)

    const sibling = await hit(w, '/v1/cloud/links/sibling', {
      method: 'POST',
      token: me.token,
      body: { workspace_id: 'ws_sibling', label: '第二个品牌' },
    })
    expect(sibling.status).toBe(201)
    const siblingId = dataOf<{ link: { id: string } }>(sibling).link.id
    const renewed = await hit(w, `/v1/cloud/links/${siblingId}/renew`, {
      method: 'POST',
      token: me.session,
      body: { ttl_days: 30 },
    })
    expect(renewed.status).toBe(200)
    const renewedToken = dataOf<{ token: string }>(renewed).token
    expect(
      (await hit(w, '/v1/cloud/links/current/revoke', { method: 'POST', token: renewedToken }))
        .status,
    ).toBe(200)

    const third = await hit(w, '/v1/cloud/links', {
      method: 'POST',
      token: me.session,
      body: { workspace_id: 'ws_third' },
    })
    const thirdId = dataOf<{ link: { id: string } }>(third).link.id
    expect(
      (await hit(w, `/v1/cloud/links/${thirdId}/revoke`, { method: 'POST', token: me.session }))
        .status,
    ).toBe(200)
    // 冲突：同一个工作区再签一次
    expect(
      (
        await hit(w, '/v1/cloud/links/sibling', {
          method: 'POST',
          token: me.token,
          body: { workspace_id: 'ws_main' },
        })
      ).status,
    ).toBe(409)

    const other = await signIn(w, 'bye@example.com', 'ws_bye')
    expect(
      (await hit(w, '/v1/cloud/auth/logout', { method: 'POST', token: other.session })).status,
    ).toBe(200)
  })
})

describe('WP164 契约 ↔ Workers 形态 · 钱包与充值', () => {
  it('余额、用量、价目、档位、按档建单；微信 501、认不出的档 400、没令牌 401、缺动作 403', async () => {
    expect((await hit(w, '/v1/wallet', { token: me.token })).status).toBe(200)
    expect((await hit(w, '/v1/wallet/usage?group=day', { token: me.token })).status).toBe(200)
    expect((await hit(w, '/v1/wallet/usage?group=nope', { token: me.token })).status).toBe(400)
    expect((await hit(w, '/v1/wallet/pricing', { token: me.token })).status).toBe(200)
    const tiers = await hit(w, '/v1/wallet/topup/tiers', { token: me.token })
    const tier = dataOf<{ tiers: { id: string }[] }>(tiers).tiers[0]?.id as string
    const order = await hit(w, '/v1/wallet/topup', {
      method: 'POST',
      token: me.token,
      body: { tier_id: tier },
    })
    expect(order.status).toBe(201)
    expect(
      (
        await hit(w, '/v1/wallet/topup', {
          method: 'POST',
          token: me.token,
          body: { provider: 'wechat' },
        })
      ).status,
    ).toBe(501)
    expect(
      (
        await hit(w, '/v1/wallet/topup', {
          method: 'POST',
          token: me.token,
          body: { tier_id: 'usd3' },
        })
      ).status,
    ).toBe(400)
    expect((await hit(w, '/v1/wallet')).status).toBe(401)
    const narrow = await signIn(w, 'narrow@example.com', 'ws_narrow', ['ai'])
    expect((await hit(w, '/v1/wallet', { token: narrow.token })).status).toBe(403)
  })
})

describe('WP164 契约 ↔ Workers 形态 · AI', () => {
  it('对话（非流式 / 流式）、向量、生图、模型清单（含 cn）；422 驻留、403 缺动作、402 没钱', async () => {
    const chat = {
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: '你好' }],
      max_tokens: 64,
    }
    expect(
      (await hit(w, '/v1/ai/chat/completions', { method: 'POST', token: me.token, body: chat }))
        .status,
    ).toBe(200)
    const streamed = await hit(w, '/v1/ai/chat/completions', {
      method: 'POST',
      token: me.token,
      body: { ...chat, stream: true },
    })
    expect(streamed.status).toBe(200)
    expect(
      (
        await hit(w, '/v1/ai/embeddings', {
          method: 'POST',
          token: me.token,
          body: { model: 'text-embedding-3-small', input: ['a', 'b'] },
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await hit(w, '/v1/ai/images/generations', {
          method: 'POST',
          token: me.token,
          body: { model: 'gpt-image-1', prompt: '一只猫' },
        })
      ).status,
    ).toBe(200)
    expect((await hit(w, '/v1/ai/models', { token: me.token })).status).toBe(200)
    const cn = { 'X-Agentsws-Region': 'cn' }
    expect((await hit(w, '/v1/ai/models', { token: me.token, headers: cn })).status).toBe(200)
    expect(
      (
        await hit(w, '/v1/ai/chat/completions', {
          method: 'POST',
          token: me.token,
          headers: cn,
          body: { ...chat, model: 'gpt-4o-mini' },
        })
      ).status,
    ).toBe(422)
    expect(
      (
        await hit(w, '/v1/ai/chat/completions', {
          method: 'POST',
          token: me.token,
          body: { messages: [] },
        })
      ).status,
    ).toBe(400)
    const noAi = await signIn(w, 'noai@example.com', 'ws_noai', ['wallet:read'])
    expect((await hit(w, '/v1/ai/models', { token: noAi.token })).status).toBe(403)
    const broke = await signIn(w, 'broke@example.com', 'ws_broke')
    zeroOut(w.cloud, broke.org)
    expect(
      (await hit(w, '/v1/ai/chat/completions', { method: 'POST', token: broke.token, body: chat }))
        .status,
    ).toBe(402)
  })
})

describe('WP164 契约 ↔ Workers 形态 · 搜索数据', () => {
  it('状态、SERP、AI 平台问答', async () => {
    expect((await hit(w, '/v1/data/search/status', { token: me.token })).status).toBe(200)
    expect(
      (
        await hit(w, '/v1/data/search/serp', {
          method: 'POST',
          token: me.token,
          body: { query: 'portable charger', engine: 'google', country: 'us', language: 'en' },
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await hit(w, '/v1/data/search/ai-answers', {
          method: 'POST',
          token: me.token,
          body: {
            question: 'best portable charger',
            platforms: ['chatgpt', 'copilot'],
            country: 'us',
            language: 'en',
            brand: { name: 'Voltbrick', domains: ['voltbrick.com'] },
          },
        })
      ).status,
    ).toBe(200)
  })
})

describe('WP164 契约 ↔ Workers 形态 · 公共红人库', () => {
  it('加观察、浏览、体检、回填、揭示、深度体检、刷新、基准、内容、争议、插件配对 / 上报 / 撤销', async () => {
    const base = '/v1/data/kol/creators/youtube/somecreator'
    const observation = {
      channel: 'youtube',
      handle: 'somecreator',
      followers: 120_000,
      posts_30d: 12,
      engagement_rate: 0.03,
      categories: ['beauty'],
      observed_at: '2026-09-14T00:00:00.000Z',
    }
    expect(
      (await hit(w, `${base}/observations`, { method: 'POST', token: me.token, body: observation }))
        .status,
    ).toBe(201)
    expect(
      (
        await hit(w, `${base}/observations`, {
          method: 'POST',
          token: me.token,
          body: { observations: [observation] },
        })
      ).status,
    ).toBe(201)
    expect(
      (await hit(w, '/v1/data/kol/creators?channel=youtube&limit=5', { token: me.token })).status,
    ).toBe(200)
    expect((await hit(w, `${base}/audit`, { token: me.token })).status).toBe(200)
    expect(
      (await hit(w, '/v1/data/kol/creators/youtube/nobodyhere/audit', { token: me.token })).status,
    ).toBe(404)
    expect(
      (
        await hit(w, `${base}/contact`, {
          method: 'POST',
          token: me.token,
          body: { email: 'hi@example.com', source: 'manual' },
        })
      ).status,
    ).toBe(201)
    expect((await hit(w, `${base}/reveal`, { method: 'POST', token: me.token })).status).toBe(200)
    expect((await hit(w, `${base}/deep-audit`, { method: 'POST', token: me.token })).status).toBe(
      200,
    )
    expect((await hit(w, `${base}/refresh`, { method: 'POST', token: me.token })).status).toBe(200)
    expect(
      (
        await hit(w, '/v1/data/kol/benchmarks?channel=youtube&followers=120000', {
          token: me.token,
        })
      ).status,
    ).toBe(200)
    const content = {
      channel: 'youtube',
      handle: 'somecreator',
      external_id: 'vid1',
      content_type: 'video',
      title: 'Video 1',
      duration_seconds: 300,
      views: 1_000,
      likes: 50,
      comments: 7,
      paid_promotion: false,
      shoppable: true,
      observed_at: '2026-09-14T08:00:00.000Z',
    }
    expect(
      (
        await hit(w, '/v1/data/kol/content-observations', {
          method: 'POST',
          token: me.token,
          body: { observations: [content] },
        })
      ).status,
    ).toBe(201)
    expect(
      (
        await hit(w, `${base}/disputes`, {
          method: 'POST',
          token: me.token,
          body: { field: 'followers', claim: '粉丝数不对' },
        })
      ).status,
    ).toBe(201)
    const paired = await hit(w, '/v1/data/kol/plugins/pair', {
      method: 'POST',
      token: me.token,
      body: { label: 'Chrome' },
    })
    expect(paired.status).toBe(201)
    const plugin = dataOf<{ token: string; pairing: { token_sha256: string } }>(paired)
    expect(
      (
        await hit(w, '/v1/data/kol/plugins/observations', {
          method: 'POST',
          token: plugin.token,
          body: { observations: [{ ...observation, handle: 'pluginseen' }] },
        })
      ).status,
    ).toBe(201)
    expect(
      (
        await hit(w, '/v1/data/kol/plugins/content-observations', {
          method: 'POST',
          token: plugin.token,
          body: { observations: [{ ...content, external_id: 'vid2' }] },
        })
      ).status,
    ).toBe(201)
    expect(
      (
        await hit(w, `/v1/data/kol/plugins/${plugin.pairing.token_sha256}/revoke`, {
          method: 'POST',
          token: me.token,
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await hit(w, '/v1/data/kol/plugins/observations', {
          method: 'POST',
          token: plugin.token,
          body: { observations: [] },
        })
      ).status,
    ).toBe(401)
    const broke = await signIn(w, 'kolbroke@example.com', 'ws_kolbroke')
    zeroOut(w.cloud, broke.org)
    expect(
      (await hit(w, '/v1/data/kol/creators?channel=youtube', { token: broke.token })).status,
    ).toBe(402)
  })
})

describe('WP164 契约 ↔ Workers 形态 · 云端红人库', () => {
  it('状态、没订阅推 402、开通、推、拉、冲突、导出、删、取消', async () => {
    const creator = {
      kind: 'creator',
      id: 'c1',
      version: 1,
      updated_at: '2026-02-01T00:00:00.000Z',
      writer: 'device:a',
      body: { handle: 'someone', followers: 1000 },
    }
    expect((await hit(w, '/v1/kol/sync/status', { token: me.token })).status).toBe(200)
    expect(
      (
        await hit(w, '/v1/kol/sync/push', {
          method: 'POST',
          token: me.token,
          body: { writer: 'device:a', objects: [creator] },
        })
      ).status,
    ).toBe(402)
    expect((await hit(w, '/v1/kol/subscription', { method: 'POST', token: me.token })).status).toBe(
      200,
    )
    expect(
      (
        await hit(w, '/v1/kol/sync/push', {
          method: 'POST',
          token: me.token,
          body: { writer: 'device:a', objects: [creator] },
        })
      ).status,
    ).toBe(200)
    // 另一台设备写一份更旧的 → 冲突
    await hit(w, '/v1/kol/sync/push', {
      method: 'POST',
      token: me.token,
      body: {
        writer: 'device:b',
        objects: [
          {
            ...creator,
            writer: 'device:b',
            updated_at: '2026-01-05T00:00:00.000Z',
            body: { handle: 'someone', followers: 2000 },
          },
        ],
      },
    })
    expect((await hit(w, '/v1/kol/sync/pull?limit=10', { token: me.token })).status).toBe(200)
    const conflicts = await hit(w, '/v1/kol/sync/conflicts?limit=10', { token: me.token })
    expect(conflicts.status).toBe(200)
    expect(
      (
        await hit(w, '/v1/kol/sync/conflicts/resolve', {
          method: 'POST',
          token: me.token,
          body: { kind: 'creator', id: 'c1' },
        })
      ).status,
    ).toBe(200)
    expect((await hit(w, '/v1/kol/cloud/export', { token: me.token })).status).toBe(200)
    expect((await hit(w, '/v1/kol/cloud', { method: 'DELETE', token: me.token })).status).toBe(200)
    expect(
      (await hit(w, '/v1/kol/subscription', { method: 'DELETE', token: me.token })).status,
    ).toBe(200)
  })
})

describe('WP164 契约 ↔ Workers 形态 · 客服订阅、聊天转发、托管实例', () => {
  it('订阅、配对、连上转发器、访客挂件全套、拉留言、托管状态与快照、取消', async () => {
    const connectPath = '/relay/{workspace}/connect'
    expect((await hit(w, '/v1/support/subscription', { token: me.token })).status).toBe(200)
    // 从没开通过：托管状态照样回（workspace_id 空串），快照 204
    expect((await hit(w, '/v1/support/hosted', { token: me.token })).status).toBe(200)
    expect(
      (await hit(w, '/v1/support/subscription', { method: 'POST', token: me.token })).status,
    ).toBe(200)

    const pairing = await hit(w, '/v1/chat/relay/pairing', { method: 'POST', token: me.token })
    expect(pairing.status).toBe(200)
    const prk = dataOf<{ pairing_token: string }>(pairing).pairing_token
    expect(
      (await hit(w, '/v1/chat/relay/pairing', { method: 'POST', token: me.token })).status,
    ).toBe(409)

    // 长连接：Node 的 Response 不收 101，替身回 200（见 chat-relay-do.ts 的 #connect）
    const connected = await route(
      req('/relay/ws_main/connect', { headers: { upgrade: 'websocket' } }),
      w.env,
    )
    expect(connected.status).toBe(200)
    rec.mark('GET', connectPath, 101)
    const socket = w.lastSocket()
    const hello = {
      type: 'hello',
      protocol_version: 1,
      workspace: 'ws_main',
      pairing: prk,
      peer: 'server',
      config: { enabled: true, accent: '#2563eb', greeting: '你好', allowed_origins: [ORIGIN] },
    }
    rec.checkWsFrame(connectPath, 'client', hello)
    socket.emit(hello)
    expect((await hit(w, '/v1/chat/relay/status', { token: me.token })).status).toBe(200)

    const origin = { Origin: ORIGIN }
    expect((await hit(w, '/relay/ws_main/widget.js')).status).toBe(200)
    expect((await hit(w, '/relay/ws_main/v1/chat/widget-config', { headers: origin })).status).toBe(
      200,
    )
    expect(
      (await hit(w, '/relay/ws_main/v1/chat/public/sessions', { method: 'POST' })).status,
    ).toBe(403)
    const session = await hit(w, '/relay/ws_main/v1/chat/public/sessions', {
      method: 'POST',
      headers: origin,
    })
    expect(session.status).toBe(200)
    const { session_id, visitor_token } = dataOf<{ session_id: string; visitor_token: string }>(
      session,
    )
    const sp = `/relay/ws_main/v1/chat/public/sessions/${session_id}`
    expect(
      (
        await hit(w, `${sp}/typing`, {
          method: 'POST',
          token: visitor_token,
          body: { active: true },
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await hit(w, `${sp}/messages`, {
          method: 'POST',
          token: visitor_token,
          headers: origin,
          body: { text: '在吗' },
        })
      ).status,
    ).toBe(202)

    // 访客流：先开流（第一块 open），对面回一句，再读第二块
    const stream = await route(
      req(`${sp}/stream`, { headers: { Authorization: `Bearer ${visitor_token}` } }),
      w.env,
    )
    const frames = socket.sent.map((t) => JSON.parse(t) as Record<string, unknown>)
    for (const frame of frames) rec.checkWsFrame(connectPath, 'server', frame)
    const visit = frames.find((f) => f.type === 'visit') as { session: string; turn: string }
    const reply = {
      type: 'reply',
      session: visit.session,
      turn: visit.turn,
      message_id: 'm1',
      text: '在的',
    }
    rec.checkWsFrame(connectPath, 'client', reply)
    socket.emit(reply)
    await rec.check('GET', `${sp}/stream`, stream, { sseEvents: 2 })

    expect(
      (
        await hit(w, '/relay/ws_main/v1/chat/public/offline-messages', {
          method: 'POST',
          headers: origin,
          body: { email: 'buyer@example.com', text: '有货吗', order_ref: 'A100' },
        })
      ).status,
    ).toBe(200)
    expect(
      (await hit(w, '/v1/chat/relay/offline-messages', { method: 'POST', token: me.token })).status,
    ).toBe(200)

    // 托管实例：开通之后容器起来了，拿到它那把 wst_hosted_
    expect((await hit(w, '/v1/support/hosted', { token: me.token })).status).toBe(200)
    expect((await hit(w, '/v1/support/hosted/snapshot', { token: me.token })).status).toBe(204)
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])
    expect(
      (
        await hit(w, '/v1/support/hosted/snapshot', {
          method: 'PUT',
          token: me.token,
          raw: zip,
          headers: { 'content-type': 'application/zip', 'content-length': String(zip.byteLength) },
        })
      ).status,
    ).toBe(200)
    expect((await hit(w, '/v1/support/hosted/snapshot', { token: me.token })).status).toBe(200)
    const hostedToken = w.containers.get('ws_main')?.starts.at(-1)
      ?.AGENTSWS_CLOUD_WORKSPACE_TOKEN as string
    expect(hostedToken).toMatch(/^wst_hosted_/)
    expect((await hit(w, '/v1/hosted/snapshot', { token: hostedToken })).status).toBe(200)
    expect(
      (
        await hit(w, '/v1/hosted/snapshot', {
          method: 'PUT',
          token: hostedToken,
          raw: zip,
          headers: { 'content-type': 'application/zip', 'content-length': String(zip.byteLength) },
        })
      ).status,
    ).toBe(200)
    // 两类钥匙互不通用
    expect((await hit(w, '/v1/hosted/snapshot', { token: me.token })).status).toBe(401)

    expect(
      (await hit(w, '/v1/support/subscription', { method: 'DELETE', token: me.token })).status,
    ).toBe(200)
  })
})

describe('WP164 校验器自己', () => {
  it('多一个没登记的字段、类型不对、缺必填，都判不过（严格档不放水）', () => {
    const schema = { $ref: '#/components/schemas/WorkspaceLinkView' }
    const good = {
      id: 'l1',
      workspace_id: 'ws',
      cloud_org_id: 'o',
      label: 'x',
      scopes: ['ai'],
      created_at: 't',
      expires_at: 't',
      active: true,
    }
    expect(validate(contract, schema, good)).toEqual([])
    expect(validate(contract, schema, { ...good, token_sha256: 'leak' })).toHaveLength(1)
    expect(validate(contract, schema, { ...good, active: 'yes' })).toHaveLength(1)
    expect(validate(contract, schema, { ...good, scopes: ['root'] })).toHaveLength(1)
    const { id: _drop, ...missing } = good
    expect(validate(contract, schema, missing)).toHaveLength(1)
  })
})

describe('WP164 契约覆盖', () => {
  it('契约里（值守以外）的每一条路由都打到过一次成功响应', () => {
    const tags = [
      'account',
      'wallet',
      'ai',
      'data-search',
      'kol-public',
      'kol-cloud',
      'support',
      'chat-relay',
      'hosted',
    ]
    expect(rec.missingSuccess(tags)).toEqual([])
  })
})
