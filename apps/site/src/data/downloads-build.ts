/**
 * WP218：构建时取一次下载清单（中英两套页面共用）。取不到用仓库里那份；
 * `AGENTSWS_SITE_OFFLINE=1` 时不打网。
 */
import { DOWNLOADS_URL } from '../config.js'
import { type DownloadManifest, type DownloadsSource, loadDownloads } from '../lib/downloads.js'
import repoManifest from './downloads.json'

let once: Promise<{ source: DownloadsSource; manifest: DownloadManifest }> | undefined

export function buildDownloads(): Promise<{ source: DownloadsSource; manifest: DownloadManifest }> {
  once ??= loadDownloads({
    url: DOWNLOADS_URL,
    fallback: repoManifest as unknown as DownloadManifest,
    offline: process.env.AGENTSWS_SITE_OFFLINE === '1',
  }).then((d) => {
    console.log(
      `[site] 下载清单：${d.source === 'feed' ? `下载站 ${DOWNLOADS_URL}` : '仓库里那份'}（${d.manifest.version}）`,
    )
    return d
  })
  return once
}
