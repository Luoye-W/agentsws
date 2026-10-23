/**
 * WP362（Luoye 10-16，决策 938）：**用 ChatGPT 订阅跑活**——模型网关那一跳。
 *
 * WP90 把订阅登录接上了，但订阅模型只在登录卡里，网关上没有它，所以岗位、助理、随便聊都用不上。
 * 这个文件是网关能调的那一半：把我们的 `ChatMessage[]` / `ToolDef[]` 翻成官方 `pi-ai` 的
 * `Context`，经 `pi-ai` 的 `openai-codex` provider 打 `chatgpt.com/backend-api/codex/responses`，
 * 再把回来的 `AssistantMessage` 翻回我们的补全（正文、工具调用、token）。
 *
 * 一行 OAuth / 请求头 / 端点都不是我们写的（与 WP355 的自带搜索同一条路）：
 * - 令牌由 pi-ai 自己从本机加密库那条 `llm-pi-ai/openai-codex` 记录里取、快过期时自己刷新并经
 *   `modifyRecord` 回写（{@link piCredentialStore}）。**我们的代码不读、不打印、不转存任何令牌**；
 * - pi-ai 只装 `openai-codex` 这一家（`createModels` + `openaiCodexProvider`，实测 46 毫秒），
 *   不装三十多家的 `providers/all`（那一份要四秒多）；
 * - 不读进程环境变量、不探本机凭据文件（`authContext` 永远回「没有」）。
 *
 * 为什么不走 dsh 里的官方 `dsh-llm-pi-ai` 适配器：那条路要把凭据插件挂进**每一次运行**那棵树，
 * 子进程档还得把凭据带过进程边界。走网关这一跳，三个运行时（stub / direct / dsh）同一条路，
 * 凭据只在服务进程里；记账、预算、事件也都是网关那一套（订阅 `cost_base` 恒为 0）。
 */
import type {
  ChatContentPart,
  ChatMessage,
  ReasoningEffort,
  ToolChoice,
  ToolDef,
} from '@agentsws/contracts'
import { REASONING_EFFORTS } from '@agentsws/contracts'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { type CredentialRecordsLike, piCredentialStore } from './native-search.js'
import { SUBSCRIPTION_RECORD_SCOPE } from './subscription-facts.js'

/** 网关能用的那一家（第一版只接 ChatGPT 订阅；Claude 订阅不接，见 WP362 报告）。 */
export const SUBSCRIPTION_CHAT_PROVIDER = 'openai-codex'

/** 订阅目录里的一个模型（`vision` = 目录里写着收图）。 */
export interface SubscriptionCatalogModel {
  id: string
  name: string
  vision: boolean
  /**
   * WP370（只加）：这个模型能调的思考档（官方 pi-ai `getSupportedThinkingLevels`，由浅到深；
   * 目录里标了不思考的模型没有这一格——官方 `dsh-llm-pi-ai` 同款：不给就不出「思考程度」那一行）。
   */
  efforts?: ReasoningEffort[]
  /** WP370（只加）：上下文窗口（token；目录里的 `contextWindow`）。 */
  context_window?: number
}

export interface SubscriptionChatRequest {
  model: string
  messages: ChatMessage[]
  tools?: ToolDef[]
  tool_choice?: ToolChoice
  max_output_tokens?: number
  thinking?: 'off'
  /** WP370：思考程度（目录里这个模型声明过的档才发；`off` 照官方 = 不写 `reasoning`）。 */
  reasoning_effort?: ReasoningEffort
  on_delta?: (text: string) => void
  signal?: AbortSignal
  /**
   * WP473（只加）：缓存分组键（宿主给的是「工作区 + 职责」或助理段的**哈希**，不含个人信息）。
   * 交给 pi-ai 当会话标识：订阅那头据此把同一组请求排到一起，开头相同的部分才命中缓存。
   */
  session_id?: string
}

export interface SubscriptionChatResult {
  text: string
  tool_calls?: { id: string; name: string; input: unknown }[]
  usage: { input_tokens: number; output_tokens: number; cached_tokens: number }
  /** 实际用的模型。 */
  model: string
}

