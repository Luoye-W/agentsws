/**
 * WP389（docs/105 §7，Luoye 10-18 定 P1–P10、N1–N5）：**工坊服务**的统一契约——服务目录、订单、
 * 报价、交付凭证、消息、交换联系方式、验收。
 *
 * 「工坊服务」是用户花积分、让别人（工坊团队 / 工坊合作的专业团队）替他做成一件事：下单 → 看进度 →
 * 拿交付 → 验收。它就是一种慢一点、中间可能有人参与的异步任务，所以写法、字段命名都照
 * `data-service.ts`；但状态和钱的走法差太多，单开这一份。
 *
 * 两类服务（docs/105 §3.0）：
 *
 * - **标准件**（`standard`）：交付物固定、不用沟通。一张**价目单**（`menu`）勾几项、各填数量与对象，
 *   一次下单；做完带**凭证**（`proof`）交付；24 小时不点自动通过；没做完的按件自动退。
 * - **定制件**（`custom`）：要沟通。需求单（`requirements`）→ 报价 → 同意报价才付钱 → 做中可以
 *   「等你补材料」、可以经用户同意交换联系方式 → 分阶段（`milestones`）交付，每段单独验收、结算那一段。
 *
 * 钱（docs/105 §3.3）：**下单即扣、进托管**（不是预扣——预扣一小时没结算会被当孤儿扫掉）；验收通过才算
 * 给服务方；没人接 / 超时 → 自动全退；做得不好由运营判全退 / 部分退 / 不退；**原路退**（充值退充值、
 * 赠送退赠送、到期日不变）。积分里单独一块「工坊服务」（`PricingBlock` 的 `workshop_service`），
 * 用量明细每单三行：托管 / 完成 / 退回（{@link SERVICE_LEDGER_CAPABILITIES}）。
 *
 * 对外叫法（P3）：接口里不出现合作方名字——只有 {@link ServiceProviderLabel} 两种说法。
 *
 * **只加不删**（契约纪律）。
 */

import type { Iso8601 } from './common.js'
import type { DataInputField } from './data-service.js'
import { normalizeInputFields } from './data-service.js'

/** 令牌要带的动作集（新开一个，与 `data` / `kol` / `store` 并列）。 */
export const SERVICE_ORDER_SCOPE = 'services' as const

/**
 * 云端路径。`orders` 后面接 `/{id}`、`/{id}/accept-quote`、`/{id}/messages`、`/{id}/contact`、
 * `/{id}/accept`、`/{id}/revise`、`/{id}/dispute`、`/{id}/cancel`。
 */
export const SERVICE_ORDER_CLOUD_PATHS = {
  services: '/v1/services',
  orders: '/v1/services/orders',
  /** P8：「没接住的意向」上报口（只收说法与岗位，不收正文）。 */
  intents: '/v1/services/intents',
} as const

/** 两类服务：标准件 / 定制件。 */
export const SERVICE_KINDS = ['standard', 'custom'] as const
export type ServiceKind = (typeof SERVICE_KINDS)[number]

/** 计价方式：一口价 / 先报价 / 按件（标准件的价目单）。 */
export const SERVICE_PRICING_MODES = ['fixed', 'quote', 'per_unit'] as const
export type ServicePricingMode = (typeof SERVICE_PRICING_MODES)[number]

/** 交付物是什么：文件 / 链接 / 文字 / 「做成了」回执 / 平台里的一个对象（主题副本、帖子）。 */
export const SERVICE_DELIVERABLE_TYPES = [
  'file',
  'link',
  'text',
  'receipt',
  'platform_object',
] as const
export type ServiceDeliverableType = (typeof SERVICE_DELIVERABLE_TYPES)[number]

/**
 * 交付后落到哪（docs/105 §3.5）：主题副本 → 网站运营的发布审批卡；刊发链接 → 发出记录；
 * 稿件 → 草稿审批卡；回执 → 回到卡住的那一步；文件 → 品牌知识库。一期 A 先做 `theme` 与 `resume_step`。
 */
export const SERVICE_LANDINGS = [
  'theme',
  'outbound_record',
  'draft',
  'resume_step',
  'knowledge_file',
] as const
export type ServiceLanding = (typeof SERVICE_LANDINGS)[number]

/** P3：对用户只有这两种说法——工坊团队 / 工坊合作的专业团队。**不出现合作方名字。** */
export const SERVICE_PROVIDER_LABELS = ['workshop_team', 'partner_team'] as const
export type ServiceProviderLabel = (typeof SERVICE_PROVIDER_LABELS)[number]

/** 两种说法的中英文（本机显示用；云上不另给字）。 */
export const SERVICE_PROVIDER_LABEL_TEXT: Readonly<
  Record<ServiceProviderLabel, { zh: string; en: string }>
> = {
  workshop_team: { zh: '工坊团队', en: 'Workshop team' },
  partner_team: { zh: '工坊合作的专业团队', en: 'A Workshop partner team' },
}

/** 默认值（P5 / N2 / N3 / P10；每项服务可以自己改）。 */
export const SERVICE_ORDER_DEFAULTS = {
  /** 下单后多久没人接就全退（小时）。 */
  accept_within_hours: 24,
  /** P5：验收不点几小时自动通过（一般服务 3 天）。 */
  auto_accept_hours: 72,
  /** N3：标准件交付后 24 小时自动通过。 */
  standard_auto_accept_hours: 24,
  /** N2 / P5 建站档：定制件每段 7 天自动通过。 */
  custom_auto_accept_hours: 168,
  /** P5：能返工几次。 */
  revisions: 1,
  /** P10：交付物保留多久（天）；到期前在订单面板提醒一次。 */
  deliverable_retention_days: 90,
} as const

/* ------------------------------------------------------------------ */
/* 服务目录（后台填，改数不改代码；docs/105 §3.1）                        */
/* ------------------------------------------------------------------ */

