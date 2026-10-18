/**
 * WP409（内测真机 10-18 #1）：应用内更新的**下载**要扛得住断线。
 *
 * 那天的样子：Windows 开着系统代理（Clash），点「更新」下到 2% 弹出英文原生框
 * 「JavaScript error occurred in the main process … net::ERR_CONNECTION_CLOSED」，下载就此卡死。
 * 根因在 electron-updater 6.8.9 的差分下载：自有下载站（generic）默认用「一次请求多段 Range」
 * （`multipleRangeDownloader.js`），那条路上 `response` 没挂 `error` 监听——连接一断，
 * Electron 的 `net` 流把错误抛成主进程未捕获异常（Electron 默认弹原生框），下载的 Promise 永远不回来。
 *
 * 这里四件事（先用库里现成的，库没有的才自己写）：
 * 1. 差分下载改走「一段一个请求」（`useMultipleRangeRequest: false`，库自带选项；那条路每个请求都挂了错误监听，
 *    差分失败库自己退回整包）——接线在 `main.ts` 的 `setFeedURL`。
 * 2. 主进程兜底（{@link mainProcessErrorHandler}）：未捕获异常一律不弹原生框；是 `net::ERR_*` 就交给正在跑的
 *    下载（取消这一次、按「断了」处理），别的写日志。
 * 3. {@link robustDownload}：第一次照常（差分 → 库内退整包）；断了就**不再差分**，改整包、自动重试。
 * 4. 能续传就续传：electron-updater 的整包下载失败会把临时文件删掉、下次从 0 开始（库不支持续传），
 *    所以断了以后改用 {@link downloadResumable}（带 `Range` 接着下、按 sha512 校验），下完放进 electron-updater
 *    自己的缓存目录（`pending/` + `update-info.json`，库启动时就认这份缓存），再让库「下载」一次——
 *    它校验通过直接用，不再联网。
 *
 * 不 import electron：网络、文件都是注入的，断流 / 差分失败 / 续传都能在 vitest 里跑满。
 */
import { createHash } from 'node:crypto'
import { createReadStream, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import type { Logger } from './logging.js'

/** 是不是 Chromium 网络栈报的断线类错误（`net::ERR_CONNECTION_CLOSED` 等）。 */
export function isNetError(err: unknown): boolean {
  const text =
    err instanceof Error ? `${err.message} ${err.stack ?? ''}` : typeof err === 'string' ? err : ''
  return /net::ERR_[A-Z_]+/.test(text)
}

/** 下载被我们主动叫停时抛的错（带上真正的原因，分类时按原因走）。 */
export class DownloadInterrupted extends Error {
  readonly reason: unknown
  constructor(reason: unknown) {
    super(`下载断了：${reason instanceof Error ? reason.message : String(reason)}`)
    this.name = 'DownloadInterrupted'
    this.reason = reason
  }
}

export interface MainProcessErrorOptions {
  logger: Logger
  /** 有下载正在跑时，把断线错误交给它（回 true = 接住了）。 */
  onNetError: (err: unknown) => boolean
}

/**
 * `process.on('uncaughtException', …)` 用的那个函数。挂上它，Electron 就不再弹
 * 「A JavaScript error occurred in the main process」原生框（非技术用户看到的是一屏英文）。
 * 断线类交给下载；其余照实写 ERROR 日志（诊断包里看得到），进程照常跑——和 Electron 默认行为一样，只是不弹框。
 */
export function mainProcessErrorHandler(options: MainProcessErrorOptions): (err: unknown) => void {
  const log = options.logger.child('main-guard')
  return (err) => {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err)
    if (isNetError(err)) {
      const taken = options.onNetError(err)
      log.warn('网络连接断了（主进程兜住，不弹框）', { taken, error: detail })
      return
    }
    log.error('主进程没接住的错误（已兜住，不弹框）', { error: detail })
  }
}

/** 这次失败值不值得再试（断线、超时、被重置；校验没过也再试一次整包）。 */
export function retryable(err: unknown): boolean {
  const cause = err instanceof DownloadInterrupted ? err.reason : err
  const code =
    typeof cause === 'object' && cause !== null ? (cause as { code?: unknown }).code : undefined
  const text = `${typeof code === 'string' ? code : ''} ${String(cause)}`
  if (/ENOSPC|not enough space|disk full|\b404\b|Not Found/i.test(text)) return false
  return (
    err instanceof DownloadInterrupted ||
    /net::ERR_|ECONNRESET|ECONNABORTED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENETUNREACH|socket hang up|timed out|aborted|cancelled|sha512 checksum mismatch|Received data length|Response ends|fetch failed|terminated|network error/i.test(
      text,
    )
  )
}

