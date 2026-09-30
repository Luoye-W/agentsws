/**
 * 钉钉「企业内部应用机器人 + Stream 模式」：常量、线类型与纯函数（WP211）。
 *
 * 事实来源（2026-09-30 读，只看公开页面与源码）：
 * - 钉钉开放平台「Stream 模式」协议说明与「机器人接收消息」文档；
 * - 官方 SDK `dingtalk-stream@2.1.5`（Node，MIT，`open-dingtalk/dingtalk-stream-sdk-nodejs`）
 *   的 `client.mjs` / `constants.d.ts`，与官方 Python SDK（MIT）的 `stream.py` / `chatbot.py`。
 *
 * 出处（移植，MIT）：`open-dingtalk/dingtalk-stream-sdk-nodejs` `src/client.ts` + `src/constants.ts`
 * @ `c979c664099a3bd175ab2f810753db0fc9e3a515`（v2.1.5）。Copyright (c) 2023 钉钉开放平台团队。
 * 登记在 `upstreams.yml` 的 `dingtalk-stream` 一条（ported）。
 *
 * 为什么是**照官方 SDK 移植协议**而不是直接 `import` 它（评估见 docs/63 §M）：它的
 * `connect()` 把所有错误吞掉、每 1 秒重试一次到天荒地老——凭据填错时我们既拿不到
 * 「错在哪」给人一句话，又会每秒打一次钉钉网关；还往 console 打连接日志、关不掉。
 * 协议本身很小（一次 HTTP 换 ticket + 一条 JSON 帧的 WebSocket），移植成与企业微信
 * 那条同一个形状（注入的 socket、我们自己的退避梯子），测试也能全在内存里跑。
 *
 * 每一处都标了**已核实 / 未核实**：已核实 = 官方 SDK 源码或文档里写着。
 */

import type { ChannelName } from '@agentsws/contracts'

/** 契约 WP211 新加的渠道名。 */
export const DINGTALK_BOT_CHANNEL: ChannelName = 'dingtalk'

/** 换连接 ticket 的地址（SDK `GATEWAY_URL` 原文，**已核实**）。 */
export const DINGTALK_GATEWAY_URL = 'https://api.dingtalk.com/v1.0/gateway/connections/open'

/** 机器人消息的回调 topic（SDK `TOPIC_ROBOT` 原文，**已核实**）。 */
export const TOPIC_ROBOT = '/v1.0/im/bot/messages/get'

/**
 * 断线重连退避。官方 Python SDK：1s 起、指数翻倍、封顶 60s、带 1s 抖动（**已核实**）；
 * 官方 Node SDK 是固定 1s（我们不照它，理由见文件头）。这里取一张固定梯子，便于测试。
 */
export const DINGTALK_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000] as const

/* ── 线类型 ─────────────────────────────────────────────────────── */

/** 服务端推下来的一帧（SDK `DWClientDownStream`，**已核实**）。 */
export interface DingtalkDownStream {
  specVersion?: string
  /** `SYSTEM` / `EVENT` / `CALLBACK`（**已核实**）。 */
  type?: string
  headers?: {
    messageId?: string
    topic?: string
    contentType?: string
    [key: string]: unknown
  }
  /** JSON 字符串。 */
  data?: string
}

/**
 * 机器人消息（SDK `RobotMessageBase` + Python SDK `ChatbotMessage` 的字段，**已核实**）。
 * `conversationType`：`'1'` 单聊、`'2'` 群聊。
 */
export interface DingtalkRobotMessage {
  msgId?: string
  msgtype?: string
  text?: { content?: string }
  conversationId?: string
  conversationType?: string
  senderId?: string
  senderStaffId?: string
  senderNick?: string
  chatbotUserId?: string
  robotCode?: string
  isInAtList?: boolean
  atUsers?: { dingtalkId?: string; staffId?: string }[]
  sessionWebhook?: string
  sessionWebhookExpiredTime?: number
  createAt?: number
  [key: string]: unknown
}

/* ── 帧与请求体（纯函数） ───────────────────────────────────────── */

/** 换 ticket 的请求体（SDK `getEndpoint` 原文，**已核实**）。`clientSecret` 是秘密：现取现用。 */
export function openConnectionBody(input: { client_id: string; client_secret: string }): {
  clientId: string
  clientSecret: string
  ua: string
  subscriptions: { type: string; topic: string }[]
} {
  return {
    clientId: input.client_id,
    clientSecret: input.client_secret,
    ua: 'agentsws',
    subscriptions: [{ type: 'CALLBACK', topic: TOPIC_ROBOT }],
  }
}

