import type {
  ChatContentPart,
  ChatMessage,
  ModelCapabilities,
  ModelMeta,
  ModelProvider,
  ModelRef,
  ProviderModelInfo,
  ProviderTranscription,
  ToolDef,
} from '@agentsws/contracts'
import { describeFetchError, isTransientNetError } from '../net-cause.js'
import { estimateInputTokens } from '../pricing.js'
import { GatewayError, ProviderError } from '../types.js'
import {
  type DeepSeekBalanceListener,
  deepseekQuotaError,
  isDeepSeekQuotaFailure,
} from './deepseek-quota.js'
import { readChatStream } from './openai-stream.js'

export type FetchLike = (
  input: string,
  init: {
    method: string
    headers: Record<string, string>
    /** JSON 档是字符串；`/audio/transcriptions` 档是 multipart 的 FormData；GET 没有 body。 */
    body?: string | FormData
    signal?: AbortSignal
  },
) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
  text(): Promise<string>
  /** WP188：流式回包的字节流（真 fetch 有；替身可以不给，退回 `text()` 一次读完）。 */
  body?: ReadableStream<Uint8Array> | null
}>

export interface OpenAiCompatibleOptions {
  /** DeepSeek 即此形态；默认 https://api.deepseek.com */
  baseUrl?: string
  /**
   * 凭据的**环境变量名**（不是值）。无界面的部署（CI、`scripts/dev-real.sh`）走这条。
   * 与 {@link OpenAiCompatibleOptions.apiKey} 二选一，两个都给时 `apiKey` 优先。
   */
  apiKeyEnv?: string
  /**
   * 凭据的**取值回调**（WP25）。
   *
   * 为什么要有它：用户在设置页填的 key 存在本机 AES-256-GCM 加密库里，不在环境变量里
   * ——把它写进 `process.env` 等于让同进程的任何代码、任何 core dump、任何子进程都能读到，
   * 正好是 22 §5「业务代码里没有 key」要防的。所以给一个**每次请求现取**的回调：
   * key 不在配置对象里长住，改完设置下一次调用自然就是新的。
   *
   * 回调只在 `authHeaders()` 里调用一次，取回的值直接进 `Authorization` 头，
   * 不落任何变量、不进日志、不进错误信封。
   */
  apiKey?: () => string | undefined
  model: string
  provider?: string
  region?: 'cn' | 'global'
  env?: Record<string, string | undefined>
  fetch?: FetchLike
  timeoutMs?: number
  /** 给了才暴露 embed（走 /embeddings）。 */
  embeddingModel?: string
  /** 给了才暴露 transcribe（走 /audio/transcriptions，OpenAI 的 whisper 形态）。 */
  transcriptionModel?: string
  extraHeaders?: Record<string, string>
  /**
   * WP127：能力声明（看不看得了图 / 出不出得了图）。**装配方按上一次验证结果填**；
   * 不给就不声明（"不知道"不等于"不能"）。
   */
  capabilities?: ModelCapabilities
  /**
   * WP151：这一条是 **DeepSeek 官方 API key**（装配方只对官方地址给）。给了：上游说余额不足
   * （402 或官方认作余额不足的措辞）就以"DeepSeek API 余额不足。用建这把 key 的那个 DeepSeek 账号登录开放平台，充值后再试"失败
   * （`reason: 'quota'`，网关原样往上抛），并回调 `onBalance(true)`；一次对话成功回调 `onBalance(false)`。
   * 不给 = 照旧（别家的 402 仍是泛泛的上游错误）。
   */
  deepseekBalance?: { onBalance?: DeepSeekBalanceListener }
  /**
   * WP194：每次对话现算的额外请求头（拿得到这一次的 {@link ModelMeta}）。「Agents 工坊官方接口」
   * 那一条用它带 `X-Agentsws-Member` / `X-Agentsws-Position`；别家不给。回的值只进请求头。
   */
  requestHeaders?: (meta: ModelMeta | undefined) => Record<string, string>
  /**
   * WP194：这一条是 **Agents 工坊官方接口**。给了：上游回 402 且正文是我们的错误信封
   * `{ code, message, details }` 时，以那句人话失败（`budget_exhausted`，网关原样往上抛）——
   * 「本月额度用完了，找管理员加。」与「积分不够了」是两句话，不能被翻成泛泛的上游错误。
   */
  cloudErrors?: boolean
}