/**
 * 标准件价目单里的一项（照数据接口的输入白名单写法：`target_fields` 是这一项要填的对象，
 * 不在表里的字段一律丢掉）。
 */
export interface ServiceMenuItem {
  id: string
  label_zh: string
  label_en: string
  /** 单位（「个」「条」「篇」）。 */
  unit_zh: string
  unit_en: string
  /** 每单位多少积分。 */
  credits_per_unit: number
  /** 数量上下限（含）。 */
  min_quantity: number
  max_quantity: number
  /** 这一项要填的对象（比如帖子链接）；空数组 = 不用填。 */
  target_fields: DataInputField[]
}

/** 定制件的一个阶段与它占总价的百分比（各段加起来 = 100）。 */
export interface ServiceMilestone {
  id: string
  label_zh: string
  label_en: string
  /** 占总价多少（1–100 的整数）。 */
  share_percent: number
}

/** 需求单里的一个问题（AI 在对话里替服务方问，问完生成需求单）。 */
export interface ServiceQuestion {
  id: string
  label_zh: string
  label_en: string
  required?: boolean
  /** 给 AI 的一句提示（怎么问、举个例子）；不给用户看。 */
  hint_zh?: string
  /** 只认这几个答案（不给 = 随便写）。 */
  options?: string[]
  /** 答案最长多少字（缺省 2000）。 */
  max?: number
}

/** 承诺时长（小时）。 */
export interface ServicePromise {
  /** 下单后多久内接单（超了全退）。 */
  accept_hours: number
  /** 先报价的服务：多久内报价。 */
  quote_hours?: number
  /** 接单后多久内交付（定制件按报价单，这里是没报价时的参考；超了没交付的部分全退）。 */
  deliver_hours?: number
}

/** `GET /v1/services` 里的一项服务。 */
export interface ServiceView {
  id: string
  kind: ServiceKind
  label_zh: string
  label_en: string
  /** 一句话说明。 */
  summary_zh: string
  summary_en: string
  pricing_mode: ServicePricingMode
  /** 一口价（`fixed`）。 */
  price_credits?: number
  /** 先报价的服务给一个「起价 X 积分」参考（`quote`）。 */
  from_credits?: number
  /** 标准件的价目单（`kind: standard` 才有）。 */
  menu?: ServiceMenuItem[]
  /** 定制件分几段交付（`kind: custom` 才有；不给 = 一段交付）。 */
  milestones?: ServiceMilestone[]
  promise: ServicePromise
  /** 能返工几次（P5 默认 1）。 */
  revisions: number
  /** 交付后几小时不点自动通过（标准件默认 24、定制件每段默认 168、其余 72）。 */
  auto_accept_hours: number
  /** 下单前要问清的东西（定制件；标准件空数组）。 */
  questions: ServiceQuestion[]
  deliverables: ServiceDeliverableType[]
  landing: ServiceLanding
  /** 关联岗位（岗位页「这个岗位能用的服务」按它列）。 */
  positions: string[]
  /** 意向说法（「想找人建站」……；`find_service` 按它匹配）。 */
  intents: string[]
  /** 关联的卡点（「品牌没有独立站」……；「缺设置」卡上「交给工坊办」按它挂）。 */
  blockers?: string[]
  provider_label: ServiceProviderLabel
  /** 现在能不能下单（上架了、有人接）。 */
  available: boolean
  /** 不能下单时一句人话。 */
  reason?: string
}

export interface ServiceList {
  services: ServiceView[]
  at: Iso8601
}

/* ------------------------------------------------------------------ */
/* 订单状态与转移表（docs/105 §3.2；手写，不引状态机库——§8 查过）          */
/* ------------------------------------------------------------------ */

/**
 * 订单状态。`draft` 是本机那份需求单（还没交给云上）——云上不会出现，留在这里让两边说同一套话。
 */
export const SERVICE_ORDER_STATUSES = [
  'draft',
  'quote_requested',
  'quoted',
  'paid',
  'in_progress',
  'waiting_user',
  'delivered',
  'disputed',
  'completed',
  'refunded',
  'cancelled',
  'expired',
] as const
export type ServiceOrderStatus = (typeof SERVICE_ORDER_STATUSES)[number]

/** 走到这几个状态就不会再变了（钱也都落定了：托管 = 已结算 + 已退回）。 */
export const SERVICE_ORDER_TERMINAL_STATUSES: readonly ServiceOrderStatus[] = [
  'completed',
  'refunded',
  'cancelled',
  'expired',
]

/** 谁能推这一步（Sharetribe「交易流程 = 一串转移 + 每一步谁能触发」的画法）。 */
export type ServiceOrderActor = 'user' | 'provider' | 'operator' | 'system'

/** 订单上能做的动作。 */
export const SERVICE_ORDER_ACTIONS = [
  /** 一口价 / 标准件：下单即付（扣进托管）。 */
  'pay',
  /** 先报价：交需求单，等报价（不扣钱）。 */
  'request_quote',
  /** 服务方报价（已报价时可以改报）。 */
  'quote',
  /** 用户同意报价并支付（扣进托管）。 */
  'accept_quote',
  /** 服务方接单。 */
  'take',
  /** 服务方说「在等你补材料」（等用户时不计超时）。 */
  'ask_user',
  /** 用户补了材料 / 回了话。 */
  'user_reply',
  /** 交付（标准件带凭证；定制件交付当前这一段）。 */
  'deliver',
  /** 验收通过（定制件还有下一段就回到做中）。 */
  'accept',
  /** 到期自动通过。 */
  'auto_accept',
  /** 要改（返工次数用完就不能再要）。 */
  'revise',
  /** 申请退款（交给运营判）。 */
  'dispute',
  /** 运营判：全退 / 部分退 / 不退。 */
  'resolve',
  /** 用户取消（接单之前）。 */
  'cancel',
  /** 没人接 / 没报价 / 超时没交付：自动收尾，没结算的全退。 */
  'expire',
] as const
export type ServiceOrderAction = (typeof SERVICE_ORDER_ACTIONS)[number]