/**
 * 订阅这一跳没跑成，**是哪一种**（宿主据此决定出不出「重新登录」的连接卡）：
 * - `sign_in`：这台机器上还没用 ChatGPT 订阅登录；
 * - `expired`：登录过期 / 被撤销（401、403、刷新令牌失败）；
 * - `rate_limited`：订阅额度这阵子用满了（429、usage limit）；
 * - `other`：别的（网络、上游 5xx、模型不在目录里……）。
 *
 * `message` 是人话，**不带任何令牌**（pi-ai 的报错里只有状态码与一句原因，我们再截到 200 字）。
 */
export class SubscriptionChatError extends Error {
  readonly kind: 'sign_in' | 'expired' | 'rate_limited' | 'other'
  readonly status: number | undefined
  constructor(kind: SubscriptionChatError['kind'], message: string, status?: number) {
    super(message)
    this.name = 'SubscriptionChatError'
    this.kind = kind
    this.status = status
  }
}

/** pi-ai 那句报错 → 哪一种（只看状态码与关键词，不看值）。 */
export function subscriptionErrorKind(message: string): SubscriptionChatError['kind'] {
  if (/\b429\b|rate.?limit|usage.?limit|too many requests|quota/iu.test(message))
    return 'rate_limited'
  if (
    /\b40[13]\b|unauthori[sz]ed|forbidden|expired|invalid.?grant|refresh|oauth|log.?in|sign.?in/iu.test(
      message,
    )
  )
    return 'expired'
  return 'other'
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

// ── 翻译：我们的消息 → pi-ai 的 Context ────────────────────────────────

type PiText = { type: 'text'; text: string }
type PiImage = { type: 'image'; data: string; mimeType: string }
type PiToolCall = { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> }
type PiMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | (PiText | PiImage)[]; timestamp: number }
  | {
      role: 'assistant'
      content: (PiText | PiToolCall)[]
      api: string
      provider: string
      model: string
      usage: Record<string, unknown>
      stopReason: 'stop' | 'toolUse'
      timestamp: number
    }
  | {
      role: 'toolResult'
      toolCallId: string
      toolName: string
      content: (PiText | PiImage)[]
      isError: boolean
      timestamp: number
    }

export interface PiContext {
  systemPrompt?: string
  messages: PiMessage[]
  tools?: { name: string; description: string; parameters: unknown }[]
}

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

function textOf(content: string | ChatContentPart[]): string {
  if (typeof content === 'string') return content
  return content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
}

function partsOf(content: string | ChatContentPart[]): (PiText | PiImage)[] {
  if (typeof content === 'string') return content === '' ? [] : [{ type: 'text', text: content }]
  return content.map((p) =>
    p.type === 'text'
      ? { type: 'text' as const, text: p.text }
      : { type: 'image' as const, data: p.data, mimeType: p.mime },
  )
}

/** 工具参数在 pi-ai 那里必须是对象；模型回过非对象的，包一层（不丢内容）。 */
function argsOf(input: unknown): Record<string, unknown> {
  if (isRecord(input)) return input
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input) as unknown
      if (isRecord(parsed)) return parsed
    } catch {
      // 不是 JSON：原样包一层
    }
  }
  return input === undefined ? {} : { value: input }
}

/**
 * `ChatMessage[]` → pi-ai 的 `Context`。
 *
 * - 开头连着的那几条 system → `systemPrompt`（Codex 的 `instructions`）；之后再出现的 system
 *   原样作 pi-ai 的 system 消息（gpt-5.5 目录里写着 `supportsMidConvoSystemMessages`，别的由 pi-ai 按模型处理）；
 * - assistant 的工具调用 → `toolCall` 块；工具结果 → `toolResult`（工具名缺了就从上一条 assistant 里补）；
 * - 图片部件原样（base64 + mime）。
 */
