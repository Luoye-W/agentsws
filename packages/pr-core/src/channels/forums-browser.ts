/**
 * `pr.forums` 的渠道口：**浏览器模式**（60 §1 / §2；55 §3 的浏览器执行器）。
 *
 * Quora、知乎与绝大多数行业论坛没有可用的公开写接口。所以这条职责与
 * 56 的 Facebook 群组**形状相同**——每个动作对应的不是一条 HTTP 请求，
 * 而是一段受控浏览器脚本描述（`BrowserAction`）。那个类型与执行器接口
 * （`BrowserExecutor`）直接 `import` 社媒那一份，**不另定义一套**：
 * 一个执行器要同时给两条职责用，两份接口迟早对不上。
 *
 * 四条纪律，与 `social-core/channels/facebook-group.ts` 逐字相同：
 *
 * 1. **读走白名单。** 只读动作真去开页面，但开之前先查一遍域名。
 *    真闸在 `dsh-adapter` 的 `checkBrowserNavigation`（职责 yml 的
 *    `browser_scope` → `RunRequest.allowed_hosts`，只看 `browser_navigate`
 *    与 `browser_tabs{new}` 的 url）；这里这一道是**第二道**。
 * 2. **写先出卡。** 发帖 / 回答 / 评论**永远**回 `browser_required`，
 *    一个字都不执行。批准之后才走 {@link executeApprovedForumAction}。
 *    `community_post` 在 `HARD_L1` 里，走浏览器不改变这一条。
 * 3. **失效即停。** 执行器回 `handover` 就说"请你接管"，**不重试**。
 * 4. **脚本描述里没有凭据。** 论坛会话是登录态的（人自己在第三栏里登过）。
 */

import { hostAllowed } from '@agentsws/contracts'
import type {
  BrowserAction,
  BrowserExecutor,
  BrowserRunResult,
  SocialError,
  SocialResult,
} from '@agentsws/social-core'

const LABEL = '论坛'

/**
 * 这条职责默认能开的站（职责 yml `roles/pr/forums.yml` 的 `browser_scope`
 * 写的是同一份）。**两处都写**是有意的：yml 那份是真闸，这一份是适配器自己
 * 那一道——两处不一致的时候 `forums.test.ts` 会喊。
 *
 * 这张表 Luoye 可以改：它是"我们允许这条职责去哪儿"，不是一条技术事实。
 */
export const FORUM_HOSTS: readonly string[] = [
  '*.quora.com',
  'quora.com',
  '*.zhihu.com',
  'zhihu.com',
  '*.stackexchange.com',
  '*.discourse.org',
  '*.xda-developers.com',
  '*.reddit.com',
]

/** 论坛上读回来的一条（帖子 / 问题 / 回答，形状归一）。 */
export interface ForumItem {
  external_id: string
  url: string
  title?: string
  /** 正文。**外部文本**——调用方进模型上下文前要围栏（21 §1 / 39）。 */
  text: string
  author?: string
  created_at?: string
  replies?: number
}

/* ── 脚本描述（读三条、写两条）─────────────────────────────────────── */

/** 在某个论坛 / 问答站里按关键词找相关的问题与帖子。 */
export function searchScript(input: { site: string; query: string; limit: number }): BrowserAction {
  return {
    url: `https://${input.site}/search?q=${encodeURIComponent(input.query)}`,
    goal: `在 ${input.site} 上找与「${input.query}」有关的问题和帖子，最多 ${input.limit} 条`,
    steps: [
      '打开搜索结果页，等结果出来',
      `往下滚到看见 ${input.limit} 条为止（滚不动了就有几条算几条）`,
      '每条记下：链接、标题、提问者、时间、回答数；正文抄前两段就够',
    ],
    verify: '每一条都有链接与标题；一条都没有的话说"这个站上搜不到相关的"',
    writes: false,
  }
}

/** 读一条问题 / 帖子的正文与下面的讨论。 */
export function readThreadScript(url: string): BrowserAction {
  return {
    url,
    goal: '把这条问题 / 帖子的正文与下面的回答读回来',
    steps: [
      '打开这个链接',
      '点开"查看更多回答"直到点不动为止',
      '每条记下：回答 id、作者、正文、时间、赞数',
    ],
    verify: '正文与至少一条回答都有；没有回答时只回正文',
    writes: false,
  }
}

