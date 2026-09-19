/**
 * 与**本机**服务说话的那一层（WP119 定论 2）。
 *
 * 四条纪律，每一条都在代码里而不是在文档里：
 *
 * 1. **只认回环**。地址由 {@link localBase} 从一个端口号拼出来，调用方给不了
 *    一个完整 URL。想让这个插件去打别的服务器，没有入口。
 * 2. **令牌只往这一个地方发**。`Authorization` 只在这个文件里出现，
 *    而这个文件只 `fetch` 回环地址。
 * 3. **「没开」与「不认」要分开说**。`fetch` 直接抛（连不上）= 桌面应用没开，
 *    走排队；401 = 配对失效，让用户去重新配一次。两句话给用户的动作完全不同，
 *    混成一句「同步失败」等于什么都没说。
 * 4. **超时**。本机服务起不来的时候 `fetch` 可能吊很久，页面上那张卡不能一直转。
 */

import type {
  ExtensionHello,
  ExtensionIngestResult,
  ExtensionObservationInput,
  LocalCallResult,
  RedeemedToken,
} from './wire.js'
import { OFFLINE_MESSAGE, UNAUTHORIZED_MESSAGE } from './wire.js'

/** 打本机最多等多久。 */
export const LOCAL_TIMEOUT_MS = 8_000

/** 端口 → 基址。**只会是回环**。 */
export function localBase(port: number): string {
  return `http://127.0.0.1:${port}`
}

type FetchLike = typeof globalThis.fetch

export interface LocalClientOptions {
  port: number
  token?: string | undefined
  /** 测试注入。生产不传。 */
  fetch?: FetchLike | undefined
  timeoutMs?: number | undefined
}

/** `/v1` 那套信封：`{ ok, data }` 或 `{ ok: false, error }`。 */
interface Envelope {
  ok?: boolean
  data?: unknown
  error?: { code?: string; message?: string }
}

async function call<T>(
  options: LocalClientOptions,
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown },
): Promise<LocalCallResult<T>> {
  const doFetch = options.fetch ?? globalThis.fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? LOCAL_TIMEOUT_MS)
  try {
    const headers: Record<string, string> = {}
    if (init.body !== undefined) headers['Content-Type'] = 'application/json'
    if (options.token !== undefined) headers.Authorization = `Bearer ${options.token}`
    const response = await doFetch(`${localBase(options.port)}${path}`, {
      method: init.method,
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: controller.signal,
    })
    const text = await response.text()
    let envelope: Envelope = {}
    try {
      envelope = text === '' ? {} : (JSON.parse(text) as Envelope)
    } catch {
      envelope = {}
    }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, kind: 'unauthorized', message: UNAUTHORIZED_MESSAGE }
    }
    if (!response.ok) {
      return {
        ok: false,
        kind: 'error',
        message: envelope.error?.message ?? `本机服务回了 HTTP ${response.status}`,
      }
    }
    return { ok: true, data: envelope.data as T }
  } catch {
    // 连不上 / 超时 / 被 abort：一律当「应用没开」。回环连不上没有第二种解释。
    return { ok: false, kind: 'offline', message: OFFLINE_MESSAGE }
  } finally {
    clearTimeout(timer)
  }
}

/** 用 6 位码换一把令牌。**这一条不带令牌**（还没有呢）。 */
export function redeemPairing(
  options: Omit<LocalClientOptions, 'token'>,
  code: string,
): Promise<LocalCallResult<RedeemedToken>> {
  return call<RedeemedToken>(options, '/v1/extension/pair', { method: 'POST', body: { code } })
}

/** 问状态：这是哪个品牌、登录了没有、观测会不会上公共库。 */
export function hello(options: LocalClientOptions): Promise<LocalCallResult<ExtensionHello>> {
  return call<ExtensionHello>(options, '/v1/extension/hello', { method: 'GET' })
}

/** 报一批观测。 */
export function ingest(
  options: LocalClientOptions,
  observations: readonly ExtensionObservationInput[],
): Promise<LocalCallResult<ExtensionIngestResult>> {
  return call<ExtensionIngestResult>(options, '/v1/extension/observations', {
    method: 'POST',
    body: { observations },
  })
}
