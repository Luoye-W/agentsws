/**
 * WP374（决策 980，Luoye 10-17）：**Anthropic 兼容口**——Claude 中转站等「Anthropic 格式」的服务。
 *
 * 一行协议都不是我们写的：请求、流式、工具调用、思考（extended thinking / adaptive）全走官方
 * `@earendil-works/pi-ai` 的 `anthropic-messages`（dsh 官方 `dsh-llm-pi-ai` 用的同一个实现，里面是
 * 官方 `@anthropic-ai/sdk`）。我们这里只做三件事：
 *
 * 1. 把我们的 `ChatMessage[]` / `ToolDef[]` 翻成 pi-ai 的 `Context`（{@link toAnthropicPiContext}），
 *    再把回来的 `AssistantMessage` 翻回补全（正文、工具调用、思考块、token）；
 * 2. 模型的「能做什么」（看图、上下文、思考档）**只从官方目录取**：模型名在 pi-ai 的 `anthropic`
 *    目录里认得出就照它（{@link anthropicModelFacts}），认不出就什么都不声明、也不发思考参数；
 * 3. 拉模型清单 `GET {根}/v1/models`（`x-api-key` + `anthropic-version`）——照官方 `dsh-llm-pi-ai`
 *    discovery 那一段的写法（它没导出，只能照写：根地址去掉一个结尾的 `/v1`、一页最多 1000 条、
 *    `data` 数组或 `models` 对象两种形状都认、回包大于 4 MB 不收）。
 *
 * 凭据纪律：key 由装配方每次现取（`apiKey()` 回调），只交给 pi-ai 的 `apiKey` 一格（它放进
 * `x-api-key` 头），不落变量、不进日志、不进错误。pi-ai 不读进程环境变量：我们的 provider id 不是
 * `anthropic`（那一家才会去读 `ANTHROPIC_*` 环境变量与联邦身份），没有 key 时直接拒。
 */
import type {
  CompletionHints,
  ModelCapabilities,
  ModelProvider,
  ProviderModelInfo,
  ReasoningEffort,
  ToolChoice,
} from '@agentsws/contracts'
import { REASONING_EFFORTS } from '@agentsws/contracts'
import { GatewayError, ProviderError } from '../types.js'
import { type PiAssistantLike, readPiAssistant, toAnthropicPiContext } from './anthropic-pi.js'

/** pi-ai 的协议名（目录与请求里都是这个）。 */
export const ANTHROPIC_MESSAGES_API = 'anthropic-messages'

/** 拉清单时带的 `anthropic-version`（官方 discovery 同一个值）。 */
export const ANTHROPIC_VERSION = '2023-06-01'

/** 拉清单最多等多久（与 OpenAI 兼容口拉清单同一个量级）。 */
export const ANTHROPIC_LIST_TIMEOUT_MS = 10_000

/** 清单回包大于这个就不收（官方 discovery 同一个上限）。 */
const MAX_LISTING_BYTES = 4 * 1024 * 1024

/** 目录里认不出的模型：发请求时的输出上限与上下文窗口（只是兜底，不对外声明）。 */
const UNKNOWN_MAX_TOKENS = 8192
const UNKNOWN_CONTEXT_WINDOW = 200_000

/** 官方目录里一个 Claude 模型「能做什么」（只取声明了的）。 */
export interface AnthropicModelFacts {
  id: string
  /** 目录里的显示名（Claude Sonnet 4.5…）。 */
  name: string
  /** 目录里写着收图。 */
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
  thinkingLevelMap?: Record<string, string | null>
  compat?: Record<string, unknown>
  [key: string]: unknown
}

interface AnthropicCatalog {
  models: Map<string, PiCatalogModel>
  facts: Map<string, AnthropicModelFacts>
}

let catalogOnce: Promise<AnthropicCatalog> | undefined
let catalogNow: AnthropicCatalog | undefined

const isReasoningEffort = (x: string): x is ReasoningEffort =>
  (REASONING_EFFORTS as readonly string[]).includes(x)