export interface ServiceOrderTransition {
  from: ServiceOrderStatus
  action: ServiceOrderAction
  /** 可能去的状态（`accept` 有两个：还有下一段回做中，否则完成）。 */
  to: readonly ServiceOrderStatus[]
  by: readonly ServiceOrderActor[]
}

const STAFF: readonly ServiceOrderActor[] = ['provider', 'operator']

/** 转移表：表里没有的一律不许（云上按它判，本机按它决定显示哪几个钮）。 */
export const SERVICE_ORDER_TRANSITIONS: readonly ServiceOrderTransition[] = [
  { from: 'draft', action: 'pay', to: ['paid'], by: ['user'] },
  { from: 'draft', action: 'request_quote', to: ['quote_requested'], by: ['user'] },
  { from: 'quote_requested', action: 'quote', to: ['quoted'], by: STAFF },
  { from: 'quote_requested', action: 'cancel', to: ['cancelled'], by: ['user', 'operator'] },
  { from: 'quote_requested', action: 'expire', to: ['expired'], by: ['system'] },
  { from: 'quoted', action: 'quote', to: ['quoted'], by: STAFF },
  { from: 'quoted', action: 'accept_quote', to: ['paid'], by: ['user'] },
  { from: 'quoted', action: 'cancel', to: ['cancelled'], by: ['user', 'operator'] },
  { from: 'paid', action: 'take', to: ['in_progress'], by: STAFF },
  { from: 'paid', action: 'cancel', to: ['cancelled'], by: ['user', 'operator'] },
  { from: 'paid', action: 'expire', to: ['expired'], by: ['system'] },
  { from: 'in_progress', action: 'ask_user', to: ['waiting_user'], by: STAFF },
  { from: 'in_progress', action: 'deliver', to: ['delivered'], by: STAFF },
  { from: 'in_progress', action: 'expire', to: ['expired'], by: ['system'] },
  { from: 'waiting_user', action: 'user_reply', to: ['in_progress'], by: ['user'] },
  // 运营代用户确认「材料收到了」（用户在微信里发过来的）
  { from: 'waiting_user', action: 'take', to: ['in_progress'], by: STAFF },
  { from: 'delivered', action: 'accept', to: ['in_progress', 'completed'], by: ['user'] },
  { from: 'delivered', action: 'auto_accept', to: ['in_progress', 'completed'], by: ['system'] },
  { from: 'delivered', action: 'revise', to: ['in_progress'], by: ['user'] },
  { from: 'delivered', action: 'dispute', to: ['disputed'], by: ['user'] },
  { from: 'disputed', action: 'resolve', to: ['completed', 'refunded'], by: ['operator'] },
]

/** 这一步能不能走：能走回那条转移，不能回 `undefined`。 */
export function serviceOrderTransition(
  from: ServiceOrderStatus,
  action: ServiceOrderAction,
  by: ServiceOrderActor,
): ServiceOrderTransition | undefined {
  return SERVICE_ORDER_TRANSITIONS.find(
    (t) => t.from === from && t.action === action && t.by.includes(by),
  )
}

/** 这个状态下这个人能做哪几件事（本机按它决定卡上出哪几个钮）。 */
export function serviceOrderActions(
  status: ServiceOrderStatus,
  by: ServiceOrderActor,
): ServiceOrderAction[] {
  return SERVICE_ORDER_TRANSITIONS.filter((t) => t.from === status && t.by.includes(by)).map(
    (t) => t.action,
  )
}

/** 这几个状态在等用户：「超时没交付」那只钟停着（验收自动通过那只钟照走）。 */
export const SERVICE_ORDER_WAITING_USER_STATUSES: readonly ServiceOrderStatus[] = [
  'quoted',
  'waiting_user',
  'delivered',
]

/* ------------------------------------------------------------------ */
/* 下单、报价、凭证、消息、联系方式、验收                                  */
/* ------------------------------------------------------------------ */

/** 标准件价目单上勾的一行。 */
export interface ServiceOrderLine {
  /** 价目单里那一项的 id。 */
  item_id: string
  quantity: number
  /** 这一项要填的对象（按 `target_fields` 白名单；多给的丢掉）。 */
  target?: Record<string, unknown>
}

/** 需求单里一个问题的答案。 */
export interface ServiceRequirementAnswer {
  question_id: string
  answer: string
}

/** `POST /v1/services/orders` 的请求。 */
export interface ServiceOrderSubmit {
  service_id: string
  /** 标准件：勾的那几行（N4：一张价目单能勾多项、一次下单）。 */
  lines?: ServiceOrderLine[]
  /** 定制件：需求单。 */
  requirements?: ServiceRequirementAnswer[]
  /**
   * 幂等键（1–128 个字符）：同一个组织同一个键只建一单、只扣一次——下单卡点两次、网络抖了重发，
   * 拿回的都是同一单。
   */
  idempotency_key: string
}

/** 服务方的报价（运营代回填）。 */
export interface ServiceQuote {
  credits: number
  /** 接单后多久交付（小时）。 */
  deliver_hours: number
  /** 这一单的分段（不给按服务的默认分段）。 */
  milestones?: ServiceMilestone[]
  /** 一句话说明报价包含什么。 */
  note?: string
  quoted_at: Iso8601
}

/** `POST /v1/services/orders/{id}/accept-quote` 的请求（同一个键只扣一次）。 */
export interface ServiceQuoteAcceptRequest {
  idempotency_key: string
}

