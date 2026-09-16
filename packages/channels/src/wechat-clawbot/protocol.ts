/**
 * 微信 ClawBot（iLink）线协议：常量、线类型与纯函数（WP85；54 §5）。
 *
 * 事实来源：`Tencent/openclaw-weixin` 的 `docs/protocol_zh_CN.md` 与
 * `src/api/{api,types}.ts`、`src/auth/login-qr.ts`、`src/api/session-guard.ts`、
 * `src/monitor/monitor.ts`（2026-09-16 走读）。**哪些核实过、哪些没有**见每一处的
 * 注释：官方那份协议文档自己声明「客户端类型和行为不能代表完整的服务端契约」，
 * 所以这里凡是从派工说明抄来、文档里查不到的数字，一律标出来并且**可注入**，
 * 不写死在判断里。
 *
 * 定位（54 §5、条款 6.1 / 6.4）：ClawBot 只做「**本人 ↔ 本人的代理**」这一件事。
 * 不做客服、不做团队、不用它对外主动发消息——违规会牵连主微信账号，
 * 而被牵连的是用户本人的账号，不是我们的。
 */

import type { ChannelName } from '@agentsws/contracts'

/**
 * 渠道名。
 *
 * `packages/contracts/src/channels.ts` 的 `ChannelName` **还没有** `'wechat'`
 * 这一项（本 WP 不自己改契约，见报告「契约改动」）。所以这里在**一处**做断言，
 * 别处一律引这个常量：等契约加上 `'wechat'` 之后，这三行删成一行 `= 'wechat'`，
 * 其余文件一个字不用动。
 */
const WECHAT_NAME: string = 'wechat'
export const WECHAT_CLAWBOT_CHANNEL: ChannelName = WECHAT_NAME as ChannelName

/* ------------------------------------------------------------------ */
/* 端点与请求头（协议文档 §「协议范围和传输方式」「鉴权和公共元数据」，已核实）  */
/* ------------------------------------------------------------------ */

/** 默认 API 地址（文档原文）。扫码确认后服务端可能返回 `baseurl` 换掉它。 */
export const ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com'

/** 本渠道构建的 `bot_type`（`login-qr.ts` 的 `DEFAULT_ILINK_BOT_TYPE`）。 */
export const ILINK_BOT_TYPE = '3'

export const EP_GET_BOT_QRCODE = 'ilink/bot/get_bot_qrcode'
export const EP_QRCODE_STATUS = 'ilink/bot/get_qrcode_status'
export const EP_GET_UPDATES = 'ilink/bot/getupdates'
export const EP_SEND_MESSAGE = 'ilink/bot/sendmessage'
export const EP_GET_UPLOAD_URL = 'ilink/bot/getuploadurl'
export const EP_GET_CONFIG = 'ilink/bot/getconfig'
export const EP_SEND_TYPING = 'ilink/bot/sendtyping'

/** 请求头名字（文档里的那张表，逐字）。 */
export const HDR_AUTHORIZATION_TYPE = 'AuthorizationType'
export const HDR_AUTHORIZATION = 'Authorization'
export const HDR_WECHAT_UIN = 'X-WECHAT-UIN'
export const HDR_APP_ID = 'iLink-App-Id'
export const HDR_APP_CLIENT_VERSION = 'iLink-App-ClientVersion'
export const AUTHORIZATION_TYPE = 'ilink_bot_token'
/** 文档：「插件应用 ID，目前为 `bot`」。 */
export const ILINK_APP_ID = 'bot'

/* ------------------------------------------------------------------ */
/* 返回码与节奏                                                          */
/* ------------------------------------------------------------------ */

export const RET_OK = 0

/**
 * **已核实**（文档 §错误处理那张表）：「任一字段为 `-14` 时触发一小时的账号会话暂停」。
 * 我们的读法：token 失效 → 停一小时 + 让用户重扫。
 */
export const RET_STALE_TOKEN = -14

/**
 * **未核实**：派工说明写「`ret=-2 prepare failed` = `context_token` 失效」。
 * 官方协议文档的错误码表里**没有** `-2`（只写了 `-14`），仓库源码里也搜不到。
 * 所以这里只把它当成「这条会话上下文不能用了」的一个**可配**信号：
 * 命中就丢掉缓存的 `context_token`，等本人下一条消息进来再回，
 * 绝不据此重扫、也绝不无限重试。
 */
export const RET_PREPARE_FAILED = -2

/** `-14` 之后停多久（`session-guard.ts` 的 `SESSION_PAUSE_DURATION_MS`，已核实）。 */
export const STALE_TOKEN_PAUSE_MS = 60 * 60 * 1000

/** 长轮询默认超时（`api.ts` 的 `DEFAULT_LONG_POLL_TIMEOUT_MS`，已核实）。 */
export const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000

