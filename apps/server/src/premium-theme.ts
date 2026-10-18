/**
 * WP304（决策 445）：**高级主题**（我们自己的、付费）的工坊一侧——问云「这家店买没买」、买、下载、解包。
 *
 * 云端那一半是私有云 WP305（按 组织 × 店铺 记买断、私有存储、下载记录）。这里照 `@agentsws/contracts` 的
 * {@link PREMIUM_THEME_PATHS} 调；云上还没这几条路（404 / 501 / 503）、连不上 → `unavailable`，卡上显示「即将开放」。
 *
 * 三条纪律：
 *
 * 1. **令牌只在请求头那一行**（本机加密库里的工作区令牌，与官方数据接口同一把）；不进日志、不进事件。
 * 2. **下载的包核 sha256**：对不上一个字节都不落盘（{@link PremiumThemeError} `integrity`）。签名地址只认 https，
 *    不写进任何事件 / 日志（它本身就是一把短时钥匙）。
 * 3. **主题文件只进用户自己的工作目录**：解包只在调用方给的暂存目录里，路径穿越（绝对路径、`..`）一律跳过。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, normalize, sep } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import {
  PREMIUM_THEME_HEADERS,
  PREMIUM_THEME_PATHS,
  PREMIUM_THEME_PRICE_CREDITS,
  type PremiumThemeDownload,
  type PremiumThemeEntitlement,
  type PremiumThemePurchaseResult,
} from '@agentsws/contracts'
import { currentCloudHeaders } from './cloud-attribution.js'
import { extractTgz, safeEntryPath } from './npm-runtime.js'
import type { SecretStore } from './secret-store.js'

export type PremiumThemeErrorCode =
  /** 云上还没开这几条路 / 连不上 / 等太久——「即将开放」 */
  | 'unavailable'
  /** 没登录工坊账号（本机没有工作区令牌 / 令牌不认） */
  | 'not_linked'
  /** WP418：登录了，令牌少了「店铺」那一项动作集（403 forbidden） */
  | 'missing_scope'
  /** WP418：这一次连不上云（断网 / 超时）——与「云上还没开」分开说 */
  | 'offline'
  /** 积分不够（云上那句人话原样给） */
  | 'insufficient_credits'
  /** 这家店没买（下载被拒） */
  | 'not_owned'
  /** 下载的包 sha256 对不上 */
  | 'integrity'
  /** 包解不开 / 里面没有主题 */
  | 'bad_package'
  /** 云上别的错（原话） */
  | 'failed'

export class PremiumThemeError extends Error {
  constructor(
    readonly code: PremiumThemeErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'PremiumThemeError'
  }
}

/** 「即将开放」那一句。 */
export const PREMIUM_SOON_TEXT = '高级主题即将开放，现在先用店里的免费主题（推荐 Horizon）。'
/** WP418：这一次连不上工坊云端。 */
export const PREMIUM_OFFLINE_TEXT = '暂时连不上 Agents 工坊云端，过一会儿再选一次。'
/** 没登录工坊账号。 */
export const PREMIUM_NOT_LINKED_TEXT =
  '买高级主题要先登录 Agents 工坊账号（设置 →「账号与积分」），登好了再选一次。'

/** 一次 HTTP 回来的最小面（`cloudFetch` 的替身只有 text / json；真 fetch 还有 arrayBuffer / headers）。 */
export interface PremiumFetchResponse {
  ok: boolean
  status: number
  text(): Promise<string>
  arrayBuffer?(): Promise<ArrayBuffer>
  headers?: { get(name: string): string | null }
}
export type PremiumFetch = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<PremiumFetchResponse>

export interface PremiumThemeClient {
  /** 本机有没有工坊账号的工作区令牌（没有 = 卡上「登录后可买」）。 */
  linked(): boolean
  entitlement(shop: string): Promise<PremiumThemeEntitlement>
  purchase(shop: string): Promise<PremiumThemePurchaseResult>
  /** 下载并核 sha256；回整包字节（只在内存里，调用方解进暂存目录）。 */
  download(shop: string, version?: string): Promise<{ version: string; bytes: Uint8Array }>
}

