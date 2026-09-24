/**
 * 第三种模型来源的推理口：**用 DeepSeek 账号登录之后的调用**（WP134）。
 *
 * 与 `openaiCompatibleProvider` 的差别就在凭据怎么来、发到哪儿、什么形状——这三样都照官方来：
 *
 * - **凭据**：不是用户填的 key，而是官方账号模块（`@deepseek-ai/dsh-deepseek-account-platform`）
 *   的 `resolveToken(url)` **每次请求现取**。官方只对它自己的 `inferenceOrigin`
 *   （默认 `https://api.deepseek.com`）给值，别的地址一律 `undefined`——所以"令牌能被发到哪儿"
 *   由官方模块决定，不由我们的配置决定。取回的值直接进请求头，不落任何变量、不进日志、不进错误信封。
 * - **请求头**：`x-dsh-auth-token: <令牌>`，**不加 Bearer**（官方 `dsh-llm-deepseek` README：
 *   「Messages 和 Files 请求通过 `x-dsh-auth-token` 发送账号 token，不加 Bearer 前缀」）；
 *   `redirect: 'error'`（同上：「两种凭据模式均拒绝重定向」）。
 * - **形状**：官方账号令牌走的是 **Anthropic Messages** 口（`https://api.deepseek.com/anthropic/v1/messages`，
 *   即官方 `PUBLIC_BASE_URL` + `/v1/messages`），不是 OpenAI 兼容的 `/chat/completions`——
 *   所以这里是一个单独的 provider，**不走我们的 OpenAI 兼容客户端**。
 *
 * WP143 起照官方补上 **Files API 复用**（`./deepseek-files.ts`，移植自官方 `dsh-llm-deepseek@0.1.7-rc.1`）：
 * 图片先 `POST /v1/files` 上传、请求里发 file id（头 `anthropic-beta: files-api-2025-04-14`）；
 * 同一张图按字节哈希只传一次；**任何一张解析失败或超时 → 整份请求退回内联 base64，一次请求绝不混用**；
 * 模型口说 file id 不认了（过期 / 404）→ 作废那条映射、重传、只重试一次。
 * 这一路也可以用 **API key**（`x-api-key`，官方同款）——见 {@link deepseekMessagesProvider}。
 *
 * 不带的东西（与官方适配器相比）：`x-deepseek-harness-*` 那几个归因头（harness 自己的遥测）、
 * 会话日志上报扩展（`session-log-deepseek`，profile 里关死的那条）、流式（网关按整段收）、
 * 图片前那段"附件 id + 请求尺寸"的说明文字（我们没有官方的附件服务）。
 */
import type {
  ChatContentPart,
  ChatMessage,
  ModelCapabilities,
  ModelProvider,
  ModelRef,
  ProviderModelInfo,
  ReasoningReplay,
  ToolDef,
} from '@agentsws/contracts'
import { GatewayError, ProviderError } from '../types.js'
import {
  DEFAULT_FILES_API_TIMEOUT_MS,
  type DeepSeekFileConnection,
  DeepSeekFileStore,
  imageKeyOf,
  MESSAGES_FILES_BETA,
  messagesApiRoot,
  providerErrorDetail,
  providerRejectedFileId,
  staleMappings,
} from './deepseek-files.js'
import { wireToolName } from './openai-compatible.js'

/** 官方 `dsh-llm-deepseek` 的 `PUBLIC_BASE_URL`：账号令牌能用的 Messages 口的根。 */
export const DEEPSEEK_ACCOUNT_BASE_URL = 'https://api.deepseek.com/anthropic'

/**
 * 账号登录这一路的默认型号：**能看图的那一档**。
 *
 * 出处：官方 `@deepseek-ai/dsh-llm-deepseek@0.1.7-rc.1` 的 `DEFAULT_MODELS`（`lib/index.js`）——
 * `deepseek-flash`（显示名 DeepSeek-V41-Flash，`inputModalities: ["text", "image"]`）与
 * `deepseek-v4-pro`（只收文字）。官方 README 的原话：省略 `models` 时「公布支持文本和图像的
 * `deepseek-flash`，以及仅支持文本的 `deepseek-v4-pro`」，并注明「不探测网关可用性」。
 * **DeepSeek 官网文档这一次没法核**（本单不联网）——能不能看图以三步验证的第 ③ 步为准。
 */
export const DEEPSEEK_ACCOUNT_DEFAULT_MODEL = 'deepseek-flash'