/** 连续失败几次之后退避（`monitor.ts`，已核实）。 */
export const MAX_CONSECUTIVE_FAILURES = 3
/** 退避多久（`monitor.ts` 的 `BACKOFF_DELAY_MS`，已核实）。 */
export const BACKOFF_DELAY_MS = 30_000
/** 未到退避阈值时的重试间隔（`monitor.ts` 的 `RETRY_DELAY_MS`，已核实）。 */
export const RETRY_DELAY_MS = 2_000

/**
 * `context_token` 的默认有效期。
 *
 * **未核实**：官方协议文档对有效期写的是「文档未提供」，派工说明给的是「约 15h」。
 * 取 15h 作缺省值，并且**可注入**——真值只有服务端知道，我们靠
 * {@link RET_PREPARE_FAILED} 与「过期就不回、等下一条入站」兜底，不靠这个数字。
 */
export const CONTEXT_TOKEN_TTL_MS = 15 * 60 * 60 * 1000

/* ------------------------------------------------------------------ */
/* 线类型（`src/api/types.ts` 的子集：只留我们真的会读写的字段）             */
/* ------------------------------------------------------------------ */

/** `proto: MessageItemType`（已核实）。 */
export const ITEM_TEXT = 1
export const ITEM_IMAGE = 2
export const ITEM_VOICE = 3
export const ITEM_FILE = 4
export const ITEM_VIDEO = 5

/** `proto: MessageType`。1 = 用户发的，2 = bot 发的（已核实）。 */
export const MSG_TYPE_USER = 1
export const MSG_TYPE_BOT = 2

/** `proto: MessageState`。2 = FINISH（已核实）。 */
export const MSG_STATE_FINISH = 2

export interface WireTextItem {
  text?: string
}

export interface WireCdnMedia {
  encrypt_query_param?: string
  aes_key?: string
  encrypt_type?: number
  full_url?: string
}

export interface WireImageItem {
  media?: WireCdnMedia
  thumb_media?: WireCdnMedia
  /** 16 字节 AES-128 key 的十六进制串（入站解密用；**是秘密，永不落事件**）。 */
  aeskey?: string
  url?: string
}

export interface WireMessageItem {
  type?: number
  msg_id?: string
  create_time_ms?: number
  text_item?: WireTextItem
  image_item?: WireImageItem
}

/** `proto: WeixinMessage`（子集）。 */
export interface WireMessage {
  seq?: number
  /** 线上是 uint64，JSON 里按字符串无损解析。 */
  message_id?: string
  from_user_id?: string
  to_user_id?: string
  client_id?: string
  create_time_ms?: number
  session_id?: string
  group_id?: string
  message_type?: number
  message_state?: number
  item_list?: WireMessageItem[]
  context_token?: string
  run_id?: string
}

export interface WireBaseInfo {
  channel_version?: string
  bot_agent?: string
}

export interface GetUpdatesReq {
  get_updates_buf?: string
  base_info?: WireBaseInfo
}

export interface GetUpdatesResp {
  ret?: number
  errcode?: number
  errmsg?: string
  msgs?: WireMessage[]
  get_updates_buf?: string
  longpolling_timeout_ms?: number
}

export interface SendMessageReq {
  msg?: WireMessage
  base_info?: WireBaseInfo
}

export interface SendMessageResp {
  message_id?: string
  ret?: number
  errmsg?: string
}

/** 扫码登录的状态机（`login-qr.ts` 的 `StatusResponse.status`，逐字）。 */
export type QrcodeStatus =
  | 'wait'
  | 'scaned'
  | 'confirmed'
  | 'expired'
  | 'scaned_but_redirect'
  | 'need_verifycode'
  | 'verify_code_blocked'
  | 'binded_redirect'

export interface QrcodeResp {
  qrcode: string
  qrcode_img_content: string
}

export interface QrcodeStatusResp {
  status: QrcodeStatus
  /** **秘密**：只允许进秘密库，永不进事件、日志、响应体（13 §4.3）。 */
  bot_token?: string
  ilink_bot_id?: string
  baseurl?: string
  ilink_user_id?: string
  redirect_host?: string
}

/* ------------------------------------------------------------------ */
/* 纯函数                                                               */
/* ------------------------------------------------------------------ */

/** `X-WECHAT-UIN`：随机 uint32 的十进制串再 base64（文档原文）。 */
export function wechatUin(random: () => number): string {
  const uint32 = Math.floor(Math.abs(random()) * 0xff_ff_ff_ff) % 0x1_00_00_00_00
  return Buffer.from(String(uint32), 'utf8').toString('base64')
}

