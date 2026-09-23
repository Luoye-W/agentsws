/**
 * WP128：客服增值服务的托管实例（`HostedInstanceDO` + `ChatRelayDO` 切对端）。
 *
 * 全替身：容器是 {@link FakeContainer}（`ctx.container` 那几样：running / start /
 * signal / destroy / getTcpPort），R2 是一张 Map，WebSocket 是可驱动的假 socket，
 * 钱包是一台录音机。一个字节不出这台机器，一个 Docker 都不起。
 */

import { DEFAULT_CLOUD_SCOPES, type VerifiedCloudToken } from '@agentsws/contracts'
import { HOSTED_KEEPALIVE_MS, type HostedInstanceStatus } from '@agentsws/hosted'
import type { SubscriptionWallet } from '@agentsws/kol-cloud'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  ChatRelayDoCore,
  type RelayDoStateLike,
  type RelayWebSocket,
} from '../src/chat-relay-do.js'
import type { DoNamespaceLike, SnapshotBucketLike, WorkerEnv } from '../src/env.js'
import {
  type ContainerLike,
  HOSTED_INTERNAL,
  HostedInstanceCore,
  STOP_GRACE_MS,
} from '../src/hosted-instance-do.js'
import { hostedTokenVerifier } from '../src/hosted-routes.js'
import { withInternalHeaders } from '../src/internal.js'
import { route } from '../src/worker.js'
import {
  type FakeCloud,
  FakeDoStorage,
  fakeCloud,
  req,
  SIGNUP_BONUS,
  tokenFromMail,
} from './helpers.js'

const WS = 'ws_hosted_test'
const ORIGIN = 'https://shop.example.com'
const T0 = '2026-09-23T10:00:00.000Z'
const DAY = 86_400_000

const plus = (iso: string, ms: number): string => new Date(Date.parse(iso) + ms).toISOString()

/** 假的 `ctx.container`：记下每次 start 的环境变量、发过的信号、被强停几次。 */
class FakeContainer implements ContainerLike {
  running = false
  healthy = true
  readonly starts: Record<string, string>[] = []
  readonly signals: number[] = []
  destroyed = 0
  healthProbes = 0