interface WireToolCall {
  id?: string
  function?: { name?: string; arguments?: string }
}
interface WireUsage {
  prompt_tokens?: number
  completion_tokens?: number
  prompt_cache_hit_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
}
interface WireChatResponse {
  choices?: {
    message?: {
      content?: string | null
      reasoning_content?: string | null
      tool_calls?: WireToolCall[]
    }
  }[]
  usage?: WireUsage
}
/** OpenAI 形态的 `GET /models`。DeepSeek、Moonshot、通义、智谱、SiliconFlow、Ollama 都回这个形状。 */
interface WireModelList {
  data?: { id?: string; owned_by?: string }[]
}
/** Ollama 自己的 `GET /api/tags`（没开 OpenAI 兼容层的老版本只有这个口）。 */
interface WireOllamaTags {
  models?: { name?: string; model?: string }[]
}
interface WireEmbeddingResponse {
  data?: { embedding?: number[] }[]
  usage?: WireUsage
}
/** OpenAI `/audio/transcriptions`（`response_format: verbose_json`）。 */
interface WireTranscriptionResponse {
  text?: string
  language?: string
  duration?: number
  segments?: { start?: number; end?: number; text?: string; speaker?: string }[]
}

/**
 * OpenAI 兼容口对工具名只认 `^[a-zA-Z0-9_-]+$`（DeepSeek 实测 400：
 * "Invalid 'tools[4].function.name': string does not match pattern"）。我们的工具名带点
 * （`shopify.docs.search`、`orders.get`）。出站时把不合规字符换成 `__`，回来的 tool_call
 * 再按本次请求的工具表映射回原名——模型看到的是合规名，运行时看到的永远是原名。
 */
export const wireToolName = (name: string): string => name.replace(/[^a-zA-Z0-9_-]/g, '__')

/**
 * content 出线：string 原样；数组（WP122b 视觉档）翻成 OpenAI 兼容口认的
 * text / image_url 两类部件，图片按 `data:` URL 内联（base64）。数组的
 * `image` 部件是我们契约里的形状，不是 OpenAI 的——这一跳就是它的翻译处。
 */
const toWireContent = (content: string | ChatContentPart[]): string | Record<string, unknown>[] => {
  if (typeof content === 'string') return content
  return content.map((part) =>
    part.type === 'text'
      ? { type: 'text', text: part.text }
      : {
          type: 'image_url',
          image_url: { url: `data:${part.mime};base64,${part.data}` },
        },
  )
}

/**
 * WP230：assistant 只带工具调用、自己没说话时 content 发 `null`（OpenAI 规范：
 * 「Required unless tool_calls is specified」，DeepSeek 文档同样标 nullable；各家回这种消息时
 * 自己也是 `content: null`）。空字符串有的兼容口会当「空内容」拒掉，`null` 是各家都认的那一种。
 */
const isCallOnly = (m: ChatMessage): boolean =>
  m.role === 'assistant' &&
  (m.tool_calls?.length ?? 0) > 0 &&
  (typeof m.content === 'string' ? m.content === '' : m.content.length === 0)

const toWireMessage = (m: ChatMessage): Record<string, unknown> => ({
  role: m.role,
  content: isCallOnly(m) ? null : toWireContent(m.content),
  ...(m.name === undefined ? {} : { name: m.role === 'tool' ? wireToolName(m.name) : m.name }),
  ...(m.tool_call_id === undefined ? {} : { tool_call_id: m.tool_call_id }),
  // 思考模型（DeepSeek thinking 模式）多轮时要把上一轮的推理原样带回，否则 400
  ...(m.role === 'assistant' && m.reasoning !== undefined
    ? { reasoning_content: m.reasoning }
    : {}),
  // 上一轮模型发出的工具调用必须原样带回去，否则 provider 400：
  // "Messages with role 'tool' must be a response to a preceding message with 'tool_calls'"
  ...(m.role !== 'assistant' || m.tool_calls === undefined || m.tool_calls.length === 0
    ? {}
    : {
        tool_calls: m.tool_calls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: wireToolName(c.name), arguments: JSON.stringify(c.input ?? {}) },
        })),
      }),
})

/** 这条消息里带没带图片部件。 */
const hasImage = (content: string | ChatContentPart[]): content is ChatContentPart[] =>
  typeof content !== 'string' && content.some((p) => p.type === 'image')

