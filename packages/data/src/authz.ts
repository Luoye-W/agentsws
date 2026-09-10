import type {
  Actor,
  DataDomain,
  Operation,
  PermissionScope,
  PersonId,
  RangeRef,
  Sensitivity,
} from '@agentsws/contracts'
import type { SqlDialect } from '@agentsws/core/sql'
import { maxSensitivity, sensitivitiesUpTo, sensitivityLte } from './sensitivity.js'

/**
 * 31 §3.1：每次运行绑定**一个** Assignment，其 scopes 原样生效；**不做跨 Assignment 并集**。
 * 调用方（roles 包 / API 层）负责解析出该 Assignment 的 grants 与 ranges 并原样传进来。
 * 契约里的 `Actor` 没有这两个字段，这里用交叉类型扩展，不改契约（见报告 §4）。
 */
export type DataActor = Actor & {
  readonly grants: readonly PermissionScope[]
  readonly ranges: readonly RangeRef[]
}

/** 读走 `read`；数据层写（stage 提议 / agent_auto 代做）走这两个 op。 */
export const READ_OPS: readonly Operation[] = ['read']
export const WRITE_OPS: readonly Operation[] = ['stage', 'agent_auto']

export interface AccessWhere {
  readonly sql: string
  readonly params: unknown[]
}

/** 判权用的记录侧信息（信封四维中的 range / sensitivity 两维）。 */
export interface RecordFacts {
  readonly owners: readonly PersonId[]
  readonly scope: readonly RangeRef[]
  readonly sensitivity: Sensitivity
}

function opsOverlap(grant: PermissionScope, ops: readonly Operation[]): boolean {
  return grant.ops.some((o) => ops.includes(o))
}

function rangeCovers(grant: PermissionScope, actor: DataActor, rec: RecordFacts): boolean {
  if (grant.range === 'workspace') return true
  if (grant.range === 'own') return rec.owners.includes(actor.person_id)
  // 'assigned'：31 §3.1 空 range 的 Assignment → 查询返回空
  if (actor.ranges.length === 0) return false
  return rec.scope.some((s) => actor.ranges.some((r) => r.kind === s.kind && r.id === s.id))
}

/**
 * 完整元组判定（31 §3.1）：(domain, ops, range, sensitivity) 四维**同时**满足才算这条 grant 放行；
 * 任一维不满足即该 grant 不生效。多条 grant 之间是「整条元组」层面的 OR，不是逐维并集。
 */
export function admittingGrants(
  actor: DataActor,
  domain: DataDomain,
  ops: readonly Operation[],
  rec: RecordFacts,
): PermissionScope[] {
  return actor.grants.filter(
    (g) =>
      g.domain === domain &&
      opsOverlap(g, ops) &&
      rangeCovers(g, actor, rec) &&
      sensitivityLte(rec.sensitivity, g.max_sensitivity),
  )
}

/**
 * 该记录上 actor 能看到的最高字段密级 = 放行这条记录的 grant 里最高的 max_sensitivity。
 * 没有任何 grant 放行 → undefined（记录本身不可见）。
 */
export function fieldCeiling(
  actor: DataActor,
  domain: DataDomain,
  ops: readonly Operation[],
  rec: RecordFacts,
): Sensitivity | undefined {
  return maxSensitivity(admittingGrants(actor, domain, ops, rec).map((g) => g.max_sensitivity))
}

/**
 * 21 §3：**过滤下推到 SQL**，不是取回来再在应用层筛。返回 undefined 表示没有任何 grant 可能命中
 * （空 ranges 的 assigned grant 也落在这里）→ 调用方直接返回空，而不是抛错。
 * `table` 必须是已校验过的标识符（见 defineCollection）。
 *
 * WP40：JSON 数组展开是两个方言唯一不同的地方——SQLite 的 `json_each` 对
 * Postgres 的 `jsonb_array_elements`。判权逻辑本身一个字没变。
 */
export function accessWhere(
  table: string,
  actor: DataActor,
  domain: DataDomain,
  ops: readonly Operation[],
  dialect: SqlDialect = 'sqlite',
): AccessWhere | undefined {
  const parts: string[] = []
  const params: unknown[] = []
  for (const g of actor.grants) {
    if (g.domain !== domain || !opsOverlap(g, ops)) continue
    let rangeSql: string
    if (g.range === 'workspace') {
      rangeSql = '1 = 1'
    } else if (g.range === 'own') {
      // owners 是一个 JSON 字符串数组；两个方言各有各的展开函数
      rangeSql =
        dialect === 'sqlite'
          ? `EXISTS (SELECT 1 FROM json_each("${table}".owners) AS o WHERE o.value = ?)`
          : `EXISTS (SELECT 1 FROM jsonb_array_elements_text("${table}".owners::jsonb) AS o WHERE o = ?)`
      params.push(actor.person_id)
    } else {
      if (actor.ranges.length === 0) continue
      const placeholders = actor.ranges.map(() => '?').join(', ')
      rangeSql =
        dialect === 'sqlite'
          ? `EXISTS (SELECT 1 FROM json_each("${table}".scope) AS s ` +
            `WHERE json_extract(s.value, '$.kind') || ':' || json_extract(s.value, '$.id') ` +
            `IN (${placeholders}))`
          : `EXISTS (SELECT 1 FROM jsonb_array_elements("${table}".scope::jsonb) AS s ` +
            `WHERE (s ->> 'kind') || ':' || (s ->> 'id') ` +
            `IN (${placeholders}))`
      for (const r of actor.ranges) params.push(`${r.kind}:${r.id}`)
    }
    const levels = sensitivitiesUpTo(g.max_sensitivity)
    parts.push(`(${rangeSql} AND "${table}".sensitivity IN (${levels.map(() => '?').join(', ')}))`)
    for (const l of levels) params.push(l)
  }
  if (parts.length === 0) return undefined
  return { sql: `(${parts.join(' OR ')})`, params }
}