/** 系统 `ping` 帧的回帧：原样带回 headers 与 data（SDK `onSystem` 原文，**已核实**）。 */
export function pongFrame(down: DingtalkDownStream): string {
  return JSON.stringify({ code: 200, headers: down.headers ?? {}, message: 'OK', data: down.data })
}

/**
 * 回调的回执（SDK `socketCallBackResponse` 原文，**已核实**）：60 秒内不回执，
 * 服务端会重推同一条。我们**收到就回执**，处理放后面（重推靠去重键挡）。
 */
export function ackFrame(messageId: string): string {
  return JSON.stringify({
    code: 200,
    headers: { contentType: 'application/json', messageId },
    message: 'OK',
    data: JSON.stringify({ response: null }),
  })
}

export function isGroupConversation(m: DingtalkRobotMessage): boolean {
  return m.conversationType === '2'
}

/** 提问人：企业内部应用有 `senderStaffId`（员工 userid），没有再退 `senderId`。 */
export function dingtalkSenderId(m: DingtalkRobotMessage): string {
  const staff = typeof m.senderStaffId === 'string' ? m.senderStaffId.trim() : ''
  if (staff !== '') return staff
  return typeof m.senderId === 'string' ? m.senderId.trim() : ''
}

/** 正文（只认文本；别的类型回空串）。 */
export function textOfDingtalk(m: DingtalkRobotMessage): string {
  if (m.msgtype !== 'text') return ''
  return m.text?.content?.trim() ?? ''
}

/**
 * 这条是不是冲着机器人来的。
 *
 * 单聊一律算。群聊：钉钉机器人在群里**只收得到 @ 它的消息**（文档，**已核实**），回调里还带
 * `isInAtList`；它明确是 `false` 才不算（字段缺省时按文档行为当作 @ 了）。
 */
export function isAddressedToDingtalkBot(m: DingtalkRobotMessage): boolean {
  if (!isGroupConversation(m)) return true
  return m.isInAtList !== false
}

/** 去重键 = `msgId`（重推的是同一条）。 */
export function dingtalkDedupeKey(m: DingtalkRobotMessage): string {
  const id = typeof m.msgId === 'string' ? m.msgId.trim() : ''
  if (id !== '') return `dingtalk:${id}`
  return `dingtalk:${m.conversationId ?? ''}:${dingtalkSenderId(m)}:${m.createAt ?? ''}`
}

/** 经 `sessionWebhook` 回一条文本；群里顺手 @ 回提问人（文档的 `at.atUserIds`，**已核实**）。 */
export function sessionReplyBody(
  text: string,
  at_staff_id?: string,
): { msgtype: 'text'; text: { content: string }; at?: { atUserIds: string[] } } {
  return {
    msgtype: 'text',
    text: { content: text },
    ...(at_staff_id === undefined || at_staff_id === ''
      ? {}
      : { at: { atUserIds: [at_staff_id] } }),
  }
}

/**
 * `sessionWebhook` 只许发往钉钉自己的域名（https + `*.dingtalk.com`）。
 * 这个地址是从推送里来的；万一线上被塞进别的地址，我们不把答案 POST 给它。
 */
export function isDingtalkWebhook(url: string): boolean {
  try {
    const u = new URL(url)
    return (
      u.protocol === 'https:' &&
      (u.hostname === 'dingtalk.com' || u.hostname.endsWith('.dingtalk.com'))
    )
  } catch {
    return false
  }
}

export type DingtalkErrorCode = 'bad_credentials' | 'unreachable'

/**
 * 换 ticket 失败 → 给人看的一句话。4xx = 凭据 / 应用配置不对（重试没用）；
 * 其余（5xx、断网）= 暂时连不上（会自动重试）。原始响应只进诊断日志。
 */
export function dingtalkErrorToHuman(status: number | undefined): {
  code: DingtalkErrorCode
  message: string
} {
  if (status !== undefined && status >= 400 && status < 500)
    return {
      code: 'bad_credentials',
      message:
        'Client ID 或 Client Secret 不对，或者应用还没开「Stream 模式」。去钉钉开发者后台核一下再填。',
    }
  return { code: 'unreachable', message: '暂时连不上钉钉，稍后会自动重试。' }
}
