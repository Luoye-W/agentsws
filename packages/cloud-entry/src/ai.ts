/**
 * `/v1/ai/*`：OpenAI 兼容口（49 M3）。
 *
 * 为什么是 OpenAI 兼容形态：本地那边**不用改 provider 代码**——
 * `openaiCompatibleProvider` 换个 `base_url` 加一把令牌就完事。New API 在我们后面
 * 做汇聚（几十家模型、格式互转、渠道轮换），但**计费在这一层，不在它里面**
 * （49 §1 理由 2：两本账必然对不上）。
 *
 * 每个请求五步，顺序不能换：
 *
 * 1. 查价目算预扣（按 `max_tokens`，没给按默认估）
 * 2. 余额够才放行（不够回 402 人话，**只拒这一次不冻结**）
 * 3. 数据驻留：`X-Agentsws-Region: cn` 的只允许境内可用的模型，否则 422 人话
 * 4. 转发到上游（内部密钥只从 env 读，**永不出现在响应、日志、计量事件里**）
 * 5. 按响应里的 `usage` 结算 → 记一条计量事件（只有八个字段）
 *
 * 上游出错：**原样透传状态码**（用户看到的是真实原因，不是我们包一层的 502），
 * 预扣整笔释放。流式与非流式都走这一套——流式的 `usage` 在最后一个 chunk 里，
 * 所以出站时替用户带上 `stream_options.include_usage`。
 */

import type { CostTable, WalletReservation } from '@agentsws/metering'
import {
  aiCredits,
  COST_TABLE,
  estimateAiCredits,
  estimateTokens,
  isCnAvailable,
  providerOfModel,
  tokenCostMicros,
  WalletError,
} from '@agentsws/metering'
import type { Context } from 'hono'
import type { EntryDeps, EntryEnv, EntryRoute, FetchLike, RegionMap } from './types.js'
import { EntryError, secretOf } from './types.js'

/** 请求头里的数据驻留（22 §2）。本地侧按工作区的 `data_residency` 填。 */
export const REGION_HEADER = 'X-Agentsws-Region'

interface WireUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
  prompt_cache_hit_tokens?: number
}

interface ChatBody {
  model?: unknown
  messages?: unknown
  stream?: unknown
  max_tokens?: unknown
  max_completion_tokens?: unknown
  stream_options?: unknown
  input?: unknown
}

const asString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const asNumber = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined

/** 估一下这次请求的输入有多少 token（只数长度，不看内容）。 */
export function inputTokensOf(body: ChatBody): number {
  const messages = Array.isArray(body.messages) ? body.messages : []
  let chars = 0
  for (const m of messages) {
    if (typeof m === 'object' && m !== null && 'content' in m) {
      const content = (m as { content: unknown }).content
      if (typeof content === 'string') chars += content.length
      else if (Array.isArray(content)) {
        for (const part of content) {
          if (typeof part === 'object' && part !== null && 'text' in part) {
            const text = (part as { text: unknown }).text
            if (typeof text === 'string') chars += text.length
          }
        }
      }
    }
  }
  return estimateTokens('x'.repeat(chars))
}

/** `input` 是字符串或字符串数组（embeddings）。 */
export function embeddingTokensOf(body: ChatBody): number {
  const input = body.input
  if (typeof input === 'string') return estimateTokens(input)
  if (Array.isArray(input)) {
    return input.reduce<number>(
      (sum, one) => sum + (typeof one === 'string' ? estimateTokens(one) : 0),
      0,
    )
  }
  return 0
}

/**
 * 这个模型在境内能不能用。
 *
 * 先看装配方给的 `region_map`（New API 的渠道现实），没有这一条就退回价目表里的
 * `cn` 标记（`pricing.json` 的 `cn_vendors`）。**两边都说不出来的一律不允许**——
 * 用户选了境内就是选了境内，不猜。
 */
export function cnAllowed(
  model: string,
  region_map: RegionMap | undefined,
  cnByPricing: boolean,
): boolean {
  const listed = region_map?.[model]
  if (listed !== undefined) return listed.includes('cn')
  return cnByPricing
}

function upstreamHeaders(
  deps: EntryDeps,
  extra: Record<string, string> = {},
): Record<string, string> {
  const key = secretOf(deps.upstream.ai.api_key)
  if (key === undefined) {
    throw new EntryError('internal', '云侧没有配上游密钥（环境变量 AGENTSWS_NEWAPI_KEY）')
  }
  // key 在这里第一次也是最后一次被本模块持有：进头，不落变量、不进日志、不进返回值
  return { 'content-type': 'application/json', Authorization: `Bearer ${key}`, ...extra }
}

const fetchOf = (deps: EntryDeps): FetchLike =>
  deps.fetch ?? ((input, init) => globalThis.fetch(input, init))

/** 上游回的错误原样端出去（状态码 + 正文），不包一层。 */
async function passthrough(res: Response): Promise<Response> {
  const text = await res.text()
  return new Response(text === '' ? '{"error":{"message":"upstream error"}}' : text, {
    status: res.status,
    headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' },
  })
}

