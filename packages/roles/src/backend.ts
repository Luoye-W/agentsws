/** Assignment / WorkspacePolicy 的存储后端：内存默认，给了 dbPath 就用 SQLite（同步 API）。 */
import { createRequire } from 'node:module'
import type {
  Assignment,
  AssignmentId,
  ProductLine,
  RangeGroup,
  WorkspaceId,
  WorkspacePolicy,
} from '@agentsws/contracts'
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
  /** 44 G1 范围组（品牌）。 */
  putRangeGroup(group: RangeGroup): void
  getRangeGroup(id: string): RangeGroup | undefined
  listRangeGroups(workspaceId?: WorkspaceId): RangeGroup[]
  deleteRangeGroup(id: string): void
  /** 44 G2 产品线。 */
  putProductLine(line: ProductLine): void
  getProductLine(id: string): ProductLine | undefined
  listProductLines(workspaceId?: WorkspaceId): ProductLine[]
  deleteProductLine(id: string): void
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
  const groups = new Map<string, RangeGroup>()
  const lines = new Map<string, ProductLine>()
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
    putRangeGroup(group) {
      groups.set(group.id, clone(group))
    },
    getRangeGroup(id) {
      const found = groups.get(id)
      return found ? clone(found) : undefined
    },
    listRangeGroups(workspaceId) {
      return [...groups.values()]
        .filter((g) => workspaceId === undefined || g.workspace_id === workspaceId)
        .map(clone)
        .sort((a, b) => a.id.localeCompare(b.id))
    },
    deleteRangeGroup(id) {
      groups.delete(id)
    },
    putProductLine(line) {
      lines.set(line.id, clone(line))
    },
    getProductLine(id) {
      const found = lines.get(id)
      return found ? clone(found) : undefined
    },
    listProductLines(workspaceId) {
      return [...lines.values()]
        .filter((l) => workspaceId === undefined || l.workspace_id === workspaceId)
        .map(clone)
        .sort((a, b) => a.id.localeCompare(b.id))
    },
    deleteProductLine(id) {
      lines.delete(id)
    },
    close() {
      assignments.clear()
      policies.clear()
      groups.clear()
      lines.clear()
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
CREATE TABLE IF NOT EXISTS range_groups (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  doc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS range_groups_workspace ON range_groups(workspace_id);
CREATE TABLE IF NOT EXISTS product_lines (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  doc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS product_lines_workspace ON product_lines(workspace_id);
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

  /** 44 G1/G2：范围组与产品线的两张表长得一样，SQL 也就长得一样。 */
  const docTable = <T extends { id: string; workspace_id: string }>(table: string) => {
    const put = db.prepare(
      `INSERT INTO ${table} (id, workspace_id, doc) VALUES (@id, @workspace_id, @doc)
       ON CONFLICT(id) DO UPDATE SET workspace_id = excluded.workspace_id, doc = excluded.doc`,
    )
    const one = db.prepare(`SELECT doc FROM ${table} WHERE id = ?`)
    const all = db.prepare(`SELECT doc FROM ${table} ORDER BY id`)
    const byWorkspace = db.prepare(`SELECT doc FROM ${table} WHERE workspace_id = ? ORDER BY id`)
    const drop = db.prepare(`DELETE FROM ${table} WHERE id = ?`)
    const read = (row: unknown): T => JSON.parse((row as { doc: string }).doc) as T
    return {
      put(doc: T): void {
        put.run({ id: doc.id, workspace_id: doc.workspace_id, doc: JSON.stringify(doc) })
      },
      get(id: string): T | undefined {
        const row = one.get(id)
        return row ? read(row) : undefined
      },
      list(workspaceId?: string): T[] {
        return (workspaceId === undefined ? all.all() : byWorkspace.all(workspaceId)).map(read)
      },
      remove(id: string): void {
        drop.run(id)
      },
    }
  }
  const groups = docTable<RangeGroup>('range_groups')
  const lines = docTable<ProductLine>('product_lines')

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
    putRangeGroup: (group) => {
      groups.put(group)
    },
    getRangeGroup: (id) => groups.get(id),
    listRangeGroups: (workspaceId) => groups.list(workspaceId),
    deleteRangeGroup: (id) => {
      groups.remove(id)
    },
    putProductLine: (line) => {
      lines.put(line)
    },
    getProductLine: (id) => lines.get(id),
    listProductLines: (workspaceId) => lines.list(workspaceId),
    deleteProductLine: (id) => {
      lines.remove(id)
    },
    close() {
      db.close()
    },
  }
}
