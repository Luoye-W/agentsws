/**
 * SQLite 档（25 §4「持久（SQLite 表），重启不丢」）。
 *
 * 纪律：
 * - 所有 SQL 参数化，没有一处字符串拼值
 * - 同步 API（`better-sqlite3`）——`ScheduleStore` 全同步，天然对上
 * - 只用自己这张库里的表，不共享其他包的表（35 §2）
 * - 时间只有迁移记一次，来自注入的 Clock
 */
import type { Clock } from '@agentsws/contracts'
import type { Database as Db } from 'better-sqlite3'
import Database from 'better-sqlite3'
import { type Migration, migrate, SCHEDULE_MIGRATIONS, schemaVersion } from './migrations.js'
import { isDue, isWakeable, matchInstance, matchTask } from './store.js'
import type {
  ScheduleFilter,
  ScheduleStore,
  ScheduleTask,
  WorkflowFilter,
  WorkflowInstanceRecord,
} from './types.js'

export interface SqliteScheduleStoreOptions {
  dbPath: string
  clock: Clock
  migrations?: readonly Migration[]
}

interface Row {
  json: string
}

export class SqliteScheduleStore implements ScheduleStore {
  readonly db: Db
  readonly schema_version: number

  constructor(options: SqliteScheduleStoreOptions) {
    this.db = new Database(options.dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    migrate(this.db, options.migrations ?? SCHEDULE_MIGRATIONS, options.clock.now())
    this.schema_version = schemaVersion(this.db)
  }

  putTask(task: ScheduleTask): void {
    this.db
      .prepare(
        `INSERT INTO tasks (id, workspace_id, owner, role_id, assignment_id, conversation_id,
                            handler, state, next_fire_at, json)
         VALUES (@id, @workspace_id, @owner, @role_id, @assignment_id, @conversation_id,
                 @handler, @state, @next_fire_at, @json)
         ON CONFLICT(id) DO UPDATE SET
           workspace_id = excluded.workspace_id,
           owner = excluded.owner,
           role_id = excluded.role_id,
           assignment_id = excluded.assignment_id,
           conversation_id = excluded.conversation_id,
           handler = excluded.handler,
           state = excluded.state,
           next_fire_at = excluded.next_fire_at,
           json = excluded.json`,
      )
      .run({
        id: task.id,
        workspace_id: task.workspace_id,
        owner: task.owner,
        role_id: task.role_id,
        assignment_id: task.assignment_id,
        conversation_id: task.origin?.conversation_id ?? null,
        handler: task.handler ?? null,
        state: task.state,
        next_fire_at: task.next_fire_at ?? null,
        json: JSON.stringify(task),
      })
  }

  getTask(id: string): ScheduleTask | undefined {
    const row = this.db.prepare<[string], Row>('SELECT json FROM tasks WHERE id = ?').get(id)
    return row === undefined ? undefined : (JSON.parse(row.json) as ScheduleTask)
  }

  listTasks(filter: ScheduleFilter): ScheduleTask[] {
    // 先按工作区在 SQL 里收窄，其余条件与内存档共用同一个判定函数（两档行为逐字一致）
    const rows = this.db
      .prepare<[string], Row>('SELECT json FROM tasks WHERE workspace_id = ? ORDER BY id')
      .all(filter.workspace_id)
    return rows.map((r) => JSON.parse(r.json) as ScheduleTask).filter((t) => matchTask(t, filter))
  }

  dueTasks(before: string): ScheduleTask[] {
    // 索引在 (state, next_fire_at) 上；判定与内存档共用 `isDue`，两档行为逐字一致
    const rows = this.db
      .prepare<[string], Row>(
        `SELECT json FROM tasks
          WHERE state IN ('pending', 'active', 'running')
            AND next_fire_at IS NOT NULL
            AND next_fire_at <= ?
          ORDER BY next_fire_at, id`,
      )
      .all(before)
    return rows.map((r) => JSON.parse(r.json) as ScheduleTask).filter((t) => isDue(t, before))
  }

  workspaces(): string[] {
    return this.db
      .prepare<[], { workspace_id: string }>(
        'SELECT DISTINCT workspace_id FROM tasks ORDER BY workspace_id',
      )
      .all()
      .map((r) => r.workspace_id)
  }

  deleteTask(id: string): void {
    this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id)
  }

  putInstance(instance: WorkflowInstanceRecord): void {
    this.db
      .prepare(
        `INSERT INTO instances (id, workspace_id, def_id, state, subject_type, subject_id,
                                conversation_id, json)
         VALUES (@id, @workspace_id, @def_id, @state, @subject_type, @subject_id,
                 @conversation_id, @json)
         ON CONFLICT(id) DO UPDATE SET
           workspace_id = excluded.workspace_id,
           def_id = excluded.def_id,
           state = excluded.state,
           subject_type = excluded.subject_type,
           subject_id = excluded.subject_id,
           conversation_id = excluded.conversation_id,
           json = excluded.json`,
      )
      .run({
        id: instance.id,
        workspace_id: instance.workspace_id,
        def_id: instance.def.id,
        state: instance.state,
        subject_type: instance.subject.type,
        subject_id: instance.subject.id,
        conversation_id: instance.conversation_id ?? null,
        json: JSON.stringify(instance),
      })
  }

  getInstance(id: string): WorkflowInstanceRecord | undefined {
    const row = this.db.prepare<[string], Row>('SELECT json FROM instances WHERE id = ?').get(id)
    return row === undefined ? undefined : (JSON.parse(row.json) as WorkflowInstanceRecord)
  }

  listInstances(filter: WorkflowFilter): WorkflowInstanceRecord[] {
    const rows = this.db
      .prepare<[string], Row>('SELECT json FROM instances WHERE workspace_id = ? ORDER BY id')
      .all(filter.workspace_id)
    return rows
      .map((r) => JSON.parse(r.json) as WorkflowInstanceRecord)
      .filter((i) => matchInstance(i, filter))
  }

  wakeableInstances(before: string): WorkflowInstanceRecord[] {
    return this.db
      .prepare<[], Row>("SELECT json FROM instances WHERE state = 'waiting' ORDER BY id")
      .all()
      .map((r) => JSON.parse(r.json) as WorkflowInstanceRecord)
      .filter((i) => isWakeable(i, before))
  }

  waitingInstances(): WorkflowInstanceRecord[] {
    return this.db
      .prepare<[], Row>(
        "SELECT json FROM instances WHERE state IN ('waiting', 'running') ORDER BY id",
      )
      .all()
      .map((r) => JSON.parse(r.json) as WorkflowInstanceRecord)
  }

  close(): void {
    this.db.close()
  }
}

export function createSqliteScheduleStore(
  options: SqliteScheduleStoreOptions,
): SqliteScheduleStore {
  return new SqliteScheduleStore(options)
}