/** 余额不足翻成 402；其余钱包错误翻成 400。 */
function reserveOrThrow(fn: () => WalletReservation): WalletReservation {
  try {
    return fn()
  } catch (err) {
    if (err instanceof WalletError) {
      throw new EntryError(
        err.code === 'insufficient_credits' ? 'insufficient_credits' : 'invalid_input',
        err.message,
        { details: err.details },
      )
    }
    throw err
  }
}

function usageOf(raw: unknown): WireUsage | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const usage = (raw as { usage?: unknown }).usage
  return typeof usage === 'object' && usage !== null ? (usage as WireUsage) : undefined
}

function tokensOf(
  usage: WireUsage | undefined,
  fallbackInput: number,
): {
  input_tokens: number
  output_tokens: number
  cached_tokens: number
} {
  return {
    input_tokens: usage?.prompt_tokens ?? fallbackInput,
    output_tokens: usage?.completion_tokens ?? 0,
    cached_tokens:
      usage?.prompt_tokens_details?.cached_tokens ?? usage?.prompt_cache_hit_tokens ?? 0,
  }
}

/**
 * 流式响应：边转发边找最后那个 `usage`。
 *
 * 不缓冲整条流（那会把"流式"变成"假流式"），只扫 `data:` 行。流走完（或者断了）
 * 就结算——**断了也结算**：token 已经发给用户了，钱就该收，只是按拿到的那部分算。
 */
function meteredStream(
  upstream: ReadableStream<Uint8Array>,
  onUsage: (usage: WireUsage | undefined) => void,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  let tail = ''
  let last: WireUsage | undefined
  let done = false
  const finish = (): void => {
    if (done) return
    done = true
    onUsage(last)
  }
  const scan = (chunk: string): void => {
    tail += chunk
    const lines = tail.split('\n')
    tail = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice('data:'.length).trim()
      if (payload === '' || payload === '[DONE]') continue
      try {
        const found = usageOf(JSON.parse(payload))
        if (found !== undefined) last = found
      } catch {
        // 不是 JSON 的 data 行（心跳、注释）：跳过，不影响转发
      }
    }
  }
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.getReader()
      try {
        for (;;) {
          const { done: finished, value } = await reader.read()
          if (finished) break
          if (value !== undefined) {
            scan(decoder.decode(value, { stream: true }))
            controller.enqueue(value)
          }
        }
        controller.close()
      } catch (err) {
        controller.error(err)
      } finally {
        finish()
      }
    },
    cancel() {
      finish()
    },
  })
}

/** 把出站请求体补上 `stream_options.include_usage`——不补的话流式的 `usage` 根本不回。 */
function withUsageOption(body: ChatBody): Record<string, unknown> {
  const out = { ...(body as Record<string, unknown>) }
  if (body.stream === true) {
    const existing =
      typeof body.stream_options === 'object' && body.stream_options !== null
        ? (body.stream_options as Record<string, unknown>)
        : {}
    out.stream_options = { ...existing, include_usage: true }
  }
  return out
}

async function readJson(c: Context<EntryEnv>): Promise<ChatBody> {
  const text = await c.req.text()
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text) as ChatBody
  } catch {
    throw new EntryError('invalid_input', '请求体不是合法 JSON')
  }
}

function guardResidency(c: Context<EntryEnv>, deps: EntryDeps, model: string): void {
  const region = c.req.header(REGION_HEADER)?.trim().toLowerCase()
  if (region !== 'cn') return
  if (cnAllowed(model, deps.upstream.ai.region_map, isCnAvailable(deps.pricing, model))) return
  throw new EntryError(
    'residency_blocked',
    `这个工作区选了"数据不出境"，而 ${model} 只在境外可用。换一个境内的模型，或者去设置 → 模型里把数据驻留改成"不限"。`,
    { details: { model, region: 'cn' } },
  )
}

/**
 * 这一次调用我们自己花了多少（65 §3）。
 *
 * `costTable: null` = 装配方明说"这个节点不算成本"，于是 `micros` 留空，计量
 * 事件里那一列是 NULL，聚合当 0。**不写 0**：0 与"没算过"在毛利表上是两回事。
 */
function costOf(
  deps: EntryDeps,
  model: string,
  usage: { input_tokens: number; output_tokens: number },
): { micros?: number; currency?: string; provider: string } {
  const table: CostTable | null = deps.costTable === undefined ? COST_TABLE : deps.costTable
  if (table === null) return { provider: providerOfModel(model) }
  const est = tokenCostMicros(model, usage, table)
  return { micros: est.micros, currency: est.currency, provider: est.provider }
}

