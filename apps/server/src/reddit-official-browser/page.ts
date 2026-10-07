/**
 * WP249：自动化用的那一个标签页——**驱动层的闸都在这里装**。
 *
 * - 网络闸（CDP Fetch 一层，每一跳都停下来问；WP228 实测过 Playwright 的 route 拦不到跳转的下一跳）：
 *   白名单外的站一律掐；**写请求**（POST / PUT / DELETE …）只放这一个动作需要的那几个路径
 *   （`postAllowed`）；读的时候一个写请求都不放。被掐掉的写请求记下来，测试据此断言。
 * - 这个对象只有 `goto` / `click` / `fill` 与几个读的方法——**没有**「执行任意脚本」「点任意坐标」。
 *   哪一步能做由 `runner.ts` 先问 `stepAllowed`（按审批卡上那一个动作算），这里只是手。
 * - 不读 cookie、不导出登录态；页面里那几段读取脚本只数元素、取文字。
 */
import { hostAllowed } from '@agentsws/contracts'
import { postAllowed, type RedditBrowserPlan } from '@agentsws/social-core'
import type { BrowserContext, CDPSession, Page } from 'playwright-core'
import { hostOf } from '../readonly-browser/guard.js'

export interface PageGoto {
  status: number
  finalUrl: string
  retryAfterMs?: number
  /** 主页面想跳去白名单外（被掐了）。 */
  offSite?: string
}

/** 页面上数出来的几样迹象（认登录态、认验证码 / 拦截页）。 */
export interface PageLook {
  loggedIn: boolean
  username?: string
  title: string
  text: string
  frameSources: string[]
}

/** HTML 退路时从 `div.thing` 上读回来的一条（old.reddit 的 `data-*` 属性）。 */
export interface RawThing {
  fullname: string
  type: string
  author: string
  subreddit: string
  permalink: string
  timestamp?: number
  title?: string
  body?: string
  reports: string[]
}

export interface AutomationPage {
  goto(url: string): Promise<PageGoto>
  look(): Promise<PageLook>
  bodyText(): Promise<string>
  things(): Promise<RawThing[]>
  click(selector: string): Promise<void>
  fill(selector: string, value: string): Promise<void>
  count(selector: string): Promise<number>
  /** 等这个元素出现（页面刚跳转 / 脚本刚插进来）；等不到回假。 */
  waitFor(selector: string): Promise<boolean>
  textOf(selector: string): Promise<string>
  url(): string
  /** 被网络闸掐掉的写请求（`POST /api/vote` 这种）。 */
  blockedWrites(): string[]
  close(): Promise<void>
}

const NAV_TIMEOUT_MS = 30_000
const STEP_TIMEOUT_MS = 10_000

const retryAfterOf = (v: string | undefined): number | undefined => {
  if (v === undefined) return undefined
  const s = Number(v)
  return Number.isFinite(s) ? Math.max(0, s * 1000) : undefined
}

/**
 * 在这个浏览器的默认上下文（登录态在这里）开一个标签页并装好闸。`plan` 不给 = 只读（一个写请求都不放）。
 */
