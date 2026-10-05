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
import type { ReadonlyBrowser } from './index.js'

export const READONLY_SESSION_ID = 'agentsws-readonly'

export function redditReadBrowserOf(rb: ReadonlyBrowser): RedditReadBrowser {
  return {
    session: () => ({ kind: 'readonly_isolated', id: READONLY_SESSION_ID }),
    async run(action, hint) {
      if (action.writes) return { status: 'failed', message: '只读浏览器不做任何会改东西的动作。' }
      const got = await rb.read(action.url, { limit: hint?.limit ?? 25 })
      if (got.ok) return { status: 'ok', items: got.items, verified: true }
      return got.reason === 'wall' || got.reason === 'blocked'
        ? { status: 'handover', message: got.message }
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
