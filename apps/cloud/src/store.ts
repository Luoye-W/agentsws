/**
 * 云侧的库：账号、组织、成员、一次性登录、会话、工作区关联。
 *
 * 五条纪律（20 §3 / 21 §5 / 18 §1）：
 *
 * 1. **一个令牌明文都不落库**。登录 token、会话 token、工作区服务令牌，库里都只有
 *    `sha256`；明文只在签发那一刻作为返回值出现一次。
 * 2. **撤销是一列，不是删行**（`revoked_at` / `used_at`）——谁在什么时候撤的必须留痕。
 * 3. 撤销 / 过期 / 根本不存在，验起来一律回 `undefined`，**不区分**。
 * 4. 时间经注入的 `Clock`，随机经注入的 `randomBytes`：同一个种子跑出同一串，测试才能钉。
 * 5. 这个库与 `apps/server` 的**完全分开**（数据目录 `AGENTSWS_CLOUD_DATA_DIR`），
 *    两边一张表都不共享。
 */

import { createHash, randomBytes as nodeRandomBytes, timingSafeEqual } from 'node:crypto'
import { migrate } from '@agentsws/api'
import type {
  Clock,
  CloudAccount,
  CloudOrg,
  CloudOrgMember,
  CloudScope,
  Iso8601,
  IssuedWorkspaceToken,
  VerifiedCloudToken,
  WorkspaceLink,
} from '@agentsws/contracts'
import { DEFAULT_CLOUD_SCOPES, DEFAULT_WORKSPACE_TOKEN_TTL_MS } from '@agentsws/contracts'
import type { SyncDb } from '@agentsws/core/sql/sync-db'
import { sqliteTokenVerifier } from './verifier.js'

/** magic link 的有效期：15 分钟（与 20 §3 本地档同一个数）。 */
export const CLOUD_LOGIN_TTL_MS = 15 * 60 * 1000
/** 云账号会话：12 小时（关联向导用一次就够，不必更长）。 */
export const CLOUD_SESSION_TTL_MS = 12 * 60 * 60 * 1000

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex')

