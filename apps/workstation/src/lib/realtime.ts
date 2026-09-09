/**
 * 工作台的实时刷新（WP33 B）。
 *
 * 一句话：**收到摘要 → 让对应的查询失效 → TanStack Query 自己重取**。
 * 推送里没有正文（服务端只推 `{ type, name, id, at, subject }`），所以这里不做任何
 * 「把推来的数据塞进缓存」的事——那会绕开 19 §3 的过滤下推，也会让前端出现
 * 与服务端算法不一致的数（29 原则 ③「数字不经模型手」的同一条精神）。
 *
 * 连不上就退回原来的做法（决定完手动 invalidate + 页面切换时重取）：
 * 浏览器插件、企业代理、老版本 Safari 都可能把 WS 拦掉，那不该让工作台变成不能用。
 */

import { subscribe as subprotocols, WS_SUBPROTOCOL, type WsFrame } from '@agentsws/sdk'
import type { QueryClient } from '@tanstack/react-query'

export type { WsFrame }
export { WS_SUBPROTOCOL }

/** 事件类型 → 要让哪些查询失效。前缀匹配，第一条命中即用。 */
const INVALIDATIONS: { prefix: string; keys: string[][] }[] = [
  // 14 审批：卡片本身、首页、岗位卡片 Tab、事项时间线（卡挂在事项上）
  { prefix: 'approval.', keys: [['deck'], ['home'], ['matter'], ['todos'], ['records']] },
  // 15 账本：记录 Tab 与首页的战报
  { prefix: 'change.', keys: [['records'], ['home'], ['matter']] },
  { prefix: 'guardrail.', keys: [['records'], ['home']] },
  // 17 运行：跑完了才有产出，跑的过程中不刷（否则一次运行刷几十遍）
  { prefix: 'run.completed', keys: [['deck'], ['home'], ['matter'], ['todos']] },
  { prefix: 'run.failed', keys: [['deck'], ['home'], ['matter']] },
  // 37 工作模型（契约里还没有这两类事件，先接上：一旦服务端开始发就自动生效）
  { prefix: 'todo.', keys: [['todos'], ['home'], ['calendar'], ['matter']] },
  { prefix: 'matter.', keys: [['matter'], ['home'], ['todos']] },
  // 25 定时与流程
  { prefix: 'schedule.', keys: [['schedules'], ['home']] },
  { prefix: 'workflow.', keys: [['schedules'], ['matter']] },
  // 28 §1 急停：整页都要重算（能不能点按钮变了）
  { prefix: 'halt.changed', keys: [['home'], ['deck'], ['positions'], ['session']] },
  // 37 §4 会议
  { prefix: 'meeting.', keys: [['meetings'], ['meeting'], ['meeting-outputs'], ['home']] },
  // WP20 连接面
  { prefix: 'connect.', keys: [['connections'], ['positions'], ['home']] },
]

/** 一帧摘要 → 要失效的 query key 前缀集合。 */
export function keysFor(name: string): string[][] {
  for (const rule of INVALIDATIONS)
    if (name === rule.prefix || name.startsWith(rule.prefix)) return rule.keys
  return []
}

export interface RealtimeOptions {
  client: QueryClient
  /** 当前岗位（31 §3.1：一次连接一个 Assignment）。 */
  assignment: string
  /**
   * bearer；浏览器里**不传**——HttpOnly 会话 cookie 握手时自带，前端根本看不到 token。
   * 普通浏览器里存过 bearer 的那条路才用得上它（`lib/api.ts` 的 `readStoredToken`）。
   */
  token?: string | undefined
  /** 换掉 WebSocket（测试）。 */
  socketFactory?: (url: string, protocols: string[]) => RealtimeSocket
  /** 换掉定时器（测试）。 */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown
  clearTimeoutFn?: (handle: unknown) => void
  /** 断线重连的退避上限，默认 30s。 */
  maxBackoffMs?: number
  /** 状态变化回调（界面上的「实时 / 已退回轮询」小点）。 */
  onStatus?: (status: RealtimeStatus) => void
}

export type RealtimeStatus = 'connecting' | 'live' | 'offline'

