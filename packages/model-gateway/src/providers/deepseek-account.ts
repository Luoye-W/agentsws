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
 * 不带的东西（与官方适配器相比）：`x-deepseek-harness-*` 那几个归因头（harness 自己的遥测）、
 * 会话日志上报扩展（`session-log-deepseek`，profile 里关死的那条）、Files API 上传（我们的图只有
 * 一两张，base64 内联就够）、流式（网关按整段收）。
 */
import type {
  ChatContentPart,
  ChatMessage,
  ModelCapabilities,
  ModelProvider,
  ModelRef,
  ProviderModelInfo,
  ToolDef,
} from '@agentsws/contracts'
import { GatewayError, ProviderError } from '../types.js'
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
}

type WireBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string }

interface WireMessage {
  role: 'user' | 'assistant'
  content: WireBlock[]
}

interface WireResponse {
  content?: (
    | { type: 'text'; text?: string }
    | { type: 'thinking'; thinking?: string }
    | { type: 'tool_use'; id?: string; name?: string; input?: unknown }
    | { type: string }
  )[]
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number
  }
}

const textOf = (content: string | ChatContentPart[]): string =>
  typeof content === 'string'
    ? content
    : content
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map((p) => p.text)
        .join('\n')

const blocksOf = (content: string | ChatContentPart[]): WireBlock[] =>
  typeof content === 'string'
    ? content === ''
      ? []
      : [{ type: 'text', text: content }]
    : content.map((part) =>
        part.type === 'text'
          ? { type: 'text', text: part.text }
          : { type: 'image', source: { type: 'base64', media_type: part.mime, data: part.data } },
      )

/**
 * 我们的对话 → Messages 形状。
 *
 * - `system` 抽出来拼成顶层 `system`；
 * - `tool` 结果变成 user 消息里的 `tool_result` 块；
 * - 助手的工具调用变成 `tool_use` 块（工具名同 OpenAI 那边一样换成合规名）；
 * - 相邻同角色合并（Messages 要求 user / assistant 交替）。
 *
 * 上一轮的推理（`reasoning`）**不带回**：Messages 的 thinking 块要带签名，我们手里没有；
 * 这一条没法离线核，写进了报告的「未核」。
 */
export function toMessagesRequest(messages: readonly ChatMessage[]): {
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
      push('user', [
        { type: 'tool_result', tool_use_id: m.tool_call_id ?? '', content: textOf(m.content) },
      ])
      continue
    }
    if (m.role === 'assistant') {
      push('assistant', [
        ...blocksOf(m.content),
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
    push('user', blocksOf(m.content))
  }
  return { ...(system.length === 0 ? {} : { system: system.join('\n\n') }), messages: out }
}

const toWireTool = (t: ToolDef): Record<string, unknown> => ({
  name: wireToolName(t.name),
  description: t.description,
  input_schema: t.input_schema,
})

export function deepseekAccountProvider(options: DeepSeekAccountProviderOptions): ModelProvider {
  const base = (options.baseUrl ?? DEEPSEEK_ACCOUNT_BASE_URL).replace(/\/+$/, '')
  const root = new URL(base).pathname.endsWith('/v1') ? base : `${base}/v1`
  const url = `${root}/messages`
  const model = options.model ?? DEEPSEEK_ACCOUNT_DEFAULT_MODEL
  const doFetch: AccountFetch = options.fetch ?? (globalThis.fetch as unknown as AccountFetch)
  const ref: ModelRef = { provider: options.provider ?? 'deepseek-account', model, region: 'cn' }

  const provider: ModelProvider = {
    ref,
    ...(options.capabilities === undefined ? {} : { capabilities: { ...options.capabilities } }),
    async listModels(): Promise<ProviderModelInfo[]> {
      // 官方目录是写在官方包里的建议性清单，不是上游报的；不为它发请求
      return DEEPSEEK_ACCOUNT_MODELS.map((m) => ({ id: m.id, owned_by: 'deepseek' }))
    },
    async complete(req) {
      const names = new Map((req.tools ?? []).map((t) => [wireToolName(t.name), t.name]))
      const wire = toMessagesRequest(req.messages)
      const body = JSON.stringify({
        model,
        max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
        ...wire,
        ...(req.tools === undefined || req.tools.length === 0
          ? {}
          : { tools: req.tools.map(toWireTool) }),
      })
      // 值只在这一段里活一次：现取 → 进 header → 结束
      const token = await options.resolveToken(url)
      if (token === undefined || token === '') {
        throw new GatewayError('invalid_input', 'deepseek account is not signed in', {
          source: 'deepseek_account',
        })
      }
      const signal =
        options.timeoutMs === undefined ? undefined : AbortSignal.timeout(options.timeoutMs)
      let res: Awaited<ReturnType<AccountFetch>>
      try {
        res = await doFetch(url, {
          method: 'POST',
          redirect: 'error',
          headers: {
            'content-type': 'application/json',
            'anthropic-version': ANTHROPIC_VERSION,
            'x-dsh-auth-token': token,
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
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new ProviderError(`provider http ${res.status}: ${detail.slice(0, 200)}`, {
          status: res.status,
        })
      }
      const json = (await res.json()) as WireResponse
      let text = ''
      let reasoning = ''
      const calls: { id: string; name: string; input: unknown }[] = []
      for (const [i, block] of (json.content ?? []).entries()) {
        if (block.type === 'text') text += (block as { text?: string }).text ?? ''
        else if (block.type === 'thinking')
          reasoning += (block as { thinking?: string }).thinking ?? ''
        else if (block.type === 'tool_use') {
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
        usage: {
          input_tokens: json.usage?.input_tokens ?? 0,
          output_tokens: json.usage?.output_tokens ?? 0,
          cached_tokens: json.usage?.cache_read_input_tokens ?? 0,
          cost_base: 0,
        },
      }
    },
  }
  return provider
}
