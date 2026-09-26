/**
 * WP155（docs/81）：搜索数据接口的 HTTP 投影（本机）。
 *
 * 两组路：
 *
 * 1. **连接页「搜索数据」那一行**：看 / 选档（官方用积分 / 自带 key / 不接）/ 填自带 key /
 *    拔掉 / 测试连接。与场景切换、浏览器设置同一档权限：读 `store_config.read@workspace`，
 *    改 `policy.stage@workspace`——只有所有者动得了（官方那一档花的是组织的积分）。
 * 2. **查**：SERP 与 AI 问答探测。权限挂 `analytics.read`——「内容与搜索」职责
 *    本来就有这一格（看 Search Console 的那一格），花积分由云端钱包按次扣。
 *
 * key 纪律：自带 key 只从 PUT 的请求体进来一次，进本机加密库，**永不回传**
 * （读视图里只有 `has_key`）；请求体不进日志。
 */
import type {
  AiAnswerProbe,
  AiAnswerResult,
  MaybePromise,
  SearchDataProvider,
  SearchDataRouteChoice,
  SearchDataSettingsView,
  SerpQuery,
  SerpResult,
} from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { body, ok, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'

const READ = {
  domain: 'store_config',
  op: 'read',
  range: 'workspace',
  sensitivity: 'internal',
} as const

const WRITE = {
  domain: 'policy',
  op: 'stage',
  range: 'workspace',
  sensitivity: 'restricted',
} as const

/**
 * 查询挂 `analytics.read`，range 要最低那一档 `own`：搜索结果是公开数据、不读也不写任何
 * 本地记录，要的只是「这个分配能看分析数据」。所有者（workspace）与「内容与搜索」职责
 * （assigned）都覆盖 own；要 assigned 的话所有者反而被拦（它的分配没有 ranges）。
 */
const QUERY = {
  domain: 'analytics',
  op: 'read',
  range: 'own',
  sensitivity: 'internal',
} as const

const TAG = 'search-data'

export interface SearchDataActor {
  workspace_id: string
  person_id: string
}

export interface SearchDataApiPort {
  settings(actor: SearchDataActor): MaybePromise<SearchDataSettingsView>
  setChoice(
    actor: SearchDataActor,
    choice: SearchDataRouteChoice,
  ): MaybePromise<SearchDataSettingsView>
  setByo(
    actor: SearchDataActor,
    input: { provider: SearchDataProvider; api_key?: string },
  ): MaybePromise<SearchDataSettingsView>
  clearByo(actor: SearchDataActor): MaybePromise<{ cleared: boolean }>
  testByo(
    actor: SearchDataActor,
    input: { provider?: SearchDataProvider; api_key?: string },
  ): MaybePromise<{ ok: boolean; message: string }>
  serp(actor: SearchDataActor, q: SerpQuery): MaybePromise<SerpResult>
  aiAnswers(actor: SearchDataActor, p: AiAnswerProbe): MaybePromise<{ results: AiAnswerResult[] }>
}

const Provider = z.enum(['dataforseo', 'serpapi', 'serper'])
const ChoiceBody = z.object({ choice: z.enum(['auto', 'official', 'byo', 'none']) })
const ByoBody = z.object({ provider: Provider, api_key: z.string().max(512).optional() })
const TestBody = z.object({
  provider: Provider.optional(),
  api_key: z.string().max(512).optional(),
})
const SerpBody = z.object({
  query: z.string().min(1).max(400),
  engine: z.enum(['google', 'bing']),
  country: z.string().min(2).max(8),
  language: z.string().min(2).max(16),
  device: z.enum(['desktop', 'mobile']).optional(),
})
const Platform = z.enum(['chatgpt', 'perplexity', 'gemini', 'google_ai_overview', 'copilot'])
const ProbeBody = z.object({
  question: z.string().min(1).max(1000),
  platforms: z.array(Platform).min(1).max(5),
  country: z.string().min(2).max(8),
  language: z.string().min(2).max(16),
  brand: z.object({
    name: z.string().min(1).max(200),
    domains: z.array(z.string().max(253)).max(20),
  }),
  competitors: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        domains: z.array(z.string().max(253)).max(20).optional(),
      }),
    )
    .max(30)
    .optional(),
})