/** 读这个板块 / 话题的规矩（多数论坛把它钉在置顶帖里）。 */
export function readRulesScript(input: { site: string; venue: string }): BrowserAction {
  return {
    url: `https://${input.site}/${input.venue}`,
    goal: `把 ${input.site} 的 ${input.venue} 这个板块的发帖规矩读回来`,
    steps: [
      '打开板块首页',
      '找置顶的"版规""社区准则""发帖须知"那一条，点进去',
      '把规矩**原样**抄回来，一条一行；不要概括',
    ],
    verify: '至少抄回一条规矩；一条都找不到的话说"这个板块没写规矩"，不要自己编一条',
    writes: false,
  }
}

/** 在别人的板块里发一条。 */
export function postScript(input: {
  site: string
  venue: string
  title?: string
  body: string
}): BrowserAction {
  return {
    url: `https://${input.site}/${input.venue}`,
    goal: `在 ${input.site} 的 ${input.venue} 里发一条`,
    steps: [
      '在板块页面上找到"发帖""提问""写回答"按钮，点开它',
      ...(input.title === undefined ? [] : [`标题填：${input.title}`]),
      '把正文粘进去，一个字不改',
      '点发布',
    ],
    verify: '刷新之后这一条出现在板块里，正文与我们给的一字不差',
    writes: true,
  }
}

/** 在别人的问题下回一条答案 / 在别人的帖子下回一条评论。 */
export function answerScript(input: { url: string; body: string }): BrowserAction {
  return {
    url: input.url,
    goal: '在这条下面回一条',
    steps: ['打开这个链接', '点"写回答" / 评论框', '把正文粘进去，一个字不改', '点发布'],
    verify: '刷新之后这一条出现在下面，正文与我们给的一字不差',
    writes: true,
  }
}

/* ── 执行那一跳 ──────────────────────────────────────────────────────── */

function outOfScope(url: string, allowed: readonly string[]): SocialError {
  return {
    ok: false,
    reason: 'browser_required',
    message: `这个地址不在这条职责能开的站里（只能开 ${allowed.join('、')}）：${url}。没开出去——越界的页面一旦打开就收不回来。`,
  }
}

function handover(what: string, message: string): SocialError {
  return {
    ok: false,
    reason: 'browser_required',
    message: `${LABEL}这一步（${what}）停下来了，要你自己在浏览器里接一下：${message} 我**没有重试**——重试一个不知道点到哪儿的动作比不做危险。`,
  }
}

function checkHost(action: BrowserAction, executor: BrowserExecutor): SocialError | undefined {
  const allowed = executor.allowedHosts?.() ?? FORUM_HOSTS
  let host: string
  try {
    host = new URL(action.url).hostname
  } catch {
    return { ok: false, reason: 'browser_required', message: `打不开这个地址：${action.url}` }
  }
  return hostAllowed(host, allowed) ? undefined : outOfScope(action.url, allowed)
}

/** 跑一段**只读**的动作。写动作走不到这里（文件头第 2 条）。 */
export async function runForumRead(
  executor: BrowserExecutor,
  action: BrowserAction,
  what: string,
): Promise<{ ok: true; items: readonly Record<string, unknown>[] } | SocialError> {
  if (action.writes)
    return {
      ok: false,
      reason: 'needs_approval',
      message: `${LABEL}的写动作不能走只读那条路（${what}）——它要先出一张卡。`,
    }
  const scope = checkHost(action, executor)
  if (scope !== undefined) return scope
  let result: BrowserRunResult
  try {
    result = await executor.run(action)
  } catch (e) {
    return {
      ok: false,
      reason: 'upstream_error',
      message: `${LABEL}的浏览器这一步没跑起来（${what}）：${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`,
    }
  }
  if (result.status === 'handover') return handover(what, result.message)
  if (result.status === 'failed')
    return {
      ok: false,
      reason: 'upstream_error',
      message: `${LABEL}的浏览器这一步没做成（${what}）：${result.message}`,
    }
  return { ok: true, items: result.items ?? [] }
}

/**
 * **批准之后**才调的那一跳：拿着卡上那段脚本描述，让执行器真去点。
 *
 * 与 56 的 `executeApprovedBrowserAction` 逐字同一条：没有卡 id 就不点，
 * 越界不点，`handover` 不重试，`verified` 为假就照实报**不当成功**。
 */
