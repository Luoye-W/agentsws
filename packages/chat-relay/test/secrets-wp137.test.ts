/**
 * WP137（P0 安全）：聊天转发三种形态「没有真密钥就拒绝」。
 *
 * 访客令牌 = HMAC(访客密钥, 工作区:会话)。访客密钥只要能被外人推出来，
 * 就能伪造任意访客令牌、读别人的聊天。这里钉住：
 * - 守卫：源码里不许再出现可推算的兜底字符串；
 * - 自建 Cloudflare 模板：没配 `VISITOR_SECRET`（或太短）→ 整台 503；从工作区号推出的旧令牌不认；
 * - 自建 Node：服务端秘密首启随机生成、存卷、不打印；从工作区号推出的旧令牌不认；
 *   老卷没有留言密钥 → 不收留言；
 * - 访客面：留言密钥没签发 → 不收留言（回人话），不拿常量封箱。
 */
import { createHash, createHmac } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RelayCore } from '../src/core.js'
import { createRelayHttp } from '../src/http.js'
import { SERVER_SECRET_KEY, startNodeRelayHost } from '../src/node-host.js'
import { parseClientFrame } from '../src/protocol.js'
import { sealedKeyOf, sealWithKey } from '../src/sealed.js'
import { OFFLINE_UNAVAILABLE, RELAY_UNAVAILABLE, relaySecretReady } from '../src/secrets.js'
import { createStandaloneWorker } from '../src/standalone-worker.js'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../..')
const ORIGIN = 'https://shop.example.com'
const GOOD_SECRET = 'wp137-standalone-visitor-secret-0123456789'

const hmac = (key: Uint8Array | string, text: string): string =>
  createHmac('sha256', key).update(text).digest('base64url')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (/\.(ts|js|mjs)$/.test(name)) out.push(full)
  }
  return out
}

describe('WP137 守卫：源码里没有可推算的密钥兜底', () => {
  it('packages/chat-relay/src 与 apps/cloud-worker/src 不出现兜底前缀与常量留言密钥', () => {
    // 拼出来而不是直写：这条守卫自己不该被自己扫到（它在 test/ 里，本来也不在扫描范围）
    const banned = [`${'derived'}:`, `${'no-message'}-key`]
    const files = [
      ...sourceFiles(join(repo, 'packages/chat-relay/src')),
      ...sourceFiles(join(repo, 'apps/cloud-worker/src')),
    ]
    expect(files.length).toBeGreaterThan(10)
    const hits: string[] = []
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      for (const word of banned) if (text.includes(word)) hits.push(`${file}: ${word}`)
    }
    expect(hits).toEqual([])
  })

  it('密钥长度门槛：没配 / 空白 / 短于 32 字节都不算', () => {
    expect(relaySecretReady(undefined)).toBe(false)
    expect(relaySecretReady('')).toBe(false)
    expect(relaySecretReady('   ')).toBe(false)
    expect(relaySecretReady('short-secret')).toBe(false)
    expect(relaySecretReady(`${'x'.repeat(31)}  `)).toBe(false)
    expect(relaySecretReady('x'.repeat(32))).toBe(true)
  })
})

