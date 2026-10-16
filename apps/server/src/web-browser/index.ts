/** WP353：联网搜索后端（工坊内置浏览器搜 Google → Bing → 云端 Google → 公开搜索服务）。 */
export {
  type OpenResult,
  SEARCH_BROWSER_TOKEN_ENV,
  SEARCH_BROWSER_URL_ENV,
  type SearchBrowserChannel,
  searchBrowserChannelFromEnv,
} from './channel.js'
export { type Block, blockOf } from './detect.js'
export {
  bingSearchUrl,
  googleSearchUrl,
  type LocaleProfile,
  type SearchLocale,
  searchLocaleLine,
  searchLocaleOf,
} from './locale.js'
export {
  BROWSER_FETCH_HOSTS,
  type BrowserSearchResult,
  type BrowserWebSearch,
  type BrowserWebSearchOptions,
  createBrowserWebSearch,
  createSearchThrottle,
  type FetchedPage,
  HANDOVER_MESSAGE,
  type KeylessSearch,
  SEARCH_CACHE_TTL_MS,
  type SearchSource,
  type SearchThrottle,
  type SearchVia,
} from './search.js'
