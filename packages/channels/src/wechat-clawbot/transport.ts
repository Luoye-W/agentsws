/**
 * ClawBot 的 HTTP 传输层（WP85）。
 *
 * 独立成一层只为一件事：**适配器能在不出网的情况下跑完整条状态机**。
 * CI 不出网（35 §2），所以测试注入一个打到 `127.0.0.1` 上假 iLink 服务器的
 * transport，或者干脆注入一个内存替身；真机上才是这里的 `fetch` 实现。
 *
 * 这一层不认识 `InboundEvent`，也不认识秘密库——它只把 JSON 搬来搬去。
 * token 从参数进来，用完就没了；**不缓存、不落日志**（13 §4.3）。
 */

import { ChannelError } from '../errors.js'
import {
  clawBotAppHeaders,
  clawBotHeaders,
  DEFAULT_LONG_POLL_TIMEOUT_MS,
  EP_GET_BOT_QRCODE,
  EP_GET_UPDATES,
  EP_QRCODE_STATUS,
  EP_SEND_MESSAGE,
  type GetUpdatesResp,
  ILINK_BASE_URL,
  ILINK_BOT_TYPE,
  type QrcodeResp,
  type QrcodeStatusResp,
  type SendMessageReq,
  type SendMessageResp,
  wechatUin,
} from './protocol.js'

