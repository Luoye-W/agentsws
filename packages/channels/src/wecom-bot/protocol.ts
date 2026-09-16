/**
 * 企业微信「智能机器人」长连接协议：常量、线类型与纯函数（WP85；54 §5）。
 *
 * 事实来源：企业微信开放文档
 * <https://developer.work.weixin.qq.com/document/path/101463>（2026-09-16 读）。
 * 每一处都标了**已核实 / 未核实**——已核实 = 文档里写着；未核实 = 我们按形状补的，
 * 真机上要再对一遍。
 *
 * 定位（54 §5）：这是**团队**渠道，归属工作区。群里 @ 机器人 → 按提问人身份
 * 路由到**他自己的**代理，答案受 41 §1.3 的公开级别限制；审批动作不在群里做
 * （见 `im-cards.ts`）。
 */

import type { ChannelName } from '@agentsws/contracts'

/** 契约里已经有 `'wecom'`，直接用（不像微信那条要断言）。 */
export const WECOM_BOT_CHANNEL: ChannelName = 'wecom'

/** 长连接地址（文档原文，**已核实**）。 */
export const WECOM_WS_URL = 'wss://openws.work.weixin.qq.com'

/* ── 命令名（文档原文，已核实）────────────────────────────────────── */

export const CMD_SUBSCRIBE = 'aibot_subscribe'
export const CMD_MSG_CALLBACK = 'aibot_msg_callback'
export const CMD_EVENT_CALLBACK = 'aibot_event_callback'
export const CMD_RESPOND_MSG = 'aibot_respond_msg'
export const CMD_RESPOND_WELCOME = 'aibot_respond_welcome_msg'
export const CMD_PING = 'ping'
export const CMD_PONG = 'pong'

/* ── 节奏与限额 ──────────────────────────────────────────────────── */

/** 心跳间隔（文档：建议每 30 秒 ping 一次，**已核实**）。 */
export const HEARTBEAT_MS = 30_000

/** 普通消息的回复窗口（文档：收到后 24 小时内可回，**已核实**）。 */
export const REPLY_WINDOW_MS = 24 * 60 * 60 * 1000

/** 进入会话 / 模板卡片事件要在 5 秒内回（文档，**已核实**）。 */
export const EVENT_REPLY_DEADLINE_MS = 5_000

/** 单会话限额（文档：30 条/分钟、1000 条/小时，含回复与主动推送，**已核实**）。 */
export const RATE_PER_MINUTE = 30
export const RATE_PER_HOUR = 1000

/** 断线重连退避（文档未规定，**未核实**：我们自己的梯子，封顶 30s）。 */
export const RECONNECT_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const

/** 同一个机器人同时只保持一个有效长连接（文档，**已核实**）：新连接会踢掉旧的。 */
export const SINGLE_CONNECTION = true

/* ── 线类型（文档给到的字段；没写的一律标 optional，不猜） ─────────── */

export interface WecomFrameHeaders {
  req_id?: string
}

export interface WecomFrame<B = unknown> {
  cmd?: string
  headers?: WecomFrameHeaders
  body?: B
  errcode?: number
  errmsg?: string
}

export type WecomChatType = 'single' | 'group'

export interface WecomInboundBody {
  msgid?: string
  aibotid?: string
  chatid?: string
  chattype?: WecomChatType
  from?: { userid?: string; name?: string }
  msgtype?: string
  text?: { content?: string }
  image?: { url?: string; aeskey?: string }
  file?: { url?: string; aeskey?: string; filename?: string }
  /** 文档未提供更细的结构；我们只读上面这几样。 */
  [key: string]: unknown
}

export interface WecomEventBody {
  event?: { eventtype?: string }
  chatid?: string
  chattype?: WecomChatType
  from?: { userid?: string }
  [key: string]: unknown
}

/** 订阅（握手）报文（文档原文形状）。`secret` 是**秘密**：只从秘密库取，用完即弃。 */
export function subscribeFrame(input: {
  bot_id: string
  secret: string
  req_id: string
}): WecomFrame<{ bot_id: string; secret: string }> {
  return {
    cmd: CMD_SUBSCRIBE,
    headers: { req_id: input.req_id },
    body: { bot_id: input.bot_id, secret: input.secret },
  }
}

export function pingFrame(req_id: string): WecomFrame {
  return { cmd: CMD_PING, headers: { req_id } }
}

/**
 * 回一条纯文本。
 *
 * `req_id` **回带入站那一条的**：文档说每个请求带一个 `req_id` 做关联。
 * 流式（`stream`）我们不用——代理答完一整句再回，IM 里的半截话只会让人误会。
 */
export function respondTextFrame(input: {
  req_id: string
  text: string
}): WecomFrame<{ msgtype: 'text'; text: { content: string } }> {
  return {
    cmd: CMD_RESPOND_MSG,
    headers: { req_id: input.req_id },
    body: { msgtype: 'text', text: { content: input.text } },
  }
}

/** 这一帧是不是一条入站消息。 */
export function isInboundMessage(frame: WecomFrame): frame is WecomFrame<WecomInboundBody> {
  return frame.cmd === CMD_MSG_CALLBACK
}

export function isInboundEvent(frame: WecomFrame): frame is WecomFrame<WecomEventBody> {
  return frame.cmd === CMD_EVENT_CALLBACK
}

/** 订阅成功没有（`errcode === 0`）。 */
export function subscribeOk(frame: WecomFrame): boolean {
  return frame.cmd === CMD_SUBSCRIBE && (frame.errcode ?? 0) === 0
}

/** 入站正文（只认 `text.content`；别的类型先只记类型，不猜内容）。 */
export function textOfInbound(body: WecomInboundBody): string {
  return body.text?.content?.trim() ?? ''
}

/**
 * 去重键 = 消息 id（与微信那条一致）。
 *
 * 没有 `msgid` 的（事件回调就没有）用 `chatid + 发送人 + 类型` 兜底——
 * 事件本来就该按会话去重一次，重复的 `enter_chat` 不该刷出两条欢迎语。
 */
export function wecomDedupeKey(body: WecomInboundBody): string {
  const id = typeof body.msgid === 'string' ? body.msgid.trim() : ''
  if (id !== '') return `wecom:${id}`
  return `wecom:${body.chatid ?? ''}:${body.from?.userid ?? ''}:${body.msgtype ?? ''}`
}

/**
 * 群里这条是不是 @ 了机器人。
 *
 * 文档没有给「有没有 @ 我」的布尔字段（**未核实**），而企业微信智能机器人在群里
 * **本来就只有被 @ 才会收到回调**——所以这里的规则是：单聊一律算，群聊只要收到
 * 就当是 @ 了。把判断写成一个具名函数而不是散在 if 里，是为了真机核对完
 * 只改这一处。
 */
export function isAddressedToBot(body: WecomInboundBody): boolean {
  if (body.chattype !== 'group') return true
  // 群聊这一档真机上要再核一遍：如果将来发现回调里其实带了 @ 列表，
  // 判断只改这一行（别处都调这个函数，没有第二处「算不算 @ 我」的逻辑）。
  return true
}
