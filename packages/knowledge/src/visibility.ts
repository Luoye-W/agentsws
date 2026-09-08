import type { PermissionScope, RangeRef, RetrievalActor } from '@agentsws/contracts'
import { SENSITIVITY_ORDER } from '@agentsws/contracts'

/**
 * 19 §3 过滤下推。契约里的 `RetrievalActor` 只带身份，不带授权；本包用**交叉类型**
 * 扩展出 `GrantedActor`（调用方从 WP3 编译好的 Casbin / PermissionScope 里取），
 * 不改 `packages/contracts`。
 */
export interface ActorGrants {
  /** 本次运行绑定的那一个 Assignment 的 scopes（05：不做跨 Assignment 并集） */
  grants: PermissionScope[]
  /** 该 Assignment 的 ranges，用于 `range: 'assigned'` 的可见性判断 */
  ranges?: RangeRef[]
}
export type GrantedActor = RetrievalActor & ActorGrants

export const rangeKey = (r: RangeRef): string => `${r.kind}:${r.id}`

export const sensitivityRank = (s: string): number => {
  const i = SENSITIVITY_ORDER.indexOf(s as (typeof SENSITIVITY_ORDER)[number])
  return i < 0 ? SENSITIVITY_ORDER.length : i
}

export interface SqlFragment {
  sql: string
  params: (string | number)[]
}

/**
 * 生成"这个 actor 能看见哪些卡"的 WHERE 片段。**先过滤再排序**：调用方把它拼进
 * 检索 SQL 的 WHERE 里，无权数据域根本不进候选集（零命中），而不是命中后脱敏。
 *
 * 规则：workspace 必须一致；至少一条带 `read` 的 scope 同时满足
 * ① 数据域匹配（`company` 视作 `knowledge` 域的公司级知识）
 * ② 卡片敏感度 ≤ 该 scope 的 max_sensitivity
 * ③ 范围：workspace 不限；assigned 要求卡片 scope 与 actor ranges 有交集；own 要求本人是 owner 或创建者。
 */
export function visibilityWhere(actor: GrantedActor, alias = 'c'): SqlFragment {
  const params: (string | number)[] = [actor.workspace_id]
  const clauses: string[] = []
  const ranges = (actor.ranges ?? []).map(rangeKey)

  for (const g of actor.grants) {
    if (!g.ops.includes('read')) continue
    const parts: string[] = []

    const domains = g.domain === 'knowledge' ? [g.domain, 'company'] : [g.domain]
    parts.push(`${alias}.domain IN (${domains.map(() => '?').join(', ')})`)
    params.push(...domains)

    parts.push(`${alias}.sensitivity_rank <= ?`)
    params.push(sensitivityRank(g.max_sensitivity))

    if (g.range === 'assigned') {
      if (ranges.length === 0) {
        parts.push('0')
      } else {
        parts.push(
          `EXISTS (SELECT 1 FROM fact_card_scopes s WHERE s.card_id = ${alias}.id` +
            ` AND s.ref IN (${ranges.map(() => '?').join(', ')}))`,
        )
        params.push(...ranges)
      }
    } else if (g.range === 'own') {
      parts.push(`(${alias}.owner = ? OR ${alias}.created_by_id = ?)`)
      params.push(actor.person_id, actor.person_id)
    }

    clauses.push(`(${parts.join(' AND ')})`)
  }

  const grantSql = clauses.length > 0 ? `(${clauses.join(' OR ')})` : '0'
  return { sql: `${alias}.workspace_id = ? AND ${grantSql}`, params }
}