describe('WP137 · 自建 Cloudflare 模板（standalone-worker）', () => {
  const WS = 'ws_standalone'
  const base = `https://relay.example.test/relay/${WS}`

  it('没配 VISITOR_SECRET：访客面与本机连接一律 503，日志说清楚怎么补', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const worker = createStandaloneWorker()
    const env = { WORKSPACE: WS, PAIRING_TOKEN: 'prk_x' }
    for (const [path, init] of [
      ['/widget.js', {}],
      ['/v1/chat/widget-config', { headers: { origin: ORIGIN } }],
      ['/v1/chat/public/sessions', { method: 'POST', headers: { origin: ORIGIN } }],
      ['/connect', { headers: { upgrade: 'websocket' } }],
    ] as const) {
      const res = await worker.fetch(new Request(`${base}${path}`, init as RequestInit), env)
      expect(res.status).toBe(503)
      expect(((await res.json()) as { error: unknown }).error).toEqual(RELAY_UNAVAILABLE)
    }
    // 日志只打一次，写明是哪把 secret、怎么补
    expect(error).toHaveBeenCalledTimes(1)
    expect(String(error.mock.calls[0]?.[0])).toContain('wrangler secret put VISITOR_SECRET')
    error.mockRestore()
  })

  it('VISITOR_SECRET 短于 32 字节同样拒绝', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const worker = createStandaloneWorker()
    const res = await worker.fetch(new Request(`${base}/widget.js`), {
      WORKSPACE: WS,
      VISITOR_SECRET: 'too-short',
    })
    expect(res.status).toBe(503)
    error.mockRestore()
  })

  it('配了真密钥照常服务；用工作区号推出来的旧令牌不被接受', async () => {
    const worker = createStandaloneWorker()
    const env = { WORKSPACE: WS, VISITOR_SECRET: GOOD_SECRET }
    expect((await worker.fetch(new Request(`${base}/widget.js`), env)).status).toBe(200)

    const session = 's_victim'
    const typing = (token: string): Promise<Response> =>
      worker.fetch(
        new Request(`${base}/v1/chat/public/sessions/${session}/typing`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ active: true }),
        }),
        env,
      )
    // 真密钥签的令牌：过
    expect((await typing(hmac(GOOD_SECRET, `${WS}:${session}`))).status).toBe(200)
    // WP124 那把「没配就从工作区号推」的密钥签的令牌：不认
    const legacySeed = `${'derived'}:${createHash('sha256').update(WS).digest('hex').slice(0, 16)}:visitor`
    expect((await typing(hmac(legacySeed, `${WS}:${session}`))).status).toBe(401)
  })
})

