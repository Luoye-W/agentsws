/**
 * WP249（决策 89）：「Reddit 官方号浏览器通道」——**这家的网页长什么样**这一半（纯数据，不碰浏览器）。
 *
 * 主路线是浏览器（多数用户没有、也不会去申请 Reddit 的开发者应用）：用户在工作台起的独立浏览器
 * 配置目录里自己登录官方号，我们用这个会话读版务页面、执行**审批过的**那一个动作。真正驱动浏览器的
 * 在服务进程那一侧（`apps/server/src/reddit-official-browser/`）；这里只回答三件事：
 *
 * 1. **去哪儿读**：old.reddit.com 的版务页面结构多年没变，而且每个列表都有 `.json` 版本
 *    （与 OAuth 接口回的是同一个形状，所以两条通道共用 {@link redditModListing} 一个解析）。
 *    `.json` 读不回来时退到页面上 `div.thing` 的 `data-*` 属性（old.reddit 的固定写法）。
 * 2. **一个动作要点哪几下**（{@link planRedditWrite}）：批准 / 移除 / 封禁 / 发帖 / 回帖 / 置顶，
 *    每个动作是一串确定的步骤（打开某页、点某个按钮、往某个框里填卡上的那段字），不让模型自己找按钮。
 * 3. **驱动层白名单**（{@link stepAllowed} / {@link postAllowed}）：执行器每一步先问这里；
 *    不在这个动作白名单里的点击 / 填写一律拒，网络层只放这个动作需要的那几个写请求（POST），
 *    其余 POST（点赞、订阅、别的版务）全拦。白名单按**动作种类**算，不按传进来的步骤算——
 *    步骤被人改了也绕不过去。
 *
 * 选择器全在 {@link OLD_REDDIT_SELECTORS} 一张表里：照 old.reddit 公开页面的写法整理，**没有对真站
 * 核过**（本单纪律不许访问 reddit.com）。首次真机前要用官方号对一次（报告里列为要定的事）。
 */

import { hostAllowed } from '@agentsws/contracts'

/** 读和写都走 old.reddit（版务页面结构稳；新版页面是一层层 web component，一改版就全换）。 */
export const OLD_REDDIT_ORIGIN = 'https://old.reddit.com'

/**
 * 自动化页面能开的站。登录窗口不在这一道闸里——那是用户自己在网页上操作（可能要走 Google 登录、
 * 人机验证），我们不拦也不看。
 */
export const REDDIT_OFFICIAL_HOSTS: readonly string[] = [
  'old.reddit.com',
  'www.reddit.com',
  'reddit.com',
  '*.redditstatic.com',
  '*.redditmedia.com',
]

/** old.reddit 的选择器（一张表，改版只改这里）。 */
export const OLD_REDDIT_SELECTORS = {
  /** 已登录：`<body class="loggedin …">`，右上角 `<span class="user"><a>用户名</a>`。 */
  loggedInBody: 'body.loggedin',
  userName: '#header-bottom-right span.user > a',
  /** 列表里的一条（帖子 / 评论都是 `div.thing`，属性 `data-fullname` 等）。 */
  thing: (fullname: string) => `div.thing[data-fullname="${fullname}"]`,
  /** modqueue / unmoderated 上每条的大按钮（approve / remove / spam）。 */
  approveButton: (fullname: string) =>
    `div.thing[data-fullname="${fullname}"] .big-mod-buttons a:text-is("approve")`,
  removeButton: (fullname: string) =>
    `div.thing[data-fullname="${fullname}"] .big-mod-buttons a:text-is("remove")`,
  /** 帖子页底下那个顶层回复框。 */
  replyText: '.commentarea > form.usertext textarea[name="text"]',
  replySave: '.commentarea > form.usertext button.save',
  /** 发帖页（`/r/<版>/submit?selftext=true`）。 */
  submitTitle: '#newlink textarea[name="title"]',
  submitText: '#newlink textarea[name="text"]',
  submitButton: '#newlink button[name="submit"]',
  /** 帖子页上自己那条帖子的「置顶」（点一下再点 yes 确认）。 */
  stickyToggle: 'div.thing.link .sticky-button a.togglebutton',
  stickyConfirm: 'div.thing.link .sticky-button a.yes',
  /** 封禁页（`/r/<版>/about/banned/`）的表单。 */
  banName: '#banned input[name="name"]',
  banDuration: '#banned input[name="duration"]',
  banNote: '#banned input[name="note"]',
  banMessage: '#banned textarea[name="ban_message"]',
  banSubmit: '#banned button[type="submit"]',
  bannedTable: 'table.banned-table',
} as const

/** 审批卡上那一个动作（执行器只认这几种）。 */
export type RedditBrowserWrite =
  | { kind: 'approve'; sub: string; fullname: string; queue: 'modqueue' | 'unmoderated' }
  | {
      kind: 'remove'
      sub: string
      fullname: string
      queue: 'modqueue' | 'unmoderated'
      /** 公开留给作者的一句理由（只给帖子留；评论的楼中楼这一版不做）。 */
      removal_message?: string
    }
  | { kind: 'ban'; sub: string; username: string; days?: number; note?: string; message?: string }
  | { kind: 'submit'; sub: string; title: string; text: string; sticky?: boolean }
  | { kind: 'reply'; post_fullname: string; text: string }

