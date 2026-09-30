/**
 * 飞书「企业自建应用 + 机器人」长连接渠道：常量、线类型与纯函数（WP211）。
 *
 * 事实来源（2026-09-30 读，只看公开页面与源码）：
 * - 飞书开放平台「使用长连接接收事件」与「接收消息 im.message.receive_v1」文档；
 * - 官方 Node SDK `@larksuiteoapi/node-sdk@1.74.0`（MIT）的类型声明与 `WSClient` 源码。
 *
 * 每一处都标了**已核实 / 未核实**：已核实 = 文档或官方 SDK 源码里写着；
 * 未核实 = 按形状补的，真机上要再对一遍。
 *
 * 定位与企业微信那条一致（54 §5）：**团队**渠道，归工作区。私聊它或在群里 @ 它 →
 * 按提问人身份问**他自己的**代理；审批动作不在飞书里做（见 `im-cards.ts`）。
 *
 * 长连接本身交给官方 SDK（协议是 protobuf 分帧、服务端下发重连参数，自己写容易错）；
 * 这个文件只放**不碰网络**的那一半，所以测试不需要 SDK 也不出网。
 */

import type { ChannelName } from '@agentsws/contracts'

/** 契约里早就有 `'feishu'`（18 §2 首批适配器），直接用。 */
export const FEISHU_BOT_CHANNEL: ChannelName = 'feishu'

/** 收消息的事件名（文档原文，**已核实**）。 */
export const FEISHU_MESSAGE_EVENT = 'im.message.receive_v1'

/** 两个站点（SDK `Domain.Feishu` / `Domain.Lark`，**已核实**）。国际版 Lark 走第二个。 */
export const FEISHU_DOMAINS = {
  feishu: 'https://open.feishu.cn',
  lark: 'https://open.larksuite.com',
} as const
export type FeishuDomain = keyof typeof FEISHU_DOMAINS

/**
 * 拉长连接地址时服务端回的错误码（SDK `ErrorCode` 枚举原文，**已核实**）。
 * `514` = 鉴权失败（App ID / Secret 不对）；`403` = 没权限（多半是没开长连接或应用没发布，**未核实**具体原因）。
 */
export const FEISHU_WS_ERROR = {
  auth_failed: 514,
  forbidden: 403,
  exceed_conn_limit: 1000040350,
} as const

/* ── 线类型（SDK 类型声明里给到的字段；没用上的不抄） ───────────────── */

export interface FeishuUserId {
  open_id?: string
  union_id?: string
  user_id?: string
}

export interface FeishuMention {
  /** 正文里的占位符，如 `@_user_1`（**已核实**）。 */
  key?: string
  /** 文档：可能是对象；`@所有人` 时社区实现见过字符串 `all`（**未核实**），两种都认。 */
  id?: FeishuUserId | string
  name?: string
}

/** `im.message.receive_v1` 的事件体（SDK 回调拿到的 `data`）。 */
export interface FeishuMessageEvent {
  event_id?: string
  sender?: { sender_id?: FeishuUserId; sender_type?: string }
  message?: {
    message_id?: string
    chat_id?: string
    /** `p2p` 私聊 / `group` 群聊（**已核实**）。 */
    chat_type?: string
    message_type?: string
    /** JSON 字符串；文本消息是 `{"text":"..."}`（**已核实**）。 */
    content?: string
    mentions?: FeishuMention[]
  }
  [key: string]: unknown
}

/* ── 纯函数 ─────────────────────────────────────────────────────── */

/** 提问人是谁：用 `open_id`（应用内稳定、不需要额外权限，**已核实**）。 */
export function feishuSenderId(e: FeishuMessageEvent): string {
  return e.sender?.sender_id?.open_id?.trim() ?? ''
}

/** 是机器人 / 应用自己发的吗（`sender_type !== 'user'`）——那种一律不理，免得两个机器人对聊。 */
export function isFromApp(e: FeishuMessageEvent): boolean {
  const t = e.sender?.sender_type
  return t !== undefined && t !== 'user'
}

export function isGroupChat(e: FeishuMessageEvent): boolean {
  return e.message?.chat_type === 'group'
}

/**
 * 正文：文本消息取 `text`，富文本（`post`）把文字段拼起来；别的类型先不认（回空串）。
 * `@_user_1` 这种占位符一律去掉——问代理的那句话里不该有它。
 */
