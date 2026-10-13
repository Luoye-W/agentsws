/**
 * WP304（决策 445）：高级主题那三条云路由的**替身**（demo 与测试用；真的在私有云 WP305）。一个字节都不出网。
 *
 * - 授权按店记在内存里；买一次扣 560 积分（余额由调用方给，demo 里那一小本账不够就照实回 402）；同店再买不重复扣；
 * - 形状照私有云 WP305 定稿：成功 `{ data }`、失败 `{ code, message, details }`；买新 201、已有 200；
 *   下载回 **zip 流**（文件在包根），版本与 sha256 在响应头；没买 403 `not_purchased`；
 * - 包是**手写的占位主题**（`FAKE_PREMIUM_THEME_FILES`），不是我们闭源主题的任何一行。
 */
import { createHash } from 'node:crypto'
import { deflateRawSync, gzipSync } from 'node:zlib'
import {
  PREMIUM_THEME_HEADERS,
  PREMIUM_THEME_PATHS,
  PREMIUM_THEME_PRICE_CREDITS,
  type PremiumThemeEntitlement,
  type PremiumThemePurchaseResult,
} from '@agentsws/contracts'
import { crc32 } from './backup.js'
import { FAKE_PREMIUM_THEME_FILES } from './site-theme-stand-in.js'

