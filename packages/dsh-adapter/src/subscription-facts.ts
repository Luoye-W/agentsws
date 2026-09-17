/**
 * 订阅登录的**纯事实**：开哪两家、各能怎么登、卡上那段风险提示（WP90，55 §9 Q8）。
 *
 * 为什么单独一个文件：`apps/server` 的设置页每次列卡都要这几行字，而
 * `subscription.ts` 一 import 就把整棵 dsh 依赖树拉进模块图——公司档上这一整块
 * 本来就不可用，为了两行文案装一遍 dsh 是纯亏（实测：一次 `import` 约 9 秒）。
 * 所以这里**一个 dsh 依赖都没有**，服务进程静态 import 它，真要登录时才去碰
 * `subscription.ts` 那一半。
 *
 * 两边同一份：`subscription.ts` 原样 re-export 这里的每一个符号。
 */

/**
 * 我们**只开这两个**。
 *
 * `pi-ai` 还带 GitHub Copilot / OpenRouter / Kimi Coding / xAI 的 OAuth，
 * 但 55 §9 的方案只要"用已有的 ChatGPT / Claude 订阅"这一件事；多开一个 provider
 * 就多一份要解释的风险与一条要维护的登录路。名字是 `pi-ai` 自己的 provider id，
 * 也是 `ctx.llm` 的路由名，还是凭据记录 `llm-pi-ai/<id>` 的 id 段——三处同一个串。
 */
export const SUBSCRIPTION_PROVIDERS = ['openai-codex', 'anthropic'] as const

export type SubscriptionProviderId = (typeof SUBSCRIPTION_PROVIDERS)[number]

/** 上游 `dsh-llm-pi-ai` 的记录 owner 段（`auth.ts` 的 `RECORD_SCOPE`）。 */
export const SUBSCRIPTION_RECORD_SCOPE = 'llm-pi-ai'

/** 这个名字是不是我们开的两个订阅 provider 之一。 */
export function isSubscriptionProvider(value: string): value is SubscriptionProviderId {
  return (SUBSCRIPTION_PROVIDERS as readonly string[]).includes(value)
}

/** `RunRequest.runtime.model.provider` → 订阅 provider（不是就 `undefined`）。 */
export function subscriptionProviderOf(provider: string): SubscriptionProviderId | undefined {
  return isSubscriptionProvider(provider) ? provider : undefined
}

/**
 * 一张卡上给人看的话（服务端与设置页共用这一份，不在前端重写一遍）。
 *
 * `methods` 是**实测**出来的，不是抄文档：`pi-ai` 的 `openai-codex` 在 `login()`
 * 里先问一个 select（`browser` / `device_code`），`anthropic` 直接走浏览器流
 * （只有"贴授权码"这一条后路，没有设备码）。所以两张卡能点的按钮不一样。
 */
export interface SubscriptionProviderFacts {
  id: SubscriptionProviderId
  /** 卡名（中文，白话）。 */
  label: string
  /** 一句话说明。 */
  summary: string
  /** 这家能用哪几种登录方式，最推荐的在前。 */
  methods: readonly SubscriptionLoginMethod[]
  /** 官方说明页（人去看的，不是我们调的）。 */
  url: string
}

/** 登录方式：设备码（在别的设备上输一串码）或浏览器（本机回调 `localhost:1455`）。 */
export type SubscriptionLoginMethod = 'device' | 'browser'

/**
 * 两张卡的固定文案。**风险那一段是硬编码的**，不允许按档位变来变去——
 * 它是 55 §9 事实表里那一行的白话版。
 */
export const SUBSCRIPTION_RISK_NOTE =
  '第三方工具用订阅登录没有得到 OpenAI / Anthropic 的明文授权，可能被限流或封禁；' +
  '账号只属于你本人，不要在公司共用的机器上登录。'

export const SUBSCRIPTION_FACTS: readonly SubscriptionProviderFacts[] = [
  {
    id: 'openai-codex',
    label: '用 ChatGPT 订阅登录（Plus / Pro）',
    summary: '已经在付 ChatGPT 的钱就不用再买 API 额度：登录一次，按订阅额度跑，不按 token 扣钱。',
    // 设备码在前：它不需要本机能开浏览器、也不需要 1455 端口空着
    methods: ['device', 'browser'],
    url: 'https://chatgpt.com',
  },
  {
    id: 'anthropic',
    label: '用 Claude 订阅登录（Pro / Max）',
    summary: '已经在付 Claude 的钱就不用再买 API 额度：登录一次，按订阅额度跑，不按 token 扣钱。',
    // 实测：`pi-ai` 的 anthropic 流没有设备码这一档，只有浏览器 + 贴授权码
    methods: ['browser'],
    url: 'https://claude.ai',
  },
]

export function subscriptionFactsOf(provider: SubscriptionProviderId): SubscriptionProviderFacts {
  const hit = SUBSCRIPTION_FACTS.find((f) => f.id === provider)
  if (hit === undefined) throw new Error(`未知的订阅 provider：${provider}`)
  return hit
}