/** 官方目录（同上出处）。设置页的模型下拉照它画；`vision` 只是官方声明，验证才算数。 */
export const DEEPSEEK_ACCOUNT_MODELS: readonly { id: string; name: string; vision: boolean }[] = [
  { id: 'deepseek-flash', name: 'DeepSeek-V41-Flash', vision: true },
  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', vision: false },
]

/** Messages 协议版本头（官方适配器发的就是这个值）。 */
const ANTHROPIC_VERSION = '2023-06-01'

/** Messages 口必填 `max_tokens`。官方适配器的 `DEFAULT_MAX_TOKENS` 更大；我们一轮用不了那么多。 */
const DEFAULT_MAX_TOKENS = 8192

export type AccountFetch = (
  input: string,
  init: {
    method: 'POST'
    headers: Record<string, string>
    body: string
    redirect: 'error'
    signal?: AbortSignal
  },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>

export interface DeepSeekAccountProviderOptions {
  /**
   * 官方账号模块的 `resolveToken`。**每次请求现取**；回 `undefined` = 没登录（或者地址不在
   * 官方允许的推理源下），这一次调用当场失败并说人话。
   */
  resolveToken: (url: string) => Promise<string | undefined>
  model?: string
  /** 网关里的 provider id（`models.json` 那一条的 id）。 */
  provider?: string
  /** 推理口的根；缺省官方 `PUBLIC_BASE_URL`。**不在官方 `inferenceOrigin` 下的地址拿不到令牌。** */
  baseUrl?: string
  fetch?: AccountFetch
  timeoutMs?: number
  maxTokens?: number
  /** WP127：能力声明（装配方按上一次验证结果填）。 */
  capabilities?: ModelCapabilities
  /**
   * WP143：图片走 Files API 复用。给一个 store = 用它（装配方一个进程共用一个，同一张图只传一次）；
   * `false` = 不用 Files，图一律内联 base64。**不给时**：没注入 `fetch` 就自建一个（真网络）；
   * 注入了 `fetch`（测试 / demo 替身）就关掉 Files——替身不会顺手让上传走到真网络上去。
   */
  files?: DeepSeekFileStore | false
  /** 一次 Files 解析最多等多久（官方默认 60 秒）。超时 = 整份退内联。 */
  filesTimeoutMs?: number
}

/**
 * WP143：凭据从哪来。账号令牌（`x-dsh-auth-token`，每次现取）或 API key（`x-api-key`，每次现取）。
 * 官方原话：「Messages 和 Files 请求通过 `x-dsh-auth-token` 发送账号 token，不加 Bearer 前缀；
 * API Key 使用 `x-api-key`。两种凭据模式均拒绝重定向。」
 */
export type DeepSeekMessagesCredential =
  | { kind: 'account'; resolveToken: (url: string) => Promise<string | undefined> }
  | { kind: 'api_key'; apiKey: () => string | undefined }

export interface DeepSeekMessagesProviderOptions
  extends Omit<DeepSeekAccountProviderOptions, 'resolveToken'> {
  credential: DeepSeekMessagesCredential
}

type WireBlock =
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'text'; text: string }
  | { type: 'image'; source: WireImageSource }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string | WireBlock[] }

/** 图片来源：内联 base64，或 Files API 的 file id（官方同款，二者在一次请求里不混用）。 */
export type WireImageSource =
  | { type: 'base64'; media_type: string; data: string }
  | { type: 'file'; file_id: string }

interface WireMessage {
  role: 'user' | 'assistant'
  content: WireBlock[]
}

interface WireResponse {
  content?: (
    | { type: 'text'; text?: string }
    | { type: 'thinking'; thinking?: string; signature?: string }
    | { type: 'tool_use'; id?: string; name?: string; input?: unknown }
    | { type: string }
  )[]
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
}

const textOf = (content: string | ChatContentPart[]): string =>
  typeof content === 'string'
    ? content
    : content
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map((p) => p.text)
        .join('\n')

/** 一张图在线上长什么样：给了 `imageSource` 就问它（file id），否则内联 base64。 */
export interface MessagesRequestOptions {
  imageSource?: (image: { mime: string; data: string }) => WireImageSource
  /**
   * WP143：这次请求发给哪个模型。思考签名只对产出它的模型有效（官方 `readReplay`：跨模型不可移植），
   * 模型对不上就只回传思考原文、不带签名。不给 = 不比（按原样带签名）。
   */
  model?: string
}

/**
 * WP143：上一轮 assistant 的思考块怎么回传（照官方 `serialize.js` 的 `assistant()` + `replay.js`）。
 *
 * - 有 {@link ReasoningReplay}（同一条线路格式）：逐块原样，签名原样；模型对不上就去掉签名；
 * - 没有但有 `reasoning` 原文（例如历史来自别的 provider）：一块不带签名的思考——官方回放元数据
 *   无效时也是这样「省略签名，不丢弃文本」；
 * - 都没有：不发思考块。
 */
