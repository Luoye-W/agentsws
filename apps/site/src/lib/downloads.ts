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

export type DownloadsSource = 'feed' | 'repo'

export interface LoadDownloadsOptions {
  url: string
  /** 仓库里那份（`src/data/downloads.json`）：取不到、不合格时用它。 */
  fallback: DownloadManifest
  fetchImpl?: typeof fetch
  timeoutMs?: number
  /** 不打网（离线构建、测试）。 */
  offline?: boolean
}

function looksLikeManifest(v: unknown): v is DownloadManifest {
  if (typeof v !== 'object' || v === null) return false
  const m = v as Partial<DownloadManifest>
  return (
    typeof m.version === 'string' &&
    typeof m.channel === 'string' &&
    Array.isArray(m.desktop) &&
    typeof m.extension === 'object' &&
    m.extension !== null
  )
}

/**
 * WP218：构建时取下载站上的最新清单。取到了还要过一遍 `manifestProblems`——
 * 下载站上一份写坏的清单不该让官网挂掉，也不该把坏链接发出去：不合格就退回仓库那份。
 */
export async function loadDownloads(
  o: LoadDownloadsOptions,
): Promise<{ source: DownloadsSource; manifest: DownloadManifest }> {
  const fallback = { source: 'repo' as const, manifest: o.fallback }
  if (o.offline === true) return fallback
  try {
    const res = await (o.fetchImpl ?? fetch)(o.url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(o.timeoutMs ?? 8000),
    })
    if (!res.ok) return fallback
    const body: unknown = await res.json()
    if (!looksLikeManifest(body) || manifestProblems(body).length > 0) return fallback
    return { source: 'feed', manifest: body }
  } catch {
    return fallback
  }
}

/** 首页「下载」按钮：Windows 访客直接拿最新安装包（有链接时），其余去下载页挑（mac 分不清芯片）。 */
export function directWindowsUrl(m: DownloadManifest): string | null {
  return m.desktop.find((d) => d.id === 'win-x64')?.url ?? null
}
