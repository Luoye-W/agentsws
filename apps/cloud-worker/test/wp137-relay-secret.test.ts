/**
 * WP137（P0 安全）：官方托管聊天转发器（`ChatRelayDO`）「没有真密钥就拒绝」。
 *
 * - 没配 `AGENTSWS_CHAT_RELAY_KEY`（或短于 32 字节）→ 访客面一律 503 人话；
 *   `/v1/cloud/health` 的 `chat_relay_key: false`，后台健康页那一格标红（bad）；
 * - 配了之后照常；WP124 那个写死在开源代码里的种子签出来的令牌不被接受；
 * - 留言密钥没签发（owner 还没领配对）→ 不收留言；签发了才收。
 *
 * 全替身：DO 存储用 `FakeDoStorage`，WebSocket 用假 socket，网络一概不碰。
 */

import { createHash, createHmac } from 'node:crypto'
import { OFFLINE_UNAVAILABLE, RELAY_UNAVAILABLE } from '@agentsws/chat-relay'
import type { VerifiedCloudToken } from '@agentsws/contracts'
import { describe, expect, it, vi } from 'vitest'
import {
  ChatRelayDoCore,
  type RelayDoStateLike,
  type RelayWebSocket,
} from '../src/chat-relay-do.js'
import type { WorkerEnv } from '../src/env.js'
import { withInternalHeaders } from '../src/internal.js'
import { route } from '../src/worker.js'
import { type FakeCloud, FakeDoStorage, fakeCloud, req, tokenFromMail } from './helpers.js'

const WS = 'ws_wp137'
const ORIGIN = 'https://shop.example.com'
const GOOD_KEY = 'wp137-official-relay-key-0123456789abcdef'
const ADMIN_TOKEN = 'test-admin-token-at-least-32-bytes-long-0123456789'

const principal: VerifiedCloudToken = {
  account_id: 'acc_1',
  org_id: 'org_1',
  workspace_id: WS,
  scopes: ['kol'],
}

class FakeSocket implements RelayWebSocket {
  handlers: { message?: (e: { data: unknown }) => void; close?: () => void } = {}
  send(): void {}
  close(): void {
    this.handlers.close?.()
  }
  addEventListener(type: 'message', handler: (event: { data: unknown }) => void): void
  addEventListener(type: 'close', handler: () => void): void
  addEventListener(type: 'message' | 'close', handler: (event?: { data: unknown }) => void): void {
    if (type === 'message') this.handlers.message = handler as (e: { data: unknown }) => void
    else this.handlers.close = handler as () => void
  }
  emit(text: string): void {
    this.handlers.message?.({ data: text })
  }
}

function makeRelay(
  env: Partial<WorkerEnv>,
  options: { visitorSeed?: string; anyPairing?: boolean } = {},
) {
  let server: FakeSocket | undefined
  const core = new ChatRelayDoCore(
    {
      storage: new FakeDoStorage(),
      acceptWebSocket: () => {},
    } as unknown as RelayDoStateLike,
    env as WorkerEnv,
    {
      clock: () => '2026-09-24T10:00:00.000Z',
      sessionRate: { per_minute: 10_000, per_hour: 10_000 },
      ...(options.visitorSeed === undefined ? {} : { visitorSeed: options.visitorSeed }),
      ...(options.anyPairing === true ? { verifyPairing: () => true } : {}),
      makeSocketPair: () => {
        server = new FakeSocket()
        return { client: new FakeSocket(), server }
      },
    },
  )
  const url = (path: string): string => `https://do/relay/${WS}${path}`
  return {
    core,
    url,
    async connect(pairing: string): Promise<void> {
      await core.fetch(new Request(url('/connect'), { headers: { upgrade: 'websocket' } }))
      server?.emit(
        JSON.stringify({
          type: 'hello',
          protocol_version: 1,
          workspace: WS,
          pairing,
          peer: 'server',
          config: { enabled: true, accent: '#2563eb', greeting: '你好', allowed_origins: [ORIGIN] },
        }),
      )
    },
    async issuePairing(): Promise<string> {
      const res = await core.fetch(
        withInternalHeaders(new Request('https://do/__internal/pairing', { method: 'POST' }), {
          principal,
        }),
      )
      expect(res.status).toBe(200)
      return ((await res.json()) as { data: { pairing_token: string } }).data.pairing_token
    },
    leave(): Promise<Response> {
      return core.fetch(
        new Request(url('/v1/chat/public/offline-messages'), {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: ORIGIN },
          body: JSON.stringify({ email: 'v@example.com', text: '订单没到' }),
        }),
      )
    },
  }
}

