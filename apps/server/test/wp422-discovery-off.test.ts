/**
 * WP422：「让同事在局域网里找到我」关着时，一下网络都不碰。
 *
 * 造 mDNS 会在所有网卡上绑 UDP 5353，Windows 防火墙一见对外绑口就弹「Node 要联网」。
 * 以前首次设置 / 公司页一打开就会去造（`status()` / `peers()` 不看开关先 `ensure()`），
 * 开关关着的人也被弹。这里钉住：开关关着 → 工厂一次都不调；开着 → 照旧。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createDiscovery, type Mdns, type MdnsFactory } from '../src/discovery.js'
import { createServer, type Server } from '../src/index.js'

const clock = { now: () => '2026-10-19T09:00:00.000Z' }

function counting(make: () => ReturnType<MdnsFactory>) {
  const counter = { calls: 0, stops: 0 }
  const factory: MdnsFactory = () => {
    counter.calls += 1
    return make()
  }
  return { counter, factory }
}

function fakeMdns(counter: { stops: number }): Mdns {
  return {
    publish() {},
    browse() {},
    stop() {
      counter.stops += 1
    },
  }
}

function discovery(input: {
  factory: MdnsFactory
  enabled: () => boolean
  key?: () => string | undefined
}) {
  return createDiscovery({
    clock,
    workspace_id: 'ws_test' as never,
    appendEvent: () => {},
    companyKey: input.key ?? (() => 'k1'),
    enabled: input.enabled,
    port: () => 4317,
    mdns: input.factory,
  })
}

describe('WP422 开关关着不造 mDNS', () => {
  it('关着：status / peers / peerIds / close 都不调工厂；available 回 true、没有原因', async () => {
    const { counter, factory } = counting(() => ({ reason: '不该被调到' }))
    const d = discovery({ factory, enabled: () => false })
    expect(d.status()).toEqual({ available: true })
    const view = await d.peers()
    expect(view).toEqual({ available: true, enabled: false, peers: [] })
    expect(d.peerIds()).toEqual([])
    d.close()
    expect(counter.calls).toBe(0)
  })

  it('开着：peers 造一次 mDNS、照常广播；再问不重造', async () => {
    const box = { calls: 0, stops: 0 }
    const { counter, factory } = counting(() => ({ mdns: fakeMdns(box) }))
    const d = discovery({ factory, enabled: () => true })
    const view = await d.peers()
    expect(view.available).toBe(true)
    expect(view.enabled).toBe(true)
    await d.peers()
    expect(d.status()).toEqual({ available: true })
    expect(counter.calls).toBe(1)
  })

  it('开着但起不来：照旧报「用不了」和原因；关掉之后原因还在、也不再去试', async () => {
    let on = true
    const { counter, factory } = counting(() => ({ reason: '这台机器没有可用网卡' }))
    const d = discovery({ factory, enabled: () => on })
    expect(await d.peers()).toMatchObject({ available: false, reason: '这台机器没有可用网卡' })
    on = false
    expect(await d.peers()).toMatchObject({
      available: false,
      enabled: false,
      reason: '这台机器没有可用网卡',
    })
    expect(d.status()).toEqual({ available: false, reason: '这台机器没有可用网卡' })
    expect(counter.calls).toBe(1)
  })

  it('打开又关上：造出来的 mDNS 拆掉；关着时再问不重造', async () => {
    let on = true
    const box = { calls: 0, stops: 0 }
    const { counter, factory } = counting(() => ({ mdns: fakeMdns(box) }))
    const d = discovery({ factory, enabled: () => on })
    await d.peers()
    on = false
    d.disable('per_owner' as never)
    expect(box.stops).toBe(1)
    await d.peers()
    d.status()
    expect(counter.calls).toBe(1)
  })

  it('开着但还没公司名：造了没广播；关开关时也一样拆掉（不留着占 5353）', async () => {
    let on = true
    const box = { calls: 0, stops: 0 }
    const { factory } = counting(() => ({ mdns: fakeMdns(box) }))
    const d = discovery({ factory, enabled: () => on, key: () => undefined })
    await d.peers()
    on = false
    d.disable('per_owner' as never)
    expect(box.stops).toBe(1)
  })
})

/* ── 真装配线：首次设置 / 同事列表打开时，开关关着就不碰网络 ───────────────── */

const servers: Server[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
})

describe('WP422 真装配线', () => {
  it('新装（个人模式、开关默认关）：读首次设置与同事列表都不造 mDNS；打开开关才造', async () => {
    const box = { calls: 0, stops: 0 }
    const { counter, factory } = counting(() => ({ mdns: fakeMdns(box) }))
    let t = Date.parse('2026-10-19T09:00:00.000Z')
    const server = await createServer({
      clock: {
        now: () => {
          t += 1
          return new Date(t).toISOString()
        },
      },
      quiet: true,
      startRun: false,
      tokenRefreshIntervalMs: 0,
      mdns: factory,
    })
    servers.push(server)
    const call = (method: string, path: string, body?: unknown) =>
      server.gateway.fetch(
        new Request(`http://127.0.0.1${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${server.bootstrap.internalToken}`,
            'X-Assignment': server.bootstrap.ownerAssignment.id,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      )

    const state = (await (await call('GET', '/v1/onboarding/state')).json()) as {
      data: { discovery: { available: boolean; enabled: boolean } }
    }
    expect(state.data.discovery).toEqual({ available: true, enabled: false })
    const peers = (await (await call('GET', '/v1/discovery/peers')).json()) as {
      data: { available: boolean; enabled: boolean }
    }
    expect(peers.data).toMatchObject({ available: true, enabled: false })
    // 存公司档案但不开开关：照样不碰
    await call('PUT', '/v1/workspace/profile', { legal_name: '诺伏特', discoverable: false })
    await call('GET', '/v1/onboarding/state')
    await call('GET', '/v1/discovery/peers')
    expect(counter.calls).toBe(0)

    // 用户打开「让同事在局域网里找到我」→ 这时才去绑
    await call('PUT', '/v1/workspace/profile', { legal_name: '诺伏特', discoverable: true })
    await call('GET', '/v1/discovery/peers')
    expect(counter.calls).toBe(1)
  })
})
