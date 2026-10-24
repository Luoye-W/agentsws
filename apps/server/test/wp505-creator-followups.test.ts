/**
 * WP505：WP502 跟进（服务端那几件）。全是本地假东西——假代理、假图片站（本机自签证书）、假的系统代理读取，
 * 一个字节都不出网，也不读这台电脑真的代理设置。端口只用 5050–5053。
 *
 * - **1770 B**：下载红人图片认系统代理（环境变量 + 操作系统设置），连不上换下一个，最后直连；
 *   域名白名单 / 类型 / 大小 / 超时照旧；跳转每一跳先核域名。
 * - **1771 B**：缓存清理——没人再引用的删掉、所有品牌合计的总量上限按最久没用的先删；红人数据不动。
 * - **1772 B**：`tag_creators` 只动标签；审核决定 AI 改不了。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync } from 'node:fs'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import {
  createServer as createNetServer,
  type Server as NetServer,
  connect as netConnect,
  type Socket,
} from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Assignment, WorkspaceId } from '@agentsws/contracts'
import { KOL_TOOL_SPECS } from '@agentsws/kol-core'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import { createKolMediaCache, kolMediaIdOf } from '../src/kol-media.js'
import { createKolMediaFetch } from '../src/kol-media-fetch.js'
import { createKolMediaJanitor } from '../src/kol-media-janitor.js'
import { createKolToolExecutor } from '../src/kol-tools.js'
import {
  bypassed,
  createSystemProxyReader,
  normalizeProxyUrl,
  parseScutilProxy,
  parseWindowsProxy,
  proxyCandidates,
  proxyFromEnv,
} from '../src/net-proxy.js'

const PROXY_PORT = 5050
const IMAGE_PORT = 5051
const DENY_PROXY_PORT = 5052
const SERVER_PORT = 5053
/** 没人在听的端口（拒绝连接）：不占用任何端口。 */
const DEAD_PROXY = 'http://127.0.0.1:1'

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
])

// ── 1770 B：解析（纯函数） ──

