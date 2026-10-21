/**
 * WP427：「团队门」与云通道客户端的单元钉子（不起服务进程、不联网）。
 *
 * 门：没登录只能走那几条；本机档「按邮箱直接给 token」的公开路由带着会话也进不去；只认会话那一种 token；
 * 外面带进来的转发头抹掉、带上门的记号；bootstrap 由门自己回（不给主人邮箱）。
 * 通道：握手 → 在线；请求按块流回；同事那边断开就掐掉；密钥对不上就清掉、重新申请。
 */
import type { TeamTunnelClientFrame, TeamTunnelServerFrame } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  bearerFromSubprotocol,
  classifyDoorRequest,
  createDoorHandler,
  DOOR_HEADER,
} from '../src/team-door.js'
import { lanAddress } from '../src/team-link.js'
import { createTeamTunnel, type TunnelSocket, tunnelConnectUrl } from '../src/team-tunnel.js'

describe('WP427 团队门：哪条能走', () => {
  it('没登录能走的只有申请 / 问批了没有 / 换会话 / 工坊账号进门 / 健康检查 / 页面', () => {
    const pub = (m: string, p: string) => classifyDoorRequest(m, p).kind
    expect(pub('GET', '/v1/health')).toBe('public')
    expect(pub('GET', '/v1/discovery/hello')).toBe('public')
    expect(pub('POST', '/v1/memberships/requests')).toBe('public')
    expect(pub('POST', '/v1/memberships/requests/mrq_1/claim')).toBe('public')
    expect(pub('POST', '/v1/discovery/superseded')).toBe('public')
    expect(pub('POST', '/v1/auth/verify')).toBe('public')
    expect(pub('POST', '/v1/auth/account/code')).toBe('public')
    expect(pub('POST', '/v1/auth/account/verify')).toBe('public')
    expect(pub('GET', '/')).toBe('public')
    expect(pub('GET', '/assets/index-abc.js')).toBe('public')
    expect(pub('GET', '/positions/asg_1/duties/kol.youtube')).toBe('public')
    expect(pub('HEAD', '/')).toBe('public')
    expect(pub('GET', '/app/bootstrap.json')).toBe('bootstrap')
  })

  it('本机档那几条「公开」路由、非页面的东西：一律挡（带不带会话都一样）', () => {
    const kind = (m: string, p: string) => classifyDoorRequest(m, p).kind
    expect(kind('POST', '/v1/auth/magic-link')).toBe('blocked')
    expect(kind('POST', '/v1/auth/browser-link')).toBe('blocked')
    expect(kind('POST', '/v1/auth/session')).toBe('blocked')
    expect(kind('POST', '/v1/auth/setup-code')).toBe('blocked')
    expect(kind('GET', '/v1/cloud/account/callback')).toBe('blocked')
    expect(kind('GET', '/oauth/callback')).toBe('blocked')
    expect(kind('GET', '/widget.js')).toBe('blocked')
    expect(kind('GET', '/openapi.json')).toBe('blocked')
    expect(kind('POST', '/')).toBe('blocked')
    expect(kind('GET', '/assets/../secrets.sqlite')).toBe('blocked')
    expect(kind('GET', '/v1/..%2fx')).toBe('blocked')
    // 其余 /v1 要会话
    expect(kind('GET', '/v1/me')).toBe('member')
    expect(kind('POST', '/v1/approvals/x/decide')).toBe('member')
    expect(kind('GET', '/v1/auth/session')).toBe('member')
  })

  it('WebSocket 子协议里那把 bearer', () => {
    expect(bearerFromSubprotocol('agentsws.v1, agentsws.bearer.sess_abc')).toBe('sess_abc')
    expect(bearerFromSubprotocol('agentsws.v1')).toBeUndefined()
    expect(bearerFromSubprotocol(undefined)).toBeUndefined()
  })

  it('局域网地址只挑私有 IPv4', () => {
    expect(
      lanAddress({
        lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true } as never],
        en0: [
          { address: 'fe80::1', family: 'IPv6', internal: false } as never,
          { address: '192.168.1.23', family: 'IPv4', internal: false } as never,
        ],
      }),
    ).toBe('192.168.1.23')
    expect(
      lanAddress({ en0: [{ address: '8.8.8.8', family: 'IPv4', internal: false } as never] }),
    ).toBeUndefined()
  })
})

