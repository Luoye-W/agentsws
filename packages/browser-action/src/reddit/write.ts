/**
 * WP329（docs/102 §2.3「写」、决策 663）：Reddit 的三种写——**插件填草稿，人点发送**。
 *
 * | 写 | 做什么 | 插件动的 |
 * |---|---|---|
 * | `reply` | 回一条评论（楼中楼；收件箱里的回复 / @ 也是它） | 点那条评论下的 reply、往冒出来的框里填草稿 |
 * | `comment` | 在帖子下面回一条（自家版的帖子、别人版里的帖子） | 往帖子下面那个评论框里填草稿 |
 * | `submit` | 发新帖（自家版 / 别人的版） | 往发帖页的标题框、正文框里填 |
 *
 * 发送 / 保存那个按钮**不在任何白名单里**（测试钉住）：填好之后停在 `await_sent`，等人自己点，
 * 认出页面上新出现的那一条才算发出去，并读回它的编号与链接（之后对方回复挂回原行就靠这个编号）。
 *
 * WP432（Luoye 10-20 反馈 9）：
 * - **默认新版 www.reddit.com**（shreddit 组件）；用户在设置里选了旧版才走 old.reddit。两套选择器各一张表
 *   （{@link REDDIT_WRITE_SELECTORS_NEW} / {@link REDDIT_WRITE_SELECTORS}），真站对不上只改表。
 * - 新版的选择器按公开页面结构整理，**没有对真站核过**：那几步标 `soft`——对不上不乱点、不停，
 *   页面横条上照实说「对不上页面，草稿在侧边栏里复制，自己粘贴」，接着等人点发送、照样读回。
 * - 批了不自动开页面：这里拼出来的活进队就是「等你在插件里打开」（`queue.ts` 的 `needsHumanOpen`）。
 *
 * WP445（决策 1323，Luoye 10-21）：**一律新版 www.reddit.com**，新版 / 旧版开关去掉了。旧版那张表只作**页面兜底**：
 * 新版每一步的选择器后面接 ` || <旧版>`（`dom.ts` 先按新版找，找不到再按旧版）——品牌号在 Reddit 设置里选了旧版界面、
 * www 被跳到 old.reddit 时照样填得进去。本地假页面（测试）按地址认哪一版。
 */

import type { ActionAccount, ActionJob, ActionPlan, ActionStep } from '../types.js'

/** 旧版 old.reddit（WP445 起只作兜底：www 被跳到这里时白名单里有它）。 */
export const REDDIT_WRITE_ORIGIN = 'https://old.reddit.com'

/** WP432 / WP445：新版 Reddit——**一律在这里填**。插件的可选站点权限用 WP328 那一份 `REDDIT_HOST_PERMISSIONS`。 */
export const REDDIT_WRITE_ORIGIN_NEW = 'https://www.reddit.com'

/** 这一页是新版还是旧版（按地址认，只决定用哪一套步骤；WP445 起不是设置）。 */
export type RedditSite = 'new' | 'old'

/** 某个站该用哪一套选择器：`www.reddit.com` / `reddit.com` 是新版，别的（old.reddit、本地假页面）按旧版。 */
export function redditSiteOf(origin: string): RedditSite {
  try {
    const h = new URL(origin).hostname
    return h === 'www.reddit.com' || h === 'reddit.com' || h === 'new.reddit.com' ? 'new' : 'old'
  } catch {
    return 'old'
  }
}

/** 自动化页面能开的站。 */
export const REDDIT_WRITE_HOSTS: readonly string[] = ['old.reddit.com', 'www.reddit.com']

