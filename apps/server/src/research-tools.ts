/**
 * WP220（Luoye 10-05）：**只读 Reddit** 这个工具真去取数——走 `@agentsws/social-core` 的 Reddit 两路路由：
 *
 * 1. 接口中台（`social.reddit.*` 三项能力，积分）：本机数据能力口（`createDataService`）转给云上；
 * 2. 浏览器只读：要一个**单独的只读会话**的执行器（`browser` 那一格）。这一版服务进程还没有
 *    能程序化开页面的只读浏览器执行器，不给 = 这一路「没配」，照实说，不拿 Agent 的浏览器凑。
 *
 * 顺序与停用来自设置（`reddit.read`），限速来自设置（默认保守）。两路都不行回 `status: 'ok'`
 * 加一句人话（「没取到，这不等于没人在聊」），不当错误抛——研究那一边要把它写进报告的「从哪取的」。
 *
 * 这一跳不往外写任何东西；正文是外部文本，由运行时围栏后再进模型上下文。
 */
import type {
  DataCallResult,
  DataSourceRoute,
  RedditBrowserReadLimits,
  RedditReadCapability,
  ResearchFetchRecord,
} from '@agentsws/contracts'
import {
  createRedditReadRouter,
  type RedditHubPort,
  type RedditReadBrowser,
  type RedditReadRequest,
} from '@agentsws/social-core'
import type { ToolExecution, ToolExecutor } from '@agentsws/stand-ins'
import { READ_REDDIT_TOOL } from '@agentsws/stand-ins'

export interface ResearchToolsOptions {
  /** 这个品牌的 Reddit 取数路由（设置里的 `reddit.read`）。 */
  route(): DataSourceRoute
  /** 浏览器只读的限速（设置里来，默认保守）。 */
  limits(): RedditBrowserReadLimits
  /** 接口中台那一跳（本机数据能力口的 `call`）；没关联 / 没开通时它自己抛。 */
  callData?(capability: string, input: Record<string, unknown>): Promise<DataCallResult>
  /** 浏览器只读执行器（单独的只读会话）。不给 = 这一路没配。 */
  browser?(): RedditReadBrowser | undefined
  nowMs(): number
  /** 每次取数记一条（审计）。 */
  onRecord?(record: ResearchFetchRecord): void
}

const ACTION_TO_CAPABILITY: Record<string, RedditReadCapability> = {
  search: 'social.reddit.search',
  posts: 'social.reddit.posts',
  comments: 'social.reddit.comments',
}

const INPUT_KEYS = ['query', 'subreddit', 'time_window', 'sort', 'limit', 'post_url'] as const

/** 模型给的入参 → 路由要的请求（认不出的动作回一句人话）。 */
export function redditReadRequestOf(
  input: Record<string, unknown>,
): RedditReadRequest | { error: string } {
  const action = typeof input.action === 'string' ? input.action : ''
  const capability =
    ACTION_TO_CAPABILITY[action] ?? ACTION_TO_CAPABILITY[action.replace(/^social\.reddit\./, '')]
  if (capability === undefined) return { error: 'action 只能是 search / posts / comments。' }
  const picked: Record<string, unknown> = {}
  for (const k of INPUT_KEYS) if (input[k] !== undefined) picked[k] = input[k]
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
    ...(options.callData === undefined ? {} : { hub: hubOf(options.callData) }),
    ...(browserOf === undefined ? {} : { browser: () => browserOf() }),
    nowMs: options.nowMs,
    ...(options.onRecord === undefined ? {} : { onRecord: options.onRecord }),
  })
  return async (call): Promise<ToolExecution> => {
    const bare = call.name.includes('.')
      ? call.name.slice(call.name.lastIndexOf('.') + 1)
      : call.name
    if (bare !== READ_REDDIT_TOOL)
      return { status: 'error', reason: `unsupported_tool: ${call.name}` }
    const req = redditReadRequestOf(call.input)
    if ('error' in req) return { status: 'error', reason: req.error }
    const got = await router.read(req)
    return got.ok
      ? { status: 'ok', data: { rows: got.items.length, items: got.items, source: got.record } }
      : { status: 'ok', data: { rows: 0, items: [], missing: got.message, source: got.record } }
  }
}
