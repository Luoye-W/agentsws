/**
 * 广告库那一面的 actor（WP75；与 `SocialActor` / `KolActor` 同形状，但**不共用**）。
 *
 * 为什么不合成一个 `Actor`：三边的"能不能动"由**不同的**对象域决定（红人那边是
 * `creator` / `collaboration`，社媒那边是 `social_account` / `community_thread`，
 * 这边是 `ad_account` / `pixel_event`）。类型一样不代表语义一样，合成一个之后，
 * 哪天有人给其中一边加一格，另外两边会跟着变。
 */
import type { AssignmentId, PersonId, RoleId, WorkspaceId } from '@agentsws/contracts'

export interface AdsActor {
  workspace_id: WorkspaceId
  person_id: PersonId
  /** 本次绑定的那条分配（31 §3.1）——额度、等级与"能不能动"全从它来。 */
  assignment_id: AssignmentId
  role_id: RoleId
}
