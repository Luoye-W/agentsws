/**
 * 用 ChatGPT / Claude 的**订阅**登录（WP90，55 §9 Q8）。
 *
 * 一句话：这条路上**一行 OAuth 都不是我们写的**。官方 `@deepseek-ai/dsh-llm-pi-ai`
 * 把 `pi-ai` 的两个订阅 provider（`openai-codex` = ChatGPT Plus / Pro，
 * `anthropic` = Claude Pro / Max）接成 `ctx.llm` 的适配器，登录流由
 * `@deepseek-ai/dsh-authorization` 的 `begin()` 驱动，凭据记录写在 `ctx.credentials`
 * 的 `llm-pi-ai/<provider>` 下——我们只做三件事：
 *
 * 1. **并存**：`agentsws-gateway` 与这两个 provider 名按名字共处一棵树，
 *    `RunRequest.runtime.model.provider` 是哪个就走哪条（{@link subscriptionProviderOf}）。
 * 2. **记账**：订阅不按 token 收钱，所以 `cost_base` 一律记 0、预算只按 token 判；
 *    官方适配器的用量从 `llm/stream` 这道 waterfall 上截下来投影进我们的
 *    `run.completed.usage`（{@link watchSubscriptionCalls}）。
 * 3. **存放**：凭据落在**本机加密秘密库**（20：个人身份类凭据留本机），由
 *    `@agentsws/credentials-openconnector` 的组合 provider 第三条路承载；
 *    这个文件不碰存储，只把 provider 插件原样挂上去。
 *
 * **风险（写在这里，也写在设置页的卡上）**：第三方工具用订阅登录没有得到
 * OpenAI / Anthropic 的明文授权，可能被限流或封禁；账号只属于用户本人，
 * 公司档 / 托管档一律不开（那等于共享账号）。
 */
import type { ChatMessage, Completion, ToolDef } from '@agentsws/contracts'
import { Context } from '@deepseek-ai/cordis'
import type {
  AuthorizationNotice,
  AuthorizationPrompt,
  AuthorizationService,
} from '@deepseek-ai/dsh-authorization'
import Authorization, { AuthorizationDeclinedError } from '@deepseek-ai/dsh-authorization'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { DshAdapterError } from './errors.js'
import type { GatewayBudget } from './llm.js'
import { toChatMessages, toToolDefs } from './llm.js'
import type { SubscriptionLoginMethod, SubscriptionProviderId } from './subscription-facts.js'
import {
  SUBSCRIPTION_PROVIDERS,
  SUBSCRIPTION_RECORD_SCOPE,
  subscriptionFactsOf,
  subscriptionProviderOf,
} from './subscription-facts.js'

/** 这条记录在 `ctx.credentials` 里的地址（owner 段是官方那个 scope）。 */
export function subscriptionRecordKey(provider: SubscriptionProviderId): CredentialKey {
  return credentialKey(SUBSCRIPTION_RECORD_SCOPE, provider)
}

/*
 * 纯事实（开哪两家、能怎么登、风险提示）在 `subscription-facts.ts` 里——那个文件
 * **一个 dsh 依赖都没有**，服务进程为了画两张卡不必装一遍整棵 dsh。这里原样透出去，
 * 调用方不用知道分了两个文件。
 */
export type {
  SubscriptionLoginMethod,
  SubscriptionProviderFacts,
  SubscriptionProviderId,
} from './subscription-facts.js'
export {
  isSubscriptionProvider,
  SUBSCRIPTION_FACTS,
  SUBSCRIPTION_PROVIDERS,
  SUBSCRIPTION_RECORD_SCOPE,
  SUBSCRIPTION_RISK_NOTE,
  subscriptionFactsOf,
  subscriptionProviderOf,
} from './subscription-facts.js'

