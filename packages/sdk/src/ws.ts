/**
 * `/v1/ws` 的那几个字面量与帧类型（29 §6：TEXT / TOOL_CALL / STATE / CUSTOM）。
 *
 * 这里**没有**连接管理：重连策略、退避、心跳都是调用方的事，各家前端框架的做法差得远，
 * 包一层只会挡路。协议本身在 `openapi.json` 的 `x-asyncapi` 里。
 */

export const WS_SUBPROTOCOL = 'agentsws.v1'
export const WS_BEARER_PREFIX = 'agentsws.bearer.'

export type WsFrameType = 'TEXT' | 'TOOL_CALL' | 'STATE' | 'CUSTOM' | 'CONTROL'

/** 一条事件的摘要——**没有正文**。要正文就拿 `subject` 去 `/v1` 取。 */
export interface WsEventFrame {
  type: Exclude<WsFrameType, 'CONTROL'>
  /** 事件日志 id（ulid）；断线重连拿最后一条当 `since`。 */
  id: string
  /** 事件日志里的原始类型名，如 `approval.decided`。 */
  name: string
  at: string
  subject?: { type: string; id: string }
  run_id?: string
  trace_id?: string
}

export interface WsControlFrame {
  type: 'CONTROL'
  name: 'ready' | 'error' | 'halted' | 'dropped' | 'pong' | 'closing'
  at: string
  detail?: Record<string, unknown>
}

export type WsFrame = WsEventFrame | WsControlFrame

export type WsClientMessage =
  | { op: 'subscribe'; assignment_id: string; since?: string; types?: string[] }
  | { op: 'ping' }

/** `http(s)://host` → `ws(s)://host/v1/ws`。**凭据不进 URL**（20 §3）。 */
export function eventStreamUrl(baseUrl: string): string {
  const base = baseUrl === '' ? (globalThis.location?.origin ?? '') : baseUrl
  return `${base.replace(/^http/, 'ws')}/v1/ws`
}

/**
 * 握手要报的子协议。浏览器同源用 cookie（不给 token）；其他调用方把 bearer 放这里——
 * 子协议头是浏览器 `WebSocket` 构造函数唯一能自定义的那个头，且不进 URL。
 */
export function subscribe(token?: string): string[] {
  return token === undefined ? [WS_SUBPROTOCOL] : [WS_SUBPROTOCOL, `${WS_BEARER_PREFIX}${token}`]
}
