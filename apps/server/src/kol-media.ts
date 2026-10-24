/**
 * WP502（决策 1760 B）：红人图片的**本机缓存**——头像、横幅、近期作品封面。
 *
 * 为什么要它：工作台的壳只加载同源图片（`img-src 'self' blob: data:`，见 `apps/desktop/src/csp.ts`），
 * 存入红人池时记下的是平台 CDN 上的地址，界面上一张都画不出来。这里在「存入红人池」（插件按钮与 ego 自动存入
 * 同一个入口）那一刻由本机服务把这几张图下载到这个品牌的数据目录，界面经 `GET /v1/kol/media/<id>` 同源取——
 * **壳的安全设置一个字不放开**。
 *
 * 几条闸（任何一条不过就不存，存入红人池本身不受影响）：
 * - **只认平台图片域名**（{@link KOL_MEDIA_HOSTS}，https）；跳转之后落到别处也不认；
 * - **只认四种位图**（JPEG / PNG / WebP / GIF，按文件头认，不信对方说的类型；SVG 一律不收——它能带脚本）；
 * - **单张上限** {@link KOL_MEDIA_MAX_BYTES}，超了就停；单张 {@link KOL_MEDIA_TIMEOUT_MS} 毫秒取不完就算了；
 * - 失败只记一行日志，不重试、不报错：这些图是「认得出人」的加分项，不是存入的先决条件。
 *
 * 同一个地址只存一份（id = 地址的 sha256 前 32 位）。文件放在 `<品牌数据目录>/kol-media/` 下；
 * 没有数据目录（测试 / 一次性进程）就放内存。**下载器是装配时给的**：只有真正的服务进程给（`index.ts`），
 * 测试给本地假响应——从不在测试里去真网站取图。
 *
 * WP505：生产的下载器认系统代理（`kol-media-fetch.ts`，决策 1770 B）；缓存记着每张多大、最后一次用是什么时候，
 * 由 `kol-media-janitor.ts` 清掉没人再引用的、超了总量上限按最久没用的先删（决策 1771 B）。
 */
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

/** WP502：缓存几张近期作品封面（= 红人详情格子里露出来的那几张）。WP505 清理按同一个数认「还在用」。 */
export const KOL_MEDIA_RECENT_COVERS = 6

/** 单张上限：3 MB（横幅最大的那种也就几百 KB）。 */
export const KOL_MEDIA_MAX_BYTES = 3 * 1024 * 1024
/** 单张最多等多久。 */
export const KOL_MEDIA_TIMEOUT_MS = 15_000

/**
 * 认的图片域名（后缀匹配）：YouTube（`yt3.ggpht.com` / `yt3.googleusercontent.com` / `i.ytimg.com`）、
 * Instagram（`*.cdninstagram.com` / `*.fbcdn.net`）、TikTok（`*.tiktokcdn.com` 及分区域名、`*.ibyteimg.com`）。
 */
export const KOL_MEDIA_HOSTS: readonly string[] = [
  'ggpht.com',
  'googleusercontent.com',
  'ytimg.com',
  'cdninstagram.com',
  'fbcdn.net',
  'tiktokcdn.com',
  'tiktokcdn-us.com',
  'tiktokcdn-eu.com',
  'ibyteimg.com',
]

const TYPES: readonly { ext: string; type: string; is(b: Uint8Array): boolean }[] = [
  { ext: 'jpg', type: 'image/jpeg', is: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    ext: 'png',
    type: 'image/png',
    is: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  },
  {
    ext: 'gif',
    type: 'image/gif',
    is: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38,
  },
  {
    ext: 'webp',
    type: 'image/webp',
    is: (b) =>
      b[0] === 0x52 &&
      b[1] === 0x49 &&
      b[2] === 0x46 &&
      b[3] === 0x46 &&
      b[8] === 0x57 &&
      b[9] === 0x45 &&
      b[10] === 0x42 &&
      b[11] === 0x50,
  },
]

/** 下载那一跳的形状（`globalThis.fetch` 的子集；测试给假的）。 */
export type KolMediaFetch = (
  url: string,
  init: { signal: AbortSignal; redirect: 'follow'; headers: Record<string, string> },
) => Promise<{
  ok: boolean
  status: number
  url?: string
  headers: { get(name: string): string | null }
  body: ReadableStream<Uint8Array> | null
}>

