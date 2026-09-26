/**
 * WP155：`/v1/data/search/*`——Agents 工坊官方数据接口的搜索数据那一块（docs/81 §4）。
 *
 * 三条路（令牌要 `data` 这一项，与公共红人库同一个动作集）：
 *
 * | 路 | 收费 |
 * |---|---|
 * | `GET  /v1/data/search/status` | 不收（只说开没开通、单价多少） |
 * | `POST /v1/data/search/serp` | `data.search.serp` × 1 |
 * | `POST /v1/data/search/ai-answers` | `data.search.ai_answer` × 平台数（**每个平台一次**） |
 *
 * 钱的四条规矩（与 docs/75 §2 红人数据同一套）：
 *
 * 1. 先预扣，再取数；**命中缓存与未命中收同样的钱**（命中时我方成本记 0）；
 * 2. **失败 / 超时 → 预扣整笔释放**，一分不扣；AI 问答某几个平台失败，只收成功的那几个；
 * 3. **搜到 0 条（也没有 AI 概览）不收钱**——收钱换来一个空结果说不过去；
 * 4. 我方成本按成本表记（`cost-table.json` 的 `unit_prices`），后台毛利从这里算。
 *
 * 对外叫法：错误信息里**不出现服务商名**（适配器自己的那句话带着服务商名，这里一律换成
 * 「工坊官方数据接口」的说法）；`source` 固定写 `official`。
 */
import type { AiAnswerResult, AiPlatform, SearchDataStatus, SerpResult } from '@agentsws/contracts'
import {
  SEARCH_AI_ANSWER_CAPABILITY,
  SEARCH_DATA_CLOUD_PATHS,
  SEARCH_SERP_CAPABILITY,
  SEARCH_SOURCE_OFFICIAL,
} from '@agentsws/contracts'
import type { CostTable, WalletReservation } from '@agentsws/metering'
import {
  COST_TABLE,
  creditsFor,
  roundCredits,
  unitCostMicros,
  WalletError,
} from '@agentsws/metering'
import type { Context } from 'hono'
import type { EntryDeps, EntryEnv, EntryRoute } from '../types.js'
import { EntryError, secretOf } from '../types.js'
import { judgeAnswer, normalizeProbe, normalizeSerpQuery, SearchDataError } from './analyze.js'
import { MemorySearchCache, SEARCH_CACHE_TTL_MS, type SearchCache } from './cache.js'
import type {
  ProviderAnswer,
  ProviderSerp,
  SearchFetch,
  SearchProviderAdapter,
} from './provider.js'
import { searchProviderOf } from './providers/index.js'

/** 官方那一侧的一句话（不带服务商名）。 */
const OFFICIAL = '工坊官方数据接口'

/** 适配器的错 → 入口的错。**服务商原话不带出去**（里面有服务商名）。 */
export function officialError(err: unknown): EntryError {
  if (err instanceof EntryError) return err
  const code = err instanceof SearchDataError ? err.code : 'provider_error'
  const details = { reason: code }
  switch (code) {
    case 'invalid_input':
    case 'unsupported':
      return new EntryError('invalid_input', (err as Error).message, { details })
    case 'timeout':
      return new EntryError(
        'provider_error',
        `${OFFICIAL}这次等太久没回来，这一次没有扣积分，稍后再试。`,
        {
          status: 504,
          details,
        },
      )
    case 'rate_limited':
      return new EntryError(
        'provider_error',
        `${OFFICIAL}现在有点忙，这一次没有扣积分，过一会儿再试。`,
        {
          status: 429,
          details,
        },
      )
    default:
      return new EntryError(
        'provider_error',
        `${OFFICIAL}这次没查成，这一次没有扣积分，稍后再试。`,
        {
          details,
        },
      )
  }
}

function reserveOrThrow(fn: () => WalletReservation): WalletReservation {
  try {
    return fn()
  } catch (err) {
    if (err instanceof WalletError)
      throw new EntryError(
        err.code === 'insufficient_credits' ? 'insufficient_credits' : 'invalid_input',
        err.message,
        { details: err.details },
      )
    throw err
  }
}

interface Ready {
  adapter: SearchProviderAdapter
  key: string
}

