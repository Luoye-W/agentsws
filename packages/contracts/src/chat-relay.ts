/**
 * 聊天转发器（WP124 / docs/74）的对外形状。
 *
 * WP164：这一份是开源侧与官方托管转发器之间的约定——
 * - 长连接协议（商家本机 / 托管实例 ↔ 转发器）：{@link RelayClientFrame} / {@link RelayServerFrame}；
 * - owner 面（`/v1/chat/relay/*`，带工作区令牌）；
 * - 访客面（`/relay/{workspace}/…`，网站上的挂件在用，不认工作区令牌）；
 * - 客服增值服务的订阅（`/v1/support/subscription`）。
 *
 * 协议那几个类型原先写在 `packages/chat-relay/src/protocol.ts`，现在挪到这里，
 * 那边原名重导出（`ClientFrame` = {@link RelayClientFrame}，`RelayFrame` = {@link RelayServerFrame}）。
 */
import type { Iso8601 } from './common.js'
import type { HostedInstanceStatus } from './hosted.js'
import type { SubscriptionStatus } from './subscription.js'

/* ------------------------------------------------------------------ */
/* 长连接协议（`GET /relay/{workspace}/connect`，WebSocket）             */
/* ------------------------------------------------------------------ */

/** 配对失败的判定不做区分提示：密钥错与工作区不存在是同一句话。 */
export type HelloRejectReason = 'bad_pairing' | 'version_mismatch'

/** 商家本机 / 托管实例握手时带的身份。 */
export type RelayPeerKind = 'server' | 'hosted'

/** 挂件外观（转发器唯一会替商家存的东西——不是对话正文，是让挂件能画出来的那几格）。 */
export interface RelayWidgetConfig {
  enabled: boolean
  accent: string
  greeting: string
  /** 来源白名单（**空 = 全拒**，同 apps/server 那四道门；由本机随 hello/config 推上来）。 */
  allowed_origins?: string[]
  /** 挂件位置与界面语言（外观预设；原样透传给挂件）。 */
  position?: 'left' | 'right'
  language?: 'auto' | 'zh' | 'en'
  /** 商家自己在设置页试聊：不计对话数（AI 费用照算，那在本机那一侧）。 */
  trial?: boolean
}

/** 对面（本机 / 托管实例）→ 转发器。 */
export type RelayClientFrame =
  | {
      type: 'hello'
      protocol_version: number
      workspace: string
      pairing: string
      peer: RelayPeerKind
      config?: RelayWidgetConfig
    }
  | {
      type: 'config'
      config: RelayWidgetConfig
    }
  | {
      type: 'reply'
      /** 会话键（转发器在 `visit` 里给的）。 */
      session: string
      /** 这一轮的编号（转发器在 `visit` 里给的）。 */
      turn: string
      message_id: string
      text: string
    }
  | {
      /**
       * 话轮之外的插话（比如教 AI 的那句改写，访客上一条消息的回复已经发过了）。
       * 与 `reply` 分开是刻意的：「一次话轮恰好一条回复」的账本只认 `reply`；
       * `note` 不占话轮、不冲账，转发器原样递给访客流。
       */
      type: 'note'
      session: string
      message_id: string
      text: string
    }
  | { type: 'typing'; session: string; active: boolean }
  | { type: 'pull_offline' }
  | { type: 'ping' }

/** 一条暂存的访客留言（密文原样给；只有商家本机有开箱的钥匙）。 */
export interface RelayOfflineItem {
  id: string
  sealed: string
  created_at: Iso8601
}

/** 转发器 → 对面。 */
export type RelayServerFrame =
  | { type: 'hello_ok'; protocol_version: number; heartbeat_ms: number; peer: RelayPeerKind }
  | { type: 'hello_err'; reason: HelloRejectReason; supported_versions: number[] }
  | {
      type: 'visit'
      session: string
      turn: string
      visitor_id: string
      display?: string
      text: string
      /** 页面上下文（72 §6.6 #4）：只留 host + pathname 与商品信息，不采 query。 */
      page?: { host: string; path: string; product?: string }
    }
  | { type: 'visitor_typing'; session: string; active: boolean }
  | {
      type: 'offline_batch'
      items: RelayOfflineItem[]
    }
  | { type: 'pong' }
  | { type: 'error'; code: string; message: string }

/* ------------------------------------------------------------------ */
/* owner 面（`/v1/chat/relay/*`，工作区令牌）                            */
/* ------------------------------------------------------------------ */

/** `POST /v1/chat/relay/pairing`：两把钥匙**只给这一次**（再要就是 409 `already_issued`）。 */
export interface RelayPairingIssued {
  /** `prk_…`：本机握手时的配对密钥。 */
  pairing_token: string
  /** `mkk_…`：本机拉走访客留言时开箱用。 */
  message_key: string
  workspace: string
}