describe('WP137 · ChatRelayDO 没有访客密钥就拒绝', () => {
  it('没配 AGENTSWS_CHAT_RELAY_KEY：访客面一律 503 人话（没有兜底种子）', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const relay = makeRelay({})
    for (const [path, init] of [
      ['/widget.js', {}],
      ['/v1/chat/widget-config', { headers: { origin: ORIGIN } }],
      ['/v1/chat/public/sessions', { method: 'POST', headers: { origin: ORIGIN } }],
      ['/v1/chat/public/sessions/s_1/stream', { headers: { authorization: 'Bearer x' } }],
      ['/v1/chat/public/offline-messages', { method: 'POST', headers: { origin: ORIGIN } }],
    ] as const) {
      const res = await relay.core.fetch(new Request(relay.url(path), init as RequestInit))
      expect(res.status).toBe(503)
      expect(((await res.json()) as { error: unknown }).error).toEqual(RELAY_UNAVAILABLE)
    }
    expect(error).toHaveBeenCalledTimes(1)
    expect(String(error.mock.calls[0]?.[0])).toContain('AGENTSWS_CHAT_RELAY_KEY')
    error.mockRestore()
  })

  it('配了但短于 32 字节：同样 503；测试注入的种子也守同一条门槛', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const short = makeRelay({ AGENTSWS_CHAT_RELAY_KEY: 'short-key' })
    expect((await short.core.fetch(new Request(short.url('/widget.js')))).status).toBe(503)
    const injected = makeRelay({}, { visitorSeed: 'short-seed' })
    expect((await injected.core.fetch(new Request(injected.url('/widget.js')))).status).toBe(503)
    error.mockRestore()
  })

  it('配了真密钥照常；WP124 写死的开源种子签出的令牌不被接受', async () => {
    const relay = makeRelay({ AGENTSWS_CHAT_RELAY_KEY: GOOD_KEY }, { anyPairing: true })
    await relay.connect('any')
    const open = await relay.core.fetch(
      new Request(relay.url('/v1/chat/public/sessions'), {
        method: 'POST',
        headers: { origin: ORIGIN },
      }),
    )
    expect(open.status).toBe(200)
    const { data } = (await open.json()) as { data: { session_id: string; visitor_token: string } }
    const typing = (token: string): Promise<Response> =>
      relay.core.fetch(
        new Request(relay.url(`/v1/chat/public/sessions/${data.session_id}/typing`), {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ active: true }),
        }),
      )
    expect((await typing(data.visitor_token)).status).toBe(200)
    // 外人按开源代码里原来那个兜底种子推一把 → 伪造令牌 → 不认
    const legacyKey = createHash('sha256')
      .update(`chat-relay:${'derived'}:agentsws-chat-relay:visitor:${WS}`)
      .digest()
    const forged = createHmac('sha256', legacyKey)
      .update(`${WS}:${data.session_id}`)
      .digest('base64url')
    expect((await typing(forged)).status).toBe(401)
  })
})

describe('WP137 · ChatRelayDO 留言密钥没签发就不收留言', () => {
  it('没领配对（没有留言密钥）→ 503 人话；领了之后照收', async () => {
    const relay = makeRelay({}, { visitorSeed: GOOD_KEY, anyPairing: true })
    await relay.connect('any')
    const refused = await relay.leave()
    expect(refused.status).toBe(503)
    expect(((await refused.json()) as { error: unknown }).error).toEqual(OFFLINE_UNAVAILABLE)

    await relay.issuePairing()
    expect((await relay.leave()).status).toBe(200)
  })
})

/* ── health：公开口与后台健康页 ─────────────────────────────────────── */

async function adminSession(cloud: FakeCloud): Promise<string> {
  const email = 'boss@example.com'
  await route(
    req('/v1/admin/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${ADMIN_TOKEN}` },
      body: JSON.stringify({ email }),
    }),
    cloud.env,
  )
  await route(
    req('/v1/admin/auth/magic-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    }),
    cloud.env,
  )
  const oneTime = tokenFromMail(cloud.mails[cloud.mails.length - 1] as never)
  const cb = await route(req(`/admin/callback?token=${encodeURIComponent(oneTime)}`), cloud.env)
  const line = cb.headers.getSetCookie().find((c) => c.startsWith('__Host-agentsws_admin='))
  return decodeURIComponent((line ?? '').slice('__Host-agentsws_admin='.length).split(';')[0] ?? '')
}

async function relayHealth(
  env: Partial<WorkerEnv>,
): Promise<{ modules: Record<string, boolean>; item?: { status: string; detail?: string } }> {
  const cloud = fakeCloud({ env: { AGENTSWS_CLOUD_ADMIN_TOKEN: ADMIN_TOKEN, ...env } })
  const pub = await route(req('/v1/cloud/health'), cloud.env)
  const modules = ((await pub.json()) as { data: { modules: Record<string, boolean> } }).data
    .modules
  const session = await adminSession(cloud)
  const admin = await route(
    req('/v1/admin/health', { headers: { Cookie: `__Host-agentsws_admin=${session}` } }),
    cloud.env,
  )
  const items = ((await admin.json()) as { data: { items: { key: string; status: string }[] } })
    .data.items
  const item = items.find((i) => i.key === 'chat_relay')
  return { modules, ...(item === undefined ? {} : { item }) }
}

const fakeRelayNs = {
  idFromName: (name: string) => ({ toString: () => name }),
  get: () => ({ fetch: async () => new Response(null, { status: 404 }) }),
}

describe('WP137 · health 里的聊天转发那一格', () => {
  it('绑了转发器、没配密钥：公开口 chat_relay_key=false，后台标红', async () => {
    const h = await relayHealth({ CHAT_RELAY: fakeRelayNs })
    expect(h.modules.chat_relay).toBe(true)
    expect(h.modules.chat_relay_key).toBe(false)
    expect(h.item?.status).toBe('bad')
    // 不回任何密钥
    expect(JSON.stringify(h)).not.toContain(GOOD_KEY)
  })

  it('密钥太短同样标红；配齐了绿', async () => {
    expect(
      (await relayHealth({ CHAT_RELAY: fakeRelayNs, AGENTSWS_CHAT_RELAY_KEY: 'short' })).item
        ?.status,
    ).toBe('bad')
    const ok = await relayHealth({ CHAT_RELAY: fakeRelayNs, AGENTSWS_CHAT_RELAY_KEY: GOOD_KEY })
    expect(ok.modules.chat_relay_key).toBe(true)
    expect(ok.item?.status).toBe('ok')
    expect(JSON.stringify(ok)).not.toContain(GOOD_KEY)
  })

  it('没绑转发器：unknown（如实说没开通）', async () => {
    const h = await relayHealth({})
    expect(h.modules.chat_relay).toBe(false)
    expect(h.item?.status).toBe('unknown')
  })
})