describe('1770 B：认得出代理设置', () => {
  it('macOS scutil --proxy：先 HTTPS 再 HTTP；只开 SOCKS / PAC 的不认；例外名单', () => {
    const both = `<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
  }
  ExcludeSimpleHostnames : 1
  HTTPEnable : 1
  HTTPPort : 7891
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7890
  HTTPSProxy : 127.0.0.1
  SOCKSEnable : 1
  SOCKSPort : 7892
  SOCKSProxy : 127.0.0.1
}`
    expect(parseScutilProxy(both)).toEqual({
      url: 'http://127.0.0.1:7890',
      bypass: ['*.local', '169.254/16', '<local>'],
    })
    expect(
      parseScutilProxy(
        '<dictionary> {\n  HTTPEnable : 1\n  HTTPPort : 8080\n  HTTPProxy : proxy.lan\n}',
      )?.url,
    ).toBe('http://proxy.lan:8080')
    expect(
      parseScutilProxy(
        '<dictionary> {\n  SOCKSEnable : 1\n  SOCKSPort : 7892\n  SOCKSProxy : 127.0.0.1\n  ProxyAutoConfigEnable : 1\n}',
      ),
    ).toBeUndefined()
    expect(
      parseScutilProxy(
        '<dictionary> {\n  HTTPSEnable : 0\n  HTTPSPort : 7890\n  HTTPSProxy : 127.0.0.1\n}',
      ),
    ).toBeUndefined()
  })

  it('Windows reg query：ProxyEnable=1 才认；h:p 与 http=…;https=… 两种写法；只有 socks= 的不认', () => {
    const plain = `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    127.0.0.1:7890
    ProxyOverride    REG_SZ    localhost;127.*;<local>
`
    expect(parseWindowsProxy(plain)).toEqual({
      url: 'http://127.0.0.1:7890',
      bypass: ['localhost', '127.*', '<local>'],
    })
    expect(
      parseWindowsProxy(
        '    ProxyEnable    REG_DWORD    0x1\n    ProxyServer    REG_SZ    http=10.0.0.2:3128;https=10.0.0.2:3129;socks=10.0.0.2:1080\n',
      )?.url,
    ).toBe('http://10.0.0.2:3129')
    expect(
      parseWindowsProxy(
        '    ProxyEnable    REG_DWORD    0x1\n    ProxyServer    REG_SZ    socks=10.0.0.2:1080\n',
      ),
    ).toBeUndefined()
    expect(
      parseWindowsProxy(
        '    ProxyEnable    REG_DWORD    0x0\n    ProxyServer    REG_SZ    127.0.0.1:7890\n',
      ),
    ).toBeUndefined()
  })

  it('环境变量：HTTPS_PROXY → ALL_PROXY → HTTP_PROXY；NO_PROXY；SOCKS 不认；没写协议当 http', () => {
    expect(proxyFromEnv({ https_proxy: '127.0.0.1:7890' }, 'i.ytimg.com')).toBe(
      'http://127.0.0.1:7890',
    )
    expect(proxyFromEnv({ HTTP_PROXY: 'http://p:1' }, 'i.ytimg.com')).toBe('http://p:1')
    expect(
      proxyFromEnv({ HTTPS_PROXY: 'http://a:1', HTTP_PROXY: 'http://b:2' }, 'i.ytimg.com'),
    ).toBe('http://a:1')
    expect(proxyFromEnv({ HTTPS_PROXY: 'socks5://127.0.0.1:7891' }, 'i.ytimg.com')).toBeUndefined()
    expect(
      proxyFromEnv({ HTTPS_PROXY: 'http://a:1', NO_PROXY: 'localhost,.ytimg.com' }, 'i.ytimg.com'),
    ).toBeUndefined()
    expect(normalizeProxyUrl('http://user:pa%40ss@h:8080')).toBe('http://user:pa%40ss@h:8080')
    expect(bypassed('i.ytimg.com', ['*'])).toBe(true)
    expect(bypassed('yt3.ggpht.com', ['*.ggpht.com'])).toBe(true)
    expect(bypassed('intranet', ['<local>'])).toBe(true)
    expect(bypassed('i.ytimg.com', ['<local>', '127.*', 'ytimg.co'])).toBe(false)
  })

  it('系统设置现查、一分钟内不重查；命令跑不了当没开；候选按环境变量 → 系统设置排、去重', async () => {
    let calls = 0
    let at = 0
    const read = createSystemProxyReader({
      platform: 'darwin',
      now: () => at,
      run: async (cmd, args) => {
        calls++
        expect([cmd, ...args]).toEqual(['scutil', '--proxy'])
        return '<dictionary> {\n  HTTPSEnable : 1\n  HTTPSPort : 7890\n  HTTPSProxy : 127.0.0.1\n}'
      },
    })
    expect((await read())?.url).toBe('http://127.0.0.1:7890')
    await read()
    expect(calls).toBe(1)
    at = 61_000
    await read()
    expect(calls).toBe(2)

    const broken = createSystemProxyReader({
      platform: 'win32',
      run: async () => {
        throw new Error('reg 不在')
      },
    })
    expect(await broken()).toBeUndefined()
    expect(await createSystemProxyReader({ platform: 'linux' })()).toBeUndefined()

    const system = async () => ({ url: 'http://127.0.0.1:7890', bypass: [] })
    expect(
      await proxyCandidates('i.ytimg.com', {
        env: { HTTPS_PROXY: 'http://10.0.0.9:3128' },
        system,
      }),
    ).toEqual([
      { url: 'http://10.0.0.9:3128', from: 'env' },
      { url: 'http://127.0.0.1:7890', from: 'system' },
    ])
    expect(
      await proxyCandidates('i.ytimg.com', {
        env: { HTTPS_PROXY: 'http://127.0.0.1:7890' },
        system,
      }),
    ).toEqual([{ url: 'http://127.0.0.1:7890', from: 'env' }])
    expect(
      await proxyCandidates('i.ytimg.com', {
        env: {},
        system: async () => ({ url: 'http://127.0.0.1:7890', bypass: ['*.ytimg.com'] }),
      }),
    ).toEqual([])
  })
})

// ── 1770 B：真拨号（本地假代理 + 假图片站） ──

let cert = ''
let key = ''
let certDir = ''
let images: HttpsServer
let proxy: NetServer
let denyProxy: NetServer
const sockets = new Set<Socket>()
/** 假代理看见过的 CONNECT（目标 + 有没有带账号）。 */
const connects: { target: string; auth?: string }[] = []
/** 假图片站被要过的（Host + 路径）。 */
const served: string[] = []