function thinkingBlocksOf(m: ChatMessage, model: string | undefined): WireBlock[] {
  const replay = m.reasoning_replay
  if (replay !== undefined && replay.kind === 'deepseek-messages' && replay.blocks.length > 0) {
    const signed = model === undefined || replay.model === model
    return replay.blocks.map((b) => ({
      type: 'thinking',
      thinking: b.thinking,
      ...(signed && b.signature !== undefined ? { signature: b.signature } : {}),
    }))
  }
  return m.reasoning === undefined || m.reasoning === ''
    ? []
    : [{ type: 'thinking', thinking: m.reasoning }]
}

const blocksOf = (
  content: string | ChatContentPart[],
  options: MessagesRequestOptions = {},
): WireBlock[] =>
  typeof content === 'string'
    ? content === ''
      ? []
      : [{ type: 'text', text: content }]
    : content.map((part) =>
        part.type === 'text'
          ? { type: 'text', text: part.text }
          : {
              type: 'image',
              source: options.imageSource?.(part) ?? {
                type: 'base64',
                media_type: part.mime,
                data: part.data,
              },
            },
      )

/**
 * 我们的对话 → Messages 形状。
 *
 * - `system` 抽出来拼成顶层 `system`；
 * - `tool` 结果变成 user 消息里的 `tool_result` 块；
 * - 助手的工具调用变成 `tool_use` 块（工具名同 OpenAI 那边一样换成合规名）；
 * - 相邻同角色合并（Messages 要求 user / assistant 交替）。
 *
 * WP143：上一轮的推理**原样带回**——思考块排在这条 assistant 内容的最前面（Messages 的回复里
 * 思考块本来就在前），签名原样（见 {@link thinkingBlocksOf}）。
 */
export function toMessagesRequest(
  messages: readonly ChatMessage[],
  options: MessagesRequestOptions = {},
): {
  system?: string
  messages: WireMessage[]
} {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => textOf(m.content))
    .filter((t) => t !== '')
  const out: WireMessage[] = []
  const push = (role: 'user' | 'assistant', blocks: WireBlock[]): void => {
    if (blocks.length === 0) return
    const last = out[out.length - 1]
    if (last !== undefined && last.role === role) last.content.push(...blocks)
    else out.push({ role, content: [...blocks] })
  }
  for (const m of messages) {
    if (m.role === 'system') continue
    if (m.role === 'tool') {
      /*
       * WP147：工具结果里有图（截图）时，`tool_result` 的 content 用块数组（文字 + 图片），
       * 照官方 `dsh-llm-deepseek`「Messages 只在 user 消息与工具结果里收图」；图片来源同样走
       * `imageSource`（Files 复用）。没有图的照旧是一段字符串，逐字节不变。
       */
      const images = typeof m.content !== 'string' && m.content.some((p) => p.type === 'image')
      push('user', [
        {
          type: 'tool_result',
          tool_use_id: m.tool_call_id ?? '',
          content: images ? blocksOf(m.content, options) : textOf(m.content),
        },
      ])
      continue
    }
    if (m.role === 'assistant') {
      push('assistant', [
        ...thinkingBlocksOf(m, options.model),
        ...blocksOf(m.content, options),
        ...(m.tool_calls ?? []).map(
          (c): WireBlock => ({
            type: 'tool_use',
            id: c.id,
            name: wireToolName(c.name),
            input: c.input ?? {},
          }),
        ),
      ])
      continue
    }
    push('user', blocksOf(m.content, options))
  }
  return { ...(system.length === 0 ? {} : { system: system.join('\n\n') }), messages: out }
}

const toWireTool = (t: ToolDef): Record<string, unknown> => ({
  name: wireToolName(t.name),
  description: t.description,
  input_schema: t.input_schema,
})

export function deepseekAccountProvider(options: DeepSeekAccountProviderOptions): ModelProvider {
  const { resolveToken, ...rest } = options
  return deepseekMessagesProvider({ ...rest, credential: { kind: 'account', resolveToken } })
}

/** 把一次请求里所有图片（按字节去重）挑出来：键、字节、类型。 */
function requestImages(
  messages: readonly ChatMessage[],
): Map<string, { key: string; data: Uint8Array; mime: string }> {
  const byData = new Map<string, { key: string; data: Uint8Array; mime: string }>()
  for (const m of messages) {
    if (typeof m.content === 'string') continue
    for (const part of m.content) {
      if (part.type !== 'image') continue
      const id = `${part.mime}\0${part.data}`
      if (byData.has(id)) continue
      const data = new Uint8Array(Buffer.from(part.data, 'base64'))
      byData.set(id, { key: imageKeyOf(part.mime, data), data, mime: part.mime })
    }
  }
  return byData
}