/** 选择器一张表（真站首跑对不上只改这里）。`{t1}` / 编号由下面的函数填。 */
export const REDDIT_WRITE_SELECTORS = {
  /** 某条评论（`#thing_t1_xxx`）自己的「reply」链接（不含它下面楼层的）。 */
  replyLink: (t1: string): string => `#thing_${t1} > .entry .buttons .reply-button > a`,
  /** 点了 reply 之后，那条评论下面冒出来的回复框。 */
  replyBox: (t1: string): string => `#thing_${t1} > .child > form.usertext textarea[name="text"]`,
  /** 那条评论直接的下一层回复（发出去的那条会出现在这里）。 */
  replyItems: (t1: string): string => `#thing_${t1} > .child > .sitetable > .thing.comment`,
  /** 帖子页最上面那个评论框（顶层评论）。 */
  commentBox: '.commentarea > form.usertext textarea[name="text"]',
  /** 帖子下面的顶层评论。 */
  commentItems: '.commentarea > .sitetable > .thing.comment',
  /** 一条评论自己的正文（不含它下面楼层的）。 */
  commentBody: ':scope > .entry .usertext-body',
  /** 发帖页：标题、正文。 */
  submitTitle: '#title-field textarea[name="title"]',
  submitText: '#text-field textarea[name="text"]',
  /** 发出去之后落到的帖子页：那条帖子与它的标题。 */
  postItem: '#siteTable > .thing.link',
  postTitle: ':scope > .entry a.title',
} as const

/**
 * WP432：**新版 Reddit**（shreddit 组件）的选择器一张表。按公开页面结构整理、**没对真站核过**；
 * 用到的那几步都是 `soft`（对不上不停，交给人粘贴）。`>>>` = 进到这个组件的 shadow root 里再找。
 */
export const REDDIT_WRITE_SELECTORS_NEW = {
  /** 某条评论（`<shreddit-comment thingid="t1_…">`）自己的「Reply」按钮。 */
  replyLink: (t1: string): string =>
    `shreddit-comment[thingid="${t1}"] > [slot="actionRow"] button[slot="comment-reply"]`,
  /** 点了 Reply 之后那条评论里冒出来的编辑框（富文本，contenteditable）。 */
  replyBox: (t1: string): string =>
    `shreddit-comment[thingid="${t1}"] shreddit-composer div[contenteditable="true"]`,
  /** 那条评论直接的下一层回复。 */
  replyItems: (t1: string): string => `shreddit-comment[parentid="${t1}"]`,
  /** 帖子页上收起的「Join the conversation」那一条（点一下展开编辑框）。 */
  commentOpener: 'comment-composer-host faceplate-textarea-input[data-testid="trigger-button"]',
  /** 展开后的顶层评论编辑框。 */
  commentBox: 'comment-composer-host shreddit-composer div[contenteditable="true"]',
  /** 帖子下面的顶层评论。 */
  commentItems: 'shreddit-comment[depth="0"]',
  /** 一条评论自己的正文。 */
  commentBody: ':scope > div[slot="comment"]',
  /** 发帖页：标题（在组件的 shadow root 里）、正文。 */
  submitTitle: 'faceplate-textarea-input[name="title"] >>> textarea',
  submitText: 'shreddit-composer[name="body"] div[contenteditable="true"]',
  /** 发出去之后落到的帖子页：那条帖子与它的标题。 */
  postItem: 'shreddit-post',
  postTitle: '[slot="title"]',
} as const

/** 一次写。 */
export type RedditWrite =
  /** 回一条评论（`parent` 是 `t1_…`；`permalink` 是那条评论的链接，打开它才找得到回复框）。 */
  | { kind: 'reply'; parent: string; permalink: string }
  /** 在帖子下面回一条（`post` 是 `t3_…`；有链接用链接，没有用 `/comments/<id>/`）。 */
  | { kind: 'comment'; post: string; permalink?: string }
  /** 发新帖（文字帖；正文 = `text`）。 */
  | { kind: 'submit'; subreddit: string; title: string }

export interface RedditWriteAction {
  write: RedditWrite
  /** 卡上批过的那段正文（插件只填这一段）。 */
  text: string
}

export class RedditPlanError extends Error {}

const T1 = /^t1_[a-z0-9]+$/u
const T3 = /^t3_[a-z0-9]+$/u
const SUB = /^[A-Za-z0-9_]{2,32}$/u
const COMMENTS_PATH = /^\/r\/[A-Za-z0-9_]{2,32}\/comments\/[a-z0-9]+\//u

/** `t1_abc` / `abc` → `t1_abc`。 */
export function redditThing(prefix: 't1' | 't3', id: string): string {
  const v = id.trim().toLowerCase()
  return v.startsWith(`${prefix}_`) ? v : `${prefix}_${v}`
}

