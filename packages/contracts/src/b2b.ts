/**
 * docs/84 B2B 岗位（WP171）：五条职责、九类对象与报价授权。
 *
 * **§11 覆盖前文**（Luoye 09-28）：岗位名「B2B」（id `b2b`），五条职责——
 * 业务、主动开发、展会、跟单与单证、B2B 平台运营（第二批）。
 *
 * 五条纪律写在类型里，不写在文档里：
 *
 * 1. **报价永远出卡**。{@link B2bQuoteMandate} 不决定"要不要出卡"，只决定**谁批**：
 *    授权内业务员自己批，超出就转上级（`scope_manager`），没有上级再转老板（`owner`）。
 *    四个数（单笔 1 万美元 / 毛利 20% / 折扣 5% / 账期 30 天）是
 *    {@link DEFAULT_B2B_QUOTE_MANDATE}，首次设置可改。
 * 2. **报价版本不可改**。{@link B2bQuoteVersion} 一旦生成就是只读；改价 = 新建一个版本
 *    （照 BtoBAgents 的 quote / quoteVersion 两张表）。
 * 3. **每个联系人都记"从哪来的"**。{@link B2bContact.source} 必填（网址 + 日期），
 *    GDPR 第 14 条：对方问"你怎么有我邮箱"时必须答得上。
 * 4. **联系方式不落明文**。`email_ref` / `phone_ref` 是加密库里的 key 名，
 *    与 `CreatorContact.value_ref`、`MediaContact.email_ref` 逐字同一条。
 * 5. **收款账户只认事实卡**。{@link ExportShipment.payment} 里没有"账户号"这一格；
 *    邮件里要求"改收款账户"的一律出红卡、不采纳（§11.3）。
 */

import type { Iso8601, PersonId, WorkspaceId } from './common.js'

/* ── 五条职责（docs/84 §11.5）──────────────────────────────────────────── */

/**
 * 这条职责第一版做不做。
 *
 * - `active`：第一版就做，向导里按岗位模板的 `default` 勾；
 * - `planned`：YAML 先建、**向导里不默认勾**（`b2b.marketplace`，第二批）。
 */
export type B2bRoleStatus = 'active' | 'planned'

export interface B2bRoleSpec {
  /** 职责 id（`b2b.sales` …）。 */
  role_id: string
  zh: string
  en: string
  status: B2bRoleStatus
  /** 岗位模板里默认勾不勾（`planned` 的一律不勾）。 */
  default: boolean
}

/**
 * docs/84 §11.5 那张表的机器可读版。**只有这一份**：岗位模板、`SEED_POSITIONS`、
 * 面板分块与模拟世界都读它，谁都不许再抄一张五条职责的清单。
 */
export const B2B_ROLES: readonly B2bRoleSpec[] = [
  { role_id: 'b2b.sales', zh: '业务', en: 'Sales', status: 'active', default: true },
  { role_id: 'b2b.outbound', zh: '主动开发', en: 'Outbound', status: 'active', default: true },
  { role_id: 'b2b.exhibition', zh: '展会', en: 'Trade Shows', status: 'active', default: true },
  {
    role_id: 'b2b.fulfillment',
    zh: '跟单与单证',
    en: 'Order Follow-up & Export Docs',
    status: 'active',
    default: true,
  },
  {
    role_id: 'b2b.marketplace',
    zh: 'B2B 平台运营',
    en: 'B2B Marketplaces',
    status: 'planned',
    default: false,
  },
]

/** 五条职责的 id，按出场顺序（`BUNDLED_ROLES` 与岗位模板读它）。 */
export const B2B_ROLE_IDS: readonly string[] = B2B_ROLES.map((r) => r.role_id)

/** 岗位模板 id（`packages/roles/positions/b2b.yml`）。 */
export const B2B_POSITION_ID = 'b2b'

