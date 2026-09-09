/**
 * 出站脱敏的**唯一入口**（31 §3.3「输出通道清单统一过一遍脱敏」）。
 *
 * WP31 之前是五个地方各自记得调 `scrub()`——加第六个通道就会漏，而漏的那次
 * 就是一把 `sk-…` 或者一串邮箱授权码原样发给了客户 / 原样进了模型上下文。
 * 39 §3.3 把这条记成待办 D：该有一个收口，各通道只调它。
 *
 * 纪律：
 * - 判定一律走 {@link SECRET_PATTERNS}（`secret-patterns.ts` 是表的唯一出处），
 *   本文件不新增秘密形态；它只负责**按通道**决定「除了秘密表之外还要做什么」。
 * - 只出不进：这里处理的都是**要离开我们进程**的东西（发给客户、发给模型、
 *   发给人的卡片）。入站脱敏仍在入站管线那一跳。
 * - 纯函数、无 IO、不认识 Clock——出站路径上多一次 IO 就是多一次失败模式。
 *
 * 五个通道（39 待办 D / E / F 点名的那五个）：
 *
 * | 通道 | 谁调 | 除秘密表外还做什么 |
 * |---|---|---|
 * | `email_body` | 回信正文（`@agentsws/channels` 的适配器与投递） | — |
 * | `card_payload` | 审批卡的标题 / 摘要 / payload | — |
 * | `answer` | 「问 AI」回给本人的正文（`apps/server/src/ask.ts`） | — |
 * | `tool_input` | 工具入参进事件日志（`@agentsws/runtime-direct`） | 围栏之外再叠这一层（围栏不认 `sk-…`） |
 * | `tool_result` | 工具返回值进模型上下文 | 额外抹掉 URL 里的签名参数 |
 */
import { scrub } from './secret-patterns.js'

/** 出站通道名。加第六个通道就在这里加一个名字——加不进来就说明它没走这个收口。 */
export type OutboundChannel =
  | 'email_body'
  | 'card_payload'
  | 'answer'
  | 'tool_input'
  | 'tool_result'

/**
 * URL 里一看就是凭据的查询参数名。
 *
 * 为什么要单列：带签名的下载 URL（`https://cdn…/x.pdf?X-Amz-Signature=…`）整串都是
 * 合法字符，秘密表的形态规则认不出来，但它就是一张能下载客户文件的通行证。
 * 39 §3.3 那一行「带签名 token 的下载 URL 会原样进模型上下文」说的就是它。
 */
const URL_SECRET_PARAMS: readonly string[] = [
  'access_token',
  'auth',
  'code',
  'id_token',
  'key',
  'password',
  'refresh_token',
  'sig',
  'signature',
  'token',
  'x-amz-credential',
  'x-amz-security-token',
  'x-amz-signature',
  'x-goog-signature',
]

/** 值被换掉之后长这样（与秘密表的 `[redacted:<rule>]` 同一形状，便于一眼认出）。 */
export const REDACTED_URL_PARAM = '[redacted:url_token]'

/** 文本里的 URL；末尾的标点（句号 / 逗号 / 括号）不算 URL 的一部分。 */
const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"'`]+/gi

/**
 * 把一条 URL 里的凭据参数换掉。解析不了的（不是合法 URL）原样返回——
 * 这一层只做「认得出来的就抹掉」，认不出来的交给秘密表。
 */
export function redactUrl(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url
  }
  let touched = false
  for (const [name] of [...parsed.searchParams]) {
    if (!URL_SECRET_PARAMS.includes(name.toLowerCase())) continue
    parsed.searchParams.set(name, REDACTED_URL_PARAM)
    touched = true
  }
  if (!touched) return url
  // `searchParams.set` 会把占位符里的方括号转义成 %5B…%5D，读起来像乱码；换回来
  return parsed.toString().replace(/%5Bredacted%3Aurl_token%5D/gi, REDACTED_URL_PARAM)
}

/** 一段文本里的每条 URL 都过 {@link redactUrl}。 */
export function redactUrlsIn(text: string): string {
  return text.replace(URL_IN_TEXT, (m) => redactUrl(m))
}

/** 单段文本的出站脱敏（通道决定要不要额外抹 URL）。 */
function redactText(channel: OutboundChannel, text: string): string {
  const withoutUrlTokens = channel === 'tool_result' ? redactUrlsIn(text) : text
  return scrub(withoutUrlTokens).text
}

/**
 * 出站脱敏（31 §3.3 的统一入口）。
 *
 * 字符串进、字符串出；对象 / 数组**深走一遍**，每个字符串叶子与每个键都过同一道
 * ——键上也可能挂着秘密（`{ "sk-live-…": 1 }` 这种形状不常见但不是不可能）。
 * 其余标量原样返回：数字与布尔里没有秘密，把它们变成字符串只会让下游解析炸掉。
 *
 * 返回类型故意是 `unknown`：调用方拿到的是「已经过了脱敏的那一份」，
 * 想当字符串用就传字符串进来（见 {@link redactOutboundText}）。
 */
export function redactOutbound(channel: OutboundChannel, value: unknown): unknown {
  if (typeof value === 'string') return redactText(channel, value)
  if (Array.isArray(value)) return value.map((v) => redactOutbound(channel, v))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[redactText(channel, k)] = redactOutbound(channel, v)
    }
    return out
  }
  return value
}

/** 只发文本的通道（回信正文、卡片摘要、answer）用这个，省一次 `as string`。 */
export function redactOutboundText(channel: OutboundChannel, text: string): string {
  return redactText(channel, text)
}