/**
 * 读一次官方 `anthropic` 目录（pi-ai 的生成目录，不是我们抄的清单）。只读、不联网、不碰凭据；
 * 读过就记住（之后 {@link anthropicModelFacts} 同步可用）。
 */
export function loadAnthropicCatalog(): Promise<AnthropicCatalog> {
  catalogOnce ??= Promise.all([
    import('@earendil-works/pi-ai/providers/anthropic.models'),
    import('@earendil-works/pi-ai/models'),
  ]).then(([{ ANTHROPIC_MODELS }, { getSupportedThinkingLevels }]) => {
    const models = new Map<string, PiCatalogModel>()
    const facts = new Map<string, AnthropicModelFacts>()
    for (const raw of Object.values(ANTHROPIC_MODELS) as unknown as PiCatalogModel[]) {
      models.set(raw.id, raw)
      // 照官方 `dsh-llm-pi-ai` 的 `reasoningInfo`：目录里不思考的模型不给档
      const efforts = raw.reasoning
        ? (getSupportedThinkingLevels(raw as never) as string[]).filter(isReasoningEffort)
        : []
      facts.set(raw.id, {
        id: raw.id,
        name: raw.name,
        vision: raw.input.includes('image'),
        context_window: raw.contextWindow,
        max_tokens: raw.maxTokens,
        ...(efforts.length === 0 ? {} : { efforts }),
      })
    }
    catalogNow = { models, facts }
    return catalogNow
  })
  return catalogOnce
}

/** 目录里怎么认一个模型名：先原样，再去掉结尾的日期（`-20250929`）。 */
function catalogKey(catalog: AnthropicCatalog, id: string): string | undefined {
  const name = id.trim()
  if (catalog.models.has(name)) return name
  const undated = name.replace(/-\d{8}$/u, '')
  return catalog.models.has(undated) ? undated : undefined
}

/**
 * 这个模型在官方目录里声明了什么（同步：目录还没读过就回 `undefined`，见 {@link loadAnthropicCatalog}）。
 * 认不出的模型（中转站自己起的名字）一样都不编。
 */
export function anthropicModelFacts(id: string): AnthropicModelFacts | undefined {
  if (catalogNow === undefined) return undefined
  const key = catalogKey(catalogNow, id)
  return key === undefined ? undefined : catalogNow.facts.get(key)
}

// ── 地址与模型清单 ─────────────────────────────────────────────────────

/**
 * 用户填的地址 → 根地址：去掉结尾的 `/`、再去掉**一个**结尾的 `/v1`。官方 SDK 自己会接 `/v1/messages`，
 * 中转站文档里两种写法（`https://x.com`、`https://x.com/v1`）都有，照官方 discovery 的做法都认。
 */
export function anthropicRootUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/u, '')
  return base.endsWith('/v1') ? base.slice(0, -3) : base
}

/** 拉清单的地址（官方 discovery：`{根}/v1/models?limit=1000`，只读一页）。 */
export function anthropicListingUrl(baseUrl: string): string {
  return `${anthropicRootUrl(baseUrl)}/v1/models?limit=1000`
}

/**
 * 读一份清单回包（照官方 discovery 的 `readListing`）：标准的 `data` 数组优先；没有就认 `models`
 * 对象（键就是模型名）。没有 id 的行跳过，不让一行坏数据毁了整份。
 */
export function readAnthropicListing(body: unknown): { id: string; name: string }[] {
  const listing = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  const rows: { key?: string; raw: Record<string, unknown> }[] = []
  if (Array.isArray(listing.data)) {
    for (const raw of listing.data)
      if (typeof raw === 'object' && raw !== null)
        rows.push({ raw: raw as Record<string, unknown> })
  } else if (typeof listing.models === 'object' && listing.models !== null) {
    for (const [key, raw] of Object.entries(listing.models as Record<string, unknown>))
      if (typeof raw === 'object' && raw !== null && !Array.isArray(raw))
        rows.push({ key, raw: raw as Record<string, unknown> })
  } else {
    throw new ProviderError('这个地址回的不是模型清单（既没有 data 数组也没有 models 对象）')
  }
  const label = (...xs: unknown[]): string | undefined =>
    xs.find((x): x is string => typeof x === 'string' && x.length > 0)
  const out: { id: string; name: string }[] = []
  for (const { key, raw } of rows) {
    const id = label(key, raw.id)
    if (id === undefined) continue
    out.push({ id, name: label(raw.display_name, raw.displayName, raw.name) ?? id })
  }
  return out
}

