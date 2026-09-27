/**
 * `@agentsws/search-providers` —— 搜索数据服务商的适配器（docs/81 §3；WP165 从
 * `@agentsws/cloud-entry` 拆出来，docs/83 §2 第 3 条）。
 *
 * 两条路共用这一份：
 * - **自带 key**（`apps/server` 的 `search-data.ts`）：本机直连，key 从本机加密库取；
 * - **官方**（云上的 `/v1/data/search/*`）：云上的服务商 key，预扣 → 取数 → 结算。
 *
 * 所以同一段回答不管从哪条路来，「提没提到我们」判出来都一样。纯逻辑、不起服务、
 * 不碰钱；计费、缓存、路由都不在这里。
 */
export {
  domainMatches,
  domainOf,
  excerptOf,
  judgeAnswer,
  mentions,
  normalizeProbe,
  normalizeSerpQuery,
  redact,
  SearchDataError,
  uniqueUrls,
} from './analyze.js'
export {
  AI_ANSWER_TIMEOUT_MS,
  type AiAnswerInput,
  type ProviderAnswer,
  type ProviderSerp,
  SERP_TIMEOUT_MS,
  type SearchFetch,
  type SearchProviderAdapter,
  type SearchResponseLike,
} from './provider.js'
export { SEARCH_PROVIDERS, searchProviderOf } from './providers/index.js'
