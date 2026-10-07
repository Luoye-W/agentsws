/**
 * WP249：内存里的「old.reddit 官方号页面」替身（**不访问 reddit.com、不起浏览器**）。
 *
 * 照 `page.ts` 的 `AutomationPage` 那几个口子演一个登着版主号的 old.reddit：版务队列（`.json` 与
 * 页面两种）、版规、帖子页回复框、封禁页。点击 / 填写按选择器认；**写请求过网络闸**（与真页面同一个
 * `postAllowed`），被掐的记下来。可以让下一页弹验证码、让登录掉线，测「照实停下」。
 */
import {
  postAllowed,
  type RedditBrowserPlan,
  OLD_REDDIT_SELECTORS as S,
} from '@agentsws/social-core'
import type { AutomationPage, PageGoto, RawThing } from '../src/reddit-official-browser/page.js'

export interface FakeThing {
  kind: 't3' | 't1'
  id: string
  title?: string
  body: string
  author: string
  reports: string[]
}

export interface FakeOldReddit {
  loggedIn: boolean
  username: string
  rules: string[]
  queues: { modqueue: FakeThing[]; unmoderated: FakeThing[] }
  banned: string[]
  comments: Record<string, string[]>
  /** 发出去的写请求（`POST /api/approve id=t3_x`）。 */
  posts: string[]
  /** 被网络闸掐掉的写请求。 */
  blocked: string[]
  /** 下一次开页面弹验证码。 */
  captchaNext: boolean
  /** `.json` 回网页（逼 HTML 退路）。 */
  jsonBroken: boolean
  /** 开过的页面（路径）。 */
  visited: string[]
  opener(): (
    ctx: unknown,
    hosts: readonly string[],
    plan?: RedditBrowserPlan,
  ) => Promise<AutomationPage>
}

const listing = (things: readonly FakeThing[], sub: string) => ({
  kind: 'Listing',
  data: {
    children: things.map((t) => ({
      kind: t.kind,
      data: {
        name: `${t.kind}_${t.id}`,
        ...(t.kind === 't3'
          ? { title: t.title, selftext: t.body }
          : { body: t.body, link_title: t.title }),
        author: t.author,
        subreddit: sub,
        permalink: `/r/${sub}/comments/${t.id}/x/`,
        created_utc: 1_791_000_000,
        num_reports: t.reports.length,
        user_reports: t.reports.map((r) => [r, 1]),
        mod_reports: [],
      },
    })),
  },
})

export function createFakeOldReddit(origin: string, sub = 'inmoxr'): FakeOldReddit {
  const site: FakeOldReddit = {
    loggedIn: false,
    username: 'inmo_official',
    rules: ['No spam or self-promotion', 'Be civil', 'Stay on topic'],
    queues: { modqueue: [], unmoderated: [] },
    banned: [],
    comments: {},
    posts: [],
    blocked: [],
    captchaNext: false,
    jsonBroken: false,
    visited: [],
    opener: () => async (_ctx, _hosts, plan) => page(plan),
  }

  function page(plan?: RedditBrowserPlan): AutomationPage {
    let path = ''
    let body = ''
    let captcha = false
    let things: FakeThing[] = []
    let queue: 'modqueue' | 'unmoderated' | undefined
    const pending: Record<string, string> = {}
    const write = (p: string, detail: string): boolean => {
      const ok = plan !== undefined && postAllowed(plan, 'POST', `${origin}${p}`)
      if (ok) site.posts.push(`POST ${p} ${detail}`)
      else site.blocked.push(`POST ${p}`)
      return ok
    }
    return {
      async goto(url): Promise<PageGoto> {
        const u = new URL(url)
        path = u.pathname
        site.visited.push(path)
        captcha = site.captchaNext
        site.captchaNext = false
        body = ''
        things = []
        queue = undefined
        if (captcha) return { status: 200, finalUrl: url }
        const q = path.match(/^\/r\/([^/]+)\/about\/(modqueue|unmoderated)\/(\.json)?$/u)
        if (q !== null) {
          if (!site.loggedIn) return { status: 403, finalUrl: url }
          queue = q[2] as 'modqueue' | 'unmoderated'
          things = site.queues[queue]
          if (q[3] === '.json')
            body = site.jsonBroken ? '<html>nope</html>' : JSON.stringify(listing(things, sub))
          return { status: 200, finalUrl: url }
        }
        if (path === `/r/${sub}/about/rules/.json`) {
          body = JSON.stringify({ rules: site.rules.map((r) => ({ short_name: r })) })
          return { status: 200, finalUrl: url }
        }
        return { status: 200, finalUrl: url }
      },
      async look() {
        return {
          loggedIn: site.loggedIn,
          ...(site.loggedIn ? { username: site.username } : {}),
          title: captcha ? 'Verify' : 'reddit',
          text: captcha ? 'please verify you are human' : '',
          frameSources: captcha ? ['https://www.google.com/recaptcha/api.js'] : [],
        }
      },
      bodyText: async () => body,
      things: async (): Promise<RawThing[]> =>
        things.map((t) => ({
          fullname: `${t.kind}_${t.id}`,
          type: t.kind === 't3' ? 'link' : 'comment',
          author: t.author,
          subreddit: sub,
          permalink: `/r/${sub}/comments/${t.id}/x/`,
          ...(t.title === undefined ? {} : { title: t.title }),
          body: t.body,
          reports: t.reports,
        })),
      async click(selector) {
        for (const t of things) {
          const fullname = `${t.kind}_${t.id}`
          const verb =
            selector === S.approveButton(fullname)
              ? 'approve'
              : selector === S.removeButton(fullname)
                ? 'remove'
                : undefined
          if (verb !== undefined && queue !== undefined) {
            if (write(`/api/${verb}`, `id=${fullname}`))
              site.queues[queue] = site.queues[queue].filter((x) => x !== t)
            return
          }
        }
        if (selector === S.replySave) {
          const id = path.match(/^\/comments\/([a-z0-9]+)\/$/u)?.[1] ?? ''
          if (write('/api/comment', `thing_id=t3_${id}`))
            site.comments[id] = [...(site.comments[id] ?? []), pending.reply ?? '']
          return
        }
        if (selector === S.banSubmit) {
          if (write('/api/friend', `type=banned name=${pending.ban ?? ''}`))
            site.banned.push(pending.ban ?? '')
          return
        }
        // 页面上别的按钮（点赞之类）：真页面上会发一个写请求，网络闸掐掉
        write('/api/vote', 'dir=1')
      },
      async fill(selector, value) {
        if (selector === S.replyText) pending.reply = value
        if (selector === S.banName) pending.ban = value
      },
      async count(selector) {
        return (
          things.filter(
            (t) =>
              selector === S.thing(`${t.kind}_${t.id}`) ||
              selector === S.approveButton(`${t.kind}_${t.id}`) ||
              selector === S.removeButton(`${t.kind}_${t.id}`),
          ).length + (selector === S.replySave || selector === S.banSubmit ? 1 : 0)
        )
      },
      async textOf(selector) {
        if (selector === S.bannedTable) return site.banned.join('\n')
        const id = path.match(/^\/comments\/([a-z0-9]+)\/$/u)?.[1] ?? ''
        return (site.comments[id] ?? []).join('\n')
      },
      url: () => `${origin}${path}`,
      blockedWrites: () => [...site.blocked],
      close: async () => undefined,
    }
  }
  return site
}
