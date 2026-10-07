/**
 * WP252（决策 125）：一台电脑一个 OpenConnector、多个品牌共用时，**哪条连接是哪个品牌的**。
 *
 * 上游没有 workspace 概念，命名连接在同一个 provider 下按名字唯一。WP66 起每个品牌各有一个适配器、
 * 各有一份 `connect-adapter.json`，可连接名默认都叫 `default`，而且「本品牌没记录过的连接」也算成本品牌的——
 * 两个品牌连同一家服务（INMO 与 Rollout 都连 Shopify）就会互相覆盖、互相看见。
 *
 * 这里收三样东西：
 * 1. **连接名带品牌**（{@link brandConnectionName}）：新建的连接叫 `<别名>--<品牌段>`，同一个 provider 在
 *    不同品牌下各是各的一条，上游的 PUT 不会再把别人的凭据顶掉。
 * 2. **整台机一份归属表**（{@link ConnectionOwners}）：连接 id → 品牌。所有品牌的适配器共用同一个实例，
 *    只列 / 只用 / 只签本品牌的；启动品牌兼容老数据（没人认领、名字不带品牌段的老 `default` 归它）。
 * 3. **迁移**（{@link migrateConnectionOwners}）：老连接不改名，只在我们这边把各品牌状态文件里记过的归属
 *    补记进来（幂等）；同一条连接被两个品牌都记过（都用了 `default`）→ 归启动品牌，另一个品牌留一条
 *    「请重新连接」。
 *
 * 文件里没有任何凭据：只有连接 id、品牌、provider 与上游连接名。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Iso8601, WorkspaceId } from '@agentsws/contracts'

/** 别名与品牌段之间的分隔。上游连接名里只放 `[A-Za-z0-9_-]` 与用户自己给的别名。 */
export const BRAND_NAME_SEPARATOR = '--'

/** 品牌段：workspace id 去掉 `[a-z0-9_]` 以外的字符（`ws_0llwvcm2` 原样）。 */
export function brandSegment(workspace_id: WorkspaceId): string {
  const seg = workspace_id.toLowerCase().replace(/[^a-z0-9_]/g, '')
  return seg === '' ? 'ws' : seg
}

/** 新建连接在上游的名字：`<别名>--<品牌段>`。已经带了本品牌段的不再套一层。 */
export function brandConnectionName(workspace_id: WorkspaceId, alias: string): string {
  const seg = brandSegment(workspace_id)
  const suffix = `${BRAND_NAME_SEPARATOR}${seg}`
  return alias.endsWith(suffix) ? alias : `${alias}${suffix}`
}

/** 拆上游连接名：带品牌段的回 `{ alias, segment }`，老名字（`default`）回 `undefined`。 */
export function parseBrandConnectionName(
  name: string,
): { alias: string; segment: string } | undefined {
  const at = name.lastIndexOf(BRAND_NAME_SEPARATOR)
  if (at <= 0) return undefined
  const segment = name.slice(at + BRAND_NAME_SEPARATOR.length)
  if (!/^[a-z0-9_]+$/.test(segment)) return undefined
  return { alias: name.slice(0, at), segment }
}

/** 归属从哪来：本品牌新连的 / 迁移补记的 / 启动品牌认领的老连接 / 转移过来的。 */
export type ConnectionOwnerVia = 'connected' | 'migrated' | 'legacy' | 'transferred'

export interface ConnectionOwnerRecord {
  connection_id: string
  workspace_id: WorkspaceId
  /** 上游 provider（迁移时还不知道，第一次列到它时补上）。 */
  service?: string
  /** 上游连接名（同上）。 */
  connection_name?: string
  via: ConnectionOwnerVia
  since: Iso8601
}

/**
 * 迁移时撞上的那一种：同一条连接被两个品牌都记过。`kept_by` 留着它，`moved_from` 要重新连接。
 * `moved_from` 那边看到一条「请重新连接」；`kept_by` 那边在核对之前带一句提醒（凭据可能是对方最后写进去的）。
 */
export interface ConnectionConflictRecord {
  connection_id: string
  kept_by: WorkspaceId
  moved_from: WorkspaceId
  service?: string
  connection_name?: string
  at: Iso8601
  /** 留着它的那一边核对过了（点过「测试」）——提醒不再显示。 */
  kept_checked?: boolean
}

export interface ConnectionOwnersFile {
  version: 1
  owners: ConnectionOwnerRecord[]
  conflicts: ConnectionConflictRecord[]
}

/** 同一个文件在一个进程里只开一份：所有品牌的适配器看的是同一张表。 */
const OPEN = new Map<string, ConnectionOwners>()

/**
 * 连接归属表（内存 + 可选文件）。
 *
 * **先到先得**：{@link claim} 只在没人认领时写入，已经是别的品牌的就原样回给调用方——一个品牌的
 * 适配器永远改不动另一个品牌的归属；只有显式的 {@link assign}（转移连接）会改。
 */
