/**
 * 用户表与组织表的查询（65 §4）。
 *
 * **两张库**：账号 / 组织 / 关联在 `cloud.sqlite`，钱与计量在 `wallet.sqlite`。
 * 不能 join，所以做法是"先在账号库里取出这一页的 id，再拿这一批 id 去钱包库里
 * 一次查完"——两次查询，不是 N 次。KOLAgents 的组织页是在 `map` 里逐个查余额的，
 * 五十行就是五十次。
 *
 * 排序也在 SQL 里做。唯一一个例外是"按余额排序"：余额在另一张库里，只能把
 * 这一页取出来之后在内存里排——所以按余额排序时**只排当前页**，界面上那一列的
 * 排序箭头会说明这一点。真要全局按余额排，得先把两张库合成一张（那是另一个 WP）。
 */

import type { AdminAccountRow, AdminOrgRow, CloudRole } from '@agentsws/contracts'
import { balancesByOrgs, paidOrgIds, type SqlDriver, usageByOrgs } from '@agentsws/metering'
import type { AdminStore } from './store.js'
import { roleOf } from './store.js'

/** 账号列表能按哪几列排。**白名单**——列名是拼进 SQL 的，不能来自用户输入。 */
export const ACCOUNT_SORTS = {
  created_at: 'a.created_at',
  email: 'a.email',
  role: 'a.role',
} as const

export type AccountSort = keyof typeof ACCOUNT_SORTS

export const ORG_SORTS = {
  created_at: 'o.created_at',
  name: 'o.name',
} as const

export type OrgSort = keyof typeof ORG_SORTS

export interface AccountFilter {
  /** 邮箱模糊搜。**只搜邮箱**——云上没有别的可搜的东西。 */
  q?: string | undefined
  role?: CloudRole | undefined
  banned?: boolean | undefined
  sort?: AccountSort | undefined
  order?: 'asc' | 'desc' | undefined
  limit?: number | undefined
  offset?: number | undefined
}

interface AccountBaseRow {
  id: string
  email: string
  role: string | null
  created_at: string
  deleted_at: string | null
  org_id: string | null
  org_name: string | null
}

/**
 * 用户列表一页。
 *
 * 徽章的优先级是 **封禁 > 会员 > 付费过 > 免费**（65 §5）：一个被封的付费会员
 * 首先是"被封了"，那是看这一行的人当下唯一需要知道的事。
 */
export function listAccounts(
  admin: AdminStore,
  meter: SqlDriver | undefined,
  f: AccountFilter,
): { rows: AdminAccountRow[]; total: number } {
  const clauses: string[] = ['a.deleted_at IS NULL']
  const params: unknown[] = []
  if (f.q !== undefined && f.q.trim() !== '') {
    clauses.push('a.email LIKE ?')
    params.push(`%${f.q.trim().toLowerCase()}%`)
  }
  if (f.role !== undefined) {
    if (f.role === 'user') clauses.push("(a.role IS NULL OR a.role = 'user')")
    else {
      clauses.push('a.role = ?')
      params.push(f.role)
    }
  }
  if (f.banned === true) {
    clauses.push(
      `EXISTS (SELECT 1 FROM account_bans b WHERE b.account_id = a.id AND b.lifted_at IS NULL
                 AND (b.expires_at IS NULL OR b.expires_at > ?))`,
    )
    params.push(admin.now())
  }
  const where = clauses.join(' AND ')
  const total =
    admin.db
      .prepare<unknown[], { n: number }>(
        `SELECT COUNT(*) AS n FROM cloud_accounts a WHERE ${where}`,
      )
      .get(...params)?.n ?? 0
  const column = ACCOUNT_SORTS[f.sort ?? 'created_at']
  const direction = f.order === 'asc' ? 'ASC' : 'DESC'
  const rows = admin.db
    .prepare<unknown[], AccountBaseRow>(
      `SELECT a.id, a.email, a.role, a.created_at, a.deleted_at,
              (SELECT m.org_id FROM cloud_org_members m WHERE m.account_id = a.id ORDER BY m.joined_at LIMIT 1) AS org_id,
              (SELECT o.name FROM cloud_org_members m JOIN cloud_orgs o ON o.id = m.org_id
                WHERE m.account_id = a.id ORDER BY m.joined_at LIMIT 1) AS org_name
         FROM cloud_accounts a WHERE ${where}
        ORDER BY ${column} ${direction}, a.id
        LIMIT ? OFFSET ?`,
    )
    .all(...params, Math.min(f.limit ?? 50, 200), f.offset ?? 0)

  const ids = rows.map((r) => r.id)
  const orgIds = rows.map((r) => r.org_id).filter((v): v is string => v !== null)
  const bans = admin.activeBans(ids)
  const members = admin.activeMemberOrgs(orgIds)
  const balances = meter === undefined ? new Map() : balancesByOrgs(meter, orgIds, admin.now())
  const paid = meter === undefined ? new Set<string>() : paidOrgIds(meter, orgIds)

  return {
    total,
    rows: rows.map((r) => {
      const ban = bans.get(r.id)
      const balance = (balances.get(r.org_id ?? '') as
        | { granted: number; purchased: number }
        | undefined) ?? { granted: 0, purchased: 0 }
      const badge: AdminAccountRow['badge'] =
        ban !== undefined
          ? 'banned'
          : r.org_id !== null && members.has(r.org_id)
            ? 'member'
            : r.org_id !== null && paid.has(r.org_id)
              ? 'paid'
              : 'free'
      return {
        account_id: r.id,
        email: r.email,
        role: roleOf(r.role),
        created_at: r.created_at,
        email_verified: admin.emailVerified(r.id),
        badge,
        org_id: r.org_id,
        org_name: r.org_name,
        credits_granted: balance.granted,
        credits_purchased: balance.purchased,
        banned: ban !== undefined,
        ...(ban?.reason === undefined ? {} : { ban_reason: ban.reason }),
        ...(ban?.expires_at === undefined ? {} : { ban_expires_at: ban.expires_at }),
      }
    }),
  }
}

