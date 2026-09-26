/**
 * WP155（docs/81）：本机这一侧的**搜索数据接口**——`SearchDataPort` 的实现。
 *
 * 一个品牌一份（设置与自带 key 都按品牌放），三档路由（照 WP126 / docs/75 §1）：
 *
 * | 档 | 谁付钱 | 怎么走 |
 * |---|---|---|
 * | `official` | 用户付积分 | 打云端 `/v1/data/search/*`（令牌是这个品牌那一把），服务商 key 在云上 |
 * | `byo` | 用户对自己选的服务商付 | 本机直连，key 从本机加密库取，不扣积分 |
 * | `none` | —— | 一句人话（`status().configured === false`，WP154 据此跳过） |
 *
 * 用户在连接页选档：官方（用积分）/ 自带 key / 不接。**没选过（`auto`）**就按派工单的顺序：
 * 关联了云账号 → 官方；没关联但填过自带 key → 自带；都没有 → none。
 *
 * **配了但报错不静默换档**（docs/75 §1 的规矩）：自带 key 失败不会偷偷去花积分，
 * 官方失败也不会偷偷用你的 key——错误照实抛出去（`SearchDataError`，带契约码表）。
 *
 * key 纪律：自带 key 只进本机加密库（`search.byo.key`），文件里只有服务商与引用；
 * 读出来直接交给适配器拼请求，不进日志、不进响应、不进错误信息。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ApiError, type SearchDataApiPort } from '@agentsws/api'
import {
  judgeAnswer,
  normalizeProbe,
  normalizeSerpQuery,
  SearchDataError,
  type SearchFetch,
  searchProviderOf,
} from '@agentsws/cloud-entry'
import type {
  AiAnswerProbe,
  AiAnswerResult,
  Iso8601,
  SearchDataPort,
  SearchDataProvider,
  SearchDataRouteChoice,
  SearchDataSettingsView,
  SearchDataStatus,
  SerpQuery,
  SerpResult,
} from '@agentsws/contracts'
import { SEARCH_DATA_PROVIDERS, searchSourceByo } from '@agentsws/contracts'
import type { SecretStore } from './secret-store.js'

/** 自带 key 在本机加密库里的名字。**全仓只有这一处拼它。** */
export const SEARCH_BYO_SECRET_ID = 'search.byo.key'

/** 设置文件（这个品牌目录下）。只有档位、服务商与时间——没有 key。 */
export const SEARCH_DATA_FILE = 'search-data.json'

interface SettingsFile {
  version: 1
  choice: SearchDataRouteChoice
  byo?: { provider: SearchDataProvider; updated_at: Iso8601 }
}

export interface SearchDataStore {
  read(): SettingsFile
  setChoice(choice: SearchDataRouteChoice): void
  setByo(input: { provider: SearchDataProvider; api_key?: string }): void
  clearByo(): boolean
  /** 取 key（只给适配器那一行用）。 */
  key(): string | undefined
  hasKey(): boolean
}

export function createSearchDataStore(options: {
  secrets: SecretStore
  dir?: string
  now: () => Iso8601
}): SearchDataStore {
  const file = options.dir === undefined ? undefined : join(options.dir, SEARCH_DATA_FILE)
  let state: SettingsFile = { version: 1, choice: 'auto' }
  if (file !== undefined) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<SettingsFile>
      const choice = parsed.choice
      state = {
        version: 1,
        choice: choice === 'official' || choice === 'byo' || choice === 'none' ? choice : 'auto',
        ...(parsed.byo !== undefined &&
        (SEARCH_DATA_PROVIDERS as readonly string[]).includes(parsed.byo.provider)
          ? { byo: parsed.byo }
          : {}),
      }
    } catch {
      // 第一次跑或文件坏了：从「没选过」开始
    }
  }
  const flush = (): void => {
    if (file === undefined) return
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  }
  const key = (): string | undefined => {
    if (!options.secrets.available) return undefined
    try {
      const v = options.secrets.get(SEARCH_BYO_SECRET_ID)?.key
      return v === undefined || v === '' ? undefined : v
    } catch {
      return undefined
    }
  }
  return {
    read: () => state,
    setChoice(choice) {
      state = { ...state, choice }
      flush()
    },
    setByo(input) {
      const k = input.api_key?.trim()
      if (k !== undefined && k !== '') {
        if (!options.secrets.available)
          throw new SearchDataError(
            'invalid_input',
            '这台电脑的本机加密库没开，key 存不了。先在设置里把加密库打开。',
          )
        options.secrets.put(SEARCH_BYO_SECRET_ID, { key: k })
      }
      state = { ...state, byo: { provider: input.provider, updated_at: options.now() } }
      flush()
    },
    clearByo() {
      const had = state.byo !== undefined || key() !== undefined
      options.secrets.remove(SEARCH_BYO_SECRET_ID)
      const { byo: _drop, ...rest } = state
      state = { ...rest, ...(rest.choice === 'byo' ? { choice: 'auto' as const } : {}) }
      flush()
      return had
    },
    key,
    hasKey: () => key() !== undefined,
  }
}