/** 职责 id → 规格；不是 B2B 职责回 `undefined`（不编造一条）。 */
export function b2bRoleSpec(role_id: string): B2bRoleSpec | undefined {
  return B2B_ROLES.find((r) => r.role_id === role_id)
}

/* ── 报价授权（docs/84 §3.2 / §11.1 第 3 条）────────────────────────────── */

/**
 * 报价授权四个数。**不决定要不要出卡**（报价永远出卡），决定这张卡谁来批。
 *
 * BtoBAgents 里两处写的不一样（`domain/policy.ts` 1 万 / 32% / 8% / 30 天，
 * `runtime-v2/runtime.ts` 10 万 / 20% / 5% / 30 天），这里统一成一套。
 */
export interface B2bQuoteMandate {
  /** 单笔报价金额上限（美元）。超了转上级。 */
  max_amount_usd: number
  /** 最低毛利（百分数，20 = 20%）。低于它转上级。 */
  min_margin_pct: number
  /** 最大折扣（百分数）。超了转上级。 */
  max_discount_pct: number
  /** 最长账期（天）。超了转上级。 */
  max_payment_terms_days: number
}

/** docs/84 §3.2 统一值；职责 yml 的 `mandate.caps` 与首次设置都从这里起。 */
export const DEFAULT_B2B_QUOTE_MANDATE: Readonly<B2bQuoteMandate> = {
  max_amount_usd: 10_000,
  min_margin_pct: 20,
  max_discount_pct: 5,
  max_payment_terms_days: 30,
}

/* ── 对象一：客户（公司）与联系人 ──────────────────────────────────────── */

/** 销售阶段（BtoBAgents `crm.defaultStages` 那七档）。 */
export type B2bStage =
  | 'contacted'
  | 'replied'
  | 'meeting'
  | 'sample'
  | 'quote'
  | 'negotiation'
  | 'won'
  | 'lost'

/** 一个联系人 / 一家公司是从哪来的（GDPR 第 14 条要答得上）。 */
export interface B2bSource {
  /** 来源种类：自己导入的表、展会名片、官网联系页、数据服务（官方档 / 自带 key）、手填。 */
  kind: 'import' | 'trade_show' | 'website' | 'data_provider' | 'manual' | 'inbound'
  /** 来源网址（官网联系页、展会名录页、数据服务的记录页）；手填与导入可以没有。 */
  url?: string
  /** 在哪一天看到的。 */
  observed_at: Iso8601
  /** 哪张名单导进来的（{@link B2bList.id}）。 */
  list_id?: string
}

/** B2B 客户（一家公司）。 */
export interface B2bAccount {
  id: string
  workspace_id: WorkspaceId
  name: string
  /** 公司域名（`example.com`，不带协议）。 */
  domain?: string
  /** 国家（ISO 3166-1 alpha-2，`DE` / `US`）。德国、奥地利默认不进开发序列（§11.1 第 6 条）。 */
  country?: string
  /** 地区（交接规则按它分：`EU` / `NA` …）。 */
  region?: string
  /** 产品线（交接规则按它分）。 */
  product_lines: string[]
  stage: B2bStage
  /** 这家客户归哪个业务员。 */
  owner_person_id?: PersonId
  source: B2bSource
  /** 最后一次往来（唤醒沉睡客户看它）。 */
  last_contact_at?: Iso8601
  created_at: Iso8601
  updated_at: Iso8601
}

/**
 * 一个联系人。**来源必填**；联系方式只存加密库里的 key 名。
 *
 * CASL（加拿大）：对方公开发布了邮箱、且信的内容与他的职务相关才算默认同意——
 * `public_source` 记的就是"这个邮箱是不是他自己公开的"。
 */