function track<T extends NetServer | HttpsServer>(s: T): T {
  s.on('connection', (sock: Socket) => {
    sockets.add(sock)
    sock.on('close', () => sockets.delete(sock))
  })
  return s
}

/** 假代理：认 CONNECT，记下目标，一律接到本地假图片站（不管要去哪）。 */
function fakeProxy(status: number): NetServer {
  return track(
    createNetServer((client) => {
      let buf = Buffer.alloc(0)
      client.on('error', () => undefined)
      const onData = (chunk: Buffer): void => {
        buf = Buffer.concat([buf, chunk])
        const end = buf.indexOf('\r\n\r\n')
        if (end === -1) return
        client.off('data', onData)
        const [line = '', ...rest] = buf.subarray(0, end).toString('latin1').split('\r\n')
        const auth = rest.find((h) => /^proxy-authorization:/iu.test(h))
        connects.push({ target: line.split(' ')[1] ?? '', ...(auth === undefined ? {} : { auth }) })
        if (status !== 200) {
          client.end(`HTTP/1.1 ${String(status)} Nope\r\n\r\n`)
          return
        }
        const up = netConnect(IMAGE_PORT, '127.0.0.1', () => {
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
          const extra = buf.subarray(end + 4)
          if (extra.length > 0) up.write(extra)
          client.pipe(up)
          up.pipe(client)
        })
        up.on('error', () => client.destroy())
        sockets.add(up)
        up.on('close', () => sockets.delete(up))
      }
      client.on('data', onData)
    }),
  )
}

const listen = (s: NetServer | HttpsServer, port: number): Promise<void> =>
  new Promise((resolve) => {
    s.listen(port, '127.0.0.1', () => resolve())
  })

beforeAll(async () => {
  certDir = mkdtempSync(join(tmpdir(), 'wp505-cert-'))
  // 本机现做一张自签证书（假图片站用；只有测试信任它）
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=i.ytimg.com',
      '-addext',
      'subjectAltName=DNS:i.ytimg.com,DNS:yt3.ggpht.com,DNS:yt3.googleusercontent.com',
      '-keyout',
      join(certDir, 'key.pem'),
      '-out',
      join(certDir, 'cert.pem'),
    ],
    { stdio: 'ignore' },
  )
  cert = readFileSync(join(certDir, 'cert.pem'), 'utf8')
  key = readFileSync(join(certDir, 'key.pem'), 'utf8')
  images = track(
    createHttpsServer({ key, cert }, (req, res) => {
      served.push(`${req.headers.host ?? ''}${req.url ?? ''}`)
      const path = req.url ?? ''
      if (path === '/hang') return // 一直不回
      if (path === '/big') {
        res.writeHead(200, { 'content-type': 'image/png' })
        res.end(Buffer.concat([Buffer.from(PNG), Buffer.alloc(64 * 1024)]))
        return
      }
      if (path === '/redir-evil') {
        res.writeHead(302, { location: 'https://cdn.evil.example/x.png' })
        res.end()
        return
      }
      if (path === '/redir-ok') {
        res.writeHead(302, { location: 'https://yt3.ggpht.com/after-redirect' })
        res.end()
        return
      }
      if (path === '/svg') {
        res.writeHead(200, { 'content-type': 'image/png' })
        res.end('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>')
        return
      }
      if (path === '/missing') {
        res.writeHead(404)
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(Buffer.from(PNG))
    }),
  )
  proxy = fakeProxy(200)
  denyProxy = fakeProxy(407)
  await listen(images, IMAGE_PORT)
  await listen(proxy, PROXY_PORT)
  await listen(denyProxy, DENY_PROXY_PORT)
})

afterAll(async () => {
  for (const s of sockets) s.destroy()
  await Promise.all(
    [images, proxy, denyProxy].map(
      (s) =>
        new Promise<void>((resolve) => {
          s.close(() => resolve())
        }),
    ),
  )
  rmSync(certDir, { recursive: true, force: true })
})

afterEach(() => {
  connects.splice(0)
  served.splice(0)
})

