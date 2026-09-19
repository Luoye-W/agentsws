/**
 * 后台自己的那一层库（65 §2 / §5 / §7）。
 *
 * 它**借用** `CloudStore` 的那个连接（同一个 `cloud.sqlite`），但所有 SQL 都写在
 * 这个文件里——`store.ts` 只多了一行 `{ version: 2, sql: ADMIN_MIGRATION_V2 }`。
 * 这样合并 WP114 的 `SqlDriver` 抽取时，要动的地方是这里一个文件，不是散在两处。
 *
 * 只用 `prepare(sql).all/get/run` + `transaction` 这个同步子集：不碰 `pragma` /
 * `function` / `aggregate` / `backup`，聚合全用标准 SQLite SQL。
 */

import { createHash } from 'node:crypto'
import type {
  AccountBan,
  AdminSession,
  AuditAction,
  AuditEntry,
  Clock,
  CloudRole,
  Iso8601,
  MembershipCycle,
  MembershipTerm,
} from '@agentsws/contracts'
import {
  ADMIN_SESSION_ABSOLUTE_TTL_MS,
  ADMIN_SESSION_TTL_MS,
  normalizeEmailAlias,
} from '@agentsws/contracts'
import type { SyncDb, SyncDbValue } from '@agentsws/core/sql/sync-db'

const sha256 = (raw: string): string => createHash('sha256').update(raw).digest('hex')

/** NULL / 空串 / 不认识的值一律当 `user`——**默认最小权限**。 */
export function roleOf(raw: string | null | undefined): CloudRole {
  return raw === 'admin' ? 'admin' : raw === 'support' ? 'support' : 'user'
}

export interface AdminStoreOptions {
  /**
   * 一张已经开好的**同步 SQL 口**（WP114 的 `SyncDb`）。
   * Compose 形态是 `cloud.sqlite`，Workers 形态是 `AccountsDO` 自己的 SQLite——
   * 这个文件不知道也不需要知道是哪一种。
   */
  db: SyncDb
  clock: Clock
  /** id 与秘密的随机源（测试注入定死的那一份）。 */
  randomBytes: (n: number) => Buffer
}

/** 新签一张后台会话时一次性返回的两串明文。之后库里只有哈希。 */
export interface IssuedAdminSession {
  session: AdminSession
  /** cookie 里那一串（httpOnly）。 */
  token: string
  /** CSRF 双提交那一串（**不是** httpOnly，前端要读出来放进请求头）。 */
  csrf: string
}

interface SessionRow {
  id: string
  token_sha256: string
  csrf_sha256: string
  account_id: string
  created_at: string
  expires_at: string
  absolute_expires_at: string
  last_seen_at: string
  revoked_at: string | null
}

export class AdminStore {
  readonly db: SyncDb
  readonly #clock: Clock
  readonly #random: (n: number) => Buffer

  constructor(options: AdminStoreOptions) {
    this.db = options.db
    this.#clock = options.clock
    this.#random = options.randomBytes
  }