export function textOfFeishu(e: FeishuMessageEvent): string {
  const raw = e.message?.content
  if (typeof raw !== 'string' || raw === '') return ''
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return ''
  }
  const type = e.message?.message_type
  let text = ''
  if (type === 'text') {
    const t = (parsed as { text?: unknown }).text
    text = typeof t === 'string' ? t : ''
  } else if (type === 'post') {
    text = postText(parsed)
  }
  return text
    .replace(/@_user_\d+/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

/** 富文本：`{ title?, content: [[{tag:'text', text}...]...] }`，可能再包一层语言键（**已核实**两种形状）。 */
function postText(parsed: unknown): string {
  const pick = (v: unknown): { title?: unknown; content?: unknown } | undefined =>
    typeof v === 'object' && v !== null ? (v as { title?: unknown; content?: unknown }) : undefined
  let body = pick(parsed)
  if (body !== undefined && !Array.isArray(body.content)) {
    const inner = Object.values(body)
      .map(pick)
      .find((v) => Array.isArray(v?.content))
    body = inner
  }
  if (body === undefined || !Array.isArray(body.content)) return ''
  const lines: string[] = []
  if (typeof body.title === 'string' && body.title.trim() !== '') lines.push(body.title)
  for (const row of body.content) {
    if (!Array.isArray(row)) continue
    const parts = row
      .map((el) => (el as { tag?: unknown; text?: unknown }) ?? {})
      .filter((el) => (el.tag === 'text' || el.tag === 'a') && typeof el.text === 'string')
      .map((el) => el.text as string)
    if (parts.length > 0) lines.push(parts.join(''))
  }
  return lines.join('\n')
}

/** 一条 mention 指的 open_id（字符串形状的 `all` 不算人）。 */
function mentionOpenId(m: FeishuMention): string | undefined {
  if (typeof m.id === 'object' && m.id !== null) return m.id.open_id
  return undefined
}

/**
 * 这条是不是冲着机器人来的。
 *
 * - 私聊：一律算；
 * - 群聊：mentions 里有**机器人自己的 open_id** 才算。`@所有人` 不算（不然每条群公告都会让它开口）。
 * - 还没拿到机器人的 open_id（启动时查 `/open-apis/bot/v3/info` 失败）：退一步，群里有 @ 某人就算。
 *   理由：只开「接收群聊中 @ 机器人消息」权限时，飞书本来就只把 @ 了机器人的群消息推过来
 *   （文档，**已核实**）；开了「获取群组中所有消息」才会收到别的——那种情况下宁可多答一句
 *   也比全不答好，而且答案本来就只到提问人自己那一层。
 */
export function isAddressedToFeishuBot(e: FeishuMessageEvent, bot_open_id?: string): boolean {
  if (!isGroupChat(e)) return true
  const mentions = e.message?.mentions ?? []
  const people = mentions.map(mentionOpenId).filter((id): id is string => id !== undefined)
  if (bot_open_id !== undefined && bot_open_id !== '') return people.includes(bot_open_id)
  return people.length > 0
}

/** 去重键 = 消息 id（飞书在 3 秒内没收到回执会重推同一条，**已核实**）。 */
export function feishuDedupeKey(e: FeishuMessageEvent): string {
  const id = e.message?.message_id?.trim() ?? ''
  if (id !== '') return `feishu:${id}`
  return `feishu:${e.event_id ?? ''}`
}

/** 回复的请求体（`POST /open-apis/im/v1/messages/:message_id/reply`，**已核实**）。 */
export function feishuReplyBody(text: string): { msg_type: 'text'; content: string } {
  return { msg_type: 'text', content: JSON.stringify({ text }) }
}

/**
 * SDK / 接口报的错 → 给人看的一句话。认不出的给一句通用的，**不把原始错误串原样摆给人**
 * （里面可能带请求地址），原始串只进诊断日志。
 */
export function feishuErrorToHuman(detail: string): { code: FeishuErrorCode; message: string } {
  const code = /code[=:]\s*(\d+)/i.exec(detail)?.[1]
  if (
    code === String(FEISHU_WS_ERROR.auth_failed) ||
    /app.?secret|invalid.*app|10014|10003/i.test(detail)
  )
    return {
      code: 'bad_credentials',
      message: 'App ID 或 App Secret 不对。去飞书开放平台的「凭证与基础信息」页重新复制一次再填。',
    }
  if (code === String(FEISHU_WS_ERROR.forbidden))
    return {
      code: 'not_enabled',
      message:
        '飞书拒绝了长连接。检查三件事：开了「机器人」能力、事件订阅选了「使用长连接接收事件」、应用已发布。',
    }
  if (code === String(FEISHU_WS_ERROR.exceed_conn_limit))
    return {
      code: 'too_many_connections',
      message: '这个应用的长连接开得太多了（别的电脑上也连着）。先关掉别处的，再点重连。',
    }
  return { code: 'unreachable', message: '暂时连不上飞书，稍后会自动重试。' }
}

export type FeishuErrorCode =
  | 'bad_credentials'
  | 'not_enabled'
  | 'too_many_connections'
  | 'unreachable'