/** 直连那一步改连本地假图片站（不出网）。 */
const dialLocal = (): Socket => netConnect(IMAGE_PORT, '127.0.0.1')

describe('1770 B：经代理取图（本地假代理 + 假图片站）', () => {
  it('环境变量里的代理：CONNECT 到图片域名，隧道里 TLS，图存下来', async () => {
    const lines: string[] = []
    const fetch = createKolMediaFetch({
      env: { HTTPS_PROXY: `http://127.0.0.1:${String(PROXY_PORT)}` },
      systemProxy: false,
      ca: cert,
      log: (l) => lines.push(l),
    })
    const cache = createKolMediaCache({ fetch })
    const url = 'https://i.ytimg.com/vi/wp505env/hqdefault.jpg'
    await cache.cache([url])
    expect(cache.localUrlOf(url)).toBe(`/v1/kol/media/${kolMediaIdOf(url)}`)
    expect(cache.read(kolMediaIdOf(url))?.bytes).toEqual(PNG)
    expect(connects).toEqual([{ target: 'i.ytimg.com:443' }])
    expect(served).toEqual(['i.ytimg.com/vi/wp505env/hqdefault.jpg'])
    expect(lines.some((l) => l.includes('经代理 http://127.0.0.1:5050（环境变量）'))).toBe(true)
  })

  it('没有环境变量：用操作系统设置里的代理（现查）；代理要账号的带上 Proxy-Authorization', async () => {
    const fetch = createKolMediaFetch({
      env: {},
      systemProxy: async () => ({
        url: `http://me:secret@127.0.0.1:${String(PROXY_PORT)}`,
        bypass: [],
      }),
      ca: cert,
    })
    const cache = createKolMediaCache({ fetch })
    const url = 'https://yt3.ggpht.com/wp505-system'
    await cache.cache([url])
    expect(cache.localUrlOf(url)).toBeDefined()
    expect(connects).toHaveLength(1)
    expect(connects[0]?.target).toBe('yt3.ggpht.com:443')
    expect(connects[0]?.auth).toBe(
      `Proxy-Authorization: Basic ${Buffer.from('me:secret').toString('base64')}`,
    )
  })

  it('环境变量那个连不上（壳交过来的代理后来关了）、系统设置那个拒绝 → 换下一个，最后直连', async () => {
    // 环境变量那个死了 → 系统设置那个通
    const viaSystem = createKolMediaFetch({
      env: { HTTPS_PROXY: DEAD_PROXY },
      systemProxy: async () => ({ url: `http://127.0.0.1:${String(PROXY_PORT)}`, bypass: [] }),
      ca: cert,
    })
    const a = createKolMediaCache({ fetch: viaSystem })
    await a.cache(['https://i.ytimg.com/vi/fallback1/hq.jpg'])
    expect(a.localUrlOf('https://i.ytimg.com/vi/fallback1/hq.jpg')).toBeDefined()
    expect(connects.map((c) => c.target)).toEqual(['i.ytimg.com:443'])

    // 代理回 407 → 直连（直连那一步改连本地）
    connects.splice(0)
    const lines: string[] = []
    const direct = createKolMediaFetch({
      env: { HTTPS_PROXY: `http://127.0.0.1:${String(DENY_PROXY_PORT)}` },
      systemProxy: false,
      ca: cert,
      dial: dialLocal,
      log: (l) => lines.push(l),
    })
    const b = createKolMediaCache({ fetch: direct })
    await b.cache(['https://i.ytimg.com/vi/fallback2/hq.jpg'])
    expect(b.localUrlOf('https://i.ytimg.com/vi/fallback2/hq.jpg')).toBeDefined()
    expect(connects).toHaveLength(1) // 问过 407 那个，它不让过
    expect(lines).toContain('红人图片：直连')
  })

  it('NO_PROXY 排除了这个域名 → 不经代理，直连', async () => {
    const fetch = createKolMediaFetch({
      env: { HTTPS_PROXY: `http://127.0.0.1:${String(PROXY_PORT)}`, NO_PROXY: '.ytimg.com' },
      systemProxy: false,
      ca: cert,
      dial: dialLocal,
    })
    const cache = createKolMediaCache({ fetch })
    await cache.cache(['https://i.ytimg.com/vi/noproxy/hq.jpg'])
    expect(cache.localUrlOf('https://i.ytimg.com/vi/noproxy/hq.jpg')).toBeDefined()
    expect(connects).toEqual([])
  })

  it('闸照旧：超大、SVG 冒充、404、超时都不存；证书不对不换路硬取', async () => {
    const env = { HTTPS_PROXY: `http://127.0.0.1:${String(PROXY_PORT)}` }
    const fetch = createKolMediaFetch({ env, systemProxy: false, ca: cert })
    const lines: string[] = []
    const cache = createKolMediaCache({
      fetch,
      maxBytes: 32 * 1024,
      timeoutMs: 400,
      log: (l) => lines.push(l),
    })
    const urls = ['/big', '/svg', '/missing', '/hang'].map((p) => `https://i.ytimg.com${p}`)
    await cache.cache(urls)
    for (const u of urls) expect(cache.localUrlOf(u)).toBeUndefined()
    expect(lines).toEqual(
      expect.arrayContaining([
        '红人图片：没缓存（太大或是空的）',
        '红人图片：没缓存（不是 JPEG / PNG / WebP / GIF）',
        '红人图片：没缓存（HTTP 404）',
        '红人图片：没缓存（超时）',
      ]),
    )

    // 不信任这张自签证书（= 生产里证书对不上）：取不到，也不退去直连
    connects.splice(0)
    const strict = createKolMediaCache({
      fetch: createKolMediaFetch({ env, systemProxy: false, dial: dialLocal }),
    })
    await strict.cache(['https://i.ytimg.com/vi/untrusted/hq.jpg'])
    expect(strict.localUrlOf('https://i.ytimg.com/vi/untrusted/hq.jpg')).toBeUndefined()
    expect(connects).toHaveLength(1)
  })

  it('跳转一跳一跳核域名：跳到白名单外的连都不连；跳到白名单内的照跟', async () => {
    const fetch = createKolMediaFetch({
      env: { HTTPS_PROXY: `http://127.0.0.1:${String(PROXY_PORT)}` },
      systemProxy: false,
      ca: cert,
    })
    const cache = createKolMediaCache({ fetch })
    await cache.cache(['https://i.ytimg.com/redir-evil', 'https://i.ytimg.com/redir-ok'])
    expect(cache.localUrlOf('https://i.ytimg.com/redir-evil')).toBeUndefined()
    expect(cache.localUrlOf('https://i.ytimg.com/redir-ok')).toBeDefined()
    expect(connects.map((c) => c.target)).not.toContain('cdn.evil.example:443')
    expect(served).toContain('yt3.ggpht.com/after-redirect')
  })
})