// ── 报错 → 哪一种 ──────────────────────────────────────────────────────

/**
 * pi-ai 回的那句报错（官方 SDK 的格式：`401 {"type":"error",…}`）→ 网关认的错。
 * 只看状态码与关键词：key 不对一律记成 401、额度 / 余额没了一律记成 402（界面据此说「key 不对」
 * 「余额不足」两句人话）；别的照原状态码（5xx 网关照常降级）。原文截到 200 字，里面不会有 key。
 */
export function anthropicProviderError(raw: string): ProviderError {
  const why = raw.slice(0, 200)
  const status = Number(/^\s*(\d{3})\b/u.exec(why)?.[1] ?? /\b([45]\d\d)\b/u.exec(why)?.[1] ?? NaN)
  const quota =
    /credit balance|insufficient|quota|billing|余额|额度不足|额度已用完|欠费/iu.test(why) ||
    status === 402
  const auth =
    status === 401 ||
    /authentication_error|invalid x-api-key|invalid api key|api key 无效|令牌无效/iu.test(why) ||
    (status === 403 && /permission|forbidden|auth/iu.test(why) && !quota)
  if (auth && !quota) return new ProviderError(`provider http 401: ${why}`, { status: 401 })
  if (quota) return new ProviderError(`provider http 402: ${why}`, { status: 402 })
  return new ProviderError(
    Number.isFinite(status) ? `provider http ${status}: ${why}` : why,
    Number.isFinite(status) ? { status } : {},
  )
}

// ── provider ──────────────────────────────────────────────────────────

export interface AnthropicCompatibleOptions {
  /** 用户填的接口地址（带不带 `/v1` 都行，见 {@link anthropicRootUrl}）。 */
  baseUrl: string
  /** key 的取值回调：**每次请求现取**（同 OpenAI 兼容口那一格的纪律）。 */
  apiKey: () => string | undefined
  model: string
  /** 网关上这条来源的 id（`provider/model` 的前半）。 */
  provider: string
  region?: 'cn' | 'global'
  /** WP127：能力声明（装配方按上一次验证 / 官方目录填；不给 = 不声明）。 */
  capabilities?: ModelCapabilities
  /** 测试注入（不给 = 全局 `fetch`）。官方 SDK 与拉清单都走它。 */
  fetch?: typeof globalThis.fetch
  /** 一次补全最多等多久（不给 = 官方 SDK 默认）。 */
  timeoutMs?: number
}

/** pi-ai 的模型：目录认得出就照目录（地址、来源换成这一条的），认不出就最小的一份、不声明思考。 */
function piModelOf(catalog: AnthropicCatalog, options: AnthropicCompatibleOptions): PiCatalogModel {
  const root = anthropicRootUrl(options.baseUrl)
  const key = catalogKey(catalog, options.model)
  const base = key === undefined ? undefined : catalog.models.get(key)
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  if (base === undefined) {
    return {
      id: options.model,
      name: options.model,
      api: ANTHROPIC_MESSAGES_API,
      provider: options.provider,
      baseUrl: root,
      // 认不出的模型照样把图送上去，能不能看以「测试」为准（不在这里替上游说「看不了」）
      input: ['text', 'image'],
      reasoning: false,
      contextWindow: UNKNOWN_CONTEXT_WINDOW,
      maxTokens: UNKNOWN_MAX_TOKENS,
      cost,
    }
  }
  // 官方目录里的「服务端降级到别的型号」只对 Anthropic 本家有效，中转站不一定有那几个型号
  const { allowedFallbackModels: _drop, ...compat } = base.compat ?? {}
  return {
    ...base,
    id: options.model,
    provider: options.provider,
    baseUrl: root,
    cost,
    compat,
  }
}

