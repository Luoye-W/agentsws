/**
 * 建站那一侧的三类对象（59 §1 / §2，WP77）。
 *
 * 为什么它们要住在契约里而不是服务进程里：与社媒那四类同一条理由——
 * 面板（`@agentsws/deck`）、`/v1/site/*` 的路由、模拟世界与记录源四处都要认
 * 同一个形状。写四份的后果不是麻烦，是**四份会各自漂移**。
 *
 * 三类各答一个问题：
 *
 * | 对象 | 它回答 |
 * |---|---|
 * | {@link LaunchCheckRun} | 上一次上线巡检查出了什么（**一次巡检的结论**，不是店里的某条记录） |
 * | {@link ShopEmailTemplate} | 这封通知邮件现在长什么样、启用了没有 |
 * | {@link ShopAppRecord} | 这个第三方 App 装在店上没有、要了哪些权限 |
 *
 * 三类里**一格凭据都没有**。App 的 API key 走连接页那条路（`connection_id` 指过去），
 * 与 `SocialAccount` 的纪律逐字相同。
 */
import type { Iso8601, RoleId, WorkspaceId } from './common.js'

/** 建站岗位的四条职责 id，按出场顺序（岗位模板 `positions/site.yml` 与 `BUNDLED_ROLES` 读它）。 */
export const SITE_ROLE_IDS: readonly RoleId[] = [
  'site.shopify-build',
  'site.shopify-theme',
  'site.shopify-email',
  'site.shopify-apps',
]

/** 上线检查单上那一格的结论。`unknown` 是**没读到**，与"缺"是两件事。 */
export type LaunchItemState = 'ok' | 'missing' | 'unknown'

/** 缺了它能不能开门。 */
export type LaunchItemSeverity = 'blocker' | 'warning'

/** 检查单上的一格（落库的那一份；纯函数算出来的形状见 `@agentsws/site-core`）。 */
export interface LaunchCheckItemRow {
  id: string
  title: { zh: string; en: string }
  state: LaunchItemState
  severity: LaunchItemSeverity
  detail: { zh: string; en: string }
  fix: { zh: string; en: string }
  /**
   * 谁来补。**没有 = 建站岗位补不了**（支付 / 税，51 §3 N2）——
   * 界面上那句"去后台自己点"读的就是这一格为空。
   */
  fixable_by?: RoleId
}

/** 一次上线巡检的结论。id 就是这次巡检的 id（一次一条，不覆盖上一次）。 */
export interface LaunchCheckRun {
  id: string
  schema_version: 1
  workspace_id: WorkspaceId
  /** 查的是哪家店（连接的 identity，不是店铺域名的明文凭据）。 */
  shop?: string
  items: LaunchCheckItemRow[]
  blockers: number
  warnings: number
  /** 一个 blocker 都没有 = 能开门（warning 不拦）。 */
  ready: boolean
  /** 缺的政策页 handle。 */
  missing_policies: string[]
  /** 缺的必装 App id。 */
  missing_apps: string[]
  /** 这条巡检开出来的那张卡（`launch_check`，L3）。 */
  approval_item_id?: string
  checked_at: Iso8601
}

/** 一份通知邮件模板的现状。 */
export interface ShopEmailTemplate {
  /** 就是 Shopify 的通知类型 handle（`order_confirmation` …）。一种通知一条。 */
  id: string
  schema_version: 1
  workspace_id: WorkspaceId
  notification_type: string
  name: { zh: string; en: string }
  subject: string
  /** Liquid 正文。**外部文本**：原样存、原样端出去，不在任何一层改写。 */
  body: string
  /** `true` = 店里现在真在用这一份。改成 `true` 的那一下永远人审。 */
  enabled: boolean
  /** 上一次自查缺了哪几个必需变量（空 = 齐了）。 */
  missing_variables: string[]
  /** 还没批下来的那张模板卡。 */
  pending_change_id?: string
  updated_at: Iso8601
}

/** 一个第三方 App 在这家店上的现状。 */
export interface ShopAppRecord {
  /** App 目录里的 id（`judge-me` / `klaviyo` …）；目录里没有的用平台给的 handle。 */
  id: string
  schema_version: 1
  workspace_id: WorkspaceId
  name: string
  installed: boolean
  /** 目录里认不认识它。`false` = 店里装了个我们不认识的 App，照样要列出来。 */
  known: boolean
  /** 它要了哪些权限（平台的 scope 串）。 */
  scopes?: string[]
  /**
   * 装上它之后连接目录里哪一个 kind 才连得上。
   *
   * **装上它**与**我们连不连得上它的 API** 是两件事（59 §2）：
   * 一家店可以装了 Judge.me 却没把 API key 给我们。
   */
  directory_kind?: string
  /** 真连上了的那条连接（连接页那一侧建的）。**这里没有凭据。** */
  connection_id?: string
  installed_at?: Iso8601
  updated_at: Iso8601
}