export interface ClawBotHeaderInput {
  /** 有 token 才加 `Authorization`（二维码那两条不带）。 */
  token?: string
  uin: string
  app_id?: string
  client_version?: string
}

/** 鉴权 Bot POST 请求的请求头（文档那张表）。 */
export function clawBotHeaders(input: ClawBotHeaderInput): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    [HDR_AUTHORIZATION_TYPE]: AUTHORIZATION_TYPE,
    [HDR_WECHAT_UIN]: input.uin,
    [HDR_APP_ID]: input.app_id ?? ILINK_APP_ID,
    [HDR_APP_CLIENT_VERSION]: input.client_version ?? '1',
  }
  const token = input.token?.trim()
  if (token !== undefined && token !== '') headers[HDR_AUTHORIZATION] = `Bearer ${token}`
  return headers
}

/**
 * 二维码状态轮询的请求头（文档：**不带** `AuthorizationType` / `Authorization` /
 * `X-WECHAT-UIN`，只带应用头）。
 */
export function clawBotAppHeaders(input: {
  app_id?: string
  client_version?: string
}): Record<string, string> {
  return {
    [HDR_APP_ID]: input.app_id ?? ILINK_APP_ID,
    [HDR_APP_CLIENT_VERSION]: input.client_version ?? '1',
  }
}

/** 一条入站消息的正文（把 `item_list` 里的文本拼起来）。 */
export function textOfMessage(msg: WireMessage): string {
  return (msg.item_list ?? [])
    .filter((i) => i.type === ITEM_TEXT)
    .map((i) => i.text_item?.text ?? '')
    .filter((t) => t !== '')
    .join('\n')
}

/** 这条消息里带了几张图（正文之外的其余附件只计数，不下载）。 */
export function mediaKindsOf(msg: WireMessage): string[] {
  const names: Record<number, string> = {
    [ITEM_IMAGE]: 'image',
    [ITEM_VOICE]: 'voice',
    [ITEM_FILE]: 'file',
    [ITEM_VIDEO]: 'video',
  }
  return (msg.item_list ?? [])
    .map((i) => (i.type === undefined ? undefined : names[i.type]))
    .filter((n): n is string => n !== undefined)
}

/**
 * 去重键 = 消息 id（派工说明原话）。
 *
 * 服务端没给 `message_id` 的（理论上不该有）退回 `seq + 时间戳`——
 * 宁可偶尔多收一条，也不要把两条不同的消息折成一条。
 */
export function clawBotDedupeKey(msg: WireMessage): string {
  const id = msg.message_id?.trim()
  if (id !== undefined && id !== '') return `wechat:${id}`
  return `wechat:seq_${msg.seq ?? 0}_${msg.create_time_ms ?? 0}_${msg.from_user_id ?? ''}`
}

/** 这条响应算不算「token 失效」（`ret` / `errcode` 任一为 -14；已核实）。 */
export function isStaleToken(resp: { ret?: number; errcode?: number }): boolean {
  return resp.ret === RET_STALE_TOKEN || resp.errcode === RET_STALE_TOKEN
}

/** 这条响应算不算错（非零 `ret` 或非零 `errcode`；`monitor.ts` 的判断）。 */
export function isApiError(resp: { ret?: number; errcode?: number }): boolean {
  return (
    (resp.ret !== undefined && resp.ret !== RET_OK) ||
    (resp.errcode !== undefined && resp.errcode !== 0)
  )
}

/** 组一条纯文本出站消息（`send.ts` 的 `buildTextMessageReq`）。 */
export function buildTextMessage(input: {
  to_user_id: string
  text: string
  context_token?: string
  client_id: string
  run_id?: string
}): SendMessageReq {
  return {
    msg: {
      from_user_id: '',
      to_user_id: input.to_user_id,
      client_id: input.client_id,
      message_type: MSG_TYPE_BOT,
      message_state: MSG_STATE_FINISH,
      item_list: input.text === '' ? [] : [{ type: ITEM_TEXT, text_item: { text: input.text } }],
      ...(input.context_token === undefined ? {} : { context_token: input.context_token }),
      ...(input.run_id === undefined ? {} : { run_id: input.run_id }),
    },
  }
}

/** 组一条图片出站消息（图片已经上传到 CDN，这里只带引用）。 */
export function buildImageMessage(input: {
  to_user_id: string
  image: WireImageItem
  context_token?: string
  client_id: string
}): SendMessageReq {
  return {
    msg: {
      from_user_id: '',
      to_user_id: input.to_user_id,
      client_id: input.client_id,
      message_type: MSG_TYPE_BOT,
      message_state: MSG_STATE_FINISH,
      item_list: [{ type: ITEM_IMAGE, image_item: input.image }],
      ...(input.context_token === undefined ? {} : { context_token: input.context_token }),
    },
  }
}