export interface KolMediaCache {
  /**
   * 把这几张图下载缓存下来（已经有的跳过；同一个地址同时只取一次）。**永远不抛**：
   * 取不到的那张就是没有，界面照旧一个字 / 色块。
   */
  cache(urls: readonly (string | undefined)[]): Promise<void>
  /** 这个外站地址缓存到了没有：有就回本机同源地址（`/v1/kol/media/<id>`）。 */
  localUrlOf(url: string | undefined): string | undefined
  /** 按 id 读一张（路由那一跳用）。读一次算「用过」一次（清理时按最久没用的先删）。 */
  read(id: string): { bytes: Uint8Array; content_type: string } | undefined
  /**
   * WP505（决策 1771 B）：缓存里现有的每一张——多大、最后一次用（存下或被看）是什么时候。
   * 给清理那一跳（`kol-media-janitor.ts`）用。
   */
  entries(): KolMediaEntry[]
  /** WP505：删掉一张（只删缓存的图，红人数据一个字不动）。没有就当删过了。 */
  remove(id: string): void
}

/** 缓存里的一张（WP505 清理用）。 */
export interface KolMediaEntry {
  id: string
  bytes: number
  /** 最后一次用（存下或被看）的毫秒时间戳。 */
  last_used_ms: number
}

/** 被看的时候多久才改一次文件时间（落盘那一档靠文件时间记「最后一次用」，重启后照样认得）。 */
const TOUCH_EVERY_MS = 60 * 60 * 1000

export interface KolMediaCacheOptions {
  /** 落盘目录（`<品牌数据目录>/kol-media`）。不给 = 放内存。 */
  dir?: string | undefined
  /** 下载器。不给 = **不下载**（`localUrlOf` 只认已经存下的）。 */
  fetch?: KolMediaFetch | undefined
  maxBytes?: number
  timeoutMs?: number
  log?: (line: string) => void
  /** WP505：新存下一张之后叫一声（清理那一跳据此看看是不是超了总量上限）。 */
  onStored?: () => void
  /** 现在几点（毫秒；测试给假的）。 */
  now?: () => number
}

/** 外站地址 → id（sha256 前 32 位十六进制）。 */
export const kolMediaIdOf = (url: string): string =>
  createHash('sha256').update(url).digest('hex').slice(0, 32)