/**
 * 给 `@deepseek-ai/dsh-llm-pi-ai` 的 `providers` 字典。
 *
 * **两个空 profile 就是全部**：路由键命中 `pi-ai` 装着的 provider 时，端点、协议、
 * 模型目录全部继承它的（上游 config 注释的原话：a route naming an installed pi-ai
 * provider inherits that provider's endpoint, protocol, and model catalog as
 * defaults）。我们一个字段都不覆盖——覆盖了就等于把上游的目录抄了一份到我们仓库里，
 * 下次它改我们不知道。
 *
 * 特别**不给** `apiKeyEnv`：给了就变成"从环境变量拿一把 key"，那是 API 计费那条路；
 * 订阅这条路的凭据是登录产出的 `grant` 记录，由 `pi-ai` 自己从 `ctx.credentials` 读。
 */
export function subscriptionPiAiConfig(): { providers: Record<string, Record<string, never>> } {
  return {
    providers: Object.fromEntries(SUBSCRIPTION_PROVIDERS.map((id) => [id, {}])),
  }
}

/**
 * 把官方 pi-ai 适配器挂上这棵树（`ctx.llm` 上多两个 provider 名，别的什么都不变）。
 *
 * 与 `agentsws-gateway` **按 provider 名并存**：官方 `registerAdapter(providers, …)`
 * 是按名字独占的，两个注册各占各的名字，互不知道对方存在。所以同一次运行里
 * 只会走其中一条——由 `RunRequest.runtime.model.provider` 决定。
 *
 * **动态 import 不是讲究，是必需**：`@deepseek-ai/dsh-llm-pi-ai` 连着整个
 * `@earendil-works/pi-ai`（三十多家 provider 的目录与协议），实测**一次加载 4.3 秒**
 * ——而 `dsh-agent` 才 0.4 秒。写成顶层 import 等于给**每一次** dsh 运行都加上这
 * 四秒多，包括那些从头到尾不碰订阅的。所以只在真要走这条路时才把它拉进模块图
 * （与浏览器、preset 同一条纪律：不用的东西不挂）。
 */
export async function installSubscriptionLlm(root: Context): Promise<void> {
  const PiAiLlm = await import('@deepseek-ai/dsh-llm-pi-ai')
  root.plugin(PiAiLlm as never, subscriptionPiAiConfig() as never)
}

// ── 记账：用量与预算（55 §9「网关只记 token、cost_base 0」）───────────────

export interface SubscriptionCallWatch {
  /** 只管这个 provider 的请求；别人的原样放过去。 */
  provider: SubscriptionProviderId
  /** 每次真的送出去的消息与工具（Model-visible ⟺ logged）。 */
  onRequest?: (request: { messages: ChatMessage[]; tools: ToolDef[] }) => void
  /** 每次补全的用量（`cost_base` 恒为 0）。 */
  onCompletion?: (completion: Completion) => void
  /** 17 §5.3 的预算；订阅路由只按 token 与步数判，没有钱这一维。 */
  budget?: GatewayBudget
  /** 模型名（记进 `Completion.model`）。 */
  model: string
}

/**
 * 在官方适配器**外面**套一圈，把三件我们必须自己管的事补回来。
 *
 * 为什么是 `llm/stream` 这道 waterfall 而不是再包一个 LlmAdapter：`ctx.llm` 的
 * provider 名是独占的，官方插件已经占了这两个名字，再注册一遍会被拒。而
 * `llm/stream` 是上游给的**环绕钩子**（"call `next()` to reach the resolved
 * adapter's stream"），正好在请求进适配器之前、流出来之后各有一刀。
 *
 * 三件事：
 * - **请求要有事件**：17 §2 的 Model-visible ⟺ logged 在这条路上照样成立；
 * - **用量要投影**：官方适配器把 token 放在 `usage` 这种 chunk 里，我们收下来
 *   变成 `Completion`，`cost_base` **恒为 0**（订阅不按 token 收钱，记成别的数字
 *   会让三级预算按一个假账拦人）；
 * - **预算要硬**：dsh 的 loop 自己没有回合预算（官方 README「No built-in turn
 *   budget」），超了就回调宿主并把这一轮干净收掉。
 */
