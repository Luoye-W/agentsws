/**
 * WP376（决策 1027，Luoye 10-17）：**自己接的 OpenAI 兼容口，地址是官方目录认识的那家时，改走官方 pi-ai**。
 *
 * 官方 dsh（`dsh-llm-pi-ai`）怎么给一条 OpenAI 兼容口出思考档：只有这条路由正是官方目录里那家
 * （OpenAI 本家、Moonshot、OpenRouter、百炼 Token Plan…）时才按那家的目录给档；每家把档发出去的写法
 * 不一样（`reasoning_effort`、`thinking: {type}`、`enable_thinking`、`reasoning: {effort}`…，官方 pi-ai 里
 * 有十来种），也都在那一家的目录条目和官方协议实现里。所以这里**一行协议都不写**：
 *
 * 1. 用户填的地址 → 官方目录里地址相同的那几家（{@link officialRouteFacts}，地址照官方目录逐字比，只认
 *    OpenAI 兼容的两种协议 `openai-completions` / `openai-responses`）；模型名在那几家的目录里 → 认得；
 * 2. 认得的：请求、流式、工具、思考档与它的传法全走官方 pi-ai 的那种协议（目录条目原样，只换来源 id 与地址）；
 *    名字、看图、上下文、思考档只照目录；
 * 3. 认不得的（中转站、自建、本机 Ollama、目录里没有的型号）：官方对它们一样不声明档位——不出思考小钮，
 *    请求照旧走我们原来的 OpenAI 兼容通道（{@link piRouteProvider} 的 `fallback`），一个字节都不变。
 *
 * 凭据纪律同 Anthropic 兼容口：key 每次现取、只交给 pi-ai 的 `apiKey` 一格；我们的来源 id 不是官方那家的 id，
 * pi-ai 不会去读进程环境变量。
 */
import type {
  CompletionHints,
  ModelCapabilities,
  ModelProvider,
  ReasoningEffort,
} from '@agentsws/contracts'
import { REASONING_EFFORTS } from '@agentsws/contracts'
import { promptCacheKeyOf } from '../feature.js'
import { GatewayError } from '../types.js'
import { anthropicProviderError } from './anthropic-compatible.js'
import { type PiAssistantLike, piToolNames, readPiAssistant, toPiContext } from './anthropic-pi.js'
import { wireToolName } from './openai-compatible.js'

/** 走官方 pi-ai 的 OpenAI 兼容协议（官方目录里只认这两种：别的协议不是「OpenAI 兼容口」）。 */
export const OPENAI_PI_APIS = ['openai-completions', 'openai-responses'] as const
export type OpenAiPiApi = (typeof OPENAI_PI_APIS)[number]

/** 官方目录里一个模型「能做什么」（只取声明了的；与 Anthropic 兼容口那份同形）。 */
export interface OfficialRouteFacts {
  /** 官方目录里那一家的 id（`openai`、`moonshotai-cn`…；只作记录与测试）。 */
  vendor: string
  api: OpenAiPiApi
  id: string
  name: string
  vision: boolean
  context_window: number
  max_tokens: number
  /** 能调的思考档（官方 `getSupportedThinkingLevels`，由浅到深）；目录里标了不思考的没有这一格。 */
  efforts?: ReasoningEffort[]
}

/** pi-ai 目录里的一条（只用到的几格）。 */
interface PiCatalogModel {
  id: string
  name: string
  api: string
  provider: string
  baseUrl: string
  input: string[]
  reasoning: boolean
  contextWindow: number
  maxTokens: number
  [key: string]: unknown
}

interface RouteCatalog {
  /** 地址（{@link routeKey}）→ 模型名 → 目录条目。 */
  byUrl: Map<string, Map<string, { model: PiCatalogModel; facts: OfficialRouteFacts }>>
}

let catalogOnce: Promise<RouteCatalog> | undefined
let catalogNow: RouteCatalog | undefined

const isReasoningEffort = (x: string): x is ReasoningEffort =>
  (REASONING_EFFORTS as readonly string[]).includes(x)

const isOpenAiPiApi = (x: string): x is OpenAiPiApi =>
  (OPENAI_PI_APIS as readonly string[]).includes(x)

/**
 * 地址怎么比：去空白、去结尾的 `/`、主机名小写；别的照原样（`/v1` 有没有、路径是什么都要一样——
 * 官方是按路由认的，地址差一截就不是那一家的那个口）。认不出的写法回 `undefined`。
 */
