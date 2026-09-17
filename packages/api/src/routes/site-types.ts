/**
 * 建站那一面的 actor（WP77；与 `SocialActor` 同形状，但**不共用**）。
 *
 * 单独一个文件的理由与 `social-types.ts` 逐字相同：路由模块之间不必互相 import
 * 一整个文件才能拿到这个形状。
 *
 * 为什么不与 `SocialActor` / `KolActor` 合成一个 `Actor`：三边的"能不能动"由
 * **不同的**对象域决定（建站这边是 `store_config` / `content`）。类型一样不代表
 * 语义一样——合成一个之后，哪天有人给社媒那边加一格，建站这边会跟着变。
 */
import type { AssignmentId, PersonId, RoleId, WorkspaceId } from '@agentsws/contracts'

export interface SiteActor {
  workspace_id: WorkspaceId
  person_id: PersonId
  /** 本次绑定的那条分配（31 §3.1）——额度、等级与"能不能动"全从它来。 */
  assignment_id: AssignmentId
  role_id: RoleId
}
