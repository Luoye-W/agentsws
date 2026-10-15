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
  ActionDownloadInput,
  ActionEvidenceInput,
  ActionEvidenceReceipt,
  ActionJobView,
  ActionNextResponse,
  ActionPlatform,
  ActionProgressInput,
  ActionProgressResponse,
  ActionResultInput,
  ActionSheetResponse,
  AdsAccountHint,
  AdsActionSettings,
  RedditReadNextResponse,
  RedditReadResultInput,
} from '@agentsws/browser-action'
import { formatAdsAccountHints } from '@agentsws/browser-action'
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

/**
 * WP345：报自己正在跑的版本、问工坊文件夹里是哪一版（每分钟一次；重载后带上从哪版换来）。
 * 老的本机服务没有这一条（501）：当成「不是桌面版」，什么都不做。
 */
export function reportVersion(
  options: LocalClientOptions,
  input: { version: string; reloaded_from?: string; gave_up?: string },
): Promise<LocalCallResult<{ folder_version?: string }>> {
  return call<{ folder_version?: string }>(options, '/v1/extension/version', {
    method: 'POST',
    body: input,
  })
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

/* ── WP313：广告动作通道（`/v1/extension/actions/*`）。令牌仍然只在这个文件里出现 ── */

/** 长轮询挂多久（秒）。本机服务那边最多挂 25 秒。 */
export const ACTION_POLL_WAIT_S = 25

/** 领活。超时比挂的时间长 10 秒（挂满了正常回来，不算「应用没开」）。 */
export function actionsNext(
  options: LocalClientOptions,
  platforms: readonly ActionPlatform[],
  waitSeconds: number = ACTION_POLL_WAIT_S,
  /** WP348：开着的广告后台里认出的账户（配置卡方案用；空就不带）。 */
  seen: readonly AdsAccountHint[] = [],
): Promise<LocalCallResult<ActionNextResponse>> {
  const accounts = formatAdsAccountHints(seen)
  const q = `platforms=${platforms.map(encodeURIComponent).join(',')}&wait=${waitSeconds}${
    accounts === '' ? '' : `&accounts=${encodeURIComponent(accounts)}`
  }`
  return call<ActionNextResponse>(
    {
      ...options,
      timeoutMs: Math.max(options.timeoutMs ?? LOCAL_TIMEOUT_MS, (waitSeconds + 10) * 1000),
    },
    `/v1/extension/actions/next?${q}`,
    { method: 'GET' },
  )
}

const actionPath = (id: string, tail: string): string =>
  `/v1/extension/actions/${encodeURIComponent(id)}/${tail}`

export function actionSheet(
  options: LocalClientOptions,
  id: string,
): Promise<LocalCallResult<ActionSheetResponse>> {
  return call<ActionSheetResponse>(
    { ...options, timeoutMs: Math.max(options.timeoutMs ?? LOCAL_TIMEOUT_MS, 60_000) },
    actionPath(id, 'sheet'),
    { method: 'GET' },
  )
}

export function actionProgress(
  options: LocalClientOptions,
  id: string,
  input: ActionProgressInput,
): Promise<LocalCallResult<ActionProgressResponse>> {
  return call<ActionProgressResponse>(options, actionPath(id, 'progress'), {
    method: 'POST',
    body: input,
  })
}

export function actionEvidence(
  options: LocalClientOptions,
  id: string,
  input: ActionEvidenceInput,
): Promise<LocalCallResult<ActionEvidenceReceipt>> {
  return call<ActionEvidenceReceipt>(
    { ...options, timeoutMs: Math.max(options.timeoutMs ?? LOCAL_TIMEOUT_MS, 30_000) },
    actionPath(id, 'evidence'),
    { method: 'POST', body: input },
  )
}

export function actionDownload(
  options: LocalClientOptions,
  id: string,
  input: ActionDownloadInput,
): Promise<LocalCallResult<{ recorded: true }>> {
  return call<{ recorded: true }>(options, actionPath(id, 'download'), {
    method: 'POST',
    body: input,
  })
}

export function actionResult(
  options: LocalClientOptions,
  id: string,
  input: ActionResultInput,
): Promise<LocalCallResult<ActionJobView>> {
  return call<ActionJobView>(options, actionPath(id, 'result'), { method: 'POST', body: input })
}

/** 连接广告时勾了「看过风险告知，同意」（决策 562）。 */
export function adsConsent(
  options: LocalClientOptions,
  input: { platform: ActionPlatform; text_version: string },
): Promise<LocalCallResult<AdsActionSettings>> {
  return call<AdsActionSettings>(options, '/v1/extension/ads-consent', {
    method: 'POST',
    body: input,
  })
}

/* ── WP328：Reddit 只读（每日巡查）────────────────────────────────────── */

/** 来问有没有要读的（`connected` = 插件里连上 Reddit 了）。 */
export function redditNext(
  options: LocalClientOptions,
  connected: boolean,
): Promise<LocalCallResult<RedditReadNextResponse>> {
  return call<RedditReadNextResponse>(
    options,
    `/v1/extension/reddit/next?connected=${connected ? '1' : '0'}`,
    { method: 'GET' },
  )
}

/** 读完交回（没登录 / 号不对 / 被拦也照实交）。 */
export function redditResult(
  options: LocalClientOptions,
  id: string,
  input: RedditReadResultInput,
): Promise<LocalCallResult<{ accepted: true }>> {
  return call<{ accepted: true }>(
    { ...options, timeoutMs: Math.max(options.timeoutMs ?? LOCAL_TIMEOUT_MS, 30_000) },
    `/v1/extension/reddit/${encodeURIComponent(id)}/result`,
    { method: 'POST', body: input },
  )
}