export function routeKey(baseUrl: string): string | undefined {
  const raw = baseUrl.trim().replace(/\/+$/u, '')
  if (raw === '' || raw.includes('{')) return undefined
  try {
    const url = new URL(raw)
    const path = url.pathname.replace(/\/+$/u, '')
    return `${url.protocol}//${url.host.toLowerCase()}${path}`
  } catch {
    return undefined
  }
}

/**
 * 决策 1045（Luoye 10-17）：这个模型选不同的档，官方 pi-ai 发出去的请求**真的不一样**吗？
 *
 * 照官方 `api/openai-completions.js` 的 `buildParams`（pi-ai 1.1.0）逐条判，`compat` 与官方 `getCompat` 同一个合法：
 * 目录条目上的 `compat` 写了就用它，没写按地址认（官方 `detectCompat` 里与档位有关的那两格）：
 *
 * - `openai-responses`：一律发 `reasoning.effort`（照目录的 `thinkingLevelMap` 换成那家的词）→ 档有用；
 * - `openai-completions`：
 *   - 有思考预算那一格（`compat.thinkingTokenBudgetField` / `supportsThinkingTokenBudget`）→ 预算按档算 → 有用；
 *   - `thinkingFormat` 是 `openrouter` / `string-thinking` / `ant-ling`：档原样（照映射）发出去 → 有用；
 *   - `chat-template` / `baseten`：模板参数里有按档取值的那种（不是 `thinking.enabled` 开关）→ 有用；
 *     `baseten` 另外看下一条；
 *   - 其余写法（`deepseek` / `zai` / `qwen` / `together` / `openai` / `qwen-chat-template`）：只有
 *     `compat.supportsReasoningEffort` 为真时才把档发出去（`reasoning_effort`）；为假时只发「开 / 关」。
 *
 * 为假的典型：Moonshot（`api.moonshot.ai` / `.cn`，kimi-k2.6 等，目录写 `thinkingFormat: deepseek`、
 * `supportsReasoningEffort: false`）、智谱（`zai` 那两家）、百炼 Token Plan 的 Qwen（`qwen` 写法，
 * `supportsReasoningEffort: false`）、Together、NVIDIA、Cloudflare AI Gateway。
 */
export function levelsSentApart(model: {
  api: string
  baseUrl: string
  compat?: Record<string, unknown>
}): boolean {
  if (model.api !== 'openai-completions') return true
  const c = model.compat ?? {}
  if (c.thinkingTokenBudgetField !== undefined || c.supportsThinkingTokenBudget === true)
    return true
  const url = model.baseUrl.toLowerCase()
  const has = (...xs: string[]): boolean => xs.some((x) => url.includes(x))
  // 官方 detectCompat：按地址认出来的写法与「发不发档」（只抄与档位有关的这两格）
  const zai = has('api.z.ai', 'open.bigmodel.cn')
  const together = has('api.together.ai', 'api.together.xyz')
  const antLing = has('api.ant-ling.com')
  const detectedFormat = has('deepseek.com')
    ? 'deepseek'
    : zai
      ? 'zai'
      : together
        ? 'together'
        : antLing
          ? 'ant-ling'
          : has('openrouter.ai')
            ? 'openrouter'
            : 'openai'
  const detectedEffort = !(
    has('api.x.ai', 'api.moonshot.', 'gateway.ai.cloudflare.com', 'integrate.api.nvidia.com') ||
    zai ||
    together ||
    antLing
  )
  const format = typeof c.thinkingFormat === 'string' ? c.thinkingFormat : detectedFormat
  const effort =
    typeof c.supportsReasoningEffort === 'boolean' ? c.supportsReasoningEffort : detectedEffort
  if (format === 'openrouter' || format === 'string-thinking' || format === 'ant-ling') return true
  const byLevel = (values: unknown): boolean =>
    Object.values((values ?? {}) as Record<string, unknown>).some(
      (v) =>
        typeof v === 'object' &&
        v !== null &&
        (v as { $var?: unknown }).$var !== 'thinking.enabled',
    )
  if (format === 'chat-template') return byLevel(c.chatTemplateKwargs)
  if (format === 'baseten') return effort || byLevel(c.chatTemplateArgs)
  return effort
}

/**
 * 档发不出去的模型：能「不想」就收成开关（`off` + 标准那一档；WP373 把它画成开关），关不掉就没得选（不出）。
 */
function onOffOnly(levels: readonly ReasoningEffort[]): ReasoningEffort[] {
  const on = (['medium', 'high', 'low', 'minimal', 'xhigh', 'max'] as const).find((e) =>
    levels.includes(e),
  )
  return levels.includes('off') && on !== undefined ? ['off', on] : []
}

