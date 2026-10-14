/**
 * {@link TabDriver} 真的那一个：`chrome.tabs` / `chrome.scripting` / `chrome.downloads`。
 *
 * 没有测试覆盖这一层（它只是把调用转给浏览器）；行为测试在 `tab-page` 与执行器那一层用假的驱动做。
 * 真浏览器里的走法见 `scripts/e2e-ext-actions.mjs`（本地假后台，不碰真站）。
 */

import type { DomOpResult } from '@agentsws/browser-action'
import type { AdsDomRequest, AdsDomResponse, BannerState } from './dom-messages'
import type { DownloadDone, TabDriver, TabFacts } from './tab-page'

/** 页面脚本打包出来的位置（`entrypoints/ads.content.ts`，运行时注册，不进清单）。 */
export const ADS_CONTENT_SCRIPT = 'content-scripts/ads.js'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export function chromeTabDriver(tabId: number): TabDriver {
  return {
    async facts(): Promise<TabFacts | undefined> {
      try {
        const t = await chrome.tabs.get(tabId)
        return { url: t.url ?? '', status: t.status, active: t.active, windowId: t.windowId }
      } catch {
        return undefined
      }
    },
    async navigate(url) {
      await chrome.tabs.update(tabId, { url })
    },
    async activate() {
      const t = await chrome.tabs.update(tabId, { active: true })
      if (t !== undefined) await chrome.windows.update(t.windowId, { focused: true })
    },
    async inject() {
      await chrome.scripting.executeScript({ target: { tabId }, files: [ADS_CONTENT_SCRIPT] })
    },
    async dom(req: AdsDomRequest): Promise<AdsDomResponse> {
      return (await chrome.tabs.sendMessage(tabId, req)) as AdsDomResponse
    },
    async banner(state: BannerState | null) {
      try {
        await chrome.tabs.sendMessage(tabId, { type: 'ads-banner', state })
      } catch {
        // 页面正在换：下一页放脚本时会再画一次
      }
    },
    capture(windowId) {
      return chrome.tabs.captureVisibleTab(windowId, { format: 'png' })
    },
    downloadsAllowed() {
      return chrome.permissions.contains({ permissions: ['downloads'] })
    },
    async watchDownload(
      click: () => Promise<DomOpResult>,
      timeoutMs: number,
    ): Promise<({ ok: true } & DownloadDone) | { ok: false; why: string }> {
      let createdId: number | undefined
      const onCreated = (item: chrome.downloads.DownloadItem): void => {
        if (createdId === undefined) createdId = item.id
      }
      chrome.downloads.onCreated.addListener(onCreated)
      try {
        const clicked = await click()
        if (!clicked.ok) return clicked
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
          if (createdId !== undefined) {
            const [item] = await chrome.downloads.search({ id: createdId })
            if (item?.state === 'complete')
              return {
                ok: true,
                path: item.filename,
                name: item.filename.split(/[\\/]/u).pop() ?? item.filename,
                ...(item.fileSize >= 0 ? { bytes: item.fileSize } : {}),
              }
            if (item?.state === 'interrupted')
              return { ok: false, why: '导出的文件没下完（下载中断了）。' }
          }
          await sleep(500)
        }
        return { ok: false, why: '点了导出，但等不到文件下完。' }
      } finally {
        chrome.downloads.onCreated.removeListener(onCreated)
      }
    },
    sleep,
  }
}