// ── 1771 B：清理 ──

describe('1771 B：缓存清理（没人引用的删掉 + 总量上限按最久没用的先删）', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  /** 本地假下载器：按地址回 n 字节的「PNG」。 */
  const sized = (n: number) => async (): Promise<Response> =>
    new Response(Buffer.concat([Buffer.from(PNG), Buffer.alloc(n - PNG.length)]), { status: 200 })

  it('没人引用、过了宽限期的删掉；还在用的、刚存下的留着；落盘的文件一起删', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp505-sweep-'))
    dirs.push(dir)
    let now = 1_000_000
    const cache = createKolMediaCache({ dir, fetch: sized(100), now: () => now })
    const [keep, old, fresh] = ['keep', 'old', 'fresh'].map((s) => `https://yt3.ggpht.com/${s}`)
    await cache.cache([keep as string, old as string])
    now += 20 * 60 * 1000
    await cache.cache([fresh as string])
    const janitor = createKolMediaJanitor({
      brands: () => [{ cache, references: () => [keep as string] }],
      idOf: kolMediaIdOf,
      now: () => now,
    })
    const out = janitor.sweep()
    expect(out).toMatchObject({ unreferenced: 1, evicted: 0, freed_bytes: 100 })
    expect(cache.localUrlOf(old)).toBeUndefined()
    expect(cache.localUrlOf(keep)).toBeDefined()
    // 刚存下不到 10 分钟：就算没人引用也先留着
    expect(cache.localUrlOf(fresh)).toBeDefined()
    expect(readdirSync(dir).sort()).toEqual(
      [kolMediaIdOf(keep as string), kolMediaIdOf(fresh as string)].map((i) => `${i}.png`).sort(),
    )
  })

  it('所有品牌合计超了上限：按最久没用（存下或被看）的先删，删到上限以下', async () => {
    let now = 0
    const a = createKolMediaCache({ fetch: sized(1000), now: () => now })
    const b = createKolMediaCache({ fetch: sized(1000), now: () => now })
    const u = (s: string): string => `https://i.ytimg.com/vi/${s}/hq.jpg`
    for (const [cache, name] of [
      [a, 'a1'],
      [b, 'b1'],
      [a, 'a2'],
      [b, 'b2'],
    ] as const) {
      now += 1000
      await cache.cache([u(name)])
    }
    // a1 最早存下，但刚被看过 → 不算最久没用
    now += 1000
    a.read(kolMediaIdOf(u('a1')))
    const refs = [u('a1'), u('a2'), u('b1'), u('b2')]
    const janitor = createKolMediaJanitor({
      brands: () => [
        { cache: a, references: () => refs },
        { cache: b, references: () => refs },
      ],
      idOf: kolMediaIdOf,
      maxTotalBytes: 2500,
      now: () => now,
    })
    expect(janitor.sweep()).toMatchObject({ unreferenced: 0, evicted: 2, total_bytes: 2000 })
    expect(a.localUrlOf(u('a1'))).toBeDefined()
    expect(b.localUrlOf(u('b1'))).toBeUndefined()
    expect(a.localUrlOf(u('a2'))).toBeUndefined()
    expect(b.localUrlOf(u('b2'))).toBeDefined()
  })

  it('落盘的「最后一次用」重启后还认得（按文件时间）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp505-lru-'))
    dirs.push(dir)
    const one = createKolMediaCache({ dir, fetch: sized(500) })
    const [x, y] = ['https://yt3.ggpht.com/x', 'https://yt3.ggpht.com/y']
    await one.cache([x as string, y as string])
    // y 很久以前用过、x 最近用过
    utimesSync(join(dir, `${kolMediaIdOf(y as string)}.png`), new Date(1_000), new Date(1_000))
    const again = createKolMediaCache({ dir })
    const byId = new Map(again.entries().map((e) => [e.id, e]))
    expect(byId.get(kolMediaIdOf(y as string))?.last_used_ms).toBe(1_000)
    expect(byId.get(kolMediaIdOf(x as string))?.bytes).toBe(500)
    const janitor = createKolMediaJanitor({
      brands: () => [{ cache: again, references: () => [x as string, y as string] }],
      idOf: kolMediaIdOf,
      maxTotalBytes: 600,
    })
    janitor.sweep()
    expect(again.localUrlOf(y)).toBeUndefined()
    expect(again.localUrlOf(x)).toBeDefined()
  })

  it('读不出在用哪些图：这一轮不按「没人引用」删（宁可留着）', async () => {
    const cache = createKolMediaCache({ fetch: sized(100), now: () => 0 })
    await cache.cache(['https://yt3.ggpht.com/z'])
    const janitor = createKolMediaJanitor({
      brands: () => [
        {
          cache,
          references: () => {
            throw new Error('库打不开')
          },
        },
      ],
      idOf: kolMediaIdOf,
      now: () => 60 * 60 * 1000,
    })
    expect(janitor.sweep().unreferenced).toBe(0)
    expect(cache.localUrlOf('https://yt3.ggpht.com/z')).toBeDefined()
  })
})