/**
 * 读一次官方目录（pi-ai 的生成目录，所有内置的那几家；只读、不联网、不碰凭据），按地址建索引。
 * 读过就记住（之后 {@link officialRouteFacts} 同步可用）。同一个地址上几家都有同一个模型名时取先读到的那家。
 */
export function loadOfficialRoutes(): Promise<RouteCatalog> {
  catalogOnce ??= Promise.all([
    import('@earendil-works/pi-ai/providers/all'),
    import('@earendil-works/pi-ai/models'),
  ]).then(([{ getBuiltinProviders, getBuiltinModels }, { getSupportedThinkingLevels }]) => {
    const byUrl: RouteCatalog['byUrl'] = new Map()
    for (const vendor of getBuiltinProviders()) {
      for (const raw of getBuiltinModels(vendor as never) as unknown as PiCatalogModel[]) {
        if (!isOpenAiPiApi(raw.api)) continue
        const key = routeKey(raw.baseUrl)
        if (key === undefined) continue
        let models = byUrl.get(key)
        if (models === undefined) {
          models = new Map()
          byUrl.set(key, models)
        }
        if (models.has(raw.id)) continue
        // 照官方 `dsh-llm-pi-ai` 的 `reasoningInfo`：目录里不思考的模型不给档
        const declared = raw.reasoning
          ? (getSupportedThinkingLevels(raw as never) as string[]).filter(isReasoningEffort)
          : []
        // 决策 1045：目录写了好几档、官方传法却只分「想 / 不想」的，收成开关（或者没得选）
        const efforts = levelsSentApart(raw) ? declared : onOffOnly(declared)
        models.set(raw.id, {
          model: raw,
          facts: {
            vendor,
            api: raw.api,
            id: raw.id,
            name: raw.name,
            vision: raw.input.includes('image'),
            context_window: raw.contextWindow,
            max_tokens: raw.maxTokens,
            ...(efforts.length === 0 ? {} : { efforts }),
          },
        })
      }
    }
    catalogNow = { byUrl }
    return catalogNow
  })
  return catalogOnce
}

function lookup(
  baseUrl: string,
  model: string,
): { model: PiCatalogModel; facts: OfficialRouteFacts } | undefined {
  const key = routeKey(baseUrl)
  if (catalogNow === undefined || key === undefined) return undefined
  return catalogNow.byUrl.get(key)?.get(model.trim())
}

/**
 * 这个地址 + 模型在官方目录里声明了什么（同步：目录还没读过就回 `undefined`，见 {@link loadOfficialRoutes}）。
 * 地址不是官方目录里那几家的、或者模型名不在那一家的目录里：回 `undefined`（一样都不编）。
 */
export function officialRouteFacts(baseUrl: string, model: string): OfficialRouteFacts | undefined {
  return lookup(baseUrl, model)?.facts
}

/** 这个地址是不是官方目录里认识的那几家之一（不看模型名；设置页据此说「这家的思考档照官方目录」）。 */
export function isOfficialRouteUrl(baseUrl: string): boolean {
  const key = routeKey(baseUrl)
  return catalogNow !== undefined && key !== undefined && catalogNow.byUrl.has(key)
}

/**
 * 这一次发不发思考、发哪一档：只发目录声明过的；调用方硬要「别想」（`thinking: 'off'`）不发
 * （不发 = 官方协议按目录发「不想」那一种写法，见 pi-ai 各家的 `thinkingFormat`）。
 */
export function routeEffortOf(
  facts: OfficialRouteFacts | undefined,
  hints: CompletionHints,
  defaultEffort?: () => ReasoningEffort | undefined,
): ReasoningEffort | undefined {
  if (facts?.efforts === undefined || hints.thinking === 'off') return undefined
  const effort = hints.reasoning_effort ?? defaultEffort?.()
  if (effort === undefined || effort === 'off') return undefined
  return facts.efforts.includes(effort) ? effort : undefined
}

// ── provider ──────────────────────────────────────────────────────────

export interface PiRouteOptions {
  /** 用户填的接口地址（与官方目录逐字比，见 {@link routeKey}）。 */
  baseUrl: string
  /** key 的取值回调：**每次请求现取**。 */
  apiKey: () => string | undefined
  model: string
  /** 网关上这条来源的 id（`provider/model` 的前半）。 */
  provider: string
  /** 能力声明（装配方按上一次验证 / 官方目录填；不给 = 照 `fallback` 的）。 */
  capabilities?: ModelCapabilities
  /**
   * 认不得时用的那一个（我们原来的 OpenAI 兼容通道）。拉清单、向量、语音识别也一直用它——
   * 官方 pi-ai 没有这几样。
   */
  fallback: ModelProvider
  /** 测试注入（不给 = 全局 `fetch`）。 */
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
  /**
   * 决策 1032「显示什么就发什么」：没选思考档时发这一档（装配方给 AI 钮上默认亮的那一档）。现取。
   */
  defaultEffort?: () => ReasoningEffort | undefined
}

