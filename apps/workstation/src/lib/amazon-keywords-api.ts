/**
 * WP398（docs/106 §13 A8）：Amazon 词库的接口——摘要、词表、现在刷新、标一个词；第三栏词表的地址。
 *
 * 单独一个文件（`api.ts` 那张大表好几单同时在加），形状直接用契约里那几个类型。
 */
import type {
  AmazonKeyword,
  AmazonKeywordBankView,
  AmazonKeywordMarkPatch,
  AmazonKeywordPage,
  AmazonKeywordQuery,
  AmazonKeywordRefresh,
} from '@agentsws/contracts'
import { api } from './api'

export type {
  AmazonKeyword,
  AmazonKeywordBankView,
  AmazonKeywordGap,
  AmazonKeywordMark,
  AmazonKeywordPage,
  AmazonKeywordRow,
  AmazonKeywordSource,
} from '@agentsws/contracts'

const as = (assignment: string | undefined) => (assignment === undefined ? {} : { assignment })

/** 第三栏「词表」的地址：`agentsws://amazon-keywords/<分配>`（`all` = 用当前那条分配）。 */
export const AMAZON_KEYWORDS_ADDRESS_PREFIX = 'agentsws://amazon-keywords/'

export function amazonKeywordsAddress(assignment?: string): string {
  return `${AMAZON_KEYWORDS_ADDRESS_PREFIX}${assignment === undefined ? 'all' : encodeURIComponent(assignment)}`
}

/** 地址里的分配（`all` / 认不出 = `undefined`，用当前那条）。 */
export function parseAmazonKeywordsAddress(address: string | undefined): string | undefined {
  if (address === undefined || !address.startsWith(AMAZON_KEYWORDS_ADDRESS_PREFIX)) return undefined
  const rest = decodeURIComponent(address.slice(AMAZON_KEYWORDS_ADDRESS_PREFIX.length))
  return rest === '' || rest === 'all' ? undefined : rest
}

export const getAmazonKeywords = (assignment?: string): Promise<AmazonKeywordBankView> =>
  api('/v1/amazon-keywords', as(assignment))

export function listAmazonKeywords(
  query: AmazonKeywordQuery,
  assignment?: string,
): Promise<AmazonKeywordPage> {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(query))
    if (v !== undefined && v !== false && v !== '') q.set(k, String(v))
  const s = q.toString()
  return api(`/v1/amazon-keywords/list${s === '' ? '' : `?${s}`}`, as(assignment))
}

export const refreshAmazonKeywords = (
  input: { seeds?: string[]; marketplace?: string; autocomplete?: boolean },
  assignment?: string,
): Promise<{ refresh: AmazonKeywordRefresh; view: AmazonKeywordBankView }> =>
  api('/v1/amazon-keywords/refresh', { method: 'POST', body: input, ...as(assignment) })

export const markAmazonKeyword = (
  patch: AmazonKeywordMarkPatch,
  assignment?: string,
): Promise<AmazonKeyword> =>
  api('/v1/amazon-keywords/mark', { method: 'POST', body: patch, ...as(assignment) })
