/**
 * 会话内的出站推送（WP57）。
 *
 * 聊天的"发"不是发一封信，是**往这条会话里推一条消息**。本地档里推送的另一头
 * 就在同一个进程：工作台经 `GET /v1/chat/sessions/:id/stream` 挂一条 SSE，
 * 这里 `publish` 一下，那边就收到。托管档要做的是把这一层换成公网 SSE 端点
 * （B 期），`ChatSessionStream` 的形状不变。
 *
 * 为什么不直接复用 WP33 的 WebSocket 事件流：那条流是**按工作区**广播事件日志摘要，
 * 订阅者是"这个人的工作台"；聊天流是**按会话**推消息正文，订阅者是"坐在这条会话前面
 * 的那个访客"。两者的鉴权面与订阅粒度都不同，混在一起就意味着一个访客能挂上
 * 整个工作区的事件流。
 */
import type { ChatMessage } from './types.js'

/** 推给订阅者的一帧。`session` 帧带的是会话状态变化（接管开关、转邮件）。 */
export type ChatStreamFrame =
  | { type: 'message'; message: ChatMessage }
  | { type: 'session'; session_id: string; status: string; takeover: boolean }
  | { type: 'typing'; session_id: string; on: boolean }

export type ChatStreamListener = (frame: ChatStreamFrame) => void

export interface ChatSubscription {
  stop(): void
}

/**
 * 进程内的按会话发布订阅。
 *
 * 一条会话可以有多个订阅者（访客那一头 + 商家在沙盒页看着）。
 * 没有订阅者时 `publish` 什么都不做——**消息已经落库了**，这一层只管"推"，
 * 不管"存"，所以掉一帧不会丢消息，重新挂上去拉一次历史就补齐了。
 */
export class ChatSessionStream {
  private readonly listeners = new Map<string, Set<ChatStreamListener>>()

  subscribe(session_id: string, listener: ChatStreamListener): ChatSubscription {
    const set = this.listeners.get(session_id) ?? new Set<ChatStreamListener>()
    set.add(listener)
    this.listeners.set(session_id, set)
    return {
      stop: () => {
        set.delete(listener)
        if (set.size === 0) this.listeners.delete(session_id)
      },
    }
  }

  publish(session_id: string, frame: ChatStreamFrame): number {
    const set = this.listeners.get(session_id)
    if (set === undefined) return 0
    for (const listener of [...set]) listener(frame)
    return set.size
  }

  /** 观察面：这条会话现在有几个人挂着。 */
  subscribers(session_id: string): number {
    return this.listeners.get(session_id)?.size ?? 0
  }

  close(): void {
    this.listeners.clear()
  }
}

/** SSE 的一帧文本（`data:` 一行 JSON，空行收尾）。路由层直接写它。 */
export function sseFrame(frame: ChatStreamFrame): string {
  return `data: ${JSON.stringify(frame)}\n\n`
}