export function toPiContext(
  messages: readonly ChatMessage[],
  tools: readonly ToolDef[] | undefined,
  model: string,
  now: number = Date.now(),
): PiContext {
  const system: string[] = []
  const out: PiMessage[] = []
  const toolNames = new Map<string, string>()
  for (const m of messages) {
    if (m.role === 'system') {
      const text = textOf(m.content)
      if (text === '') continue
      if (out.length === 0) system.push(text)
      else out.push({ role: 'system', content: text })
      continue
    }
    if (m.role === 'user') {
      out.push({ role: 'user', content: partsOf(m.content), timestamp: now })
      continue
    }
    if (m.role === 'assistant') {
      const content: (PiText | PiToolCall)[] = []
      const text = textOf(m.content)
      if (text !== '') content.push({ type: 'text', text })
      for (const c of m.tool_calls ?? []) {
        toolNames.set(c.id, c.name)
        content.push({ type: 'toolCall', id: c.id, name: c.name, arguments: argsOf(c.input) })
      }
      out.push({
        role: 'assistant',
        content,
        api: 'openai-codex-responses',
        provider: SUBSCRIPTION_CHAT_PROVIDER,
        model,
        usage: EMPTY_USAGE,
        stopReason: (m.tool_calls ?? []).length > 0 ? 'toolUse' : 'stop',
        timestamp: now,
      })
      continue
    }
    const id = m.tool_call_id ?? ''
    out.push({
      role: 'toolResult',
      toolCallId: id,
      toolName: m.name ?? toolNames.get(id) ?? 'tool',
      content: partsOf(m.content),
      isError: false,
      timestamp: now,
    })
  }
  return {
    ...(system.length === 0 ? {} : { systemPrompt: system.join('\n\n') }),
    messages: out,
    ...(tools === undefined || tools.length === 0
      ? {}
      : {
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.input_schema,
          })),
        }),
  }
}

// ── pi-ai：只装 openai-codex 这一家 ───────────────────────────────────────

/** pi-ai 的环境查询：**永远回「没有」**——不读进程环境变量、不探本机凭据文件（凭据纪律）。 */
const NO_AMBIENT_AUTH = {
  env: async (): Promise<undefined> => undefined,
  fileExists: async (): Promise<boolean> => false,
}

interface PiStreamLike extends AsyncIterable<unknown> {
  result(): Promise<unknown>
}
interface PiCatalogModelLike {
  id: string
  name: string
  input?: readonly string[]
  reasoning?: boolean
  contextWindow?: number
}
interface PiModelsLike {
  getModels(provider?: string): readonly PiCatalogModelLike[]
  getModel(provider: string, id: string): unknown
  streamSimple(model: unknown, context: unknown, options?: unknown): PiStreamLike
}

/**
 * 一份只有 `openai-codex` 的 pi-ai 模型集合。`records` 不给 = 只读目录（不能发请求）。
 * pi-ai 的两个子路径都是官方导出的（`./models`、`./providers/*`）。
 */
async function codexModels(records?: CredentialRecordsLike): Promise<PiModelsLike> {
  const [{ createModels }, { openaiCodexProvider }] = await Promise.all([
    import('@earendil-works/pi-ai/models'),
    import('@earendil-works/pi-ai/providers/openai-codex'),
  ])
  const models = createModels({
    ...(records === undefined ? {} : { credentials: piCredentialStore(records) as never }),
    authContext: NO_AMBIENT_AUTH,
  })
  models.setProvider(openaiCodexProvider())
  return models as unknown as PiModelsLike
}

/**
 * 订阅目录（来自 pi-ai 的生成目录，不是我们抄的清单）。只读目录、不碰凭据、不联网。
 * 别的订阅来源回空（第一版只接 ChatGPT）。
 */
export async function subscriptionCatalog(provider: string): Promise<SubscriptionCatalogModel[]> {
  if (provider !== SUBSCRIPTION_CHAT_PROVIDER) return []
  const [models, { getSupportedThinkingLevels }] = await Promise.all([
    codexModels(),
    import('@earendil-works/pi-ai/models'),
  ])
  return models.getModels(SUBSCRIPTION_CHAT_PROVIDER).map((m) => {
    // WP370：照官方 `dsh-llm-pi-ai` 的 `reasoningInfo`——目录里不思考的模型不给档；给了就是 pi-ai 认的那几档
    const efforts =
      m.reasoning === true
        ? (getSupportedThinkingLevels(m as never) as string[]).filter(isReasoningEffort)
        : []
    return {
      id: m.id,
      name: m.name,
      vision: (m.input ?? []).includes('image'),
      ...(efforts.length === 0 ? {} : { efforts }),
      ...(typeof m.contextWindow === 'number' && m.contextWindow > 0
        ? { context_window: m.contextWindow }
        : {}),
    }
  })
}

const isReasoningEffort = (x: string): x is ReasoningEffort =>
  (REASONING_EFFORTS as readonly string[]).includes(x)

// ── 跑一次补全 ─────────────────────────────────────────────────────────