/** `WebSocket` 里我们用得到的那一小块（浏览器与测试替身都满足）。 */
export interface RealtimeSocket {
  send(data: string): void
  close(): void
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev: unknown) => void) | null
  onerror: ((ev: unknown) => void) | null
}

export interface RealtimeHandle {
  /** 断开并不再重连。 */
  stop(): void
  status(): RealtimeStatus
  /** 最后收到的那条事件 id（重连补拉用；也方便测试断言）。 */
  cursor(): string | undefined
}

const DEFAULT_MAX_BACKOFF = 30_000

function wsUrl(): string {
  const loc = globalThis.location
  // 同源：工作台与 `/v1` 永远是同一个来源（28 §2 唯一入口）
  const origin = loc === undefined ? '' : `${loc.protocol}//${loc.host}`
  return `${origin.replace(/^http/, 'ws')}/v1/ws`
}

/**
 * 连上事件流并把收到的摘要翻成缓存失效。
 *
 * 重连带 `since`：断线期间发生的事补拉回来，不会漏掉一张卡（28 §4 用例 4）。
 * 连不上就是 `offline`——调用方原来的手动 invalidate 一直都在，不受影响。
 */
export function connectRealtime(options: RealtimeOptions): RealtimeHandle {
  const {
    client,
    assignment,
    token,
    socketFactory,
    onStatus,
    maxBackoffMs = DEFAULT_MAX_BACKOFF,
  } = options
  const later = options.setTimeoutFn ?? ((fn, ms) => globalThis.setTimeout(fn, ms))
  const cancel =
    options.clearTimeoutFn ??
    ((h) => {
      globalThis.clearTimeout(h as number)
    })

  let socket: RealtimeSocket | undefined
  let stopped = false
  let attempt = 0
  let cursor: string | undefined
  let status: RealtimeStatus = 'connecting'
  let retryHandle: unknown

  const setStatus = (next: RealtimeStatus): void => {
    if (status === next) return
    status = next
    onStatus?.(next)
  }

  const make =
    socketFactory ??
    ((url: string, protocols: string[]): RealtimeSocket => {
      const Ctor = (globalThis as { WebSocket?: new (u: string, p: string[]) => RealtimeSocket })
        .WebSocket
      if (Ctor === undefined) throw new Error('这个浏览器没有 WebSocket')
      return new Ctor(url, protocols)
    })

  const invalidate = (name: string): void => {
    for (const key of keysFor(name)) void client.invalidateQueries({ queryKey: key })
  }

  const open = (): void => {
    if (stopped) return
    setStatus(attempt === 0 ? 'connecting' : status)
    let ws: RealtimeSocket
    try {
      ws = make(wsUrl(), subprotocols(token))
    } catch {
      // 造不出来（没有 WebSocket、被插件拦了）：直接退回轮询，不重试
      setStatus('offline')
      return
    }
    socket = ws
    ws.onopen = () => {
      attempt = 0
      setStatus('live')
      ws.send(
        JSON.stringify({
          op: 'subscribe',
          assignment_id: assignment,
          ...(cursor === undefined ? {} : { since: cursor }),
        }),
      )
    }
    ws.onmessage = (ev) => {
      let frame: WsFrame
      try {
        frame = JSON.parse(String(ev.data)) as WsFrame
      } catch {
        return
      }
      if (frame.type === 'CONTROL') {
        // 服务端说「刚才丢了几帧」：视图可能不全，整体重取一次
        if (frame.name === 'dropped') {
          void client.invalidateQueries()
        }
        return
      }
      cursor = frame.id
      invalidate(frame.name)
    }
    const retry = (): void => {
      socket = undefined
      if (stopped) return
      setStatus('offline')
      attempt += 1
      // 指数退避 + 上限；断线期间工作台照常能用（手动 invalidate 那条路一直在）
      const delay = Math.min(maxBackoffMs, 500 * 2 ** Math.min(attempt, 6))
      retryHandle = later(open, delay)
    }
    ws.onclose = retry
    ws.onerror = retry
  }

  open()

  return {
    stop() {
      stopped = true
      if (retryHandle !== undefined) cancel(retryHandle)
      socket?.close()
      socket = undefined
      setStatus('offline')
    },
    status: () => status,
    cursor: () => cursor,
  }
}