export interface OrgFilter {
  q?: string | undefined
  suspended?: boolean | undefined
  sort?: OrgSort | undefined
  order?: 'asc' | 'desc' | undefined
  limit?: number | undefined
  offset?: number | undefined
}

interface OrgBaseRow {
  id: string
  name: string
  owner_account_id: string
  owner_email: string | null
  created_at: string
  suspended_at: string | null
  members: number
  active_links: number
}

/** 组织列表一页。近 30 天的用量与成本一次查完（不在循环里查）。 */
export function listOrgs(
  admin: AdminStore,
  meter: SqlDriver | undefined,
  f: OrgFilter,
): { rows: AdminOrgRow[]; total: number } {
  const clauses: string[] = ['1 = 1']
  const params: unknown[] = []
  if (f.q !== undefined && f.q.trim() !== '') {
    clauses.push('(o.name LIKE ? OR o.id = ?)')
    params.push(`%${f.q.trim().toLowerCase()}%`, f.q.trim())
  }
  if (f.suspended === true) clauses.push('o.suspended_at IS NOT NULL')
  const where = clauses.join(' AND ')
  const total =
    admin.db
      .prepare<unknown[], { n: number }>(`SELECT COUNT(*) AS n FROM cloud_orgs o WHERE ${where}`)
      .get(...params)?.n ?? 0
  const column = ORG_SORTS[f.sort ?? 'created_at']
  const direction = f.order === 'asc' ? 'ASC' : 'DESC'
  const now = admin.now()
  const rows = admin.db
    .prepare<unknown[], OrgBaseRow>(
      `SELECT o.id, o.name, o.owner_account_id, o.created_at, o.suspended_at,
              (SELECT a.email FROM cloud_accounts a WHERE a.id = o.owner_account_id) AS owner_email,
              (SELECT COUNT(*) FROM cloud_org_members m WHERE m.org_id = o.id) AS members,
              (SELECT COUNT(*) FROM workspace_links l
                WHERE l.cloud_org_id = o.id AND l.revoked_at IS NULL AND l.expires_at > ?) AS active_links
         FROM cloud_orgs o WHERE ${where}
        ORDER BY ${column} ${direction}, o.id
        LIMIT ? OFFSET ?`,
    )
    .all(now, ...params, Math.min(f.limit ?? 50, 200), f.offset ?? 0)

  const ids = rows.map((r) => r.id)
  const from = new Date(Date.parse(now) - 30 * 24 * 60 * 60 * 1000).toISOString()
  const usage = meter === undefined ? new Map() : usageByOrgs(meter, ids, { from, to: now })
  const balances = meter === undefined ? new Map() : balancesByOrgs(meter, ids, now)

  return {
    total,
    rows: rows.map((r) => {
      const u = (usage.get(r.id) as
        | { calls: number; credits: number; cost_micros: number }
        | undefined) ?? { calls: 0, credits: 0, cost_micros: 0 }
      const b = (balances.get(r.id) as { granted: number; purchased: number } | undefined) ?? {
        granted: 0,
        purchased: 0,
      }
      return {
        org_id: r.id,
        name: r.name,
        owner_account_id: r.owner_account_id,
        owner_email: r.owner_email ?? '',
        created_at: r.created_at,
        members: r.members,
        active_links: r.active_links,
        credits_available: Math.round((b.granted + b.purchased) * 100) / 100,
        credits_30d: u.credits,
        cost_micros_30d: u.cost_micros,
        calls_30d: u.calls,
        suspended: r.suspended_at !== null,
      }
    }),
  }
}