export interface B2bContact {
  id: string
  workspace_id: WorkspaceId
  account_id: string
  name: string
  title?: string
  /** 加密库里的 key 名，**不是邮箱明文**。 */
  email_ref?: string
  /** 加密库里的 key 名，**不是电话明文**。 */
  phone_ref?: string
  source: B2bSource
  /** 这个联系方式是不是对方自己公开发布的（CASL 默认同意的前提）。 */
  public_source?: boolean
  /** 在抑制名单上（退订 / 硬退信 / 说过别再发）。名单本身在 `core/suppression.ts`。 */
  suppressed?: boolean
  created_at: Iso8601
}

/* ── 对象二：商机 ──────────────────────────────────────────────────────── */

export interface B2bOpportunity {
  id: string
  workspace_id: WorkspaceId
  account_id: string
  name: string
  stage: B2bStage
  /** 预计金额（美元）。 */
  value_usd?: number
  product?: string
  owner_person_id?: PersonId
  expected_close?: Iso8601
  /** 从哪条线索来的（展会线索 / 开发信回复 / 平台询盘），按来源归因。 */
  lead_source?: 'inquiry' | 'outbound' | 'trade_show' | 'marketplace' | 'referral' | 'repeat'
  created_at: Iso8601
  updated_at: Iso8601
}

/* ── 对象三：报价与不可改的报价版本 ────────────────────────────────────── */

/** 贸易术语（`quotation` 技能讲它们的区别）。 */
export type Incoterm = 'EXW' | 'FOB' | 'CIF' | 'DDP' | 'DAP' | 'FCA'

export type B2bQuoteStatus =
  | 'draft'
  | 'pending_approval'
  | 'sent'
  | 'accepted'
  | 'rejected'
  | 'expired'

/** 一张报价（一串版本的"文件夹"）。当前是哪一版看 {@link B2bQuote.current_version}。 */
export interface B2bQuote {
  id: string
  workspace_id: WorkspaceId
  account_id: string
  opportunity_id?: string
  /** 报价单号（`Q-2026-0928-01`）。 */
  number: string
  status: B2bQuoteStatus
  current_version: number
  owner_person_id?: PersonId
  created_at: Iso8601
  updated_at: Iso8601
}

export interface B2bQuoteLine {
  sku: string
  description: string
  qty: number
  /** 单价（美元）。 */
  unit_price_usd: number
}

/**
 * 报价的一个版本。**只读**：改价、改账期、改数量一律新建一版，旧版原样留着。
 *
 * 金额 / 毛利 / 折扣 / 账期四个数就是 {@link B2bQuoteMandate} 比的那四个。
 */
export interface B2bQuoteVersion {
  readonly quote_id: string
  /** 从 1 起，每改一次加 1。 */
  readonly version: number
  readonly lines: readonly B2bQuoteLine[]
  readonly amount_usd: number
  readonly margin_pct: number
  readonly discount_pct: number
  readonly payment_terms_days: number
  readonly incoterm: Incoterm
  readonly valid_until: Iso8601
  readonly created_at: Iso8601
  readonly created_by: PersonId | 'agent'
}

/* ── 对象四：样品 ──────────────────────────────────────────────────────── */

/** 待寄 → 已寄（单号）→ 已签收 → 已反馈（docs/84 §3.2）。 */
export type B2bSampleStatus = 'to_ship' | 'shipped' | 'delivered' | 'feedback'

export interface B2bSample {
  id: string
  workspace_id: WorkspaceId
  account_id: string
  opportunity_id?: string
  items: { sku: string; qty: number }[]
  status: B2bSampleStatus
  /** 收费样品的金额（美元）；免费样品不填。 */
  charge_usd?: number
  carrier?: string
  /** 快递单号。**标"已寄"必须带它**（guardrail 拦）。 */
  tracking_no?: string
  /** 最晚哪天寄出（超期不寄出提醒）。 */
  ship_by: Iso8601
  /** 最晚哪天该有反馈（超期没反馈出提醒）。 */
  feedback_by?: Iso8601
  feedback?: string
  updated_at: Iso8601
}

