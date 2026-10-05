/** WP218：官网构建时取下载站上的最新清单；取不到 / 写坏了退回仓库那份。 */
import { describe, expect, it } from 'vitest'
import { DOWNLOADS_URL } from '../src/config.js'
import repo from '../src/data/downloads.json'
import { type DownloadManifest, directWindowsUrl, loadDownloads } from '../src/lib/downloads.js'

const fallback = repo as unknown as DownloadManifest
const fresh: DownloadManifest = {
  ...fallback,
  version: '0.2.0-beta.1',
  desktop: fallback.desktop.map((d) =>
    d.id === 'win-x64'
      ? {
          ...d,
          file: 'Agents-Workshop-Setup-0.2.0-beta.1-x64.exe',
          url: 'https://dl.agentsws.com/beta/Agents-Workshop-Setup-0.2.0-beta.1-x64.exe',
          sha256: 'a'.repeat(64),
          size: 100,
        }
      : d,
  ),
}
const reply = (status: number, body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

describe('loadDownloads', () => {
  it('下载站上的清单合格就用它', async () => {
    const d = await loadDownloads({ url: DOWNLOADS_URL, fallback, fetchImpl: reply(200, fresh) })
    expect(d).toEqual({ source: 'feed', manifest: fresh })
    expect(DOWNLOADS_URL).toBe('https://dl.agentsws.com/downloads.json')
  })

  it('离线 / 非 200 / 形状不对 / 有链接没 sha256 / 网断：一律用仓库那份', async () => {
    const cases = [
      loadDownloads({ url: DOWNLOADS_URL, fallback, offline: true }),
      loadDownloads({ url: DOWNLOADS_URL, fallback, fetchImpl: reply(404, {}) }),
      loadDownloads({ url: DOWNLOADS_URL, fallback, fetchImpl: reply(200, { version: 1 }) }),
      loadDownloads({ url: DOWNLOADS_URL, fallback, fetchImpl: reply(200, null) }),
      loadDownloads({
        url: DOWNLOADS_URL,
        fallback,
        fetchImpl: reply(200, {
          ...fresh,
          desktop: fresh.desktop.map((d) => ({ ...d, sha256: null })),
        }),
      }),
      loadDownloads({
        url: DOWNLOADS_URL,
        fallback,
        fetchImpl: (async () => {
          throw new Error('ENOTFOUND')
        }) as unknown as typeof fetch,
      }),
    ]
    for (const d of await Promise.all(cases))
      expect(d).toEqual({ source: 'repo', manifest: fallback })
  })

  it('首页按钮：Windows 有链接就直链，没有就 null（留在下载页）', () => {
    expect(directWindowsUrl(fresh)).toBe(
      'https://dl.agentsws.com/beta/Agents-Workshop-Setup-0.2.0-beta.1-x64.exe',
    )
    expect(directWindowsUrl(fallback)).toBeNull()
  })
})