/* ── 官方那一档：打云端 `/v1/data/search/*` ─────────────────────────── */

/** 打云侧最多等多久（AI 问答要问好几个平台，比红人库那条长）。 */
export const SEARCH_CLOUD_TIMEOUT_MS = 120_000

export const OFFICIAL_NOT_LINKED =
  '还没关联 Agents 工坊账号，所以用不了工坊官方数据接口。去「设置 → 账号与积分」关联一次，或者在连接页接你自己的搜索数据 key（不扣积分）。'

export const OFFICIAL_NO_DATA_SCOPE =
  '关联账号的时候没给「数据服务」这一项权限，所以工坊官方数据接口现在用不了。去「设置 → 账号与积分」重新关联一次就好。'

export interface OfficialSearchClient {
  /** 关联了云账号没有（有没有这个品牌那把令牌）。 */
  linked(): boolean
  status(): Promise<SearchDataStatus>
  serp(q: SerpQuery): Promise<SerpResult>
  aiAnswers(p: AiAnswerProbe): Promise<{ results: AiAnswerResult[] }>
}

/** 云侧的状态码 / 错误码 → 契约码表。 */
function officialFailure(
  status: number,
  body: { code?: string; message?: string; details?: unknown },
): SearchDataError {
  const details = (body.details ?? {}) as { reason?: string; required_scope?: string }
  const said = body.message ?? `工坊官方数据接口没答上来（HTTP ${status}）。`
  if (status === 402 || body.code === 'insufficient_credits')
    return new SearchDataError('insufficient_credits', said)
  if (status === 401) return new SearchDataError('not_configured', OFFICIAL_NOT_LINKED)
  if (status === 403 && details.required_scope !== undefined)
    return new SearchDataError('not_configured', OFFICIAL_NO_DATA_SCOPE)
  if (status === 501 || details.reason === 'not_configured')
    return new SearchDataError('not_configured', said)
  if (status === 400)
    return new SearchDataError(
      details.reason === 'unsupported' ? 'unsupported' : 'invalid_input',
      said,
    )
  if (status === 429) return new SearchDataError('rate_limited', said)
  if (status === 504) return new SearchDataError('timeout', said)
  return new SearchDataError('provider_error', said)
}

