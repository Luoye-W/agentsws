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
  PanelFillInput,
  PanelFillResult,
  PanelOpenInput,
  PanelOpenResult,
  PanelSentInput,
  PanelSkipInput,
  PanelSkipResult,
  PanelSnapshot,
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
  init: { method: 'GET' | 'POST' | 'PUT'; body?: unknown },
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

/**
 * WP432：**没配对**也问一声工坊文件夹里是哪一版（不带令牌，只回版本号）——没配上也跟着工坊更新。
 * 老的本机服务没有这一条：当成「不是桌面版」，什么都不做。
 */
export function probeVersion(
  options: Omit<LocalClientOptions, 'token'>,
  version: string,
): Promise<LocalCallResult<{ folder_version?: string }>> {
  return call<{ folder_version?: string }>(options, '/v1/extension/version/probe', {
    method: 'POST',
    body: { version },
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

/* ── WP413：常驻侧边栏（`/v1/extension/panel*`）。令牌仍然只在这个文件里出现 ──────────── */

/** 侧边栏一屏：进度 / 要你处理 / 记录。 */
export function panelSnapshot(
  options: LocalClientOptions,
): Promise<LocalCallResult<PanelSnapshot>> {
  return call<PanelSnapshot>(options, '/v1/extension/panel', { method: 'GET' })
}

const panelCardPath = (id: string, verb: 'fill' | 'skip'): string =>
  `/v1/extension/panel/cards/${encodeURIComponent(id)}/${verb}`

/** 在插件里批这张卡（改过就按改过的）并马上交给插件填进页面。 */
export function panelFill(
  options: LocalClientOptions,
  id: string,
  input: PanelFillInput,
): Promise<LocalCallResult<PanelFillResult>> {
  return call<PanelFillResult>(options, panelCardPath(id, 'fill'), { method: 'POST', body: input })
}

/** 不发（驳回这张卡）。WP445：写了理由，同类的可能一并不发了（回执里带 `followed`）。 */
export function panelSkip(
  options: LocalClientOptions,
  id: string,
  input: PanelSkipInput,
): Promise<LocalCallResult<PanelSkipResult>> {
  return call<PanelSkipResult>(options, panelCardPath(id, 'skip'), { method: 'POST', body: input })
}

/** WP445：撤回「同类的也一并不发了」那几张（放回「等你发」）。 */
export function panelFollowUndo(
  options: LocalClientOptions,
  leader: string,
  ids: readonly string[],
): Promise<LocalCallResult<{ restored: number }>> {
  return call<{ restored: number }>(
    options,
    `/v1/extension/panel/cards/${encodeURIComponent(leader)}/follow/undo`,
    { method: 'POST', body: { ids: [...ids] } },
  )
}

/** WP419：交给你发的社媒帖子，回「发好了」（可带那一条的链接）/「不发了」。 */
export function panelPostAnswer(
  options: LocalClientOptions,
  id: string,
  answer: 'done' | 'skip',
  input: { link?: string; reason?: string },
): Promise<LocalCallResult<{ ok: true }>> {
  return call<{ ok: true }>(
    options,
    `/v1/extension/panel/posts/${encodeURIComponent(id)}/${answer}`,
    {
      method: 'POST',
      body: input,
    },
  )
}

/** 没发出去的那一条再填一次。 */
export function panelRefill(
  options: LocalClientOptions,
  job: string,
): Promise<LocalCallResult<PanelFillResult>> {
  return call<PanelFillResult>(
    options,
    `/v1/extension/panel/writes/${encodeURIComponent(job)}/refill`,
    { method: 'POST', body: {} },
  )
}

/**
 * WP432：人在侧边栏里点「打开这一条」（改过就带改过的字）——回交给插件的那一件活（插件在当前窗口新开标签页填好）。
 */
export function panelOpen(
  options: LocalClientOptions,
  job: string,
  input: PanelOpenInput,
): Promise<LocalCallResult<PanelOpenResult>> {
  return call<PanelOpenResult>(
    options,
    `/v1/extension/panel/writes/${encodeURIComponent(job)}/open`,
    { method: 'POST', body: input },
  )
}

/** WP432：侧边栏里点「不发了」。 */
export function panelDrop(
  options: LocalClientOptions,
  job: string,
  reason?: string,
): Promise<LocalCallResult<{ ok: true }>> {
  return call<{ ok: true }>(options, `/v1/extension/panel/writes/${encodeURIComponent(job)}/drop`, {
    method: 'POST',
    body: reason === undefined ? {} : { reason },
  })
}

/**
 * WP467：人在 Reddit 上自己发出去了（插件在原帖页认出来的 / 贴的链接 / 认最近一条）——记成「已记录」。
 * 本机服务再核一遍（这个帖子里、文本相近、同一条不记两次）。
 */
export function panelSent(
  options: LocalClientOptions,
  job: string,
  input: PanelSentInput,
): Promise<LocalCallResult<PanelFillResult>> {
  return call<PanelFillResult>(
    options,
    `/v1/extension/panel/writes/${encodeURIComponent(job)}/sent`,
    { method: 'POST', body: input },
  )
}