describe('WP137 · 自建 Node / Docker（node-host）', () => {
  const handles: { close(): Promise<void> }[] = []
  afterEach(async () => {
    for (const h of handles) await h.close()
    handles.length = 0
    vi.restoreAllMocks()
  })

  it('服务端秘密首启随机生成、存卷、不打印；同卷重启沿用', async () => {
    const printed: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      printed.push(String(chunk))
      return true
    })
    const dataDir = mkdtempSync(join(tmpdir(), 'relay-wp137-'))
    const host = startNodeRelayHost({ port: 0, workspace: 'ws_n', dataDir })
    handles.push(host)
    const kvFile = join(dataDir, 'relay-kv.json')
    const stored = (JSON.parse(readFileSync(kvFile, 'utf8')) as Record<string, string>)[
      SERVER_SECRET_KEY
    ] as string
    expect(Buffer.from(stored, 'base64url').length).toBe(32)
    // 不进日志（配对密钥 / 留言密钥照旧只打印一次，服务端秘密一次都不打）
    expect(printed.join('')).not.toContain(stored)
    // 卷文件只给自己读
    expect(statSync(kvFile).mode & 0o077).toBe(0)

    const again = startNodeRelayHost({ port: 0, workspace: 'ws_n', dataDir })
    handles.push(again)
    const after = (JSON.parse(readFileSync(kvFile, 'utf8')) as Record<string, string>)[
      SERVER_SECRET_KEY
    ]
    expect(after).toBe(stored)
  })

  it('老部署升级：卷里只有配对哈希 → 自动补服务端秘密；旧令牌失效；没留言密钥就不收留言', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const dataDir = mkdtempSync(join(tmpdir(), 'relay-wp137-old-'))
    const pairing = 'prk_old_deployment_token'
    // WP124 早期的卷：配对哈希有，留言密钥与服务端秘密都没有
    writeFileSync(
      join(dataDir, 'relay-kv.json'),
      JSON.stringify({
        'pairing:ws_old': createHash('sha256').update(pairing).digest('hex'),
      }),
    )
    const host = startNodeRelayHost({ port: 0, workspace: 'ws_old', dataDir })
    handles.push(host)
    expect(host.pairingToken).toBeUndefined()
    expect(host.messageKey).toBeUndefined()
    const kv = JSON.parse(readFileSync(join(dataDir, 'relay-kv.json'), 'utf8')) as Record<
      string,
      string
    >
    expect(kv[SERVER_SECRET_KEY]).toBeDefined()
    // 老卷的文件权限也收紧
    expect(statSync(join(dataDir, 'relay-kv.json')).mode & 0o077).toBe(0)

    const base = `http://localhost:${host.port() as number}/relay/ws_old`
    // 本机连上来，给出白名单
    const socket = new WebSocket(`ws://localhost:${host.port() as number}/relay/ws_old/connect`)
    const frames: string[] = []
    socket.addEventListener('message', (e) => frames.push(String(e.data)))
    await new Promise<void>((ok, bad) => {
      socket.addEventListener('open', () => ok())
      socket.addEventListener('error', () => bad(new Error('connect failed')))
    })
    socket.send(
      JSON.stringify({
        type: 'hello',
        protocol_version: 1,
        workspace: 'ws_old',
        pairing,
        peer: 'server',
        config: { enabled: true, accent: '#2563eb', greeting: '你好', allowed_origins: [ORIGIN] },
      }),
    )
    await vi.waitFor(() => expect(frames.some((f) => f.includes('hello_ok'))).toBe(true))

    // 真令牌：从会话接口领的那一把能用
    const open = await fetch(`${base}/v1/chat/public/sessions`, {
      method: 'POST',
      headers: { origin: ORIGIN },
    })
    expect(open.status).toBe(200)
    const { data } = (await open.json()) as { data: { session_id: string; visitor_token: string } }
    const typing = (token: string): Promise<Response> =>
      fetch(`${base}/v1/chat/public/sessions/${data.session_id}/typing`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ active: true }),
      })
    expect((await typing(data.visitor_token)).status).toBe(200)

    // WP124 的 Node 访客密钥：只由工作区号推出（从来没用过秘密）——签出来的令牌不认
    const legacyKey = new TextEncoder().encode(
      createHash('sha256').update('chat-relay:ws_old:visitor').digest().toString('hex'),
    )
    expect((await typing(hmac(legacyKey, `ws_old:${data.session_id}`))).status).toBe(401)

    // 没签发留言密钥：不收留言，回人话
    const leave = await fetch(`${base}/v1/chat/public/offline-messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ email: 'v@example.com', text: '订单没到' }),
    })
    expect(leave.status).toBe(503)
    expect(((await leave.json()) as { error: unknown }).error).toEqual(OFFLINE_UNAVAILABLE)
    socket.close()
  })
})

describe('WP137 · 访客面：留言密钥没签发就不收留言', () => {
  function harness(opts: { seal: boolean; ready: boolean }): {
    app: ReturnType<typeof createRelayHttp>
    stored: () => number
  } {
    let stored = 0
    const core = new RelayCore({
      clock: () => '2026-09-24T10:00:00.000Z',
      verifyPairing: () => true,
      ...(opts.seal
        ? { seal: (_ws: string, text: string) => sealWithKey(sealedKeyOf('mkk_test'), text) }
        : {}),
      sealReady: () => opts.ready,
      offline: {
        put: () => {
          stored += 1
        },
        take: () => [],
        count: () => stored,
      },
      newId: () => 'id',
    })
    core.handshake(
      { send: () => {} },
      parseClientFrame(
        JSON.stringify({
          type: 'hello',
          protocol_version: 1,
          workspace: 'ws_h',
          pairing: 'x',
          peer: 'server',
          config: { enabled: true, accent: '#000', greeting: '', allowed_origins: [ORIGIN] },
        }),
      ) as never,
    )
    const app = createRelayHttp({
      core,
      workspace: 'ws_h',
      visitorSecret: () => new TextEncoder().encode(GOOD_SECRET),
    })
    return { app, stored: () => stored }
  }

  const leave = (app: ReturnType<typeof createRelayHttp>): Promise<Response> =>
    app.fetch(
      new Request('https://relay.test/v1/chat/public/offline-messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ email: 'v@example.com', text: '在吗' }),
      }),
    )

  it('没签发 → 503 人话，一个字节都不入箱', async () => {
    const h = harness({ seal: true, ready: false })
    const res = await leave(h.app)
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe(
      '商家还没完成配对，暂时不能留言。',
    )
    expect(h.stored()).toBe(0)
  })

  it('宿主根本没给封箱 → 同样不收（不再原样存明文）', async () => {
    const h = harness({ seal: false, ready: true })
    expect((await leave(h.app)).status).toBe(503)
    expect(h.stored()).toBe(0)
  })

  it('签发了 → 照收（密文入箱）', async () => {
    const h = harness({ seal: true, ready: true })
    expect((await leave(h.app)).status).toBe(200)
    expect(h.stored()).toBe(1)
  })
})
