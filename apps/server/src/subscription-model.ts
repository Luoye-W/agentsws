/**
 * WP362（Luoye 10-16，决策 938）：**ChatGPT 订阅进模型网关**——网关上的那一条 provider。
 *
 * 订阅不是一条「存在 models.json 里的来源」：它是这台机器上某个人登录出来的（WP90，按人存在本机加密库），
 * 所以模型面按「这台机器上有没有人登录过」现算出一条虚的来源（id 就是 `openai-codex`，与 dsh 那一层、
 * WP355 自带搜索的名单认的是同一个名字），挂上网关的就是这里造的 provider。
 *
 * - 补全经服务端的订阅登录树（`subscription.ts` → dsh-adapter `subscription-chat.ts` → 官方 pi-ai）；
 *   **令牌不经这个文件**，这里只见到正文、工具调用与 token 数；
 * - 订阅不按 token 收钱：`cost_base` 恒为 0（预算只按 token 判）；
 * - 没跑成分三档说人话：没登录 / 登录过期 → `unauthenticated`（运行收尾时出「重新登录」的连接卡），
 *   限流 → `rate_limited`（同一张卡，说明是额度用满了），别的 → 上游错（网关照常降级）。
 */
import type { ModelProvider } from '@agentsws/contracts'
import type {
  SubscriptionCatalogModel,
  SubscriptionChatRequest,
  SubscriptionChatResult,
} from '@agentsws/dsh-adapter'
import { GatewayError, ProviderError } from '@agentsws/model-gateway'

/** 网关上 / 默认模型里订阅那一条的来源名（`provider_id/model` 的前半）。 */
export const SUBSCRIPTION_SOURCE_ID = 'openai-codex'
/** 界面上的名字。 */
export const SUBSCRIPTION_SOURCE_LABEL = 'ChatGPT 订阅'
/** 订阅目录里的默认模型（与设置页那张卡的默认同一个）。 */
export const SUBSCRIPTION_DEFAULT_MODEL = 'gpt-5.5'

export const SUBSCRIPTION_SIGN_IN_MESSAGE =
  'ChatGPT 订阅还没登录（或已经登出）。在下面的卡上登录一次，就接着做。'
export const SUBSCRIPTION_EXPIRED_MESSAGE =
  'ChatGPT 订阅的登录过期了。在下面的卡上重新登录一次，就接着做。'
export const SUBSCRIPTION_RATE_LIMITED_MESSAGE =
  'ChatGPT 订阅这阵子的额度用满了（被限流）。等一会儿再接着做；急的话在卡上换个账号登录，或者这件事换一个 AI。'

/** 订阅那一半（`subscription.ts` 的子集）。 */
export interface SubscriptionModelPort {
  signedIn(provider: 'openai-codex'): boolean
  /** WP370：目录里每个模型还带能调的思考档与上下文窗口（官方 pi-ai 目录）。 */
  catalog(provider: 'openai-codex'): SubscriptionCatalogModel[]
  complete(
    person_id: string | undefined,
    provider: 'openai-codex',
    request: SubscriptionChatRequest,
  ): Promise<SubscriptionChatResult>
}

/** 订阅那一跳的错 → 网关认的错（只看 `kind`，原句里没有令牌）。 */
export function subscriptionGatewayError(e: unknown): unknown {
  if (!(e instanceof Error)) return e
  if (e.name === 'AbortError') return e
  const kind = (e as { kind?: unknown }).kind
  if (kind === 'sign_in')
    return new GatewayError('unauthenticated', SUBSCRIPTION_SIGN_IN_MESSAGE, {
      subscription: 'sign_in',
    })
  if (kind === 'expired')
    return new GatewayError('unauthenticated', SUBSCRIPTION_EXPIRED_MESSAGE, {
      subscription: 'expired',
    })
  if (kind === 'rate_limited')
    return new GatewayError('rate_limited', SUBSCRIPTION_RATE_LIMITED_MESSAGE, {
      subscription: 'rate_limited',
    })
  const status = (e as { status?: unknown }).status
  return new ProviderError(e.message, typeof status === 'number' ? { status } : {})
}

/** 网关上订阅那一条（一个模型一个实例，与别的来源同一种挂法）。 */
export function subscriptionModelProvider(input: {
  port: SubscriptionModelPort
  model: string
  vision: boolean | undefined
}): ModelProvider {
  const { port, model } = input
  return {
    ref: { provider: SUBSCRIPTION_SOURCE_ID, model, region: 'global' },
    ...(input.vision === undefined
      ? {}
      : { capabilities: { vision: input.vision, image_generation: false } }),
    // Codex 的 Responses 只认 auto / none：强制某个工具做不到，交给网关剥掉
    supports_tool_choice: false,
    async complete(req) {
      try {
        const r = await port.complete(req.meta?.person_id, SUBSCRIPTION_SOURCE_ID, {
          model,
          messages: req.messages,
          ...(req.tools === undefined ? {} : { tools: req.tools }),
          ...(req.tool_choice === undefined ? {} : { tool_choice: req.tool_choice }),
          ...(req.max_output_tokens === undefined
            ? {}
            : { max_output_tokens: req.max_output_tokens }),
          ...(req.thinking === undefined ? {} : { thinking: req.thinking }),
          // WP370：思考程度（pi-ai 按目录映射成订阅认的值）
          ...(req.reasoning_effort === undefined ? {} : { reasoning_effort: req.reasoning_effort }),
          ...(req.on_delta === undefined ? {} : { on_delta: req.on_delta }),
          ...(req.signal === undefined ? {} : { signal: req.signal }),
        })
        return {
          text: r.text,
          ...(r.tool_calls === undefined ? {} : { tool_calls: r.tool_calls }),
          // 订阅：钱在月费里，不在这一次调用里
          usage: { ...r.usage, cost_base: 0 },
        }
      } catch (e) {
        throw subscriptionGatewayError(e)
      }
    },
  }
}