/** WP147：工具结果里图片之外的那段文字（没有文字时给一句占位，照官方 pi-ai）。 */
export const TOOL_IMAGE_PLACEHOLDER = '(see attached image)'
/** WP147：工具结果里的图片挪进紧跟的一条 user 消息，开头这一句（照官方 pi-ai 原文）。 */
export const TOOL_IMAGES_LEAD = 'Attached image(s) from tool result:'

/**
 * WP147：整份对话出线。与逐条 {@link toWireMessage} 只差一处——**工具结果里的图片**。
 *
 * OpenAI 兼容口的 `role: 'tool'` 只收文字（带 `image_url` 的数组各家一律 400），所以照官方
 * `@earendil-works/pi-ai`（`dsh-llm-pi-ai` 用的那一份，MIT）`openai-completions` 的做法：
 * 一串相邻的工具结果照常各发一条**纯文字** tool 消息（只有图没字的给 `(see attached image)`），
 * 这一串结束后补**一条** user 消息「Attached image(s) from tool result:」+ 这些图（`image_url`，
 * `data:` URL 内联）。没有图的对话与逐条翻译**逐字节相同**。
 */
export function toWireMessages(messages: readonly ChatMessage[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  let pending: Record<string, unknown>[] = []
  const flush = (): void => {
    if (pending.length === 0) return
    out.push({ role: 'user', content: [{ type: 'text', text: TOOL_IMAGES_LEAD }, ...pending] })
    pending = []
  }
  for (const m of messages) {
    if (m.role !== 'tool') flush()
    if (m.role !== 'tool' || !hasImage(m.content)) {
      out.push(toWireMessage(m))
      continue
    }
    const text = m.content
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('\n')
    out.push(toWireMessage({ ...m, content: text.length > 0 ? text : TOOL_IMAGE_PLACEHOLDER }))
    for (const part of m.content) {
      if (part.type === 'image') {
        pending.push({
          type: 'image_url',
          image_url: { url: `data:${part.mime};base64,${part.data}` },
        })
      }
    }
  }
  flush()
  return out
}

const toWireTool = (t: ToolDef): Record<string, unknown> => ({
  type: 'function',
  function: { name: wireToolName(t.name), description: t.description, parameters: t.input_schema },
})

/** 本次请求的 合规名 → 原名；两个原名撞成同一个合规名是调用方的错，当场拒。 */
function toolNameMap(tools: ToolDef[] | undefined): Map<string, string> {
  const map = new Map<string, string>()
  for (const t of tools ?? []) {
    const wire = wireToolName(t.name)
    const prior = map.get(wire)
    if (prior !== undefined && prior !== t.name) {
      throw new GatewayError('invalid_input', 'two tool names collapse to the same wire name', {
        wire,
        names: [prior, t.name],
      })
    }
    map.set(wire, t.name)
  }
  return map
}

const cachedOf = (u: WireUsage | undefined): number =>
  u?.prompt_tokens_details?.cached_tokens ?? u?.prompt_cache_hit_tokens ?? 0

/** 网关是唯一持凭据的地方；这里也只拿环境变量名，不接受字面量凭据。 */
/**
 * WP194：官方接口回的 402 → 那句人话（`budget_exhausted`）。
 *
 * 正文是我们自己的错误信封 `{ code, message, details }`：`details.reason` 分
 * `member_limit`（本月额度用完了）/ `position_limit`（这个岗位的额度用完了）/ `org_balance`（公司积分用完了）。
 * 不是信封（中间有代理改了正文）就说一句不分人的。
 */
export function cloudQuotaError(detail: string): GatewayError {
  let message = '官方接口说积分不够了，这一次没做。'
  let reason: string | undefined
  try {
    const body = JSON.parse(detail) as { message?: unknown; details?: { reason?: unknown } }
    if (typeof body.message === 'string' && body.message.trim() !== '') message = body.message
    if (typeof body.details?.reason === 'string') reason = body.details.reason
  } catch {
    // 不是信封：用上面那句
  }
  return new GatewayError('budget_exhausted', message, {
    source: 'agentsws_cloud',
    status: 402,
    ...(reason === undefined ? {} : { reason }),
  })
}

export function openaiCompatibleProvider(options: OpenAiCompatibleOptions): ModelProvider {
  const baseUrl = (options.baseUrl ?? 'https://api.deepseek.com').replace(/\/+$/, '')
  const env = options.env ?? process.env
  const doFetch: FetchLike = options.fetch ?? (globalThis.fetch as unknown as FetchLike)
  const ref: ModelRef = {
    provider: options.provider ?? 'deepseek',
    model: options.model,
    ...(options.region === undefined ? {} : { region: options.region }),
  }

  const authHeaders = (): Record<string, string> => {
    // 值只在这个函数栈里活一次：取 → 进 header → 结束
    const key = options.apiKey === undefined ? env[options.apiKeyEnv ?? ''] : options.apiKey()
    if (key === undefined || key === '') {
      throw new GatewayError(
        'invalid_input',
        // WP242：官方接口那一条缺的是关联账号时签的工作区令牌，不是用户填的 key——照实说
        options.cloudErrors === true
          ? 'missing cloud workspace token (this brand has no Agents Workshop link)'
          : 'missing api key',
        {
          // 报错里只有来源（环境变量名 / 本机加密库），永远没有值
          source: options.apiKey === undefined ? (options.apiKeyEnv ?? 'unset') : 'local_vault',
        },
      )
    }
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
      ...options.extraHeaders,
    }
  }

  /** 一次上游调用。**唯一**发请求的地方——header 由 `authHeaders()` 现取现用。 */
  const open = async (
    url: string,
    init: {
      method: 'GET' | 'POST'
      body?: string | FormData
      multipart?: boolean
      /** WP188：调用方的停止信号（流式那条路给）。 */
      signal?: AbortSignal
      /** WP194：这一次多带的头（官方接口那一条的「谁 / 哪个岗位」）。 */
      headers?: Record<string, string>
    },
  ): Promise<Awaited<ReturnType<FetchLike>>> => {
    const headers = { ...authHeaders(), ...init.headers }
    // multipart 的 boundary 由 fetch 自己写，手工塞 content-type 会让上游解不出来
    if (init.multipart === true) delete headers['content-type']
    const timeout =
      options.timeoutMs === undefined ? undefined : AbortSignal.timeout(options.timeoutMs)
    const signals = [timeout, init.signal].filter((x): x is AbortSignal => x !== undefined)
    const signal =
      signals.length === 0
        ? undefined
        : signals.length === 1
          ? signals[0]
          : AbortSignal.any(signals)
    const send = () =>
      doFetch(url, {
        method: init.method,
        headers,
        ...(init.body === undefined ? {} : { body: init.body }),
        ...(signal === undefined ? {} : { signal }),
      })
    let res: Awaited<ReturnType<FetchLike>>
    try {
      try {
        res = await send()
      } catch (first) {
        /*
         * WP242：连接被对面 / 本机代理掐了（`ECONNRESET`、陈旧的长连接 `UND_ERR_SOCKET`……）——
         * 还没拿到回执，马上再发一次大概率就好。只重发一次；调用方停的、超时的不重发。
         * multipart 的正文是一次性的流，不重发。
         */
        if (!isTransientNetError(first) || init.multipart === true || signal?.aborted === true)
          throw first
        res = await send()
      }
    } catch (e) {
      const name = e instanceof Error ? e.name : ''
      const timeout = name === 'TimeoutError' || name === 'AbortError'
      // WP242：`fetch failed` 后面带上真原因（cause.code），不然 provider_down 里什么都看不出来
      throw new ProviderError(`request to ${url} failed: ${describeFetchError(e)}`, { timeout })
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      if (options.cloudErrors === true && res.status === 402) throw cloudQuotaError(detail)
      if (options.deepseekBalance !== undefined && isDeepSeekQuotaFailure(res.status, detail)) {
        options.deepseekBalance.onBalance?.(true)
        throw deepseekQuotaError('api_key', res.status)
      }
      throw new ProviderError(`provider http ${res.status}: ${detail.slice(0, 200)}`, {
        status: res.status,
      })
    }
    return res
  }

  const request = async (
    url: string,
    init: {
      method: 'GET' | 'POST'
      body?: string | FormData
      multipart?: boolean
      headers?: Record<string, string>
    },
  ): Promise<unknown> => (await open(url, init)).json()

  const post = async (
    path: string,
    body: unknown,
    form?: FormData,
    headers?: Record<string, string>,
  ): Promise<unknown> =>
    request(`${baseUrl}${path}`, {
      method: 'POST',
      body: form ?? JSON.stringify(body),
      ...(form === undefined ? {} : { multipart: true }),
      ...(headers === undefined ? {} : { headers }),
    })

  /**
   * 这家现在有哪些模型（WP42）。
   *
   * 先打 OpenAI 形态的 `GET {base}/models`——DeepSeek、OpenAI、Moonshot、通义、
   * 智谱、SiliconFlow、Ollama 的 `/v1/models` 都是这一个形状。打不通再兜一次
   * Ollama 自己的 `GET {origin}/api/tags`（本机跑的老 Ollama 只有这个口）。
   *
   * 两条都不通就把**第一条**的错抛出去：用户想知道的是"我填的这个地址怎么了"，
   * 不是"顺手试的那个兜底口怎么了"。
   */
  const listModels = async (): Promise<ProviderModelInfo[]> => {
    let first: unknown
    try {
      const json = (await request(`${baseUrl}/models`, { method: 'GET' })) as WireModelList
      const rows = json.data ?? []
      if (rows.length > 0) return normalizeModels(rows.map((r) => ({ id: r.id, from: r.owned_by })))
      first = new ProviderError('provider returned an empty model list')
    } catch (e) {
      first = e
    }
    try {
      const json = (await request(`${ollamaTagsUrl(baseUrl)}`, { method: 'GET' })) as WireOllamaTags
      const rows = json.models ?? []
      if (rows.length > 0) return normalizeModels(rows.map((r) => ({ id: r.model ?? r.name })))
    } catch {
      // 兜底口的错吞掉：报第一条的
    }
    throw first
  }

  /** WP188：流式请求一次，拼回非流式那个形状（后面的工具调用解析、用量换算照旧）。 */
  const streamed = async (
    payload: Record<string, unknown>,
    onText: (text: string) => void,
    signal: AbortSignal | undefined,
    headers?: Record<string, string>,
  ): Promise<WireChatResponse> => {
    const res = await open(`${baseUrl}/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({ ...payload, stream: true, stream_options: { include_usage: true } }),
      ...(signal === undefined ? {} : { signal }),
      ...(headers === undefined ? {} : { headers }),
    })
    const reply = await readChatStream(res, onText, signal)
    return {
      choices: [
        {
          message: {
            content: reply.content,
            ...(reply.reasoning === '' ? {} : { reasoning_content: reply.reasoning }),
            ...(reply.tool_calls.length === 0
              ? {}
              : {
                  tool_calls: reply.tool_calls.map((c) => ({
                    ...(c.id === undefined ? {} : { id: c.id }),
                    function: {
                      ...(c.name === undefined ? {} : { name: c.name }),
                      arguments: c.arguments === '' ? '{}' : c.arguments,
                    },
                  })),
                }),
          },
        },
      ],
      ...(reply.usage === undefined ? {} : { usage: reply.usage }),
    }
  }

  const provider: ModelProvider = {
    ref,
    // WP127：能力声明由装配方给（来自上一次验证）；没给就是"还不知道"，网关照常放行
    ...(options.capabilities === undefined ? {} : { capabilities: { ...options.capabilities } }),
    listModels,
    async complete(req) {
      const payload = {
        model: options.model,
        messages: toWireMessages(req.messages),
        ...(req.tools === undefined ? {} : { tools: req.tools.map(toWireTool) }),
        ...(req.seed === undefined ? {} : { seed: req.seed }),
      }
      // WP194：官方接口那一条带上「谁 / 哪个岗位」
      const extra = options.requestHeaders?.(req.meta)
      // WP188：调用方要一段一段收（随便聊）→ 走流式；拼回来的形状与非流式一模一样
      const json: WireChatResponse =
        req.on_delta === undefined
          ? ((await post(
              '/chat/completions',
              { ...payload, stream: false },
              undefined,
              extra,
            )) as WireChatResponse)
          : await streamed(payload, req.on_delta, req.signal, extra)
      const message = json.choices?.[0]?.message
      if (message === undefined) {
        throw new ProviderError('provider response has no choices')
      }
      // WP151：这一次成了——余额够用
      options.deepseekBalance?.onBalance?.(false)
      const names = toolNameMap(req.tools)
      const calls = (message.tool_calls ?? []).map((c, i) => {
        const wire = c.function?.name
        if (wire === undefined) {
          throw new GatewayError('invalid_input', 'tool_call without function name', { index: i })
        }
        const name = names.get(wire) ?? wire
        const args = c.function?.arguments ?? '{}'
        let input: unknown
        try {
          input = JSON.parse(args) as unknown
        } catch {
          throw new GatewayError('invalid_input', 'tool_call arguments are not valid JSON', {
            index: i,
            tool: name,
          })
        }
        return { id: c.id ?? `call_${i}`, name, input }
      })
      const usage = json.usage
      const reasoning = message.reasoning_content
      const text = message.content ?? ''
      return {
        text,
        ...(calls.length === 0 ? {} : { tool_calls: calls }),
        ...(typeof reasoning === 'string' && reasoning.length > 0 ? { reasoning } : {}),
        usage:
          usage === undefined && req.on_delta !== undefined
            ? // WP188：有的上游流式时不回用量（不认 include_usage）——按字数估，好过记 0
              {
                input_tokens: estimateInputTokens(req.messages, req.tools, 4),
                output_tokens: Math.ceil((text.length + (reasoning?.length ?? 0)) / 4),
                cached_tokens: 0,
                cost_base: 0,
              }
            : {
                input_tokens: usage?.prompt_tokens ?? 0,
                output_tokens: usage?.completion_tokens ?? 0,
                cached_tokens: cachedOf(usage),
                cost_base: 0,
              },
      }
    },
  }

  const transcriptionModel = options.transcriptionModel
  const withAsr: ModelProvider =
    transcriptionModel === undefined
      ? provider
      : {
          ...provider,
          async transcribe(audio): Promise<ProviderTranscription> {
            const form = new FormData()
            form.set('model', transcriptionModel)
            form.set('response_format', 'verbose_json')
            if (audio.language !== undefined) form.set('language', audio.language)
            form.set(
              'file',
              new Blob([new Uint8Array(audio.bytes)], { type: audio.mime }),
              `audio.${extensionFor(audio.mime)}`,
            )
            const json = (await post(
              '/audio/transcriptions',
              undefined,
              form,
            )) as WireTranscriptionResponse
            const text = json.text ?? ''
            const segments = (json.segments ?? []).map((seg, i) => ({
              start_ms: Math.round((seg.start ?? i) * 1000),
              end_ms: Math.round((seg.end ?? i + 1) * 1000),
              ...(seg.speaker === undefined ? {} : { speaker: seg.speaker }),
              text: seg.text ?? '',
            }))
            const speakers = [
              ...new Set(
                (json.segments ?? [])
                  .map((seg) => seg.speaker)
                  .filter((sp): sp is string => sp !== undefined),
              ),
            ]
            return {
              text,
              segments,
              ...(speakers.length === 0 ? {} : { speakers }),
              ...(json.language === undefined ? {} : { language: json.language }),
              usage: {
                // 按秒计价：上游 verbose_json 回 duration（秒）
                input_tokens: Math.max(1, Math.ceil(json.duration ?? 0)),
                output_tokens: Math.ceil(text.length / 4),
                cached_tokens: 0,
              },
            }
          },
        }

  const embeddingModel = options.embeddingModel
  if (embeddingModel === undefined) return withAsr
  return {
    ...withAsr,
    async embed(texts: string[]) {
      const json = (await post('/embeddings', {
        model: embeddingModel,
        input: texts,
      })) as WireEmbeddingResponse
      const rows = json.data ?? []
      if (rows.length !== texts.length) {
        throw new ProviderError(
          `embeddings returned ${rows.length} rows for ${texts.length} inputs`,
        )
      }
      return {
        vectors: rows.map((r) => r.embedding ?? []),
        usage: {
          input_tokens: json.usage?.prompt_tokens ?? 0,
          output_tokens: 0,
          cached_tokens: cachedOf(json.usage),
          cost_base: 0,
        },
      }
    },
  }
}

const MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/flac': 'flac',
}

/** 上游按文件名后缀判格式，所以 mime 要能翻成一个它认识的扩展名。 */
export function extensionFor(mime: string): string {
  return MIME_EXTENSIONS[mime.split(';')[0]?.trim() ?? mime] ?? 'bin'
}

/** `.../v1` → `.../api/tags`；没有 `/v1` 就直接挂在后面。 */
export function ollamaTagsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/v1$/, '')}/api/tags`
}

/** 去重、去空、按名字排序——下拉框要的是一份稳定的清单，不是上游的返回顺序。 */
function normalizeModels(
  rows: { id?: string | undefined; from?: string | undefined }[],
): ProviderModelInfo[] {
  const seen = new Map<string, ProviderModelInfo>()
  for (const row of rows) {
    const id = row.id?.trim()
    if (id === undefined || id === '') continue
    if (seen.has(id)) continue
    seen.set(id, {
      id,
      ...(row.from === undefined || row.from === '' ? {} : { owned_by: row.from }),
    })
  }
  return [...seen.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}