export function watchSubscriptionCalls(ctx: Context, watch: SubscriptionCallWatch): () => void {
  let steps = 0
  const off = ctx.on(
    'llm/stream',
    // biome-ignore lint/complexity/useArrowFunction: waterfall 的 `this` 是 LlmRuntime，箭头函数拿不到
    async function* (
      options: GenerateOptions,
      next: () => AsyncIterable<StreamChunk>,
    ): AsyncIterable<StreamChunk> {
      if (options.provider !== watch.provider) {
        yield* next()
        return
      }
      const budget = watch.budget
      steps += 1
      if (budget !== undefined) {
        if (steps > budget.max_steps) {
          budget.exhausted('max_seconds', steps, budget.max_steps)
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        const spent = budget.spent()
        if (spent > budget.max_tokens) {
          budget.exhausted('max_tokens', spent, budget.max_tokens)
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
      }
      watch.onRequest?.({
        messages: toChatMessages(options),
        tools: toToolDefs(options.tools),
      })
      let text = ''
      let reported = false
      for await (const chunk of next()) {
        if (chunk.type === 'text-delta') text += chunk.text
        if (chunk.type === 'usage') {
          reported = true
          watch.onCompletion?.(subscriptionCompletion(watch, text, chunk.usage))
        }
        yield chunk
      }
      // 适配器一个 token 都没报（上游允许"omit when unavailable"）：
      // 也要有一条补全记录，否则这一步在用量表里凭空消失
      if (!reported) watch.onCompletion?.(subscriptionCompletion(watch, text, undefined))
    } as never,
  )
  return () => {
    off()
  }
}

/** 一次订阅补全的记账形状。**`cost_base` 恒为 0**——这是这条路唯一的计费真相。 */
function subscriptionCompletion(
  watch: SubscriptionCallWatch,
  text: string,
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number } | undefined,
): Completion {
  return {
    text,
    usage: {
      input_tokens: usage?.inputTokens ?? 0,
      output_tokens: usage?.outputTokens ?? 0,
      cached_tokens: usage?.cacheReadTokens ?? 0,
      // 订阅：钱在月费里，不在这一次调用里
      cost_base: 0,
    },
    model: { provider: watch.provider, model: watch.model },
    static_prefix_hash: '',
  }
}

// ── 登录流（55 §9「设置页两张卡」的服务端一半）──────────────────────────

/** 一条登录途中的进展（**永远没有 token**；官方 `AuthorizationNotice` 原样透出）。 */
export interface SubscriptionNotice {
  message: string
  /** 要人去打开的那一页（设备码的验证页，或浏览器流的授权页）。 */
  url?: string
  /** 要人在那一页上输的那串码（设备码流才有）。 */
  code?: string
}

/** 登录途中要人回答的一个问题（贴授权码那一类）。 */
export interface SubscriptionQuestion {
  kind: 'text' | 'secret'
  message: string
  placeholder?: string
}

/** 一条订阅登录现在的样子。**account 是脱敏的，token 一个字节都不在这里。** */
export interface SubscriptionStatus {
  provider: SubscriptionProviderId
  signed_in: boolean
  /** 账号标识脱敏后的样子（`a1b2…f9e8`）；没有就是这家不给账号 id。 */
  account?: string
  /** 这把令牌什么时候过期（ISO8601）。官方会在到期前自己刷新。 */
  expires_at?: string
}

export interface SubscriptionBeginRequest {
  provider: SubscriptionProviderId
  method: SubscriptionLoginMethod
  /** 每来一条进展就回调一次（宿主拿去给界面看）。 */
  notify: (notice: SubscriptionNotice) => void
  /** 要人回答时回调；宿主把问题挂起来等人填，填了 resolve。 */
  ask: (question: SubscriptionQuestion) => Promise<string>
  signal?: AbortSignal
}

export interface SubscriptionLoginHandle {
  /** 现在这条登录什么样（登没登录 / 账号 / 到期）。 */
  status(provider: SubscriptionProviderId): Promise<SubscriptionStatus>
  /** 这家能用哪几个模型（目录来自 `pi-ai`，不是我们抄的清单）。 */
  models(provider: SubscriptionProviderId): Promise<{ id: string; name: string }[]>
  /** 跑一次登录；回来时记录已经落库（官方 `begin()` 自己确认这一点）。 */
  begin(request: SubscriptionBeginRequest): Promise<'authorized' | 'cancelled'>
  /** 中断正在跑的那一次。 */
  cancel(provider: SubscriptionProviderId): void
  /** 登出 = 销毁记录。 */
  signOut(provider: SubscriptionProviderId): Promise<void>
  dispose(): Promise<void>
}

export interface SubscriptionLoginOptions {
  /**
   * 官方 `ctx.credentials` 的 provider **插件**（`@agentsws/credentials-openconnector`
   * 的组合 provider，第三条路指向本机加密秘密库）。
   *
   * 类型故意是 `unknown`：这一层不该知道凭据到底存在哪——与 `DshRuntimeOptions.credentials`
   * 同一条纪律。没有它这棵树连 `authorization` 都起不来（官方 `AuthorizationService`
   * 的 `inject` 就是 `['credentials']`）。
   */
  credentials: unknown
  /** 装配超时（毫秒）。 */
  readyTimeoutMs?: number
}

/** `pi-ai` 的 `openai-codex` 在 select 里用的两个选项 id（实测，见该模块源码）。 */
const PI_AI_METHOD_IDS: Record<SubscriptionLoginMethod, string> = {
  browser: 'browser',
  device: 'device_code',
}

/**
 * 起一棵**只为登录**的最小 dsh 树：`ctx.llm` + `ctx.credentials` + `ctx.authorization`
 * + 官方 pi-ai 插件。没有 Agent、没有 Session、没有工具——登录不需要它们。
 *
 * 为什么是常驻的一棵而不是每次登录起一棵：官方 README 明写"登录只活在发起它的
 * 进程里"（`llm-pi-ai/README.md`），设备码流要在这个进程里轮询到人在别的设备上
 * 点完为止；树一销毁，`registerFlow` 的 disposer 会把这次尝试一起带走。
 */
export async function createSubscriptionLogin(
  options: SubscriptionLoginOptions,
): Promise<SubscriptionLoginHandle> {
  const root = new Context()
  root.plugin(LlmRuntime)
  root.plugin(options.credentials as Parameters<Context['plugin']>[0], undefined as never)
  root.plugin(Authorization)
  await installSubscriptionLlm(root)

  const ctx = await injectReady(
    root,
    ['llm', 'credentials', 'authorization'],
    options.readyTimeoutMs,
  )
  const auth = ctx.authorization as AuthorizationService

  const readPayload = async (
    provider: SubscriptionProviderId,
  ): Promise<Record<string, unknown> | undefined> => {
    const record: CredentialRecord | undefined = await ctx.credentials.readRecord(
      subscriptionRecordKey(provider),
    )
    if (record === undefined || record.kind !== 'grant') return undefined
    const payload = record.payload
    return typeof payload === 'object' && payload !== null
      ? (payload as Record<string, unknown>)
      : {}
  }

  return {
    async status(provider) {
      const payload = await readPayload(provider)
      if (payload === undefined) return { provider, signed_in: false }
      const account = maskAccount(payload.accountId)
      const expires = typeof payload.expires === 'number' ? payload.expires : undefined
      return {
        provider,
        signed_in: true,
        ...(account === undefined ? {} : { account }),
        ...(expires === undefined ? {} : { expires_at: new Date(expires).toISOString() }),
      }
    },

    async models(provider) {
      try {
        const listed = await ctx.llm.listModels(provider)
        return listed.map((m) => ({ id: m.id, name: m.name }))
      } catch {
        // 目录拿不到不是错（离线、上游改了形状）：界面退回手填模型名
        return []
      }
    },

    async begin(request) {
      const facts = subscriptionFactsOf(request.provider)
      if (!facts.methods.includes(request.method)) {
        throw new DshAdapterError(
          'invalid_input',
          `${facts.label}没有「${request.method === 'device' ? '设备码' : '浏览器'}」这种登录方式，` +
            `这家只能用：${facts.methods.map((m) => (m === 'device' ? '设备码' : '浏览器')).join(' / ')}`,
        )
      }
      const wanted = PI_AI_METHOD_IDS[request.method]
      const outcome = await auth.begin({
        key: subscriptionRecordKey(request.provider),
        // 官方给的方法 id 是 `oauth` / `api-key`；设备码与浏览器是 pi-ai 在流**里面**
        // 用一个 select 问的，所以那一问由下面的 `prompt` 代答（见 §说明）
        method: 'oauth',
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        interaction: {
          notify: (notice: AuthorizationNotice) => {
            request.notify({
              message: notice.message,
              ...(notice.url === undefined ? {} : { url: notice.url }),
              ...(notice.code === undefined ? {} : { code: notice.code }),
            })
          },
          prompt: async (prompt: AuthorizationPrompt): Promise<string> => {
            if (prompt.kind === 'select') {
              /*
               * 这一问就是 pi-ai 的「Select OpenAI Codex login method」。人在设置页上
               * 点的是"设备码"还是"浏览器"，答案在 `request.method` 里早就有了——
               * 再弹一次给用户看没有任何意义。**只答它自己列出来的 id**：
               * 上游哪天改了选项，这里当场找不到、如实报错，而不是瞎答一个。
               */
              const hit = prompt.options.find((o) => o.id === wanted)
              if (hit !== undefined) return hit.id
              throw new AuthorizationDeclinedError(
                `这一版 ${facts.label} 没有提供「${request.method === 'device' ? '设备码' : '浏览器'}」这种登录方式`,
              )
            }
            return request.ask({
              kind: prompt.kind === 'secret' ? 'secret' : 'text',
              message: prompt.message,
              ...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }),
            })
          },
        },
      })
      return outcome.status
    },

    cancel(provider) {
      auth.cancel(subscriptionRecordKey(provider))
    },

    async signOut(provider) {
      await ctx.credentials.deleteRecord(subscriptionRecordKey(provider))
    },

    async dispose() {
      await root.fiber.dispose()
    },
  }
}

/**
 * 账号标识脱敏：只留头尾各四位。
 *
 * 为什么留：不留的话，同一台机器上换了个账号登录，界面上看不出任何区别。
 * 为什么只留四位：这是一条能反查到人的标识（ChatGPT 的 account id），
 * 完整回显等于把它抄进了浏览器里、日志里、截图里。
 */
export function maskAccount(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  if (value.length <= 8) return `${value.slice(0, 2)}…`
  return `${value.slice(0, 4)}…${value.slice(-4)}`
}

/** 等一批服务就绪（Cordis 的注入是异步的；与 `harness.ts` 的 `inject` 同一件事）。 */
async function injectReady(root: Context, services: string[], timeoutMs = 5000): Promise<Context> {
  return new Promise<Context>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new DshAdapterError('timeout', `dsh 服务未就绪：${services.join(', ')}`, {
          retryable: true,
        }),
      )
    }, timeoutMs)
    root.plugin({
      name: 'agentsws-subscription-host',
      inject: services,
      apply(ctx: Context) {
        clearTimeout(timer)
        resolve(ctx)
      },
    })
  })
}
