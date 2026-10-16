/**
 * WP355（Luoye 10-16，决策 937）：**指定的模型来源用它自带的联网搜索**——第一版名单（在
 * `apps/server` 的 web-browser 那一层）只有 ChatGPT 订阅登录（`openai-codex`）。这个文件是
 * 「ChatGPT 自带搜索」那一路的**执行**：怎么问、怎么解析；名单、缓存、节流、审计、退回 WP353 的链都在宿主那一层。
 *
 * 一行 OAuth / 请求头 / 端点都不是我们写的：
 *
 * - 请求走官方 `pi-ai` 的 `openai-codex` provider（与订阅运行同一个、同一版 1.1.0）。令牌由 pi-ai 自己从
 *   本机加密库那条 `llm-pi-ai/openai-codex` 记录里取、到期前自己刷新并经 `modifyRecord` 回写——
 *   **我们的代码不读、不打印、不转存任何令牌**（{@link piCredentialStore} 只是把记录原样递给它）；
 * - 只用 pi-ai 公开的两个口：`onPayload`（往请求体里加 Responses 的 `{type: 'web_search'}` 服务端工具，
 *   Codex CLI 自己用的就是这个）与 `onProviderStreamEvent`（只读地收 `response.output_item.done` 那几块）；
 * - 收来的块拼成 `{ output: [...] }`，交给社区插件 `dsh-web-search-diy`（MIT，aaronlei）导出的
 *   `mapResponsesResponse` 解析：来源只认 `web_search_call` 块与 `url_citation` 标注，
 *   **模型正文里自己写的网址一概不收**（与官方 DeepSeek 搜索提供方同一条规矩）。
 *
 * 摘要（snippet）：OpenAI 的 `web_search_call` 块不带摘要，我们请模型每条一行「一句话 + 引用」，
 * 摘要取那条引用所在的那一行（{@link snippetsFromOutput}）。
 *
 * 搜索语言（决策 922）照旧由宿主按品牌主市场定，这里只把「用什么语言、哪个市场」写进那一问。
 */
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { SUBSCRIPTION_RECORD_SCOPE } from './subscription-facts.js'

/** 一条来源（与 `ctx.web` 的 `WebSearchResult.sources` 同形）。 */
export interface NativeSearchSource {
  url: string
  title?: string
  snippet?: string
}

export interface NativeSearchRequest {
  query: string
  /** 最多要几条（缺省 10）。 */
  maxResults?: number
  /** 用订阅目录里哪个模型问（缺省 {@link CODEX_SEARCH_DEFAULT_MODEL}；目录里没有也退回它）。 */
  model?: string
  /** 搜索语言（决策 922）：`language` 如 `en` / `de` / `zh-CN`，`market` 如 `US`；宿主按品牌主市场给。 */
  locale?: { language: string; market?: string }
  signal?: AbortSignal
  /**
   * 请求体里 `web_search` 工具的写法（实测前留口，默认按 Codex CLI 的写法）：
   * - `externalWebAccess`：`true` = 实时联网（缺省）；`false` = 只用缓存索引；`null` = 不写这个字段；
   * - `userLocation`：把市场写成 `user_location`（缺省不写——Codex 后端认不认未实测）；
   * - `includeSources`：要 `web_search_call.action.sources`（缺省不要——Codex 后端认不认未实测）。
   */
  tool?: { externalWebAccess?: boolean | null; userLocation?: boolean; includeSources?: boolean }
}

export interface NativeSearchResult {
  sources: NativeSearchSource[]
  /** 实际用的模型。 */
  model: string
  /** 这一次的 token（订阅不按 token 收钱，宿主照 `cost_base: 0` 记）。 */
  usage?: { input_tokens: number; output_tokens: number; cached_tokens: number }
  /** 模型那一段话（不交给运行，只给本机实测脚本看）。 */
  text?: string
}

/** 订阅目录里的默认模型（与设置页 ChatGPT 订阅那张卡的默认同一个）。 */
export const CODEX_SEARCH_DEFAULT_MODEL = 'gpt-5.5'
/** 一次自带搜索最多等多久（官方工具层给搜索 60 秒，这里留出退回 WP353 链的余量）。 */
export const CODEX_NATIVE_SEARCH_TIMEOUT_MS = 40_000

const webError = (code: string, message: string): Error =>
  Object.assign(new Error(message), { code })

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** 系统那一段：只搜、只列，不凭记忆答。 */
export const CODEX_SEARCH_INSTRUCTIONS =
  "You are a web search helper. Always use the web_search tool to search the web for the user's query; " +
  'never answer from memory. After searching, list the most relevant pages you found.'

