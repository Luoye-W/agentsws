/**
 * 49 M1 → M3 的那一跳：一串 `wst_…` → 谁的账号、哪个组织、哪个工作区、能做什么。
 *
 * 这是 WP59 的服务入口路由包唯一要依赖的东西（契约里的 `CloudTokenVerifier`）。
 * 它**只读库**，不认识 HTTP、不认识 Hono、也不记任何日志——令牌明文不进日志
 * 的最省事办法就是让能看见明文的那段代码根本没有日志出口（21 §5）。
 *
 * 四种情况一律回 `undefined`，**不区分**：撤销了、过期了、格式不对、根本不存在。
 * 区分了就等于给人一个探测接口（"这把撤过" vs "这把没存在过"）。
 */

import { createHash } from 'node:crypto'
import type { Clock, CloudScope, CloudTokenVerifier, VerifiedCloudToken } from '@agentsws/contracts'
import { WORKSPACE_TOKEN_PREFIX } from '@agentsws/contracts'
import type { SyncDb } from '@agentsws/core/sql/sync-db'

const SYSTEM_CLOCK: Clock = { now: () => new Date().toISOString() }

interface VerifyRow {
  id: string
  workspace_id: string
  cloud_org_id: string
  scopes: string
  expires_at: string
  revoked_at: string | null
  created_by: string
}

/**
 * 用云侧的 SQLite 库做 `CloudTokenVerifier`。
 *
 * 验成功会顺手把 `last_used_at` 往前推——那是"这把令牌还在用"的唯一证据，
 * 撤旧令牌时靠它判断"撤了会不会打断谁"。写的是时间，不是计数，也不是调用内容。
 */
export function sqliteTokenVerifier(db: SyncDb, clock: Clock = SYSTEM_CLOCK): CloudTokenVerifier {
  const select = db.prepare<VerifyRow>(
    `SELECT id, workspace_id, cloud_org_id, scopes, expires_at, revoked_at, created_by
     FROM workspace_links WHERE token_sha256 = ?`,
  )
  const touch = db.prepare('UPDATE workspace_links SET last_used_at = ? WHERE id = ?')
  return async (token: string): Promise<VerifiedCloudToken | undefined> => {
    const raw = token.startsWith('Bearer ') ? token.slice('Bearer '.length).trim() : token.trim()
    // 前缀不对的直接出门：省一次库查询，也让"拿会话 token 当服务令牌用"当场失败
    if (!raw.startsWith(WORKSPACE_TOKEN_PREFIX)) return undefined
    const row = select.get(createHash('sha256').update(raw).digest('hex'))
    if (row === undefined) return undefined
    if (row.revoked_at !== null) return undefined
    if (Date.parse(clock.now()) >= Date.parse(row.expires_at)) return undefined
    touch.run(clock.now(), row.id)
    return {
      account_id: row.created_by,
      org_id: row.cloud_org_id,
      workspace_id: row.workspace_id,
      scopes: JSON.parse(row.scopes) as CloudScope[],
    }
  }
}