function portOf(deps: GatewayDeps): SearchDataApiPort {
  const p = deps.searchData
  if (p === undefined)
    throw new ApiError(
      'not_implemented',
      '这个服务进程没有装配搜索数据接口（GatewayDeps.searchData）',
    )
  return p
}

function actorOf(c: Parameters<typeof principalOf>[0]): SearchDataActor {
  const p = principalOf(c)
  return { workspace_id: p.workspace_id, person_id: p.person_id }
}

/** zod 解出来的可选字段带着 `undefined`——契约开了 exactOptionalPropertyTypes，这里去掉。 */
function defined<T extends Record<string, unknown>>(
  o: T,
): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]: Exclude<T[K], undefined>
  }
}

export function searchDataRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/search-data',
        operationId: 'getSearchDataSettings',
        summary:
          'WP155：连接页「搜索数据」那一行——选的哪一档、自带 key 设没设过（key 永不回传）、现在能不能用',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'SearchDataSettingsView',
      },
      async (c, deps) => ok(c, await portOf(deps).settings(actorOf(c))),
    ),
    route(
      {
        method: 'put',
        path: '/v1/search-data/choice',
        operationId: 'setSearchDataChoice',
        summary:
          'WP155：选档——官方（用积分）/ 自带 key / 不接；auto = 按「官方 → 自带 → 不接」自动挑',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: ChoiceBody,
        returns: 'SearchDataSettingsView',
      },
      async (c, deps) => {
        const input = await body(c, ChoiceBody)
        return ok(c, await portOf(deps).setChoice(actorOf(c), input.choice))
      },
    ),
    route(
      {
        method: 'put',
        path: '/v1/search-data/byo',
        operationId: 'setSearchDataByo',
        summary:
          'WP155：接自带的搜索数据 key（选服务商 + 填 key）。key 只进本机加密库；本机直连服务商、走你自己的额度，不扣积分',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: ByoBody,
        returns: 'SearchDataSettingsView',
      },
      async (c, deps) => {
        const input = defined(await body(c, ByoBody))
        return ok(c, await portOf(deps).setByo(actorOf(c), input))
      },
    ),
    route(
      {
        method: 'delete',
        path: '/v1/search-data/byo',
        operationId: 'clearSearchDataByo',
        summary: 'WP155：拔掉自带的搜索数据 key（加密库里那一格一并清掉）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        returns: '{ cleared }',
      },
      async (c, deps) => ok(c, await portOf(deps).clearByo(actorOf(c))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/search-data/byo/test',
        operationId: 'testSearchDataByo',
        summary: 'WP155：「测试连接」——用填的（或已存的）key 打一次服务商最便宜的那个口',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: TestBody,
        returns: '{ ok, message }',
      },
      async (c, deps) => {
        const input = defined(await body(c, TestBody))
        return ok(c, await portOf(deps).testByo(actorOf(c), input))
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/search-data/serp',
        operationId: 'searchDataSerp',
        summary:
          'WP155：查一次搜索结果页（Google / Bing，按国家 / 语言 / 设备）。走官方数据接口时按次扣积分，命中缓存同价，失败不扣',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: QUERY,
        body: SerpBody,
        returns: 'SerpResult',
      },
      async (c, deps) => {
        const input = defined(await body(c, SerpBody)) as SerpQuery
        return ok(c, await portOf(deps).serp(actorOf(c), input))
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/search-data/ai-answers',
        operationId: 'searchDataAiAnswers',
        summary:
          'WP155：问几个 AI 平台同一个问题，看有没有提到你、引用了谁、提到了哪些竞品。官方数据接口按「每个平台一次」扣积分，只收成功的',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: QUERY,
        body: ProbeBody,
        returns: '{ results: AiAnswerResult[] }',
      },
      async (c, deps) => {
        const input = defined(await body(c, ProbeBody)) as AiAnswerProbe
        return ok(c, await portOf(deps).aiAnswers(actorOf(c), input))
      },
    ),
  ]
}