/**
 * DeepSeek 官方 Messages 口（WP134 账号登录那一路；WP143 起也能用 API key）。
 *
 * 一次 `complete` 的流程照官方 `DeepSeekAdapter.request`：
 * 1. 现取凭据（取不到当场失败，一个请求都不发）；
 * 2. 有图且开着 Files：逐张解析 file id（同图只传一次）；**任何一张失败或超时 → 这一整份请求改走内联**；
 * 3. 发模型请求（带 file id 时加 `anthropic-beta`）；
 * 4. 上游说 file id 不认了：作废点名的映射（没点名就作废这次用过的全部），**只重试一次**；
 *    重试时再解析失败同样整份退内联。
 */
export function deepseekMessagesProvider(options: DeepSeekMessagesProviderOptions): ModelProvider {
  const base = (options.baseUrl ?? DEEPSEEK_ACCOUNT_BASE_URL).replace(/\/+$/, '')
  const url = `${messagesApiRoot(base)}/messages`
  const model = options.model ?? DEEPSEEK_ACCOUNT_DEFAULT_MODEL
  const doFetch: AccountFetch = options.fetch ?? (globalThis.fetch as unknown as AccountFetch)
  const files: DeepSeekFileStore | undefined =
    options.files === false
      ? undefined
      : (options.files ?? (options.fetch === undefined ? new DeepSeekFileStore() : undefined))
  const filesTimeoutMs = options.filesTimeoutMs ?? DEFAULT_FILES_API_TIMEOUT_MS
  const account = options.credential.kind === 'account'
  const ref: ModelRef = {
    provider: options.provider ?? (account ? 'deepseek-account' : 'deepseek'),
    model,
    region: 'cn',
  }

  /** 现取凭据。值只在这一次 complete 里活：进头、当 scope 的哈希输入，然后丢掉。 */
  const credentialOf = async (): Promise<string> => {
    const c = options.credential
    const value = c.kind === 'account' ? await c.resolveToken(url) : c.apiKey()
    if (value === undefined || value === '') {
      throw new GatewayError(
        'invalid_input',
        c.kind === 'account' ? 'deepseek account is not signed in' : 'missing api key',
        { source: c.kind === 'account' ? 'deepseek_account' : 'local_vault' },
      )
    }
    return value
  }

  /** 逐张解析 file id；任何一张失败都回 `undefined`（= 整份退内联）。 */
  const resolveFileIds = async (
    images: Map<string, { key: string; data: Uint8Array; mime: string }>,
    connection: DeepSeekFileConnection,
    used: { imageKey: string; fileId: string }[],
  ): Promise<Map<string, string> | undefined> => {
    if (files === undefined || images.size === 0) return undefined
    const ids = new Map<string, string>()
    try {
      for (const [id, image] of images) {
        const { fileId } = await files.ensureUploaded(
          image,
          connection,
          AbortSignal.timeout(filesTimeoutMs),
        )
        ids.set(id, fileId)
        used.push({ imageKey: image.key, fileId })
      }
    } catch {
      // 官方 FileResolutionFailure：不细分原因，整份请求改走内联（一次请求绝不混用）
      return undefined
    }
    return ids
  }

  const post = async (
    credential: string,
    body: string,
    withFiles: boolean,
  ): Promise<Awaited<ReturnType<AccountFetch>>> => {
    const signal =
      options.timeoutMs === undefined ? undefined : AbortSignal.timeout(options.timeoutMs)
    try {
      return await doFetch(url, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': ANTHROPIC_VERSION,
          ...(account ? { 'x-dsh-auth-token': credential } : { 'x-api-key': credential }),
          ...(withFiles ? { 'anthropic-beta': MESSAGES_FILES_BETA } : {}),
        },
        body,
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (e) {
      const name = e instanceof Error ? e.name : ''
      throw new ProviderError(
        `request to ${url} failed: ${e instanceof Error ? e.message : String(e)}`,
        { timeout: name === 'TimeoutError' || name === 'AbortError' },
      )
    }
  }

  const provider: ModelProvider = {
    ref,
    ...(options.capabilities === undefined ? {} : { capabilities: { ...options.capabilities } }),
    async listModels(): Promise<ProviderModelInfo[]> {
      // 官方目录是写在官方包里的建议性清单，不是上游报的；不为它发请求
      return DEEPSEEK_ACCOUNT_MODELS.map((m) => ({ id: m.id, owned_by: 'deepseek' }))
    },
    async complete(req) {
      const names = new Map((req.tools ?? []).map((t) => [wireToolName(t.name), t.name]))
      const bodyOf = (fileIds: Map<string, string> | undefined): string => {
        const wire = toMessagesRequest(
          req.messages,
          fileIds === undefined
            ? { model }
            : {
                model,
                imageSource: (image) => {
                  const file_id = fileIds.get(`${image.mime}\0${image.data}`)
                  // 走到这里说明解析漏了一张：宁可失败也不混用
                  if (file_id === undefined) {
                    throw new GatewayError('invalid_input', 'request file id is missing', {})
                  }
                  return { type: 'file', file_id }
                },
              },
        )
        return JSON.stringify({
          model,
          max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
          ...wire,
          ...(req.tools === undefined || req.tools.length === 0
            ? {}
            : { tools: req.tools.map(toWireTool) }),
        })
      }
      // 值只在这一段里活一次：现取 → 进 header / 当哈希输入 → 结束
      const credential = await credentialOf()
      const connection: DeepSeekFileConnection = {
        baseURL: base,
        credential,
        accountCredential: account,
      }
      const images = requestImages(req.messages)
      let inline = false
      let retried = false
      let res: Awaited<ReturnType<AccountFetch>>
      for (;;) {
        const used: { imageKey: string; fileId: string }[] = []
        const fileIds = inline ? undefined : await resolveFileIds(images, connection, used)
        if (fileIds === undefined) inline = true
        res = await post(credential, bodyOf(fileIds), fileIds !== undefined)
        if (res.ok) break
        const detailText = await res.text().catch(() => '')
        if (fileIds !== undefined && files !== undefined) {
          let raw: unknown
          try {
            raw = JSON.parse(detailText)
          } catch {}
          const { detail } = providerErrorDetail(raw)
          if (providerRejectedFileId(detail)) {
            for (const stale of staleMappings(used, detail)) {
              files.invalidate(stale.imageKey, stale.fileId, connection)
            }
            if (!retried) {
              retried = true
              continue
            }
          }
        }
        throw new ProviderError(`provider http ${res.status}: ${detailText.slice(0, 200)}`, {
          status: res.status,
        })
      }
      const json = (await res.json()) as WireResponse
      let text = ''
      let reasoning = ''
      const thinking: ReasoningReplay['blocks'] = []
      const calls: { id: string; name: string; input: unknown }[] = []
      for (const [i, block] of (json.content ?? []).entries()) {
        if (block.type === 'text') text += (block as { text?: string }).text ?? ''
        else if (block.type === 'thinking') {
          const b = block as { thinking?: string; signature?: string }
          reasoning += b.thinking ?? ''
          // WP143：思考原文与签名原样留下，下一轮原样带回
          thinking.push({
            thinking: b.thinking ?? '',
            ...(typeof b.signature === 'string' ? { signature: b.signature } : {}),
          })
        } else if (block.type === 'tool_use') {
          const b = block as { id?: string; name?: string; input?: unknown }
          if (b.name === undefined) {
            throw new GatewayError('invalid_input', 'tool_use without name', { index: i })
          }
          calls.push({
            id: b.id ?? `call_${i}`,
            name: names.get(b.name) ?? b.name,
            input: b.input ?? {},
          })
        }
      }
      return {
        text,
        ...(calls.length === 0 ? {} : { tool_calls: calls }),
        ...(reasoning === '' ? {} : { reasoning }),
        ...(thinking.length === 0
          ? {}
          : { reasoning_replay: { kind: 'deepseek-messages' as const, model, blocks: thinking } }),
        usage: {
          /*
           * WP143：Messages 的 `input_tokens` 只算**没命中缓存**的那部分（官方适配器把缓存读 / 写各记一桶，
           * 「token 总数包含未缓存输入、输出、缓存读取与缓存写入」）；而我们的口径是 `input_tokens` **含**
           * `cached_tokens`（`pricing.ts` 的 `costOf`）。不加回来，命中缓存的那部分就被少算甚至不算。
           */
          input_tokens:
            (json.usage?.input_tokens ?? 0) +
            (json.usage?.cache_read_input_tokens ?? 0) +
            (json.usage?.cache_creation_input_tokens ?? 0),
          output_tokens: json.usage?.output_tokens ?? 0,
          cached_tokens: json.usage?.cache_read_input_tokens ?? 0,
          cost_base: 0,
        },
      }
    },
  }
  return provider
}