/* ── 对象五：名单 ──────────────────────────────────────────────────────── */

/**
 * 一张名单（导入的表、展会名录、数据服务查回来的一批）。
 *
 * 三档数据（docs/84 §6.1）：自己的免费；官方档（云端调 Apify）按条扣积分；
 * 自带 key 档用户直接付给服务商、本机直连不经过我们的云。
 */
export interface B2bList {
  id: string
  workspace_id: WorkspaceId
  name: string
  tier: 'own' | 'official' | 'byo_key'
  source: B2bSource
  contact_count: number
  /** 官方档扣了多少积分（价目取云上 `/v1/pricing`，不写死）。 */
  credits_spent?: number
  imported_at: Iso8601
}

/* ── 对象六：展会与展会线索（docs/84 §11.2）───────────────────────────── */

export type TradeShowStatus =
  | 'considering'
  | 'registered'
  | 'preparing'
  | 'on_site'
  | 'done'
  | 'skipped'

export interface TradeShow {
  id: string
  workspace_id: WorkspaceId
  /** 展会名（"香港秋季电子展"）。 */
  name: string
  city: string
  country: string
  starts_on: Iso8601
  ends_on: Iso8601
  /** 报名截止日（截止日提醒看它）。 */
  registration_deadline?: Iso8601
  status: TradeShowStatus
  /** 展位号。 */
  booth?: string
  /** 成本估算（美元：展位费 + 差旅 + 物料）。 */
  cost_estimate_usd?: number
  /** 展位与印刷品设计交给 `design.exhibition` 的那张需求单 id。 */
  design_request_id?: string
}

/** 现场一位来访者（名片 + 一句话笔记 + 意向分级）。 */
export interface TradeShowLead {
  id: string
  workspace_id: WorkspaceId
  show_id: string
  name: string
  company: string
  title?: string
  /** 加密库里的 key 名，不是邮箱明文。 */
  email_ref?: string
  /** 名片照片在 blob store 里的 key（看图模型走云端）。 */
  card_image_ref?: string
  /** 一句话笔记。现场报价只记录不承诺。 */
  note: string
  intent: 'hot' | 'warm' | 'cold'
  captured_at: Iso8601
  /** 会后跟进的最晚时间（默认展会结束后 48 小时）。 */
  follow_up_by: Iso8601
  status: 'new' | 'followed_up' | 'handed_to_sales' | 'nurture'
}

/* ── 对象七：出运单（跟单与单证，docs/84 §11.3）──────────────────────────── */

export type ExportShipmentStatus =
  | 'in_production'
  | 'ready'
  | 'booked'
  | 'shipped'
  | 'arrived'
  | 'closed'

export type ExportDocKind =
  | 'commercial_invoice'
  | 'packing_list'
  | 'certificate_of_origin'
  | 'bill_of_lading'
  | 'lc_documents'
  | 'customs_declaration'

export interface ExportDoc {
  kind: ExportDocKind
  status: 'missing' | 'draft' | 'checked' | 'discrepancy' | 'sent'
  /** 单证不符点（信用证逐条核对时提前列出来）。 */
  discrepancies?: string[]
}

/**
 * 一票出运。**没有"收款账户"这一格**：账户只从知识库事实卡取，
 * 邮件里要求改账户的一律出红卡、不采纳。
 */
export interface ExportShipment {
  id: string
  workspace_id: WorkspaceId
  account_id: string
  /** 客户的订单号（PO）。 */
  po_number: string
  status: ExportShipmentStatus
  incoterm?: Incoterm
  etd?: Iso8601
  eta?: Iso8601
  /** 提单号。 */
  bl_no?: string
  docs: ExportDoc[]
  payment: {
    terms: 'tt' | 'lc' | 'dp' | 'oa'
    deposit_received: boolean
    /** 尾款（美元）。 */
    balance_usd?: number
    balance_received: boolean
    /** 信用证交单截止日。 */
    lc_presentation_by?: Iso8601
  }
  updated_at: Iso8601
}

