// WP155（docs/81）：搜索数据接口——官方那三条路；三家适配器、判断与校验 WP165 起住在开源包
// `@agentsws/search-providers`（本机自带 key 那一档也用），这里原样转出，老的导入不用改
export {
  AI_ANSWER_TIMEOUT_MS,
  type AiAnswerInput,
  domainMatches,
  domainOf,
  excerptOf,
  judgeAnswer,
  mentions,
  normalizeProbe,
  normalizeSerpQuery,
  type ProviderAnswer,
  type ProviderSerp,
  redact,
  SEARCH_PROVIDERS,
  SERP_TIMEOUT_MS,
  SearchDataError,
  type SearchFetch,
  type SearchProviderAdapter,
  type SearchResponseLike,
  searchProviderOf,
} from '@agentsws/search-providers'
export {
  aiRoutes,
  cnAllowed,
  embeddingTokensOf,
  inputTokensOf,
  REGION_HEADER,
} from './ai.js'
export {
  authenticate,
  bearerToken,
  createEntryApp,
  entryRoutes,
  errorResponse,
  mountEntryRoutes,
  WORKSPACE_TOKEN_PREFIX,
} from './routes.js'
export { MemorySearchCache, SEARCH_CACHE_TTL_MS, type SearchCache } from './search/cache.js'
export {
  answerCacheKey,
  type OfficialAiAnswers,
  officialError,
  officialStatus,
  type SkippedPlatform,
  searchRoutes,
  serpCacheKey,
} from './search/routes.js'
export type { WebhookOutcome } from './stripe.js'
export {
  createCheckoutSession,
  handleStripeWebhook,
  notImplementedProvider,
  STRIPE_API_BASE,
  topupOrderOf,
  verifyStripeSignature,
  WEBHOOK_TOLERANCE_SECONDS,
} from './stripe.js'
export type {
  AiUpstream,
  EntryDeps,
  EntryEnv,
  EntryErrorCode,
  EntryPrincipal,
  EntryRoute,
  FetchLike,
  RegionMap,
  SearchUpstream,
  StripeConfig,
  TokenVerifier,
} from './types.js'
export { ENTRY_STATUS, EntryError, secretOf } from './types.js'
export { monthStart, WALLET_ADMIN_SCOPE, walletRoutes } from './wallet-routes.js'
