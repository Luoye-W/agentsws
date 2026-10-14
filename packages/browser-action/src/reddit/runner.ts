/**
 * WP328：插件跑一件「Reddit 只读」活（本机服务排进来的每日巡查那一份）。
 *
 * 先看登的是哪个号（没登录 → 停，回 `not_logged_in`；登的不是品牌号 → 停，回 `wrong_user`，
 * 一条都不读——那可能是你的个人号）；再一路一路读，每两次请求之间隔**固定**的
 * {@link REDDIT_READ_GAP_MS}；被拦（429 / 验证 / 登录掉了）就停下整件活，已经读到的照样交回。
 * 不重试、不换路、不伪装。
 */

import { parseRedditListing, type RedditListingItem, redditMeOf } from './listing.js'
import {
  checkRedditReadRequest,
  checkRedditReadUrl,
  REDDIT_ME_URL,
  REDDIT_READ_GAP_MS,
  type RedditReadRequest,
  redditReadUrl,
} from './read.js'

/** 本机服务排给插件的一件只读活。 */
export interface RedditReadJob {
  id: string
  workspace_id: string
  /** 品牌号用户名（用户配了才有）。登着的不是它就一条都不读。 */
  expect_user?: string
  reads: RedditReadRequest[]
  title: string
  created_at: string
}

export type RedditReadOutcome =
  | 'done'
  | 'not_logged_in'
  | 'wrong_user'
  | 'blocked'
  | 'failed'
  | 'stopped'

export interface RedditReadPart {
  key: string
  ok: boolean
  items: RedditListingItem[]
  pages: number
  /** 读到了上次那一条（或比 `since_utc` 更早的）——中间没有漏。 */
  reached_stop: boolean
  message?: string
}

export interface RedditReadJobResult {
  outcome: RedditReadOutcome
  message: string
  /** 登着的号（读到了才有）。 */
  user?: string
  parts: RedditReadPart[]
}

/** 一次 GET 的结果（插件里是 `fetch`，测试里是替身）。 */
export interface RedditFetched {
  status: number
  /** 跟完跳转后的地址（被跳到登录页认这个）。 */
  url: string
  content_type: string
  body: string
}

export type RedditWallKind = 'login' | 'rate_limited' | 'blocked' | 'not_found' | 'not_json'

/** 这一次 GET 是不是被拦了；`whole` = 整件活都该停（不只是这一路）。 */
export function detectRedditWall(
  res: RedditFetched,
  account: boolean,
): { kind: RedditWallKind; message: string; whole: boolean } | undefined {
  let path = ''
  try {
    path = new URL(res.url).pathname
  } catch {}
  const body = res.body.slice(0, 4_000).toLowerCase()
  if (
    res.status === 429 ||
    body.includes('whoa there, pardner') ||
    body.includes('too many requests')
  )
    return {
      kind: 'rate_limited',
      message: 'Reddit 说读得太快了。今天先停，明天再读。',
      whole: true,
    }
  if (/\/(login|register)\b/u.test(path) || res.status === 401 || (account && res.status === 403))
    return { kind: 'login', message: 'Chrome 里的 Reddit 没登录（或登录掉了）。', whole: true }
  if (
    body.includes('verify you are human') ||
    body.includes('captcha') ||
    body.includes("you've been blocked")
  )
    return {
      kind: 'blocked',
      message: 'Reddit 要你做一次验证。已停下，请你自己处理。',
      whole: true,
    }
  if (res.status === 404)
    return { kind: 'not_found', message: '没有这个版块 / 帖子。', whole: false }
  if (res.status === 403)
    return { kind: 'blocked', message: '这个版块不让看（私密 / 被封）。', whole: false }
  if (res.status >= 400 || !res.content_type.toLowerCase().includes('json'))
    return { kind: 'not_json', message: `Reddit 回的不是数据（${res.status}）。`, whole: false }
  return undefined
}

export interface RedditReadDeps {
  fetch(url: string): Promise<RedditFetched>
  sleep(ms: number): Promise<void>
  /** 用户点了停 / 插件要退出。 */
  stopped(): boolean
  /** 测试给 0。 */
  gapMs?: number
}

const lower = (s: string): string => s.trim().replace(/^u\//iu, '').toLowerCase()

export async function runRedditRead(
  job: RedditReadJob,
  deps: RedditReadDeps,
): Promise<RedditReadJobResult> {
  const gap = deps.gapMs ?? REDDIT_READ_GAP_MS
  const parts: RedditReadPart[] = []
  for (const req of job.reads) {
    const bad = checkRedditReadRequest(req)
    if (bad !== undefined) return { outcome: 'failed', message: bad, parts }
  }
  const get = async (url: string, account: boolean) => {
    const bad = checkRedditReadUrl(url)
    if (bad !== undefined) throw new Error(bad)
    const res = await deps.fetch(url)
    return { res, wall: detectRedditWall(res, account) }
  }
  let user: string | undefined
  try {
    const me = await get(REDDIT_ME_URL, true)
    if (me.wall?.whole === true && me.wall.kind !== 'login')
      return { outcome: 'blocked', message: me.wall.message, parts }
    user = me.wall === undefined ? redditMeOf(safeJson(me.res.body)) : undefined
  } catch (e) {
    return { outcome: 'failed', message: e instanceof Error ? e.message : String(e), parts }
  }
  if (user === undefined)
    return { outcome: 'not_logged_in', message: 'Chrome 里的 Reddit 没登录品牌号。', parts }
  if (job.expect_user !== undefined && lower(job.expect_user) !== lower(user))
    return {
      outcome: 'wrong_user',
      message: `Chrome 里登着的是 u/${user}，不是品牌号 u/${job.expect_user}。一条都没读。`,
      user,
      parts,
    }
  for (const req of job.reads) {
    const part: RedditReadPart = {
      key: req.key,
      ok: true,
      items: [],
      pages: 0,
      reached_stop: false,
    }
    parts.push(part)
    let after: string | undefined
    while (part.pages < req.max_pages) {
      if (deps.stopped()) return { outcome: 'stopped', message: '你点了停止。', user, parts }
      await deps.sleep(gap)
      let got: Awaited<ReturnType<typeof get>>
      try {
        got = await get(redditReadUrl(req, after), req.kind === 'inbox')
      } catch (e) {
        part.ok = false
        part.message = e instanceof Error ? e.message : String(e)
        break
      }
      if (got.wall !== undefined) {
        part.ok = false
        part.message = got.wall.message
        if (got.wall.whole)
          return {
            outcome: got.wall.kind === 'login' ? 'not_logged_in' : 'blocked',
            message: got.wall.message,
            user,
            parts,
          }
        break
      }
      const page = parseRedditListing(safeJson(got.res.body), req.kind === 'inbox')
      part.pages += 1
      if (page === undefined) {
        part.ok = false
        part.message = '读回来的数据认不出。'
        break
      }
      for (const item of page.items) {
        if (
          item.name === req.stop_at ||
          (req.since_utc !== undefined && item.created_utc < req.since_utc)
        ) {
          // 某帖评论是一棵树，不按时间排：只跳过旧的，不停
          if (req.kind === 'post_comments') continue
          part.reached_stop = true
          break
        }
        part.items.push(item)
      }
      if (part.reached_stop || page.after === undefined) {
        if (page.after === undefined) part.reached_stop = true
        break
      }
      after = page.after
    }
  }
  return { outcome: 'done', message: '读完了。', user, parts }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