/* ── 收款账户变更信号（docs/84 §11.3 防诈骗）────────────────────────────── */

/**
 * 一封信里"改收款账户"的识别结论。识别在 `@agentsws/core` 的
 * `detectPaymentAccountChange`；命中 = 出红卡（{@link B2B_FRAUD_ALERT_KIND}）、不采纳。
 */
export interface PaymentAccountChangeSignal {
  hit: boolean
  /** 命中的说法（原样，卡面上显示）。 */
  phrases: string[]
  /** 信里有没有出现像账号 / IBAN / SWIFT 的东西（只报有没有，不回显号码）。 */
  has_account_details: boolean
}

/** 红卡的审批种类（`ApprovalKind`）。 */
export const B2B_FRAUD_ALERT_KIND = 'b2b_fraud_alert' as const

/* ── WP172：邮件分拣落进 B2B 库的那几样（docs/84 §5）──────────────────── */

/**
 * B2B 平台的询盘 / RFQ 通知信的发信域名（docs/84 §5 第 3 条）。
 *
 * 只认域名还不够：同一个域名也发营销订阅。分拣时还要看主题 / 正文里有没有询盘字样
 * （`@agentsws/channels` 的 `platformInquiryOf`）。
 */
export const B2B_PLATFORM_DOMAINS: readonly { domain: string; platform: string }[] = [
  { domain: 'alibaba.com', platform: 'alibaba' },
  { domain: 'made-in-china.com', platform: 'made_in_china' },
  { domain: 'globalsources.com', platform: 'global_sources' },
]

/** 一封信为什么判成了 B2B（docs/84 §5 的四条，按顺序）。 */
export type B2bMailBasis = 'our_thread' | 'known_sender' | 'platform_notice' | 'model' | 'user'

/**
 * 分拣判成 B2B 的一封信在 B2B 库里落成的样子：**询盘**（新的需求）或**往来记录**
 * （已有客户 / 我们发出去那封信的后续）。
 *
 * 正文不在这里（在消息库里，`message_id` 指过去）；发件人只存遮过的地址与哈希。
 */
export interface B2bInquiry {
  id: string
  workspace_id: WorkspaceId
  /** `inquiry` = 询盘（新需求、平台通知）；`correspondence` = 已有客户 / 回我们的信。 */
  kind: 'inquiry' | 'correspondence'
  basis: B2bMailBasis
  /** 平台通知信是哪个平台（`alibaba` …）。 */
  platform?: string
  /** 对上了库里哪家客户 / 哪个联系人。 */
  account_id?: string
  contact_id?: string
  subject: string
  /** 发件人（遮过：`a***@b.com`）。 */
  from_masked: string
  /** 发件人域名（没遮：公司域名不是个人数据，交接与去重要它）。 */
  from_domain: string
  /** 哪只邮箱收的（遮过）。 */
  mailbox_masked: string
  /** 消息库里那封信的 id（正文、原信都在那边）。 */
  message_id: string
  thread_id: string
  /** 回信里碰到的承诺类别（价格 / 交期 / 认证 …），面板上一眼看得见。 */
  commitments: string[]
  status: 'new' | 'replied' | 'closed'
  /** B2B 岗位开着时开的那条事项。 */
  matter_id?: string
  /** 起的那次 Run。 */
  run_id?: string
  /** 信里要求改收款账户 → 红卡的 id（不采纳）。 */
  fraud_alert_id?: string
  /** WP173：回我们开发信的那一封被分成了哪一类（有意向 / 要资料 / 问价 / …，docs/84 §2.2）。 */
  reply_class?: B2bReplyClass
  received_at: Iso8601
  created_at: Iso8601
}