// ── 起真进程：存入红人池 → 经代理取图 → 换了头像后旧图被清掉 ──

const T0 = '2026-10-24T09:00:00.000Z'
const T1 = '2026-10-24T10:00:00.000Z'
const EXT_ORIGIN = 'chrome-extension://abcdefghijklmnop'

describe('起真进程：生产那条下载器认代理，清理接上了', () => {
  let server: Server
  let url: string
  let youtube: Assignment

  const owner = async (method: string, path: string, body?: unknown, assignment?: string) => {
    const headers = new Headers({
      Authorization: `Bearer ${server.bootstrap.internalToken}`,
      'X-Assignment': assignment ?? youtube.id,
    })
    if (body !== undefined) headers.set('content-type', 'application/json')
    return fetch(`${url}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  }
  const plugin = async (path: string, token: string | undefined, body: unknown) =>
    fetch(`${url}${path}`, {
      method: 'POST',
      headers: {
        Origin: EXT_ORIGIN,
        'content-type': 'application/json',
        ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify(body),
    })
  const data = async <T>(res: Response): Promise<T> => {
    const parsed = (await res.json()) as { data?: T; code?: string; message?: string }
    if (parsed.data === undefined) throw new Error(`${parsed.code}：${parsed.message}`)
    return parsed.data
  }
  const until = async (ok: () => boolean, what: string): Promise<void> => {
    for (let i = 0; i < 60; i++) {
      if (ok()) return
      await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error(what)
  }

  afterEach(async () => {
    await server.close()
  })

  it('存入 → 经环境变量里的代理取到 → 换了头像 → 旧头像被清掉（红人数据不动）', async () => {
    server = await createServer({
      quiet: true,
      clock: { now: () => T0 },
      scheduleIntervalMs: 0,
      startRun: false,
      kolMedia: {
        net: { systemProxy: false, ca: cert },
        sweep: { firstMs: 50, everyMs: 100, graceMs: 0 },
      },
      env: {
        AGENTSWS_OWNER_EMAIL: 'luoye@example.com',
        AGENTSWS_SECRETS_KEY: 'c'.repeat(64),
        HTTPS_PROXY: `http://127.0.0.1:${String(PROXY_PORT)}`,
      },
    })
    ;({ url } = await server.listen(SERVER_PORT))
    youtube = server.roles.assignments.create({
      person_id: server.bootstrap.person.id,
      workspace_id: server.bootstrap.workspace.id,
      role_id: 'kol.youtube',
      granted_by: server.bootstrap.person.id,
      ranges: [{ kind: 'store', id: 'store_1' }],
    })
    const { code } = await data<{ code: string }>(
      await owner('POST', '/v1/extension/pairings', {}, server.bootstrap.ownerAssignment.id),
    )
    const { token } = await data<{ token: string }>(
      await plugin('/v1/extension/pair', undefined, { code }),
    )
    const first = 'https://yt3.ggpht.com/wp505-avatar-1'
    const second = 'https://yt3.ggpht.com/wp505-avatar-2'
    const save = (avatar_url: string, observed_at: string) =>
      plugin('/v1/extension/creators', token, {
        channel: 'youtube',
        handle: '@proxyfixture',
        display_name: 'Proxy Fixture',
        url: 'https://www.youtube.com/@proxyfixture',
        followers: 50_000,
        avatar_url,
        observed_at,
        source: 'manual_save',
      })
    const res = await save(first, T0)
    expect(res.status).toBe(200)
    const id = (await data<{ creator_id: string }>(res)).creator_id
    const brand = await server.brands.forWorkspace(server.bootstrap.workspace.id)
    await until(() => brand.kolMedia.localUrlOf(first) !== undefined, '第一张头像一直没取到')
    expect(connects.map((c) => c.target)).toContain('yt3.ggpht.com:443')

    expect((await save(second, T1)).status).toBe(200)
    await until(() => brand.kolMedia.localUrlOf(second) !== undefined, '第二张头像一直没取到')
    await until(() => brand.kolMedia.localUrlOf(first) === undefined, '旧头像一直没被清掉')
    expect(brand.kolMedia.entries().map((e) => e.id)).toEqual([kolMediaIdOf(second)])
    // 红人与快照都还在
    const detail = await data<{ creator: { id: string }; accounts: { id: string }[] }>(
      await owner('GET', `/v1/kol/creators/${id}`),
    )
    expect(detail.creator.id).toBe(id)
    expect(brand.kol.accountObservations({ account_id: detail.accounts[0]?.id ?? '' }).length).toBe(
      2,
    )
  })
})

