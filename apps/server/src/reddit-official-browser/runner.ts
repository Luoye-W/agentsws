/**
 * WP249：在一个装好闸的标签页上**读**版务队列、**做**审批过的那一个动作（逻辑在这里，手在 `page.ts`）。
 *
 * 执行一个动作的顺序（每一步不过就停、照实说，**不重试、不换路**）：
 *
 * 1. 每一步先问 `stepAllowed`（白名单按审批卡上那一个动作的种类算）；不在白名单 → 停。
 * 2. 每打开一页先看：还登着官方号吗（old.reddit 的 `body.loggedin`）？是不是验证码 / 拦截页 / 429？
 *    → 停，回 `handover`（要人去「登录官方号」窗口里处理）。
 * 3. 全部做完**读回页面自证**（批准 / 移除：队列里没有它了；封禁：封禁名单里有他；回帖：评论区里
 *    有这段字；发帖：落到了这个版的新帖页）。自证不过 = 没做成，照实报。
 */
import {
  landedPostFullname,
  type ModQueueEntry,
  planRedditWrite,
  type RedditBrowserReadResult,
  type RedditBrowserRunResult,
  type RedditBrowserWrite,
  redditFullname,
  redditModListing,
  redditRuleNames,
  stepAllowed,
} from '@agentsws/social-core'
import { detectWall, type WallKind } from '../readonly-browser/guard.js'
import type { AutomationPage, PageGoto, RawThing } from './page.js'

export interface PageVerdict {
  ok: boolean
  /** 停下的原因（`login` = 官方号没登着 / 掉了）。 */
  wall?: WallKind | 'login'
  message?: string
  retryAfterMs?: number
}

const LOGIN_LOST =
  '官方号没登着（或者登录掉了）。去连接页点「登录官方号」，在弹出的窗口里重新登录一次。'

/** 打开一页之后：被拦了没有、还登着没有。 */
export async function checkPage(
  page: AutomationPage,
  got: PageGoto,
  allowedHosts: readonly string[],
  needLogin: boolean,
): Promise<PageVerdict> {
  if (got.offSite !== undefined)
    return { ok: false, wall: 'off_site', message: '页面跳去了白名单外的站，已停下。' }
  const look = await page.look()
  const wall = detectWall({
    status: got.status,
    finalUrl: got.finalUrl,
    allowedHosts,
    signals: {
      title: look.title,
      text: look.text,
      passwordInputs: 0,
      frameSources: look.frameSources,
      items: 1,
    },
  })
  if (wall !== undefined && wall.kind !== 'login')
    return {
      ok: false,
      wall: wall.kind,
      message: wall.message,
      ...(got.retryAfterMs === undefined ? {} : { retryAfterMs: got.retryAfterMs }),
    }
  if (needLogin && !look.loggedIn) return { ok: false, wall: 'login', message: LOGIN_LOST }
  return { ok: true }
}

/** 体检：首页右上角有没有登录名。 */
export async function checkLoginOn(
  page: AutomationPage,
  url: string,
  allowedHosts: readonly string[],
): Promise<{ ok: true; username?: string } | { ok: false; verdict: PageVerdict }> {
  const got = await page.goto(url)
  const v = await checkPage(page, got, allowedHosts, false)
  if (!v.ok) return { ok: false, verdict: v }
  const look = await page.look()
  return look.loggedIn
    ? { ok: true, ...(look.username === undefined ? {} : { username: look.username }) }
    : { ok: false, verdict: { ok: false, wall: 'login', message: LOGIN_LOST } }
}

/** HTML 退路：`div.thing` 的 `data-*` → 与 `.json` 同一个形状。 */
export function thingsToEntries(
  things: readonly RawThing[],
  source: 'modqueue' | 'unmoderated',
): ModQueueEntry[] {
  return things
    .filter((t) => /^t[13]_/u.test(t.fullname))
    .map((t) => {
      const comment = t.fullname.startsWith('t1_')
      return {
        id: t.fullname,
        subreddit: t.subreddit,
        thing: comment ? ('comment' as const) : ('post' as const),
        ...(t.title === undefined ? {} : { title: t.title.slice(0, 300) }),
        excerpt: (t.body ?? '').slice(0, 600),
        author: t.author,
        report_reasons: t.reports.slice(0, 10),
        ...(t.timestamp === undefined ? {} : { created_at: new Date(t.timestamp).toISOString() }),
        url: t.permalink === '' ? '' : `https://www.reddit.com${t.permalink}`,
        source,
      }
    })
}

const failRead = (v: PageVerdict): RedditBrowserReadResult<never> => ({
  ok: false,
  reason:
    v.wall === 'login'
      ? 'login'
      : v.wall === 'rate_limited' || v.wall === 'captcha' || v.wall === 'blocked'
        ? 'blocked'
        : 'failed',
  message: v.message ?? '这一页没读到。',
})