/**
 * 抑制名单上的一条（docs/84 §2.1「只有一份」，规则在 `@agentsws/core` 的 `suppression.ts`）。
 *
 * **不存明文地址**：`key_hash` 是 `sha256(suppressionKey(地址))`，比对时把收件人照同一个口径算一遍；
 * `masked` 只给人认（`a***@b.com`）。
 */
export interface B2bSuppressionEntry {
  key_hash: string
  masked: string
  /** WP173 加 `declined`：开发信回信说"不感兴趣"（docs/84 §2.2：退订、不感兴趣都进名单）。 */
  reason: 'unsubscribe' | 'hard_bounce' | 'manual' | 'declined'
  /** 从哪封信认出来的（消息库 id）。 */
  message_id?: string
  /** 对上了哪个联系人（这个联系人的开发序列就此停下）。 */
  contact_id?: string
  at: Iso8601
}

/* ── WP172：B2B 库的写法——草稿 → 改动卡 → 批了才落库 ─────────────────── */

/** B2B 库里的九类对象（表名 = 对象类型名；报价版本挂在 `b2b_quote` 下面）。 */
export type B2bCollection =
  | 'b2b_account'
  | 'b2b_contact'
  | 'b2b_opportunity'
  | 'b2b_quote'
  | 'b2b_sample'
  | 'b2b_list'
  | 'trade_show'
  | 'trade_show_lead'
  | 'export_shipment'

export const B2B_COLLECTIONS: readonly B2bCollection[] = [
  'b2b_account',
  'b2b_contact',
  'b2b_opportunity',
  'b2b_quote',
  'b2b_sample',
  'b2b_list',
  'trade_show',
  'trade_show_lead',
  'export_shipment',
]

/**
 * 一份还没生效的改动（新建或修改一条 B2B 记录）。
 *
 * **写都经卡**：草稿存着不算数；「提交」= 出一张改动卡（`b2b_record` / `b2b_quote` /
 * `b2b_sample` / `b2b_list_import` …），批了执行器才把它落进库里。读不经卡。
 */
export interface B2bDraft {
  id: string
  workspace_id: WorkspaceId
  collection: B2bCollection
  op: 'create' | 'update'
  /** 要建 / 要改的那条记录的 id（新建时预先分好）。 */
  record_id: string
  /** 记录本身（新建是全量，修改是改完之后的全量）。联系方式只有 `*_ref`，没有明文。 */
  record: Record<string, unknown>
  /** 报价：这一版（只读，批了才写进版本表）。 */
  quote_version?: B2bQuoteVersion
  status: 'draft' | 'submitted' | 'applied' | 'blocked'
  change_id?: string
  approval_item_id?: string
  /** 被 guardrail 拦下时那句人话。 */
  message?: string
  created_by: PersonId
  created_at: Iso8601
  updated_at: Iso8601
}

/* ── WP173：开发信序列（docs/84 §2 / §11.1）────────────────────────────── */

/** 序列里的第几封（与 `@agentsws/core` 的 `OutreachStep` 同一组字面量）。 */
export type B2bSequenceStep = 'first' | 'follow_up' | 'final'

/**
 * 一个联系人在开发序列里走到哪了。
 *
 * - `queued`：排着（今天配额满了 / 还没选发信邮箱 / 发信邮箱体检没过 / 公司地址没填）；
 * - `awaiting_approval`：进了一张待批的卡（占着今天的配额）；
 * - `active`：发过至少一封，等下一封到点；
 * - `replied` / `handed_to_sales`：回信了（有意向的交给业务）；
 * - `stopped`：退订、退信、不感兴趣、卡被驳回；
 * - `finished`：收尾那封发完了——**真停**。
 */
export type B2bEnrollmentStatus =
  | 'queued'
  | 'awaiting_approval'
  | 'active'
  | 'replied'
  | 'handed_to_sales'
  | 'stopped'
  | 'finished'

/** 排着的原因（面板上照实写）。 */
export type B2bQueuedReason = 'quota' | 'sender_choice' | 'sender_auth' | 'company_address'