/**
 * 组织抽屉里的工作区关联。**只显示前缀与动作集**——`token_sha256` 一个字节都不回。
 *
 * 前缀是 `wst_` 这四个字符，不是令牌的前四位：令牌明文我们自己也没有（库里只有
 * 哈希），而"哈希的前八位"看着像标识符，实际上是一个可以被用来做彩虹表的把手。
 */
export function linksOfOrg(
  admin: AdminStore,
  org_id: string,
): {
  id: string
  workspace_id: string
  label: string
  prefix: string
  scopes: string[]
  created_at: string
  expires_at: string
  revoked_at: string | null
  last_used_at: string | null
  active: boolean
}[] {
  const now = admin.now()
  return admin.db
    .prepare<
      [string],
      {
        id: string
        workspace_id: string
        label: string
        scopes: string
        created_at: string
        expires_at: string
        revoked_at: string | null
        last_used_at: string | null
      }
    >(
      `SELECT id, workspace_id, label, scopes, created_at, expires_at, revoked_at, last_used_at
         FROM workspace_links WHERE cloud_org_id = ? ORDER BY created_at DESC`,
    )
    .all(org_id)
    .map((r) => ({
      id: r.id,
      workspace_id: r.workspace_id,
      label: r.label,
      prefix: 'wst_',
      scopes: JSON.parse(r.scopes) as string[],
      created_at: r.created_at,
      expires_at: r.expires_at,
      revoked_at: r.revoked_at,
      last_used_at: r.last_used_at,
      active: r.revoked_at === null && r.expires_at > now,
    }))
}

/** 组织抽屉里的成员。 */
export function membersOfOrg(
  admin: AdminStore,
  org_id: string,
): { account_id: string; email: string; role: string; joined_at: string }[] {
  return admin.db
    .prepare<[string], { account_id: string; email: string; role: string; joined_at: string }>(
      `SELECT m.account_id, COALESCE(a.email, '') AS email, m.role, m.joined_at
         FROM cloud_org_members m LEFT JOIN cloud_accounts a ON a.id = m.account_id
        WHERE m.org_id = ? ORDER BY m.joined_at`,
    )
    .all(org_id)
}

/** 组织 id → 名字（用量台账那一页要把 org_id 显示成人看得懂的东西）。 */
export function orgNames(admin: AdminStore, org_ids: string[]): Map<string, string> {
  const out = new Map<string, string>()
  if (org_ids.length === 0) return out
  const holes = org_ids.map(() => '?').join(', ')
  for (const r of admin.db
    .prepare<unknown[], { id: string; name: string }>(
      `SELECT id, name FROM cloud_orgs WHERE id IN (${holes})`,
    )
    .all(...org_ids))
    out.set(r.id, r.name)
  return out
}

/** 邮箱 → 账号 + 主组织。批量发积分时一次解析完一串邮箱。 */
export function resolveOrgByEmail(
  admin: AdminStore,
  email: string,
): { account_id: string; org_id: string; email: string } | undefined {
  const row = admin.db
    .prepare<[string], { id: string; email: string; org_id: string | null }>(
      `SELECT a.id, a.email,
              (SELECT m.org_id FROM cloud_org_members m WHERE m.account_id = a.id ORDER BY m.joined_at LIMIT 1) AS org_id
         FROM cloud_accounts a WHERE a.email = ? AND a.deleted_at IS NULL`,
    )
    .get(email.trim().toLowerCase())
  if (row === undefined || row.org_id === null) return undefined
  return { account_id: row.id, org_id: row.org_id, email: row.email }
}

/** 注册账号总数（KPI 第一格）。删掉的不算。 */
export function accountCount(admin: AdminStore, since?: string): number {
  if (since === undefined)
    return (
      admin.db
        .prepare<[], { n: number }>(
          'SELECT COUNT(*) AS n FROM cloud_accounts WHERE deleted_at IS NULL',
        )
        .get()?.n ?? 0
    )
  return (
    admin.db
      .prepare<[string], { n: number }>(
        'SELECT COUNT(*) AS n FROM cloud_accounts WHERE deleted_at IS NULL AND created_at >= ?',
      )
      .get(since)?.n ?? 0
  )
}
