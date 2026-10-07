/**
 * WP228：把本机只读浏览器接到 WP220 的 Reddit 两路路由上（`browser_readonly` 那一格）。
 *
 * - 会话：报 `readonly_isolated`（单独起的、不带任何登录态的只读会话）——路由只认这一种。
 * - 只接 `writes: false` 的脚本描述；带写的一律拒（路由本来就不会给，这里是第二道）。
 * - 被站点拦了（登录墙 / 验证码 / 429 / 拦截页）回 `handover`，路由记 `blocked`；别的没成回 `failed`。
 * - 限速器：路由拿 {@link redditReadLimiterOf}（只问不记），真正开页面时由只读浏览器记一页——
 *   两边数的是同一本账，连接页显示的「今天额度用完」也是它。
 */
import type { RedditReadBrowser, RedditReadLimiter } from '@agentsws/social-core'
import type { RedditReadAccount } from './account.js'
import type { ReadonlyBrowser } from './index.js'

export const READONLY_SESSION_ID = 'agentsws-readonly'

/** WP246：用读号读时被验证码 / 拦截页拦下，告诉人怎么手动过一次。 */
export const READ_ACCOUNT_CAPTCHA_HINT =
  '点连接页「取数路线」的「登录读号」，在打开的窗口里手动过一次验证再关掉，这一路就恢复。'

/**
 * @param account WP246：读号（给了 = 只有读号登录好、而且不是品牌登记的号时才读；生产都给）。
 *   不给 = WP228 的老行为（测试里直接验只读浏览器本身）。
 */
export function redditReadBrowserOf(
  rb: ReadonlyBrowser,
  account?: RedditReadAccount,
): RedditReadBrowser {
  return {
    session: () => ({ kind: 'readonly_isolated', id: READONLY_SESSION_ID }),
    ...(account === undefined ? {} : { availability: () => account.gate() }),
    async run(action, hint) {
      if (action.writes) return { status: 'failed', message: '只读浏览器不做任何会改东西的动作。' }
      const got = await rb.read(action.url, { limit: hint?.limit ?? 25 })
      if (got.ok) return { status: 'ok', items: got.items, verified: true }
      const human = account !== undefined && (got.wall === 'captcha' || got.wall === 'blocked')
      return got.reason === 'wall' || got.reason === 'blocked'
        ? {
            status: 'handover',
            message: human ? `${got.message}${READ_ACCOUNT_CAPTCHA_HINT}` : got.message,
          }
        : { status: 'failed', message: got.message }
    },
  }
}

/** 路由用的限速器：只问不记（记一页由只读浏览器在真开页面时做）。 */
export function redditReadLimiterOf(rb: ReadonlyBrowser): RedditReadLimiter {
  return {
    check: (nowMs) => rb.usage.check(nowMs),
    take: () => undefined,
  }
}