export type RedditBrowserWriteKind = RedditBrowserWrite['kind']

export type BrowserStep =
  | { op: 'goto'; url: string }
  | { op: 'click'; selector: string }
  | { op: 'fill'; selector: string; value: string }

/** 做完之后怎么确认真做成了（读回页面）。 */
export type BrowserVerify =
  | { op: 'absent'; url: string; selector: string }
  | { op: 'present'; url: string; selector: string; text: string }
  /** 发帖：落到了这个版的帖子页（`/r/<版>/comments/<id>/`）。 */
  | { op: 'landed'; sub: string }

export interface RedditBrowserPlan {
  write: RedditBrowserWriteKind
  steps: BrowserStep[]
  /** 这个动作允许发出去的写请求路径（网络层白名单；别的 POST 一律拦）。 */
  allowed_posts: string[]
  verify: BrowserVerify
}

/** `t3_abc` → `abc`。 */
const id36 = (fullname: string): string => fullname.replace(/^t\d_/u, '')
const subPath = (sub: string): string => encodeURIComponent(sub.replace(/^\/?r\//u, ''))

/** 读：一个版务列表的 `.json`（与 OAuth 接口同形）。 */
export function modQueueJsonUrl(
  origin: string,
  sub: string,
  source: 'modqueue' | 'unmoderated',
  limit = 50,
): string {
  return `${origin}/r/${subPath(sub)}/about/${source}/.json?limit=${Math.min(limit, 100)}&raw_json=1`
}

/** 读：一个版务列表的页面（`.json` 读不回来时退到它）。 */
export function modQueuePageUrl(
  origin: string,
  sub: string,
  source: 'modqueue' | 'unmoderated',
): string {
  return `${origin}/r/${subPath(sub)}/about/${source}/`
}

/** 读：版规的 `.json`。 */
export function rulesJsonUrl(origin: string, sub: string): string {
  return `${origin}/r/${subPath(sub)}/about/rules/.json?raw_json=1`
}

/** 体检：首页右上角看登录名。 */
export function loginCheckUrl(origin: string): string {
  return `${origin}/`
}

/** 「登录官方号」窗口打开的那一页。 */
export function loginPageUrl(origin: string): string {
  return `${origin}/login`
}

/** 一个动作 → 一串确定的步骤 + 网络白名单 + 自证。 */
export function planRedditWrite(origin: string, w: RedditBrowserWrite): RedditBrowserPlan {
  const S = OLD_REDDIT_SELECTORS
  switch (w.kind) {
    case 'approve':
      return {
        write: 'approve',
        steps: [
          { op: 'goto', url: modQueuePageUrl(origin, w.sub, w.queue) },
          { op: 'click', selector: S.approveButton(w.fullname) },
        ],
        allowed_posts: ['/api/approve'],
        verify: {
          op: 'absent',
          url: modQueuePageUrl(origin, w.sub, w.queue),
          selector: S.thing(w.fullname),
        },
      }
    case 'remove': {
      const message =
        w.removal_message !== undefined &&
        w.removal_message.trim() !== '' &&
        w.fullname.startsWith('t3_')
          ? w.removal_message.trim()
          : undefined
      return {
        write: 'remove',
        steps: [
          { op: 'goto', url: modQueuePageUrl(origin, w.sub, w.queue) },
          { op: 'click', selector: S.removeButton(w.fullname) },
          ...(message === undefined
            ? []
            : ([
                { op: 'goto', url: `${origin}/comments/${id36(w.fullname)}/` },
                { op: 'fill', selector: S.replyText, value: message },
                { op: 'click', selector: S.replySave },
              ] as BrowserStep[])),
        ],
        allowed_posts: message === undefined ? ['/api/remove'] : ['/api/remove', '/api/comment'],
        verify: {
          op: 'absent',
          url: modQueuePageUrl(origin, w.sub, w.queue),
          selector: S.thing(w.fullname),
        },
      }
    }
    case 'ban': {
      const url = `${origin}/r/${subPath(w.sub)}/about/banned/`
      return {
        write: 'ban',
        steps: [
          { op: 'goto', url },
          { op: 'fill', selector: S.banName, value: w.username },
          ...(w.days === undefined
            ? []
            : ([{ op: 'fill', selector: S.banDuration, value: String(w.days) }] as BrowserStep[])),
          ...(w.note === undefined
            ? []
            : ([
                { op: 'fill', selector: S.banNote, value: w.note.slice(0, 300) },
              ] as BrowserStep[])),
          ...(w.message === undefined
            ? []
            : ([{ op: 'fill', selector: S.banMessage, value: w.message }] as BrowserStep[])),
          { op: 'click', selector: S.banSubmit },
        ],
        allowed_posts: ['/api/friend'],
        verify: { op: 'present', url, selector: S.bannedTable, text: w.username },
      }
    }
    case 'submit':
      return {
        write: 'submit',
        steps: [
          { op: 'goto', url: `${origin}/r/${subPath(w.sub)}/submit?selftext=true` },
          { op: 'fill', selector: S.submitTitle, value: w.title.slice(0, 300) },
          { op: 'fill', selector: S.submitText, value: w.text },
          { op: 'click', selector: S.submitButton },
          ...(w.sticky === true
            ? ([
                { op: 'click', selector: S.stickyToggle },
                { op: 'click', selector: S.stickyConfirm },
              ] as BrowserStep[])
            : []),
        ],
        allowed_posts:
          w.sticky === true ? ['/api/submit', '/api/set_subreddit_sticky'] : ['/api/submit'],
        verify: { op: 'landed', sub: w.sub },
      }
    case 'reply': {
      const url = `${origin}/comments/${id36(w.post_fullname)}/`
      return {
        write: 'reply',
        steps: [
          { op: 'goto', url },
          { op: 'fill', selector: S.replyText, value: w.text },
          { op: 'click', selector: S.replySave },
        ],
        allowed_posts: ['/api/comment'],
        verify: {
          op: 'present',
          url,
          selector: '.commentarea .thing.comment .md',
          text: w.text.slice(0, 40),
        },
      }
    }
  }
}

/**
 * 每种动作**最多**能点 / 能填的选择器（白名单按动作种类算，与 {@link planRedditWrite} 分开写，
 * 两处对不上测试会喊）。`fullname` 只认审批卡上的那一条。
 */
function allowedSelectors(w: RedditBrowserWrite): { click: string[]; fill: string[] } {
  const S = OLD_REDDIT_SELECTORS
  switch (w.kind) {
    case 'approve':
      return { click: [S.approveButton(w.fullname)], fill: [] }
    case 'remove':
      return { click: [S.removeButton(w.fullname), S.replySave], fill: [S.replyText] }
    case 'ban':
      return { click: [S.banSubmit], fill: [S.banName, S.banDuration, S.banNote, S.banMessage] }
    case 'submit':
      return {
        click: [S.submitButton, ...(w.sticky === true ? [S.stickyToggle, S.stickyConfirm] : [])],
        fill: [S.submitTitle, S.submitText],
      }
    case 'reply':
      return { click: [S.replySave], fill: [S.replyText] }
  }
}

/** 填的值只能是审批卡上的那几段字（填别的 = 不是批过的那个动作）。 */
function allowedValues(w: RedditBrowserWrite): string[] {
  switch (w.kind) {
    case 'approve':
      return []
    case 'remove':
      return w.removal_message === undefined ? [] : [w.removal_message.trim()]
    case 'ban':
      return [
        w.username,
        ...(w.days === undefined ? [] : [String(w.days)]),
        ...(w.note === undefined ? [] : [w.note.slice(0, 300)]),
        ...(w.message === undefined ? [] : [w.message]),
      ]
    case 'submit':
      return [w.title.slice(0, 300), w.text]
    case 'reply':
      return [w.text]
  }
}

/** 这一步在不在这个动作的白名单里。不在就回一句人话（执行器停下、照实报）。 */
export function stepAllowed(
  w: RedditBrowserWrite,
  step: BrowserStep,
  allowedHosts: readonly string[] = REDDIT_OFFICIAL_HOSTS,
): { ok: true } | { ok: false; why: string } {
  if (step.op === 'goto') {
    let host = ''
    try {
      host = new URL(step.url).hostname
    } catch {}
    return hostAllowed(host, allowedHosts)
      ? { ok: true }
      : { ok: false, why: `要打开的页面不在白名单里：${host || step.url}` }
  }
  const allowed = allowedSelectors(w)
  if (step.op === 'click')
    return allowed.click.includes(step.selector)
      ? { ok: true }
      : { ok: false, why: `这一下点击不在「${w.kind}」这个动作的白名单里，已拦下。` }
  if (!allowed.fill.includes(step.selector))
    return { ok: false, why: `这个输入框不在「${w.kind}」这个动作的白名单里，已拦下。` }
  return allowedValues(w).includes(step.value)
    ? { ok: true }
    : { ok: false, why: '要填的字和审批卡上的不一样，已拦下。' }
}

/** 网络层：这个写请求（非 GET）放不放。只放这个动作需要的那几个路径。 */
export function postAllowed(plan: RedditBrowserPlan, method: string, url: string): boolean {
  const m = method.toUpperCase()
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return true
  let path = ''
  try {
    path = new URL(url).pathname.replace(/\/+$/u, '')
  } catch {
    return false
  }
  return plan.allowed_posts.includes(path)
}

/** 发帖之后落到的帖子页 → 新帖的 fullname（认不出回 `undefined`）。 */
export function landedPostFullname(url: string, sub: string): string | undefined {
  let path = ''
  try {
    path = new URL(url).pathname
  } catch {
    return undefined
  }
  const name = sub.replace(/^\/?r\//u, '').toLowerCase()
  const m = path.match(/^\/r\/([^/]+)\/comments\/([a-z0-9]+)\//iu)
  if (m === null || (m[1] ?? '').toLowerCase() !== name) return undefined
  return `t3_${m[2]}`
}