/** 开没开通：有服务商、有 key、认得这家。 */
function readiness(deps: EntryDeps): Ready | undefined {
  const up = deps.upstream.search
  if (up === undefined) return undefined
  const key = secretOf(up.api_key)
  const adapter = searchProviderOf(up.provider)
  return key === undefined || adapter === undefined ? undefined : { adapter, key }
}

function notConfigured(): EntryError {
  return new EntryError(
    'not_implemented',
    `${OFFICIAL}的搜索数据还没开通。可以先在连接页接你自己的搜索数据 key（不扣积分）。`,
    { details: { reason: 'not_configured' } },
  )
}

function priceOf(deps: EntryDeps, capability: string): number {
  const p = creditsFor(deps.pricing, capability, 1)
  if (p === undefined)
    throw new EntryError('internal', `价目表里没有 ${capability}，这个节点还不能查搜索数据。`)
  return p
}

async function readBody(c: Context<EntryEnv>): Promise<unknown> {
  try {
    return await c.req.json()
  } catch {
    throw new EntryError('invalid_input', '请求体不是合法 JSON')
  }
}

function fetchOf(deps: EntryDeps): SearchFetch {
  return (deps.fetch as SearchFetch | undefined) ?? ((u, i) => globalThis.fetch(u, i))
}

/** 缓存键：服务商 + 归一过的查询（同一家同一个问法才算同一次）。 */
export function serpCacheKey(provider: string, q: SerpResult['query']): string {
  return `serp|${provider}|${q.engine}|${q.country}|${q.language}|${q.device ?? 'desktop'}|${q.query.toLowerCase()}`
}
export function answerCacheKey(
  provider: string,
  platform: AiPlatform,
  p: { question: string; country: string; language: string },
): string {
  return `ai|${provider}|${platform}|${p.country}|${p.language}|${p.question.toLowerCase()}`
}

/** 每个 `EntryDeps` 一份默认缓存（Compose 一个进程一份；Workers 一个组织对象一份）。 */
const DEFAULT_CACHES = new WeakMap<EntryDeps, SearchCache>()
function cacheOf(deps: EntryDeps): SearchCache {
  if (deps.searchCache !== undefined) return deps.searchCache
  let found = DEFAULT_CACHES.get(deps)
  if (found === undefined) {
    found = new MemorySearchCache()
    DEFAULT_CACHES.set(deps, found)
  }
  return found
}

function nowOf(deps: EntryDeps): string {
  return deps.now?.() ?? new Date().toISOString()
}

function costFields(
  deps: EntryDeps,
  key: string,
  quantity: number,
): { cost_micros?: number; cost_currency?: string; provider?: string } {
  const table: CostTable | null = deps.costTable === undefined ? COST_TABLE : deps.costTable
  if (table === null) return {}
  const est = unitCostMicros(key, quantity, table)
  // 成本表里没这一条就不写 cost_micros——「不知道」不是 0（与生图同一条）
  return est.fallback
    ? { provider: est.provider }
    : { cost_micros: est.micros, cost_currency: est.currency, provider: est.provider }
}

/** `GET /v1/data/search/status`（不收钱）。 */
export function officialStatus(deps: EntryDeps): SearchDataStatus {
  const ready = readiness(deps)
  if (ready === undefined)
    return {
      configured: false,
      route: 'none',
      reason: `${OFFICIAL}的搜索数据还没开通。`,
    }
  const serp = creditsFor(deps.pricing, SEARCH_SERP_CAPABILITY, 1)
  const ai = creditsFor(deps.pricing, SEARCH_AI_ANSWER_CAPABILITY, 1)
  return {
    configured: true,
    route: 'official',
    engines: [...ready.adapter.engines],
    platforms: [...ready.adapter.platforms],
    ...(serp === undefined || ai === undefined ? {} : { prices: { serp, ai_answer: ai } }),
  }
}

