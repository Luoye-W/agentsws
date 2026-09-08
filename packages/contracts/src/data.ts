import type { Iso8601, PersonId, RangeRef, Sensitivity, WorkspaceId } from './common.js'

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

/** 数据层访问：所有读写经此；查询在数据层按 actor 过滤（Casbin），不在应用层。 */
export interface Actor {
  person_id: PersonId
  assignment_id: string
  workspace_id: WorkspaceId
}

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
  /** 21 §4：销毁主体密钥 + 墓碑事件；不删事件 */
  erase(subject: { collection: string; id: string }, actor: Actor): Promise<void>
}
