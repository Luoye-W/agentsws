/**
 * WP228：一个起好的只读浏览器会话——只有「打开一页、读回来」这一个动作。
 *
 * 驱动层的只读闸都在这里装：每次读页面开一个一次性的上下文（不开页面脚本、不收下载、
 * 挡掉 Service Worker），所有请求先过 `requestVerdict`（只放白名单站的 GET 页面），读完就关上下文。
 * 这里**没有**点击、输入、提交的方法——想加也得先改这个文件，审核看得见。
 */
import { chromium } from 'playwright-core'
import { spawnChrome } from './chrome.js'
import { type ExtractArgs, type ExtractResult, extractRedditPage } from './extract.js'
import type { Env } from './find-browser.js'
import { requestVerdict } from './guard.js'

export interface PageRead {
  /** 主文档的 HTTP 状态码（没拿到回 0）。 */
  status: number
  finalUrl: string
  /** 429 带的 Retry-After（毫秒）。 */
  retryAfterMs?: number
  /** 主页面想跳去白名单外的地址（被掐了）。 */
  offSite?: string
  extract?: ExtractResult
}

export interface BrowserSession {
  readPage(url: string, args: ExtractArgs, allowedHosts: readonly string[]): Promise<PageRead>
  close(): Promise<void>
  /** 进程退出的最后一刻同步结束浏览器（不等）。 */
  killNow(): void
  /** 浏览器主进程号（查有没有残留用）。 */
  readonly pid?: number | undefined
}

export type SessionLauncher = (input: {
  executable: string
  profileDir: string
  platform: NodeJS.Platform
  env: Env
}) => Promise<BrowserSession>

const NAV_TIMEOUT_MS = 30_000
const CLOSE_GRACE_MS = 3_000

const retryAfterOf = (v: string | undefined): number | undefined => {
  if (v === undefined) return undefined
  const s = Number(v)
  if (Number.isFinite(s)) return Math.max(0, s * 1000)
  const at = Date.parse(v)
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined
}

/** 默认的会话：自己起浏览器进程，`playwright-core` 经 CDP 连上去。 */
export const launchChromeSession: SessionLauncher = async (input) => {
  const chrome = await spawnChrome(input)
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>>
  try {
    browser = await chromium.connectOverCDP(chrome.endpoint, { timeout: 15_000 })
  } catch (err) {
    chrome.killNow()
    throw new Error(`连不上起好的浏览器：${err instanceof Error ? err.message : String(err)}`)
  }
  return {
    async readPage(url, args, allowedHosts) {
      const ctx = await browser.newContext({
        javaScriptEnabled: false,
        acceptDownloads: false,
        serviceWorkers: 'block',
      })
      try {
        const page = await ctx.newPage()
        let offSite: string | undefined
        /*
         * 闸装在 CDP 的 Fetch 一层而不是 Playwright 的 route：route 拦不到跳转的下一跳（302 到白名单外
         * 的站照样会发出去——本地假站点实测抓到过），Fetch 每一跳都停下来问一次。
         */
        const cdp = await ctx.newCDPSession(page)
        const main = (await cdp.send('Page.getFrameTree')).frameTree.frame.id
        cdp.on('Fetch.requestPaused', (e) => {
          const v = requestVerdict(
            {
              method: e.request.method,
              url: e.request.url,
              resourceType: e.resourceType.toLowerCase(),
            },
            allowedHosts,
          )
          if (v.allow) {
            void cdp
              .send('Fetch.continueRequest', { requestId: e.requestId })
              .catch(() => undefined)
            return
          }
          if (e.resourceType === 'Document' && e.frameId === main) offSite = e.request.url
          void cdp
            .send('Fetch.failRequest', { requestId: e.requestId, errorReason: 'BlockedByClient' })
            .catch(() => undefined)
        })
        await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] })
        let res: Awaited<ReturnType<typeof page.goto>> = null
        try {
          res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS })
        } catch (err) {
          if (offSite !== undefined) return { status: 0, finalUrl: offSite, offSite }
          throw err
        }
        if (offSite !== undefined) return { status: 0, finalUrl: offSite, offSite }
        const status = res?.status() ?? 0
        const retryAfterMs = retryAfterOf(res?.headers()['retry-after'])
        const extract = await page.evaluate(extractRedditPage, args)
        return {
          status,
          finalUrl: page.url(),
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
          extract,
        }
      } finally {
        await ctx.close().catch(() => undefined)
      }
    },
    async close() {
      // 先礼后兵：请浏览器自己退，3 秒没退按进程树结束
      const exited = new Promise<void>((resolve) => {
        if (chrome.child.exitCode !== null || chrome.child.signalCode !== null) resolve()
        else chrome.child.once('exit', () => resolve())
      })
      try {
        const cdp = await browser.newBrowserCDPSession()
        await cdp.send('Browser.close').catch(() => undefined)
      } catch {
        // 连接已经断了：直接走下面的强杀
      }
      const timer = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), CLOSE_GRACE_MS))
      if ((await Promise.race([exited.then(() => 'exited' as const), timer])) === 'timeout') {
        chrome.kill()
        await Promise.race([exited, new Promise((r) => setTimeout(r, CLOSE_GRACE_MS))])
      }
      await browser.close().catch(() => undefined)
      chrome.forgetPid()
    },
    killNow: () => chrome.killNow(),
    pid: chrome.child.pid,
  }
}