export interface RobustDownloadOptions {
  /**
   * electron-updater 下一次。`differential = false` = 这次不走差分（`disableDifferentialDownload`）。
   * 回下好的文件清单（库的 `downloadUpdate()` 原样）。
   */
  attempt(differential: boolean): Promise<string[]>
  /**
   * 续传（见 {@link downloadResumable}）：接着上次断的地方下完整包、校验、放进库的缓存。
   * 不给 = 这条源续不了（例如 GitHub 备用源），只能整包重下。
   */
  resume?: (() => Promise<void>) | undefined
  /** 断了以后再试几次（默认 3）。续传每次都接着上一次的进度，所以次数不用多。 */
  retries?: number
  sleep(ms: number): Promise<void>
  /** 第 n 次重试前等多久（默认 2 秒、4 秒、8 秒……封顶 30 秒）。 */
  delayMs?: (n: number) => number
  logger: Logger
}

export const DEFAULT_DOWNLOAD_RETRIES = 3

export function defaultRetryDelay(n: number): number {
  return Math.min(30_000, 2000 * 2 ** Math.max(0, n - 1))
}

/**
 * 断了不慌：第一次照常（差分，库内失败退整包）；断了改整包（能续传就续传）再试几次。
 * 不是断线类的错误（磁盘满、文件不在）不重试，原样抛给状态机按人话分类。
 */
export async function robustDownload(options: RobustDownloadOptions): Promise<string[]> {
  const log = options.logger.child('update-download')
  const retries = options.retries ?? DEFAULT_DOWNLOAD_RETRIES
  const delay = options.delayMs ?? defaultRetryDelay
  let last: unknown
  try {
    return await options.attempt(true)
  } catch (err) {
    if (!retryable(err)) throw err
    last = err
    log.warn('下载断了，改整包下载接着试', {
      error: String(err),
      resume: options.resume !== undefined,
    })
  }
  for (let n = 1; n <= retries; n += 1) {
    await options.sleep(delay(n))
    try {
      if (options.resume !== undefined) await options.resume()
      const files = await options.attempt(false)
      log.info('整包下载好了', { attempt: n, resumed: options.resume !== undefined })
      return files
    } catch (err) {
      if (!retryable(err)) throw err
      last = err
      log.warn('整包下载又断了', { attempt: n, of: retries, error: String(err) })
    }
  }
  throw last
}

// ── 续传（electron-updater 不支持，自己写；只认标准的 HTTP Range）─────────────────

/** 一次带 Range 的 GET 回来的东西（真的那份包 Electron `net.fetch`，走系统代理）。 */
export interface RangeResponse {
  status: number
  body: AsyncIterable<Uint8Array> | null
}

export type RangeFetch = (url: string, headers: Record<string, string>) => Promise<RangeResponse>

/** 续传要用的几件文件操作。 */
export interface ResumableFiles {
  size(path: string): number | undefined
  /** 以追加方式打开（没有就建）。 */
  openAppend(path: string): Promise<{
    write(chunk: Uint8Array): Promise<void>
    close(): Promise<void>
  }>
  remove(path: string): void
  rename(from: string, to: string): void
  ensureDir(dir: string): void
  writeText(path: string, text: string): void
  /** 文件的 sha512（base64，与 latest.yml 同一种写法）。 */
  sha512(path: string): Promise<string>
}

export interface ResumableOptions {
  url: string
  /** 半截文件放哪（**不能**放在库的 `pending/` 里：库失败时会清空那个目录）。 */
  partial: string
  /** latest.yml 里这个文件的 sha512（base64）。 */
  sha512: string
  /** latest.yml 里的大小（字节）；不给就以服务器说完为准。 */
  size?: number | undefined
  fetch: RangeFetch
  files: ResumableFiles
  onProgress?: (percent: number) => void
  /** 连续几次一个字节都没下到就放弃（默认 3）；有进展就重新数。 */
  maxStalls?: number
  sleep(ms: number): Promise<void>
  delayMs?: (n: number) => number
  logger: Logger
}