/** 云上那几条路要等多久（下载另算：包有几 MB）。 */
const CALL_TIMEOUT_MS = 15_000
const DOWNLOAD_TIMEOUT_MS = 120_000
/** 包最大多少（主题包几 MB；超了当坏包）。 */
export const MAX_PREMIUM_PACKAGE_BYTES = 64 * 1024 * 1024

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

export function createPremiumThemeClient(options: {
  secrets: SecretStore
  /** 云的根地址（`cloudBaseUrl(env)`）。 */
  baseUrl: string
  tokenSecretId: string
  /** 调云（测试 / demo 注入替身；不给 = 全局 fetch）。 */
  fetch?: PremiumFetch
  /** 取签名地址那一跳（只认 https；不给 = 全局 fetch）。 */
  fetchBytes?: PremiumFetch
}): PremiumThemeClient {
  const doFetch: PremiumFetch =
    options.fetch ?? ((u, i) => globalThis.fetch(u, i) as unknown as Promise<PremiumFetchResponse>)
  const fetchBytes: PremiumFetch =
    options.fetchBytes ??
    ((u, i) => globalThis.fetch(u, i) as unknown as Promise<PremiumFetchResponse>)
  const tokenOf = (): string | undefined => {
    if (!options.secrets.available) return undefined
    try {
      const t = options.secrets.get(options.tokenSecretId)?.token
      return t === undefined || t === '' ? undefined : t
    } catch {
      return undefined
    }
  }

  const failure = (status: number, body: Record<string, unknown>): PremiumThemeError => {
    const said = typeof body.message === 'string' && body.message !== '' ? body.message : undefined
    const code = typeof body.code === 'string' ? body.code : ''
    if (status === 401) return new PremiumThemeError('not_linked', PREMIUM_NOT_LINKED_TEXT)
    if (status === 402 || code === 'insufficient_credits')
      return new PremiumThemeError(
        'insufficient_credits',
        said ??
          `积分不够：买高级主题要 ${PREMIUM_THEME_PRICE_CREDITS} 积分。去「账号与积分」充值后再选一次。`,
      )
    if (status === 403 && code !== 'forbidden')
      return new PremiumThemeError('not_owned', '这家店还没买高级主题。')
    if (status === 403)
      return new PremiumThemeError(
        'missing_scope',
        '这把工坊账号令牌没有「店铺」那一项权限，重新登录一次工坊账号再试。',
      )
    // WP305：指定的版本没有（带 latest_version）
    if (code === 'version_not_found')
      return new PremiumThemeError('failed', '云上没有这一版高级主题，换最新版再试。')
    // WP305：钱包没应答——再点不会重复扣（幂等由云端保证）
    if (status === 503 && code !== 'not_implemented')
      return new PremiumThemeError(
        'failed',
        'Agents 工坊云的钱包这会儿没应答，过一会儿再点一次「买下」（不会重复扣）。',
      )
    // 云上还没这条路（老版本的云）/ 私有桶没绑（501）/ 还没上架（409 not_available，不扣钱）：都当「即将开放」
    if (
      status === 404 ||
      status === 501 ||
      status === 409 ||
      code === 'not_implemented' ||
      code === 'not_available'
    )
      return new PremiumThemeError('unavailable', PREMIUM_SOON_TEXT)
    return new PremiumThemeError('failed', said ?? `Agents 工坊云这一次没成（HTTP ${status}）。`)
  }

  async function send(
    method: 'GET' | 'POST',
    path: string,
    payload: unknown,
    accept: string,
    timeoutMs: number,
  ): Promise<PremiumFetchResponse> {
    const token = tokenOf()
    if (token === undefined) throw new PremiumThemeError('not_linked', PREMIUM_NOT_LINKED_TEXT)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      // 令牌只在这一行进头
      return await doFetch(`${options.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          accept,
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
          ...currentCloudHeaders(),
        },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        signal: controller.signal,
      })
    } catch {
      // WP418（自查 A7）：连不上 ≠ 还没上架
      throw new PremiumThemeError('offline', PREMIUM_OFFLINE_TEXT)
    } finally {
      clearTimeout(timer)
    }
  }

  /** 读 JSON 回话：错 → {@link failure}；成功解 `{ data }` 信封（直接回正文的也认）。 */
  async function parse<T>(res: PremiumFetchResponse): Promise<T> {
    const text = await res.text()
    let body: Record<string, unknown> = {}
    try {
      const parsed = text.trim() === '' ? {} : (JSON.parse(text) as unknown)
      body =
        parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
    } catch {
      // 不是 JSON：多半是还没这条路的网关页
      if (!res.ok) throw failure(res.status, {})
      throw new PremiumThemeError('unavailable', PREMIUM_SOON_TEXT)
    }
    if (!res.ok) throw failure(res.status, body)
    // 云上成功是 `{ data }` 信封（钱包那一层的写法）；直接回正文的也认
    const data = body.data !== undefined ? body.data : body
    return data as T
  }

  async function call<T>(method: 'GET' | 'POST', path: string, payload?: unknown): Promise<T> {
    return parse<T>(await send(method, path, payload, 'application/json', CALL_TIMEOUT_MS))
  }

  /** 响应头（替身那种没有 headers 的回 undefined）。 */
  const header = (res: PremiumFetchResponse, name: string): string | undefined => {
    const v = res.headers?.get(name)
    return v === null || v === undefined || v.trim() === '' ? undefined : v.trim()
  }

  const q = (shop: string, extra: Record<string, string | undefined> = {}): string => {
    const params = new URLSearchParams({ shop })
    for (const [k, v] of Object.entries(extra)) if (v !== undefined) params.set(k, v)
    return params.toString()
  }

  const bytesOfUrl = async (url: string): Promise<Uint8Array> => {
    if (!url.startsWith('https://'))
      throw new PremiumThemeError('bad_package', '下载地址不是 https，没下。')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
    try {
      const res = await fetchBytes(url, { method: 'GET', signal: controller.signal })
      if (!res.ok || res.arrayBuffer === undefined)
        throw new PremiumThemeError('failed', `高级主题包没下下来（HTTP ${res.status}）。`)
      return new Uint8Array(await res.arrayBuffer())
    } catch (e) {
      if (e instanceof PremiumThemeError) throw e
      throw new PremiumThemeError('unavailable', '高级主题包没下下来（网络不通），过一会儿再试。')
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    linked: () => tokenOf() !== undefined,
    async entitlement(shop) {
      const out = await call<PremiumThemeEntitlement>(
        'GET',
        `${PREMIUM_THEME_PATHS.entitlement}?${q(shop)}`,
      )
      const { latest_version, ...rest } = out
      return {
        ...rest,
        ...(typeof latest_version === 'string' ? { latest_version } : {}),
        owned: out.owned === true,
        price_credits:
          typeof out.price_credits === 'number' ? out.price_credits : PREMIUM_THEME_PRICE_CREDITS,
      }
    },
    async purchase(shop) {
      return call<PremiumThemePurchaseResult>('POST', PREMIUM_THEME_PATHS.purchase, { shop })
    },
    async download(shop, version) {
      const res = await send(
        'GET',
        `${PREMIUM_THEME_PATHS.download}?${q(shop, { version })}`,
        undefined,
        'application/zip, application/json',
        DOWNLOAD_TIMEOUT_MS,
      )
      // WP305 定稿：200 = zip 流，版本与 sha256 在响应头
      const headSha = res.ok ? header(res, PREMIUM_THEME_HEADERS.sha256) : undefined
      let bytes: Uint8Array | undefined
      let sha: string | undefined
      let got = version ?? ''
      if (headSha !== undefined && res.arrayBuffer !== undefined) {
        sha = headSha
        got = header(res, PREMIUM_THEME_HEADERS.version) ?? got
        bytes = new Uint8Array(await res.arrayBuffer())
      } else {
        // 兜底：JSON（整包 base64 / 短时签名地址）
        const out = await parse<PremiumThemeDownload>(res)
        sha = typeof out.sha256 === 'string' ? out.sha256 : undefined
        got = typeof out.version === 'string' ? out.version : got
        bytes =
          typeof out.content_base64 === 'string'
            ? new Uint8Array(Buffer.from(out.content_base64, 'base64'))
            : typeof out.url === 'string'
              ? await bytesOfUrl(out.url)
              : undefined
      }
      if (sha === undefined || !/^[0-9a-f]{64}$/i.test(sha))
        throw new PremiumThemeError('bad_package', '云上没给高级主题包的 sha256，没装。')
      if (bytes === undefined)
        throw new PremiumThemeError('bad_package', '云上没给高级主题包（没有地址也没有内容）。')
      if (bytes.byteLength > MAX_PREMIUM_PACKAGE_BYTES)
        throw new PremiumThemeError('bad_package', '高级主题包大得不对劲，没装。')
      if (sha256Hex(bytes) !== sha.toLowerCase())
        throw new PremiumThemeError(
          'integrity',
          '下载的高级主题包校验没对上（sha256），没装。过一会儿再试一次。',
        )
      return { version: got, bytes }
    },
  }
}

// ── 解包：tar.gz（git archive 默认）或 zip ─────────────────────────────────

/** 一个 zip 包（多层目录、store / deflate 两种方法）解到 `dest`；回写了几个文件。 */
export function extractZip(zip: Uint8Array, dest: string): number {
  const buf = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength)
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i -= 1)
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  if (eocd < 0) throw new PremiumThemeError('bad_package', '高级主题包解不开（不是 zip）。')
  const count = buf.readUInt16LE(eocd + 10)
  let cursor = buf.readUInt32LE(eocd + 16)
  const root = normalize(dest)
  let files = 0
  for (let i = 0; i < count; i += 1) {
    if (cursor + 46 > buf.length || buf.readUInt32LE(cursor) !== 0x02014b50)
      throw new PremiumThemeError('bad_package', '高级主题包坏了（zip 目录）。')
    const method = buf.readUInt16LE(cursor + 10)
    const compressedSize = buf.readUInt32LE(cursor + 20)
    const nameLen = buf.readUInt16LE(cursor + 28)
    const extraLen = buf.readUInt16LE(cursor + 30)
    const commentLen = buf.readUInt16LE(cursor + 32)
    const localOffset = buf.readUInt32LE(cursor + 42)
    const name = buf.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8')
    cursor += 46 + nameLen + extraLen + commentLen
    if (name.endsWith('/') || (method !== 0 && method !== 8)) continue
    const rel = safeEntryPath(name)
    if (rel === undefined) continue
    const target = normalize(join(dest, ...rel.split('/')))
    if (!target.startsWith(root + sep)) continue
    const start =
      localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28)
    const raw = buf.subarray(start, start + compressedSize)
    let data: Buffer
    try {
      data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw)
    } catch {
      throw new PremiumThemeError('bad_package', '高级主题包坏了（解压失败）。')
    }
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, data)
    files += 1
  }
  return files
}

/**
 * 包解进 `dest`，回主题根目录（有 `config/settings_schema.json` 的那一层：包顶层多一层目录也认）。
 * 认不出是哪种包 / 里面没有主题 → `bad_package`。
 */
export function extractThemePackage(bytes: Uint8Array, dest: string): string {
  mkdirSync(dest, { recursive: true })
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try {
      extractTgz(bytes, dest)
    } catch {
      throw new PremiumThemeError('bad_package', '高级主题包解不开（tar.gz）。')
    }
  } else if (bytes[0] === 0x50 && bytes[1] === 0x4b) extractZip(bytes, dest)
  else throw new PremiumThemeError('bad_package', '高级主题包认不出是什么格式。')
  const has = (dir: string): boolean => existsSync(join(dir, 'config', 'settings_schema.json'))
  if (has(dest)) return dest
  const tops = readdirSync(dest).filter((n) => statSync(join(dest, n)).isDirectory())
  const inner = tops.length === 1 ? join(dest, tops[0] as string) : undefined
  if (inner !== undefined && has(inner)) return inner
  throw new PremiumThemeError(
    'bad_package',
    '高级主题包里没有主题（找不到 config/settings_schema.json）。',
  )
}
