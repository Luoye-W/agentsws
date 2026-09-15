/**
 * 49（M2 / M3 / M4 / M6）：服务入口与积分的契约面。
 *
 * 一句话：**用户永远只有一个 agentsws 账号、一个余额；每项增值能力都是同一个开关
 * "用我的 / 用 agentsws 的"。** 用我的 = 本地直连、不经我们、一分不扣；
 * 用 agentsws 的 = 走云上的服务入口，按动作定价、预扣后结算、从余额扣。
 *
 * 三条边界，写在类型里而不是写在注释里：
 *
 * 1. **钱在组织级**（52 §2 O3）。lot 与计量事件都按 `org_id` 存，`workspace_id`
 *    只是一个分组维度——一个账号一个余额，团队版由 owner 一个账号付。
 * 2. **计量事件是白名单**（49 M6）。{@link MeteringEvent} 只有能力、单位、数量、
 *    积分、时间、组织、工作区、请求号八个字段，**绝不含正文、prompt、附件、订单内容**。
 *    {@link METERING_EVENT_FIELDS} 是它的运行时投影，`packages/metering` 用它做断言。
 * 3. **定价表是数据不是代码**（49 §3）。{@link Pricing} 是 `pricing.json` 的形状，
 *    随版本走，界面上一张"价目表"页照它画。
 *
 * 令牌验证的那个类型（`CloudTokenVerifier`）**不在这个文件里**——它属于 WP58
 * 的 `cloud.ts`（云账号 / 隐式组织 / 工作区关联）。两份 WP 并行时各写各的文件，
 * 合并时才在一处 import，避免两个分支改同一个文件。
 */
import type { Iso8601, WorkspaceId } from './common.js'

/* ------------------------------------------------------------------ */
/* M2 每项能力一个开关                                                  */
/* ------------------------------------------------------------------ */

/**
 * 一项能力的来源。默认 `mine`（开源本地优先，40 §1）：
 * 填自己的 key、本地直连、不经我们、不扣积分。
 */
export type CapabilitySource = 'mine' | 'agentsws'

/**
 * 工作区上"每项能力用谁的"。键是能力名（与 {@link PricingEntry.capability} 同一套名字）。
 *
 * **缺键即 `mine`**——这张表只记用户显式改过的那几项，不预先铺满。
 */
export type CapabilitySources = Record<string, CapabilitySource>

/**
 * 工作区的能力来源设置（`GET` / `PUT /v1/settings/capability-sources` 的形状）。
 *
 * 这一版**只有模型那一项真的按开关路由**（走不走 `agentsws_cloud` 这种 provider）；
 * 其余能力只存偏好，等各自的 WP 落地时再接上去。类型上不区分——
 * 区分写在实现里，界面不该因为"这一项还没接"而少一个开关。
 */
export interface CapabilitySourceSettings {
  workspace_id: WorkspaceId
  capability_sources: CapabilitySources
  /** 上次改是什么时候（没改过就没有）。 */
  updated_at?: Iso8601
}

/* ------------------------------------------------------------------ */
/* M4 价目表（数据不是代码）                                            */
/* ------------------------------------------------------------------ */

/**
 * 价目表里的一条：一项能力、一个单位、多少积分。
 *
 * **对用户只显示最终积分价**（49 §3，同旧 SaaS）：成本、倍率、汇率都是算这个数字的
 * 中间量，不进界面。
 */
export interface PricingEntry {
  /** 能力名（`ai.chat` / `data.kol.lookup` / `crawl.page` …）。 */
  capability: string
  /** 单位（`1k_tokens` / `call` / `page` / `minute` / `seat_month`）。 */
  unit: string
  /** 一个单位多少积分。1 积分 = ¥1（Luoye 2026-09-15 定）。 */
  credits_per_unit: number
  label_zh: string
  label_en: string
  /** 按 token 计的那几条：各模型的单价（积分 / 1k token），界面上折叠着看。 */
  models?: PricingModelEntry[]
}

/** 按 token 计价的能力里的一个模型。`in` / `out` 是**积分 / 1k token**。 */
export interface PricingModelEntry {
  model: string
  in: number
  out: number
  /** 缓存命中的输入价；不填按 `in` 算。 */
  cached?: number
  /** 境内可用（数据驻留 `cn` 的请求只允许这些）。 */
  cn?: boolean
}

/**
 * 参考汇率表：各家官网标价的币种 → 人民币。
 *
 * 为什么写死在 json 里而不是去拉实时汇率：**积分价必须是稳定的**。汇率每天动一点，
 * 用户看到的单价就每天动一点，账对不上也说不清。所以它是一张带日期的快照，
 * 改它要出一个版本（和改价一样）。
 */
export type FxTable = Record<string, number>

/** `pricing.json` 的形状（49 §3「定价表是数据不是代码」）。 */
export interface Pricing {
  version: number
  /** 这份价是哪天的。 */
  as_of: Iso8601
  /** 1 积分值多少人民币。**恒为 1**（M4 定案），写出来是为了让换算口径可读。 */
  credit_cny: number
  /** AI 按 token 计价时的倍率（成本 × 倍率）。默认 3。 */
  ai_multiplier: number
  /** 参考汇率（`USD: 7.1` 意为 1 美元折 7.1 元）。 */
  fx: FxTable
  entries: PricingEntry[]
}

