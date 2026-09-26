/**
 * 这条职责从外面读的两样东西，各一个口（注入；本包不实现任何真请求）：
 *
 * - `SearchConsolePort`：Search Console 的「查询 × 页面」行与收录状况。真连接器还没做
 *   （连接目录里那张卡是"待增加"）——所以服务端今天接的是替身或"没连"。
 * - `SearchDataPort`（契约在 `@agentsws/contracts`，WP155 实现）：SERP + AI 问答探测。
 *   WP155 还没合进来时用 {@link unconfiguredSearchData}：`configured: false`，
 *   SERP 检查与 GEO 探测跳过，卡上一句人话，其余照跑（WP154 §7）。
 *
 * 替身只从调用方给的固定数据里回答，不联网、不花钱（测试与模拟用）。
 */
import type {
  AiAnswerProbe,
  AiAnswerResult,
  GscRow,
  SearchDataPort,
  SearchDataStatus,
  SerpQuery,
  SerpResult,
  SitePage,
} from '@agentsws/contracts'
import { normalizeQuery } from './signals.js'

export interface SearchConsolePort {
  /** 连没连（没连 = 卡上明说「接上才看得到」，不是"今天没数据"）。 */
  connected(): boolean
  /** 近 7 天「查询 × 页面」行，带上一个 7 天的点击。 */
  rows(input: { end: string }): Promise<GscRow[]>
  /** 店里的页与收录状况（拉不到给空数组）。 */
  pages(): Promise<SitePage[]>
}

/** 没连 Search Console。 */
export function disconnectedSearchConsole(): SearchConsolePort {
  return {
    connected: () => false,
    rows: () => Promise.resolve([]),
    pages: () => Promise.resolve([]),
  }
}

/** 替身：固定几行。 */
export function standInSearchConsole(data: {
  rows: readonly GscRow[]
  pages?: readonly SitePage[]
}): SearchConsolePort {
  return {
    connected: () => true,
    rows: () => Promise.resolve(data.rows.map((r) => ({ ...r }))),
    pages: () => Promise.resolve((data.pages ?? []).map((p) => ({ ...p }))),
  }
}

export const SEARCH_DATA_NOT_CONFIGURED = '搜索数据接口还没接'

/** WP155 还没合进来 / 用户选了「不接」：`route: 'none'`，一次都不查。 */
export function unconfiguredSearchData(reason = SEARCH_DATA_NOT_CONFIGURED): SearchDataPort {
  const status: SearchDataStatus = { configured: false, route: 'none', reason }
  const refuse = () => Promise.reject(new Error(reason))
  return {
    status: () => Promise.resolve(status),
    serp: refuse,
    aiAnswers: refuse,
  }
}

/**
 * 替身：SERP 按查询字面、AI 问答按问题字面从固定数据里取（查不到回空结果，不编）。
 * `calls` 记下每一次调用——测试断言"没接的时候一次都没查"读它。
 */
export function standInSearchData(fixtures: {
  serp?: Readonly<Record<string, Omit<SerpResult, 'query'>>>
  answers?: Readonly<Record<string, readonly AiAnswerResult[]>>
  route?: 'official' | 'byo'
}): SearchDataPort & { calls: { kind: 'serp' | 'ai'; key: string }[] } {
  const calls: { kind: 'serp' | 'ai'; key: string }[] = []
  const serpBy = new Map(
    Object.entries(fixtures.serp ?? {}).map(([k, v]) => [normalizeQuery(k), v]),
  )
  const aiBy = new Map(
    Object.entries(fixtures.answers ?? {}).map(([k, v]) => [normalizeQuery(k), v]),
  )
  return {
    calls,
    status: () => Promise.resolve({ configured: true, route: fixtures.route ?? 'official' }),
    serp: (q: SerpQuery) => {
      calls.push({ kind: 'serp', key: q.query })
      const hit = serpBy.get(normalizeQuery(q.query))
      return Promise.resolve(
        hit === undefined
          ? { query: q, items: [], fetched_at: '1970-01-01T00:00:00Z', source: 'stand-in' }
          : { ...hit, query: q },
      )
    },
    aiAnswers: (p: AiAnswerProbe) => {
      calls.push({ kind: 'ai', key: p.question })
      const hit = aiBy.get(normalizeQuery(p.question)) ?? []
      return Promise.resolve(
        hit.filter((r) => p.platforms.includes(r.platform)).map((r) => ({ ...r })),
      )
    },
  }
}