/** 开发信回信的分类（docs/84 §2.2，形状照 `kol-core/replies.ts`）。 */
export type B2bReplyClass =
  | 'interested'
  | 'wants_info'
  | 'asks_price'
  | 'later'
  | 'not_interested'
  | 'unsubscribe'
  | 'auto_reply'
  | 'bounce'
  | 'unknown'

export interface B2bEnrollment {
  id: string
  workspace_id: WorkspaceId
  contact_id: string
  account_id: string
  /** 从哪只邮箱发（配额按它算）。 */
  sender: string
  status: B2bEnrollmentStatus
  queued_reason?: B2bQueuedReason
  stop_reason?: string
  /** 发过的那几封（Message-ID 用来对回信的线程）。 */
  steps: {
    step: B2bSequenceStep
    at: Iso8601
    message_id?: string
    change_id?: string
    /** 这一封的主题（跟进回在同一条线程里，用首封那一个）。 */
    subject?: string
  }[]
  /** 下一封是哪封、什么时候到点。 */
  next_step?: B2bSequenceStep
  due_at?: Iso8601
  /** 等批的那张卡（批了才发）。 */
  pending_change_id?: string
  pending_approval_id?: string
  reply_class?: B2bReplyClass
  replied_at?: Iso8601
  /** 交给业务时开的那件事项。 */
  matter_id?: string
  created_at: Iso8601
  updated_at: Iso8601
}

/** 发信邮箱体检的一格。`pending` = 测试信还没收回来。 */
export type B2bAuthResult = 'pass' | 'fail' | 'missing' | 'pending' | 'unknown'

/**
 * 发信邮箱体检（docs/84 §2.3）：SPF / DMARC 查 DNS，DKIM 看给自己发的那封测试信的
 * `Authentication-Results`。**SPF 或 DKIM 没过不发**；DMARC 缺了只提示。
 */
export interface B2bSenderAuth {
  spf: B2bAuthResult
  dkim: B2bAuthResult
  dmarc: B2bAuthResult
  checked_at?: Iso8601
  /** 那封测试信的 Message-ID（收回来时按它认）。 */
  test_message_id?: string
  /** 给人看的几句（没过的原因、怎么配）。 */
  notes: string[]
  /** WP176：测试信是什么时候发出去的（等超过 10 分钟没收回来，就按 DNS 查 DKIM 兜底）。 */
  test_sent_at?: Iso8601
  /**
   * WP176：DKIM 这一格是怎么判的。`test_mail` = 读了测试信的信头（实信验证）；`dns` = 测试信没收回来
   * （Gmail 自己发给自己的信常常不进收件箱），按常见选择器在 DNS 里查到了公钥记录——
   * 「DNS 已配置（未经实信验证）」，允许发，卡上写明。没有这一格 = 老数据（按测试信判的）。
   */
  dkim_via?: 'test_mail' | 'dns'
  /** WP176：DNS 兜底查到的那个选择器（`google` / `selector1` …）。 */
  dkim_selector?: string
}

/** 一只发信邮箱（用户在「发信域名」那张卡上选的）。 */
export interface B2bSender {
  address: string
  domain: string
  /** 是不是单独的发信域名（与主站 / 客服邮箱不同域）。 */
  separate_domain: boolean
  chosen_at: Iso8601
  chosen_by?: PersonId
  /** 第一次从这只邮箱发开发信的时间（预热从这天算）。 */
  first_sent_at?: Iso8601
  auth: B2bSenderAuth
  /** 上一次查到的 DNS 记录（测试信收回来时拿它和信头一起再判一次）。 */
  dns?: { spf_txt?: string[]; dmarc_txt?: string[] }
  /**
   * WP176：用户勾了「这只邮箱已经正常发信很久」——**不走预热**，直接按每天 50 封（预热之后那一档）。
   * 新域名别勾（面板上那一句提醒）。不勾 = 照旧从第一次发开发信那天起预热两周。
   */
  established?: { by?: PersonId; at: Iso8601 }
}