/** 用户那一问：原样先搜这一句（`site:` 之类的限定不改），再一行一条列出来。 */
export function codexSearchInput(
  query: string,
  maxResults: number,
  locale?: { language: string; market?: string },
): string {
  const where =
    locale === undefined
      ? []
      : [
          `Search language: ${locale.language}` +
            (locale.market === undefined ? '.' : `; target market: ${locale.market}.`),
        ]
  return [
    `Search query: ${query}`,
    'Search the web for exactly this query first, keeping operators such as site: unchanged.',
    ...where,
    `Then list up to ${maxResults} of the most relevant pages you actually found, one per line:`,
    '- <one sentence on what the page says about the query> <citation>',
    'No introduction and no conclusion.',
  ].join('\n')
}

/**
 * `onPayload`：往 pi-ai 组好的请求体里加 `web_search` 服务端工具（别的字段一个不动）。
 * 不认得的形状原样放过（pi-ai 哪天改了请求体，这里不瞎改）。
 */
export function withCodexWebSearch(
  payload: unknown,
  o: { market?: string; tool?: NativeSearchRequest['tool'] } = {},
): unknown {
  if (!isRecord(payload)) return undefined
  const access = o.tool?.externalWebAccess === undefined ? true : o.tool.externalWebAccess
  const tool: Record<string, unknown> = {
    type: 'web_search',
    ...(access === null ? {} : { external_web_access: access }),
    ...(o.tool?.userLocation === true && o.market !== undefined
      ? { user_location: { type: 'approximate', country: o.market } }
      : {}),
  }
  const tools = Array.isArray(payload.tools) ? payload.tools : []
  const include = Array.isArray(payload.include) ? payload.include : []
  return {
    ...payload,
    tools: [...tools, tool],
    ...(o.tool?.includeSources === true
      ? { include: [...include, 'web_search_call.action.sources'] }
      : {}),
  }
}

// ── 解析 ───────────────────────────────────────────────────────────────

