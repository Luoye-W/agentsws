/**
 * WP246：演示（`agentsws demo`）用的本机只读浏览器**替身**——不起任何浏览器、不访问 reddit.com。
 *
 * 连接页「取数路线」那一块在演示里要演得出「登录读号 → 窗口开着 → 关掉后显示已登录 u/demo_reader」：
 * 「登录窗口」开 1.5 秒自己关（像用户登好关掉了）；之后体检那一页回一个读号用户名；
 * 别的页面回两条演示帖子（演示世界里的内容，不是真 Reddit）。
 * 生产路径从不调它（与 `deepseekAccountStandIn` 同一个口径）。
 */
import type { LoginWindow, LoginWindowLauncher } from './account.js'
import type { BrowserSession, PageRead, SessionLauncher } from './session.js'

export interface ReadonlyBrowserStandIn {
  exists: (path: string) => boolean
  platform: NodeJS.Platform
  env: Record<string, string>
  launch: SessionLauncher
  loginWindow: LoginWindowLauncher
}

export function readonlyBrowserStandIn(
  options: { username?: string; loginMs?: number } = {},
): ReadonlyBrowserStandIn {
  let loggedIn = false
  const username = options.username ?? 'demo_reader'
  const page = (url: string): PageRead => {
    const who = /old\.reddit\.com\/?$/u.test(url)
    return {
      status: 200,
      finalUrl: url,
      extract: {
        signals: {
          title: 'reddit',
          text: '',
          passwordInputs: 0,
          frameSources: [],
          items: who ? 1 : 2,
          ...(who && loggedIn ? { account: username } : {}),
        },
        items: who
          ? []
          : [
              {
                kind: 'post',
                url: '/r/demo/comments/d1/battery/',
                title: '演示帖：续航怎么样？',
                subreddit: 'demo',
                score: 12,
                comments: 4,
                text: '演示世界里的内容。',
              },
              {
                kind: 'post',
                url: '/r/demo/comments/d2/subtitles/',
                title: '演示帖：字幕功能真好用',
                subreddit: 'demo',
                score: 30,
                comments: 9,
                text: '演示世界里的内容。',
              },
            ],
      },
    }
  }
  const session: BrowserSession = {
    readPage: async (url) => page(url),
    close: async () => undefined,
    killNow: () => undefined,
  }
  return {
    exists: () => true,
    platform: 'darwin',
    env: {},
    launch: async () => session,
    loginWindow: async (): Promise<LoginWindow> => {
      let done: () => void = () => undefined
      const closed = new Promise<void>((r) => {
        done = r
      })
      const timer = setTimeout(() => {
        loggedIn = true
        done()
      }, options.loginMs ?? 1_500)
      timer.unref?.()
      return {
        closed,
        close: async () => {
          clearTimeout(timer)
          done()
        },
      }
    },
  }
}