/** 这个地址是不是认的平台图片（https + 域名在白名单里）。 */
export function isKolMediaUrl(url: string | undefined): url is string {
  if (url === undefined || url === '' || url.length > 2000) return false
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.protocol !== 'https:' || u.username !== '' || u.password !== '') return false
  return KOL_MEDIA_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`))
}

const typeOfBytes = (b: Uint8Array): (typeof TYPES)[number] | undefined =>
  b.length < 12 ? undefined : TYPES.find((t) => t.is(b))

export function createKolMediaCache(options: KolMediaCacheOptions = {}): KolMediaCache {
  const maxBytes = options.maxBytes ?? KOL_MEDIA_MAX_BYTES
  const timeoutMs = options.timeoutMs ?? KOL_MEDIA_TIMEOUT_MS
  const now = options.now ?? Date.now
  const memory = new Map<string, { bytes: Uint8Array; content_type: string }>()
  /** id → 扩展名（落盘档；启动时扫一遍目录）。 */
  const onDisk = new Map<string, string>()
  /** WP505：id → 多大、最后一次用（落盘档启动时按文件大小与修改时间认）。 */
  const usage = new Map<string, { bytes: number; last_used_ms: number }>()
  const inFlight = new Map<string, Promise<void>>()

  if (options.dir !== undefined && existsSync(options.dir)) {
    for (const name of readdirSync(options.dir)) {
      const m = name.match(/^([a-f0-9]{32})\.(jpg|png|gif|webp)$/)
      if (m?.[1] === undefined || m[2] === undefined) continue
      onDisk.set(m[1], m[2])
      try {
        const st = statSync(join(options.dir, name))
        usage.set(m[1], { bytes: st.size, last_used_ms: st.mtimeMs })
      } catch {
        usage.set(m[1], { bytes: 0, last_used_ms: 0 })
      }
    }
  }

  const has = (id: string): boolean => memory.has(id) || onDisk.has(id)

  const put = (id: string, bytes: Uint8Array, t: (typeof TYPES)[number]): void => {
    if (options.dir === undefined) memory.set(id, { bytes, content_type: t.type })
    else {
      mkdirSync(options.dir, { recursive: true })
      writeFileSync(join(options.dir, `${id}.${t.ext}`), bytes)
      onDisk.set(id, t.ext)
    }
    usage.set(id, { bytes: bytes.length, last_used_ms: now() })
    options.onStored?.()
  }

  /** 被看了一次：记「最后一次用」；落盘的隔一阵改一次文件时间（重启后还认得）。 */
  const touch = (id: string): void => {
    const u = usage.get(id)
    if (u === undefined) return
    const t = now()
    const stale = t - u.last_used_ms >= TOUCH_EVERY_MS
    u.last_used_ms = Math.max(u.last_used_ms, t)
    const ext = onDisk.get(id)
    if (!stale || ext === undefined || options.dir === undefined) return
    try {
      const at = new Date(t)
      utimesSync(join(options.dir, `${id}.${ext}`), at, at)
    } catch {
      // 改不了文件时间就只记在内存里
    }
  }

  /** 读到上限为止；超了回 `undefined`。 */
  const readCapped = async (
    body: ReadableStream<Uint8Array> | null,
  ): Promise<Uint8Array | undefined> => {
    if (body === null) return undefined
    const reader = body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined)
        return undefined
      }
      chunks.push(value)
    }
    const out = new Uint8Array(total)
    let at = 0
    for (const c of chunks) {
      out.set(c, at)
      at += c.length
    }
    return out
  }

  const fetchOne = async (url: string, id: string): Promise<void> => {
    const fetcher = options.fetch
    if (fetcher === undefined) return
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await fetcher(url, {
        signal: ctrl.signal,
        redirect: 'follow',
        headers: { accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9' },
      })
      // 跳转之后落到白名单以外的域名：不认
      if (!res.ok || (res.url !== undefined && res.url !== '' && !isKolMediaUrl(res.url))) {
        options.log?.(`红人图片：没缓存（HTTP ${String(res.status)}）`)
        await res.body?.cancel().catch(() => undefined)
        return
      }
      const declared = Number(res.headers.get('content-length') ?? '0')
      if (Number.isFinite(declared) && declared > maxBytes) {
        options.log?.('红人图片：没缓存（太大）')
        await res.body?.cancel().catch(() => undefined)
        return
      }
      const bytes = await readCapped(res.body)
      if (bytes === undefined) {
        options.log?.('红人图片：没缓存（太大或是空的）')
        return
      }
      const t = typeOfBytes(bytes)
      if (t === undefined) {
        options.log?.('红人图片：没缓存（不是 JPEG / PNG / WebP / GIF）')
        return
      }
      put(id, bytes, t)
    } catch (err) {
      options.log?.(
        `红人图片：没缓存（${err instanceof Error && err.name === 'AbortError' ? '超时' : '取不到'}）`,
      )
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    async cache(urls) {
      const jobs: Promise<void>[] = []
      for (const url of new Set(urls)) {
        if (!isKolMediaUrl(url)) continue
        const id = kolMediaIdOf(url)
        if (has(id)) continue
        const running = inFlight.get(id)
        if (running !== undefined) {
          jobs.push(running)
          continue
        }
        // 一张一张来（最多十几张）：不在别人的 CDN 上开一排并发
        const job = (async () => {
          await Promise.all(jobs)
          await fetchOne(url, id)
        })().finally(() => inFlight.delete(id))
        inFlight.set(id, job)
        jobs.push(job)
      }
      await Promise.all(jobs)
    },
    localUrlOf(url) {
      if (!isKolMediaUrl(url)) return undefined
      const id = kolMediaIdOf(url)
      return has(id) ? `/v1/kol/media/${id}` : undefined
    },
    read(id) {
      if (!/^[a-f0-9]{32}$/.test(id)) return undefined
      const hit = memory.get(id)
      if (hit !== undefined) {
        touch(id)
        return hit
      }
      const ext = onDisk.get(id)
      if (ext === undefined || options.dir === undefined) return undefined
      const t = TYPES.find((x) => x.ext === ext)
      if (t === undefined) return undefined
      try {
        const out = {
          bytes: new Uint8Array(readFileSync(join(options.dir, `${id}.${ext}`))),
          content_type: t.type,
        }
        touch(id)
        return out
      } catch {
        return undefined
      }
    },
    entries() {
      return [...usage].map(([id, u]) => ({ id, bytes: u.bytes, last_used_ms: u.last_used_ms }))
    },
    remove(id) {
      if (!/^[a-f0-9]{32}$/.test(id)) return
      memory.delete(id)
      usage.delete(id)
      const ext = onDisk.get(id)
      onDisk.delete(id)
      if (ext === undefined || options.dir === undefined) return
      try {
        unlinkSync(join(options.dir, `${id}.${ext}`))
      } catch {
        // 已经不在了
      }
    },
  }
}