/** OpenAI 给引用网址挂的 `utm_source=openai` 去掉（不然同一页会按两个网址算两条）。 */
export function cleanCitationUrl(url: string): string {
  try {
    const u = new URL(url)
    if (u.searchParams.get('utm_source') !== 'openai') return url
    u.searchParams.delete('utm_source')
    return u.href.replace(/\?$/, '').replace(/\?#/, '#')
  } catch {
    return url
  }
}

/** 一行引用前面那句话（去掉列表符号、编号、多余空白，最长 300 字）。 */
function lineBefore(text: string, start: number): string {
  const from = text.lastIndexOf('\n', Math.max(0, start - 1)) + 1
  const line = text
    .slice(from, start)
    .replace(/^\s*(?:[-*•]|\d+[.)])\s*/u, '')
    .replace(/[\s(（[【]+$/u, '')
    .replace(/\s+/gu, ' ')
    .trim()
  return line.length > 300 ? `${line.slice(0, 299)}…` : line
}

/** 每个被引用的网址 → 引用它的那一行（摘要）。只认 `url_citation` 标注，正文里的网址不算。 */
export function snippetsFromOutput(output: readonly unknown[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const block of output) {
    if (!isRecord(block) || block.type !== 'message' || !Array.isArray(block.content)) continue
    for (const part of block.content) {
      if (!isRecord(part) || part.type !== 'output_text' || typeof part.text !== 'string') continue
      for (const a of Array.isArray(part.annotations) ? part.annotations : []) {
        if (!isRecord(a) || a.type !== 'url_citation' || typeof a.url !== 'string') continue
        const start = typeof a.start_index === 'number' ? a.start_index : -1
        if (start < 0) continue
        const url = cleanCitationUrl(a.url)
        const line = lineBefore(part.text, start)
        if (line !== '' && !out.has(url)) out.set(url, line)
      }
    }
  }
  return out
}

/** 把引用网址里的 `utm_source=openai` 先洗掉（交给解析之前），别的一个字段不动。 */
function cleanOutput(output: readonly unknown[]): unknown[] {
  return output.map((block) => {
    if (!isRecord(block) || block.type !== 'message' || !Array.isArray(block.content)) return block
    return {
      ...block,
      content: block.content.map((part) =>
        isRecord(part) && Array.isArray(part.annotations)
          ? {
              ...part,
              annotations: part.annotations.map((a) =>
                isRecord(a) && a.type === 'url_citation' && typeof a.url === 'string'
                  ? { ...a, url: cleanCitationUrl(a.url) }
                  : a,
              ),
            }
          : part,
      ),
    }
  })
}

/**
 * Responses 的输出块 → 来源。解析交给社区插件的 `mapResponsesResponse`（它判「到底搜没搜」：
 * 既没有 `web_search_call` 块也没有引用 = 模型没搜、凭记忆答，抛 `WEB_PROVIDER_ERROR`）；
 * 我们只补摘要、只要 http(s)、截到 `maxResults`。
 */
export async function sourcesFromCodexOutput(
  output: readonly unknown[],
  maxResults: number,
): Promise<NativeSearchSource[]> {
  const { mapResponsesResponse } = await import('dsh-web-search-diy')
  const cleaned = cleanOutput(output)
  const mapped = mapResponsesResponse({ output: cleaned })
  const snippets = snippetsFromOutput(cleaned)
  return mapped.sources
    .filter((s) => /^https?:\/\//iu.test(s.url))
    .slice(0, maxResults)
    .map((s) => {
      const snippet = s.snippet ?? snippets.get(s.url)
      return {
        url: s.url,
        ...(s.title === undefined || s.title === '' ? {} : { title: s.title }),
        ...(snippet === undefined || snippet === '' ? {} : { snippet }),
      }
    })
}

// ── 凭据：把本机加密库那条记录原样递给 pi-ai ───────────────────────────────

/** 官方 `ctx.credentials` 里我们要用的那四样（`CompositeCredentials` / 测试替身都有）。 */
export interface CredentialRecordsLike {
  readRecord(key: CredentialKey): Promise<CredentialRecord | undefined>
  modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined>
  deleteRecord(key: CredentialKey): Promise<void>
  listRecords(): Promise<readonly { key: CredentialKey; kind: string }[]>
}

/** pi-ai 的凭据形状（`@earendil-works/pi-ai` 的 `Credential`）——这里不展开，原样过手。 */
type PiCredential =
  | { type: 'api_key'; key?: string; env?: Record<string, string> }
  | {
      type: 'oauth'
      [k: string]: unknown
    }

function toPiCredential(record: CredentialRecord | undefined): PiCredential | undefined {
  if (record === undefined) return undefined
  if (record.kind === 'api-key') {
    return {
      type: 'api_key',
      ...(record.key === undefined ? {} : { key: record.key }),
      ...(record.env === undefined ? {} : { env: { ...record.env } }),
    }
  }
  return record.payload as PiCredential
}

function toRecord(credential: PiCredential): CredentialRecord {
  if (credential.type === 'api_key') {
    const c = credential as { key?: string; env?: Record<string, string> }
    return {
      kind: 'api-key',
      ...(c.key === undefined ? {} : { key: c.key }),
      ...(c.env === undefined ? {} : { env: { ...c.env } }),
    } as CredentialRecord
  }
  return { kind: 'grant', payload: JSON.parse(JSON.stringify(credential)) } as CredentialRecord
}

/**
 * pi-ai 的 `CredentialStore`，背后是官方 `ctx.credentials` 的 `llm-pi-ai/<provider>` 记录——
 * 照官方 `@deepseek-ai/dsh-llm-pi-ai`（MIT）的 `credentialStoreFrom` 写（那个没导出）：读原样、
 * 写只走 `modifyRecord`（pi-ai 在里面刷新令牌，排他由凭据层保证）。值只在 pi-ai 手里，这里不留、不打印。
 */
export function piCredentialStore(records: CredentialRecordsLike) {
  const key = (providerId: string): CredentialKey =>
    credentialKey(SUBSCRIPTION_RECORD_SCOPE, providerId)
  return {
    async read(providerId: string) {
      return toPiCredential(await records.readRecord(key(providerId)))
    },
    async list() {
      const prefix = `${SUBSCRIPTION_RECORD_SCOPE}/`
      return (await records.listRecords())
        .filter((e) => String(e.key).startsWith(prefix))
        .map((e) => ({
          providerId: String(e.key).slice(prefix.length),
          type: e.kind === 'api-key' ? ('api_key' as const) : ('oauth' as const),
        }))
    },
    async modify(
      providerId: string,
      fn: (current: PiCredential | undefined) => Promise<PiCredential | undefined>,
    ) {
      return toPiCredential(
        await records.modifyRecord(key(providerId), async (current) => {
          const next = await fn(toPiCredential(current))
          return next === undefined ? undefined : toRecord(next)
        }),
      )
    },
    async delete(providerId: string) {
      await records.deleteRecord(key(providerId))
    },
  }
}

/** pi-ai 的环境查询：**永远回「没有」**——不读进程环境变量、不探本机凭据文件（凭据纪律）。 */
const NO_AMBIENT_AUTH = {
  env: async (): Promise<undefined> => undefined,
  fileExists: async (): Promise<boolean> => false,
}

// ── 搜一次 ─────────────────────────────────────────────────────────────

export interface CodexNativeSearch {
  search(request: NativeSearchRequest): Promise<NativeSearchResult>
}

interface PiModelsLike {
  getModel(provider: string, id: string): unknown
  completeSimple(model: unknown, context: unknown, options?: unknown): Promise<unknown>
}

/**
 * 造一个「ChatGPT 自带搜索」。pi-ai 的模型集合懒建一次（`providers/all` 只在第一次搜时才 import），
 * 凭据层每次现读（登出 / 换账号下一次就生效）。
 *
 * `fetch` 只给测试用（替身）；产品里不给，pi-ai 用全局 `fetch`（桌面壳给的系统代理照样生效）。
 */
export function createCodexNativeSearch(
  records: CredentialRecordsLike,
  deps: { fetch?: typeof globalThis.fetch } = {},
): CodexNativeSearch {
  let modelsOnce: Promise<PiModelsLike> | undefined
  const models = (): Promise<PiModelsLike> => {
    modelsOnce ??= import('@earendil-works/pi-ai/providers/all').then(
      (m) =>
        m.builtinModels({
          credentials: piCredentialStore(records) as never,
          authContext: NO_AMBIENT_AUTH,
        }) as unknown as PiModelsLike,
    )
    return modelsOnce
  }
  return {
    async search(request) {
      const record = await records.readRecord(
        credentialKey(SUBSCRIPTION_RECORD_SCOPE, 'openai-codex'),
      )
      if (record === undefined)
        throw webError(
          'WEB_PROVIDER_CREDENTIAL_MISSING',
          '还没用 ChatGPT 订阅登录，用不了它自带的搜索。',
        )
      const collection = await models()
      const wanted = request.model ?? CODEX_SEARCH_DEFAULT_MODEL
      const model =
        collection.getModel('openai-codex', wanted) ??
        collection.getModel('openai-codex', CODEX_SEARCH_DEFAULT_MODEL)
      if (model === undefined)
        throw webError('WEB_PROVIDER_UNAVAILABLE', `ChatGPT 订阅的模型目录里没有 ${wanted}。`)
      const modelId = (model as { id: string }).id
      const maxResults = Math.max(1, Math.min(request.maxResults ?? 10, 20))
      const output: unknown[] = []
      let completed: unknown[] | undefined
      const signal = AbortSignal.any([
        AbortSignal.timeout(CODEX_NATIVE_SEARCH_TIMEOUT_MS),
        ...(request.signal === undefined ? [] : [request.signal]),
      ])
      const message = (await collection.completeSimple(
        model,
        {
          systemPrompt: CODEX_SEARCH_INSTRUCTIONS,
          messages: [
            {
              role: 'user',
              content: codexSearchInput(request.query, maxResults, request.locale),
              timestamp: Date.now(),
            },
          ],
        },
        {
          signal,
          // 走 SSE：同一条 `/codex/responses`，不开 WebSocket（这一次就一问一答，没有续接可省）
          transport: 'sse',
          reasoning: 'low',
          maxRetries: 0,
          ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
          onPayload: (payload: unknown) =>
            withCodexWebSearch(payload, {
              ...(request.locale?.market === undefined ? {} : { market: request.locale.market }),
              ...(request.tool === undefined ? {} : { tool: request.tool }),
            }),
          onProviderStreamEvent: (event: unknown) => {
            if (!isRecord(event)) return
            if (event.type === 'response.output_item.done' && isRecord(event.item))
              output.push(event.item)
            if (
              (event.type === 'response.completed' || event.type === 'response.incomplete') &&
              isRecord(event.response) &&
              Array.isArray(event.response.output) &&
              event.response.output.length > 0
            )
              completed = event.response.output
          },
        },
      )) as {
        stopReason?: string
        errorMessage?: string
        content?: { type: string; text?: string }[]
        usage?: { input: number; output: number; cacheRead: number }
      }
      if (message.stopReason === 'error' || message.stopReason === 'aborted') {
        const why = message.errorMessage ?? '没有说原因'
        throw webError(
          /sign|login|auth|401|403/iu.test(why)
            ? 'WEB_PROVIDER_CREDENTIAL_MISSING'
            : 'WEB_PROVIDER_ERROR',
          `ChatGPT 自带搜索这次没搜成（${why.slice(0, 200)}）`,
        )
      }
      const sources = await sourcesFromCodexOutput(completed ?? output, maxResults).catch((e) => {
        throw webError(
          'WEB_PROVIDER_ERROR',
          `ChatGPT 自带搜索没有真的去搜（${String((e as Error).message).slice(0, 160)}）`,
        )
      })
      const text = (message.content ?? [])
        .filter((c) => c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text)
        .join('\n')
      return {
        sources,
        model: modelId,
        ...(message.usage === undefined
          ? {}
          : {
              usage: {
                input_tokens: message.usage.input,
                output_tokens: message.usage.output,
                cached_tokens: message.usage.cacheRead,
              },
            }),
        ...(text === '' ? {} : { text }),
      }
    },
  }
}
