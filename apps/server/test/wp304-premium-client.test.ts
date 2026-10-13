/**
 * WP304：高级主题的工坊一侧客户端（问云 / 买 / 下载 / 解包）。云与签名地址都是替身，不联网。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createPremiumThemeClient,
  extractThemePackage,
  type PremiumFetch,
} from '../src/premium-theme.js'
import { premiumThemeStandIn, themeTarGz, themeZip } from '../src/premium-theme-stand-in.js'
import type { SecretStore } from '../src/secret-store.js'
import { FAKE_PREMIUM_THEME_FILES } from '../src/site-theme-stand-in.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wp304-premium-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const secrets = (token?: string) =>
  ({
    available: true,
    get: () => (token === undefined ? undefined : { token }),
  }) as unknown as SecretStore

const reply =
  (status: number, body: unknown, seen?: { url: string; auth?: string }[]): PremiumFetch =>
  async (url, init) => {
    seen?.push({
      url,
      ...(init?.headers?.Authorization === undefined ? {} : { auth: init.headers.Authorization }),
    })
    const text = JSON.stringify(body)
    return { ok: status < 300, status, text: async () => text }
  }

/** 一个带子目录的 zip（store / deflate 都有）。 */
function zipOf(files: Record<string, string>): Uint8Array {
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  let i = 0
  for (const [name, body] of Object.entries(files)) {
    const data = Buffer.from(body, 'utf8')
    const method = i++ % 2 === 0 ? 8 : 0
    const comp = method === 8 ? deflateRawSync(data) : data
    const nameBuf = Buffer.from(name, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(comp.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    const c = Buffer.alloc(46)
    c.writeUInt32LE(0x02014b50, 0)
    c.writeUInt16LE(method, 10)
    c.writeUInt32LE(comp.length, 20)
    c.writeUInt32LE(data.length, 24)
    c.writeUInt16LE(nameBuf.length, 28)
    c.writeUInt32LE(offset, 42)
    central.push(c, nameBuf)
    chunks.push(local, nameBuf, comp)
    offset += 30 + nameBuf.length + comp.length
  }
  const cd = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return new Uint8Array(Buffer.concat([...chunks, cd, end]))
}

describe('高级主题客户端（WP304）', () => {
  it('令牌只在请求头；`{ data }` 信封解开；没登录不出网', async () => {
    const seen: { url: string; auth?: string }[] = []
    const c = createPremiumThemeClient({
      secrets: secrets('wst_x'),
      baseUrl: 'https://cloud.test',
      tokenSecretId: 'cloud.workspace_token',
      fetch: reply(
        200,
        { data: { owned: false, price_credits: 560, latest_version: '1.2.0' } },
        seen,
      ),
    })
    expect(await c.entitlement('a.myshopify.com')).toMatchObject({
      owned: false,
      price_credits: 560,
    })
    expect(seen).toEqual([
      {
        url: 'https://cloud.test/v1/themes/premium/entitlement?shop=a.myshopify.com',
        auth: 'Bearer wst_x',
      },
    ])
    const none = createPremiumThemeClient({
      secrets: secrets(),
      baseUrl: 'https://cloud.test',
      tokenSecretId: 'cloud.workspace_token',
      fetch: reply(200, {}, seen),
    })
    expect(none.linked()).toBe(false)
    await expect(none.entitlement('a.myshopify.com')).rejects.toMatchObject({ code: 'not_linked' })
    expect(seen).toHaveLength(1)
  })

  it('云上没这条路 → 即将开放；402 → 云上那句人话', async () => {
    const make = (status: number, body: unknown) =>
      createPremiumThemeClient({
        secrets: secrets('wst_x'),
        baseUrl: 'https://cloud.test',
        tokenSecretId: 'cloud.workspace_token',
        fetch: reply(status, body),
      })
    await expect(
      make(404, { code: 'not_found', message: 'x' }).entitlement('a.myshopify.com'),
    ).rejects.toMatchObject({
      code: 'unavailable',
      message: expect.stringMatching(/即将开放/),
    })
    await expect(
      make(402, { code: 'insufficient_credits', message: '积分不够了：要 560' }).purchase(
        'a.myshopify.com',
      ),
    ).rejects.toMatchObject({ code: 'insufficient_credits', message: '积分不够了：要 560' })
  })

  it('签名地址只认 https；sha256 对上才回字节', async () => {
    const pkg = themeTarGz(FAKE_PREMIUM_THEME_FILES)
    const sha = createHash('sha256').update(pkg).digest('hex')
    const fetched: string[] = []
    const make = (url: string) =>
      createPremiumThemeClient({
        secrets: secrets('wst_x'),
        baseUrl: 'https://cloud.test',
        tokenSecretId: 'cloud.workspace_token',
        fetch: reply(200, { data: { version: '1.2.0', sha256: sha, url } }),
        fetchBytes: async (u) => {
          fetched.push(u)
          return {
            ok: true,
            status: 200,
            text: async () => '',
            arrayBuffer: async () => pkg.slice().buffer as ArrayBuffer,
          }
        },
      })
    await expect(make('http://evil.test/p.tgz').download('a.myshopify.com')).rejects.toMatchObject({
      code: 'bad_package',
    })
    expect(fetched).toEqual([])
    const ok = await make('https://r2.test/signed?x=1').download('a.myshopify.com')
    expect(ok.version).toBe('1.2.0')
    expect(ok.bytes.byteLength).toBe(pkg.byteLength)
  })

  it('解包：tar.gz 与 zip 都认，顶层多一层目录也认；路径穿越跳过', () => {
    const tgzRoot = extractThemePackage(themeTarGz(FAKE_PREMIUM_THEME_FILES), join(dir, 'a'))
    expect(tgzRoot).toBe(join(dir, 'a', 'agentsws-theme'))
    expect(readFileSync(join(tgzRoot, 'templates', 'index.json'), 'utf8')).toContain('hero')
    const zipRoot = extractThemePackage(
      zipOf({
        'config/settings_schema.json': '[{"name":"theme_info","theme_name":"x"}]',
        'sections/a.liquid': '<a></a>',
        '../escape.txt': 'no',
      }),
      join(dir, 'b'),
    )
    expect(zipRoot).toBe(join(dir, 'b'))
    expect(readFileSync(join(zipRoot, 'sections', 'a.liquid'), 'utf8')).toBe('<a></a>')
    expect(existsSync(join(dir, 'escape.txt'))).toBe(false)
    expect(() => extractThemePackage(new Uint8Array([1, 2, 3]), join(dir, 'c'))).toThrow(/认不出/)
  })
})

describe('WP305 定稿的形状', () => {
  const viaStandIn =
    (st: ReturnType<typeof premiumThemeStandIn>): PremiumFetch =>
    async (input, init) => {
      const url = new URL(input)
      const body =
        init?.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>)
      const out = st.handle(init?.method ?? 'GET', url.pathname, url.searchParams, body) ?? {
        status: 404,
        body: {},
      }
      const lower = new Map(Object.entries(out.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
      const bytes = out.bytes
      const text = JSON.stringify(out.body ?? {})
      return {
        ok: out.status < 300,
        status: out.status,
        text: async () => text,
        headers: { get: (n: string) => lower.get(n.toLowerCase()) ?? null },
        ...(bytes === undefined
          ? {}
          : { arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer }),
      }
    }

  it('买：新买 201 扣 560、再买 200 不扣；下载 zip 流（头里的版本与 sha256），文件在包根；店铺写法大小写 / https:// 都认', async () => {
    let credits = 1000
    const st = premiumThemeStandIn({
      available: () => credits,
      spend: (n) => {
        credits -= n
      },
    })
    const c = createPremiumThemeClient({
      secrets: secrets('wst_x'),
      baseUrl: 'https://cloud.test',
      tokenSecretId: 'cloud.workspace_token',
      fetch: viaStandIn(st),
    })
    await expect(c.download('a.myshopify.com')).rejects.toMatchObject({ code: 'not_owned' })
    expect(await c.purchase('https://A.myshopify.com/')).toMatchObject({
      already_owned: false,
      charged_credits: 560,
    })
    expect(await c.purchase('a.myshopify.com')).toMatchObject({
      already_owned: true,
      charged_credits: 0,
    })
    expect(credits).toBe(440)
    expect(await c.entitlement('a.myshopify.com')).toMatchObject({
      owned: true,
      available: true,
      latest_version: '1.2.0',
    })
    const got = await c.download('a.myshopify.com')
    expect(got.version).toBe('1.2.0')
    const root = extractThemePackage(got.bytes, join(dir, 'z'))
    expect(root).toBe(join(dir, 'z'))
    expect(existsSync(join(root, 'config', 'settings_schema.json'))).toBe(true)
    await expect(c.download('a.myshopify.com', '9.9.9')).rejects.toMatchObject({ code: 'failed' })
  })

  it('没上架：entitlement 200 available:false；买 409 不扣钱 → 即将开放；钱包 503 → 再点不会重复扣', async () => {
    let credits = 1000
    const st = premiumThemeStandIn({
      available: () => credits,
      spend: (n) => {
        credits -= n
      },
      listed: false,
    })
    const c = createPremiumThemeClient({
      secrets: secrets('wst_x'),
      baseUrl: 'https://cloud.test',
      tokenSecretId: 'cloud.workspace_token',
      fetch: viaStandIn(st),
    })
    expect(await c.entitlement('a.myshopify.com')).toMatchObject({ available: false, owned: false })
    expect((await c.entitlement('a.myshopify.com')).latest_version).toBeUndefined()
    await expect(c.purchase('a.myshopify.com')).rejects.toMatchObject({ code: 'unavailable' })
    expect(credits).toBe(1000)
    const busy = createPremiumThemeClient({
      secrets: secrets('wst_x'),
      baseUrl: 'https://cloud.test',
      tokenSecretId: 'cloud.workspace_token',
      fetch: reply(503, { code: 'unavailable', message: 'wallet down' }),
    })
    await expect(busy.purchase('a.myshopify.com')).rejects.toMatchObject({
      code: 'failed',
      message: expect.stringMatching(/不会重复扣/),
    })
  })

  it('themeZip 出来的包解得开（带子目录）', () => {
    const root = extractThemePackage(themeZip(FAKE_PREMIUM_THEME_FILES), join(dir, 'y'))
    expect(readFileSync(join(root, 'sections', 'hero.liquid'), 'utf8')).toContain('schema')
  })
})