/** 站内提醒（owner 的「额度用到 80% / 到顶」）。 */
export interface RelayNotification {
  type: 'quota_warn_80' | 'quota_full'
  at: Iso8601
  message_zh: string
  count: number
  limit: number
}

/** `GET /v1/chat/relay/status`。 */
export interface RelayOwnerStatus {
  workspace: string
  conversations_this_month: number
  /** 免费档的月上限；订阅了就没有这一格。 */
  limit?: number
  subscribed: boolean
  peer_online: boolean
  /** 现在接访客的是哪一边（没有对端在线就没有这一格）。 */
  peer_kind?: RelayPeerKind
  /** 本机与托管各在不在（两格并存时访客消息给托管那一格）。 */
  peers: RelayPeerKind[]
  /** 托管实例的状态（开通过才有）。 */
  hosted?: HostedInstanceStatus
  /** 问托管对象没问到时的一句话。 */
  hosted_error?: string
  offline_messages: number
  notifications: RelayNotification[]
}

/** `POST /v1/chat/relay/offline-messages`：拉走并清除。 */
export interface RelayOfflineMessages {
  items: RelayOfflineItem[]
}

/* ------------------------------------------------------------------ */
/* 客服增值服务的订阅（`/v1/support/subscription`）                      */
/* ------------------------------------------------------------------ */

/** `GET /v1/support/subscription`。从没订过就只有 `status: 'none'` 与两格标识。 */
export interface SupportSubscriptionView {
  status: SubscriptionStatus
  current_cycle_end?: Iso8601
  grace_until?: Iso8601
  cancel_at_period_end?: boolean
  service_id: 'support.service.monthly'
  workspace: string
}

/** 开通时这一次扣了哪几期（补扣落下的几期也在这里）。`ok: false` = 没扣成，进宽限。 */
export interface SupportSubscriptionCharge {
  cycle_start: Iso8601
  ok: boolean
}

/** `POST /v1/support/subscription`：开通。钱不够**不回 402**——订阅照开、状态进 `grace`。 */
export interface SupportSubscriptionStarted {
  status: SubscriptionStatus
  charged: SupportSubscriptionCharge[]
}

/** `DELETE /v1/support/subscription`：取消（当期用完为止）。 */
export interface SupportSubscriptionCancelled {
  status: SubscriptionStatus
}

/* ------------------------------------------------------------------ */
/* 访客面（`/relay/{workspace}/…`，网站挂件在用）                        */
/* ------------------------------------------------------------------ */

/**
 * 访客那一面能看到的挂件配置。**不回 `allowed_origins`**；来源不在白名单里时
 * 回 `{ enabled: false, accent: '#2563eb', greeting: '' }`。
 */
export interface RelayWidgetPublicConfig {
  enabled: boolean
  accent: string
  greeting: string
  position?: 'left' | 'right'
  language?: 'auto' | 'zh' | 'en'
}

/** `POST …/v1/chat/public/sessions`：开一个会话。之后的请求带 `Authorization: Bearer <visitor_token>`。 */
export interface RelayVisitorSession {
  session_id: string
  visitor_token: string
}

/** `POST …/sessions/{id}/typing`：打字信号**只承载布尔**。 */
export interface RelayVisitorTypingRequest {
  active: boolean
}

/** 访客面那几条「收到了」。 */
export interface RelayVisitorOk {
  ok: true
}

/** `POST …/sessions/{id}/messages`。`text` 超过 2000 字截断。 */
export interface RelayVisitorMessageRequest {
  text: string
  /** 商家自己在设置页试聊（不计对话数）。 */
  trial?: boolean
}

/**
 * 发出去了（202，回复从 SSE 回来），或者对面不在 / 额度到顶（200，挂件改成留言表单）。
 */
export type RelayVisitorMessageResult =
  | { status: 'forwarded' }
  | { status: 'offline'; reason: 'peer_offline' | 'quota_exhausted' }

/** `POST …/v1/chat/public/offline-messages`：留言（封箱存 7 天，等商家本机拉走）。 */
export interface RelayOfflineMessageRequest {
  email: string
  text: string
  order_ref?: string
  page?: string
}

/** 访客 SSE 流里每个 `data:` 的形状（第一条恒为 `open`）。 */
export type RelayVisitorEvent =
  | { type: 'open' }
  | { type: 'message'; message: { role: 'agent'; text: string } }
  | { type: 'typing'; active: boolean }
  | { type: 'offline' }

/**
 * 访客面的错误：`{ error: { code } }`，**大多数不带 message**（挂件按码出文案）；
 * 503 的那两种（`relay_unavailable` / `offline_unavailable`）带一句人话。
 */
export interface RelayVisitorErrorBody {
  error: { code: string; message?: string }
}