/** 标准件交付的凭证：链接、截图、每一项实际完成多少。 */
export interface ServiceDeliveryProof {
  links: string[]
  /** 截图地址（存在云上，带过期时刻）。 */
  screenshots: string[]
  /** 每一项实际完成了多少（少于下单数量的那部分按件自动退）。 */
  completed: { item_id: string; quantity: number }[]
  note?: string
}

/** 一件交付物。 */
export interface ServiceDeliverable {
  type: ServiceDeliverableType
  label: string
  url?: string
  text?: string
  /** 平台里那个对象的 id（主题副本 id……）。 */
  ref?: string
  /** 定制件：属于哪一段。 */
  milestone_id?: string
  delivered_at: Iso8601
}

/** 一条消息（只有定制件有消息串；标准件不出消息、不出联系方式）。 */
export interface ServiceOrderMessage {
  id: string
  from: 'user' | 'provider' | 'system'
  /**
   * `text` 普通一句；`need_input` 服务方要你补材料；`meeting_note` 会上定了什么（要你确认）；
   * `status` 系统记一笔（接单了、交付了、退了多少）。
   */
  kind: 'text' | 'need_input' | 'meeting_note' | 'status'
  text: string
  at: Iso8601
}

/** `POST /v1/services/orders/{id}/messages` 的请求（用户说话；在「等你补材料」时说话 = 补上了）。 */
export interface ServiceOrderMessagePost {
  text: string
}

export interface ServiceOrderMessages {
  order_id: string
  messages: ServiceOrderMessage[]
}

/** 联系方式的种类（用户自己选给哪一种，N1）。 */
export type ServiceContactKind = 'wechat' | 'phone' | 'email'

export interface ServiceContact {
  kind: ServiceContactKind
  value: string
}

/**
 * 交换联系方式（N1）：服务方发请求 → 用户点同意才把**他自己填的**那一种给这一单的服务方；
 * 对方的联系方式同时给到用户。只对这一单有效，订单结束后不再返回。
 */
export interface ServiceContactExchange {
  id: string
  /** 服务方为什么要（「约个时间过一下设计稿」）。 */
  reason: string
  status: 'pending' | 'accepted' | 'declined'
  requested_at: Iso8601
  answered_at?: Iso8601
  /** 同意之后才有，订单结束后不再返回。 */
  provider_contact?: ServiceContact
  /** 用户给出去的那一种（同上）。 */
  user_contact?: ServiceContact
}

/** `POST /v1/services/orders/{id}/contact` 的请求：同意（带上自己选的那一种）或拒绝。 */
export interface ServiceContactAnswer {
  request_id: string
  accept: boolean
  contact?: ServiceContact
}

/** `…/accept`、`…/revise`、`…/dispute` 的请求。 */
export interface ServiceAcceptanceRequest {
  /** 定制件：验的是哪一段（不给 = 当前在验的那一段）。 */
  milestone_id?: string
  /** 要改 / 申请退款时说一句为什么（申请退款必填）。 */
  reason?: string
}

/** `POST /v1/services/orders/{id}/cancel` 的请求（接单之前才能取消；已付的全退）。 */
export interface ServiceOrderCancelRequest {
  reason?: string
}

/** 一次验收（通过 / 要改 / 申请退款 + 理由）。 */
export interface ServiceAcceptance {
  decision: 'accept' | 'revise' | 'dispute'
  /** 到期自动通过时是 `system`。 */
  by: 'user' | 'system'
  milestone_id?: string
  reason?: string
  at: Iso8601
}

/** 争议与运营的判定（P6：用户看得到一句理由）。 */
export interface ServiceDispute {
  reason: string
  opened_at: Iso8601
  resolution?: 'full_refund' | 'partial_refund' | 'no_refund'
  /** 这次判退了多少。 */
  refund_credits?: number
  /** 运营写给用户的一句理由。 */
  note?: string
  resolved_at?: Iso8601
}

/** 订单里价目单的一行（下单时的价、实际完成多少）。 */
export interface ServiceOrderLineView extends ServiceOrderLine {
  label_zh: string
  label_en: string
  credits_per_unit: number
  /** 这一行一共多少积分。 */
  credits: number
  /** 实际完成多少（交付之后才有）。 */
  completed?: number
}

/** 定制件一段的状态。 */
export interface ServiceMilestoneView extends ServiceMilestone {
  /** 这一段多少积分（总价 × 占比，零头算进最后一段）。 */
  credits: number
  status: 'pending' | 'in_progress' | 'delivered' | 'accepted' | 'refunded'
  delivered_at?: Iso8601
  accepted_at?: Iso8601
  /** 交付了还没点：到这一刻自动通过。 */
  auto_accept_at?: Iso8601
}

/** 一张订单的样子（`GET /v1/services/orders/{id}`）。 */
export interface ServiceOrderView {
  id: string
  service_id: string
  kind: ServiceKind
  label_zh: string
  label_en: string
  status: ServiceOrderStatus
  provider_label: ServiceProviderLabel
  lines?: ServiceOrderLineView[]
  requirements?: ServiceRequirementAnswer[]
  quote?: ServiceQuote
  milestones?: ServiceMilestoneView[]
  /** 这一单一共多少积分（先报价的在报价之前没有）。 */
  total_credits?: number
  /** 托管着多少（扣进来还没结算、也没退的）。 */
  escrow_credits: number
  /** 已经结算给服务方的（实扣）。 */
  settled_credits: number
  /** 退回了多少。 */
  refunded_credits: number
  /** 在等你什么（「上传 Logo 原图」）。 */
  waiting_for?: string
  /** 还能返工几次。 */
  revisions_left: number
  /** 到这一刻还没人接 / 没报价就自动收尾（全退）。 */
  respond_by?: Iso8601
  /** 预计交付（超了没交付的部分全退；等你的时候往后顺延）。 */
  deliver_by?: Iso8601
  /** 交付了还没点：到这一刻自动通过。 */
  auto_accept_at?: Iso8601
  deliverables: ServiceDeliverable[]
  /** 交付物保留到什么时候（P10：90 天）。 */
  deliverables_expire_at?: Iso8601
  proof?: ServiceDeliveryProof
  acceptances: ServiceAcceptance[]
  dispute?: ServiceDispute
  /** 定制件：交换联系方式的请求（订单结束后联系方式不再返回）。 */
  contact?: ServiceContactExchange
  /** 消息条数（定制件；取消息走 `…/messages`）。 */
  message_count: number
  /** 下一步你能做的（按转移表算好给的）。 */
  actions: ServiceOrderAction[]
  created_at: Iso8601
  updated_at: Iso8601
  finished_at?: Iso8601
}

