/**
 * 编排层的库（49 §6 WP60）。
 *
 * **这张表里没有一个字节的租户数据**：只有"哪个组织的哪个工作区、什么状态、
 * 付到什么时候、跑在哪个回环端口"。租户的库密钥在 `keyring.ts`（租户自己的目录里），
 * 租户的业务数据在子进程自己的库里——编排层两样都读不到，也没有读它们的代码。
 *
 * 两份实现：内存（测试）与 sqlite（云上）。形状一样，行为一样，测试只测一次。
 */
import type { Iso8601, WorkspaceId } from '@agentsws/contracts'
import type { ChildTokenRow, StandbyRecord, StandbyStore, StandbyTokenStore } from './types.js'

export class MemoryStandbyStore implements StandbyStore {
  private readonly rows = new Map<string, StandbyRecord>()

  get(workspace_id: WorkspaceId): StandbyRecord | undefined {
    const row = this.rows.get(workspace_id)
    return row === undefined ? undefined : { ...row }
  }

  list(org_id?: string): StandbyRecord[] {
    return [...this.rows.values()]
      .filter((r) => org_id === undefined || r.org_id === org_id)
      .map((r) => ({ ...r }))
      .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0))
  }

  put(record: StandbyRecord): void {
    this.rows.set(record.workspace_id, { ...record })
  }
}

/** better-sqlite3 的那一点点面（不把整个类型拖进这个包）。 */
export interface SqliteLike {
  exec(sql: string): unknown
  prepare(sql: string): {
    run(...args: unknown[]): unknown
    get(...args: unknown[]): unknown
    all(...args: unknown[]): unknown[]
  }
  close(): void
}