/** 读一个版务队列：先 `.json`（与接口同形），读不回来退到页面上的 `div.thing`。 */
export async function readModQueueOn(
  page: AutomationPage,
  urls: { json: string; html: string },
  source: 'modqueue' | 'unmoderated',
  allowedHosts: readonly string[],
): Promise<RedditBrowserReadResult<ModQueueEntry[]> & { verdict?: PageVerdict }> {
  const got = await page.goto(urls.json)
  if (got.status === 403 || got.status === 401)
    return {
      ok: false,
      reason: 'login',
      message: '官方号没登着，或者不是这个版的版主（Reddit 回了 403）。',
    }
  const v = await checkPage(page, got, allowedHosts, false)
  if (!v.ok) return { ...failRead(v), verdict: v }
  if (got.status >= 200 && got.status < 300) {
    try {
      return { ok: true, data: redditModListing(JSON.parse(await page.bodyText()), source) }
    } catch {
      // 不是 JSON（被换成了网页）：退到页面
    }
  }
  const html = await page.goto(urls.html)
  const v2 = await checkPage(page, html, allowedHosts, true)
  if (!v2.ok) return { ...failRead(v2), verdict: v2 }
  if (html.status >= 400)
    return { ok: false, reason: 'failed', message: `Reddit 回了 ${html.status}，这一页没读到。` }
  return { ok: true, data: thingsToEntries(await page.things(), source) }
}

/** 读版规（`.json`；读不到就空，不挡队列）。 */
export async function readRulesOn(
  page: AutomationPage,
  url: string,
  allowedHosts: readonly string[],
): Promise<RedditBrowserReadResult<string[]> & { verdict?: PageVerdict }> {
  const got = await page.goto(url)
  const v = await checkPage(page, got, allowedHosts, false)
  if (!v.ok) return { ...failRead(v), verdict: v }
  if (got.status >= 400)
    return { ok: false, reason: 'failed', message: `Reddit 回了 ${got.status}，版规没读到。` }
  try {
    return { ok: true, data: redditRuleNames(JSON.parse(await page.bodyText())) }
  } catch {
    return { ok: false, reason: 'failed', message: '版规页不是认得出的格式。' }
  }
}

/** 执行审批卡上那一个动作并读回自证。 */
export async function runWriteOn(
  page: AutomationPage,
  origin: string,
  write: RedditBrowserWrite,
  allowedHosts: readonly string[],
): Promise<RedditBrowserRunResult & { verdict?: PageVerdict }> {
  const plan = planRedditWrite(origin, write)
  for (const step of plan.steps) {
    const allowed = stepAllowed(write, step, allowedHosts)
    if (!allowed.ok) return { status: 'failed', message: allowed.why }
    try {
      if (step.op === 'goto') {
        const got = await page.goto(step.url)
        const v = await checkPage(page, got, allowedHosts, true)
        if (!v.ok) return { status: 'handover', message: v.message ?? '页面被拦了。', verdict: v }
        if (got.status >= 400)
          return {
            status: 'failed',
            message: `Reddit 回了 ${got.status}（${new URL(step.url).pathname}）。`,
          }
      } else if (step.op === 'click') {
        if (!(await page.waitFor(step.selector)))
          return {
            status: 'handover',
            message:
              '页面上找不到该点的那个按钮（可能这一条已经被别的版主处理了，或者页面改版了）。',
          }
        await page.click(step.selector)
      } else {
        await page.fill(step.selector, step.value)
      }
    } catch (err) {
      return {
        status: 'failed',
        message: `浏览器这一步没做成：${err instanceof Error ? err.message.split('\n')[0] : String(err)}`,
      }
    }
  }
  // 点完之后先看一眼：弹了验证码 / 被拦就停
  const after = await checkPage(page, { status: 200, finalUrl: page.url() }, allowedHosts, false)
  if (!after.ok)
    return { status: 'handover', message: after.message ?? '页面被拦了。', verdict: after }

  const verify = plan.verify
  if (verify.op === 'landed') {
    const fullname = landedPostFullname(page.url(), verify.sub)
    return fullname === undefined
      ? {
          status: 'failed',
          message: '点了发布，但没落到新帖页上（可能要填验证码，或者被版规拦了）。',
        }
      : { status: 'ok', fullname, url: page.url() }
  }
  const got = await page.goto(verify.url)
  const v = await checkPage(page, got, allowedHosts, true)
  if (!v.ok) return { status: 'handover', message: v.message ?? '读回页面时被拦了。', verdict: v }
  if (verify.op === 'absent')
    return (await page.count(verify.selector)) === 0
      ? {
          status: 'ok',
          fullname: write.kind === 'approve' || write.kind === 'remove' ? write.fullname : '',
        }
      : { status: 'failed', message: '点过了，但刷新之后这一条还在队列里——没做成。' }
  const text = await page.textOf(verify.selector)
  return text.includes(verify.text)
    ? {
        status: 'ok',
        ...(write.kind === 'reply' ? { fullname: redditFullname(write.post_fullname, 't3') } : {}),
      }
    : { status: 'failed', message: '点过了，但刷新之后页面上没看到结果——没做成。' }
}