/** 官方协议的实现（只认那两种；动态取，没用到的不进内存）。 */
async function apiOf(api: OpenAiPiApi): Promise<{ streamSimple: (...xs: never[]) => unknown }> {
  return api === 'openai-responses'
    ? ((await import('@earendil-works/pi-ai/api/openai-responses')) as never)
    : ((await import('@earendil-works/pi-ai/api/openai-completions')) as never)
}

/**
 * 自己接的 OpenAI 兼容口：地址 + 模型是官方目录认识的 → 走官方 pi-ai 那一家的协议（档位与传法照目录）；
 * 认不得 → 原样交给 `fallback`。
 */
export function piRouteProvider(options: PiRouteOptions): ModelProvider {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const { fallback } = options
  return {
    ...fallback,
    ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
    async complete(req) {
      await loadOfficialRoutes()
      const hit = lookup(options.baseUrl, options.model)
      if (hit === undefined) return fallback.complete(req)
      const key = options.apiKey()
      if (key === undefined || key === '')
        throw new GatewayError('invalid_input', '还没填 API key，先在设置里保存一把')
      const api = hit.facts.api
      const [{ streamSimple }, { normalizeContext }] = await Promise.all([
        apiOf(api),
        import('@earendil-works/pi-ai/utils/transcript'),
      ])
      const model = {
        ...hit.model,
        id: options.model,
        // 来源 id 用官方那一家的（官方协议里有几处按家认：OpenAI 本家的缓存键、xAI 的思考密文…）；
        // key 只走 `apiKey` 一格，不读进程环境变量
        provider: hit.facts.vendor,
        baseUrl: options.baseUrl.trim().replace(/\/+$/u, ''),
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }
      const effort = routeEffortOf(hit.facts, req, options.defaultEffort)
      const names = piToolNames(req.tools)
      const context = toPiContext(req.messages, req.tools, {
        api,
        provider: hit.facts.vendor,
        model: options.model,
      })
      const choice = req.tool_choice
      const forced =
        choice?.type === 'tool' && choice.name !== undefined ? wireToolName(choice.name) : undefined
      const toolChoice =
        choice === undefined
          ? undefined
          : forced === undefined
            ? choice.type === 'tool'
              ? 'auto'
              : choice.type
            : api === 'openai-responses'
              ? { type: 'function', name: forced }
              : { type: 'function', function: { name: forced } }
      const seed = req.seed
      // WP473：缓存分组键（工作区 + 职责，或调用方给的段；只发哈希）——OpenAI 本家据此带 `prompt_cache_key`
      const sessionId = promptCacheKeyOf(req.meta)
      const stream = streamSimple(
        model as never,
        normalizeContext(context as never) as never,
        {
          apiKey: key,
          fetch: fetchImpl,
          ...(req.signal === undefined ? {} : { signal: req.signal }),
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
          ...(req.max_output_tokens === undefined ? {} : { maxTokens: req.max_output_tokens }),
          ...(effort === undefined ? {} : { reasoning: effort }),
          ...(toolChoice === undefined ? {} : { toolChoice }),
          ...(sessionId === undefined ? {} : { sessionId }),
          // 以前这条通道发过的 `seed` 照发（官方协议不管它；只在 Chat Completions 那种上发）
          ...(seed === undefined || api !== 'openai-completions'
            ? {}
            : { onPayload: (p: unknown) => ({ ...(p as Record<string, unknown>), seed }) }),
        } as never,
      ) as AsyncIterable<unknown> & { result(): Promise<unknown> }
      for await (const event of stream) {
        const e = event as { type?: unknown; delta?: unknown }
        if (e.type === 'text_delta' && typeof e.delta === 'string') req.on_delta?.(e.delta)
      }
      const message = (await stream.result()) as PiAssistantLike
      if (message.stopReason === 'error' || message.stopReason === 'aborted') {
        if (req.signal?.aborted === true || message.stopReason === 'aborted')
          throw Object.assign(new Error('已停下'), { name: 'AbortError' })
        throw anthropicProviderError(message.errorMessage ?? '没有说原因')
      }
      return readPiAssistant(message, options.model, api, names)
    },
  }
}