/** 半截文件下完、校验过，回它的路径（还是 `partial`，由调用方挪走）。 */
export async function downloadResumable(options: ResumableOptions): Promise<string> {
  const log = options.logger.child('update-resume')
  const { files, partial, size } = options
  const maxStalls = options.maxStalls ?? 3
  const delay = options.delayMs ?? defaultRetryDelay
  let stalls = 0
  for (;;) {
    let have = files.size(partial) ?? 0
    if (size !== undefined && have > size) {
      files.remove(partial)
      have = 0
    }
    if (size !== undefined && have === size) break
    let got = 0
    try {
      const res = await options.fetch(options.url, have > 0 ? { Range: `bytes=${have}-` } : {})
      if (res.status === 416 && have > 0) {
        // 服务器说「这段不存在」：手里这份不对（换了文件），从头来
        files.remove(partial)
        throw new Error('Range not satisfiable, restarting')
      }
      if (res.status === 200 && have > 0) {
        // 服务器不认 Range，回了整个文件：丢掉半截、从头写
        log.info('下载站这次没认续传，从头下', { have })
        files.remove(partial)
        have = 0
      } else if (res.status !== 206 && res.status !== 200) {
        throw new Error(`HTTP ${res.status}`)
      }
      if (have > 0) log.info('接着上次的进度下', { have, size })
      const out = await files.openAppend(partial)
      try {
        for await (const chunk of res.body ?? []) {
          await out.write(chunk)
          got += chunk.length
          if (size !== undefined && size > 0) options.onProgress?.(((have + got) / size) * 100)
        }
      } finally {
        await out.close()
      }
      if (size === undefined || have + got >= size) break
      throw new Error(`Response ends early (${have + got} of ${size})`)
    } catch (err) {
      const status = /HTTP (\d{3})/.exec(String(err))?.[1]
      const serverHiccup = status?.startsWith('5') === true
      if (!serverHiccup && !retryable(err)) throw err
      stalls = got > 0 ? 0 : stalls + 1
      if (stalls >= maxStalls) throw err
      log.warn('续传断了，等一下接着下', { have: have + got, size, error: String(err) })
      await options.sleep(delay(stalls === 0 ? 1 : stalls))
    }
  }
  const actual = await files.sha512(partial)
  if (actual !== options.sha512) {
    files.remove(partial)
    throw new Error('sha512 checksum mismatch (resumed download), discarded')
  }
  return partial
}

/**
 * 把续传下好的安装包交给 electron-updater：放进它的 `pending/`，写上它认的 `update-info.json`
 * （`DownloadedUpdateHelper.getValidCachedUpdateFile` 读的就是 `{ fileName, sha512, isAdminRightsRequired }`）。
 * 之后调一次 `downloadUpdate()`，库重新算一遍 sha512、对上了直接用，不再联网。
 */
export function placeInUpdaterCache(input: {
  files: ResumableFiles
  from: string
  pendingDir: string
  fileName: string
  sha512: string
  isAdminRightsRequired: boolean
  join: (...parts: string[]) => string
}): string {
  const { files, pendingDir } = input
  files.ensureDir(pendingDir)
  const dest = input.join(pendingDir, input.fileName)
  if (files.size(dest) !== undefined) files.remove(dest)
  files.rename(input.from, dest)
  files.writeText(
    input.join(pendingDir, 'update-info.json'),
    JSON.stringify({
      fileName: input.fileName,
      sha512: input.sha512,
      isAdminRightsRequired: input.isAdminRightsRequired,
    }),
  )
  return dest
}

/** latest.yml 里文件的 `url`（常是相对名）按更新源地址补全；安装包文件名取最后一段。 */
export function resolveUpdateFile(
  feedUrl: string,
  fileUrl: string,
): { url: string; fileName: string } {
  const url = new URL(fileUrl, feedUrl.endsWith('/') ? feedUrl : `${feedUrl}/`).href
  const last = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '')
  // 和库一样只取最后一段：服务器给的「../../x」逃不出缓存目录
  const fileName = last.replace(/[\\/]/g, '') || 'update.exe'
  return { url, fileName }
}

/** 真的那一份文件操作（Node fs；不 import electron）。 */
export function nodeResumableFiles(): ResumableFiles {
  return {
    size: (path) => {
      try {
        return statSync(path).size
      } catch {
        return undefined
      }
    },
    openAppend: async (path) => {
      const handle = await open(path, 'a')
      return {
        write: async (chunk) => {
          await handle.write(chunk)
        },
        close: () => handle.close(),
      }
    },
    remove: (path) => {
      rmSync(path, { force: true })
    },
    rename: (from, to) => {
      renameSync(from, to)
    },
    ensureDir: (dir) => {
      mkdirSync(dir, { recursive: true })
    },
    writeText: (path, text) => {
      writeFileSync(path, text, 'utf8')
    },
    sha512: (path) =>
      new Promise((resolve, reject) => {
        const hash = createHash('sha512')
        createReadStream(path)
          .on('error', reject)
          .on('data', (chunk) => hash.update(chunk))
          .on('end', () => resolve(hash.digest('base64')))
      }),
  }
}

/**
 * 给一次 GET 的响应体加「多久没来数据就算断了」（默认 60 秒）：代理吊着连接不给数据时，
 * 不至于永远停在那个百分比上。`abort()` 之后遍历抛 AbortError（{@link retryable} 认「aborted」）。
 */
export async function* idleGuard<T>(
  body: AsyncIterable<T>,
  abort: () => void,
  idleMs = 60_000,
  timers: {
    set: (fn: () => void, ms: number) => unknown
    clear: (h: unknown) => void
  } = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as never) },
): AsyncGenerator<T> {
  let handle = timers.set(abort, idleMs)
  try {
    for await (const chunk of body) {
      timers.clear(handle)
      yield chunk
      handle = timers.set(abort, idleMs)
    }
  } finally {
    timers.clear(handle)
  }
}
