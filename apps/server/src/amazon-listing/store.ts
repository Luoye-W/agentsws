/**
 * WP396（docs/106 §13）：Listing 体检落盘——品牌目录下一个 `amazon-listing.json`（本机，不上云）。
 *
 * - `runs`：体检结果，按时间留最近 {@link MAX_RUNS} 次（「上次 6 处、修了 4 处」靠它）；
 * - `rule_overrides`：用户改过的建议值 / 开关 / 核对日期（规则表本身是 `seo-core` 的数据文件）；
 * - `own_sellers`：自家店铺名（判购物车是不是你；没设就用品牌名）；
 * - `candidates`：自家 ASIN 没填时按品牌名搜到的候选（配置卡上让人勾）。
 *
 * 自家 ASIN 清单**不在这里**：唯一一份是关注设置的 `BrandWatch.brand.amazon`（WP392）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Iso8601, ListingCheckupRun, ListingRuleOverride } from '@agentsws/contracts'

export const MAX_RUNS = 20

export interface OwnAsinCandidate {
  marketplace: string
  asin: string
  title: string
}

export interface ListingStateFile {
  version: 1
  runs: ListingCheckupRun[]
  rule_overrides: Record<string, ListingRuleOverride>
  own_sellers?: string[]
  candidates?: { at: Iso8601; query: string; items: OwnAsinCandidate[] }
}

export interface ListingStore {
  state(): ListingStateFile
  saveRun(run: ListingCheckupRun): void
  setOverride(rule_id: string, o: ListingRuleOverride | undefined): void
  setOwnSellers(names: string[] | undefined): void
  setCandidates(c: ListingStateFile['candidates']): void
}

export function createListingStore(dir: string | undefined): ListingStore {
  const file = dir === undefined ? undefined : join(dir, 'amazon-listing.json')
  const state: ListingStateFile = ((): ListingStateFile => {
    if (file !== undefined && existsSync(file))
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<ListingStateFile>
        if (raw.version === 1)
          return {
            version: 1,
            runs: Array.isArray(raw.runs) ? raw.runs : [],
            rule_overrides: raw.rule_overrides ?? {},
            ...(raw.own_sellers === undefined ? {} : { own_sellers: raw.own_sellers }),
            ...(raw.candidates === undefined ? {} : { candidates: raw.candidates }),
          }
      } catch {
        // 坏了就当没体检过（规则表用自带的）
      }
    return { version: 1, runs: [], rule_overrides: {} }
  })()
  const save = (): void => {
    if (file === undefined || dir === undefined) return
    mkdirSync(dir, { recursive: true })
    writeFileSync(`${file}.tmp`, JSON.stringify(state))
    renameSync(`${file}.tmp`, file)
  }
  return {
    state: () => state,
    saveRun(run) {
      state.runs = [...state.runs, run].slice(-MAX_RUNS)
      save()
    },
    setOverride(rule_id, o) {
      if (o === undefined) delete state.rule_overrides[rule_id]
      else state.rule_overrides[rule_id] = o
      save()
    },
    setOwnSellers(names) {
      if (names === undefined || names.length === 0) delete state.own_sellers
      else state.own_sellers = names
      save()
    },
    setCandidates(c) {
      if (c === undefined) delete state.candidates
      else state.candidates = c
      save()
    },
  }
}