/** `GET /v1/services/orders` 的查询参数。 */
export interface ServiceOrderListQuery {
  /** `open` 只要没结束的（默认）、`all` 全部（最近 100 单）。 */
  status?: 'open' | 'all'
}

export interface ServiceOrderList {
  orders: ServiceOrderView[]
  at: Iso8601
}

/** `/v1/services/orders/{id}*` 的路径参数。 */
export interface ServiceOrderParams {
  id: string
}

/**
 * P8：「没接住的意向」——用户说出了意向但目录里没有对应的服务。**只收说法与岗位，不收正文**
 * （`phrase` 是 AI 归纳出来的一句意向说法，不是用户原话；≤ 200 字）。
 */
export interface ServiceIntentReport {
  phrase: string
  position_id?: string
}

/* ------------------------------------------------------------------ */
/* 用量明细（积分里「工坊服务」那一块，每单三行）                          */
/* ------------------------------------------------------------------ */

/**
 * 计量事件的能力名：托管（扣进来，正数）/ 完成（结算给服务方，积分记 0、数量 = 结算了多少积分）/
 * 退回（负数）。三行加起来 = 这一单实际花掉的。前缀 `workshop.service.` 归「工坊服务」那一块。
 */
export const SERVICE_LEDGER_CAPABILITIES = {
  escrow: 'workshop.service.escrow',
  complete: 'workshop.service.complete',
  refund: 'workshop.service.refund',
} as const

/** 「工坊服务」那一块的能力名前缀。 */
export const SERVICE_LEDGER_PREFIX = 'workshop.service.'

/* ------------------------------------------------------------------ */
/* 两边共用的校验与算钱                                                  */
/* ------------------------------------------------------------------ */

const round4 = (n: number): number => Math.round(n * 10_000) / 10_000

export type ServiceLinesCheck =
  | { ok: true; lines: ServiceOrderLineView[]; total_credits: number }
  | { ok: false; field?: string; message: string }

/**
 * 标准件：按价目单校验勾的那几行，算好每行与合计。同一项勾两次合成一行不许（说清楚哪一项）；
 * 数量要在上下限里；对象按 `target_fields` 白名单规范化。云上与本机用同一个函数，话一样。
 */
export function normalizeServiceLines(service: ServiceView, raw: unknown): ServiceLinesCheck {
  if (service.kind !== 'standard' || service.menu === undefined)
    return { ok: false, message: '这项服务不是按价目单下单的。' }
  if (!Array.isArray(raw) || raw.length === 0)
    return { ok: false, field: 'lines', message: '价目单上至少勾一项。' }
  const seen = new Set<string>()
  const out: ServiceOrderLineView[] = []
  for (const row of raw as unknown[]) {
    const r = typeof row === 'object' && row !== null ? (row as Record<string, unknown>) : {}
    const item = service.menu.find((m) => m.id === r.item_id)
    if (item === undefined) return { ok: false, field: 'lines', message: '价目单上没有这一项。' }
    if (seen.has(item.id))
      return {
        ok: false,
        field: 'lines',
        message: `「${item.label_zh}」勾了两次，合成一行再下单。`,
      }
    seen.add(item.id)
    const q = typeof r.quantity === 'number' ? r.quantity : Number(r.quantity)
    if (!Number.isInteger(q) || q < item.min_quantity || q > item.max_quantity)
      return {
        ok: false,
        field: 'lines',
        message: `「${item.label_zh}」的数量要在 ${String(item.min_quantity)}–${String(item.max_quantity)} 之间。`,
      }
    const target = normalizeInputFields(item.target_fields, r.target)
    if (!target.ok)
      return { ok: false, field: 'lines', message: `「${item.label_zh}」：${target.message}` }
    out.push({
      item_id: item.id,
      quantity: q,
      ...(item.target_fields.length === 0 ? {} : { target: target.input }),
      label_zh: item.label_zh,
      label_en: item.label_en,
      credits_per_unit: item.credits_per_unit,
      credits: round4(item.credits_per_unit * q),
    })
  }
  return { ok: true, lines: out, total_credits: round4(out.reduce((s, l) => s + l.credits, 0)) }
}

export type ServiceRequirementsCheck =
  | { ok: true; requirements: ServiceRequirementAnswer[] }
  | { ok: false; field?: string; message: string }

/** 定制件：需求单按问题清单校验（必答的要答、选项题只认选项、太长的拒）。多答的丢掉。 */
export function normalizeServiceRequirements(
  service: ServiceView,
  raw: unknown,
): ServiceRequirementsCheck {
  const list = Array.isArray(raw) ? (raw as unknown[]) : []
  const byId = new Map<string, string>()
  for (const row of list) {
    const r = typeof row === 'object' && row !== null ? (row as Record<string, unknown>) : {}
    if (typeof r.question_id === 'string' && typeof r.answer === 'string')
      byId.set(r.question_id, r.answer.trim())
  }
  const out: ServiceRequirementAnswer[] = []
  for (const q of service.questions) {
    const answer = byId.get(q.id) ?? ''
    if (answer === '') {
      if (q.required === true)
        return { ok: false, field: 'requirements', message: `需求单缺「${q.label_zh}」。` }
      continue
    }
    if (answer.length > (q.max ?? 2000))
      return { ok: false, field: 'requirements', message: `「${q.label_zh}」写得太长了。` }
    if (q.options !== undefined && !q.options.includes(answer))
      return {
        ok: false,
        field: 'requirements',
        message: `「${q.label_zh}」只能是 ${q.options.join(' / ')}。`,
      }
    out.push({ question_id: q.id, answer })
  }
  return { ok: true, requirements: out }
}

