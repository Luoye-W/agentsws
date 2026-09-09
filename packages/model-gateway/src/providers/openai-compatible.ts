import type {
  ChatMessage,
  ModelProvider,
  ModelRef,
  ProviderTranscription,
  ToolDef,
} from '@agentsws/contracts'
import { GatewayError, ProviderError } from '../types.js'

export type FetchLike = (
  input: string,
  init: {
    method: string
    headers: Record<string, string>
    /** JSON 档是字符串；`/audio/transcriptions` 档是 multipart 的 FormData。 */
    body: string | FormData
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
  /** 凭据只读环境变量名，网关外的代码永远拿不到值。 */
  apiKeyEnv: string
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
    const key = env[options.apiKeyEnv]
    if (key === undefined || key === '') {
      throw new GatewayError('invalid_input', 'missing api key environment variable', {
        env_var: options.apiKeyEnv,
      })
    }
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
      ...options.extraHeaders,
    }
  }

  const post = async (path: string, body: unknown, form?: FormData): Promise<unknown> => {
    const headers = authHeaders()
    // multipart 的 boundary 由 fetch 自己写，手工塞 content-type 会让上游解不出来
    if (form !== undefined) delete headers['content-type']
    const signal =
      options.timeoutMs === undefined ? undefined : AbortSignal.timeout(options.timeoutMs)
    let res: Awaited<ReturnType<FetchLike>>
    try {
      res = await doFetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers,
        body: form ?? JSON.stringify(body),
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (e) {
      const name = e instanceof Error ? e.name : ''
      const timeout = name === 'TimeoutError' || name === 'AbortError'
      throw new ProviderError(
        `request to ${baseUrl}${path} failed: ${e instanceof Error ? e.message : String(e)}`,
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

  const provider: ModelProvider = {
    ref,
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