export async function executeApprovedForumAction(
  executor: BrowserExecutor,
  action: BrowserAction,
  context: { approval_id: string; now: string },
): Promise<SocialResult<{ verified: boolean }>> {
  if (context.approval_id.trim() === '')
    return {
      ok: false,
      reason: 'needs_approval',
      message: `${LABEL}的写动作要先有一张批过的卡。没有卡 id 就不点——浏览器只是手，不是授权。`,
    }
  const scope = checkHost(action, executor)
  if (scope !== undefined) return scope
  let result: BrowserRunResult
  try {
    result = await executor.run(action)
  } catch (e) {
    return {
      ok: false,
      reason: 'upstream_error',
      message: `${LABEL}的浏览器没跑起来：${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`,
    }
  }
  if (result.status === 'handover') return handover(action.goal, result.message)
  if (result.status === 'failed')
    return {
      ok: false,
      reason: 'upstream_error',
      message: `${LABEL}那一步没做成：${result.message}（没有重试——这一条要你看一眼再决定）`,
    }
  return { ok: true, observed_at: context.now, data: { verified: result.verified === true } }
}

/* ── 适配器 ─────────────────────────────────────────────────────────── */

const str = (row: Record<string, unknown>, key: string): string | undefined => {
  const v = row[key]
  return typeof v === 'string' && v !== '' ? v : undefined
}
const num = (row: Record<string, unknown>, key: string): number | undefined => {
  const v = row[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

export interface ForumAdapter {
  readonly mode: 'browser'
  /** 能开哪些站（面板上"这条职责去得了哪儿"读它）。 */
  hosts(): readonly string[]
  search(input: { site: string; query: string; limit?: number }): Promise<SocialResult<ForumItem[]>>
  thread(url: string): Promise<SocialResult<ForumItem[]>>
  /** 读板块规矩（原文一条一行；解析成结构化的那一步在 `subreddits.ts`）。 */
  rules(input: { site: string; venue: string }): Promise<SocialResult<string[]>>
  /** 发帖 / 回答：**永远**回 `browser_required`（文件头第 2 条）。 */
  post(input: {
    site: string
    venue: string
    title?: string
    body: string
  }): Promise<SocialResult<never>>
  answer(input: { url: string; body: string }): Promise<SocialResult<never>>
}

export interface ForumAdapterOptions {
  /** 受控浏览器执行器。不给 = 这条职责只出脚本描述（**不假装读到了**）。 */
  browser?: BrowserExecutor
  /** 现在（注入；这个包里没有 `Date.now()`）。 */
  now(): string
}

export function createForumAdapter(options: ForumAdapterOptions): ForumAdapter {
  const browser = options.browser
  const needBrowser = (what: string): SocialError => ({
    ok: false,
    reason: 'browser_required',
    message: `论坛没有可用的接口（Quora / 知乎都没有公开写接口），${what}要走第三栏的受控浏览器。这台机器上还没接上执行器——现在只能你自己去做。`,
  })

  const toItems = (rows: readonly Record<string, unknown>[]): ForumItem[] =>
    rows.map((row) => ({
      external_id: str(row, 'external_id') ?? str(row, 'id') ?? str(row, 'url') ?? '',
      url: str(row, 'url') ?? '',
      ...(str(row, 'title') === undefined ? {} : { title: str(row, 'title') as string }),
      text: str(row, 'text') ?? str(row, 'body') ?? '',
      ...(str(row, 'author') === undefined ? {} : { author: str(row, 'author') as string }),
      ...(str(row, 'created_at') === undefined
        ? {}
        : { created_at: str(row, 'created_at') as string }),
      ...(num(row, 'replies') === undefined ? {} : { replies: num(row, 'replies') as number }),
    }))

  return {
    mode: 'browser',
    hosts: () => browser?.allowedHosts?.() ?? FORUM_HOSTS,

    async search({ site, query, limit }) {
      if (browser === undefined) return needBrowser('找问题与帖子')
      const res = await runForumRead(
        browser,
        searchScript({ site, query, limit: limit ?? 20 }),
        '在论坛上搜',
      )
      if (!('items' in res)) return res
      return { ok: true, observed_at: options.now(), data: toItems(res.items) }
    },

    async thread(url) {
      if (browser === undefined) return needBrowser('读一条问题下的讨论')
      const res = await runForumRead(browser, readThreadScript(url), '读讨论')
      if (!('items' in res)) return res
      return { ok: true, observed_at: options.now(), data: toItems(res.items) }
    },

    async rules({ site, venue }) {
      if (browser === undefined) return needBrowser('读板块规矩')
      const res = await runForumRead(browser, readRulesScript({ site, venue }), '读板块规矩')
      if (!('items' in res)) return res
      return {
        ok: true,
        observed_at: options.now(),
        data: res.items
          .map((row) => str(row, 'rule') ?? str(row, 'text') ?? '')
          .filter((s) => s !== ''),
      }
    },

    async post(input) {
      return needBrowser(`在 ${input.site} 的 ${input.venue} 里发一条`)
    },

    async answer(input) {
      return needBrowser(`在 ${input.url} 下面回一条`)
    },
  }
}
