/**
 * 下载页读的清单 `src/data/downloads.json`：版本、平台、链接、sha256、大小。
 * 托管位置上线前由 Fable 定；这里只管「清单长得对不对」与「怎么显示」。
 */

export interface DownloadItem {
  id: string
  file: string
  /** 还没定托管位置时为 null：页面显示「即将提供」，不给一个点了没用的链接。 */
  url: string | null
  sha256: string | null
  /** 字节。 */
  size: number | null
}

export interface DesktopItem extends DownloadItem {
  os: 'mac' | 'win'
  arch: 'arm64' | 'x64'
}

export interface ExtensionItem extends DownloadItem {
  version: string
  browsers: string[]
}

export interface DownloadManifest {
  version: string
  channel: string
  released: string | null
  desktop: DesktopItem[]
  extension: ExtensionItem
}

/** 清单的毛病（空数组 = 没毛病）。给了链接就必须同时给 sha256（64 位十六进制）与大小，且只认 https。 */
export function manifestProblems(m: DownloadManifest): string[] {
  const out: string[] = []
  if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/u.test(m.version)) out.push(`版本号不像 semver：${m.version}`)
  const items: DownloadItem[] = [...m.desktop, m.extension]
  const ids = new Set<string>()
  for (const it of items) {
    if (ids.has(it.id)) out.push(`重复的 id：${it.id}`)
    ids.add(it.id)
    if (it.url === null) continue
    if (!it.url.startsWith('https://')) out.push(`${it.id}：链接要 https`)
    if (it.sha256 === null || !/^[0-9a-f]{64}$/u.test(it.sha256))
      out.push(`${it.id}：有链接就要有 sha256（64 位小写十六进制）`)
    if (it.size === null || !Number.isInteger(it.size) || it.size <= 0)
      out.push(`${it.id}：有链接就要有大小（字节）`)
  }
  for (const want of ['mac-arm64', 'mac-x64', 'win-x64'])
    if (!m.desktop.some((d) => d.id === want)) out.push(`缺 ${want}`)
  return out
}

/** 字节 → 「128 MB」。 */
export function formatSize(bytes: number | null): string {
  if (bytes === null) return '—'
  if (bytes >= 1024 * 1024)
    return `${(bytes / 1024 / 1024).toFixed(bytes >= 100 * 1024 * 1024 ? 0 : 1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}
