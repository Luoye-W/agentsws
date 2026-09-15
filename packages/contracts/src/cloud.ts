/**
 * 49 M1 统一账号：云账号（人）→ 云侧组织（计费主体）→ 工作区关联令牌。
 *
 * 三个对象与一条纪律：
 *
 * - **`CloudAccount`**（人）= 首次设置里的那个登录邮箱（46）。登录复用 20 的 magic link。
 * - **`CloudOrg`**（计费主体）= 52 §2 O3「人 / 钱 / 发现在组织级」里的那个组织。
 *   第一次登录时**隐式**建一个以邮箱命名的组织——界面上不露"组织"这个词，
 *   一个人只有"一个 agentsws 账号、一个余额"（49 §0）。
 * - **`WorkspaceLink`**（工作区关联）= 本地一个工作区与云侧一个组织之间的那把
 *   **工作区服务令牌**。18 §1 的令牌纪律逐条照搬：**短期**（默认 90 天可续期）、
 *   **最小动作集**（`scopes`，本版只有三个）、**可撤**（`revoked_at` 是一列，不是删行）。
 *
 * 纪律：**这里没有任何令牌明文**。库里只存 `token_sha256`，明文只在签发那一刻
 * 返回一次（21 §5 秘密不落库）；事件 payload 里只有邮箱**域名**与组织 id，
 * 邮箱本地部分与令牌一个字节都不进（21 §1）。
 */

import type { Iso8601, WorkspaceId } from './common.js'

export type CloudAccountId = string
export type CloudOrgId = string
export type WorkspaceLinkId = string

/** 49 M1：云账号就是一个邮箱，没有别的。密码不存在——登录只有 magic link。 */
export interface CloudAccount {
  id: CloudAccountId
  email: string
  created_at: Iso8601
}

/** 52 O3：组织里的一个人。本版只有 owner 与 member 两档（付钱的是 owner）。 */
export interface CloudOrgMember {
  account_id: CloudAccountId
  role: 'owner' | 'member'
  joined_at: Iso8601
}

/**
 * 52 O3 的计费主体。**余额挂在它上面**，不挂在人上，也不挂在工作区上——
 * 团队版由 owner 一个账号付，成员用工作区令牌（49 M1）。
 */
export interface CloudOrg {
  id: CloudOrgId
  name: string
  owner_account_id: CloudAccountId
  members: CloudOrgMember[]
  created_at: Iso8601
}

/**
 * 18 §1「最小动作集」：一把工作区令牌能做什么，逐条列出来，没列的一律不行。
 *
 * - `ai`：走服务入口的模型调用（`/v1/ai/*`，WP59）。
 * - `wallet:read`：**只读**余额与用量（`/v1/wallet/*` 的读面）。充值 / 退款不在令牌能做的事里。
 * - `standby`：在线值守（WP60）。
 *
 * 本版五个（WP59 合并时把钱包拆成 read / topup / admin）；加能力就加成员（只加不删）。
 */
export type CloudScope = 'ai' | 'wallet:read' | 'wallet:topup' | 'wallet:admin' | 'standby'

export const CLOUD_SCOPES: readonly CloudScope[] = [
  'ai',
  'wallet:read',
  'wallet:topup',
  'wallet:admin',
  'standby',
]

/** 新签一把令牌时默认给的动作集：能用模型、能看余额，不能值守。 */
export const DEFAULT_CLOUD_SCOPES: readonly CloudScope[] = ['ai', 'wallet:read', 'wallet:topup']

/** 工作区服务令牌的前缀。一眼能认出来是什么，也方便在日志里做前缀级的屏蔽。 */
export const WORKSPACE_TOKEN_PREFIX = 'wst_'

/** 18 §1「短期」：默认 90 天，到期前续期。 */
export const DEFAULT_WORKSPACE_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000

/**
 * 一个本地工作区与一个云侧组织的关联。
 *
 * `token_sha256` 是**唯一**留在库里的令牌痕迹；明文在 `IssuedWorkspaceToken` 里
 * 出现一次就没了。续期 = 换一把新的（同一条关联换 hash 与 `expires_at`），
 * 撤销 = 写 `revoked_at`（**不删行**：谁在什么时候撤的必须留痕，40 §1）。
 */
export interface WorkspaceLink {
  id: WorkspaceLinkId
  workspace_id: WorkspaceId
  cloud_org_id: CloudOrgId
  /** 给人看的名字（"我的 MacBook 上的女装品牌"）；没填就用工作区 id。 */
  label: string
  token_sha256: string
  scopes: CloudScope[]
  created_at: Iso8601
  created_by: CloudAccountId
  expires_at: Iso8601
  revoked_at?: Iso8601
  /** 最近一次验令牌成功的时间；从没用过就没有这一格（不要用 created_at 冒充）。 */
  last_used_at?: Iso8601
}

/** 签发 / 续期的返回：明文**只在这里出现一次**，之后哪儿都查不到。 */
export interface IssuedWorkspaceToken {
  link: WorkspaceLink
  /** `wst_…`。不进日志、不进事件、不进 OpenAPI 示例。 */
  token: string
}

/**
 * 一把令牌验过之后的样子。
 *
 * 这是 WP59 的服务入口路由包唯一需要知道的东西：谁的账号、哪个组织（钱从这里扣）、
 * 哪个工作区（计量按它分）、能做哪些动作。
 */
export interface VerifiedCloudToken {
  account_id: CloudAccountId
  org_id: CloudOrgId
  workspace_id: WorkspaceId
  scopes: CloudScope[]
}

/**
 * 49 M3 服务入口验令牌的那一跳，写成一个**纯函数**。
 *
 * 之所以是函数而不是一个类：WP59 的路由包（`packages/cloud-entry`）只该依赖
 * "给我一串 token，告诉我它代表谁"，不该知道账号库长什么样、是不是 SQLite、
 * 在不在同一个进程里。撤销了 / 过期了 / 根本不存在，一律回 `undefined`
 * ——**不区分**，免得被拿来探测哪把令牌存在过。
 */
export type CloudTokenVerifier = (token: string) => Promise<VerifiedCloudToken | undefined>

/**
 * 本地事件 `cloud.account_linked` 的 payload。
 *
 * **只有邮箱域名**（`example.com`，不是 `me@example.com`）与组织 id：
 * 事件日志是工作区里所有人都可能看到的东西，owner 的私人邮箱不该在里面（21 §1）。
 * 令牌明文与哈希都不进。
 */
export interface CloudAccountLinkedPayload {
  /** 邮箱的 `@` 之后那一半。 */
  email_domain: string
  cloud_org_id: CloudOrgId
  scopes: CloudScope[]
  expires_at: Iso8601
}

/** `cloud.account_unlinked`：解除关联。`revoked_on_cloud` = 云侧那一刀切成功没有。 */
export interface CloudAccountUnlinkedPayload {
  email_domain: string
  cloud_org_id: CloudOrgId
  revoked_on_cloud: boolean
}

/** `me@example.com` → `example.com`；不像邮箱就回 `unknown`（不回原串）。 */
export function emailDomain(email: string): string {
  const at = email.lastIndexOf('@')
  if (at <= 0 || at === email.length - 1) return 'unknown'
  return email.slice(at + 1).toLowerCase()
}