export class ConnectionOwners {
  private readonly owners = new Map<string, ConnectionOwnerRecord>()
  private conflicts: ConnectionConflictRecord[] = []

  /** 按文件路径共享实例（同一进程里所有品牌拿到的是同一个对象）；不给路径就是一份只在内存里的。 */
  static open(file?: string): ConnectionOwners {
    if (file === undefined) return new ConnectionOwners()
    const hit = OPEN.get(file)
    if (hit !== undefined) return hit
    const fresh = new ConnectionOwners(file)
    OPEN.set(file, fresh)
    return fresh
  }

  /** 测试与进程收尾用：忘掉按路径共享的实例（下次 `open` 从文件重读）。 */
  static forget(file: string): void {
    OPEN.delete(file)
  }

  constructor(private readonly file?: string | undefined) {
    if (file === undefined || !existsSync(file)) return
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<ConnectionOwnersFile>
      for (const r of parsed.owners ?? []) this.owners.set(r.connection_id, r)
      this.conflicts = [...(parsed.conflicts ?? [])]
    } catch {
      // 文件坏了从空开始：老连接会按「启动品牌认领 + 各品牌状态文件迁移」重新补记
    }
  }

  ownerOf(connection_id: string): ConnectionOwnerRecord | undefined {
    return this.owners.get(connection_id)
  }

  /** 没人认领就记成 `record.workspace_id` 的；已经有主了就回现在的主（不改）。 */
  claim(record: ConnectionOwnerRecord): ConnectionOwnerRecord {
    const existing = this.owners.get(record.connection_id)
    if (existing !== undefined) {
      // 同一个品牌再认一次：顺手补上之前不知道的 provider / 连接名
      if (existing.workspace_id === record.workspace_id) this.describe(record)
      return existing
    }
    this.owners.set(record.connection_id, { ...record })
    if (record.via === 'connected' && record.service !== undefined) {
      this.resolveReconnects(record.workspace_id, record.service)
    }
    this.flush()
    return record
  }

  /** 显式改主（转移连接）。 */
  assign(record: ConnectionOwnerRecord): void {
    this.owners.set(record.connection_id, { ...record })
    this.flush()
  }

  /** 连接在上游删掉了：归属一起删（「请重新连接」那条不动——那一边仍要重连）。 */
  release(connection_id: string): void {
    if (!this.owners.delete(connection_id)) return
    // 留下的那一边的提醒随连接一起没了；让出去的那一边照旧要重连
    for (const c of this.conflicts) if (c.connection_id === connection_id) c.kept_checked = true
    this.flush()
  }

  /** 补上 provider / 连接名（任何一个品牌列到这条连接时都会顺手补，好让「请重新连接」那一行知道是哪家服务）。 */
  describe(input: { connection_id: string; service?: string; connection_name?: string }): void {
    let changed = false
    const rec = this.owners.get(input.connection_id)
    if (rec !== undefined) changed = fill(rec, input) || changed
    for (const c of this.conflicts) {
      if (c.connection_id === input.connection_id) changed = fill(c, input) || changed
    }
    if (changed) this.flush()
  }

  all(): ConnectionOwnerRecord[] {
    return [...this.owners.values()].map((r) => ({ ...r }))
  }

  /** 这个品牌要重新连接的那几条（迁移时让给了别的品牌）。 */
  reconnectsOf(workspace_id: WorkspaceId): ConnectionConflictRecord[] {
    return this.conflicts.filter((c) => c.moved_from === workspace_id).map((c) => ({ ...c }))
  }

  /** 这个品牌留下的、还没核对过的那几条（凭据可能是另一个品牌最后写进去的）。 */
  keptUncheckedOf(workspace_id: WorkspaceId): ConnectionConflictRecord[] {
    return this.conflicts
      .filter((c) => c.kept_by === workspace_id && c.kept_checked !== true)
      .map((c) => ({ ...c }))
  }

  addConflict(record: ConnectionConflictRecord): boolean {
    const dup = this.conflicts.some(
      (c) => c.connection_id === record.connection_id && c.moved_from === record.moved_from,
    )
    if (dup) return false
    this.conflicts.push({ ...record })
    this.flush()
    return true
  }

  /** 「请重新连接」那一行被点了断开：只删这条提醒，上游那条连接（别的品牌的）一个字节不碰。 */
  dismissReconnect(workspace_id: WorkspaceId, connection_id: string): boolean {
    const before = this.conflicts.length
    this.conflicts = this.conflicts.filter(
      (c) => !(c.moved_from === workspace_id && c.connection_id === connection_id),
    )
    if (this.conflicts.length === before) return false
    this.flush()
    return true
  }

  /** 留下的那一边核对过了（测试通过）。 */
  markKeptChecked(workspace_id: WorkspaceId, connection_id: string): void {
    let changed = false
    for (const c of this.conflicts) {
      if (c.kept_by === workspace_id && c.connection_id === connection_id && !c.kept_checked) {
        c.kept_checked = true
        changed = true
      }
    }
    if (changed) this.flush()
  }

  /** 这个品牌给同一个 provider 连上了自己的一条：那几条「请重新连接」就结了。 */
  private resolveReconnects(workspace_id: WorkspaceId, service: string): void {
    this.conflicts = this.conflicts.filter(
      (c) => !(c.moved_from === workspace_id && c.service === service),
    )
  }

  snapshot(): ConnectionOwnersFile {
    return {
      version: 1,
      owners: this.all(),
      conflicts: this.conflicts.map((c) => ({ ...c })),
    }
  }

  private flush(): void {
    if (this.file === undefined) return
    mkdirSync(dirname(this.file), { recursive: true })
    // 先写临时文件再改名：写到一半断电不会留下半个 JSON
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, `${JSON.stringify(this.snapshot(), null, 2)}\n`, 'utf8')
    renameSync(tmp, this.file)
  }
}

