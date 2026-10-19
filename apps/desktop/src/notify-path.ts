/**
 * WP429：系统通知点了去哪——只认工作台里的地址（`/` 开头、不带协议、不是 `//` 开头），
 * 别的一律不认（不让页面借系统通知把窗口带到外面去）。
 */
export function notificationPathOf(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const path = raw.trim()
  if (path === '' || path.length > 2048) return undefined
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) return undefined
  for (let i = 0; i < path.length; i += 1) if (path.charCodeAt(i) < 0x20) return undefined
  return path
}
