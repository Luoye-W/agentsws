/**
 * WP228：一个起好的只读浏览器会话——只有「打开一页、读回来」这一个动作。
 *
 * 驱动层的只读闸都在这里装：每次读页面开一个一次性的上下文（不开页面脚本、不收下载、
 * 挡掉 Service Worker），所有请求先过 `requestVerdict`（只放白名单站的 GET 页面），读完就关上下文。
 * 这里**没有**点击、输入、提交的方法——想加也得先改这个文件，审核看得见。
 */
import { chromium } from 'playwright-core'
import { type ChromeMode, spawnChrome } from './chrome.js'
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

/** WP246：这一页怎么读。 */
export interface ReadPageOptions {
  /**
   * 用这份用户数据目录**自己的**登录态（读号）读：开在浏览器的默认上下文里（带着读号的 cookie），
   * 页面脚本照样关、只读闸照样装。不给 = WP228 原来的一次性上下文（什么登录态都不带）。
   */
  profile?: boolean
}

export interface BrowserSession {
  readPage(
    url: string,
    args: ExtractArgs,
    allowedHosts: readonly string[],
    options?: ReadPageOptions,
  ): Promise<PageRead>
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
  /** WP246：无头 / 有头最小化（缺省无头）。 */
  mode?: ChromeMode
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
  const minimized = input.mode === 'minimized'
  if (input.mode !== undefined && input.mode !== 'headless') {
    // 有头：不收任何下载（无头那一档靠一次性上下文的 acceptDownloads: false）
    const bcdp = await browser.newBrowserCDPSession().catch(() => undefined)
    await bcdp?.send('Browser.setDownloadBehavior', { behavior: 'deny' }).catch(() => undefined)
  }
  return {
    async readPage(url, args, allowedHosts, opts) {
      const useProfile = opts?.profile === true
      const shared = useProfile ? browser.contexts()[0] : undefined
      const ctx =
        shared ??
        (await browser.newContext({
          javaScriptEnabled: false,
          acceptDownloads: false,
          serviceWorkers: 'block',
        }))
      const page = await ctx.newPage()
      try {
        let offSite: string | undefined
        /*
         * 闸装在 CDP 的 Fetch 一层而不是 Playwright 的 route：route 拦不到跳转的下一跳（302 到白名单外
         * 的站照样会发出去——本地假站点实测抓到过），Fetch 每一跳都停下来问一次。
         */
        const cdp = await ctx.newCDPSession(page)
        if (shared !== undefined) {
          // WP246：默认上下文没有「关脚本 / 挡 Service Worker」的上下文开关——在这一页上用 CDP 关
          await cdp.send('Emulation.setScriptExecutionDisabled', { value: true })
          await cdp.send('Network.enable')
          await cdp.send('Network.setBypassServiceWorker', { bypass: true })
        }
        if (minimized) {
          // 有头最小化：新开的这一页所在窗口收到最小化（不抢焦点、不挡人）
          const { windowId } = await cdp.send('Browser.getWindowForTarget')
          await cdp
            .send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } })
            .catch(() => undefined)
        }
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
        // 读号那一档：只关这一页，上下文（登录态）留着；一次性上下文整个关掉
        if (shared !== undefined) await page.close().catch(() => undefined)
        else await ctx.close().catch(() => undefined)
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
      // mac / Linux：主进程退了再扫一遍这一组，辅助进程一个不留
      if (input.platform !== 'win32') chrome.killNow()
      chrome.forgetPid()
    },
    killNow: () => chrome.killNow(),
    pid: chrome.child.pid,
  }
}