/** 分段占比合不合法：每段 1–100 的整数、id 不重复、加起来正好 100。 */
export function serviceMilestonesOk(milestones: readonly ServiceMilestone[]): boolean {
  if (milestones.length === 0) return false
  const ids = new Set(milestones.map((m) => m.id))
  if (ids.size !== milestones.length) return false
  if (!milestones.every((m) => Number.isInteger(m.share_percent) && m.share_percent >= 1))
    return false
  return milestones.reduce((s, m) => s + m.share_percent, 0) === 100
}

/** 总价按占比拆到每一段（四位小数；零头算进最后一段，于是各段加起来正好等于总价）。 */
export function serviceMilestoneCredits(
  total: number,
  milestones: readonly ServiceMilestone[],
): number[] {
  const out = milestones.map((m) => round4((total * m.share_percent) / 100))
  if (out.length > 0) {
    const head = out.slice(0, -1).reduce((s, n) => s + n, 0)
    out[out.length - 1] = round4(total - head)
  }
  return out
}

/* ================================================================== */
/* 本机那一半（WP390，docs/105 §4 / §5 / §7）                           */
/* ================================================================== */

/** 用户说「不用」之后，这项服务在这个品牌上多少天不主动推（P7）。 */
export const SERVICE_RECOMMEND_QUIET_DAYS = 30

/** 岗位页「这个岗位能用的服务」最多列几项（§4.1 ③）。 */
export const SERVICE_POSITION_LIMIT = 3

/** 交付物到期前几天在订单面板提醒（P10：提醒一次）。 */
export const SERVICE_EXPIRY_NOTICE_DAYS = 7

/**
 * 一项服务的「起价」：一口价 → 那个价；先报价 → 起价参考；价目单 → 最便宜那一项按最少数量算。
 * 推荐卡与列表上那一个数（「起价 800 积分」）。算不出回 `undefined`（卡上就不写价）。
 */
export function serviceStartCredits(s: ServiceView): number | undefined {
  if (s.pricing_mode === 'fixed' && s.price_credits !== undefined) return s.price_credits
  if (s.from_credits !== undefined) return s.from_credits
  if (s.price_credits !== undefined) return s.price_credits
  const menu = s.menu ?? []
  if (menu.length === 0) return undefined
  return Math.min(...menu.map((m) => round4(m.credits_per_unit * Math.max(1, m.min_quantity))))
}

/** 一段话里的字与相邻两字（试匹配用；与后台「输几句话试匹配」同一套口径）。 */
function grams(s: string): Set<string> {
  const chars = Array.from(s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ''))
  const out = new Set<string>(chars)
  for (let i = 0; i + 1 < chars.length; i++) out.add(`${chars[i]}${chars[i + 1]}`)
  return out
}

/**
 * 一句意向说法和用户的话有多像（0–1）：说法被整句包含 = 1；否则看说法里的字 / 相邻两字有多少出现在话里。
 * 与 WP389 后台的「试匹配」同一套（过 {@link SERVICE_MATCH_THRESHOLD} 算命中）。
 */
export function serviceIntentScore(phrase: string, text: string): number {
  const p = phrase.trim().toLowerCase()
  const t = text.toLowerCase()
  if (p === '' || t.trim() === '') return 0
  if (t.includes(p)) return 1
  const want = grams(p)
  if (want.size === 0) return 0
  const have = grams(t)
  let hit = 0
  for (const g of want) if (have.has(g)) hit += 1
  return Math.round((hit / want.size) * 1000) / 1000
}

/** 过这个分算命中。 */
export const SERVICE_MATCH_THRESHOLD = 0.5

export interface ServiceMatch {
  service: ServiceView
  /** 命中那句意向说法的分（0–1）。 */
  score: number
  /** 命中的那句说法。 */
  phrase: string
  /** 是不是当前岗位的服务。 */
  position_hit: boolean
}

/**
 * `find_service` 的匹配（意向 + 当前岗位 → 匹配项）：只看能下单的；过线才算；
 * 排序 = 工坊团队自营的在前 → 当前岗位的在前 → 分高的在前 → id。
 */
export function matchServices(
  services: readonly ServiceView[],
  text: string,
  position_id?: string,
): ServiceMatch[] {
  const out: ServiceMatch[] = []
  for (const s of services) {
    if (!s.available) continue
    let best = 0
    let phrase = ''
    for (const p of [...s.intents, s.label_zh, s.label_en]) {
      const score = serviceIntentScore(p, text)
      if (score > best) {
        best = score
        phrase = p
      }
    }
    if (best < SERVICE_MATCH_THRESHOLD) continue
    out.push({
      service: s,
      score: best,
      phrase,
      position_hit: position_id !== undefined && s.positions.includes(position_id),
    })
  }
  const own = (m: ServiceMatch): number => (m.service.provider_label === 'workshop_team' ? 0 : 1)
  return out.sort(
    (a, b) =>
      own(a) - own(b) ||
      Number(b.position_hit) - Number(a.position_hit) ||
      b.score - a.score ||
      a.service.id.localeCompare(b.service.id),
  )
}