/* ------------------------------------------------------------------ */
/* M4 钱包                                                              */
/* ------------------------------------------------------------------ */

/** 两类积分：充值买的永不过期；套餐 / 活动送的按周期清零。 */
export type CreditKind = 'purchased' | 'granted'

/** 一笔积分（一个 lot）。扣费时**先扣有期限的**。 */
export interface WalletLot {
  id: string
  org_id: string
  kind: CreditKind
  /** 当初入账多少。 */
  credits: number
  /** 还剩多少。 */
  remaining: number
  granted_at: Iso8601
  /** `granted` 才有；到点即不可用（不是负债，是清零）。 */
  expires_at?: Iso8601
  /** 充值来的那条：支付渠道的订单号（幂等键）。**不是支付凭据。** */
  source_ref?: string
}

/** 余额（`GET /v1/wallet`）。 */
export interface WalletBalance {
  org_id: string
  /** 永不过期的那部分。 */
  purchased: number
  /** 有期限的那部分（已排除过期的）。 */
  granted: number
  /** 两者之和，减掉预扣中的。 */
  available: number
  /** 正在预扣、还没结算的。 */
  reserved: number
  /** 快到期的（按到期日升序，只列还有剩的）。 */
  expiring: { credits: number; expires_at: Iso8601 }[]
  /** 低于它出一个 `wallet.low_balance` 事件（只事件，不弹窗）。 */
  low_balance_threshold: number
  low_balance: boolean
  at: Iso8601
}

/* ------------------------------------------------------------------ */
/* M6 计量事件（字段白名单）                                            */
/* ------------------------------------------------------------------ */

/**
 * 一条计量事件。**这八个字段就是全部**——49 M6：
 * "不在入口存任何正文、附件、订单内容；计量事件只有能力、单位、数量、积分、时间、工作区"。
 *
 * 加字段要改 {@link METERING_EVENT_FIELDS}，而那张表上挂着一条运行时断言：
 * 多一个键就红。这是"不存正文"这条纪律唯一可执行的形式。
 */
export interface MeteringEvent {
  capability: string
  unit: string
  quantity: number
  credits: number
  at: Iso8601
  /** 钱在组织级（52 §2 O3）。 */
  org_id: string
  /** 只做分组维度，不是账本主体。 */
  workspace_id: WorkspaceId
  /** 这一次调用的请求号（对账用；不是会话 id、不是用户 id）。 */
  request_id: string
}

/** {@link MeteringEvent} 的字段白名单。多一个键就是违反 49 M6。 */
export const METERING_EVENT_FIELDS: readonly (keyof MeteringEvent)[] = [
  'capability',
  'unit',
  'quantity',
  'credits',
  'at',
  'org_id',
  'workspace_id',
  'request_id',
]

/** 用量聚合的分组维度（`GET /v1/wallet/usage?group=…`）。 */
export type UsageGroup = 'capability' | 'workspace' | 'day'

/** 聚合出来的一行。 */
export interface UsageRow {
  /** 分组键：能力名 / 工作区 id / `YYYY-MM-DD`。 */
  key: string
  credits: number
  quantity: number
  calls: number
}

export interface UsageReport {
  group: UsageGroup
  from: Iso8601
  to: Iso8601
  rows: UsageRow[]
  total_credits: number
}

/* ------------------------------------------------------------------ */
/* M4 充值                                                              */
/* ------------------------------------------------------------------ */

/** 支付渠道。这一版只做 Stripe；微信 / 支付宝回 `not_implemented` 人话。 */
export type TopupProvider = 'stripe' | 'wechat' | 'alipay'

/** 一笔充值单。**没有任何支付凭据**——只有去哪儿付的那个链接和订单号。 */
export interface TopupOrder {
  id: string
  org_id: string
  provider: TopupProvider
  credits: number
  /** 折算成人民币多少（1 积分 = ¥1，所以等于 credits）。 */
  amount_cny: number
  /** 去这里付（Stripe Checkout 的 URL）。新窗口打开。 */
  checkout_url?: string
  status: 'created' | 'paid'
  created_at: Iso8601
}

/* ------------------------------------------------------------------ */
/* M5 本地侧要显示的那点东西                                            */
/* ------------------------------------------------------------------ */

/**
 * 设置页"agentsws 云"那张卡要的数字（`GET /v1/cloud/credits`）。
 *
 * 还没关联账号时 `linked: false` + 一句人话，其余字段都没有——
 * 界面据此把按钮变成"先关联账号"，而不是画一堆 0。
 */
export interface CloudCreditsView {
  linked: boolean
  /** 没关联时的人话。 */
  reason?: string
  balance?: WalletBalance
  /** 本月用了多少积分。 */
  month_credits?: number
  /** 这一份是什么时候取的（本地缓存 60 秒）。 */
  fetched_at?: Iso8601
}
