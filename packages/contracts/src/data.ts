import type { Iso8601, PersonId, RangeRef, Sensitivity, WorkspaceId } from './common.js'
import type { EventEnvelope } from './events.js'
import type { PermissionScope } from './roles.js'

/** 21 §2 业务记录信封。09-08：owners[]（首位主 owner），授权关系另建表。 */
export interface RecordEnvelope {
  id: string
  schema_version: number
  workspace_id: WorkspaceId
  owners: PersonId[]
  scope: RangeRef[]
  sensitivity: Sensitivity
  source?: { package?: string; connector?: string; external_id?: string }
  created_at: Iso8601
  updated_at: Iso8601
  /** 乐观锁 */
  version: string
}

export type DataRecord<T> = RecordEnvelope & T

/**
 * 数据层访问：所有读写经此；查询在数据层按 actor 过滤，不在应用层。
 * 09-09（WP2 审核）：Actor 携带**当次 Assignment** 的 grants 与 ranges，原样生效，不跨 Assignment 并集（31 §3.1）。
 */
export interface Actor {
  person_id: PersonId
  assignment_id: string
  workspace_id: WorkspaceId
  grants: readonly PermissionScope[]
  ranges: readonly RangeRef[]
}

/** 21 §4 墓碑事件载荷 */
export interface PrivacyErasedPayload {
  subject: { collection: string; id: string }
  key_id: string
  destroyed_at: Iso8601
  erased_fields: string[]
}
export type PrivacyErasedEvent = Omit<EventEnvelope<'privacy.erased', PrivacyErasedPayload>, 'id'>

export interface DataStore {
  get<T>(collection: string, id: string, actor: Actor): Promise<DataRecord<T> | undefined>
  query<T>(
    collection: string,
    filter: Record<string, unknown>,
    actor: Actor,
    opts?: { limit?: number; cursor?: string },
  ): Promise<{ items: DataRecord<T>[]; cursor?: string }>
  put<T>(
    collection: string,
    rec: Omit<DataRecord<T>, 'created_at' | 'updated_at' | 'version'> & { version?: string },
    actor: Actor,
  ): Promise<DataRecord<T>>
  /** 21 §4：销毁主体密钥 + 返回墓碑事件（调用方写入事件日志）；不删记录不删事件 */
  erase(subject: { collection: string; id: string }, actor: Actor): Promise<PrivacyErasedEvent>
  /** 备份恢复后重放墓碑，幂等 */
  replayTombstones(
    events: readonly PrivacyErasedEvent[],
  ): Promise<{ applied: number; skipped: number }>
  /** 21 §4 可携带权：该主体的全部记录（按 actor 权限） */
  exportSubject(
    subject: { collection: string; id: string },
    actor: Actor,
  ): Promise<DataRecord<unknown>[]>
}