describe('WP427 团队门：转进去', () => {
  const tokens: Record<string, string> = {
    sess_ok: 'session',
    key_plugin: 'api_key',
    int_x: 'internal',
  }
  const seen: { url: string; headers: Headers; method: string }[] = []
  const handler = createDoorHandler({
    upstream: () => 'http://127.0.0.1:4317',
    authenticate: async (t) => (tokens[t] === undefined ? undefined : { kind: tokens[t] }),
    cookieName: 'agentsws_session',
    via: 'cloud',
    fetch: (async (url: string, init: RequestInit) => {
      seen.push({ url, headers: new Headers(init.headers), method: String(init.method) })
      return new Response('{"data":{"ok":true}}', {
        status: 200,
        headers: { 'content-type': 'application/json', 'content-length': '20', connection: 'x' },
      })
    }) as never,
  })
  const req = (method: string, path: string, headers: Record<string, string> = {}) =>
    handler(new Request(`http://door${path}`, { method, headers }))

  it('要会话的：没带 / 带插件钥匙 / 带内部令牌都 401；带会话（bearer 或 cookie）才转', async () => {
    expect((await req('GET', '/v1/me')).status).toBe(401)
    expect((await req('GET', '/v1/me', { authorization: 'Bearer key_plugin' })).status).toBe(401)
    expect((await req('GET', '/v1/me', { authorization: 'Bearer int_x' })).status).toBe(401)
    expect((await req('GET', '/v1/me', { authorization: 'Bearer nope' })).status).toBe(401)
    expect(seen).toHaveLength(0)
    expect((await req('GET', '/v1/me?x=1', { authorization: 'Bearer sess_ok' })).status).toBe(200)
    expect((await req('GET', '/v1/me', { cookie: 'a=b; agentsws_session=sess_ok' })).status).toBe(
      200,
    )
    expect(seen.map((s) => s.url)).toEqual([
      'http://127.0.0.1:4317/v1/me?x=1',
      'http://127.0.0.1:4317/v1/me',
    ])
  })

  it('挡掉的带着会话也 403、不转；转发头抹掉、带门的记号', async () => {
    seen.length = 0
    const blocked = await req('POST', '/v1/auth/magic-link', { authorization: 'Bearer sess_ok' })
    expect(blocked.status).toBe(403)
    expect(seen).toHaveLength(0)
    const res = await req('GET', '/v1/health', {
      'x-forwarded-for': '6.6.6.6',
      [DOOR_HEADER]: 'lan',
      forwarded: 'for=6.6.6.6',
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('connection')).toBeNull()
    const h = seen[0]?.headers
    expect(h?.get('x-forwarded-for')).toBeNull()
    expect(h?.get('forwarded')).toBeNull()
    expect(h?.get(DOOR_HEADER)).toBe('cloud')
  })

  it('bootstrap 门自己回：不给主人邮箱', async () => {
    const res = await req('GET', '/app/bootstrap.json')
    expect(await res.json()).toEqual({ login: 'shared', team: true })
  })
})

/** 通道替身 socket：记下发出去的帧，测试手动喂进来的帧。 */
function fakeSocket(): {
  socket: TunnelSocket
  sent: TeamTunnelClientFrame[]
  feed(frame: TeamTunnelServerFrame): void
  open(): void
  close(): void
} {
  const handlers: Record<string, ((e?: { data: unknown }) => void)[]> = {}
  const sent: TeamTunnelClientFrame[] = []
  const fire = (type: string, e?: { data: unknown }): void => {
    for (const h of handlers[type] ?? []) h(e)
  }
  return {
    socket: {
      send: (text) => {
        sent.push(JSON.parse(text) as TeamTunnelClientFrame)
      },
      close: () => fire('close'),
      addEventListener: ((type: string, h: (e?: { data: unknown }) => void) => {
        if (handlers[type] === undefined) handlers[type] = []
        handlers[type]?.push(h)
      }) as TunnelSocket['addEventListener'],
    },
    sent,
    feed: (frame) => fire('message', { data: JSON.stringify(frame) }),
    open: () => fire('open'),
    close: () => fire('close'),
  }
}

const tick = () => new Promise((r) => setTimeout(r, 5))

describe('WP427 云通道客户端', () => {
  it('地址：https → wss', () => {
    expect(tunnelConnectUrl('https://cloud.agentsws.com/')).toBe(
      'wss://cloud.agentsws.com/v1/team/tunnel/connect',
    )
    expect(tunnelConnectUrl('http://127.0.0.1:4593')).toBe(
      'ws://127.0.0.1:4593/v1/team/tunnel/connect',
    )
    // WP435：带上通道号，云直接接到那条通道上；形状不对的不带
    expect(tunnelConnectUrl('https://cloud.agentsws.com', 'k3f9x2ab01cd')).toBe(
      'wss://cloud.agentsws.com/v1/team/tunnel/connect?tunnel_id=k3f9x2ab01cd',
    )
    expect(tunnelConnectUrl('https://cloud.agentsws.com', 'a b&c')).toBe(
      'wss://cloud.agentsws.com/v1/team/tunnel/connect',
    )
  })

  it('没令牌停在 needs_account、不连；有了令牌申请 → 握手 → 在线；请求按块流回；断开就掐掉', async () => {
    let token: string | undefined
    let vault: { tunnel_id: string; url: string; secret: string } | undefined
    const registered: string[] = []
    const sockets: ReturnType<typeof fakeSocket>[] = []
    let aborted = 0
    const big = 'x'.repeat(150 * 1024)
    const tunnel = createTeamTunnel({
      cloudBase: () => 'https://cloud.test',
      token: () => token,
      vault: { get: () => vault, set: (v) => (vault = v) },
      fetch: async (url, init) => {
        registered.push(`${init?.method} ${url}`)
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              data: {
                tunnel_id: 'tabc',
                url: 'https://tabc.team.test',
                secret: `tts_${registered.length}`,
              },
            }),
        }
      },
      socketFactory: () => {
        const s = fakeSocket()
        sockets.push(s)
        return s.socket
      },
      handler: async (req) => {
        const path = new URL(req.url).pathname
        if (path === '/slow')
          return await new Promise<Response>((resolve) => {
            req.signal.addEventListener('abort', () => {
              aborted += 1
              resolve(new Response('late'))
            })
          })
        return new Response(path === '/big' ? big : `hi ${req.method} ${await req.text()}`, {
          status: 201,
          headers: { 'x-a': '1' },
        })
      },
      heartbeatMs: 60_000,
    })
    tunnel.start()
    expect(tunnel.state()).toBe('needs_account')
    expect(sockets).toHaveLength(0)

    token = 'wst_1'
    tunnel.start()
    await tick()
    expect(registered).toEqual(['POST https://cloud.test/v1/team/tunnel'])
    const s = sockets[0]
    if (s === undefined) throw new Error('没连')
    s.open()
    expect(s.sent[0]).toMatchObject({ type: 'hello', tunnel_id: 'tabc', secret: 'tts_1' })
    s.feed({ type: 'welcome', protocol_version: 1, url: 'https://tabc.team.test' })
    expect(tunnel.state()).toBe('online')
    expect(tunnel.url()).toBe('https://tabc.team.test')

    s.feed({
      type: 'request',
      id: 'r1',
      method: 'POST',
      path: '/v1/x',
      headers: [['content-type', 'text/plain']],
      body: Buffer.from('yo').toString('base64'),
    })
    await tick()
    const r1 = s.sent.filter((f) => 'id' in f && f.id === 'r1')
    expect(r1[0]).toMatchObject({ type: 'response_head', status: 201 })
    const body = r1
      .filter((f) => f.type === 'response_chunk')
      .map((f) => Buffer.from((f as { data: string }).data, 'base64').toString())
      .join('')
    expect(body).toBe('hi POST yo')
    expect(r1.at(-1)).toMatchObject({ type: 'response_end' })

    s.feed({ type: 'request', id: 'r2', method: 'GET', path: '/big', headers: [] })
    await tick()
    const chunks = s.sent.filter((f) => f.type === 'response_chunk' && f.id === 'r2')
    expect(chunks.length).toBeGreaterThanOrEqual(3)

    s.feed({ type: 'request', id: 'r3', method: 'GET', path: '/slow', headers: [] })
    await tick()
    s.feed({ type: 'cancel', id: 'r3' })
    await tick()
    expect(aborted).toBe(1)
    expect(s.sent.some((f) => 'id' in f && f.id === 'r3')).toBe(false)

    s.feed({ type: 'ping' })
    expect(s.sent.at(-1)).toEqual({ type: 'pong' })
    tunnel.stop()
    expect(tunnel.state()).toBe('stopped')
  })

  it('密钥对不上：清掉，下一次重新申请一把新的', async () => {
    let vault: { tunnel_id: string; url: string; secret: string } | undefined = {
      tunnel_id: 'told',
      url: 'https://told.team.test',
      secret: 'tts_stale',
    }
    let registers = 0
    const sockets: ReturnType<typeof fakeSocket>[] = []
    const tunnel = createTeamTunnel({
      cloudBase: () => 'https://cloud.test',
      token: () => 'wst_1',
      vault: { get: () => vault, set: (v) => (vault = v) },
      fetch: async () => {
        registers += 1
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              data: { tunnel_id: 'told', url: 'https://told.team.test', secret: 'tts_fresh' },
            }),
        }
      },
      socketFactory: () => {
        const s = fakeSocket()
        sockets.push(s)
        return s.socket
      },
      handler: async () => new Response('x'),
      maxBackoffMs: 1,
    })
    tunnel.start()
    await tick()
    expect(registers).toBe(0)
    sockets[0]?.open()
    sockets[0]?.feed({ type: 'rejected', reason: 'bad_secret' })
    expect(vault).toBeUndefined()
    await new Promise((r) => setTimeout(r, 30))
    expect(registers).toBe(1)
    sockets[1]?.open()
    expect(sockets[1]?.sent[0]).toMatchObject({ type: 'hello', secret: 'tts_fresh' })
    tunnel.stop()
  })
})