export interface SubscriptionChat {
  complete(request: SubscriptionChatRequest): Promise<SubscriptionChatResult>
}

interface PiAssistant {
  content?: { type: string; text?: string; id?: string; name?: string; arguments?: unknown }[]
  usage?: { input?: number; output?: number; cacheRead?: number }
  stopReason?: string
  errorMessage?: string
}

/**
 * 造一个「用 ChatGPT 订阅跑一次补全」。pi-ai 的模型集合懒建一次；凭据层每次现读
 * （登出 / 换账号下一次就生效）。`fetch` 只给测试用（替身）；产品里 pi-ai 用全局 `fetch`。
 */
export function createSubscriptionChat(
  records: CredentialRecordsLike,
  deps: { fetch?: typeof globalThis.fetch } = {},
): SubscriptionChat {
  let modelsOnce: Promise<PiModelsLike> | undefined
  return {
    async complete(request) {
      const record = await records.readRecord(
        credentialKey(SUBSCRIPTION_RECORD_SCOPE, SUBSCRIPTION_CHAT_PROVIDER),
      )
      if (record === undefined)
        throw new SubscriptionChatError('sign_in', '还没用 ChatGPT 订阅登录。登录一次就能接着用。')
      modelsOnce ??= codexModels(records)
      const collection = await modelsOnce
      const model = collection.getModel(SUBSCRIPTION_CHAT_PROVIDER, request.model)
      if (model === undefined)
        throw new SubscriptionChatError(
          'other',
          `ChatGPT 订阅的模型目录里没有 ${request.model}，换一个模型试试。`,
        )
      const context = toPiContext(request.messages, request.tools, request.model)
      const choice = request.tool_choice?.type
      const stream = collection.streamSimple(model, context, {
        // 走 SSE：同一条 `/codex/responses`（与 WP355 自带搜索同一种）
        transport: 'sse',
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        ...(request.max_output_tokens === undefined
          ? {}
          : { maxTokens: request.max_output_tokens }),
        ...(request.thinking === 'off'
          ? { reasoning: 'minimal' }
          : // WP370：官方同款——`off` 就是不写 `reasoning`；别的档原样交给 pi-ai（它按目录映射成订阅认的值）
            request.reasoning_effort === undefined || request.reasoning_effort === 'off'
            ? {}
            : { reasoning: request.reasoning_effort }),
        ...(choice === 'none'
          ? { toolChoice: 'none' }
          : choice === undefined
            ? {}
            : { toolChoice: 'auto' }),
        ...(request.session_id === undefined || request.session_id === ''
          ? {}
          : { sessionId: request.session_id }),
        ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
      })
      for await (const event of stream) {
        if (!isRecord(event)) continue
        if (event.type === 'text_delta' && typeof event.delta === 'string')
          request.on_delta?.(event.delta)
      }
      const message = (await stream.result()) as PiAssistant
      if (message.stopReason === 'error' || message.stopReason === 'aborted') {
        if (request.signal?.aborted === true || message.stopReason === 'aborted')
          throw Object.assign(new Error('已停下'), { name: 'AbortError' })
        const why = (message.errorMessage ?? '没有说原因').slice(0, 200)
        const status = /\b(4\d\d|5\d\d)\b/u.exec(why)?.[1]
        throw new SubscriptionChatError(
          subscriptionErrorKind(why),
          `ChatGPT 订阅这次没跑成（${why}）`,
          status === undefined ? undefined : Number(status),
        )
      }
      const content = message.content ?? []
      const text = content
        .filter((c) => c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text as string)
        .join('')
      const calls = content
        .filter((c) => c.type === 'toolCall' && typeof c.name === 'string')
        .map((c) => ({ id: String(c.id ?? ''), name: c.name as string, input: c.arguments ?? {} }))
      return {
        text,
        ...(calls.length === 0 ? {} : { tool_calls: calls }),
        usage: {
          // pi-ai 的 `input` 不含命中缓存的那部分；我们的口径（与 OpenAI 兼容口同）是「含缓存」
          input_tokens: (message.usage?.input ?? 0) + (message.usage?.cacheRead ?? 0),
          output_tokens: message.usage?.output ?? 0,
          cached_tokens: message.usage?.cacheRead ?? 0,
        },
        model: request.model,
      }
    },
  }
}