export function createOfficialSearchClient(options: {
  secrets: SecretStore
  /** 云的根地址（`cloudBaseUrl(env)`）。 */
  baseUrl: string
  tokenSecretId: string
  fetch?: SearchFetch
}): OfficialSearchClient {
  const doFetch: SearchFetch = options.fetch ?? ((u, i) => globalThis.fetch(u, i))
  const tokenOf = (): string | undefined => {
    if (!options.secrets.available) return undefined
    try {
      const t = options.secrets.get(options.tokenSecretId)?.token
      return t === undefined || t === '' ? undefined : t
    } catch {
      return undefined
    }
  }
  async function call<T>(method: 'GET' | 'POST', path: string, payload?: unknown): Promise<T> {
    const token = tokenOf()
    if (token === undefined) throw new SearchDataError('not_configured', OFFICIAL_NOT_LINKED)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), SEARCH_CLOUD_TIMEOUT_MS)
    let res: Awaited<ReturnType<SearchFetch>>
    try {
      // 令牌只在这一行进头
      res = await doFetch(`${options.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        signal: controller.signal,
      })
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError'
      throw new SearchDataError(
        aborted ? 'timeout' : 'provider_error',
        aborted
          ? '工坊官方数据接口等太久没回来，这次先停了（没有扣积分）。'
          : '连不上 Agents 工坊云端（网络不通）。',
      )
    } finally {
      clearTimeout(timer)
    }
    const text = await res.text()
    let body: unknown = {}
    try {
      body = text.trim() === '' ? {} : JSON.parse(text)
    } catch {
      throw new SearchDataError(
        'provider_error',
        `工坊官方数据接口回的不是 JSON（HTTP ${res.status}）。`,
      )
    }
    if (!res.ok) throw officialFailure(res.status, body as { code?: string; message?: string })
    return body as T
  }
  return {
    linked: () => tokenOf() !== undefined,
    async status() {
      if (tokenOf() === undefined)
        return { configured: false, route: 'none', reason: OFFICIAL_NOT_LINKED }
      try {
        return await call<SearchDataStatus>('GET', '/v1/data/search/status')
      } catch (err) {
        return {
          configured: false,
          route: 'none',
          reason: err instanceof Error ? err.message : '工坊官方数据接口这会儿问不到。',
        }
      }
    },
    serp: (q) => call<SerpResult>('POST', '/v1/data/search/serp', q),
    aiAnswers: (p) => call<{ results: AiAnswerResult[] }>('POST', '/v1/data/search/ai-answers', p),
  }
}

/* ── 三档合一：`SearchDataPort` + 连接页那一行 ───────────────────────── */

export interface SearchDataService extends SearchDataPort {
  settings(): Promise<SearchDataSettingsView>
  setChoice(choice: SearchDataRouteChoice): Promise<SearchDataSettingsView>
  setByo(input: { provider: SearchDataProvider; api_key?: string }): Promise<SearchDataSettingsView>
  clearByo(): Promise<{ cleared: boolean }>
  /** 「测试连接」：用填的（或已存的）key 打一次服务商最便宜的那个口。 */
  testByo(input: {
    provider?: SearchDataProvider
    api_key?: string
  }): Promise<{ ok: boolean; message: string }>
}

const NONE_REASON =
  '搜索数据接口还没接：关联 Agents 工坊账号就能用官方数据接口（用积分），或者在连接页接你自己的搜索数据 key。'
const CHOSE_NONE = '你在连接页选了「不接」搜索数据。'

export function createSearchDataService(options: {
  store: SearchDataStore
  official: OfficialSearchClient
  now: () => Iso8601
  /** 自带 key 那一档直连服务商用的 fetch（测试注入替身）。 */
  fetch?: SearchFetch
}): SearchDataService {
  const { store, official } = options
  const doFetch: SearchFetch = options.fetch ?? ((u, i) => globalThis.fetch(u, i))

  /** 这一刻走哪一档。 */
  const route = (): 'official' | 'byo' | 'none' => {
    const { choice, byo } = store.read()
    const byoReady = byo !== undefined && store.hasKey()
    if (choice === 'none') return 'none'
    if (choice === 'official') return 'official'
    if (choice === 'byo') return byoReady ? 'byo' : 'none'
    // auto：派工单的顺序——官方 → 自带 → 都没有
    if (official.linked()) return 'official'
    return byoReady ? 'byo' : 'none'
  }

  const byoAdapter = () => {
    const byo = store.read().byo
    const adapter = byo === undefined ? undefined : searchProviderOf(byo.provider)
    const key = store.key()
    if (byo === undefined || adapter === undefined || key === undefined)
      throw new SearchDataError(
        'not_configured',
        '自带的搜索数据 key 还没填好。去连接页「搜索数据」那一行填一下。',
      )
    return { provider: byo.provider, adapter, key }
  }

  const status = async (): Promise<SearchDataStatus> => {
    const r = route()
    if (r === 'official') return official.status()
    if (r === 'byo') {
      const { provider, adapter } = byoAdapter()
      return {
        configured: true,
        route: 'byo',
        provider,
        engines: [...adapter.engines],
        platforms: [...adapter.platforms],
      }
    }
    const choice = store.read().choice
    return {
      configured: false,
      route: 'none',
      reason:
        choice === 'none'
          ? CHOSE_NONE
          : choice === 'byo'
            ? '你选了自带 key，但 key 还没填好。去连接页「搜索数据」那一行填一下。'
            : NONE_REASON,
    }
  }

  const notConfigured = async (): Promise<never> => {
    const s = await status()
    throw new SearchDataError('not_configured', s.reason ?? NONE_REASON)
  }

  const view = async (): Promise<SearchDataSettingsView> => {
    const { choice, byo } = store.read()
    return {
      choice,
      ...(byo === undefined ? {} : { byo: { ...byo, has_key: store.hasKey() } }),
      status: await status(),
    }
  }

  return {
    status,
    async serp(input) {
      const q = normalizeSerpQuery(input)
      const r = route()
      if (r === 'official') return official.serp(q)
      if (r === 'none') return notConfigured()
      const { provider, adapter, key } = byoAdapter()
      if (!adapter.engines.includes(q.engine))
        throw new SearchDataError('unsupported', `你选的服务商查不了 ${q.engine}。`)
      const got = await adapter.serp(q, key, doFetch)
      return {
        query: q,
        ...got,
        fetched_at: options.now(),
        source: searchSourceByo(provider),
        credits: 0,
      }
    },
    async aiAnswers(input) {
      const probe = normalizeProbe(input)
      const r = route()
      if (r === 'official') return (await official.aiAnswers(probe)).results
      if (r === 'none') return notConfigured()
      const { provider, adapter, key } = byoAdapter()
      const asked = probe.platforms.filter((p) => adapter.platforms.includes(p))
      if (asked.length === 0)
        throw new SearchDataError('unsupported', '你选的服务商探测不了这几个 AI 平台。')
      const rows = await Promise.all(
        asked.map(async (platform) => {
          try {
            const answer = await adapter.aiAnswer(
              {
                question: probe.question,
                country: probe.country,
                language: probe.language,
                platform,
              },
              key,
              doFetch,
            )
            return answer.text.trim() === ''
              ? undefined
              : judgeAnswer(probe, platform, answer, {
                  fetched_at: options.now(),
                  source: searchSourceByo(provider),
                })
          } catch (err) {
            return err instanceof SearchDataError
              ? err
              : new SearchDataError('provider_error', '这次没查成。')
          }
        }),
      )
      const results = rows.filter(
        (x): x is AiAnswerResult => x !== undefined && !(x instanceof SearchDataError),
      )
      if (results.length === 0) {
        const first = rows.find((x): x is SearchDataError => x instanceof SearchDataError)
        throw first ?? new SearchDataError('provider_error', '这几个平台这次都没拿到回答。')
      }
      return results.map((x) => ({ ...x, credits: 0 }))
    },
    settings: view,
    async setChoice(choice) {
      store.setChoice(choice)
      return view()
    },
    async setByo(input) {
      if (!(SEARCH_DATA_PROVIDERS as readonly string[]).includes(input.provider))
        throw new SearchDataError(
          'invalid_input',
          `服务商只认 ${SEARCH_DATA_PROVIDERS.join(' / ')}。`,
        )
      store.setByo(input)
      // 填了自带 key 就是想用它：档位跟着拨到「自带」（用户随时可以再拨回来）
      if (store.hasKey()) store.setChoice('byo')
      return view()
    },
    async clearByo() {
      return { cleared: store.clearByo() }
    },
    async testByo(input) {
      const provider = input.provider ?? store.read().byo?.provider
      const adapter = provider === undefined ? undefined : searchProviderOf(provider)
      const key = input.api_key?.trim() || store.key()
      if (adapter === undefined) return { ok: false, message: '先选一家服务商。' }
      if (key === undefined || key === '') return { ok: false, message: '先填 key。' }
      try {
        await adapter.test(key, doFetch)
        return { ok: true, message: '通了。这把 key 能用。' }
      } catch (err) {
        return {
          ok: false,
          message: err instanceof SearchDataError ? err.message : '没通。',
        }
      }
    },
  }
}

/* ── HTTP 投影：按品牌取服务 + 错误翻成网关码 ───────────────────────── */

/** 契约码表 → 网关错误（`details.reason` 带原码，界面据此给入口：充值 / 去连接页）。 */
export function searchDataApiError(err: unknown): unknown {
  if (!(err instanceof SearchDataError)) return err
  const details = { reason: err.code }
  switch (err.code) {
    case 'invalid_input':
    case 'unsupported':
      return new ApiError('invalid_input', err.message, { details })
    case 'not_configured':
      return new ApiError('provider_unavailable', err.message, { details })
    case 'insufficient_credits':
      // 402：钱不够（与云端入口同一个状态码）
      return new ApiError('provider_unavailable', err.message, { details, status: 402 })
    case 'rate_limited':
      return new ApiError('rate_limited', err.message, { details })
    case 'timeout':
      return new ApiError('timeout', err.message, { details })
    default:
      return new ApiError('provider_error', err.message, { details })
  }
}

/** `GatewayDeps.searchData`：每个调用按 actor 的工作区取那个品牌的服务。 */
export function searchDataApiPort(
  of: (workspace_id: string) => Promise<SearchDataService>,
): SearchDataApiPort {
  const run = async <T>(ws: string, fn: (s: SearchDataService) => Promise<T>): Promise<T> => {
    try {
      return await fn(await of(ws))
    } catch (err) {
      throw searchDataApiError(err)
    }
  }
  return {
    settings: (a) => run(a.workspace_id, (s) => s.settings()),
    setChoice: (a, choice) => run(a.workspace_id, (s) => s.setChoice(choice)),
    setByo: (a, input) => run(a.workspace_id, (s) => s.setByo(input)),
    clearByo: (a) => run(a.workspace_id, (s) => s.clearByo()),
    testByo: (a, input) => run(a.workspace_id, (s) => s.testByo(input)),
    serp: (a, q) => run(a.workspace_id, (s) => s.serp(q)),
    aiAnswers: (a, p) => run(a.workspace_id, async (s) => ({ results: await s.aiAnswers(p) })),
  }
}