/** 岗位页「这个岗位能用的服务」：关联了这个岗位、能下单的，自营在前，最多 {@link SERVICE_POSITION_LIMIT} 项。 */
export function servicesForPosition(
  services: readonly ServiceView[],
  position_id: string,
  limit: number = SERVICE_POSITION_LIMIT,
): ServiceView[] {
  return services
    .filter((s) => s.available && s.positions.includes(position_id))
    .sort(
      (a, b) =>
        Number(a.provider_label !== 'workshop_team') -
          Number(b.provider_label !== 'workshop_team') || a.id.localeCompare(b.id),
    )
    .slice(0, limit)
}

/**
 * 卡点 → 服务：「缺设置」卡上的「交给工坊办」挂哪一项。服务目录里「关联卡点」写机器键
 * （`connect:<服务>` / `setup:<设置目标>`）就按键对上；写人话的按名字试匹配。自营优先。
 */
export function serviceForBlocker(
  services: readonly ServiceView[],
  blocker: { key: string; name?: string },
): ServiceView | undefined {
  const hits = services.filter((s) => {
    if (!s.available) return false
    return (s.blockers ?? []).some(
      (b) =>
        b.trim().toLowerCase() === blocker.key.toLowerCase() ||
        (blocker.name !== undefined &&
          !b.includes(':') &&
          serviceIntentScore(b, blocker.name) >= SERVICE_MATCH_THRESHOLD),
    )
  })
  return hits.sort(
    (a, b) =>
      Number(a.provider_label !== 'workshop_team') - Number(b.provider_label !== 'workshop_team'),
  )[0]
}

/**
 * **推荐卡**（docs/105 §4 / §5）：挂在 AI 那段话末尾的一行「名字 · 起价 · 看看」。**不是审批卡**、
 * 不进卡片队列；卡上不写风险、不写合作方名字（只有 {@link ServiceProviderLabel}）。
 */
export interface ServiceOffer {
  service_id: string
  kind: ServiceKind
  label_zh: string
  label_en: string
  pricing_mode: ServicePricingMode
  /** 起价（{@link serviceStartCredits}；算不出就没有）。 */
  from_credits?: number
  provider_label: ServiceProviderLabel
}

export function serviceOfferOf(s: ServiceView): ServiceOffer {
  const from = serviceStartCredits(s)
  return {
    service_id: s.id,
    kind: s.kind,
    label_zh: s.label_zh,
    label_en: s.label_en,
    pricing_mode: s.pricing_mode,
    ...(from === undefined ? {} : { from_credits: from }),
    provider_label: s.provider_label,
  }
}

/* ------------------------------------------------------------------ */
/* 审批卡 `service_order`（永远 L1）的五种卡面                            */
/* ------------------------------------------------------------------ */

/** 审批卡种（`ApprovalKind`）。永远 L1、不能升级成自动（下单就是花钱）。 */
export const SERVICE_ORDER_CARD_KIND = 'service_order' as const

/**
 * 卡上要的服务那几格（出卡那一刻的快照；卡面照它画，下单前本机再按最新目录校验一遍）。
 */
export type ServiceCardSnapshot = Pick<
  ServiceView,
  | 'id'
  | 'kind'
  | 'label_zh'
  | 'label_en'
  | 'summary_zh'
  | 'summary_en'
  | 'provider_label'
  | 'pricing_mode'
  | 'price_credits'
  | 'from_credits'
  | 'menu'
  | 'milestones'
  | 'questions'
  | 'promise'
  | 'revisions'
  | 'auto_accept_hours'
  | 'landing'
>

export function serviceCardSnapshot(s: ServiceView): ServiceCardSnapshot {
  return {
    id: s.id,
    kind: s.kind,
    label_zh: s.label_zh,
    label_en: s.label_en,
    summary_zh: s.summary_zh,
    summary_en: s.summary_en,
    provider_label: s.provider_label,
    pricing_mode: s.pricing_mode,
    ...(s.price_credits === undefined ? {} : { price_credits: s.price_credits }),
    ...(s.from_credits === undefined ? {} : { from_credits: s.from_credits }),
    ...(s.menu === undefined ? {} : { menu: s.menu }),
    ...(s.milestones === undefined ? {} : { milestones: s.milestones }),
    questions: s.questions,
    promise: s.promise,
    revisions: s.revisions,
    auto_accept_hours: s.auto_accept_hours,
    landing: s.landing,
  }
}

/** 这张卡挂在哪件事上、办成后回哪一步（卡点入口带 `resume`，决策 690）。 */
export interface ServiceCardOrigin {
  matter_id?: string
  position_id?: string
  assignment_id?: string
  /** 「交给工坊办」那一类：办成后按原话接着做的那件事。 */
  resume?: { matter_id: string; person_id: string; assignment_id: string }
  /** 卡点的机器键（`connect:google` / `setup:site.store`）。 */
  blocker?: string
}

/** 标准件的**价目单**：勾几项、各填数量与对象，合计当场算；点「下单」= 批（扣进托管）。 */
export interface ServiceMenuCardPayload extends ServiceCardOrigin {
  form: 'service_menu'
  service: ServiceCardSnapshot
  /** AI 预填的几行（人在卡上改；批的时候带改过的）。 */
  lines: ServiceOrderLine[]
  idempotency_key: string
}

/** 定制件的**需求单**（AI 在对话里一问一答整理的）：提交等报价 / 再改改。 */
export interface ServiceRequirementsCardPayload extends ServiceCardOrigin {
  form: 'service_requirements'
  service: ServiceCardSnapshot
  answers: ServiceRequirementAnswer[]
  idempotency_key: string
}

/**
 * **下单卡**（同意并支付）：一口价的定制件交完需求单（`pay`）、报价回来了（`accept_quote`）、
 * 会上说定要加钱（`extra`，一期云上还没有这个口，见 WP390 报告）。
 */