/** 主动开发的几样设置（一个品牌一份）。 */
export interface B2bOutboundSettings {
  /** 页脚上的公司名（不填用公司档案的全称）。 */
  company_name?: string
  /** 页脚上的公司实体地址（CAN-SPAM 硬要求）。**没有就不能发**。 */
  postal_address?: string
  /** 署名。 */
  sender_name?: string
  /** 想聊的产品线（开一轮时给的，下一轮沿用）。 */
  product?: string
  /** 「发信域名」那张卡的答案。`separate_pending` = 选了单独域名但还没接上那只邮箱。 */
  sender_choice?: 'separate' | 'primary' | 'separate_pending'
  /** 选定的发信邮箱。 */
  sender_address?: string
  /** 那张卡的 id（还没答时面板上指过去）。 */
  choice_card_id?: string
  /** 德国 / 奥地利：用户勾选并确认风险后才发（docs/84 §11.1 第 6 条）。 */
  de_at?: { confirmed_by: PersonId; confirmed_at: Iso8601 }
  updated_at?: Iso8601
}

/**
 * WP176（Luoye 09-28）：说过「不感兴趣」的人**只停这一轮**，进冷却——冷却期内不进任何新一轮，
 * 期满可以再被选进新一轮。**不进永久抑制名单**（退订与硬退信才进，不变）。
 *
 * 按地址哈希记（同抑制名单的口径：同一个人换了联系人记录也认得出）。同一个人第二次说不感兴趣
 * 冷却翻倍（90 → 180 天），第三次再翻倍。
 */
export interface B2bDeclineCooldown {
  /** `sha256(suppressionKey(地址))`，与抑制名单同一个口径。 */
  key_hash: string
  masked: string
  contact_id?: string
  /** 第几次说不感兴趣（1 起）。 */
  count: number
  /** 这一次冷却多少天（90 / 180 …）。 */
  days: number
  declined_at: Iso8601
  /** 冷却到哪天（这之前不进任何新一轮）。 */
  until: Iso8601
  /** 从哪封信认出来的（消息库 id）。 */
  message_id?: string
}

/** WP176：「不感兴趣」的冷却天数默认值（职责阈值 `b2b_declined_cooldown_days` 可改）。 */
export const B2B_DECLINED_COOLDOWN_DAYS = 90

/**
 * WP176：DKIM 兜底时按顺序查的常见选择器（`<选择器>._domainkey.<域名>` 的 TXT）。
 * Google Workspace 是 `google`，Microsoft 365 是 `selector1` / `selector2`，Mailchimp / Mandrill 是 `k1`，
 * 其余是常见服务商的默认写法。
 */
export const B2B_DKIM_SELECTORS: readonly string[] = [
  'google',
  'selector1',
  'selector2',
  'k1',
  'k2',
  's1',
  's2',
  'default',
  'dkim',
  'mail',
  'zoho',
]

/**
 * 默认不发开发信的国家（ISO 两位码）：德国、奥地利。**只拦没有往来的潜在客户**，
 * 已有往来的照常出卡（Fable 09-28，WP170 终审）。
 */
export const B2B_EXCLUDED_COUNTRIES: readonly string[] = ['DE', 'AT']

/** 卡上那一句原因（docs/84 §11.1 第 6 条：告诉用户为什么）。 */
export const B2B_DE_AT_REASON = '两国法院常把未经同意的 B2B 冷邮件判为违法'

/**
 * WP173：「发信域名」那张选择题卡的审批种类（docs/84 §11.1 第 4 条：**建议而不强制**，
 * 由用户选；不问不设）。payload = `{ options, recommended, primary_domains }`。
 */
export const B2B_SENDER_CHOICE_KIND = 'b2b_sender_choice' as const