/** `globalThis.fetch` 的最小形状（测试可注入）。 */
export type FetchLike = (
  input: string,
  init: {
    method: string
    headers: Record<string, string>
    body?: string
    signal?: AbortSignal
  },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

export interface ClawBotTransport {
  /** 起一次扫码：拿二维码。`local_tokens` 是本机已有的 token（官方用它认「已连过」）。 */
  qrcode(input: { base_url?: string; local_tokens?: readonly string[] }): Promise<QrcodeResp>
  /** 轮询扫码状态（GET，长轮询；超时返回 `wait` 由调用方决定要不要再来一次）。 */
  qrcodeStatus(input: {
    base_url: string
    qrcode: string
    verify_code?: string
  }): Promise<QrcodeStatusResp>
  getUpdates(input: {
    base_url: string
    token: string
    get_updates_buf: string
    timeout_ms?: number
    signal?: AbortSignal
  }): Promise<GetUpdatesResp>
  sendMessage(input: {
    base_url: string
    token: string
    body: SendMessageReq
  }): Promise<SendMessageResp>
}

export interface HttpClawBotTransportOptions {
  fetch?: FetchLike
  /** 缺省 {@link ILINK_BASE_URL}。 */
  base_url?: string
  app_id?: string
  client_version?: string
  bot_type?: string
  /** 随机源（`X-WECHAT-UIN` 用）。注入的，不裸调 `Math.random()`（35 §2）。 */
  random: () => number
  /** 普通请求超时。 */
  timeout_ms?: number
  /** `base_info.channel_version`（只作观测用，官方明写不参与鉴权与路由）。 */
  channel_version?: string
}

const DEFAULT_API_TIMEOUT_MS = 15_000

function joinUrl(base: string, endpoint: string): string {
  return new URL(endpoint, base.endsWith('/') ? base : `${base}/`).toString()
}

/**
 * uint64 的 id 在 JSON 里会被 `JSON.parse` 截精度。官方的做法是先把这几个键的
 * 值加上引号再 parse；这里照做（只改**对象键**后面的裸数字，不碰字符串里的文本）。
 */
const LOSSLESS_ID_FIELDS: ReadonlySet<string> = new Set(['message_id', 'msg_id', 'svr_id'])

export function parseLosslessJson<T>(raw: string): T {
  let out = ''
  let i = 0
  while (i < raw.length) {
    if (raw[i] !== '"') {
      out += raw[i]
      i += 1
      continue
    }
    const start = i
    i += 1
    let escaped = false
    while (i < raw.length) {
      const ch = raw[i]
      i += 1
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') break
    }
    const token = raw.slice(start, i)
    out += token
    let cursor = i
    while (/\s/.test(raw[cursor] ?? '')) cursor += 1
    if (raw[cursor] !== ':') continue
    let key: unknown
    try {
      key = JSON.parse(token)
    } catch {
      continue
    }
    if (typeof key !== 'string' || !LOSSLESS_ID_FIELDS.has(key)) continue
    out += raw.slice(i, cursor + 1)
    cursor += 1
    while (/\s/.test(raw[cursor] ?? '')) {
      out += raw[cursor]
      cursor += 1
    }
    const numberStart = cursor
    if (raw[cursor] === '-') cursor += 1
    while (/\d/.test(raw[cursor] ?? '')) cursor += 1
    if (cursor > numberStart && !(cursor === numberStart + 1 && raw[numberStart] === '-')) {
      out += `"${raw.slice(numberStart, cursor)}"`
      i = cursor
    } else {
      i = numberStart
    }
  }
  return JSON.parse(out) as T
}

export function createHttpClawBotTransport(options: HttpClawBotTransportOptions): ClawBotTransport {
  const doFetch: FetchLike =
    options.fetch ??
    ((input, init) =>
      globalThis.fetch(input, {
        method: init.method,
        headers: init.headers,
        ...(init.body === undefined ? {} : { body: init.body }),
        ...(init.signal === undefined ? {} : { signal: init.signal }),
      }))
  const defaultBase = options.base_url ?? ILINK_BASE_URL
  const baseInfo = { channel_version: options.channel_version ?? '0.0.0', bot_agent: 'agentsws' }

  const post = async (input: {
    base_url: string
    endpoint: string
    body: unknown
    token?: string
    timeout_ms: number
    signal?: AbortSignal
  }): Promise<string> => {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, input.timeout_ms)
    const external = input.signal
    const onAbort = (): void => {
      controller.abort()
    }
    external?.addEventListener('abort', onAbort, { once: true })
    try {
      const res = await doFetch(joinUrl(input.base_url, input.endpoint), {
        method: 'POST',
        headers: clawBotHeaders({
          uin: wechatUin(options.random),
          ...(input.token === undefined ? {} : { token: input.token }),
          ...(options.app_id === undefined ? {} : { app_id: options.app_id }),
          ...(options.client_version === undefined
            ? {}
            : { client_version: options.client_version }),
        }),
        body: JSON.stringify(input.body),
        signal: controller.signal,
      })
      const text = await res.text()
      if (!res.ok) {
        throw new ChannelError('provider_error', `微信接口 ${input.endpoint} 返回 ${res.status}`, {
          status: res.status,
        })
      }
      return text
    } finally {
      clearTimeout(timer)
      external?.removeEventListener('abort', onAbort)
    }
  }

  return {
    async qrcode(input) {
      const text = await post({
        base_url: input.base_url ?? defaultBase,
        endpoint: `${EP_GET_BOT_QRCODE}?bot_type=${encodeURIComponent(options.bot_type ?? ILINK_BOT_TYPE)}`,
        // 官方：获取二维码的 POST **不带** Authorization 与 base_info
        body: { local_token_list: [...(input.local_tokens ?? [])] },
        timeout_ms: options.timeout_ms ?? DEFAULT_API_TIMEOUT_MS,
      })
      return JSON.parse(text) as QrcodeResp
    },

    async qrcodeStatus(input) {
      let endpoint = `${EP_QRCODE_STATUS}?qrcode=${encodeURIComponent(input.qrcode)}`
      if (input.verify_code !== undefined && input.verify_code !== '')
        endpoint += `&verify_code=${encodeURIComponent(input.verify_code)}`
      const controller = new AbortController()
      const timer = setTimeout(() => {
        controller.abort()
      }, DEFAULT_LONG_POLL_TIMEOUT_MS)
      try {
        const res = await doFetch(joinUrl(input.base_url, endpoint), {
          method: 'GET',
          headers: clawBotAppHeaders({
            ...(options.app_id === undefined ? {} : { app_id: options.app_id }),
            ...(options.client_version === undefined
              ? {}
              : { client_version: options.client_version }),
          }),
          signal: controller.signal,
        })
        const text = await res.text()
        // 网关超时（官方注释点名 Cloudflare 524）一律当成「还在等」，继续轮询
        if (!res.ok) return { status: 'wait' }
        return JSON.parse(text) as QrcodeStatusResp
      } catch {
        return { status: 'wait' }
      } finally {
        clearTimeout(timer)
      }
    },

    async getUpdates(input) {
      const timeout = input.timeout_ms ?? DEFAULT_LONG_POLL_TIMEOUT_MS
      try {
        const text = await post({
          base_url: input.base_url,
          endpoint: EP_GET_UPDATES,
          body: { get_updates_buf: input.get_updates_buf, base_info: baseInfo },
          token: input.token,
          timeout_ms: timeout,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        })
        return parseLosslessJson<GetUpdatesResp>(text)
      } catch (e) {
        // 长轮询超时 / 外部中止都是正常出口：回一条空的，游标不动
        if (e instanceof Error && e.name === 'AbortError')
          return { ret: 0, msgs: [], get_updates_buf: input.get_updates_buf }
        throw e
      }
    },

    async sendMessage(input) {
      const text = await post({
        base_url: input.base_url,
        endpoint: EP_SEND_MESSAGE,
        body: { ...input.body, base_info: baseInfo },
        token: input.token,
        timeout_ms: options.timeout_ms ?? DEFAULT_API_TIMEOUT_MS,
      })
      return parseLosslessJson<SendMessageResp>(text)
    },
  }
}
