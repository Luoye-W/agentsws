/**
 * WP353：联网搜索后端（工坊内置浏览器搜 Google → Bing → 云端 Google → 公开搜索服务）。
 * WP355：名单里的模型来源（第一版只有 ChatGPT 订阅）先用它自带的搜索，不行再走上面那条链。
 */
export {
  type AmazonDeliveryResult,
  type OpenResult,
  SEARCH_BROWSER_TOKEN_ENV,
  SEARCH_BROWSER_URL_ENV,
  type SearchBrowserChannel,
  searchBrowserChannelFromEnv,
} from './channel.js'
export { type Block, type BlockKind, blockOf } from './detect.js'
export {
  bingSearchUrl,
  googleSearchUrl,
  type LocaleProfile,
  type SearchLocale,
  searchLocaleLine,
  searchLocaleOf,
} from './locale.js'
export {
  NATIVE_SEARCH_LABEL,
  NATIVE_SEARCH_SOURCES,
  type NativeSearchPort,
  type NativeSearchSource,
  nativeSearchSourceOf,
  type SearchWho,
} from './native.js'
// WP402（决策 1140 / 1146）：取数链第 3 条路——通过插件在用户自己的浏览器里读一页（只读）
export {
  type BskJson,
  bskJsonOf,
  createOwnBrowserReader,
  dataTextOfHtml,
  OWN_BROWSER_PAGE_TIMEOUT_MS,
  type OwnBrowserReader,
  type OwnBrowserReaderOptions,
} from './own-browser.js'
export {
  BROWSER_FETCH_HOSTS,
  type BrowserSearchResult,
  type BrowserWebSearch,
  type BrowserWebSearchOptions,
  CONSENT_HANDOVER_LINE,
  CONSENT_MESSAGE,
  createBrowserWebSearch,
  createSearchThrottle,
  ENGINE_TIMEOUT_MS,
  type FetchedPage,
  GOOGLE_HOME,
  HANDOVER_MESSAGE,
  type KeylessSearch,
  SEARCH_CACHE_TTL_MS,
  SEARCH_TRACE_MAX,
  type SearchSource,
  type SearchStepResult,
  type SearchThrottle,
  type SearchTraceEntry,
  type SearchTraceStep,
  type SearchVia,
} from './search.js'
