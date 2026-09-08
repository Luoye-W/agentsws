/** Assignment / WorkspacePolicy 的存储后端：内存默认，给了 dbPath 就用 SQLite（同步 API）。 */
import { createRequire } from 'node:module'
import type { Assignment, AssignmentId, WorkspaceId, WorkspacePolicy } from '@agentsws/contracts'
import type BetterSqlite3 from 'better-sqlite3'

export interface AssignmentFilter {
  person_id?: string
  role_id?: string
  workspace_id?: string
  include_revoked?: boolean
}

export interface StoreBackend {
  putAssignment(assignment: Assignment): void
  getAssignment(id: AssignmentId): Assignment | undefined
  listAssignments(filter: AssignmentFilter): Assignment[]
  countAssignments(): number
  putPolicy(policy: WorkspacePolicy): void
  getPolicy(workspaceId: WorkspaceId): WorkspacePolicy | undefined
  close(): void
}

const clone = <T>(value: T): T => structuredClone(value)

function matches(a: Assignment, f: AssignmentFilter): boolean {
  if (f.person_id !== undefined && a.person_id !== f.person_id) return false
  if (f.role_id !== undefined && a.role_id !== f.role_id) return false
  if (f.workspace_id !== undefined && a.workspace_id !== f.workspace_id) return false
  if (!f.include_revoked && a.revoked_at) return false
  return true
}

export function createMemoryBackend(): StoreBackend {
  const assignments = new Map<AssignmentId, Assignment>()
  const policies = new Map<WorkspaceId, WorkspacePolicy>()
  return {
    putAssignment(assignment) {
      assignments.set(assignment.id, clone(assignment))
    },
    getAssignment(id) {
      const found = assignments.get(id)
      return found ? clone(found) : undefined
    },
    listAssignments(filter) {
      return [...assignments.values()].filter((a) => matches(a, filter)).map(clone)
    },
    countAssignments() {
      return assignments.size
    },
    putPolicy(policy) {
      policies.set(policy.workspace_id, clone(policy))
    },
    getPolicy(workspaceId) {
      const found = policies.get(workspaceId)
      return found ? clone(found) : undefined
    },
    close() {
      assignments.clear()
      policies.clear()
    },
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS assignments (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  revoked_at TEXT,
  doc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS assignments_person ON assignments(person_id, workspace_id);
CREATE INDEX IF NOT EXISTS assignments_role ON assignments(role_id, workspace_id);
CREATE TABLE IF NOT EXISTS workspace_policies (
  workspace_id TEXT PRIMARY KEY,
  doc TEXT NOT NULL
);
`

/** 惰性 require：内存模式下不碰原生模块。 */
function openDatabase(dbPath: string): BetterSqlite3.Database {
  const require = createRequire(import.meta.url)
  const Database = require('better-sqlite3') as typeof BetterSqlite3
  return new Database(dbPath)
}

export function createSqliteBackend(dbPath: string): StoreBackend {
  const db = openDatabase(dbPath)
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA)
  const insert = db.prepare(
    `INSERT INTO assignments (id, person_id, workspace_id, role_id, revoked_at, doc)
     VALUES (@id, @person_id, @workspace_id, @role_id, @revoked_at, @doc)
     ON CONFLICT(id) DO UPDATE SET
       person_id = excluded.person_id,
       workspace_id = excluded.workspace_id,
       role_id = excluded.role_id,
       revoked_at = excluded.revoked_at,
       doc = excluded.doc`,
  )
  const selectOne = db.prepare('SELECT doc FROM assignments WHERE id = ?')
  const countAll = db.prepare('SELECT COUNT(*) AS n FROM assignments')
  const putPolicyStmt = db.prepare(
    `INSERT INTO workspace_policies (workspace_id, doc) VALUES (?, ?)
     ON CONFLICT(workspace_id) DO UPDATE SET doc = excluded.doc`,
  )
  const getPolicyStmt = db.prepare('SELECT doc FROM workspace_policies WHERE workspace_id = ?')

  const parse = (row: unknown): Assignment => JSON.parse((row as { doc: string }).doc) as Assignment

  return {
    putAssignment(assignment) {
      insert.run({
        id: assignment.id,
        person_id: assignment.person_id,
        workspace_id: assignment.workspace_id,
        role_id: assignment.role_id,
        revoked_at: assignment.revoked_at ?? null,
        doc: JSON.stringify(assignment),
      })
    },
    getAssignment(id) {
      const row = selectOne.get(id)
      return row ? parse(row) : undefined
    },
    listAssignments(filter) {
      const where: string[] = []
      const params: string[] = []
      if (filter.person_id !== undefined) {
        where.push('person_id = ?')
        params.push(filter.person_id)
      }
      if (filter.role_id !== undefined) {
        where.push('role_id = ?')
        params.push(filter.role_id)
      }
      if (filter.workspace_id !== undefined) {
        where.push('workspace_id = ?')
        params.push(filter.workspace_id)
      }
      if (!filter.include_revoked) where.push('revoked_at IS NULL')
      const sql = `SELECT doc FROM assignments${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id`
      return db
        .prepare(sql)
        .all(...params)
        .map(parse)
    },
    countAssignments() {
      return (countAll.get() as { n: number }).n
    },
    putPolicy(policy) {
      putPolicyStmt.run(policy.workspace_id, JSON.stringify(policy))
    },
    getPolicy(workspaceId) {
      const row = getPolicyStmt.get(workspaceId)
      return row ? (JSON.parse((row as { doc: string }).doc) as WorkspacePolicy) : undefined
    },
    close() {
      db.close()
    },
  }
}