/** 这一次发不发思考、发哪一档：只发目录声明过的；`thinking: 'off'` 与强制工具时不发。 */
function reasoningOf(
  model: PiCatalogModel,
  hints: CompletionHints,
  choice: ToolChoice | undefined,
  facts: AnthropicModelFacts | undefined,
): ReasoningEffort | undefined {
  if (!model.reasoning || hints.thinking === 'off' || choice?.type === 'tool') return undefined
  const effort = hints.reasoning_effort
  if (effort === undefined || effort === 'off') return undefined
  return facts?.efforts?.includes(effort) === true ? effort : undefined
}

export function anthropicCompatibleProvider(options: AnthropicCompatibleOptions): ModelProvider {
  const ref = {
    provider: options.provider,
    model: options.model,
    region: options.region ?? 'global',
  }
  const fetchImpl = options.fetch ?? globalThis.fetch

  const listModels = async (): Promise<ProviderModelInfo[]> => {
    const key = options.apiKey()
    const headers: Record<string, string> = {
      accept: 'application/json',
      'anthropic-version': ANTHROPIC_VERSION,
    }
    if (key !== undefined && key !== '') headers['x-api-key'] = key
    let res: Response
    try {
      res = await fetchImpl(anthropicListingUrl(options.baseUrl), {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(ANTHROPIC_LIST_TIMEOUT_MS),
      })
    } catch (e) {
      throw new ProviderError(
        `连不上这个地址（${e instanceof Error ? e.message : String(e)}）`.slice(0, 200),
        {
          timeout: e instanceof Error && e.name === 'TimeoutError',
        },
      )
    }
    const text = await res.text()
    if (!res.ok) throw anthropicProviderError(`${res.status} ${text}`)
    if (text.length > MAX_LISTING_BYTES) throw new ProviderError('模型清单太大，没收')
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      throw new ProviderError('这个地址回的不是 JSON（可能不是 Anthropic 兼容口）')
    }
    return readAnthropicListing(body).map((m) => ({ id: m.id }))
  }

  return {
    ref,
    ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
    supports_tool_choice: true,
    listModels,
    async complete(req) {
      const key = options.apiKey()
      if (key === undefined || key === '')
        throw new GatewayError('invalid_input', '还没填 API key，先在设置里保存一把')
      const [catalog, { streamSimple }, { normalizeContext }] = await Promise.all([
        loadAnthropicCatalog(),
        import('@earendil-works/pi-ai/api/anthropic-messages'),
        import('@earendil-works/pi-ai/utils/transcript'),
      ])
      const model = piModelOf(catalog, options)
      const effort = reasoningOf(model, req, req.tool_choice, anthropicModelFacts(options.model))
      const context = toAnthropicPiContext(req.messages, req.tools, {
        api: ANTHROPIC_MESSAGES_API,
        provider: options.provider,
        model: options.model,
      })
      const choice = req.tool_choice
      const stream = streamSimple(model as never, normalizeContext(context as never), {
        apiKey: key,
        fetch: fetchImpl as never,
        ...(req.signal === undefined ? {} : { signal: req.signal }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(req.max_output_tokens === undefined ? {} : { maxTokens: req.max_output_tokens }),
        ...(effort === undefined ? {} : { reasoning: effort as never }),
        // 强制某个工具：官方 Anthropic 层认 `{ type: 'tool', name }`（中立层只有 auto / none）
        ...(choice === undefined
          ? {}
          : {
              toolChoice: (choice.type === 'tool' && choice.name !== undefined
                ? { type: 'tool', name: choice.name }
                : choice.type) as never,
            }),
      })
      for await (const event of stream as AsyncIterable<unknown>) {
        const e = event as { type?: unknown; delta?: unknown }
        if (e.type === 'text_delta' && typeof e.delta === 'string') req.on_delta?.(e.delta)
      }
      const message = (await stream.result()) as PiAssistantLike
      if (message.stopReason === 'error' || message.stopReason === 'aborted') {
        if (req.signal?.aborted === true || message.stopReason === 'aborted')
          throw Object.assign(new Error('已停下'), { name: 'AbortError' })
        throw anthropicProviderError(message.errorMessage ?? '没有说原因')
      }
      return readPiAssistant(message, options.model)
    },
  }
}