  #id(prefix: string): string {
    return `${prefix}_${this.#random(12).toString('hex')}`
  }

  #secret(prefix: string): string {
    return `${prefix}${this.#random(32).toString('base64url')}`
  }

  now(): Iso8601 {
    return this.#clock.now()
  }

  // ── 角色 ────────────────────────────────────────────────────────────

  role(account_id: string): CloudRole {
    const row = this.db
      .prepare<{ role: string | null; deleted_at: string | null }>(
        'SELECT role, deleted_at FROM cloud_accounts WHERE id = ?',
      )
      .get(account_id)
    // 删过的账号一律降到 user：墓碑行不该还带着 admin
    if (row === undefined || row.deleted_at !== null) return 'user'
    return roleOf(row.role)
  }

  setRole(account_id: string, role: CloudRole): void {
    this.db.prepare('UPDATE cloud_accounts SET role = ? WHERE id = ?').run(role, account_id)
  }

  /** 现在有几个 admin。删最后一个 admin 要被拦住（不然谁也进不去了）。 */
  adminCount(): number {
    return (
      this.db
        .prepare<{ n: number }>(
          "SELECT COUNT(*) AS n FROM cloud_accounts WHERE role = 'admin' AND deleted_at IS NULL",
        )
        .get()?.n ?? 0
    )
  }

  /** 这个邮箱验证过没有：magic link 成功换过一次会话就算（`used_at` 非空）。 */
  emailVerified(account_id: string): boolean {
    return (
      (this.db
        .prepare<{ n: number }>(
          'SELECT COUNT(*) AS n FROM cloud_logins WHERE account_id = ? AND used_at IS NOT NULL',
        )
        .get(account_id)?.n ?? 0) > 0
    )
  }

  // ── 后台会话 ────────────────────────────────────────────────────────

  /**
   * 签一张后台会话。**只有 staff 才走到这里**——判角色是调用方的事，
   * 但这里再兜一次：签给 `user` 的会话是一个纯粹的错误，不该只靠上游不犯错。
   */
  issueSession(account_id: string, role: CloudRole): IssuedAdminSession | undefined {
    if (role !== 'admin' && role !== 'support') return undefined
    const now = this.now()
    const token = this.#secret('as_')
    const csrf = this.#secret('ac_')
    const session: AdminSession = {
      id: this.#id('asn'),
      account_id,
      role,
      created_at: now,
      expires_at: new Date(Date.parse(now) + ADMIN_SESSION_TTL_MS).toISOString(),
      absolute_expires_at: new Date(Date.parse(now) + ADMIN_SESSION_ABSOLUTE_TTL_MS).toISOString(),
      last_seen_at: now,
    }
    this.db
      .prepare(
        `INSERT INTO admin_sessions
           (id, token_sha256, csrf_sha256, account_id, created_at, expires_at, absolute_expires_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        sha256(token),
        sha256(csrf),
        account_id,
        now,
        session.expires_at,
        session.absolute_expires_at,
        now,
      )
    return { session, token, csrf }
  }

  /**
   * 验一张会话并**滑动续期**。
   *
   * 撤销 / 过期 / 不存在一律回 `undefined`，不区分（与令牌那一套同一条纪律）。
   * 滑动的上限是 `absolute_expires_at`：一直开着的标签页也得七天重登一次。
   */
  session(token: string): (AdminSession & { csrf_sha256: string }) | undefined {
    const row = this.db
      .prepare<SessionRow>('SELECT * FROM admin_sessions WHERE token_sha256 = ?')
      .get(sha256(token))
    if (row === undefined || row.revoked_at !== null) return undefined
    const now = this.now()
    const nowMs = Date.parse(now)
    if (nowMs >= Date.parse(row.expires_at) || nowMs >= Date.parse(row.absolute_expires_at))
      return undefined
    const role = this.role(row.account_id)
    // 角色是**每次请求现查**的：刚被降级的人不该靠一张旧 cookie 再撑十二小时
    if (role !== 'admin' && role !== 'support') return undefined
    const next = Math.min(nowMs + ADMIN_SESSION_TTL_MS, Date.parse(row.absolute_expires_at))
    const expires_at = new Date(next).toISOString()
    this.db
      .prepare('UPDATE admin_sessions SET expires_at = ?, last_seen_at = ? WHERE id = ?')
      .run(expires_at, now, row.id)
    return {
      id: row.id,
      account_id: row.account_id,
      role,
      created_at: row.created_at,
      expires_at,
      absolute_expires_at: row.absolute_expires_at,
      last_seen_at: now,
      csrf_sha256: row.csrf_sha256,
    }
  }

  csrfMatches(session: { csrf_sha256: string }, given: string): boolean {
    return session.csrf_sha256 === sha256(given)
  }

  revokeSession(token: string): void {
    this.db
      .prepare(
        'UPDATE admin_sessions SET revoked_at = ? WHERE token_sha256 = ? AND revoked_at IS NULL',
      )
      .run(this.now(), sha256(token))
  }

  /** 吊销这个人的**全部**后台会话（改角色、封禁、删号时都要跑一次）。 */
  revokeSessionsOf(account_id: string): number {
    return this.db
      .prepare(
        'UPDATE admin_sessions SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL',
      )
      .run(this.now(), account_id).changes
  }

  /** 吊销这个人的云账号会话（`cloud_sessions`，本地关联向导那一套）。 */
  revokeCloudSessionsOf(account_id: string): number {
    return this.db
      .prepare(
        'UPDATE cloud_sessions SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL',
      )
      .run(this.now(), account_id).changes
  }

  // ── 封禁 ────────────────────────────────────────────────────────────

  /** 现在生效的那一条封禁（解封了 / 到期了都不算）。 */
  activeBan(account_id: string): AccountBan | undefined {
    const now = this.now()
    const row = this.db
      .prepare<{
        account_id: string
        reason: string
        banned_by: string
        banned_at: string
        expires_at: string | null
        lifted_at: string | null
        lifted_by: string | null
      }>(
        `SELECT account_id, reason, banned_by, banned_at, expires_at, lifted_at, lifted_by
           FROM account_bans WHERE account_id = ? AND lifted_at IS NULL
          ORDER BY banned_at DESC LIMIT 1`,
      )
      .get(account_id)
    if (row === undefined) return undefined
    // 到期自动失效：判在**读**的时候做，不靠定时任务——定时任务没跑那几分钟里
    // 一个已经到期的封禁还在生效，而用户看到的是"说好今天解封的"
    if (row.expires_at !== null && Date.parse(row.expires_at) <= Date.parse(now)) return undefined
    return {
      account_id: row.account_id,
      reason: row.reason,
      banned_by: row.banned_by,
      banned_at: row.banned_at,
      ...(row.expires_at === null ? {} : { expires_at: row.expires_at }),
    }
  }

  /** 一批人各自有没有被封（列表页一次查完，不在循环里查）。 */
  activeBans(account_ids: string[]): Map<string, AccountBan> {
    const out = new Map<string, AccountBan>()
    if (account_ids.length === 0) return out
    const holes = account_ids.map(() => '?').join(', ')
    const now = this.now()
    const rows = this.db
      .prepare<{
        account_id: string
        reason: string
        banned_by: string
        banned_at: string
        expires_at: string | null
      }>(
        `SELECT account_id, reason, banned_by, banned_at, expires_at
           FROM account_bans
          WHERE account_id IN (${holes}) AND lifted_at IS NULL
            AND (expires_at IS NULL OR expires_at > ?)
          ORDER BY banned_at`,
      )
      .all(...account_ids, now)
    for (const r of rows)
      out.set(r.account_id, {
        account_id: r.account_id,
        reason: r.reason,
        banned_by: r.banned_by,
        banned_at: r.banned_at,
        ...(r.expires_at === null ? {} : { expires_at: r.expires_at }),
      })
    return out
  }

  ban(input: {
    account_id: string
    reason: string
    banned_by: string
    expires_at?: string | undefined
  }): AccountBan {
    const now = this.now()
    this.db
      .prepare(
        `INSERT INTO account_bans (id, account_id, reason, banned_by, banned_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.#id('ban'),
        input.account_id,
        input.reason,
        input.banned_by,
        now,
        input.expires_at ?? null,
      )
    return {
      account_id: input.account_id,
      reason: input.reason,
      banned_by: input.banned_by,
      banned_at: now,
      ...(input.expires_at === undefined ? {} : { expires_at: input.expires_at }),
    }
  }

  /** 解封：写 `lifted_at`，**不删行**——他什么时候被封过必须还查得到。 */
  unban(account_id: string, by: string): number {
    return this.db
      .prepare(
        'UPDATE account_bans SET lifted_at = ?, lifted_by = ? WHERE account_id = ? AND lifted_at IS NULL',
      )
      .run(this.now(), by, account_id).changes
  }

  // ── 邮箱黑名单 ──────────────────────────────────────────────────────

  banEmail(email: string, reason: string, by: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO banned_emails (email_sha256, alias_sha256, reason, banned_by, banned_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        sha256(email.trim().toLowerCase()),
        sha256(normalizeEmailAlias(email)),
        reason,
        by,
        this.now(),
      )
  }

  /**
   * 这个邮箱在黑名单上没有。**两条都查**：字面量与规范化别名。
   *
   * 只查字面量的后果是删号封邮箱之后，那个人五秒钟就能拿 `me+2@gmail.com` 回来。
   */
  emailBanned(email: string): boolean {
    return (
      (this.db
        .prepare<{ n: number }>(
          'SELECT COUNT(*) AS n FROM banned_emails WHERE email_sha256 = ? OR alias_sha256 = ?',
        )
        .get(sha256(email.trim().toLowerCase()), sha256(normalizeEmailAlias(email)))?.n ?? 0) > 0
    )
  }

  // ── 组织停用 ────────────────────────────────────────────────────────

  suspendOrg(org_id: string, reason: string): void {
    this.db
      .prepare('UPDATE cloud_orgs SET suspended_at = ?, suspended_reason = ? WHERE id = ?')
      .run(this.now(), reason, org_id)
  }

  resumeOrg(org_id: string): void {
    this.db
      .prepare('UPDATE cloud_orgs SET suspended_at = NULL, suspended_reason = NULL WHERE id = ?')
      .run(org_id)
  }

  // ── 注册赠送（70 §2，WP121）────────────────────────────────────────

  /**
   * 这个邮箱领过注册赠送了吗。**按规范化别名查**，不是按账号 id。
   *
   * 只按账号 id 查的后果是 `me+1@gmail.com`、`me+2@gmail.com`、`m.e@gmail.com`
   * 各是一个账号，同一个人想领几份领几份。
   */
  signupBonusOf(
    email: string,
  ): { account_id: string; credits: number; granted_at: string } | undefined {
    return this.db
      .prepare<{ account_id: string; credits: number; granted_at: string }>(
        'SELECT account_id, credits, granted_at FROM signup_bonuses WHERE alias_sha256 = ?',
      )
      .get(sha256(normalizeEmailAlias(email)))
  }

  /**
   * 记一行"这个别名领过了"。
   *
   * `INSERT OR IGNORE`：并发两跳同时走到这里时，后一跳什么也不做。真正挡住
   * 第二笔积分的是钱包那头 `(org_id, source_ref)` 的唯一索引；这一行挡的是
   * **换个别名再来一次**。两道都要，各挡一种。
   */
  recordSignupBonus(input: {
    email: string
    account_id: string
    org_id: string
    credits: number
    lot_id?: string | undefined
  }): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO signup_bonuses
           (alias_sha256, account_id, org_id, credits, granted_at, lot_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sha256(normalizeEmailAlias(input.email)),
        input.account_id,
        input.org_id,
        input.credits,
        this.now(),
        input.lot_id ?? null,
      )
  }

  /** 一共送出去了多少（后台「积分与会员」那一页的一格）。 */
  signupBonusTotals(): { count: number; credits: number } {
    const row = this.db
      .prepare<{ n: number; c: number | null }>(
        'SELECT COUNT(*) AS n, SUM(credits) AS c FROM signup_bonuses',
      )
      .get()
    return { count: row?.n ?? 0, credits: row?.c ?? 0 }
  }

  suspendedOrgs(org_ids: string[]): Set<string> {
    if (org_ids.length === 0) return new Set()
    const holes = org_ids.map(() => '?').join(', ')
    return new Set(
      this.db
        .prepare<{ id: string }>(
          `SELECT id FROM cloud_orgs WHERE id IN (${holes}) AND suspended_at IS NOT NULL`,
        )
        .all(...org_ids)
        .map((r) => r.id),
    )
  }

  orgSuspension(org_id: string): { at: string; reason: string } | undefined {
    const row = this.db
      .prepare<{ suspended_at: string | null; suspended_reason: string | null }>(
        'SELECT suspended_at, suspended_reason FROM cloud_orgs WHERE id = ?',
      )
      .get(org_id)
    if (row?.suspended_at == null) return undefined
    return { at: row.suspended_at, reason: row.suspended_reason ?? '' }
  }

  // ── 审计 ────────────────────────────────────────────────────────────

  /**
   * 写一条审计。**永不抛**（KOLAgents 那条，照搬）。
   *
   * 审计写失败不该把"封禁这个人"也一起失败掉——那会让一个真实的、已经决定要做的
   * 处置因为一张日志表而不发生。写不进去就往 stderr 上喊一声，让人去看库。
   */
  audit(entry: {
    action: AuditAction
    actor_account_id: string
    actor_role: string
    target_kind: string
    target_id: string
    outcome: 'intent' | 'done' | 'failed'
    details?: Record<string, unknown>
    ip?: string
    warn?: (line: string) => void
  }): void {
    try {
      this.db
        .prepare(
          `INSERT INTO admin_audit
             (at, action, actor_account_id, actor_role, target_kind, target_id, outcome, details, ip)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          this.now(),
          entry.action,
          entry.actor_account_id,
          entry.actor_role,
          entry.target_kind,
          entry.target_id,
          entry.outcome,
          JSON.stringify(entry.details ?? {}),
          entry.ip ?? 'unknown',
        )
    } catch (err) {
      const warn = entry.warn ?? ((line: string) => process.stderr.write(line))
      warn(`[admin-audit] 写不进去：${entry.action} ${entry.target_id} ${String(err)}\n`)
    }
  }

  auditPage(f: {
    limit?: number | undefined
    offset?: number | undefined
    action?: string | undefined
    target_id?: string | undefined
  }): { rows: AuditEntry[]; total: number } {
    const clauses: string[] = ['1 = 1']
    const params: SyncDbValue[] = []
    if (f.action !== undefined && f.action !== '') {
      clauses.push('action = ?')
      params.push(f.action)
    }
    if (f.target_id !== undefined && f.target_id !== '') {
      clauses.push('target_id = ?')
      params.push(f.target_id)
    }
    const where = clauses.join(' AND ')
    const total =
      this.db
        .prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM admin_audit WHERE ${where}`)
        .get(...params)?.n ?? 0
    const rows = this.db
      .prepare<{
        id: number
        at: string
        action: string
        actor_account_id: string
        actor_role: string
        target_kind: string
        target_id: string
        outcome: string
        details: string
        ip: string
      }>(`SELECT * FROM admin_audit WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...params, Math.min(f.limit ?? 50, 200), f.offset ?? 0)
    return {
      total,
      rows: rows.map((r) => ({
        id: r.id,
        at: r.at,
        action: r.action as AuditAction,
        actor_account_id: r.actor_account_id,
        actor_role: r.actor_role as AuditEntry['actor_role'],
        target_kind: r.target_kind as AuditEntry['target_kind'],
        target_id: r.target_id,
        outcome: r.outcome as AuditEntry['outcome'],
        details: JSON.parse(r.details) as Record<string, unknown>,
        ip: r.ip,
      })),
    }
  }

  // ── 会员 ────────────────────────────────────────────────────────────

  createTerm(term: Omit<MembershipTerm, 'id'> & { id?: string }): MembershipTerm {
    const id = term.id ?? this.#id('mst')
    this.db
      .prepare(
        `INSERT INTO membership_terms
           (id, org_id, plan_id, anchor_at, starts_at, ends_at, status, created_by, created_at, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        term.org_id,
        term.plan_id,
        term.anchor_at,
        term.starts_at,
        term.ends_at,
        term.status,
        term.created_by,
        term.created_at,
        term.note ?? null,
      )
    return { ...term, id }
  }

  /**
   * 落一批 cycle。`INSERT OR IGNORE` + `grant_key` 唯一索引 = **重跑安全**：
   * 同一个 term 被重算一次（比如改了 ends_at）不会把已经发过的那几个月复制一遍。
   */
  putCycles(cycles: Omit<MembershipCycle, 'id'>[]): void {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO membership_cycles
         (id, term_id, org_id, idx, starts_at, ends_at, grant_key, credits)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    this.db.transaction(() => {
      for (const c of cycles)
        insert.run(
          this.#id('msc'),
          c.term_id,
          c.org_id,
          c.index,
          c.starts_at,
          c.ends_at,
          c.grant_key,
          c.credits,
        )
    })
  }

  term(id: string): MembershipTerm | undefined {
    const row = this.db
      .prepare<Record<string, string | null>>('SELECT * FROM membership_terms WHERE id = ?')
      .get(id)
    return row === undefined ? undefined : rowToTerm(row)
  }

  terms(f: { org_id?: string | undefined; limit?: number | undefined } = {}): MembershipTerm[] {
    const where = f.org_id === undefined || f.org_id === '' ? '' : ' WHERE org_id = ?'
    const params = f.org_id === undefined || f.org_id === '' ? [] : [f.org_id]
    return this.db
      .prepare<Record<string, string | null>>(
        `SELECT * FROM membership_terms${where} ORDER BY starts_at DESC LIMIT ?`,
      )
      .all(...params, Math.min(f.limit ?? 100, 500))
      .map(rowToTerm)
  }

  /** 这些组织里现在有会员的那几个（"会员"徽章）。 */
  activeMemberOrgs(org_ids: string[]): Set<string> {
    if (org_ids.length === 0) return new Set()
    const holes = org_ids.map(() => '?').join(', ')
    const now = this.now()
    return new Set(
      this.db
        .prepare<{ org_id: string }>(
          `SELECT DISTINCT org_id FROM membership_terms
            WHERE org_id IN (${holes}) AND status = 'active' AND starts_at <= ? AND ends_at > ?`,
        )
        .all(...org_ids, now, now)
        .map((r) => r.org_id),
    )
  }

  cancelTerm(id: string, by: string, at: string): void {
    // term 即刻结束：`ends_at` 拉到现在，**已发的积分不回收**（65 §7）
    this.db
      .prepare(
        `UPDATE membership_terms
            SET status = 'cancelled', cancelled_at = ?, cancelled_by = ?, ends_at = ?
          WHERE id = ? AND status = 'active'`,
      )
      .run(at, by, at, id)
    // 还没发的那些 cycle 直接删掉：它们从来没有发生过，留着只会让定时任务纠结
    this.db
      .prepare('DELETE FROM membership_cycles WHERE term_id = ? AND granted_at IS NULL')
      .run(id)
  }

  cyclesOf(term_id: string): MembershipCycle[] {
    return this.db
      .prepare<Record<string, string | number | null>>(
        'SELECT * FROM membership_cycles WHERE term_id = ? ORDER BY idx',
      )
      .all(term_id)
      .map(rowToCycle)
  }

  /** 到点该发、还没发的那些 cycle（进程内定时拿它跑）。 */
  dueCycles(now: string, limit = 200): MembershipCycle[] {
    return this.db
      .prepare<Record<string, string | number | null>>(
        `SELECT c.* FROM membership_cycles c
           JOIN membership_terms t ON t.id = c.term_id
          WHERE c.granted_at IS NULL AND c.starts_at <= ? AND t.status = 'active'
          ORDER BY c.starts_at LIMIT ?`,
      )
      .all(now, limit)
      .map(rowToCycle)
  }

  markCycleGranted(id: string, at: string, lot_id: string): void {
    this.db
      .prepare('UPDATE membership_cycles SET granted_at = ?, lot_id = ? WHERE id = ?')
      .run(at, lot_id, id)
  }

  /** 到期的 term 落成 `expired`（只是让列表好看，不影响已发的积分）。 */
  expireTerms(now: string): number {
    return this.db
      .prepare(
        "UPDATE membership_terms SET status = 'expired' WHERE status = 'active' AND ends_at <= ?",
      )
      .run(now).changes
  }

  // ── 删号 ────────────────────────────────────────────────────────────

  /**
   * 账号那一侧的删除：**行留着，字段清空**（墓碑）。
   *
   * 为什么不 `DELETE`：审计里那条 `account.delete` 指着这个 id，钱包里那些
   * 匿名化之后的流水也带着墓碑 id。真删掉的话，三个月后有人问"这一笔是谁的"，
   * 答案是"查无此行"，而不是"一个已经删掉的账号"。
   */
  tombstoneAccount(account_id: string, tombstoneEmail: string): void {
    const now = this.now()
    this.db.transaction(() => {
      this.db
        .prepare("UPDATE cloud_accounts SET email = ?, role = 'user', deleted_at = ? WHERE id = ?")
        .run(tombstoneEmail, now, account_id)
      this.db
        .prepare(
          'UPDATE cloud_sessions SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL',
        )
        .run(now, account_id)
      this.db
        .prepare(
          'UPDATE admin_sessions SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL',
        )
        .run(now, account_id)
      this.db
        .prepare('UPDATE cloud_logins SET used_at = COALESCE(used_at, ?) WHERE account_id = ?')
        .run(now, account_id)
    })
  }

  /** 这个人**独占**的那些组织（他是 owner 且只有他一个成员）。删号时一并清理。 */
  soleOwnedOrgs(account_id: string): string[] {
    return this.db
      .prepare<{ id: string }>(
        `SELECT o.id FROM cloud_orgs o
          WHERE o.owner_account_id = ?
            AND (SELECT COUNT(*) FROM cloud_org_members m WHERE m.org_id = o.id) <= 1
            AND NOT EXISTS (SELECT 1 FROM cloud_org_members m2 WHERE m2.org_id = o.id AND m2.account_id <> ?)`,
      )
      .all(account_id, account_id)
      .map((r) => r.id)
  }

  /** 撤掉这些组织下所有还活着的工作区关联（删号 / 停用时跑）。 */
  revokeLinksOfOrgs(org_ids: string[]): number {
    if (org_ids.length === 0) return 0
    const holes = org_ids.map(() => '?').join(', ')
    return this.db
      .prepare(
        `UPDATE workspace_links SET revoked_at = ?
          WHERE cloud_org_id IN (${holes}) AND revoked_at IS NULL`,
      )
      .run(this.now(), ...org_ids).changes
  }

  /** 组织那一侧的删除：成员清空、组织改名成墓碑。钱与账在 `anonymizeOrg` 里另走。 */
  tombstoneOrgs(org_ids: string[], tombstone: string): void {
    if (org_ids.length === 0) return
    this.db.transaction(() => {
      for (const id of org_ids) {
        this.db.prepare('DELETE FROM cloud_org_members WHERE org_id = ?').run(id)
        this.db.prepare('UPDATE cloud_orgs SET name = ? WHERE id = ?').run(tombstone, id)
      }
    })
  }
}

function rowToTerm(r: Record<string, unknown>): MembershipTerm {
  return {
    id: String(r.id),
    org_id: String(r.org_id),
    plan_id: String(r.plan_id),
    anchor_at: String(r.anchor_at),
    starts_at: String(r.starts_at),
    ends_at: String(r.ends_at),
    status: String(r.status) as MembershipTerm['status'],
    created_by: String(r.created_by),
    created_at: String(r.created_at),
    ...(r.note == null ? {} : { note: String(r.note) }),
    ...(r.cancelled_at == null ? {} : { cancelled_at: String(r.cancelled_at) }),
    ...(r.cancelled_by == null ? {} : { cancelled_by: String(r.cancelled_by) }),
  }
}

function rowToCycle(r: Record<string, unknown>): MembershipCycle {
  return {
    id: String(r.id),
    term_id: String(r.term_id),
    org_id: String(r.org_id),
    index: Number(r.idx),
    starts_at: String(r.starts_at),
    ends_at: String(r.ends_at),
    grant_key: String(r.grant_key),
    credits: Number(r.credits),
    ...(r.granted_at == null ? {} : { granted_at: String(r.granted_at) }),
    ...(r.lot_id == null ? {} : { lot_id: String(r.lot_id) }),
  }
}