const MIGRATIONS = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS cloud_accounts (
  id         TEXT PRIMARY KEY NOT NULL,
  email      TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS cloud_orgs (
  id               TEXT PRIMARY KEY NOT NULL,
  name             TEXT NOT NULL,
  owner_account_id TEXT NOT NULL,
  created_at       TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS cloud_org_members (
  org_id     TEXT NOT NULL,
  account_id TEXT NOT NULL,
  role       TEXT NOT NULL,
  joined_at  TEXT NOT NULL,
  PRIMARY KEY (org_id, account_id)
) STRICT;

-- 一次性登录：只有哈希；用过写 used_at（不删行）
CREATE TABLE IF NOT EXISTS cloud_logins (
  token_sha256 TEXT PRIMARY KEY NOT NULL,
  account_id   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  used_at      TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS cloud_sessions (
  token_sha256 TEXT PRIMARY KEY NOT NULL,
  account_id   TEXT NOT NULL,
  org_id       TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  revoked_at   TEXT
) STRICT;

-- 18 §1 的三条纪律各一列：expires_at 短期、scopes 最小动作集、revoked_at 可撤
CREATE TABLE IF NOT EXISTS workspace_links (
  id           TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  cloud_org_id TEXT NOT NULL,
  label        TEXT NOT NULL,
  token_sha256 TEXT NOT NULL UNIQUE,
  scopes       TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  created_by   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  revoked_at   TEXT,
  last_used_at TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS workspace_links_by_org ON workspace_links (cloud_org_id);
`,
  },
]

export interface CloudStoreDeps {
  /**
   * 一张已经开好的库（同步 SQL 口）。开在哪由装配方决定：
   * Compose 形态是 `cloud.sqlite`（见 `store-node.ts`），Workers 形态是
   * `AccountsDO` 自己的 SQLite。**这个文件不知道也不需要知道是哪一种。**
   */
  db: SyncDb
  clock: Clock
  /** 随机源注入点（测试用）。默认 `node:crypto` 的 randomBytes。 */
  randomBytes?: (n: number) => Buffer
}

export interface CreateLinkInput {
  workspace_id: string
  cloud_org_id: string
  created_by: string
  label?: string
  scopes?: CloudScope[]
  ttlMs?: number
}

export interface CloudSessionRow {
  account_id: string
  org_id: string
  expires_at: Iso8601
}

export interface VerifiedLogin {
  account: CloudAccount
  org: CloudOrg
  session_token: string
  expires_at: Iso8601
}

interface LinkRow {
  id: string
  workspace_id: string
  cloud_org_id: string
  label: string
  token_sha256: string
  scopes: string
  created_at: string
  created_by: string
  expires_at: string
  revoked_at: string | null
  last_used_at: string | null
}

export function rowToLink(row: LinkRow): WorkspaceLink {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    cloud_org_id: row.cloud_org_id,
    label: row.label,
    token_sha256: row.token_sha256,
    scopes: JSON.parse(row.scopes) as CloudScope[],
    created_at: row.created_at,
    created_by: row.created_by,
    expires_at: row.expires_at,
    ...(row.revoked_at === null ? {} : { revoked_at: row.revoked_at }),
    ...(row.last_used_at === null ? {} : { last_used_at: row.last_used_at }),
  }
}

const normalizeEmail = (email: string): string => email.trim().toLowerCase()

export class CloudStore {
  readonly db: SyncDb
  readonly #clock: Clock
  readonly #random: (n: number) => Buffer
  readonly #verify: (token: string) => Promise<VerifiedCloudToken | undefined>

  constructor(options: CloudStoreDeps) {
    this.db = options.db
    this.#clock = options.clock
    this.#random = options.randomBytes ?? nodeRandomBytes
    migrate(this.db, MIGRATIONS, options.clock.now())
    this.#verify = sqliteTokenVerifier(this.db, options.clock)
  }

  /** 49 M3 的服务入口只依赖这一个纯函数（`CloudTokenVerifier`）。 */
  get verifyToken(): (token: string) => Promise<VerifiedCloudToken | undefined> {
    return this.#verify
  }

  #id(prefix: string): string {
    return `${prefix}_${this.#random(12).toString('hex')}`
  }

  #secret(prefix: string): string {
    return `${prefix}${this.#random(32).toString('base64url')}`
  }

  #expired(at: string | null | undefined): boolean {
    if (at === null || at === undefined) return false
    return Date.parse(this.#clock.now()) >= Date.parse(at)
  }

  // ── 账号与组织 ──────────────────────────────────────────────────────

  /**
   * 第一次见到这个邮箱：建账号，并**隐式**建一个以邮箱命名的组织（52 O3）。
   *
   * 界面上不露"组织"这个词——用户看到的是"我的 agentsws 账号"；组织只是钱与人
   * 挂靠的那个东西。已经见过就原样返回，绝不重复建（邮箱唯一）。
   */
  ensureAccount(email: string): { account: CloudAccount; org: CloudOrg; created: boolean } {
    const normalized = normalizeEmail(email)
    const existing = this.accountByEmail(normalized)
    if (existing !== undefined) {
      const org = this.primaryOrg(existing.id)
      // 账号在、组织没了是装配错误，不是正常状态；补一个而不是抛，免得人被锁在外面
      return { account: existing, org: org ?? this.#createOrg(existing), created: false }
    }
    const now = this.#clock.now()
    const account: CloudAccount = { id: this.#id('acc'), email: normalized, created_at: now }
    this.db
      .prepare('INSERT INTO cloud_accounts (id, email, created_at) VALUES (?, ?, ?)')
      .run(account.id, account.email, account.created_at)
    return { account, org: this.#createOrg(account), created: true }
  }

  #createOrg(account: CloudAccount): CloudOrg {
    const now = this.#clock.now()
    const org: CloudOrg = {
      id: this.#id('org'),
      // 以邮箱命名：用户没被问过"你的组织叫什么"，我们也不猜一个公司名
      name: account.email,
      owner_account_id: account.id,
      members: [{ account_id: account.id, role: 'owner', joined_at: now }],
      created_at: now,
    }
    this.db
      .prepare(
        'INSERT INTO cloud_orgs (id, name, owner_account_id, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(org.id, org.name, org.owner_account_id, org.created_at)
    this.db
      .prepare(
        'INSERT INTO cloud_org_members (org_id, account_id, role, joined_at) VALUES (?, ?, ?, ?)',
      )
      .run(org.id, account.id, 'owner', now)
    return org
  }

  account(id: string): CloudAccount | undefined {
    return this.db
      .prepare<CloudAccount>('SELECT id, email, created_at FROM cloud_accounts WHERE id = ?')
      .get(id)
  }

  accountByEmail(email: string): CloudAccount | undefined {
    return this.db
      .prepare<CloudAccount>('SELECT id, email, created_at FROM cloud_accounts WHERE email = ?')
      .get(normalizeEmail(email))
  }

  org(id: string): CloudOrg | undefined {
    const row = this.db
      .prepare<{ id: string; name: string; owner_account_id: string; created_at: string }>(
        'SELECT id, name, owner_account_id, created_at FROM cloud_orgs WHERE id = ?',
      )
      .get(id)
    if (row === undefined) return undefined
    const members = this.db
      .prepare<CloudOrgMember>(
        'SELECT account_id, role, joined_at FROM cloud_org_members WHERE org_id = ? ORDER BY joined_at',
      )
      .all(id)
    return { ...row, members }
  }

  /** 这个人所属的第一个组织（本版一人一组织；团队版是往同一个组织里加成员）。 */
  primaryOrg(account_id: string): CloudOrg | undefined {
    const row = this.db
      .prepare<{ org_id: string }>(
        'SELECT org_id FROM cloud_org_members WHERE account_id = ? ORDER BY joined_at LIMIT 1',
      )
      .get(account_id)
    return row === undefined ? undefined : this.org(row.org_id)
  }

  isMember(org_id: string, account_id: string): boolean {
    return (
      (this.db
        .prepare<{ n: number }>(
          'SELECT COUNT(*) AS n FROM cloud_org_members WHERE org_id = ? AND account_id = ?',
        )
        .get(org_id, account_id)?.n ?? 0) > 0
    )
  }

  // ── magic link 与会话 ───────────────────────────────────────────────

  /** 签发一次性登录 token；明文只在返回值里出现一次（之后只进邮件正文）。 */
  issueLogin(
    account_id: string,
    ttlMs = CLOUD_LOGIN_TTL_MS,
  ): { token: string; expires_at: Iso8601 } {
    const now = this.#clock.now()
    const token = this.#secret('cml_')
    const expires_at = new Date(Date.parse(now) + ttlMs).toISOString()
    this.db
      .prepare(
        'INSERT INTO cloud_logins (token_sha256, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
      )
      .run(hashToken(token), account_id, now, expires_at)
    return { token, expires_at }
  }

  /** 验一次性 token 并换会话。用过 / 过期 / 不存在一律 `undefined`。 */
  verifyLogin(token: string, ttlMs = CLOUD_SESSION_TTL_MS): VerifiedLogin | undefined {
    const row = this.db
      .prepare<{
        token_sha256: string
        account_id: string
        expires_at: string
        used_at: string | null
      }>(
        'SELECT token_sha256, account_id, expires_at, used_at FROM cloud_logins WHERE token_sha256 = ?',
      )
      .get(hashToken(token))
    if (row === undefined || row.used_at !== null || this.#expired(row.expires_at)) return undefined
    const account = this.account(row.account_id)
    if (account === undefined) return undefined
    const org = this.primaryOrg(account.id) ?? this.#createOrg(account)
    const now = this.#clock.now()
    this.db
      .prepare('UPDATE cloud_logins SET used_at = ? WHERE token_sha256 = ?')
      .run(now, row.token_sha256)
    const session_token = this.#secret('cs_')
    const expires_at = new Date(Date.parse(now) + ttlMs).toISOString()
    this.db
      .prepare(
        'INSERT INTO cloud_sessions (token_sha256, account_id, org_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(hashToken(session_token), account.id, org.id, now, expires_at)
    return { account, org, session_token, expires_at }
  }

  session(token: string): CloudSessionRow | undefined {
    const hash = hashToken(token)
    const row = this.db
      .prepare<{
        token_sha256: string
        account_id: string
        org_id: string
        expires_at: string
        revoked_at: string | null
      }>(
        'SELECT token_sha256, account_id, org_id, expires_at, revoked_at FROM cloud_sessions WHERE token_sha256 = ?',
      )
      .get(hash)
    if (row === undefined) return undefined
    // 定时安全比较：命中之后再比一次，长度不同直接 false
    if (!constantTimeEqual(row.token_sha256, hash)) return undefined
    if (row.revoked_at !== null || this.#expired(row.expires_at)) return undefined
    return { account_id: row.account_id, org_id: row.org_id, expires_at: row.expires_at }
  }

  revokeSession(token: string): void {
    this.db
      .prepare(
        'UPDATE cloud_sessions SET revoked_at = ? WHERE token_sha256 = ? AND revoked_at IS NULL',
      )
      .run(this.#clock.now(), hashToken(token))
  }

  // ── 工作区关联 ──────────────────────────────────────────────────────

  /**
   * 签一把工作区服务令牌。明文**只在返回值里出现一次**。
   *
   * 同一个工作区已经关到**别的**组织上（还没撤、没过期）时拒绝：一个工作区的钱
   * 只能从一个地方出，两条活着的关联意味着两本账（52 O3）。
   */
  createLink(input: CreateLinkInput): IssuedWorkspaceToken {
    const now = this.#clock.now()
    const conflict = this.activeLinkOfWorkspace(input.workspace_id)
    if (conflict !== undefined && conflict.cloud_org_id !== input.cloud_org_id)
      throw new Error(`workspace_already_linked:${input.workspace_id}`)
    const token = this.#secret('wst_')
    const scopes = input.scopes ?? [...DEFAULT_CLOUD_SCOPES]
    const link: WorkspaceLink = {
      id: this.#id('lnk'),
      workspace_id: input.workspace_id,
      cloud_org_id: input.cloud_org_id,
      label: input.label ?? input.workspace_id,
      token_sha256: hashToken(token),
      scopes,
      created_at: now,
      created_by: input.created_by,
      expires_at: new Date(
        Date.parse(now) + (input.ttlMs ?? DEFAULT_WORKSPACE_TOKEN_TTL_MS),
      ).toISOString(),
    }
    this.db
      .prepare(
        `INSERT INTO workspace_links
         (id, workspace_id, cloud_org_id, label, token_sha256, scopes, created_at, created_by, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        link.id,
        link.workspace_id,
        link.cloud_org_id,
        link.label,
        link.token_sha256,
        JSON.stringify(link.scopes),
        link.created_at,
        link.created_by,
        link.expires_at,
      )
    return { link, token }
  }

  link(id: string): WorkspaceLink | undefined {
    const row = this.db.prepare<LinkRow>('SELECT * FROM workspace_links WHERE id = ?').get(id)
    return row === undefined ? undefined : rowToLink(row)
  }

  links(org_id: string): WorkspaceLink[] {
    return this.db
      .prepare<LinkRow>(
        'SELECT * FROM workspace_links WHERE cloud_org_id = ? ORDER BY created_at DESC',
      )
      .all(org_id)
      .map(rowToLink)
  }

  /** 这个工作区现在还活着的那条关联（撤了 / 过期了都不算）。 */
  activeLinkOfWorkspace(workspace_id: string): WorkspaceLink | undefined {
    return this.db
      .prepare<LinkRow>(
        'SELECT * FROM workspace_links WHERE workspace_id = ? AND revoked_at IS NULL ORDER BY created_at DESC',
      )
      .all(workspace_id)
      .map(rowToLink)
      .find((l) => !this.#expired(l.expires_at))
  }

  /**
   * 续期 = **换一把新的**，不是把旧的有效期往后拖。
   *
   * 旧明文当场作废（哈希被覆盖），于是"续期"与"泄漏之后重签"是同一个动作，
   * 不必再多一条路（18 §1 短期 + 可撤）。
   */
  renewLink(id: string, ttlMs = DEFAULT_WORKSPACE_TOKEN_TTL_MS): IssuedWorkspaceToken | undefined {
    const current = this.link(id)
    if (current === undefined || current.revoked_at !== undefined) return undefined
    const now = this.#clock.now()
    const token = this.#secret('wst_')
    const expires_at = new Date(Date.parse(now) + ttlMs).toISOString()
    this.db
      .prepare('UPDATE workspace_links SET token_sha256 = ?, expires_at = ? WHERE id = ?')
      .run(hashToken(token), expires_at, id)
    const link = this.link(id)
    return link === undefined ? undefined : { link, token }
  }

  /** 撤销：写 `revoked_at`，**不删行**。重复撤销是幂等的。 */
  revokeLink(id: string): WorkspaceLink | undefined {
    const current = this.link(id)
    if (current === undefined) return undefined
    if (current.revoked_at !== undefined) return current
    this.db
      .prepare('UPDATE workspace_links SET revoked_at = ? WHERE id = ?')
      .run(this.#clock.now(), id)
    return this.link(id)
  }

  /**
   * 整库的 JSON 快照（WP114 的跨平台退路）。
   *
   * 为什么要它：Workers 形态的库在 Durable Object 里，Compose 形态的库是一个
   * sqlite 文件——两边**没有**一个共同的"把文件拷过去"的动作。所以搬家那条路
   * 走的是这一份 JSON：从哪一边导出来，都能往另一边灌回去。
   *
   * 里面**只有账号层该有的东西**：账号（邮箱）、组织、成员、工作区关联。
   * 令牌哈希在里面（不带它的话搬完家所有令牌都得重签，等于所有人重新关联一次），
   * **明文一个都没有**——库里本来就没存过。一次性登录与会话**不导**：
   * 它们本来就只活几分钟到十几小时，搬家时让人重登一次比把会话搬过去干净。
   */
  exportSnapshot(): CloudSnapshot {
    return {
      at: this.#clock.now(),
      accounts: this.db
        .prepare<CloudAccount>(
          'SELECT id, email, created_at FROM cloud_accounts ORDER BY created_at',
        )
        .all(),
      orgs: this.db
        .prepare<{ id: string; name: string; owner_account_id: string; created_at: string }>(
          'SELECT id, name, owner_account_id, created_at FROM cloud_orgs ORDER BY created_at',
        )
        .all(),
      members: this.db
        .prepare<{ org_id: string; account_id: string; role: string; joined_at: string }>(
          'SELECT org_id, account_id, role, joined_at FROM cloud_org_members ORDER BY joined_at',
        )
        .all(),
      links: this.db
        .prepare<LinkRow>('SELECT * FROM workspace_links ORDER BY created_at')
        .all()
        .map(rowToLink),
    }
  }

  close(): void {
    this.db.close()
  }
}

/** 账号层的整库快照（{@link CloudStore.exportSnapshot} 的形状）。 */
export interface CloudSnapshot {
  at: Iso8601
  accounts: CloudAccount[]
  orgs: { id: string; name: string; owner_account_id: string; created_at: string }[]
  members: { org_id: string; account_id: string; role: string; joined_at: string }[]
  links: WorkspaceLink[]
}

function constantTimeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8')
  const y = Buffer.from(b, 'utf8')
  if (x.length !== y.length) return false
  return timingSafeEqual(x, y)
}

/**
 * 在一张已经开好的库上装一个账号库。
 *
 * 开库那一跳（路径、WAL、外键）在 `store-node.ts`——它是**唯一**一处
 * `better-sqlite3` 出现在云侧账号层的地方。Workers 形态把 `db` 换成 DO 的 SQLite，
 * 这个文件一个字都不动。
 */
export function createCloudStoreOn(options: CloudStoreDeps): CloudStore {
  return new CloudStore(options)
}
