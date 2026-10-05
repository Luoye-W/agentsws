/**
 * WP234（docs/54 §6.1）：**安放**——一条分配归哪个岗位。
 *
 * 一条职责可以同时出现在几个岗位行里（模板「社媒运营」里有 `social.reddit`，自建的
 * 「Reddit 运营」里也有）。只看岗位行的职责清单，分不出这个人的那一条是在哪个岗位里做的。
 * 安放把这个歧义在源头消掉：一条分配至多安放在一个岗位上。
 *
 * 两条纪律：
 *
 * 1. **安放不带任何权限**。权限、额度、动作面永远看那一条分配本身（05 §4 路由不是并集）；
 *    安放只回答「这条活儿在界面上、在岗位层上下文与记忆里，算哪个岗位的」。
 * 2. **没有安放行的老分配照老规则算**（= WP69 现状，逐字不变）：属于每一个职责清单里
 *    含它的岗位。老工作区升级上来，界面上的岗位一个都不变。
 */
import type { PersonId, RoleId } from '@agentsws/contracts'

/** 工作区底座职责：不算任何岗位的职责（docs/54 §6.1 最后一条）。 */
export const WORKSPACE_BASE_ROLES: ReadonlySet<string> = new Set(['common.member', 'common.owner'])

export interface PlacementLike {
  id: string
  role_id: RoleId
}

export interface PositionRolesLike {
  id: string
  roles: readonly { role: RoleId; default?: boolean }[]
}

/** 安放表的读口：分配 id → 岗位 id（没有 = 没安放）。 */
export type PlacementOf = (assignment_id: string) => string | undefined

/**
 * 这条分配属不属于这个岗位（docs/54 §6.1 归属规则，唯一的一份）。
 *
 * - 有安放行、且那个岗位还在 → **只**属于那一个；
 * - 没有（或安放的岗位已经不在了）→ 属于每一个职责清单里含它的岗位。
 */
export function belongsTo(
  assignment: PlacementLike,
  position: PositionRolesLike,
  placementOf: PlacementOf | undefined,
  exists: (position_id: string) => boolean,
): boolean {
  const placed = placementOf?.(assignment.id)
  if (placed !== undefined && exists(placed)) return placed === position.id
  return position.roles.some((r) => r.role === assignment.role_id)
}

/**
 * 持有人（docs/54 §6.1）：有分配**安放**在这里的人，加上老规则——未安放的分配凑齐
 * 这个岗位默认包的人（05 §2）。
 */
export function holdersByPlacement(
  position: PositionRolesLike,
  people: readonly { person_id: PersonId; held: readonly PlacementLike[] }[],
  placementOf: PlacementOf | undefined,
  exists: (position_id: string) => boolean,
): PersonId[] {
  const wanted = position.roles.filter((r) => r.default === true).map((r) => r.role)
  const out: PersonId[] = []
  for (const person of people) {
    const placedHere = person.held.some((a) => {
      const p = placementOf?.(a.id)
      return p !== undefined && exists(p) && p === position.id
    })
    if (placedHere) {
      out.push(person.person_id)
      continue
    }
    // 老规则只数**没被安放到别处**的分配：被挪走的那条不该还把他算在这里
    const loose = person.held.filter((a) => {
      const p = placementOf?.(a.id)
      return p === undefined || !exists(p)
    })
    if (wanted.length > 0 && wanted.every((r) => loose.some((a) => a.role_id === r)))
      out.push(person.person_id)
  }
  return out
}

/* ------------------------------------------------------------------ */
/* 存储                                                                 */
/* ------------------------------------------------------------------ */

export interface PlacementStore {
  get(assignment_id: string): string | undefined
  set(assignment_id: string, position_id: string): void
  /** 全表（合并 / 移动要按岗位反查）。 */
  list(): { assignment_id: string; position_id: string }[]
}

export function createMemoryPlacements(): PlacementStore {
  const rows = new Map<string, string>()
  return {
    get: (id) => rows.get(id),
    set: (id, position_id) => {
      rows.set(id, position_id)
    },
    list: () => [...rows].map(([assignment_id, position_id]) => ({ assignment_id, position_id })),
  }
}

export const PLACEMENTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS org_placements (assignment_id TEXT PRIMARY KEY, position_id TEXT NOT NULL);
`

/** 落在 org.sqlite 里（与岗位行同一个库：它们是同一层的东西）。 */
export function createSqlitePlacements(db: {
  exec(sql: string): unknown
  prepare(sql: string): {
    get(...args: unknown[]): unknown
    run(...args: unknown[]): unknown
    all(...args: unknown[]): unknown[]
  }
}): PlacementStore {
  db.exec(PLACEMENTS_SCHEMA)
  const getStmt = db.prepare('SELECT position_id FROM org_placements WHERE assignment_id = ?')
  const putStmt = db.prepare(
    'INSERT INTO org_placements (assignment_id, position_id) VALUES (?, ?) ON CONFLICT(assignment_id) DO UPDATE SET position_id = excluded.position_id',
  )
  const allStmt = db.prepare('SELECT assignment_id, position_id FROM org_placements')
  return {
    get: (id) => (getStmt.get(id) as { position_id: string } | undefined)?.position_id,
    set: (id, position_id) => {
      putStmt.run(id, position_id)
    },
    list: () => allStmt.all() as { assignment_id: string; position_id: string }[],
  }
}
