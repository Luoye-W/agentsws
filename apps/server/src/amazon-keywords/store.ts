/**
 * WP398（docs/106 §13 A8）：词库落盘——品牌目录下一个 `amazon-keywords.json`（本机，不上云）。
 *
 * - `keywords`：词库本身（二期广告单、Listing 改写读同一份）；
 * - `listings`：拆词用的 Listing 文本，按「自家 / 竞品 + ASIN」只留最新一份；
 * - `gaps`：最近一次算出的差距词（体检卡那一行、面板读这里）；
 * - `refreshes`：最近 {@link MAX_REFRESHES} 次刷新；
 * - `seeds` / `seed_cursor`：联想词的种子词（用户 / AI 给的）与下一次从哪个读起；
 * - `blocked_until`：Amazon 出过验证页之后，到这个时刻之前不再去读联想词（不绕、不重试）；
 * - `own_browser_rest`：WP408（决策 1155）在用户自己的浏览器里一批只读 9 页，这个种子词还剩哪几页留给下一轮。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  AmazonKeyword,
  AmazonKeywordGap,
  AmazonKeywordRefresh,
  AmazonListingText,
  Iso8601,
} from '@agentsws/contracts'

export const MAX_REFRESHES = 20

export interface KeywordStateFile {
  version: 1
  keywords: AmazonKeyword[]
  listings: AmazonListingText[]
  gaps: AmazonKeywordGap[]
  refreshes: AmazonKeywordRefresh[]
  seeds: string[]
  seed_cursor: number
  blocked_until?: Iso8601
  own_browser_rest?: OwnBrowserRest
  updated_at?: Iso8601
}

/** WP408（决策 1155）：用户自己的浏览器那一批没读到的几页（同一个种子词、同一站下一轮先读这几页）。 */
export interface OwnBrowserRest {
  seed: string
  marketplace: string
  prefixes: string[]
}

const restOf = (raw: unknown): OwnBrowserRest | undefined => {
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as Partial<OwnBrowserRest>
  if (typeof r.seed !== 'string' || typeof r.marketplace !== 'string') return undefined
  const prefixes = Array.isArray(r.prefixes)
    ? r.prefixes.filter((x): x is string => typeof x === 'string')
    : []
  return prefixes.length === 0 ? undefined : { seed: r.seed, marketplace: r.marketplace, prefixes }
}

export interface KeywordStore {
  state(): KeywordStateFile
  /** 改完一处就存（整份写，先写临时文件再改名）。 */
  update(fn: (s: KeywordStateFile) => void): void
}

const empty = (): KeywordStateFile => ({
  version: 1,
  keywords: [],
  listings: [],
  gaps: [],
  refreshes: [],
  seeds: [],
  seed_cursor: 0,
})

export function createKeywordStore(dir: string | undefined): KeywordStore {
  const file = dir === undefined ? undefined : join(dir, 'amazon-keywords.json')
  const state: KeywordStateFile = ((): KeywordStateFile => {
    if (file !== undefined && existsSync(file))
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<KeywordStateFile>
        if (raw.version === 1)
          return {
            ...empty(),
            keywords: Array.isArray(raw.keywords) ? raw.keywords : [],
            listings: Array.isArray(raw.listings) ? raw.listings : [],
            gaps: Array.isArray(raw.gaps) ? raw.gaps : [],
            refreshes: Array.isArray(raw.refreshes) ? raw.refreshes : [],
            seeds: Array.isArray(raw.seeds) ? raw.seeds.filter((x) => typeof x === 'string') : [],
            seed_cursor: typeof raw.seed_cursor === 'number' ? raw.seed_cursor : 0,
            ...(raw.blocked_until === undefined ? {} : { blocked_until: raw.blocked_until }),
            ...((rest) => (rest === undefined ? {} : { own_browser_rest: rest }))(
              restOf(raw.own_browser_rest),
            ),
            ...(raw.updated_at === undefined ? {} : { updated_at: raw.updated_at }),
          }
      } catch {
        // 坏了就当还没有词库（下次刷新重建）
      }
    return empty()
  })()
  const save = (): void => {
    if (file === undefined || dir === undefined) return
    mkdirSync(dir, { recursive: true })
    writeFileSync(`${file}.tmp`, JSON.stringify(state))
    renameSync(`${file}.tmp`, file)
  }
  return {
    state: () => state,
    update(fn) {
      fn(state)
      state.refreshes = state.refreshes.slice(-MAX_REFRESHES)
      save()
    },
  }
}
