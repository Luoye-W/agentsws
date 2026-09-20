/**
 * 增值服务的**订阅**（67 §3，WP118）——一份引擎，多个服务。
 *
 * Luoye 09-19 的后续定论：同价同机制还会有一个「客服增值服务」（WP124）。所以这
 * 一套从一开始就**不是红人专用**的：订阅的状态机、幂等扣费、宽限、取消、赠送，
 * 全部只认一个 `service_id`；红人营销增值服务只是它的**第一个实例**。
 *
 * 为什么不等到第二个服务出现再抽：第一个实例把状态机写死在自己的名字里之后，
 * 第二个服务要么复制一份（于是宽限期的 bug 要修两遍），要么在 rename 的过程中
 * 改动已经上线的那张库表。两条都比现在多花十倍力气。
 *
 * 三件事写在这里，不写在任何一个服务里：
 *
 * 1. **状态只有五个**，见 {@link SubscriptionStatus}；
 * 2. **余额不足不删数据**——进宽限，{@link SUBSCRIPTION_GRACE_DAYS} 天，过了也只是
 *    暂停。删数据的按钮只在用户自己手里；
 * 3. **幂等键不含时间戳**，见 `@agentsws/metering` 的 `chargeKeyOf`。
 */

import type { Iso8601 } from './common.js'

/* ------------------------------------------------------------------ */
/* 服务登记表                                                           */
/* ------------------------------------------------------------------ */

/** 红人营销增值服务（WP118 实现）。30 积分 / 月。 */
export const KOL_SERVICE_ID = 'kol.service.monthly'

/**
 * 客服增值服务（WP124 实现，**本轮只登记不接业务**）。同样 30 积分 / 月。
 *
 * 登记在先是有意的：价目表、后台的订阅列表、扣费的定时任务都按登记表遍历，
 * 所以 WP124 落地时**一行引擎代码都不用改**——只要把 `available` 翻成 true。
 */
export const SUPPORT_SERVICE_ID = 'support.service.monthly'

/**
 * 一个按月订阅的增值服务（`subscriptions.json` 里的一行）。
 *
 * `id` 同时就是价目表里那条能力的名字（`pricing.json` 的 `capability`）——
 * 两张表用同一个字符串，对不上的时候是一条能测出来的错，而不是一笔算错的钱。
 */
export interface SubscriptionService {
  /** 服务 id，同时是计费能力名（`kol.service.monthly`）。 */
  id: string
  /** 每月多少积分。 */
  credits_per_month: number
  label_zh: string
  label_en: string
  /**
   * 现在能不能订。`false` = 登记了但还没做（界面上灰着，写"即将上线"，
   * 后端一律拒——**不是**收了钱给不出服务）。
   */
  available: boolean
  note_zh?: string
}

/** `subscriptions.json` 的形状。 */
export interface SubscriptionServices {
  version: number
  as_of: Iso8601
  services: SubscriptionService[]
}

/* ------------------------------------------------------------------ */
/* 订阅状态                                                             */
/* ------------------------------------------------------------------ */

/**
 * 余额不足之后还能拖多少天。
 *
 * 30 天不是随手写的：用户这个月没充上钱，不该第二天就看不到自己的红人库。
 * 宽限期内**服务暂停、数据一条不动**；过了宽限期仍然只是暂停（`suspended`），
 * 依旧不删——删数据的按钮只在用户自己手里。
 */
export const SUBSCRIPTION_GRACE_DAYS = 30

/**
 * 订阅现在是什么状态。
 *
 * - `none`：从来没开通过（或者已经彻底结束了）。
 * - `active`：正常。
 * - `grace`：这一期的钱没扣上（余额不足），在 30 天宽限里——服务暂停，数据不动。
 * - `suspended`：宽限期过了，还是没充上钱。服务仍然停、数据仍然不动。
 * - `cancelling`：用户点了取消，**当期用完为止**（`current_cycle_end` 之前照常用）。
 *
 * 为什么把 `grace` 与 `suspended` 分开：前者界面上是一句提醒，后者是一张要人
 * 拍板的卡（充值 / 导出 / 删除三个选项）。合成一态就没法区分这两句话。
 */
export type SubscriptionStatus = 'none' | 'active' | 'grace' | 'suspended' | 'cancelling'

export const SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = [
  'none',
  'active',
  'grace',
  'suspended',
  'cancelling',
]

/**
 * 这个状态下服务能不能用。只有 `active` 与 `cancelling` 能。
 *
 * 写成一个函数而不是让每个调用方自己 `=== 'active'`：漏掉 `cancelling` 的那一种
 * 写法会把"这个月已经付过钱、点了取消"的用户当场断掉，而那是我们收了钱不给服务。
 */
export function subscriptionUsable(status: SubscriptionStatus): boolean {
  return status === 'active' || status === 'cancelling'
}

/**
 * 一个组织在一个服务上的订阅。
 *
 * 时间字段全是可选的，因为 `none` 那一态什么都没有——写成必填就得塞一个假日期，
 * 而假日期会被当真日期算出一个假的 cycle。
 */
export interface ServiceSubscription {
  org_id: string
  /** 哪个服务（{@link KOL_SERVICE_ID} / {@link SUPPORT_SERVICE_ID} …）。 */
  service_id: string
  status: SubscriptionStatus
  /** 第一次开通的时刻。取消再开通不改它（用来回答「用了多久」）。 */
  started_at?: Iso8601
  /**
   * 算所有 cycle 边界的锚点。**取消再开通会换一个新的**，但调档不换
   * （65 §7 第 3 条：换档沿用旧 anchor，否则这个月会扣两次）。
   */
  anchor_at?: Iso8601
  current_cycle_start?: Iso8601
  current_cycle_end?: Iso8601
  /** 用户点过取消（当期用完为止）。等价于 `status === 'cancelling'`，但存下来便于审计。 */
  cancel_at_period_end: boolean
  /** 从哪一刻开始欠着这一期（余额不足那一刻）。 */
  unpaid_since?: Iso8601
  /** 宽限到哪天。`unpaid_since + 30 天`。 */
  grace_until?: Iso8601
  /** 运营后台赠送还剩几个月。赠送的那些 cycle **不扣钱**。 */
  granted_months: number
  last_charge_at?: Iso8601
  /** 最后扣成功的那个 cycle 的起点（幂等的可读版本，真幂等靠 charge key）。 */
  last_charged_cycle_start?: Iso8601
  updated_at: Iso8601
}

/** 一个没开通过的组织长什么样。**不是** `undefined`——界面上那张卡总要有东西渲染。 */
export function emptySubscription(
  org_id: string,
  service_id: string,
  at: Iso8601,
): ServiceSubscription {
  return {
    org_id,
    service_id,
    status: 'none',
    cancel_at_period_end: false,
    granted_months: 0,
    updated_at: at,
  }
}

/**
 * 一条扣费记录（后台看得见的那一行）。
 *
 * 留着 `failed` 的那些是有意的：用户来问"你们是不是把我停了"，我们要能答
 * "2 月 3 日那一期扣不上，余额 4 积分、要 30"，而不是"库里没有这条记录"。
 */
export interface SubscriptionCharge {
  org_id: string
  service_id: string
  cycle_start: Iso8601
  cycle_end: Iso8601
  /** 幂等键。同一个 cycle 在任何一次计算里都是同一串。 */
  charge_key: string
  credits: number
  /** 是不是赠送月抵掉的（`credits` 为 0）。 */
  granted: boolean
  status: 'paid' | 'failed'
  /** 扣不上的原因（人话，直接进界面）。 */
  reason?: string
  at: Iso8601
}