export async function openAutomationPage(
  ctx: BrowserContext,
  allowedHosts: readonly string[],
  plan?: RedditBrowserPlan,
): Promise<AutomationPage> {
  const page: Page = await ctx.newPage()
  const blocked: string[] = []
  let offSite: string | undefined
  const cdp: CDPSession = await ctx.newCDPSession(page)
  const main = (await cdp.send('Page.getFrameTree')).frameTree.frame.id
  cdp.on('Fetch.requestPaused', (e) => {
    const method = e.request.method.toUpperCase()
    const host = hostOf(e.request.url)
    const onSite = hostAllowed(host, allowedHosts)
    const write = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS'
    const allow =
      onSite && (!write || (plan !== undefined && postAllowed(plan, method, e.request.url)))
    if (allow) {
      void cdp.send('Fetch.continueRequest', { requestId: e.requestId }).catch(() => undefined)
      return
    }
    if (write) {
      let path = e.request.url
      try {
        path = new URL(e.request.url).pathname
      } catch {}
      blocked.push(`${method} ${path}`)
    }
    if (!onSite && e.resourceType === 'Document' && e.frameId === main) offSite = e.request.url
    void cdp
      .send('Fetch.failRequest', { requestId: e.requestId, errorReason: 'BlockedByClient' })
      .catch(() => undefined)
  })
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] })

  const settle = async (): Promise<void> => {
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined)
  }
  /**
   * 页面里读一下。点完按钮页面可能正在跳转 / 刷新（封禁页提交后会自己刷新），读到一半上下文没了
   * 就等它落定再读一次——只读，重读不会多做任何事。
   */
  const read = async <T>(fn: () => T): Promise<T> => {
    try {
      return await page.evaluate(fn)
    } catch {
      await page
        .waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT_MS })
        .catch(() => undefined)
      await settle()
      return page.evaluate(fn)
    }
  }

  return {
    async goto(url) {
      offSite = undefined
      let res: Awaited<ReturnType<Page['goto']>> = null
      try {
        res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS })
      } catch (err) {
        if (offSite !== undefined) return { status: 0, finalUrl: offSite, offSite }
        throw err
      }
      if (offSite !== undefined) return { status: 0, finalUrl: offSite, offSite }
      await settle()
      const retryAfterMs = retryAfterOf(res?.headers()['retry-after'])
      return {
        status: res?.status() ?? 0,
        finalUrl: page.url(),
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      }
    },
    look: () =>
      read(() => {
        const user = document.querySelector('#header-bottom-right span.user > a')
        const name = user?.textContent?.trim() ?? ''
        return {
          loggedIn: document.body?.classList.contains('loggedin') === true,
          ...(name === '' ? {} : { username: name }),
          title: document.title,
          text: (document.body?.innerText ?? '').slice(0, 3000).toLowerCase(),
          frameSources: [...document.querySelectorAll('iframe[src], script[src]')]
            .map((el) => el.getAttribute('src') ?? '')
            .slice(0, 50),
        }
      }),
    bodyText: () => read(() => document.body?.innerText ?? ''),
    things: () =>
      read(() =>
        [...document.querySelectorAll('div.thing[data-fullname]')].slice(0, 100).map((el) => {
          const d = (el as HTMLElement).dataset
          const ts = Number(d.timestamp)
          const title = el.querySelector('a.title')?.textContent?.trim()
          const body = el.querySelector('.usertext-body .md')?.textContent?.trim()
          return {
            fullname: d.fullname ?? '',
            type: d.type ?? '',
            author: d.author ?? '',
            subreddit: d.subreddit ?? '',
            permalink: d.permalink ?? '',
            ...(Number.isFinite(ts) && ts > 0 ? { timestamp: ts } : {}),
            ...(title === undefined || title === '' ? {} : { title }),
            ...(body === undefined || body === '' ? {} : { body }),
            reports: [...el.querySelectorAll('.report-reasons li')]
              .map((li) => li.textContent?.trim() ?? '')
              .filter((t) => t !== ''),
          }
        }),
      ),
    async click(selector) {
      await page.locator(selector).first().click({ timeout: STEP_TIMEOUT_MS })
      await settle()
    },
    async fill(selector, value) {
      await page.locator(selector).first().fill(value, { timeout: STEP_TIMEOUT_MS })
    },
    count: (selector) => page.locator(selector).count(),
    waitFor: (selector) =>
      page
        .locator(selector)
        .first()
        .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS })
        .then(
          () => true,
          () => false,
        ),
    textOf: async (selector) =>
      (
        await page
          .locator(selector)
          .allInnerTexts()
          .catch(() => [])
      ).join('\n'),
    url: () => page.url(),
    blockedWrites: () => [...blocked],
    async close() {
      await cdp.detach().catch(() => undefined)
      await page.close().catch(() => undefined)
    },
  }
}