/** `POST /v1/data/search/serp`。 */
async function officialSerp(c: Context<EntryEnv>, deps: EntryDeps): Promise<Response> {
  const principal = c.get('principal')
  let q: SerpResult['query']
  try {
    q = normalizeSerpQuery(await readBody(c))
  } catch (err) {
    throw officialError(err)
  }
  const ready = readiness(deps)
  if (ready === undefined) throw notConfigured()
  if (!ready.adapter.engines.includes(q.engine))
    throw new EntryError('invalid_input', `${OFFICIAL}现在查不了 ${q.engine}。`, {
      details: { reason: 'unsupported' },
    })
  const price = priceOf(deps, SEARCH_SERP_CAPABILITY)
  const exempt = deps.isExemptAccount?.(principal.account_id) === true
  const reservation = reserveOrThrow(() =>
    deps.wallet.reserve({
      org_id: principal.org_id,
      workspace_id: principal.workspace_id,
      capability: SEARCH_SERP_CAPABILITY,
      unit: 'call',
      quantity: 1,
      credits: exempt ? 0 : price,
      request_id: c.get('request_id'),
    }),
  )

  const cache = cacheOf(deps)
  const key = serpCacheKey(ready.adapter.id, q)
  const nowMs = Date.parse(nowOf(deps))
  const hit = cache.get(key, nowMs) as { serp: ProviderSerp; fetched_at: string } | undefined
  let got: { serp: ProviderSerp; fetched_at: string }
  if (hit !== undefined) {
    got = hit
  } else {
    try {
      got = { serp: await ready.adapter.serp(q, ready.key, fetchOf(deps)), fetched_at: nowOf(deps) }
    } catch (err) {
      deps.wallet.release(reservation)
      throw officialError(err)
    }
  }
  const empty = got.serp.items.length === 0 && got.serp.ai_overview === undefined
  if (empty) deps.wallet.release(reservation)
  else
    deps.wallet.settle(reservation, {
      quantity: 1,
      credits: exempt ? 0 : price,
      account_id: principal.account_id,
      charge_status: exempt ? 'admin_exempt' : 'charged',
      // 命中缓存：收入照旧、我方成本 0（docs/75 §2 第 4 条）
      ...(hit !== undefined
        ? { cost_micros: 0, provider: ready.adapter.id }
        : costFields(deps, ready.adapter.costKey('serp'), 1)),
    })
  if (hit === undefined && !empty) cache.put(key, got, nowMs, SEARCH_CACHE_TTL_MS)
  const out: SerpResult = {
    query: q,
    ...got.serp,
    fetched_at: got.fetched_at,
    source: SEARCH_SOURCE_OFFICIAL,
    credits: empty || exempt ? 0 : price,
    cached: hit !== undefined,
  }
  return c.json(out)
}

/** 某个平台这次没查成 / 查不了（不收钱）。 */
export interface SkippedPlatform {
  platform: AiPlatform
  code: string
  message: string
}

/** `POST /v1/data/search/ai-answers` 的回包。 */
export interface OfficialAiAnswers {
  results: AiAnswerResult[]
  skipped: SkippedPlatform[]
  credits: number
}

