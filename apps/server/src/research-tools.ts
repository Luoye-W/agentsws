/**
 * WP220（Luoye 10-05）：**只读 Reddit** 这个工具真去取数——走 `@agentsws/social-core` 的 Reddit 两路路由：
 *
 * 1. 接口中台（`social.reddit.*` 三项能力，积分）：本机数据能力口（`createDataService`）转给云上；
 * 2. 浏览器只读：要一个**单独的只读会话**的执行器（`browser` 那一格）。WP228 起由本机只读浏览器
 *    （`readonly-browser/`）提供；不给 = 这一路「没配」，照实说，不拿 Agent 的浏览器凑。
 *
 * 顺序与停用来自设置（`reddit.read`），限速来自设置（默认保守）。两路都不行回 `status: 'ok'`
 * 加一句人话（「没取到，这不等于没人在聊」），不当错误抛——研究那一边要把它写进报告的「从哪取的」。
 *
 * WP419：两路都不行时，**第三路借用户 Chrome 里的插件**（品牌号会话、只读、不入巡查库）现读一次；
 * 三路都不行就照实说「读不了 Reddit，先装好并连上插件」，并叮嘱模型**不去第三方镜像 / 统计站凑数**。
 *
 * 这一跳不往外写任何东西；正文是外部文本，由运行时围栏后再进模型上下文。
 */

import type {
  RedditReadRequest as PluginReadRequest,
  RedditListingItem,
} from '@agentsws/browser-action'
import {
  DATA_CREDIT_WARN_RATIO,
  type DataCallResult,
  type DataSourceRoute,
  type RedditBrowserReadLimits,
  type RedditReadCapability,
  type ResearchFetchRecord,
  type RunRequest,
} from '@agentsws/contracts'
import {
  coveringTimeWindow,
  createRedditReadRouter,
  type RedditHubPort,
  type RedditItem,
  type RedditReadBrowser,
  type RedditReadLimiter,
  type RedditReadRequest,
} from '@agentsws/social-core'
import type { ToolExecution, ToolExecutor } from '@agentsws/stand-ins'
import { READ_REDDIT_DEFAULT_LIMIT, READ_REDDIT_TOOL } from '@agentsws/stand-ins'

export interface ResearchToolsOptions {
  /** 这个品牌的 Reddit 取数路由（设置里的 `reddit.read`）。 */
  route(): DataSourceRoute
  /** 浏览器只读的限速（设置里来，默认保守）。 */
  limits(): RedditBrowserReadLimits
  /** WP228：外面给的限速器（本机只读浏览器那本落盘的账）；不给 = 内存版。 */
  limiter?: RedditReadLimiter
  /** 接口中台那一跳（本机数据能力口的 `call`）；没关联 / 没开通时它自己抛。 */
  callData?(capability: string, input: Record<string, unknown>): Promise<DataCallResult>
  /** 浏览器只读执行器（单独的只读会话）。不给 = 这一路没配。 */
  browser?(): RedditReadBrowser | undefined
  nowMs(): number
  /** 每次取数记一条（审计）。 */
  onRecord?(record: ResearchFetchRecord): void
  /**
   * WP236 ⑨：这次运行给数据接口的积分预算（职责阈值 `data_credits_per_run`，缺省 3）。
   * 不给 = 不设预算（老行为）。
   */
  creditBudget?(request: RunRequest): number | undefined
  /** WP236：一项能力每条多少积分（价目表；取不到回 `undefined`，那就不按价收条数）。 */
  priceOf?(capability: string): Promise<number | undefined>
  /** WP411：本地日期（`since` / `until` 写成 YYYY-MM-DD 时）按哪个时区算（分钟；不给 = UTC）。 */
  tzOffsetMinutes?(): number
  /**
   * WP419：第三路——借用户 Chrome 里的插件现读一次（Reddit 巡查那一份的 `readOnce`）。不给 = 没有这一路。
   */
  pluginRead?(
    reads: PluginReadRequest[],
  ): Promise<
    | { ok: true; parts: { ok: boolean; items: RedditListingItem[]; message?: string }[] }
    | { ok: false; why: string }
  >
  /**
   * WP493（决策 1718）：ego 连得上（`pluginRead` 这时由 ego 读、用 ego 里的登录态）→ 先走它，没读到再走前两路。
   * 不给 / 为假 = 老顺序（它是最后一路）。
   */
  egoFirst?(): boolean
}

