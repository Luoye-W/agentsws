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
 * 这一跳不往外写任何东西；正文是外部文本，由运行时围栏后再进模型上下文。
 */
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
  createRedditReadRouter,
  type RedditHubPort,
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

/** 接口中台那一跳的错误 → 路由认的两种（没配 / 走了没成）。 */
function hubOf(call: NonNullable<ResearchToolsOptions['callData']>): RedditHubPort {
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
        // 没关联账号、云上这项能力还没开通、积分不够、数据驻留挡住：都是「这一路现在用不了」
        const notConfigured =
          code === 'not_implemented' || code === 'budget_exhausted' || code === 'residency_blocked'
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
    ...(options.callData === undefined ? {} : { hub: hubOf(options.callData) }),
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
    const got = await router.read(req)
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
