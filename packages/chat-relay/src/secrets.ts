/**
 * 转发器的密钥纪律（WP137，P0 安全修复）。
 *
 * 访客令牌 = `HMAC(访客密钥, 工作区:会话)`。只要访客密钥能被外人算出来，
 * 就能伪造任意访客令牌、读别人的聊天——所以三种形态一条规矩：
 * **没有真密钥就拒绝服务，绝不兜底**。「真密钥」= 部署方给的（或宿主自己随机生成、
 * 存在自己卷里的）、至少 32 字节的一串；从工作区号、写死的常量推出来的都不算。
 */

/** 访客密钥最短多少字节（UTF-8 计）。`openssl rand -base64 32` 出来是 44 个字符。 */
export const MIN_RELAY_SECRET_BYTES = 32

/** 这把密钥能不能用：配了、去掉首尾空白后至少 32 字节。 */
export function relaySecretReady(value: string | undefined): value is string {
  if (value === undefined) return false
  return new TextEncoder().encode(value.trim()).length >= MIN_RELAY_SECRET_BYTES
}

/** 访客面拒绝服务时回给浏览器的那句（不说缺哪把密钥——那是给运维看的，进日志）。 */
export const RELAY_UNAVAILABLE = {
  code: 'relay_unavailable',
  message: '聊天窗暂时不可用，请稍后再试。',
} as const

/** 没签发留言密钥时回给留言表单的那句。 */
export const OFFLINE_UNAVAILABLE = {
  code: 'offline_unavailable',
  message: '商家还没完成配对，暂时不能留言。',
} as const

/** 访客面 503（三种形态同一个形状：`{ error: { code, message } }`）。 */
export function relayUnavailableResponse(): Response {
  return Response.json(
    { error: RELAY_UNAVAILABLE },
    { status: 503, headers: { 'retry-after': '300', 'access-control-allow-origin': '*' } },
  )
}
