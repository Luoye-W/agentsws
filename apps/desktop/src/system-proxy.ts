/**
 * 10-16 内测：Windows 上开着代理软件「全局 / 系统代理」，用 ChatGPT 订阅登录时浏览器那一步成功，
 * 工坊却报 `unsupported_country_region_territory`（403）。原因：系统代理只写在操作系统设置里，不在环境变量里；
 * 浏览器（Chromium）认系统代理，服务进程（Node）只认 `HTTPS_PROXY` 这类环境变量，于是换令牌那一跳直连出境被拒。
 *
 * 做法：壳用 Chromium 自己的判断（`session.resolveProxy`）问「去这个地址走哪个代理」，把结果换成
 * `HTTP_PROXY` / `HTTPS_PROXY` 交给服务进程，再加 `NODE_USE_ENV_PROXY=1`（Node 22.21+ 的内置 fetch 才认）。
 * 环境里本来就有代理变量的不覆盖；本机地址一律不走代理。SOCKS 代理 Node 不认，照实不给（日志里说一句）。
 */

/** Chromium `resolveProxy` 的返回（`PROXY h:p; DIRECT` 这类 PAC 写法）→ 给 Node 的代理地址。 */
export function proxyUrlFromResolution(resolution: string): string | undefined {
  for (const part of resolution.split(';')) {
    const [kind, hostPort] = part.trim().split(/\s+/)
    if (kind === undefined || hostPort === undefined) continue
    const k = kind.toUpperCase()
    if (k === 'PROXY' || k === 'HTTP') return `http://${hostPort}`
    if (k === 'HTTPS') return `https://${hostPort}`
    // SOCKS / SOCKS4 / SOCKS5：Node 的环境代理不支持，跳过看下一个
  }
  return undefined
}

const PROXY_VARS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
]
const LOCAL_NO_PROXY = ['127.0.0.1', 'localhost', '::1']

/**
 * 给服务进程的代理环境。`base` 是已经继承下来的环境；`systemProxy` 是上面解析出来的地址。
 * 返回要**追加**的变量（不改 base）。
 */
export function proxyEnvFor(
  base: Readonly<Record<string, string | undefined>>,
  systemProxy: string | undefined,
): Record<string, string> {
  const hasEnvProxy = PROXY_VARS.some((k) => (base[k] ?? '') !== '')
  const out: Record<string, string> = {}
  if (!hasEnvProxy && systemProxy !== undefined) {
    out.HTTP_PROXY = systemProxy
    out.HTTPS_PROXY = systemProxy
  }
  if (hasEnvProxy || systemProxy !== undefined) {
    const existing = (base.NO_PROXY ?? base.no_proxy ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '')
    out.NO_PROXY = [...new Set([...existing, ...LOCAL_NO_PROXY])].join(',')
    out.NODE_USE_ENV_PROXY = '1'
  }
  return out
}