/** 一个最小的 ustar 归档（只放普通文件），再 gzip——`git archive --format=tar.gz --prefix=<目录>/` 那个样子。 */
export function themeTarGz(
  files: Readonly<Record<string, string>>,
  prefix = 'agentsws-theme',
): Uint8Array {
  const blocks: Buffer[] = []
  const octal = (n: number, len: number): string => `${n.toString(8).padStart(len - 1, '0')}\0`
  for (const [rel, body] of Object.entries(files)) {
    const name = prefix === '' ? rel : `${prefix}/${rel}`
    const data = Buffer.from(body, 'utf8')
    const header = Buffer.alloc(512)
    header.write(name.slice(0, 100), 0, 'utf8')
    header.write(octal(0o644, 8), 100, 'ascii')
    header.write(octal(0, 8), 108, 'ascii')
    header.write(octal(0, 8), 116, 'ascii')
    header.write(octal(data.length, 12), 124, 'ascii')
    header.write(octal(0, 12), 136, 'ascii')
    header.write('        ', 148, 'ascii')
    header.write('0', 156, 'ascii')
    header.write('ustar\0', 257, 'ascii')
    header.write('00', 263, 'ascii')
    let sum = 0
    for (const b of header) sum += b
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii')
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return new Uint8Array(gzipSync(Buffer.concat(blocks)))
}

/** 一个 zip（文件在包根，可带子目录；deflate）——WP305 下载回的那个样子。 */
export function themeZip(files: Readonly<Record<string, string>>): Uint8Array {
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, body] of Object.entries(files)) {
    const data = Buffer.from(body, 'utf8')
    const comp = deflateRawSync(data)
    const crc = crc32(data)
    const nameBuf = Buffer.from(name, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(comp.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    const c = Buffer.alloc(46)
    c.writeUInt32LE(0x02014b50, 0)
    c.writeUInt16LE(20, 4)
    c.writeUInt16LE(20, 6)
    c.writeUInt16LE(8, 10)
    c.writeUInt32LE(crc, 16)
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

/** 替身回的一次：JSON 正文，或（下载）字节 + 响应头。 */
export interface PremiumStandInReply {
  status: number
  body?: unknown
  bytes?: Uint8Array
  headers?: Record<string, string>
}

export interface PremiumThemeStandIn {
  /** 认得出就回一次回话；不是这三条路回 undefined。 */
  handle(
    method: string,
    path: string,
    query: URLSearchParams,
    body: Record<string, unknown>,
  ): PremiumStandInReply | undefined
  owned(): string[]
  downloads(): { shop: string; version: string }[]
}

/** 云上认的店铺写法：大小写 / `https://` / 尾斜杠都认。 */
const shopOf = (raw: unknown): string | undefined => {
  if (typeof raw !== 'string') return undefined
  const s = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '')
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(s) ? s : undefined
}

export function premiumThemeStandIn(options: {
  /** 还剩多少可用积分（买之前看一眼）。 */
  available(): number
  /** 真扣（买成了才叫）。 */
  spend(credits: number): void
  version?: string
  files?: Readonly<Record<string, string>>
  /** `false` = 私有桶没绑 / 还没上架（entitlement 200 但 `available: false`；买 409、下 409）。 */
  listed?: boolean
}): PremiumThemeStandIn {
  const owned = new Set<string>()
  const downloads: { shop: string; version: string }[] = []
  const version = options.version ?? '1.2.0'
  const listed = options.listed !== false
  const pkg = themeZip(options.files ?? FAKE_PREMIUM_THEME_FILES)
  const sha256 = createHash('sha256').update(pkg).digest('hex')
  const err = (
    status: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) => ({
    status,
    body: { code, message, ...(details === undefined ? {} : { details }) },
  })
  const bad = err(400, 'invalid_input', '店铺地址要是 xxx.myshopify.com')
  const notListed = err(409, 'not_available', '高级主题还没上架。')
  return {
    handle(method, path, query, body) {
      if (method === 'GET' && path === PREMIUM_THEME_PATHS.entitlement) {
        const shop = shopOf(query.get('shop'))
        if (shop === undefined) return bad
        const data: PremiumThemeEntitlement = {
          shop,
          theme_id: 'agentsws-theme',
          owned: owned.has(shop),
          price_credits: PREMIUM_THEME_PRICE_CREDITS,
          latest_version: listed ? version : null,
          available: listed,
        }
        return { status: 200, body: { data } }
      }
      if (method === 'POST' && path === PREMIUM_THEME_PATHS.purchase) {
        const shop = shopOf(body.shop)
        if (shop === undefined) return bad
        if (!listed) return notListed
        if (owned.has(shop)) {
          const data: PremiumThemePurchaseResult = {
            shop,
            charged_credits: 0,
            already_owned: true,
          }
          return { status: 200, body: { data } }
        }
        const available = options.available()
        if (available < PREMIUM_THEME_PRICE_CREDITS)
          return err(
            402,
            'insufficient_credits',
            `积分不够了：高级主题要 ${PREMIUM_THEME_PRICE_CREDITS} 积分，可用 ${available}。去"账号与积分"里充值后再试。`,
            {
              required: PREMIUM_THEME_PRICE_CREDITS,
              available,
              shop,
              price_credits: PREMIUM_THEME_PRICE_CREDITS,
            },
          )
        options.spend(PREMIUM_THEME_PRICE_CREDITS)
        owned.add(shop)
        const data: PremiumThemePurchaseResult = {
          shop,
          charged_credits: PREMIUM_THEME_PRICE_CREDITS,
          already_owned: false,
        }
        return { status: 201, body: { data } }
      }
      if (method === 'GET' && path === PREMIUM_THEME_PATHS.download) {
        const shop = shopOf(query.get('shop'))
        if (shop === undefined) return bad
        if (!listed) return notListed
        if (!owned.has(shop)) return err(403, 'not_purchased', '这家店还没买高级主题。')
        const want = query.get('version')
        if (want !== null && want !== version)
          return err(404, 'version_not_found', '没有这一版。', { latest_version: version })
        downloads.push({ shop, version })
        return {
          status: 200,
          bytes: pkg,
          headers: {
            'content-type': 'application/zip',
            [PREMIUM_THEME_HEADERS.version]: version,
            [PREMIUM_THEME_HEADERS.sha256]: sha256,
          },
        }
      }
      return undefined
    },
    owned: () => [...owned],
    downloads: () => [...downloads],
  }
}
