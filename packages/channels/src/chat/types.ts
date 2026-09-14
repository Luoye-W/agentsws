/**
 * 在线聊天渠道的对象与端口（18 §2；48 §4 L3 #11 的本地部分，WP57）。
 *
 * 聊天与邮件走**同一条入站管线**（`ChannelInboundPipeline`，`channel: 'chat'`），
 * 所以这里只定义"会话与消息长什么样"和"存在哪"，去重 / 围栏 / 脱敏 / 路由 / 排队
 * 一跳都不重写。
 *
 * 出站不是"发一封信"，是**往这条会话里推一条消息**——本地档就是服务进程里的
 * 一条事件流（SSE）。公网端点、widget 脚本与 Origin 白名单属于托管档（B 期），
 * 本 WP 不做。
 */
import type { Iso8601, MaybePromise, WorkspaceId } from '@agentsws/contracts'

/**
 * 消息从哪来。本地档只有 `sandbox`（工作台的聊天沙盒页）；
 * 托管档会加 `widget`（网站聊天窗）。它是会话唯一键的一部分，
 * 所以沙盒会话与真访客会话天然不会撞。
 */
export type ChatSource = 'sandbox' | 'widget'

export type ChatMessageRole = 'visitor' | 'agent' | 'operator' | 'system'

/**
 * 一条会话。
 *
 * 唯一键 `(workspace_id, source, external_session_id)`——同一个访客刷新页面
 * 带着同一个 `external_session_id` 回来，接着上一条会话说，不另起一条。
 */
export interface ChatSession {
  id: string
  workspace_id: WorkspaceId
  source: ChatSource
  external_session_id: string
  /** 访客的外部身份（沙盒里是操作者自己；托管档是 widget 生成的匿名 id）。 */
  visitor_id: string
  visitor_display?: string
  /** 访客留下的邮箱（超时转邮件跟进要用它）。 */
  visitor_email?: string
  /** `support-core` 的 `ChatSessionStatus`；本包不解释它的语义，只存。 */
  status: string
  /** 事项上钉的那条 thread ref 的外部 id（与邮件线程同一套钉法）。 */
  thread_external_id: string
  created_at: Iso8601
  updated_at: Iso8601
  /** 访客最后一次露面（心跳或说话）。求助超时判"人还在不在"用它。 */
  last_seen_at?: Iso8601
  /** 求助是什么时候提的（T+3 / T+10 两个钟点从它算）。 */
  assist_requested_at?: Iso8601
  /** 已经提醒过的时刻（提醒的幂等锚）。 */
  assist_reminded_at?: Iso8601
  /** 人工接管开关。开着的时候 AI 一句都不答。 */
  takeover: boolean
}

export interface ChatMessage {
  id: string
  session_id: string
  workspace_id: WorkspaceId
  role: ChatMessageRole
  /**
   * 正文。
   *
   * **访客消息存的是原文**（未围栏）：围栏是进模型那一路的事，管线会做；
   * 时间线与沙盒页要给人看，围栏标记不该出现在屏幕上。
   */
  text: string
  at: Iso8601
  /** 外部消息 id（去重键的后半段）。 */
  external_id: string
  /** 这条是哪次运行产生的（AI 回复才有）。 */
  run_id?: string
  /** 这条 AI 回复用的是哪个计划动作（沙盒页上要显示）。 */
  plan_action?: string
}

/** 建会话的入参。`id` 由 store 生成（同一唯一键重复建 = 拿回原来那条）。 */
export interface ChatSessionInput {
  workspace_id: WorkspaceId
  source: ChatSource
  external_session_id: string
  visitor_id: string
  visitor_display?: string
  at: Iso8601
}

/** 可以改的那几格（状态机的合法性由 `support-core` 判，本包只存）。 */
export interface ChatSessionPatch {
  status?: string
  takeover?: boolean
  visitor_email?: string
  last_seen_at?: Iso8601
  /** 显式传 `null` 表示清空（求助被接了 / 会话关了）。 */
  assist_requested_at?: Iso8601 | null
  assist_reminded_at?: Iso8601 | null
  at: Iso8601
}

/**
 * 会话与消息的落库口。
 *
 * 两档实现（内存 / SQLite）跑同一份一致性套件——同邮件渠道的纪律。
 */
export interface ChatStore {
  /** 按唯一键取或建。**幂等**：同一键调两次拿到同一条。 */
  ensureSession(input: ChatSessionInput): MaybePromise<ChatSession>
  getSession(id: string): MaybePromise<ChatSession | undefined>
  findSession(
    workspace_id: WorkspaceId,
    source: ChatSource,
    external_session_id: string,
  ): MaybePromise<ChatSession | undefined>
  /** 按线程外部 id 找（出站要靠它找到会话，同邮件的收件人门禁思路）。 */
  findByThread(thread_external_id: string): MaybePromise<ChatSession | undefined>
  listSessions(
    workspace_id: WorkspaceId,
    filter?: { status?: string[]; limit?: number },
  ): MaybePromise<ChatSession[]>
  patchSession(id: string, patch: ChatSessionPatch): MaybePromise<ChatSession>
  /** 追加一条消息。同 `(session_id, external_id)` 重复追加只留一条。 */
  appendMessage(input: Omit<ChatMessage, 'id'>): MaybePromise<ChatMessage>
  listMessages(session_id: string, filter?: { limit?: number }): MaybePromise<ChatMessage[]>
  /** 21 §4 随主体删除：这个访客的会话与消息一起清掉。 */
  eraseVisitor(visitor_id: string): MaybePromise<number>
  close?(): void
}

/** 适配器收到的那一条原始载荷（`ChannelAdapter.toInbound` 的 `raw`）。 */
export interface RawChatMessage {
  session_id: string
  external_id: string
  visitor_id: string
  visitor_display?: string
  text: string
  at: Iso8601
}

/** 18 §2.2 去重键：会话 + 消息 id。 */
export function chatDedupeKey(session_id: string, external_id: string): string {
  return `chat:${session_id}:${external_id}`
}

/** 会话的线程外部 id（事项钉的就是它，与邮件线程同一套 `thread` ref）。 */
export function chatThreadExternalId(session_id: string): string {
  return `chat-thread:${session_id}`
}
