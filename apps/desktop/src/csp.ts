/**
 * CSP：只允许 self（13 §5「不加载远程内容」）。
 *
 * 页面本身由本地服务进程提供，同源即工作台自己的资源；剩下的全封。
 * 头是主进程在 `onHeadersReceived` 里**覆盖**上去的，即使服务端忘了发也有这一道。
 */

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')

/** 大小写不敏感地去掉已有的 CSP 头，再写上我们这份。 */
export function withCsp(
  headers: Readonly<Record<string, string[] | string>>,
  policy: string = CONTENT_SECURITY_POLICY,
): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase()
    if (lower === 'content-security-policy' || lower === 'content-security-policy-report-only')
      continue
    out[key] = Array.isArray(value) ? [...value] : [value]
  }
  out['Content-Security-Policy'] = [policy]
  return out
}