  start(options?: { env?: Record<string, string> }): void {
    this.running = true
    this.starts.push(options?.env ?? {})
  }
  monitor(): Promise<void> {
    return new Promise(() => {})
  }
  async destroy(): Promise<void> {
    this.running = false
    this.destroyed += 1
  }
  signal(signo: number): void {
    this.signals.push(signo)
  }
  getTcpPort(_port: number): { fetch(url: string): Promise<Response> } {
    return {
      fetch: async (url: string) => {
        this.healthProbes += 1
        expect(url).toBe('http://container/v1/health')
        return new Response('{}', { status: this.healthy ? 200 : 503 })
      },
    }
  }
  /** 平台滚动更新 / 进程崩了。 */
  crash(): void {
    this.running = false
  }
  lastEnv(): Record<string, string> {
    return this.starts[this.starts.length - 1] ?? {}
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

/** 一对可驱动的假 WS（与 wp124 那份同一个语义）。 */
class FakeWSSide implements RelayWebSocket {
  readonly inbox: { data: unknown }[] = []
  handlers: { message?: (e: { data: unknown }) => void; close?: () => void } = {}
  peer: FakeWSSide | undefined
  send(text: string): void {
    this.inbox.push({ data: text })
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
  emit(text: string): void {
    this.handlers.message?.({ data: text })
  }
  frames(): Record<string, unknown>[] {
    return this.inbox.map((e) => JSON.parse(String(e.data)) as Record<string, unknown>)
  }
}

interface World {
  clock: { now: string }
  env: WorkerEnv
  relay: ChatRelayDoCore
  relayStorage: FakeDoStorage
  hosted: HostedInstanceCore
  hostedStorage: FakeDoStorage
  container: FakeContainer
  bucket: FakeBucket
  wallet: { ok: boolean; charges: number }
  principal: VerifiedCloudToken
  subscribe(): Promise<string>
  cancel(): Promise<string>
  relayAlarm(): Promise<void>
  hostedAlarm(): Promise<void>
  status(): HostedInstanceStatus
  relayStatus(): Promise<Record<string, unknown>>
  issueOwnerPairing(): Promise<string>
  connect(peer: 'server' | 'hosted', pairing: string): Promise<FakeWSSide>
  visit(text: string): Promise<void>
}

/** 一个工作区：转发器 + 托管对象 + 假容器 + 假桶，共享一个可拨的钟。 */
function makeWorld(over: { seed?: string | null; env?: Partial<WorkerEnv> } = {}): World {
  const clock = { now: T0 }
  const container = new FakeContainer()
  const bucket = new FakeBucket()
  const hostedStorage = new FakeDoStorage()
  const relayStorage = new FakeDoStorage()
  const wallet = { ok: true, charges: 0 }
  const principal: VerifiedCloudToken = {
    account_id: 'acc_owner',
    org_id: 'org_1',
    workspace_id: WS,
    scopes: ['ai', 'wallet:read'],
  }
  const env = {
    AGENTSWS_CLOUD_BASE_URL: 'https://cloud.example.test',
    ...(over.seed === null ? {} : { AGENTSWS_HOSTED_KEY_SEED: over.seed ?? 'test-seed' }),
    ...over.env,
  } as WorkerEnv
  let hosted: HostedInstanceCore | undefined
  const hostedNs: DoNamespaceLike = {
    idFromName: (name) => ({ toString: () => name }),
    get: () => ({ fetch: (r: Request) => (hosted as HostedInstanceCore).fetch(r) }),
  }
  env.HOSTED_INSTANCE = hostedNs
  env.HOSTED_SNAPSHOTS = bucket
  hosted = new HostedInstanceCore({ storage: hostedStorage }, env, {
    clock: () => clock.now,
    container,
    bucket,
  })
  const subscriptionWallet: SubscriptionWallet = {
    async charge() {
      wallet.charges += 1
      return wallet.ok ? { ok: true, credits: 30 } : { ok: false, reason: '余额不足' }
    },
  }
  let lastPair: { client: FakeWSSide; server: FakeWSSide } | undefined
  const relay = new ChatRelayDoCore(
    { storage: relayStorage, acceptWebSocket: () => {} } as unknown as RelayDoStateLike,
    env,
    {
      clock: () => clock.now,
      wallet: subscriptionWallet,
      sessionRate: { per_minute: 10_000, per_hour: 10_000 },
      makeSocketPair: () => {
        lastPair = { client: new FakeWSSide(), server: new FakeWSSide() }
        return lastPair
      },
    },
  )
  const internal = (path: string, method = 'GET'): Request =>
    withInternalHeaders(new Request(`https://do/__internal/${path}`, { method }), { principal })
  let session: { session_id: string; visitor_token: string } | undefined

  const world: World = {
    clock,
    env,
    relay,
    relayStorage,
    hosted,
    hostedStorage,
    container,
    bucket,
    wallet,
    principal,
    subscribe: async () => {
      const res = await relay.fetch(internal('support-subscription', 'POST'))
      return ((await res.json()) as { data: { status: string } }).data.status
    },
    cancel: async () => {
      const res = await relay.fetch(internal('support-subscription', 'DELETE'))
      return ((await res.json()) as { data: { status: string } }).data.status
    },
    relayAlarm: () => relay.alarm(),
    hostedAlarm: () => (hosted as HostedInstanceCore).alarm(),
    status: () => (hosted as HostedInstanceCore).status(clock.now),
    relayStatus: async () => {
      const res = await relay.fetch(internal('status'))
      return ((await res.json()) as { data: Record<string, unknown> }).data
    },
    issueOwnerPairing: async () => {
      const res = await relay.fetch(internal('pairing', 'POST'))
      return ((await res.json()) as { data: { pairing_token: string } }).data.pairing_token
    },
    connect: async (peer, pairing) => {
      await relay.fetch(
        new Request(`https://do/relay/${WS}/connect`, { headers: { upgrade: 'websocket' } }),
      )
      const server = (lastPair as { server: FakeWSSide }).server
      server.emit(
        JSON.stringify({
          type: 'hello',
          protocol_version: 1,
          workspace: WS,
          pairing,
          peer,
          config: { enabled: true, accent: '#2563eb', greeting: '你好', allowed_origins: [ORIGIN] },
        }),
      )
      return server
    },
    visit: async (text) => {
      if (session === undefined) {
        const res = await relay.fetch(
          new Request(`https://do/relay/${WS}/v1/chat/public/sessions`, {
            method: 'POST',
            headers: { origin: ORIGIN },
          }),
        )
        session = ((await res.json()) as { data: { session_id: string; visitor_token: string } })
          .data
      }
      await relay.fetch(
        new Request(
          `https://do/relay/${WS}/v1/chat/public/sessions/${session.session_id}/messages`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              origin: ORIGIN,
              authorization: `Bearer ${session.visitor_token}`,
            },
            body: JSON.stringify({ text }),
          },
        ),
      )
    },
  }
  return world
}

const visits = (side: FakeWSSide): number => side.frames().filter((f) => f.type === 'visit').length

describe('WP128 · 订阅起容器', () => {
  it('开通 → 起容器（环境变量只带这一个工作区的令牌与配对，工作区号只出现一处）→ 闹钟接上', async () => {
    const w = makeWorld()
    expect(await w.subscribe()).toBe('active')
    expect(w.container.running).toBe(true)
    expect(w.container.starts).toHaveLength(1)
    const env = w.container.lastEnv()
    expect(env.AGENTSWS_HOSTED).toBe('1')
    expect(env.AGENTSWS_WORKSPACE_ID).toBe(WS)
    expect(env.AGENTSWS_CLOUD_WORKSPACE_TOKEN).toMatch(/^wst_hosted_/)
    expect(env.AGENTSWS_HOSTED_RELAY_PAIRING).toMatch(/^hrp_/)
    expect(env.AGENTSWS_SECRETS_KEY).toMatch(/^[0-9a-f]{64}$/)
    expect(Object.values(env).filter((v) => v === WS)).toHaveLength(1)
    // 种子不在任何一个环境变量里（只有派生出来的那把）
    expect(JSON.stringify(env)).not.toContain('test-seed')
    const status = w.status()
    expect(status.desired).toBe('run')
    expect(status.state).toBe('starting')
    expect(w.hostedStorage.alarmAt).toBe(Date.parse(T0) + HOSTED_KEEPALIVE_MS)
    // 转发器那边也接上了六小时一拍（以前第一拍没人接）
    expect(w.relayStorage.alarmAt).not.toBeNull()
  })

  it('心跳：alarm 打一次 /v1/health，应了就是「在跑」；三次不应就强停、下一拍重起', async () => {
    const w = makeWorld()
    await w.subscribe()
    w.clock.now = plus(T0, HOSTED_KEEPALIVE_MS)
    await w.hostedAlarm()
    expect(w.container.healthProbes).toBe(1)
    expect(w.status().state).toBe('running')
    expect(w.status().last_heartbeat_at).toBe(w.clock.now)

    w.container.healthy = false
    for (let i = 1; i <= 3; i += 1) {
      w.clock.now = plus(T0, HOSTED_KEEPALIVE_MS * (1 + i))
      await w.hostedAlarm()
    }
    expect(w.container.destroyed).toBe(1)
    expect(w.status().last_error).toContain('心跳')
    w.container.healthy = true
    w.clock.now = plus(w.clock.now, HOSTED_KEEPALIVE_MS)
    await w.hostedAlarm()
    expect(w.container.running).toBe(true)
    expect(w.status().restarts_this_month).toBe(1)
  })

  it('平台滚动更新 / 崩了：下一拍重起，换一把新令牌（旧的当场作废）', async () => {
    const w = makeWorld()
    await w.subscribe()
    const first = w.container.lastEnv().AGENTSWS_CLOUD_WORKSPACE_TOKEN as string
    w.container.crash()
    expect(w.status().state).toBe('sleeping')
    w.clock.now = plus(T0, HOSTED_KEEPALIVE_MS)
    await w.hostedAlarm()
    expect(w.container.starts).toHaveLength(2)
    const second = w.container.lastEnv().AGENTSWS_CLOUD_WORKSPACE_TOKEN as string
    expect(second).not.toBe(first)
    expect(w.hosted.verifyToken(first, w.clock.now)).toBeUndefined()
    expect(w.hosted.verifyToken(second, w.clock.now)?.workspace_id).toBe(WS)
    // 同一个工作区派生出同一把库密钥：重起之后读得回自己推上去的快照
    expect(w.container.starts[0]?.AGENTSWS_SECRETS_KEY).toBe(
      w.container.lastEnv().AGENTSWS_SECRETS_KEY,
    )
  })

  it('没配种子：不起容器，状态里写一句人话（不假装在跑）', async () => {
    const w = makeWorld({ seed: null })
    await w.subscribe()
    expect(w.container.running).toBe(false)
    expect(w.status().last_error).toContain('AGENTSWS_HOSTED_KEY_SEED')
    expect(w.status().state).toBe('sleeping')
  })

  it('费用估算：basic 常驻整月约 8.5 美元；跑了一小时就是一小时的钱', async () => {
    const w = makeWorld()
    await w.subscribe()
    w.clock.now = plus(T0, 60 * 60 * 1000)
    const status = w.status()
    expect(status.instance_type).toBe('basic')
    expect(status.running_seconds_this_month).toBe(3600)
    expect(status.cost_estimate_usd_full_month).toBeCloseTo(8.5, 1)
    expect(status.cost_estimate_usd_this_month).toBeCloseTo(0.0118, 3)
  })
})

describe('WP128 · 切对端', () => {
  it('托管用自己那把配对连上来；本机开机不把它挤下线；访客消息给托管', async () => {
    const w = makeWorld()
    const ownerPairing = await w.issueOwnerPairing()
    await w.subscribe()
    const hostedPairing = w.container.lastEnv().AGENTSWS_HOSTED_RELAY_PAIRING as string
    const hosted = await w.connect('hosted', hostedPairing)
    expect(hosted.frames().some((f) => f.type === 'hello_ok')).toBe(true)
    const local = await w.connect('server', ownerPairing)
    expect(local.frames().some((f) => f.type === 'hello_ok')).toBe(true)
    await w.visit('这件衣服有 M 码吗')
    expect(visits(hosted)).toBe(1)
    expect(visits(local)).toBe(0)
    const status = await w.relayStatus()
    expect(status.peer_kind).toBe('hosted')
    expect(status.peers).toEqual(['hosted', 'server'])
    expect((status.hosted as HostedInstanceStatus).desired).toBe('run')
  })

  it('两把配对互不通用：托管那把冒充不了本机，本机那把冒充不了托管', async () => {
    const w = makeWorld()
    const ownerPairing = await w.issueOwnerPairing()
    await w.subscribe()
    const hostedPairing = w.container.lastEnv().AGENTSWS_HOSTED_RELAY_PAIRING as string
    const fakeLocal = await w.connect('server', hostedPairing)
    expect(fakeLocal.frames().some((f) => f.type === 'hello_err')).toBe(true)
    const fakeHosted = await w.connect('hosted', ownerPairing)
    expect(fakeHosted.frames().some((f) => f.type === 'hello_err')).toBe(true)
  })
})

describe('WP128 · 取消停容器', () => {
  it('取消 = 当期用完为止：cancelling 期间照跑；到期那一拍 SIGTERM → 一分钟后强停 → 快照留 30 天后删', async () => {
    const w = makeWorld()
    const ownerPairing = await w.issueOwnerPairing()
    await w.subscribe()
    const token = w.container.lastEnv().AGENTSWS_CLOUD_WORKSPACE_TOKEN as string
    const hostedPairing = w.container.lastEnv().AGENTSWS_HOSTED_RELAY_PAIRING as string
    const hosted = await w.connect('hosted', hostedPairing)
    const local = await w.connect('server', ownerPairing)
    // 容器推过一份快照
    await w.hosted.fetch(
      withInternalHeaders(
        new Request(`https://hosted.internal${HOSTED_INTERNAL.snapshot}`, {
          method: 'PUT',
          body: new Uint8Array([1, 2, 3]),
        }),
        { principal: w.principal },
      ),
    )
    expect(await w.cancel()).toBe('cancelling')
    expect(w.container.running).toBe(true)
    expect(w.status().desired).toBe('run')

    // 当期（一个月）用完之后的那一拍
    w.clock.now = plus(T0, 32 * DAY)
    await w.relayAlarm()
    expect(w.container.signals).toEqual([15])
    const stopped = w.status()
    expect(stopped.desired).toBe('stop')
    expect(stopped.state).toBe('stopped')
    expect(stopped.stop_reason).toBe('cancelled')
    expect(stopped.snapshot_kept_until).toBe(plus(w.clock.now, 30 * DAY))
    // 令牌当场作废；转发器不再认托管那把配对；访客消息回到本机
    expect(w.hosted.verifyToken(token, w.clock.now)).toBeUndefined()
    await w.visit('还在吗')
    expect(visits(local)).toBe(1)
    expect(visits(hosted)).toBe(0)
    const again = await w.connect('hosted', hostedPairing)
    expect(again.frames().some((f) => f.type === 'hello_err')).toBe(true)

    // SIGTERM 之后一分钟还在：强停
    w.clock.now = plus(w.clock.now, STOP_GRACE_MS)
    await w.hostedAlarm()
    expect(w.container.destroyed).toBe(1)
    expect(w.bucket.objects.size).toBe(1)
    // 30 天后：快照删掉
    w.clock.now = plus(w.clock.now, 30 * DAY)
    await w.hostedAlarm()
    expect(w.bucket.objects.size).toBe(0)
    expect(w.status().snapshot).toBeUndefined()
  })

  it('30 天内重新订阅：接着用那份快照（不删），容器重新起来', async () => {
    const w = makeWorld()
    await w.subscribe()
    await w.cancel()
    w.clock.now = plus(T0, 32 * DAY)
    await w.relayAlarm()
    expect(w.status().desired).toBe('stop')
    w.clock.now = plus(w.clock.now, 5 * DAY)
    expect(await w.subscribe()).toBe('active')
    const status = w.status()
    expect(status.desired).toBe('run')
    expect(status.snapshot_kept_until).toBeUndefined()
    expect(w.container.running).toBe(true)
  })
})

describe('WP128 · 欠费宽限', () => {
  it('扣不上 → 宽限：容器照跑（充上钱不用再冷启动）；宽限到期 → 停，理由 suspended', async () => {
    const w = makeWorld()
    w.wallet.ok = false
    expect(await w.subscribe()).toBe('grace')
    expect(w.container.running).toBe(true)
    // 宽限期内的六小时一拍：还是跑
    w.clock.now = plus(T0, 10 * DAY)
    await w.relayAlarm()
    expect(w.status().desired).toBe('run')
    // 宽限 30 天到期
    w.clock.now = plus(T0, 31 * DAY)
    await w.relayAlarm()
    const status = w.status()
    expect(status.desired).toBe('stop')
    expect(status.stop_reason).toBe('suspended')
    expect(w.container.signals).toEqual([15])
  })
})

/* ── 从入口 Worker 走完整条路：令牌两类互不通用、AI 计积分、快照对齐 ─────── */

const CALLBACK = 'http://127.0.0.1:3000/v1/cloud/account/callback'

async function call(
  cloud: FakeCloud,
  path: string,
  init: { method?: string; body?: unknown; raw?: Uint8Array; token?: string } = {},
): Promise<{ status: number; res: Response }> {
  const headers = new Headers()
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  if (init.token !== undefined) headers.set('Authorization', `Bearer ${init.token}`)
  const res = await route(
    req(path, {
      method: init.method ?? 'GET',
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      ...(init.raw === undefined ? {} : { body: init.raw }),
    }),
    cloud.env,
  )
  return { status: res.status, res }
}

async function ownerToken(
  cloud: FakeCloud,
  workspace_id: string,
): Promise<{ token: string; org: string }> {
  await call(cloud, '/v1/cloud/auth/magic-link', {
    method: 'POST',
    body: { email: 'owner@example.com', callback_url: CALLBACK },
  })
  const oneTime = tokenFromMail(cloud.mails[cloud.mails.length - 1] as never)
  const verified = await call(cloud, '/v1/cloud/auth/verify', {
    method: 'POST',
    body: { token: oneTime },
  })
  const data = (
    (await verified.res.json()) as { data: { session_token: string; org: { id: string } } }
  ).data
  const link = await call(cloud, '/v1/cloud/links', {
    method: 'POST',
    token: data.session_token,
    body: { workspace_id, scopes: DEFAULT_CLOUD_SCOPES },
  })
  const token = ((await link.res.json()) as { data: { token: string } }).data.token
  return { token, org: data.org.id }
}

describe('WP128 · 入口 Worker：两把钥匙、AI 计积分、本机上线对齐', () => {
  let cloud: FakeCloud
  let container: FakeContainer
  let bucket: FakeBucket
  let owner: { token: string; org: string }
  let hostedToken: string

  beforeEach(async () => {
    container = new FakeContainer()
    bucket = new FakeBucket()
    cloud = fakeCloud({
      env: { AGENTSWS_HOSTED_KEY_SEED: 'test-seed', AGENTSWS_NEWAPI_KEY: 'test-upstream-key' },
      fetch: async () =>
        Response.json({
          id: 'c1',
          choices: [{ index: 0, message: { role: 'assistant', content: '有的' } }],
          usage: { prompt_tokens: 10, completion_tokens: 20 },
        }),
    })
    const hostedCores = new Map<string, HostedInstanceCore>()
    const relayCores = new Map<string, ChatRelayDoCore>()
    cloud.env.HOSTED_SNAPSHOTS = bucket
    cloud.env.HOSTED_INSTANCE = {
      idFromName: (name) => ({ toString: () => name }),
      get: (id) => {
        const name = id.toString()
        let core = hostedCores.get(name)
        if (core === undefined) {
          core = new HostedInstanceCore({ storage: new FakeDoStorage() }, cloud.env, {
            container,
            bucket,
          })
          hostedCores.set(name, core)
        }
        const found = core
        return { fetch: (r: Request) => found.fetch(r) }
      },
    }
    cloud.env.CHAT_RELAY = {
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
            cloud.env,
            { wallet: { charge: async () => ({ ok: true, credits: 30 }) } },
          )
          relayCores.set(name, core)
        }
        const found = core
        return { fetch: (r: Request) => found.fetch(r) }
      },
    }
    owner = await ownerToken(cloud, WS)
    const sub = await call(cloud, '/v1/support/subscription', {
      method: 'POST',
      token: owner.token,
    })
    expect(sub.status).toBe(200)
    hostedToken = container.lastEnv().AGENTSWS_CLOUD_WORKSPACE_TOKEN as string
    expect(hostedToken).toMatch(/^wst_hosted_/)
  })

  it('托管实例的 AI 调用走 /v1/ai/*，记在这个组织的钱包上（块 = ai）', async () => {
    cloud.wallet(owner.org).wallet.topup({ org_id: owner.org, credits: 100, kind: 'purchased' })
    const res = await call(cloud, '/v1/ai/chat/completions', {
      method: 'POST',
      token: hostedToken,
      body: { model: 'deepseek-chat', messages: [{ role: 'user', content: '有 M 码吗' }] },
    })
    expect(res.status).toBe(200)
    await cloud.settle()
    const events = cloud.wallet(owner.org).store.events({ org_id: owner.org })
    expect(events).toHaveLength(1)
    expect(events[0]?.capability).toBe('ai.chat')
    expect(events[0]?.workspace_id).toBe(WS)
    const wallet = await call(cloud, '/v1/wallet', { token: hostedToken })
    expect(wallet.status).toBe(200)
    expect(
      ((await wallet.res.json()) as { data: { available: number } }).data.available,
    ).toBeLessThan(100 + SIGNUP_BONUS)
  })

  it('托管令牌开不了订阅、看不了商家的托管页、拉不走留言；商家令牌推不了容器那条快照', async () => {
    expect(
      (await call(cloud, '/v1/support/subscription', { method: 'DELETE', token: hostedToken }))
        .status,
    ).toBe(401)
    expect((await call(cloud, '/v1/support/hosted', { token: hostedToken })).status).toBe(401)
    expect(
      (await call(cloud, '/v1/chat/relay/offline-messages', { method: 'POST', token: hostedToken }))
        .status,
    ).toBe(401)
    expect(
      (
        await call(cloud, '/v1/hosted/snapshot', {
          method: 'PUT',
          token: owner.token,
          raw: new Uint8Array([1]),
        })
      ).status,
    ).toBe(401)
    // 拼一把别的工作区前缀的假令牌：对象不认
    const verify = hostedTokenVerifier(cloud.env)
    expect(await verify(hostedToken.replace(/\.[^.]+$/, '.forged'))).toBeUndefined()
    expect((await verify(hostedToken))?.scopes).toEqual(['ai', 'wallet:read'])
  })

  it('本机上线对齐：容器推上来的快照，商家本机拉得回；本机推一份覆盖，容器下次起来拉到的是本机那份', async () => {
    const pushed = await call(cloud, '/v1/hosted/snapshot', {
      method: 'PUT',
      token: hostedToken,
      raw: new Uint8Array([7, 7, 7]),
    })
    expect(pushed.status).toBe(200)
    const pulled = await call(cloud, '/v1/support/hosted/snapshot', { token: owner.token })
    expect(pulled.status).toBe(200)
    expect(pulled.res.headers.get('x-agentsws-snapshot-source')).toBe('hosted')
    expect([...new Uint8Array(await pulled.res.arrayBuffer())]).toEqual([7, 7, 7])

    const seeded = await call(cloud, '/v1/support/hosted/snapshot', {
      method: 'PUT',
      token: owner.token,
      raw: new Uint8Array([1, 2]),
    })
    expect(seeded.status).toBe(200)
    const restore = await call(cloud, '/v1/hosted/snapshot', { token: hostedToken })
    expect(restore.res.headers.get('x-agentsws-snapshot-source')).toBe('local')
    expect([...new Uint8Array(await restore.res.arrayBuffer())]).toEqual([1, 2])

    const status = await call(cloud, '/v1/support/hosted', { token: owner.token })
    const data = ((await status.res.json()) as { data: HostedInstanceStatus }).data
    expect(data.snapshot?.source).toBe('local')
    expect(data.desired).toBe('run')
  })

  it('没有快照时容器拉到 204（从空库起）', async () => {
    const empty = await call(cloud, '/v1/hosted/snapshot', { token: hostedToken })
    expect(empty.status).toBe(204)
  })
})
