/**
 * WP398（docs/106 §5.6 / §13 A8）：Amazon 词库——前台联想词 + 竞品 / 自家 Listing 拆词 + 「竞品有、你没有」的差距。
 */
export {
  type AmazonAutocompleteReader,
  AUTOCOMPLETE_TIMEOUT_MS,
  type AutocompleteRead,
  createBrowserAutocompleteReader,
} from './reader.js'
export {
  type AmazonKeywordBank,
  type AmazonKeywordBankOptions,
  AUTOCOMPLETE_BLOCK_PAUSE_MS,
  createAmazonKeywordBank,
  type KeywordBrandInfo,
  latestListings,
  type RefreshInput,
} from './service.js'
export { createKeywordStore, type KeywordStateFile, type KeywordStore } from './store.js'
export {
  listingTextsFromFacts,
  listingTextsFromSnapshots,
} from './texts.js'
export { type AmazonKeywordToolsOptions, createAmazonKeywordToolExecutor } from './tools.js'