/** WP419：三路都读不了时给模型的那一句（照实说、不找第三方站凑）。 */
export function redditUnreadableText(detail: string, via: 'plugin' | 'ego' = 'plugin'): string {
  return (
    `读不了 Reddit：${detail}。Reddit 拦服务器直读，**不要**去第三方镜像 / 统计站（redlib、subredditstats 之类）凑数——` +
    (via === 'ego'
      ? // WP493：ego 能用时不再叫人装插件
        '照实告诉用户这次没读到，并请他在 ego 里登录 Reddit 品牌号（用他自己的登录态读），登好后再读。'
      : '照实告诉用户这次没读到，并请他在 Chrome 里装好、连上「Agents 工坊助手」插件（用他自己的登录态读），装好后再读。')
  )
}

/** WP419：路由要读的那一件 → 插件读法（搜帖子 / 读版 / 读一帖评论）。认不出回 `undefined`。 */
export function pluginReadOf(req: RedditReadRequest): PluginReadRequest | undefined {
  const i = req.input
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
  const times = ['hour', 'day', 'week', 'month', 'year', 'all'] as const
  const t = str(i.time_window)
  // 不给时间档：和只读浏览器那一路一样按一个月
  const time = times.find((x) => x === t) ?? 'month'
  if (req.capability === 'social.reddit.search') {
    const q = str(i.query)
    if (q === undefined) return undefined
    return {
      key: 'adhoc:search',
      kind: 'search',
      query: q.slice(0, 200),
      time,
      max_pages: 1,
    }
  }
  if (req.capability === 'social.reddit.posts') {
    const sub = str(i.subreddit)?.replace(/^\/?r\//iu, '')
    return sub === undefined
      ? undefined
      : { key: `adhoc:sub_new:${sub}`, kind: 'sub_new', subreddit: sub, max_pages: 1 }
  }
  const id = /\/comments\/([a-z0-9]+)/iu.exec(str(i.post_url) ?? '')?.[1]
  return id === undefined
    ? undefined
    : { key: `adhoc:post:${id}`, kind: 'post_comments', post_id: id.toLowerCase(), max_pages: 1 }
}

/** 插件读回的一条 → 和别的路同一个样子。 */
function itemOfListing(x: RedditListingItem): RedditItem | undefined {
  if (x.kind === 'message' || x.url === undefined) return undefined
  return {
    kind: x.kind,
    url: x.url,
    id: x.name,
    ...(x.title === undefined
      ? x.link_title === undefined
        ? {}
        : { title: x.link_title }
      : { title: x.title }),
    text: x.text,
    ...(x.subreddit === undefined ? {} : { subreddit: x.subreddit }),
    ...(x.author === undefined ? {} : { author: x.author }),
    created_at: new Date(x.created_utc * 1000).toISOString(),
    ...(x.score === undefined ? {} : { score: x.score }),
    ...(x.num_comments === undefined ? {} : { comments: x.num_comments }),
  }
}

/**
 * WP411（#13）：`since` / `until`（本地日期或 ISO）→ 毫秒。`until` 的日期含那一天。认不出回一句人话。
 */
export function readWindowOf(
  input: Record<string, unknown>,
  tzOffsetMinutes: number,
): { since?: number; until?: number } | { error: string } {
  const one = (v: unknown, end: boolean): number | undefined | null => {
    if (typeof v !== 'string' || v.trim() === '') return undefined
    const t = v.trim()
    const ms = /^\d{4}-\d{2}-\d{2}$/u.test(t)
      ? Date.parse(`${t}T00:00:00.000Z`) - tzOffsetMinutes * 60_000 + (end ? 86_400_000 - 1 : 0)
      : Date.parse(t)
    return Number.isFinite(ms) ? ms : null
  }
  const since = one(input.since, false)
  const until = one(input.until, true)
  if (since === null || until === null)
    return { error: 'since / until 认不出：用本地日期（2026-10-11）或 ISO 时间。' }
  return { ...(since === undefined ? {} : { since }), ...(until === undefined ? {} : { until }) }
}

/** 一次运行花了多少积分（按运行 id 记；只留最近这么多次运行的账）。 */
const SPENT_RUNS_KEPT = 64

const fmt = (n: number): string => (Math.round(n * 100) / 100).toString()

/** 预算用完那一句（模型照实转述给人）。 */
export function creditExhaustedText(spent: number, budget: number): string {
  return `这次取数预算用完了（已用 ${fmt(spent)} / ${fmt(budget)} 积分），没有再取。请用已经取到的数据写结论，并照实告诉对方这次取数预算用完了。`
}

const ACTION_TO_CAPABILITY: Record<string, RedditReadCapability> = {
  search: 'social.reddit.search',
  posts: 'social.reddit.posts',
  comments: 'social.reddit.comments',
}

const INPUT_KEYS = ['query', 'subreddit', 'time_window', 'sort', 'limit', 'post_url'] as const

/**
 * WP236：`action` 没给时按入参推断——有 `query` 是搜帖子，有 `subreddit` 是读版，有 `post_url` 是读评论
 * （10-06 真机：模型第一次没带 action 就报错，多花一轮才改对）。一个都没有就推不出。
 */
export function inferRedditAction(input: Record<string, unknown>): string | undefined {
  const has = (k: string): boolean => typeof input[k] === 'string' && input[k] !== ''
  if (has('post_url')) return 'comments'
  if (has('query')) return 'search'
  if (has('subreddit')) return 'posts'
  return undefined
}

/** 模型给的入参 → 路由要的请求（认不出的动作回一句人话）。 */
export function redditReadRequestOf(
  input: Record<string, unknown>,
): RedditReadRequest | { error: string } {
  const given = typeof input.action === 'string' ? input.action.trim() : ''
  const action = given === '' ? (inferRedditAction(input) ?? '') : given
  const capability =
    ACTION_TO_CAPABILITY[action] ?? ACTION_TO_CAPABILITY[action.replace(/^social\.reddit\./, '')]
  if (capability === undefined)
    return {
      error:
        given === ''
          ? '没看出要做什么：搜帖子给 query，读一个版给 subreddit，读一条帖子的评论给 post_url。'
          : 'action 只能是 search / posts / comments。',
    }
  const picked: Record<string, unknown> = {}
  for (const k of INPUT_KEYS) if (input[k] !== undefined) picked[k] = input[k]
  // WP236：不给条数就取 10 条（按条计积分；原来走中台缺省 25 条）
  if (picked.limit === undefined) picked.limit = READ_REDDIT_DEFAULT_LIMIT
  if (capability === 'social.reddit.search' && typeof picked.query !== 'string')
    return { error: '搜帖子要给 query（搜什么）。' }
  if (capability === 'social.reddit.posts' && typeof picked.subreddit !== 'string')
    return { error: '读版要给 subreddit（版名）。' }
  if (capability === 'social.reddit.comments' && typeof picked.post_url !== 'string')
    return { error: '读评论要给 post_url（帖子地址）。' }
  return { capability, input: picked }
}

/** 接口中台那一跳的错误 → 路由认的两种（没配 / 走了没成）。WP328 的外部关键词巡查也用它。 */
export function redditHubOf(call: NonNullable<ResearchToolsOptions['callData']>): RedditHubPort {
  return {
    async call(capability, input) {
      try {
        const res = await call(capability, input)
        return {
          ok: true,
          items: res.items,
          cached: res.cached,
          credits: res.credits,
          fetched_at: res.fetched_at,
        }
      } catch (err) {
        const code = (err as { code?: unknown }).code
        const message = err instanceof Error ? err.message : String(err)
        // 没关联账号、云上这项能力还没开通、积分不够：都是「这一路现在用不了」
        const notConfigured = code === 'not_implemented' || code === 'budget_exhausted'
        return { ok: false, reason: notConfigured ? 'not_configured' : 'failed', message }
      }
    },
  }
}

export function createResearchToolExecutor(options: ResearchToolsOptions): ToolExecutor {
  // 路由建一次：限速要记得这个品牌刚才开过几页（顺序、停用、限速每次取数现读设置）
  const browserOf = options.browser
  const router = createRedditReadRouter({
    route: options.route,
    limits: options.limits,
    ...(options.limiter === undefined ? {} : { limiter: options.limiter }),
    ...(options.callData === undefined ? {} : { hub: redditHubOf(options.callData) }),
    ...(browserOf === undefined ? {} : { browser: () => browserOf() }),
    nowMs: options.nowMs,
    ...(options.onRecord === undefined ? {} : { onRecord: options.onRecord }),
  })
  const spent = new Map<string, number>()
  const addSpent = (run: string, credits: number): number => {
    const next = (spent.get(run) ?? 0) + credits
    spent.delete(run)
    spent.set(run, next)
    while (spent.size > SPENT_RUNS_KEPT) {
      const oldest = spent.keys().next().value
      if (oldest === undefined) break
      spent.delete(oldest)
    }
    return next
  }
  return async (call): Promise<ToolExecution> => {
    const bare = call.name.includes('.')
      ? call.name.slice(call.name.lastIndexOf('.') + 1)
      : call.name
    if (bare !== READ_REDDIT_TOOL)
      return { status: 'error', reason: `unsupported_tool: ${call.name}` }
    const req = redditReadRequestOf(call.input)
    if ('error' in req) return { status: 'error', reason: req.error }
    // WP411（#13）：按时间窗筛——没给时间档时按起点选最小的那一档；搜索按最新排
    const win = readWindowOf(call.input, options.tzOffsetMinutes?.() ?? 0)
    if ('error' in win) return { status: 'error', reason: win.error }
    if (win.since !== undefined) {
      if (req.input.time_window === undefined)
        req.input.time_window = coveringTimeWindow(win.since, options.nowMs())
      if (req.capability === 'social.reddit.search' && req.input.sort === undefined)
        req.input.sort = 'new'
    }
    /*
     * WP236 ⑨：每次运行的取数预算。用完了就不再取（两路都不走）、照实说；按价把这一次的条数收进
     * 剩下的预算里（一条都放不下就当用完）。10-06 真机：一次「看一眼」五次各 25 条，花了约 6.7 积分。
     */
    // 老调用方（测试里直接调执行器）可能不带 request：那就没有预算可言
    const budget = call.request === undefined ? undefined : options.creditBudget?.(call.request)
    const run = call.request?.id ?? ''
    const before = spent.get(run) ?? 0
    let clamped: number | undefined
    if (budget !== undefined) {
      const exhausted = {
        status: 'ok' as const,
        data: {
          rows: 0,
          items: [],
          budget_exhausted: true,
          credits: { used: before, budget },
          missing: creditExhaustedText(before, budget),
        },
      }
      if (before >= budget) return exhausted
      const price = await options.priceOf?.(req.capability)
      if (price !== undefined && price > 0) {
        const room = Math.floor((budget - before) / price + 1e-9)
        if (room < 1) return exhausted
        const want = typeof req.input.limit === 'number' ? req.input.limit : room
        if (want > room) {
          req.input.limit = room
          clamped = room
        }
      }
    }
    /** WP419：借插件（WP493 起 ego 能用时是 ego）现读一次。 */
    const viaBrowser = async () => {
      const plug = pluginReadOf(req)
      const res =
        plug === undefined || options.pluginRead === undefined
          ? { ok: false as const, why: '这台电脑上没有连着的「Agents 工坊助手」插件' }
          : await options.pluginRead([plug]).catch((err: unknown) => ({
              ok: false as const,
              why: err instanceof Error ? err.message : String(err),
            }))
      return { res, part: res.ok ? res.parts[0] : undefined }
    }
    const listingLimit = () =>
      typeof req.input.limit === 'number' ? req.input.limit : READ_REDDIT_DEFAULT_LIMIT
    // WP493：ego 连得上就先在 ego 里读（不花积分、用你在 ego 里登录的号）；没读到再走前两路
    const egoFirst = options.egoFirst?.() === true
    let early: Awaited<ReturnType<typeof viaBrowser>> | undefined
    let got: Awaited<ReturnType<typeof router.read>> | undefined
    if (egoFirst) {
      early = await viaBrowser()
      if (early.part?.ok === true) {
        const record: ResearchFetchRecord = {
          platform: 'reddit',
          capability: req.capability,
          route: 'extension',
          cached: false,
          fetched_at: new Date(options.nowMs()).toISOString(),
          items: early.part.items.length,
          attempts: [{ route: 'extension', outcome: 'ok' }],
        }
        options.onRecord?.(record)
        got = {
          ok: true,
          items: early.part.items.flatMap((x) => itemOfListing(x) ?? []).slice(0, listingLimit()),
          record,
        }
      }
    }
    got ??= await router.read(req)
    // WP419：两路都不行 → 借插件现读一次；还不行就照实说、叮嘱别找第三方站
    if (!got.ok) {
      // ego 先读过了就不再读一次
      const { res: viaPlugin, part } = early ?? (await viaBrowser())
      if (part?.ok === true) {
        const limit =
          typeof req.input.limit === 'number' ? req.input.limit : READ_REDDIT_DEFAULT_LIMIT
        got = {
          ok: true,
          items: part.items.flatMap((x) => itemOfListing(x) ?? []).slice(0, limit),
          record: {
            ...got.record,
            route: 'extension',
            items: part.items.length,
            attempts: [...got.record.attempts, { route: 'extension', outcome: 'ok' }],
          },
        }
        options.onRecord?.(got.record)
      } else {
        const why = viaPlugin.ok ? (part?.message ?? '插件没读到') : viaPlugin.why
        got = {
          ...got,
          message: egoFirst
            ? redditUnreadableText(`${got.message}；ego：${why}`, 'ego')
            : redditUnreadableText(`${got.message}；插件：${why}`),
        }
      }
    }
    const used = budget === undefined ? before : addSpent(run, got.record.credits ?? 0)
    const notice =
      budget === undefined
        ? undefined
        : used >= budget
          ? creditExhaustedText(used, budget)
          : used >= budget * DATA_CREDIT_WARN_RATIO
            ? `这次取数预算已用 ${Math.round((used / budget) * 100)}%（${fmt(used)} / ${fmt(budget)} 积分）：请收尾，别再换词搜了，用已经取到的数据写结论。`
            : clamped === undefined
              ? undefined
              : `按剩下的取数预算，这次只取了 ${clamped} 条。`
    const budgetInfo =
      budget === undefined
        ? {}
        : { credits: { used, budget }, ...(notice === undefined ? {} : { notice }) }
    if (got.ok && (win.since !== undefined || win.until !== undefined)) {
      const inside = got.items.filter((it) => {
        const at = it.created_at === undefined ? Number.NaN : Date.parse(it.created_at)
        if (!Number.isFinite(at)) return false
        return (
          (win.since === undefined || at >= win.since) &&
          (win.until === undefined || at <= win.until)
        )
      })
      const outside = got.items.length - inside.length
      const window = {
        ...(win.since === undefined ? {} : { since: new Date(win.since).toISOString() }),
        ...(win.until === undefined ? {} : { until: new Date(win.until).toISOString() }),
        outside,
      }
      return {
        status: 'ok',
        data: {
          rows: inside.length,
          items: inside,
          window,
          source: got.record,
          ...budgetInfo,
          ...(inside.length === 0 && got.items.length > 0
            ? {
                missing: `取回 ${got.items.length} 条都不在这段时间里（这一路每次只给最近 ${String(req.input.limit ?? '')} 条，时间太早的取不到）——那不是「这段时间 0 条」。要把这段补齐，用 run_watch_now 带 since / until 在用户浏览器里读。`,
              }
            : {}),
        },
      }
    }
    return got.ok
      ? {
          status: 'ok',
          data: { rows: got.items.length, items: got.items, source: got.record, ...budgetInfo },
        }
      : {
          status: 'ok',
          data: { rows: 0, items: [], missing: got.message, source: got.record, ...budgetInfo },
        }
  }
}

/**
 * WP237（#67，Fable 定）：给模型看的 `read_reddit` 描述里写的那个单价，每次运行按价目表现查。
 *
 * 一个工具背后是三项能力（搜帖 / 读版 / 读评论）：三项都查得到且同价才回那个数；
 * 价不一样（一句「约 N 积分一条」说不准）或者有一项查不到，就回 `undefined`——描述里只写「按条计积分」。
 */
export async function redditReadPrice(
  tool: string,
  priceOf: (capability: string) => Promise<{ credits: number } | undefined>,
): Promise<number | undefined> {
  if (tool !== READ_REDDIT_TOOL) return undefined
  const prices = await Promise.all(
    ['social.reddit.search', 'social.reddit.posts', 'social.reddit.comments'].map(
      async (c) => (await priceOf(c).catch(() => undefined))?.credits,
    ),
  )
  const first = prices[0]
  if (first === undefined || prices.some((p) => p !== first)) return undefined
  return first
}