interface Row {
  workspace_id: string
  org_id: string
  owner_account_id: string
  status: string
  seats: number
  period_end: string
  port: number | null
  last_health_at: string | null
  created_at: string
  restarts: number
  restart_at: string | null
  reason: string | null
  renewal_notified_at: string | null
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS standby_workspaces (
  workspace_id       TEXT PRIMARY KEY,
  org_id             TEXT NOT NULL,
  owner_account_id   TEXT NOT NULL DEFAULT '',
  status             TEXT NOT NULL,
  seats              INTEGER NOT NULL,
  period_end         TEXT NOT NULL,
  port               INTEGER,
  last_health_at     TEXT,
  created_at         TEXT NOT NULL,
  restarts           INTEGER NOT NULL DEFAULT 0,
  restart_at         TEXT,
  reason             TEXT,
  renewal_notified_at TEXT
);
CREATE INDEX IF NOT EXISTS standby_by_org ON standby_workspaces(org_id);

-- 子进程那把云令牌。**只有 sha256**（21 §5：明文只在签发那一刻返回一次）。
-- 与 WP58 的 workspace_links 分开：那张表上有"一个工作区一条活着的关联"这条不变量。
CREATE TABLE IF NOT EXISTS standby_child_tokens (
  sha256       TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  org_id       TEXT NOT NULL,
  account_id   TEXT NOT NULL,
  issued_at    TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  revoked_at   TEXT
);
CREATE INDEX IF NOT EXISTS standby_child_tokens_by_ws ON standby_child_tokens(workspace_id);
`

function toRecord(row: Row): StandbyRecord {
  return {
    workspace_id: row.workspace_id,
    org_id: row.org_id,
    owner_account_id: row.owner_account_id,
    status: row.status as StandbyRecord['status'],
    seats: row.seats,
    period_end: row.period_end,
    ...(row.port === null ? {} : { port: row.port }),
    ...(row.last_health_at === null ? {} : { last_health_at: row.last_health_at }),
    created_at: row.created_at,
    restarts: row.restarts,
    ...(row.restart_at === null ? {} : { restart_at: row.restart_at }),
    ...(row.reason === null ? {} : { reason: row.reason }),
    ...(row.renewal_notified_at === null ? {} : { renewal_notified_at: row.renewal_notified_at }),
  }
}

export class SqliteStandbyStore implements StandbyStore {
  private readonly db: SqliteLike

  constructor(db: SqliteLike) {
    this.db = db
    this.db.exec(SCHEMA)
  }

  get(workspace_id: WorkspaceId): StandbyRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM standby_workspaces WHERE workspace_id = ?')
      .get(workspace_id) as Row | undefined
    return row === undefined ? undefined : toRecord(row)
  }

  list(org_id?: string): StandbyRecord[] {
    const rows = (
      org_id === undefined
        ? this.db.prepare('SELECT * FROM standby_workspaces ORDER BY created_at').all()
        : this.db
            .prepare('SELECT * FROM standby_workspaces WHERE org_id = ? ORDER BY created_at')
            .all(org_id)
    ) as Row[]
    return rows.map(toRecord)
  }

  put(record: StandbyRecord): void {
    this.db
      .prepare(
        `INSERT INTO standby_workspaces
           (workspace_id, org_id, owner_account_id, status, seats, period_end, port,
            last_health_at, created_at, restarts, restart_at, reason, renewal_notified_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET
           org_id = excluded.org_id,
           owner_account_id = excluded.owner_account_id,
           status = excluded.status,
           seats = excluded.seats,
           period_end = excluded.period_end,
           port = excluded.port,
           last_health_at = excluded.last_health_at,
           restarts = excluded.restarts,
           restart_at = excluded.restart_at,
           reason = excluded.reason,
           renewal_notified_at = excluded.renewal_notified_at`,
      )
      .run(
        record.workspace_id,
        record.org_id,
        record.owner_account_id,
        record.status,
        record.seats,
        record.period_end,
        record.port ?? null,
        record.last_health_at ?? null,
        record.created_at,
        record.restarts,
        record.restart_at ?? null,
        record.reason ?? null,
        record.renewal_notified_at ?? null,
      )
  }

  close(): void {
    this.db.close()
  }
}

/** 子进程令牌的内存档（测试）。 */
export class MemoryTokenStore implements StandbyTokenStore {
  private readonly rows = new Map<string, ChildTokenRow>()

  put(row: ChildTokenRow): void {
    this.rows.set(row.sha256, { ...row })
  }

  bySha256(sha256: string): ChildTokenRow | undefined {
    const row = this.rows.get(sha256)
    return row === undefined ? undefined : { ...row }
  }

  revokeAllOf(workspace_id: WorkspaceId, at: Iso8601): void {
    for (const [key, row] of [...this.rows]) {
      if (row.workspace_id === workspace_id && row.revoked_at === undefined)
        this.rows.set(key, { ...row, revoked_at: at })
    }
  }
}

/** 子进程令牌的 sqlite 档。撤销写 `revoked_at`（**不删行**：谁在什么时候撤的要留痕）。 */
export class SqliteTokenStore implements StandbyTokenStore {
  private readonly db: SqliteLike

  constructor(db: SqliteLike) {
    this.db = db
    this.db.exec(SCHEMA)
  }

  put(row: ChildTokenRow): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO standby_child_tokens
           (sha256, workspace_id, org_id, account_id, issued_at, expires_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.sha256,
        row.workspace_id,
        row.org_id,
        row.account_id,
        row.issued_at,
        row.expires_at,
        row.revoked_at ?? null,
      )
  }

  bySha256(sha256: string): ChildTokenRow | undefined {
    const row = this.db
      .prepare('SELECT * FROM standby_child_tokens WHERE sha256 = ?')
      .get(sha256) as (ChildTokenRow & { revoked_at: string | null }) | undefined
    if (row === undefined) return undefined
    return {
      sha256: row.sha256,
      workspace_id: row.workspace_id,
      org_id: row.org_id,
      account_id: row.account_id,
      issued_at: row.issued_at,
      expires_at: row.expires_at,
      ...(row.revoked_at === null ? {} : { revoked_at: row.revoked_at }),
    }
  }

  revokeAllOf(workspace_id: WorkspaceId, at: Iso8601): void {
    this.db
      .prepare(
        'UPDATE standby_child_tokens SET revoked_at = ? WHERE workspace_id = ? AND revoked_at IS NULL',
      )
      .run(at, workspace_id)
  }
}
