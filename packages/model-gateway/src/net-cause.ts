/**
 * WP242：Node 的 `fetch` 打不通时只抛一句笼统的 `fetch failed`，真原因在 `cause` 链上
 * （`ECONNRESET` / `ENOTFOUND` / `UND_ERR_CONNECT_TIMEOUT` / `CERT_HAS_EXPIRED` / 自签证书……）。
 * 以前 provider 只记 `e.message`，`model.provider_down` 里就只剩「fetch failed」——
 * 真机上（Windows + 代理）排查时什么都看不出来。这里把原因挖出来，拼进那一行。
 *
 * 只取错误码与系统调用名、以及 cause 自己那一句（不含请求头 / 正文，不会带出令牌）。
 */

/** 一次网络层失败的原因（挖不出就是空）。 */
export interface NetCause {
  /** 第一个挖到的错误码（`ECONNRESET`、`UND_ERR_SOCKET`……）。 */
  code?: string
  /** 给人看的一小段：`ECONNRESET read ECONNRESET`；挖不出就是 `undefined`。 */
  detail?: string
}

/** 网络层、值得**马上再试一次**的那几种（连接被对面 / 代理掐了、陈旧的长连接）。 */
const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'EPIPE',
  'ECONNABORTED',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
  'EAI_AGAIN',
])

interface ErrLike {
  code?: unknown
  syscall?: unknown
  message?: unknown
  cause?: unknown
  errors?: unknown
}

/** 沿 `cause`（以及 `AggregateError.errors`）往下挖，最多几层。 */
export function netCauseOf(err: unknown): NetCause {
  const codes: string[] = []
  const parts: string[] = []
  const seen = new Set<unknown>()
  const visit = (cur: unknown, depth: number): void => {
    if (cur === undefined || cur === null || depth > 4 || seen.has(cur)) return
    seen.add(cur)
    const rec = cur as ErrLike
    if (depth > 0) {
      const code = typeof rec.code === 'string' ? rec.code : undefined
      if (code !== undefined && !codes.includes(code)) codes.push(code)
      const msg = typeof rec.message === 'string' ? rec.message.trim() : ''
      const piece = [code, msg !== '' && msg !== code ? msg : undefined]
        .filter((x): x is string => x !== undefined && x !== '')
        .join(' ')
      if (piece !== '' && !parts.includes(piece)) parts.push(piece)
    }
    if (Array.isArray(rec.errors)) for (const e of rec.errors.slice(0, 3)) visit(e, depth + 1)
    visit(rec.cause, depth + 1)
  }
  visit(err, 0)
  const detail = parts.join('; ').slice(0, 240)
  return {
    ...(codes[0] === undefined ? {} : { code: codes[0] }),
    ...(detail === '' ? {} : { detail }),
  }
}

/** 这一下网络失败是不是「马上再试一次大概率就好」的那种。 */
export function isTransientNetError(err: unknown): boolean {
  const { code } = netCauseOf(err)
  return code !== undefined && TRANSIENT_CODES.has(code)
}

/** `fetch failed` → `fetch failed (ECONNRESET read ECONNRESET)`；挖不出原因就原样。 */
export function describeFetchError(err: unknown): string {
  const base = err instanceof Error ? err.message : String(err)
  const { detail } = netCauseOf(err)
  return detail === undefined ? base : `${base} (${detail})`
}