export interface ServicePayCardPayload extends ServiceCardOrigin {
  form: 'service_pay'
  stage: 'pay' | 'accept_quote' | 'extra'
  service: ServiceCardSnapshot
  /** 先报价的那一单（`accept_quote`）。 */
  order_id?: string
  credits: number
  /** 接单后多久交付（小时）。 */
  deliver_hours?: number
  milestones?: ServiceMilestone[]
  /** 一口价的定制件：交给做的人的需求单。 */
  requirements?: ServiceRequirementAnswer[]
  /** 报价里那一句说明。 */
  quote_note?: string
  idempotency_key: string
}

/** 验收卡的三个选项（选项就是答案：通过 / 要改 / 申请退款）。 */
export const SERVICE_ACCEPTANCE_OPTIONS = ['accept', 'revise', 'dispute'] as const
export type ServiceAcceptanceOption = (typeof SERVICE_ACCEPTANCE_OPTIONS)[number]

/** **验收卡**：标准件看凭证；定制件按段。写明几时自动通过。 */
export interface ServiceAcceptanceCardPayload extends ServiceCardOrigin {
  form: 'service_acceptance'
  order_id: string
  service: ServiceCardSnapshot
  milestone_id?: string
  milestone_label_zh?: string
  milestone_label_en?: string
  /** 这一次验的是多少积分（这一段 / 整单）。 */
  credits: number
  proof?: ServiceDeliveryProof
  lines?: ServiceOrderLineView[]
  deliverables: ServiceDeliverable[]
  revisions_left: number
  auto_accept_at?: Iso8601
  /** 要改 / 申请退款时那一句（批的时候带上；申请退款必填）。 */
  reason?: string
}

/** **交换联系方式请求卡**（N1）：同意才把你自己选的那一种给这一单的服务方。 */
export interface ServiceContactCardPayload extends ServiceCardOrigin {
  form: 'service_contact'
  order_id: string
  service: ServiceCardSnapshot
  request_id: string
  /** 服务方为什么要。 */
  reason: string
  /** 你选给哪一种（批的时候带上；卡里不预填）。 */
  contact?: ServiceContact
}

export type ServiceOrderCardPayload =
  | ServiceMenuCardPayload
  | ServiceRequirementsCardPayload
  | ServicePayCardPayload
  | ServiceAcceptanceCardPayload
  | ServiceContactCardPayload

export const SERVICE_ORDER_CARD_FORMS = [
  'service_menu',
  'service_requirements',
  'service_pay',
  'service_acceptance',
  'service_contact',
] as const

export function isServiceOrderCardPayload(p: unknown): p is ServiceOrderCardPayload {
  const o = p !== null && typeof p === 'object' ? (p as Record<string, unknown>) : {}
  const svc = o.service !== null && typeof o.service === 'object' ? o.service : undefined
  return (
    typeof o.form === 'string' &&
    (SERVICE_ORDER_CARD_FORMS as readonly string[]).includes(o.form) &&
    svc !== undefined
  )
}

/* ------------------------------------------------------------------ */
/* 本机接口（`/v1/workshop-services/*`）的样子                           */
/* ------------------------------------------------------------------ */

/** 本机缓存的服务目录（云上改了刷新一次；断网用上一份）。 */
export interface WorkshopServiceCatalogView {
  /** 关联了工坊账号没有（没关联就是空目录 + 一句人话）。 */
  linked: boolean
  services: ServiceView[]
  /** 云上那一份的时刻。 */
  at?: Iso8601
  /** 本机上一次取到的时刻。 */
  fetched_at?: Iso8601
  /** 一句人话（没关联 / 取不到用的是上一份 / 要重新登录）。 */
  notice?: string
  /** 老令牌缺 `services` 动作集、自动补签也没成：要重新登录一次（决策 1098）。 */
  reauth?: true
}

/** 一张订单在本机的样子：云上那一份 + 本机记的挂在哪件事上、在等你的卡。 */
export interface WorkshopServiceOrderRow {
  order: ServiceOrderView
  matter_id?: string
  position_id?: string
  /** 等你点的那张卡（下单 / 验收 / 联系方式）。 */
  card_id?: string
  /** 交付物快到期了（P10：到期前提醒一次）。 */
  expiring?: boolean
}

export interface WorkshopServiceOrdersView {
  orders: WorkshopServiceOrderRow[]
  at: Iso8601
  notice?: string
  reauth?: true
}

/** 本机账本一行：下单、托管、每条沟通、交付、验收、退款各一条。 */
export interface WorkshopServiceLedgerEntry {
  at: Iso8601
  order_id: string
  kind:
    | 'order'
    | 'escrow'
    | 'message'
    | 'delivery'
    | 'acceptance'
    | 'settle'
    | 'refund'
    | 'cancel'
    | 'landing'
  /** 这一笔动了多少积分（托管正数、退回负数）。 */
  credits?: number
  text: string
}

export interface WorkshopServiceOrderDetail extends WorkshopServiceOrderRow {
  messages: ServiceOrderMessage[]
  ledger: WorkshopServiceLedgerEntry[]
}

/** 「看看」/「交给工坊办」/ 列表里点一项：出价目单，或者让 AI 在对话里问清需求。 */
export interface WorkshopServiceStartInput {
  service_id: string
  matter_id?: string
  position_id?: string
  /** 从哪张「缺设置」卡来的（卡点入口）。 */
  from_card?: string
}

export interface WorkshopServiceStartResult {
  /** `card` 出了一张卡（价目单 / 下单卡）；`ask` AI 在对话里问需求。 */
  next: 'card' | 'ask'
  card_id?: string
  matter_id?: string
  message: string
}

/** 「帮我起草回复」：AI 帮读懂对方在问什么、起一句回复（**不替你答应加钱或改范围**）。 */
export interface WorkshopServiceReplyDraft {
  /** 对方在问什么（一句话）。 */
  summary: string
  /** 起草的回复（你改了再发）。 */
  text: string
  /** 对方提到加钱 / 改范围：草稿里没替你答应，要你自己定。 */
  needs_you?: true
}
