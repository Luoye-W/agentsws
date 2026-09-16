/**
 * 社媒库那一面的 actor（WP73；与 `KolActor` 同形状，但**不共用**）。
 *
 * 单独一个文件是为了让 `social.ts` 与将来可能拆出去的日历 / 群发路由都能
 * 引它，而不必互相 import 一整个路由模块。
 *
 * 为什么不与 `KolActor` 合成一个 `Actor`：两边的"能不能动"由**不同的**
 * 对象域决定（红人那边是 `creator` / `collaboration`，社媒这边是
 * `social_account` / `community_member` / `community_thread`）。类型一样不代表
 * 语义一样，合成一个之后，哪天有人给红人那边加一格，社媒这边会跟着变。
 */
import type { AssignmentId, PersonId, RoleId, WorkspaceId } from '@agentsws/contracts'

export interface SocialActor {
  workspace_id: WorkspaceId
  person_id: PersonId
  /** 本次绑定的那条分配（31 §3.1）——额度、等级与"能不能动"全从它来。 */
  assignment_id: AssignmentId
  role_id: RoleId
}