/** `/v1/ai/chat/completions` 与 `/v1/ai/embeddings` 共用的那一套。 */
async function meteredCall(
  c: Context<EntryEnv>,
  deps: EntryDeps,
  args: {
    path: string
    capability: string
    inputTokens: (body: ChatBody) => number
    allowStream: boolean
  },
): Promise<Response> {
  const principal = c.get('principal')
  const request_id = c.get('request_id')
  const body = await readJson(c)
  const model = asString(body.model)
  if (model === undefined) throw new EntryError('invalid_input', '请求体里缺 model')
  guardResidency(c, deps, model)

  /*
   * WP115（65 §3）：我们自己人的调用免计费。判在**预扣之前**——免了还预扣的话，
   * 余额为 0 的管理员账号会被自己的钱包拦在门外。
   */
  const exempt = deps.isExemptAccount?.(principal.account_id) === true

  const input_tokens = args.inputTokens(body)
  const max_tokens = asNumber(body.max_tokens) ?? asNumber(body.max_completion_tokens)
  const estimate = estimateAiCredits(deps.pricing, model, {
    input_tokens,
    ...(max_tokens === undefined ? {} : { max_tokens }),
  })
  const reservation = reserveOrThrow(() =>
    deps.wallet.reserve({
      org_id: principal.org_id,
      workspace_id: principal.workspace_id,
      capability: args.capability,
      unit: '1k_tokens',
      quantity: input_tokens / 1000,
      // 免计费的那一档预扣 0：它不该因为自己余额为 0 而被拦下
      credits: exempt ? 0 : estimate,
      request_id,
    }),
  )

  const settle = (usage: WireUsage | undefined): void => {
    const t = tokensOf(usage, input_tokens)
    const credits = exempt ? 0 : aiCredits(deps.pricing, model, t)
    /*
     * 我方成本按**成本表**算，与向用户收的积分**各算各的**（65 §3）。
     * 免计费的那一档 `credits = 0` 但**成本照记**——那笔钱我们确实付给了上游，
     * 只是不从用户身上收。
     */
    const cost = costOf(deps, model, t)
    deps.wallet.settle(reservation, {
      quantity: (t.input_tokens + t.output_tokens) / 1000,
      credits,
      provider: cost.provider,
      model,
      input_tokens: t.input_tokens,
      output_tokens: t.output_tokens,
      account_id: principal.account_id,
      charge_status: exempt ? 'admin_exempt' : 'charged',
      ...(cost.micros === undefined
        ? {}
        : { cost_micros: cost.micros, cost_currency: cost.currency }),
    })
  }

  const streaming = args.allowStream && body.stream === true
  let res: Response
  try {
    res = await fetchOf(deps)(`${deps.upstream.ai.base_url}${args.path}`, {
      method: 'POST',
      headers: upstreamHeaders(deps),
      body: JSON.stringify(withUsageOption(body)),
    })
  } catch (err) {
    deps.wallet.release(reservation)
    throw new EntryError('provider_error', '上游暂时连不上，这一次没有扣积分，稍后再试。', {
      details: { cause: err instanceof Error ? err.message : 'unknown' },
    })
  }

  if (!res.ok) {
    // 上游拒了：钱一分不扣，状态码原样端出去
    deps.wallet.release(reservation)
    return passthrough(res)
  }

  if (streaming && res.body !== null) {
    return new Response(meteredStream(res.body, settle), {
      status: 200,
      headers: {
        'content-type': res.headers.get('content-type') ?? 'text/event-stream',
        'cache-control': 'no-cache',
      },
    })
  }

  const json: unknown = await res.json()
  settle(usageOf(json))
  return new Response(JSON.stringify(json), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

export function aiRoutes(deps: EntryDeps): EntryRoute[] {
  return [
    {
      method: 'post',
      path: '/v1/ai/chat/completions',
      auth: 'bearer',
      scope: 'ai',
      summary: 'OpenAI 兼容的对话口（流式与非流式都支持）；按 token 预扣后结算',
      handler: (c) =>
        meteredCall(c, deps, {
          path: '/chat/completions',
          capability: 'ai.chat',
          inputTokens: inputTokensOf,
          allowStream: true,
        }),
    },
    {
      method: 'post',
      path: '/v1/ai/embeddings',
      auth: 'bearer',
      scope: 'ai',
      summary: 'OpenAI 兼容的向量口；按 token 预扣后结算',
      handler: (c) =>
        meteredCall(c, deps, {
          path: '/embeddings',
          capability: 'ai.embeddings',
          inputTokens: embeddingTokensOf,
          allowStream: false,
        }),
    },
    {
      method: 'get',
      path: '/v1/ai/models',
      auth: 'bearer',
      scope: 'ai',
      summary: '这把令牌能用的模型清单；带 X-Agentsws-Region: cn 时只列境内可用的',
      handler: async (c) => {
        // 列清单不扣积分：它不产生任何上游成本，收钱没道理
        const res = await fetchOf(deps)(`${deps.upstream.ai.base_url}/models`, {
          method: 'GET',
          headers: upstreamHeaders(deps),
        })
        if (!res.ok) return passthrough(res)
        const json = (await res.json()) as { data?: { id?: string }[] }
        const region = c.req.header(REGION_HEADER)?.trim().toLowerCase()
        const rows = json.data ?? []
        const filtered =
          region === 'cn'
            ? rows.filter((m) =>
                typeof m.id === 'string'
                  ? cnAllowed(m.id, deps.upstream.ai.region_map, isCnAvailable(deps.pricing, m.id))
                  : false,
              )
            : rows
        return new Response(JSON.stringify({ object: 'list', data: filtered }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      },
    },
  ]
}