/** 链接（绝对的或站内的）→ 站内路径，只认 `/r/<版>/comments/<id>/…`；别的回 `undefined`。 */
export function redditCommentsPath(permalink: string): string | undefined {
  let path = permalink.trim()
  try {
    if (/^https?:/iu.test(path)) path = new URL(path).pathname
  } catch {
    return undefined
  }
  path = path.split(/[?#]/u)[0] ?? ''
  if (!path.endsWith('/')) path = `${path}/`
  return COMMENTS_PATH.test(path) ? path : undefined
}

const base = (origin: string): string => origin.replace(/\/+$/u, '')

/** 白名单站点：Reddit 本身 + 给了假站点时那一个。 */
function hostsFor(origin: string): string[] {
  const hosts = [...REDDIT_WRITE_HOSTS]
  try {
    const h = new URL(origin).hostname
    if (!hosts.includes(h)) hosts.push(h)
  } catch {}
  return hosts
}

const SEND_PROMPT = '草稿已填好，看一眼，自己点发送'

/**
 * 一次写 → 计划（步骤 + 白名单）。对不上形状就抛 {@link RedditPlanError}（进队前拦下）。
 * WP432：`site` 不给就按 `origin` 认（`www.reddit.com` = 新版）；`author` = 品牌号（人改了字也认得出发出去的那一条）。
 */
export function redditWritePlan(
  action: RedditWriteAction,
  origin = REDDIT_WRITE_ORIGIN_NEW,
  options: { site?: RedditSite; author?: string } = {},
): ActionPlan {
  const text = action.text.trim()
  if (text === '') throw new RedditPlanError('正文是空的，不填。')
  const o = base(origin)
  const site = options.site ?? redditSiteOf(o)
  if (site === 'new') return newRedditPlan(action, text, o, options.author)
  const S = REDDIT_WRITE_SELECTORS
  const w = action.write
  const by = authorOf(options.author)
  let steps: ActionStep[]
  let click: string[] = []
  let fill: string[]
  let values: string[] = [text]
  switch (w.kind) {
    case 'reply': {
      const t1 = redditThing('t1', w.parent)
      if (!T1.test(t1)) throw new RedditPlanError('要回的那条评论编号不对。')
      const path = redditCommentsPath(w.permalink)
      if (path === undefined) throw new RedditPlanError('要回的那条评论没有链接，找不到回复框。')
      steps = [
        { op: 'goto', url: `${o}${path}` },
        { op: 'wait', selector: S.replyLink(t1), timeout_ms: 20_000 },
        { op: 'click', selector: S.replyLink(t1) },
        { op: 'wait', selector: S.replyBox(t1), timeout_ms: 10_000 },
        { op: 'fill', selector: S.replyBox(t1), value: text, highlight: true },
        {
          op: 'await_sent',
          selector: S.replyItems(t1),
          body: S.commentBody,
          text,
          prompt: SEND_PROMPT,
          ...by,
        },
      ]
      click = [S.replyLink(t1)]
      fill = [S.replyBox(t1)]
      break
    }
    case 'comment': {
      const t3 = redditThing('t3', w.post)
      if (!T3.test(t3)) throw new RedditPlanError('要回的那个帖子编号不对。')
      const path = w.permalink === undefined ? undefined : redditCommentsPath(w.permalink)
      const url = path === undefined ? `${o}/comments/${t3.slice(3)}/` : `${o}${path}`
      steps = [
        { op: 'goto', url },
        { op: 'wait', selector: S.commentBox, timeout_ms: 20_000 },
        { op: 'fill', selector: S.commentBox, value: text, highlight: true },
        {
          op: 'await_sent',
          selector: S.commentItems,
          body: S.commentBody,
          text,
          prompt: SEND_PROMPT,
          ...by,
        },
      ]
      fill = [S.commentBox]
      break
    }
    case 'submit': {
      const sub = w.subreddit.replace(/^\/?r\//u, '').trim()
      if (!SUB.test(sub)) throw new RedditPlanError('版块名不对。')
      const title = w.title.trim().slice(0, 300)
      if (title === '') throw new RedditPlanError('新帖没有标题。')
      steps = [
        { op: 'goto', url: `${o}/r/${sub}/submit?selftext=true` },
        { op: 'wait', selector: S.submitTitle, timeout_ms: 20_000 },
        { op: 'fill', selector: S.submitTitle, value: title, highlight: true },
        { op: 'fill', selector: S.submitText, value: text, highlight: true },
        {
          op: 'await_sent',
          selector: S.postItem,
          body: S.postTitle,
          text: title,
          prompt: SEND_PROMPT,
          ...by,
        },
      ]
      fill = [S.submitTitle, S.submitText]
      values = [title, text]
      break
    }
  }
  return {
    kind: `reddit_${w.kind}`,
    platform: 'reddit',
    pace: 'write',
    steps,
    allow: {
      hosts: hostsFor(o),
      click,
      fill,
      values,
      wait: steps.flatMap((s) => (s.op === 'wait' ? [s.selector] : [])),
    },
    // 读回在 `await_sent` 里（认出新出现的那一条才算发出去）
    verify: { op: 'none' },
    zones: [],
    needs_sheet: false,
  }
}

/** 品牌号用户名（去掉 `u/`；认不出就不给）。 */
function authorOf(author: string | undefined): { author?: string } {
  const a = author?.replace(/^\/?u\//u, '').trim()
  return a !== undefined && /^[A-Za-z0-9_-]{3,20}$/u.test(a) ? { author: a } : {}
}

/** 计划的外壳（白名单从步骤里收）。 */
function planOf(w: RedditWrite, o: string, steps: ActionStep[], values: string[]): ActionPlan {
  return {
    kind: `reddit_${w.kind}`,
    platform: 'reddit',
    pace: 'write',
    steps,
    allow: {
      hosts: hostsFor(o),
      click: steps.flatMap((s) => (s.op === 'click' ? [s.selector] : [])),
      fill: steps.flatMap((s) => (s.op === 'fill' ? [s.selector] : [])),
      values,
      wait: steps.flatMap((s) => (s.op === 'wait' ? [s.selector] : [])),
    },
    verify: { op: 'none' },
    zones: [],
    needs_sheet: false,
  }
}

/**
 * WP432：新版 Reddit 的步骤表。打开页面（`goto` 不软：打不开 / 被拦照样停）之后，等框、点 Reply、填字都是 `soft`——
 * 对不上就停在「等你粘贴」，不乱点；最后一步照样是等人点发送、读回。
 */
function newRedditPlan(
  action: RedditWriteAction,
  text: string,
  o: string,
  author: string | undefined,
): ActionPlan {
  const N = REDDIT_WRITE_SELECTORS_NEW
  const O = REDDIT_WRITE_SELECTORS
  /** WP445：新版找不到再按旧版（页面兜底）。 */
  const or = (a: string, b: string): string => `${a} || ${b}`
  const S = {
    replyLink: (t1: string) => or(N.replyLink(t1), O.replyLink(t1)),
    replyBox: (t1: string) => or(N.replyBox(t1), O.replyBox(t1)),
    replyItems: (t1: string) => or(N.replyItems(t1), O.replyItems(t1)),
    // 旧版没有「Join the conversation」那一条：评论框本来就摊开着，点一下它只是把光标放进去
    commentOpener: or(N.commentOpener, O.commentBox),
    commentBox: or(N.commentBox, O.commentBox),
    commentItems: or(N.commentItems, O.commentItems),
    commentBody: or(N.commentBody, O.commentBody),
    submitTitle: or(N.submitTitle, O.submitTitle),
    submitText: or(N.submitText, O.submitText),
    postItem: or(N.postItem, O.postItem),
    postTitle: or(N.postTitle, O.postTitle),
  }
  const w = action.write
  const by = authorOf(author)
  const send = (selector: string, body: string, want: string): ActionStep => ({
    op: 'await_sent',
    selector,
    body,
    text: want,
    prompt: SEND_PROMPT,
    ...by,
  })
  switch (w.kind) {
    case 'reply': {
      const t1 = redditThing('t1', w.parent)
      if (!T1.test(t1)) throw new RedditPlanError('要回的那条评论编号不对。')
      const path = redditCommentsPath(w.permalink)
      if (path === undefined) throw new RedditPlanError('要回的那条评论没有链接，找不到回复框。')
      return planOf(
        w,
        o,
        [
          { op: 'goto', url: `${o}${path}` },
          { op: 'wait', selector: S.replyLink(t1), timeout_ms: 20_000, soft: true },
          { op: 'click', selector: S.replyLink(t1), soft: true },
          { op: 'wait', selector: S.replyBox(t1), timeout_ms: 10_000, soft: true },
          { op: 'fill', selector: S.replyBox(t1), value: text, soft: true, highlight: true },
          send(S.replyItems(t1), S.commentBody, text),
        ],
        [text],
      )
    }
    case 'comment': {
      const t3 = redditThing('t3', w.post)
      if (!T3.test(t3)) throw new RedditPlanError('要回的那个帖子编号不对。')
      const path = w.permalink === undefined ? undefined : redditCommentsPath(w.permalink)
      const url = path === undefined ? `${o}/comments/${t3.slice(3)}/` : `${o}${path}`
      return planOf(
        w,
        o,
        [
          { op: 'goto', url },
          { op: 'wait', selector: S.commentOpener, timeout_ms: 20_000, soft: true },
          { op: 'click', selector: S.commentOpener, soft: true },
          { op: 'wait', selector: S.commentBox, timeout_ms: 10_000, soft: true },
          { op: 'fill', selector: S.commentBox, value: text, soft: true, highlight: true },
          send(S.commentItems, S.commentBody, text),
        ],
        [text],
      )
    }
    case 'submit': {
      const sub = w.subreddit.replace(/^\/?r\//u, '').trim()
      if (!SUB.test(sub)) throw new RedditPlanError('版块名不对。')
      const title = w.title.trim().slice(0, 300)
      if (title === '') throw new RedditPlanError('新帖没有标题。')
      return planOf(
        w,
        o,
        [
          { op: 'goto', url: `${o}/r/${sub}/submit/?type=TEXT` },
          { op: 'wait', selector: S.submitTitle, timeout_ms: 20_000, soft: true },
          { op: 'fill', selector: S.submitTitle, value: title, soft: true, highlight: true },
          { op: 'fill', selector: S.submitText, value: text, soft: true, highlight: true },
          send(S.postItem, S.postTitle, title),
        ],
        [title, text],
      )
    }
  }
}

/** 横条 / 工作台上的一句话（卡上没给标题时用）。 */
export function redditWriteTitle(write: RedditWrite): string {
  switch (write.kind) {
    case 'reply':
      return '回复一条评论'
    case 'comment':
      return '在帖子下回一条'
    case 'submit':
      return `在 r/${write.subreddit.replace(/^\/?r\//u, '')} 发帖`
  }
}

export interface RedditJobInput {
  id: string
  workspace_id: string
  /** 品牌号（用户名；不知道就用品牌 id）。每天写 ≤ 20 按它算。 */
  account_id: string
  action: RedditWriteAction
  approval_id: string
  approval_level?: 'L1' | 'L2' | 'L3'
  title?: string
  created_at: string
  origin?: string
  /** WP432：品牌号（人改了字也认得出发出去的那一条）。 */
  author?: string
}

/** 拼一件活（本机服务在卡批了之后调）。 */
export function buildRedditJob(input: RedditJobInput): ActionJob {
  const account: ActionAccount = { platform: 'reddit', id: input.account_id }
  return {
    id: input.id,
    workspace_id: input.workspace_id,
    account,
    plan: redditWritePlan(input.action, input.origin ?? REDDIT_WRITE_ORIGIN_NEW, {
      ...(input.author === undefined ? {} : { author: input.author }),
    }),
    approval_id: input.approval_id,
    ...(input.approval_level === undefined ? {} : { approval_level: input.approval_level }),
    zones_allowed: [],
    title: input.title ?? redditWriteTitle(input.action.write),
    created_at: input.created_at,
  }
}
