/**
 * WP381 ②：渲染对比用的「开 JS 看一眼」——**只开自己网站的页**，读完就关。
 *
 * 与只读浏览器（WP228，给 Reddit 用、页面脚本关着）分开：这里要的恰恰是脚本跑完之后的样子。
 * 所以闸换了一套，但同样只读：
 *
 * - 一次性的用户数据目录（临时目录，读完删掉）、一次性上下文、不收下载、挡 Service Worker；
 * - 只发 GET；主页面跳出我们自己的域名就掐掉（子资源——主题脚本、CDN——照放，不然渲染不出来）；
 * - 每页最多等 20 秒（网络空闲或超时就取当时的 DOM）；
 * - 用的是这台电脑上已有的 Chrome / Edge（找不到就抛 `'no_browser'`，体检照实记「没比渲染后」）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { spawnChrome } from './readonly-browser/chrome.js'
import { type Env, findBrowser } from './readonly-browser/find-browser.js'
import type { PageRenderer } from './site-health.js'

const PAGE_TIMEOUT_MS = 20_000

const ownHost = (url: string, hosts: readonly string[]): boolean => {
  try {
    const h = new URL(url).hostname.toLowerCase()
    return hosts.some((x) => h === x || h.endsWith(`.${x}`) || `www.${h}` === x || h === `www.${x}`)
  } catch {
    return false
  }
}

export function createChromeRenderer(options: {
  platform?: NodeJS.Platform
  env?: Env
  /** 用户在设置里指定的浏览器。 */
  executable?: () => string | undefined
}): PageRenderer {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  return {
    async render(urls, ownHosts) {
      const found = findBrowser({ platform, env, preferred: options.executable?.() })
      if (!found.ok) throw 'no_browser'
      const out = new Map<string, string>()
      const targets = urls.filter((u) => ownHost(u, ownHosts))
      if (targets.length === 0) return out
      const profileDir = mkdtempSync(join(tmpdir(), 'agentsws-site-health-'))
      const chrome = await spawnChrome({ executable: found.executable, profileDir, platform, env })
      try {
        const browser = await chromium.connectOverCDP(chrome.endpoint, { timeout: 15_000 })
        try {
          const ctx = await browser.newContext({ acceptDownloads: false, serviceWorkers: 'block' })
          await ctx.route('**/*', (route) => {
            const req = route.request()
            if (req.method() !== 'GET') return route.abort('blockedbyclient')
            if (
              req.isNavigationRequest() &&
              req.frame() === req.frame().page().mainFrame() &&
              !ownHost(req.url(), ownHosts)
            )
              return route.abort('blockedbyclient')
            return route.continue()
          })
          for (const url of targets) {
            const page = await ctx.newPage()
            try {
              await page
                .goto(url, { waitUntil: 'networkidle', timeout: PAGE_TIMEOUT_MS })
                .catch(() => undefined)
              out.set(url, await page.content())
            } catch {
              // 这一页没渲染成：不给，体检那一行照「没比渲染后」
            } finally {
              await page.close().catch(() => undefined)
            }
          }
          await ctx.close().catch(() => undefined)
        } finally {
          await browser.close().catch(() => undefined)
        }
      } finally {
        chrome.kill()
        chrome.forgetPid()
        try {
          rmSync(profileDir, { recursive: true, force: true })
        } catch {
          // 浏览器还没完全退出（Windows 上常见）：临时目录留给系统清
        }
      }
      return out
    },
  }
}