function fill(
  target: { service?: string; connection_name?: string },
  input: { service?: string; connection_name?: string },
): boolean {
  let changed = false
  if (target.service === undefined && input.service !== undefined) {
    target.service = input.service
    changed = true
  }
  if (target.connection_name === undefined && input.connection_name !== undefined) {
    target.connection_name = input.connection_name
    changed = true
  }
  return changed
}

// ── 迁移 ────────────────────────────────────────────────────────────────

/** 一个品牌的老状态文件（`connect-adapter.json`）。 */
export interface BrandStateSource {
  workspace_id: WorkspaceId
  /** 不存在就当这个品牌什么都没记过。 */
  stateFile: string
}

export interface ConnectionOwnersMigration {
  /** 这一趟新补记了几条归属。 */
  claimed: number
  /** 这一趟新记了几条「两个品牌都用过」。 */
  conflicts: number
  /** 早就有归属、这一趟没动的。 */
  skipped: number
}

/**
 * 把各品牌老状态文件里记过的连接归属补记进归属表（**幂等**：已经有主的一条不动、冲突不重复记）。
 *
 * - 只有一个品牌记过 → 归它；
 * - 两个以上品牌都记过（都用 `default` 连了同一家服务，上游是同一条连接）→ 归启动品牌；
 *   启动品牌没记过它时归 workspace id 排序最前的那个（确定性），其余品牌各留一条「请重新连接」。
 *
 * 不改任何连接名、不碰上游；没人记过的老连接不在这里处理——启动品牌的适配器第一次列到时认领（`legacy`）。
 */
export function migrateConnectionOwners(
  owners: ConnectionOwners,
  input: { startup: WorkspaceId; brands: readonly BrandStateSource[]; now: Iso8601 },
): ConnectionOwnersMigration {
  const claimants = new Map<string, Set<WorkspaceId>>()
  for (const brand of input.brands) {
    for (const ws of recordedConnections(brand)) {
      const set = claimants.get(ws.connection_id) ?? new Set<WorkspaceId>()
      set.add(ws.workspace_id)
      claimants.set(ws.connection_id, set)
    }
  }
  const out: ConnectionOwnersMigration = { claimed: 0, conflicts: 0, skipped: 0 }
  for (const [connection_id, set] of [...claimants.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (owners.ownerOf(connection_id) !== undefined) {
      out.skipped += 1
      continue
    }
    const brands = [...set].sort((a, b) => a.localeCompare(b))
    const keeper = set.has(input.startup) ? input.startup : (brands[0] as WorkspaceId)
    owners.claim({ connection_id, workspace_id: keeper, via: 'migrated', since: input.now })
    out.claimed += 1
    for (const loser of brands) {
      if (loser === keeper) continue
      const added = owners.addConflict({
        connection_id,
        kept_by: keeper,
        moved_from: loser,
        at: input.now,
      })
      if (added) out.conflicts += 1
    }
  }
  return out
}

/** 一个品牌老状态文件里记过的 `{ 连接 id, 归哪个品牌 }`（读不了 / 坏了就是空）。 */
function recordedConnections(
  brand: BrandStateSource,
): { connection_id: string; workspace_id: WorkspaceId }[] {
  if (!existsSync(brand.stateFile)) return []
  try {
    const parsed = JSON.parse(readFileSync(brand.stateFile, 'utf8')) as {
      connections?: { connection_id?: unknown; workspace_id?: unknown }[]
    }
    const out: { connection_id: string; workspace_id: WorkspaceId }[] = []
    for (const c of parsed.connections ?? []) {
      if (typeof c.connection_id !== 'string') continue
      // 转移过的那条记的是目标品牌；没写的按文件所属品牌算
      const ws = typeof c.workspace_id === 'string' ? c.workspace_id : brand.workspace_id
      out.push({ connection_id: c.connection_id, workspace_id: ws })
    }
    return out
  } catch {
    return []
  }
}