/** `POST /v1/data/search/ai-answers`：每个平台一次，只收成功的那几个。 */
async function officialAiAnswers(c: Context<EntryEnv>, deps: EntryDeps): Promise<Response> {
  const principal = c.get('principal')
  let probe: ReturnType<typeof normalizeProbe>
  try {
    probe = normalizeProbe(await readBody(c))
  } catch (err) {
    throw officialError(err)
  }
  const ready = readiness(deps)
  if (ready === undefined) throw notConfigured()
  const skipped: SkippedPlatform[] = []
  const asked = probe.platforms.filter((p) => {
    if (ready.adapter.platforms.includes(p)) return true
    skipped.push({
      platform: p,
      code: 'unsupported',
      message: `${OFFICIAL}现在探测不了这个平台，没收钱。`,
    })
    return false
  })
  if (asked.length === 0)
    throw new EntryError('invalid_input', `${OFFICIAL}现在探测不了你选的这几个平台。`, {
      details: { reason: 'unsupported', skipped },
    })
  const price = priceOf(deps, SEARCH_AI_ANSWER_CAPABILITY)
  const exempt = deps.isExemptAccount?.(principal.account_id) === true
  const reservation = reserveOrThrow(() =>
    deps.wallet.reserve({
      org_id: principal.org_id,
      workspace_id: principal.workspace_id,
      capability: SEARCH_AI_ANSWER_CAPABILITY,
      unit: 'call',
      quantity: asked.length,
      credits: exempt ? 0 : roundCredits(price * asked.length),
      request_id: c.get('request_id'),
    }),
  )

  const cache = cacheOf(deps)
  const nowMs = Date.parse(nowOf(deps))
  const doFetch = fetchOf(deps)
  const settled = await Promise.all(
    asked.map(async (platform) => {
      const key = answerCacheKey(ready.adapter.id, platform, probe)
      const hit = cache.get(key, nowMs) as
        | { answer: ProviderAnswer; fetched_at: string }
        | undefined
      if (hit !== undefined) return { platform, got: hit, cached: true as const }
      try {
        const answer = await ready.adapter.aiAnswer(
          { question: probe.question, country: probe.country, language: probe.language, platform },
          ready.key,
          doFetch,
        )
        const got = { answer, fetched_at: nowOf(deps) }
        if (answer.text.trim() !== '') cache.put(key, got, nowMs, SEARCH_CACHE_TTL_MS)
        return { platform, got, cached: false as const }
      } catch (err) {
        return { platform, error: officialError(err) }
      }
    }),
  )

  const results: AiAnswerResult[] = []
  const fresh: AiPlatform[] = []
  for (const row of settled) {
    if ('error' in row) {
      skipped.push({ platform: row.platform, code: 'provider_error', message: row.error.message })
      continue
    }
    // 空回答算没查成（收钱换来一个空结果说不过去）
    if (row.got.answer.text.trim() === '') {
      skipped.push({
        platform: row.platform,
        code: 'provider_error',
        message: `${OFFICIAL}这次没拿到这个平台的回答，没收钱。`,
      })
      continue
    }
    if (!row.cached) fresh.push(row.platform)
    results.push({
      ...judgeAnswer(probe, row.platform, row.got.answer, {
        fetched_at: row.got.fetched_at,
        source: SEARCH_SOURCE_OFFICIAL,
      }),
      credits: exempt ? 0 : price,
      cached: row.cached,
    })
  }

  if (results.length === 0) {
    deps.wallet.release(reservation)
    const first = settled.find((r) => 'error' in r)
    throw first !== undefined && 'error' in first
      ? first.error
      : new EntryError('provider_error', `${OFFICIAL}这次没拿到回答，这一次没有扣积分。`)
  }
  const credits = exempt ? 0 : roundCredits(price * results.length)
  // 成本只算真打了上游的那几个平台（命中缓存的记 0）
  const cost = { micros: 0, currency: undefined as string | undefined, unknown: false }
  for (const p of fresh) {
    const f = costFields(deps, ready.adapter.costKey(p), 1)
    if (f.cost_micros === undefined) cost.unknown = true
    else {
      cost.micros += f.cost_micros
      cost.currency = f.cost_currency ?? cost.currency
    }
  }
  deps.wallet.settle(reservation, {
    quantity: results.length,
    credits,
    account_id: principal.account_id,
    charge_status: exempt ? 'admin_exempt' : 'charged',
    provider: ready.adapter.id,
    ...(cost.unknown
      ? {}
      : {
          cost_micros: cost.micros,
          ...(cost.currency === undefined ? {} : { cost_currency: cost.currency }),
        }),
  })
  const body: OfficialAiAnswers = { results, skipped, credits }
  return c.json(body)
}

/** 三条路（挂进 `entryRoutes`）。 */
export function searchRoutes(deps: EntryDeps): EntryRoute[] {
  return [
    {
      method: 'get',
      path: SEARCH_DATA_CLOUD_PATHS.status,
      auth: 'bearer',
      scope: 'data',
      summary: '搜索数据开没开通、能查哪些引擎 / 平台、单价多少（不收钱）',
      handler: async (c) => c.json(officialStatus(deps)),
    },
    {
      method: 'post',
      path: SEARCH_DATA_CLOUD_PATHS.serp,
      auth: 'bearer',
      scope: 'data',
      summary: '查一次搜索结果页（按国家 / 语言 / 设备）；按次扣积分，命中缓存同价，失败不扣',
      handler: (c) => officialSerp(c, deps),
    },
    {
      method: 'post',
      path: SEARCH_DATA_CLOUD_PATHS.aiAnswers,
      auth: 'bearer',
      scope: 'data',
      summary: '问几个 AI 平台同一个问题，看有没有提到你、引用了谁；每个平台一次，只收成功的',
      handler: (c) => officialAiAnswers(c, deps),
    },
  ]
}
