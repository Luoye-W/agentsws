import type {
  ChatMessage,
  ModelProvider,
  ModelRef,
  ProviderModelInfo,
  ProviderTranscription,
  ToolDef,
} from '@agentsws/contracts'
import { GatewayError, ProviderError } from '../types.js'

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
  choices?: { message?: { content?: string | null; tool_calls?: WireToolCall[] } }[]
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

const toWireMessage = (m: ChatMessage): Record<string, unknown> => ({
  role: m.role,
  content: m.content,
  ...(m.name === undefined ? {} : { name: m.name }),
  ...(m.tool_call_id === undefined ? {} : { tool_call_id: m.tool_call_id }),
})

const toWireTool = (t: ToolDef): Record<string, unknown> => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.input_schema },
})

const cachedOf = (u: WireUsage | undefined): number =>
  u?.prompt_tokens_details?.cached_tokens ?? u?.prompt_cache_hit_tokens ?? 0

/** 网关是唯一持凭据的地方；这里也只拿环境变量名，不接受字面量凭据。 */
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
      throw new GatewayError('invalid_input', 'missing api key', {
        // 报错里只有来源（环境变量名 / 本机加密库），永远没有值
        source: options.apiKey === undefined ? (options.apiKeyEnv ?? 'unset') : 'local_vault',
      })
    }
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
      ...options.extraHeaders,
    }
  }

  /** 一次上游调用。**唯一**发请求的地方——header 由 `authHeaders()` 现取现用。 */
  const request = async (
    url: string,
    init: { method: 'GET' | 'POST'; body?: string | FormData; multipart?: boolean },
  ): Promise<unknown> => {
    const headers = authHeaders()
    // multipart 的 boundary 由 fetch 自己写，手工塞 content-type 会让上游解不出来
    if (init.multipart === true) delete headers['content-type']
    const signal =
      options.timeoutMs === undefined ? undefined : AbortSignal.timeout(options.timeoutMs)
    let res: Awaited<ReturnType<FetchLike>>
    try {
      res = await doFetch(url, {
        method: init.method,
        headers,
        ...(init.body === undefined ? {} : { body: init.body }),
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (e) {
      const name = e instanceof Error ? e.name : ''
      const timeout = name === 'TimeoutError' || name === 'AbortError'
      throw new ProviderError(
        `request to ${url} failed: ${e instanceof Error ? e.message : String(e)}`,
        { timeout },
      )
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new ProviderError(`provider http ${res.status}: ${detail.slice(0, 200)}`, {
        status: res.status,
      })
    }
    return res.json()
  }

  const post = async (path: string, body: unknown, form?: FormData): Promise<unknown> =>
    request(`${baseUrl}${path}`, {
      method: 'POST',
      body: form ?? JSON.stringify(body),
      ...(form === undefined ? {} : { multipart: true }),
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

  const provider: ModelProvider = {
    ref,
    listModels,
    async complete(req) {
      const json = (await post('/chat/completions', {
        model: options.model,
        messages: req.messages.map(toWireMessage),
        ...(req.tools === undefined ? {} : { tools: req.tools.map(toWireTool) }),
        ...(req.seed === undefined ? {} : { seed: req.seed }),
        stream: false,
      })) as WireChatResponse
      const message = json.choices?.[0]?.message
      if (message === undefined) {
        throw new ProviderError('provider response has no choices')
      }
      const calls = (message.tool_calls ?? []).map((c, i) => {
        const name = c.function?.name
        if (name === undefined) {
          throw new GatewayError('invalid_input', 'tool_call without function name', { index: i })
        }
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
      return {
        text: message.content ?? '',
        ...(calls.length === 0 ? {} : { tool_calls: calls }),
        usage: {
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
