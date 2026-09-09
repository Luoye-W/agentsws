/**
 * URL 拦截判定（13 §5「不加载远程内容」）。
 *
 * 窗口里只准出现本地服务进程的源；其余 http(s) 交给系统浏览器；
 * 其它协议（`file:` `javascript:` `data:` `ms-msdt:` …）一律拒绝——
 * `shell.openExternal` 拿到这些协议是能被用来执行本机命令的，所以外链也要过白名单。
 */

export type NavigationDecision =
  | { action: 'allow' }
  | { action: 'external'; url: string }
  | { action: 'deny'; reason: string }

const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

export function parseUrl(raw: string): URL | undefined {
  try {
    return new URL(raw)
  } catch {
    return undefined
  }
}

/** `http://127.0.0.1:4317` → `http://127.0.0.1:4317`（`URL.origin` 规范化）。 */
export function originOf(raw: string): string | undefined {
  return parseUrl(raw)?.origin
}

export function isLocalOrigin(raw: string, allowedOrigins: readonly string[]): boolean {
  const url = parseUrl(raw)
  if (url === undefined) return false
  return allowedOrigins.includes(url.origin)
}

/** 只有这几种协议允许交给系统浏览器。 */
export function isSafeExternal(raw: string): boolean {
  const url = parseUrl(raw)
  if (url === undefined) return false
  return EXTERNAL_PROTOCOLS.has(url.protocol)
}

/** `will-navigate`：本地放行，外链走系统浏览器，其余拒绝。 */
export function decideNavigation(
  raw: string,
  allowedOrigins: readonly string[],
): NavigationDecision {
  const url = parseUrl(raw)
  if (url === undefined) return { action: 'deny', reason: `不是合法 URL：${raw}` }
  if (allowedOrigins.includes(url.origin)) return { action: 'allow' }
  if (isSafeExternal(raw)) return { action: 'external', url: url.toString() }
  return { action: 'deny', reason: `不允许的协议：${url.protocol}` }
}

/**
 * `setWindowOpenHandler`：永远不新开 BrowserWindow。
 * 本地链接 `allow` 表示"在当前窗口里加载"，外链交系统浏览器。
 */
export function decideWindowOpen(
  raw: string,
  allowedOrigins: readonly string[],
): NavigationDecision {
  return decideNavigation(raw, allowedOrigins)
}
