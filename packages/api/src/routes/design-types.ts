/**
 * 设计库那一面的 actor（WP76；与 `SocialActor` / `KolActor` 同形状，但**不共用**）。
 *
 * 单独一个文件是为了让 `design.ts` 与将来可能拆出去的素材库路由都能引它，
 * 而不必互相 import 一整个路由模块。
 *
 * 为什么不与 `SocialActor` 合成一个 `Actor`：两边的"能不能动"由**不同的**
 * 对象域决定（社媒那边是 `social_account` / `community_*`，设计这边是
 * `design_request` / `design_brief` / `design_asset`）。类型一样不代表语义一样，
 * 合成一个之后，哪天有人给社媒那边加一格，设计这边会跟着变。
 */
import type { AssignmentId, PersonId, RoleId, WorkspaceId } from '@agentsws/contracts'

export interface DesignActor {
  workspace_id: WorkspaceId
  person_id: PersonId
  /** 本次绑定的那条分配（31 §3.1）——额度、等级与"能不能动"全从它来。 */
  assignment_id: AssignmentId
  role_id: RoleId
}