// ── 1772 B：AI 打标签 ──

describe('1772 B：tag_creators 只动标签，审核决定 AI 改不了', () => {
  let server: Server
  afterEach(async () => {
    await server.close()
  })

  it('加 / 去标签（不分大小写去重、别的标签不动、满了说一声）；审核一格不动；不存在的人照实说', async () => {
    server = await createServer({
      quiet: true,
      clock: { now: () => T0 },
      scheduleIntervalMs: 0,
      startRun: false,
      env: { AGENTSWS_OWNER_EMAIL: 'luoye@example.com', AGENTSWS_SECRETS_KEY: 'c'.repeat(64) },
    })
    const ws = server.bootstrap.workspace.id as WorkspaceId
    const youtube = server.roles.assignments.create({
      person_id: server.bootstrap.person.id,
      workspace_id: ws,
      role_id: 'kol.youtube',
      granted_by: server.bootstrap.person.id,
      ranges: [{ kind: 'store', id: 'store_1' }],
    })
    const brand = await server.brands.forWorkspace(ws)
    const port = brand.kolService.port
    const actor = {
      workspace_id: ws,
      person_id: server.bootstrap.person.id,
      assignment_id: youtube.id,
      role_id: 'kol.youtube',
    } as never
    const a = (
      await port.createCreator(actor, {
        display_name: 'Desk A',
        channel: 'youtube',
        handle: '@deska',
      })
    ).creator.id
    const b = (
      await port.createCreator(actor, {
        display_name: 'Desk B',
        channel: 'youtube',
        handle: '@deskb',
      })
    ).creator.id
    await port.setCreatorTags?.(actor, a, { tags: ['开箱', '待联系'] })
    await port.reviewCreator?.(actor, a, { decision: 'rejected', reason: '风格不对' })

    const exec = createKolToolExecutor({ workspace_id: ws, port: () => port, now: () => T0 })
    const request = {
      actor: {
        person_id: server.bootstrap.person.id,
        assignment_id: youtube.id,
        role_id: 'kol.youtube',
      },
    } as never
    const out = await exec({
      name: 'tag_creators',
      input: {
        creator_ids: [a, b, 'cr_nobody'],
        add: ['桌搭', ' 桌搭 ', '开箱'],
        remove: ['待联系'],
        // 夹带审核决定：不认
        review: 'approved',
        decision: 'approved',
      },
      request,
    })
    expect(out.status).toBe('ok')
    const rows = (
      out.data as { creators: { creator_id: string; tags?: string[]; error?: string }[] }
    ).creators
    expect(rows.find((r) => r.creator_id === a)?.tags).toEqual(['开箱', '桌搭'])
    expect(rows.find((r) => r.creator_id === b)?.tags).toEqual(['桌搭', '开箱'])
    expect(rows.find((r) => r.creator_id === 'cr_nobody')?.error).toContain('没有')
    expect((out.data as { summary: string }).summary).toContain('审核决定没动')
    // 审核决定还是人点的那个
    expect((await port.creator(actor, a))?.review).toMatchObject({
      decision: 'rejected',
      reason: '风格不对',
    })
    expect((await port.creator(actor, b))?.review).toBeUndefined()

    // 满了（每人最多 20 个）：没加上的照实说
    await port.setCreatorTags?.(actor, b, {
      tags: Array.from({ length: 20 }, (_, i) => `t${String(i)}`),
    })
    const full = await exec({
      name: 'tag_creators',
      input: { creator_ids: [b], add: ['美区'] },
      request,
    })
    expect((full.data as { creators: { dropped?: string[] }[] }).creators[0]?.dropped).toEqual([
      '美区',
    ])

    // 什么都没给 / 一个都改不成：回错
    expect(
      (await exec({ name: 'tag_creators', input: { creator_ids: [a] }, request })).status,
    ).toBe('error')
    expect(
      (await exec({ name: 'tag_creators', input: { creator_ids: ['cr_x'], add: ['x'] }, request }))
        .status,
    ).toBe('error')
  })

  it('没有一个红人工具改得了审核决定（工具清单与执行器源码里都没有那个口子）', () => {
    for (const spec of KOL_TOOL_SPECS) {
      const props = Object.keys(
        (spec.input_schema as { properties?: Record<string, unknown> }).properties ?? {},
      )
      expect(props.filter((p) => p === 'decision')).toEqual([])
      expect(spec.name).not.toMatch(/review_creator|approve_creator|reject_creator/u)
    }
    const source = readFileSync(join(__dirname, '../src/kol-tools.ts'), 'utf8')
    expect(source).not.toMatch(/\.reviewCreator\b/u)
    expect(KOL_TOOL_SPECS.map((s) => s.name)).toContain('tag_creators')
  })
})
