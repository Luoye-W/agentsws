/**
 * Join 向导的装配（20 §4–§5、45 H2 / H3）：个人工作区并进公司。
 *
 * 三步，一步一个动作：
 *
 * 1. `export`——把本工作区的品牌 / 产品线 / 店铺范围与连接清单打成一个包。**只读**。
 * 2. `import`——逐条对照（唯一键在 `@agentsws/catalog/org-keys`），凑成一张
 *    `join_mapping` 审批项。**一个字都不改**：owner 在卡上逐条过，改主意不要代价。
 * 3. `complete`——批准落地：一样的合（公司那份成员 / 判据取并集 + 记 `origin`），
 *    没有的在公司新建，保留两条的各留各的；个人那份一律打 `superseded_by` 变别名，
 *    挂在它上面的岗位范围改指到公司那份并留痕。
 *
 * 四条纪律：
 *
 * - **不自动合"相似"**（45 §4）：`similar` 的 `chosen` 必须来自人；界面不点就按
 *   `suggested`（默认"同一个，取并集"）走，但那也是 owner 按下"批准"这一下带来的。
 * - **凭据不跟着走**（40 §1）：只有 `transfer: true` 的连接才 `transferConnection`，
 *   而那个开关在向导里默认是关的。
 * - **合并可回退**：个人那份不删，只是 `superseded_by`；退出公司（`leave`）就断开。
 * - **落地是幂等的**：同一个 join 落两次，第二次原样回第一次的回执。
 */
import { createRequire } from 'node:module'
import { join as joinPath } from 'node:path'
import type { JoinActor, JoinDecisionInput, JoinImportReceipt, JoinPort } from '@agentsws/api'
import {
  compareJoinBundle,
  deriveStoreRanges,
  joinSummary,
  normalizeExternalId,
  storeRangeKey,
} from '@agentsws/catalog'
import type {
  ApprovalBus,
  Clock,
  Connection,
  EventEnvelope,
  JoinCompleteResult,
  JoinExportBundle,
  JoinMappingPayload,
  JoinObjectComparison,
  JoinObjectKind,
  JoinResolution,
  JoinStoreRange,
  ObjectOrigin,
  PersonId,
  ProductLine,
  ProductLineRule,
  RangeGroup,
  RangeRef,
  WorkspaceId,
} from '@agentsws/contracts'
import { sha256 } from '@agentsws/core'
import { RoleError, type RoleStore } from '@agentsws/roles'
import type BetterSqlite3 from 'better-sqlite3'

/** 一次 Join 的全部状态（落库就是这一份 JSON）。 */
interface JoinRecord {
  id: string
  status: 'pending' | 'completed' | 'left'
  approval_id: string
  payload: JoinMappingPayload
  result?: JoinCompleteResult
}

interface JoinBackend {
  list(): JoinRecord[]
  get(id: string): JoinRecord | undefined
  put(row: JoinRecord): void
  /** 45 H2：公司这边"认得的店铺范围"里，由 Join 新建进来的那些。 */
  storeRanges(): JoinStoreRange[]
  putStoreRange(row: JoinStoreRange): void
  close(): void
}

function createMemoryBackend(): JoinBackend {
  const rows = new Map<string, JoinRecord>()
  const stores = new Map<string, JoinStoreRange>()
  return {
    list: () => [...rows.values()].map((r) => structuredClone(r)),
    get: (id) => {
      const found = rows.get(id)
      return found === undefined ? undefined : structuredClone(found)
    },
    put: (row) => {
      rows.set(row.id, structuredClone(row))
    },
    storeRanges: () => [...stores.values()].map((s) => structuredClone(s)),
    putStoreRange: (row) => {
      stores.set(storeRangeKey(row), structuredClone(row))
    },
    close: () => {
      rows.clear()
      stores.clear()
    },
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS joins (id TEXT PRIMARY KEY, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS join_store_ranges (key TEXT PRIMARY KEY, json TEXT NOT NULL);
`

function createSqliteBackend(dbPath: string): JoinBackend {
  const require = createRequire(import.meta.url)
  const Database = require('better-sqlite3') as typeof BetterSqlite3
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA)
  const putJoin = db.prepare(
    'INSERT INTO joins (id, json) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET json = excluded.json',
  )
  const putStore = db.prepare(
    'INSERT INTO join_store_ranges (key, json) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET json = excluded.json',
  )
  return {
    list: () =>
      (db.prepare('SELECT json FROM joins ORDER BY id').all() as { json: string }[]).map(
        (r) => JSON.parse(r.json) as JoinRecord,
      ),
    get: (id) => {
      const row = db.prepare('SELECT json FROM joins WHERE id = ?').get(id) as
        | { json: string }
        | undefined
      return row === undefined ? undefined : (JSON.parse(row.json) as JoinRecord)
    },
    put: (row) => {
      putJoin.run(row.id, JSON.stringify(row))
    },
    storeRanges: () =>
      (
        db.prepare('SELECT json FROM join_store_ranges ORDER BY key').all() as { json: string }[]
      ).map((r) => JSON.parse(r.json) as JoinStoreRange),
    putStoreRange: (row) => {
      putStore.run(storeRangeKey(row), JSON.stringify(row))
    },
    close: () => {
      db.close()
    },
  }
}

/**
 * Join 要用到的连接面（40 §1 凭据归属）。
 *
 * `transferConnection` 是**可选**的：本机 runtime 认这条，跨 runtime 的适配器会回
 * `not_implemented`（18 §1），有些装配干脆没有这个能力。没有它时向导里那个开关
 * 打开了也交不成——记一条事件说清楚，不静默当成交好了。
 */
export interface JoinConnectPort {
  connections(workspace_id: WorkspaceId): Promise<Connection[]>
  transferConnection?(id: string, to_workspace: WorkspaceId): Promise<Connection>
}

export interface JoinOptions {
  clock: Clock
  /** **目标**（公司）工作区。 */
  workspace_id: WorkspaceId
  roles: RoleStore
  approvals: ApprovalBus
  appendEvent(e: Omit<EventEnvelope, 'id' | 'at'> & { at?: string }): void
  /** 凭据交接；没装配连接面时向导里就只有"不交"这一种可能。 */
  connect?: JoinConnectPort
  /** 给了就落盘（`join.sqlite`）。 */
  dbDir?: string
}

export interface JoinAssembly {
  port: JoinPort
  close(): void
}

const JOIN_ERROR = (code: 'not_found' | 'conflict' | 'invalid_input', msg: string): RoleError =>
  new RoleError(code, msg)

const rangeKeyOf = (r: RangeRef): string => `${r.kind}:${r.id}`

/** 两条判据取并集（同平台才调得到这儿——不同平台在对照那一步就 `none` 了）。 */
export function unionRule(a: ProductLineRule, b: ProductLineRule): ProductLineRule {
  if (a.platform !== b.platform) return structuredClone(a)
  const merge = (x?: readonly string[], y?: readonly string[]): string[] | undefined => {
    if (x === undefined && y === undefined) return undefined
    return [...new Set([...(x ?? []), ...(y ?? [])])]
  }
  if (a.platform === 'manual' && b.platform === 'manual')
    return { platform: 'manual', product_ids: merge(a.product_ids, b.product_ids) ?? [] }
  if (a.platform === 'amazon' && b.platform === 'amazon') {
    const asins = merge(a.asins, b.asins)
    const prefixes = merge(a.sku_prefixes, b.sku_prefixes)
    const brand = a.brand ?? b.brand
    return {
      platform: 'amazon',
      ...(asins === undefined ? {} : { asins }),
      ...(prefixes === undefined ? {} : { sku_prefixes: prefixes }),
      ...(brand === undefined ? {} : { brand }),
    }
  }
  if (a.platform === 'shopify' && b.platform === 'shopify') {
    const collections = merge(a.collection_ids, b.collection_ids)
    const tags = merge(a.tags, b.tags)
    const vendors = merge(a.vendors, b.vendors)
    const types = merge(a.product_types, b.product_types)
    return {
      platform: 'shopify',
      ...(collections === undefined ? {} : { collection_ids: collections }),
      ...(tags === undefined ? {} : { tags }),
      ...(vendors === undefined ? {} : { vendors }),
      ...(types === undefined ? {} : { product_types: types }),
    }
  }
  return structuredClone(a)
}

export function createJoin(options: JoinOptions): JoinAssembly {
  const { clock, roles, approvals, appendEvent, workspace_id } = options
  const backend =
    options.dbDir === undefined
      ? createMemoryBackend()
      : createSqliteBackend(joinPath(options.dbDir, 'join.sqlite'))

  const emit = (
    type: string,
    actor: PersonId | 'system',
    payload: Record<string, unknown>,
  ): void => {
    appendEvent({
      schema_version: 1,
      workspace_id,
      type,
      actor: actor === 'system' ? { kind: 'system', id: 'join' } : { kind: 'person', id: actor },
      correlation: { trace_id: 'join' },
      payload,
    })
  }

  const live = (id: WorkspaceId): { groups: RangeGroup[]; lines: ProductLine[] } => ({
    groups: roles.rangeGroups.list(id).filter((g) => g.superseded_by === undefined),
    lines: roles.productLines.list(id).filter((l) => l.superseded_by === undefined),
  })

  /**
   * 公司这边"认得的店铺 / 平台账号范围"。
   *
   * 没有一张"店铺表"——范围就是岗位、品牌、产品线上出现过的那些 id（`rangeOptions`
   * 也是这么算的）。再并上由 Join 新建进来的那些（`join_store_ranges`）。
   */
  const companyStoreRanges = (): JoinStoreRange[] => {
    const { groups, lines } = live(workspace_id)
    return deriveStoreRanges({
      assignment_ranges: roles.assignments
        .listByWorkspace(workspace_id, {})
        .filter((a) => a.revoked_at === undefined)
        .flatMap((a) => a.ranges),
      range_groups: groups,
      product_lines: lines,
      extra: backend.storeRanges(),
    })
  }

  const holders = (kind: JoinObjectKind, id: string): number => {
    if (kind === 'range_group') return roles.rangeGroups.assignments(id).length
    if (kind === 'product_line') return roles.productLines.assignments(id).length
    return roles.assignments
      .listByWorkspace(workspace_id, {})
      .filter((a) => a.revoked_at === undefined && a.ranges.some((r) => r.id === id)).length
  }

  const exportBundle = (actor: JoinActor): JoinExportBundle => {
    const { groups, lines } = live(actor.workspace_id)
    // 导出包里的店铺范围不含产品线的父范围：那一条会跟着产品线自己走
    const stores = deriveStoreRanges({
      assignment_ranges: roles.assignments
        .listByWorkspace(actor.workspace_id, {})
        .filter((a) => a.revoked_at === undefined)
        .flatMap((a) => a.ranges),
      range_groups: groups,
      product_lines: [],
    })
    return {
      schema_version: 1,
      workspace_id: actor.workspace_id,
      person_id: actor.person_id,
      exported_at: clock.now(),
      range_groups: groups.map((g) => structuredClone(g)),
      product_lines: lines.map((l) => structuredClone(l)),
      store_ranges: stores,
      connections: [],
    }
  }

  /* ── 落地 ──────────────────────────────────────────────────────── */

  /** 把 owner 在卡上的选择贴回对照表（没提到的按 `suggested`）。 */
  const applyDecisions = (
    payload: JoinMappingPayload,
    input: JoinDecisionInput,
  ): JoinObjectComparison[] => {
    const chosen = new Map((input.objects ?? []).map((o) => [o.unique_key, o] as const))
    return payload.objects.map((o) => {
      const pick = chosen.get(o.unique_key)
      const resolution = (pick?.chosen ?? o.chosen ?? o.suggested) as JoinResolution
      if (!o.options.includes(resolution))
        throw JOIN_ERROR(
          'invalid_input',
          `「${o.mine.name}」不能选「${resolution}」——这一条只有 ${o.options.join(' / ')}`,
        )
      return {
        ...o,
        chosen: resolution,
        ...(pick?.name_choice === undefined ? {} : { name_choice: pick.name_choice }),
      }
    })
  }

  /** 45 H3：个人那条落进库里并打上别名（原来的 id 保住，退出时能恢复）。 */
  const aliasPersonal = (
    o: JoinObjectComparison,
    source_workspace: WorkspaceId,
    person: PersonId,
    to: string,
  ): void => {
    if (o.kind === 'range_group') {
      const existing = roles.rangeGroups.get(o.mine.id)
      if (existing === undefined)
        roles.rangeGroups.create({
          id: o.mine.id,
          workspace_id: source_workspace,
          name: o.mine.name,
          members: o.mine.members ?? [],
          origin: { workspace_id: source_workspace, person_id: person },
          superseded_by: to,
        })
      else roles.rangeGroups.supersede(o.mine.id, to)
      return
    }
    if (o.kind === 'product_line') {
      const existing = roles.productLines.get(o.mine.id)
      if (existing === undefined && o.mine.parent !== undefined && o.mine.rule !== undefined)
        roles.productLines.create({
          id: o.mine.id,
          workspace_id: source_workspace,
          name: o.mine.name,
          parent: o.mine.parent,
          rule: o.mine.rule,
          origin: { workspace_id: source_workspace, person_id: person },
          superseded_by: to,
        })
      else if (existing !== undefined) roles.productLines.supersede(o.mine.id, to)
    }
  }

  /**
   * 45 H3 最后一句：挂在被取代对象上的岗位范围自动指到公司那份。
   *
   * 品牌走 `range_groups`（改完 `assignments.update` 会自己重新展开成员）；
   * 产品线与店铺范围走 `ranges` 里的 id 替换。每条记一条 `range.alias_resolved`，
   * 范围真的变了再记一条 `assignment.range_expanded`（44 G5 的留痕口径）。
   */
  const rewriteAssignments = (
    aliases: { kind: JoinObjectKind; from: string; to: string }[],
    person: PersonId,
    direction: 'to_company' | 'back_to_personal',
  ): number => {
    const byId = new Map(aliases.map((a) => [a.from, a] as const))
    if (byId.size === 0) return 0
    let count = 0
    for (const a of roles.assignments.listByWorkspace(workspace_id, {})) {
      if (a.revoked_at !== undefined) continue
      const groupsBefore = a.range_groups ?? []
      const groupsAfter = groupsBefore.map((g) => byId.get(g)?.to ?? g)
      const rangesBefore = a.ranges
      const rangesAfter = rangesBefore.map((r) => {
        const hit = byId.get(r.id)
        return hit === undefined || hit.kind === 'range_group' ? r : { kind: r.kind, id: hit.to }
      })
      const groupsChanged = groupsAfter.some((g, i) => g !== groupsBefore[i])
      const rangesChanged = rangesAfter.some(
        (r, i) => rangeKeyOf(r) !== rangeKeyOf(rangesBefore[i] ?? r),
      )
      if (!groupsChanged && !rangesChanged) continue
      const next = roles.assignments.update(a.id, {
        ranges: rangesAfter,
        ...(groupsChanged ? { range_groups: groupsAfter } : {}),
      })
      count += 1
      emit('range.alias_resolved', person, {
        assignment_id: a.id,
        direction,
        changed: aliases.filter((x) => byId.has(x.from)).map((x) => ({ from: x.from, to: x.to })),
      })
      const beforeKeys = new Set(a.ranges.map(rangeKeyOf))
      const added = next.ranges.filter((r) => !beforeKeys.has(rangeKeyOf(r)))
      const afterKeys = new Set(next.ranges.map(rangeKeyOf))
      const removed = a.ranges.filter((r) => !afterKeys.has(rangeKeyOf(r)))
      if (added.length > 0 || removed.length > 0)
        emit('assignment.range_expanded', 'system', {
          assignment_id: a.id,
          person_id: a.person_id,
          role_id: a.role_id,
          reason: 'join_alias',
          added,
          removed,
        })
    }
    return count
  }

  const port: JoinPort = {
    export: (actor) => exportBundle(actor),

    async import(actor, bundle) {
      if (bundle.workspace_id === actor.workspace_id)
        throw JOIN_ERROR('invalid_input', '这个包就是本工作区导出来的，不用并进自己')
      const join_id = `join_${sha256(`${bundle.workspace_id}:${actor.workspace_id}:${bundle.person_id}`).slice(0, 12)}`
      const services = (await options.connect?.connections(workspace_id))?.map((c) => c.service)
      const payload = compareJoinBundle({
        bundle,
        company: {
          range_groups: live(workspace_id).groups,
          product_lines: live(workspace_id).lines,
          store_ranges: companyStoreRanges(),
        },
        holders,
        ...(services === undefined ? {} : { companyServices: services }),
        join_id,
        target_workspace_id: workspace_id,
      })
      const summary = joinSummary(payload)
      const item = await approvals.create({
        workspace_id,
        schema_version: 1,
        kind: 'join_mapping',
        role_id: 'common.owner',
        subject: { object: { type: 'policy', id: `join:${join_id}` } },
        dedupe_key: `${workspace_id}:join:${join_id}`,
        title: `${bundle.person_id} 要把个人工作区并进公司`,
        summary,
        payload: payload as unknown as Record<string, unknown>,
        evidence: {
          source_events: [],
          diff: { before: {}, after: { objects: payload.counts }, summary },
          provenance: { seen: [] },
          precheck: { permission_diff: 'ok', semantic_diff: 'ok' },
        },
        proposer: { kind: 'person', id: bundle.person_id },
        // 14：合并组织结构是 owner 的事，**不自动放行**
        automation: {
          level_at_creation: 'L1',
          auto_approved: false,
          mandate_check: { within: true, caps_hit: [] },
          sampling: { selected: false },
        },
        routing: {
          recipients: [],
          rule: 'owner',
          escalation: {
            after_hours: 72,
            business_hours: true,
            chain: ['owner'],
            escalated_at: [],
          },
          separation_of_duties: false,
        },
        priority: 'queue',
      })
      backend.put({ id: join_id, status: 'pending', approval_id: item.id, payload })
      emit('join.started', bundle.person_id, {
        join_id,
        source_workspace_id: bundle.workspace_id,
        objects: payload.objects.length,
        counts: payload.counts,
      })
      return {
        join_id,
        approval_item_id: item.id,
        status: 'pending_approval',
        payload,
        summary,
      } satisfies JoinImportReceipt
    },

    list(_actor) {
      return backend
        .list()
        .filter((r) => r.status === 'pending')
        .map((r) => r.payload)
    },

    get(_actor, join_id) {
      return backend.get(join_id)?.payload
    },

    async complete(actor, join_id, input) {
      const record = backend.get(join_id)
      if (record === undefined) throw JOIN_ERROR('not_found', `没有这次 Join：${join_id}`)
      // 落两次回同一份回执（14 §6 幂等）
      if (record.status === 'completed' && record.result !== undefined) return record.result

      const source = record.payload.source_workspace_id
      const person = record.payload.person_id
      const origin = (object_id: string): ObjectOrigin => ({
        workspace_id: source,
        person_id: person,
        object_id,
      })
      const decided = applyDecisions(record.payload, input)
      const aliases: { kind: JoinObjectKind; from: string; to: string }[] = []
      let merged = 0
      let created = 0
      let kept = 0

      for (const o of decided) {
        const chosen = o.chosen ?? o.suggested
        if (chosen === 'skip') continue

        if (chosen === 'merge_union' && o.theirs !== undefined) {
          if (o.kind === 'range_group') {
            const company = roles.rangeGroups.get(o.theirs.id)
            if (company === undefined) continue
            const members = [...company.members, ...(o.mine.members ?? [])]
            const name = o.name_choice === 'personal' ? o.mine.name : company.name
            roles.rangeGroups.update(company.id, { name, members, origin: origin(o.mine.id) })
            emit('range_group.merged', person, {
              range_group_id: company.id,
              from: o.mine.id,
              name,
              members: roles.rangeGroups.get(company.id)?.members.length ?? 0,
            })
          } else if (o.kind === 'product_line') {
            const company = roles.productLines.get(o.theirs.id)
            if (company === undefined || o.mine.rule === undefined) continue
            const rule = unionRule(company.rule, o.mine.rule)
            const name = o.name_choice === 'personal' ? o.mine.name : company.name
            roles.productLines.update(company.id, { name, rule, origin: origin(o.mine.id) })
            emit('product_line.merged', person, {
              product_line_id: company.id,
              from: o.mine.id,
              name,
              platform: rule.platform,
            })
          }
          aliasPersonal(o, source, person, o.theirs.id)
          aliases.push({ kind: o.kind, from: o.mine.id, to: o.theirs.id })
          merged += 1
          continue
        }

        if (chosen === 'adopt_company' && o.theirs !== undefined) {
          aliasPersonal(o, source, person, o.theirs.id)
          aliases.push({ kind: o.kind, from: o.mine.id, to: o.theirs.id })
          merged += 1
          continue
        }

        if (chosen === 'create_in_company' || chosen === 'keep_both') {
          if (o.kind === 'range_group') {
            const made = roles.rangeGroups.create({
              workspace_id,
              name:
                o.name_choice === 'company' && o.theirs !== undefined ? o.theirs.name : o.mine.name,
              members: o.mine.members ?? [],
              origin: origin(o.mine.id),
            })
            emit('range_group.created', person, {
              range_group_id: made.id,
              name: made.name,
              members: made.members.length,
              from_join: join_id,
            })
            if (chosen === 'create_in_company') {
              aliasPersonal(o, source, person, made.id)
              aliases.push({ kind: o.kind, from: o.mine.id, to: made.id })
            }
          } else if (
            o.kind === 'product_line' &&
            o.mine.parent !== undefined &&
            o.mine.rule !== undefined
          ) {
            const made = roles.productLines.create({
              workspace_id,
              name: o.mine.name,
              parent: o.mine.parent,
              rule: o.mine.rule,
              origin: origin(o.mine.id),
            })
            emit('product_line.created', person, {
              product_line_id: made.id,
              name: made.name,
              parent: made.parent,
              platform: made.rule.platform,
              from_join: join_id,
            })
            if (chosen === 'create_in_company') {
              aliasPersonal(o, source, person, made.id)
              aliases.push({ kind: o.kind, from: o.mine.id, to: made.id })
            }
          } else if (o.kind === 'store_range' && o.mine.platform !== undefined) {
            // 店铺范围没有一张自己的表：公司"认得它"就是把它记进来（`rangeOptions` 看得到）
            backend.putStoreRange({
              range: { kind: 'store', id: o.mine.id },
              platform: o.mine.platform,
              external_id: normalizeExternalId(o.mine.platform, o.mine.id),
              name: o.mine.name,
            })
          }
          if (chosen === 'create_in_company') created += 1
          else kept += 1
          continue
        }

        kept += 1
      }

      const range_rewrites = rewriteAssignments(aliases, person, 'to_company')

      let transferred_connections = 0
      for (const c of input.connections ?? []) {
        if (!c.transfer) continue
        // 40 §1：本人明确打开开关的才走。交不成（没装配 / 跨 runtime）**说出来**，
        // 不静默当成交好了——凭据在谁手上是这件事的全部意义。
        const transfer = options.connect?.transferConnection
        if (transfer === undefined) {
          emit('join.mapped', person, {
            join_id,
            connection_id: c.connection_id,
            transferred: false,
            reason: 'transfer_unavailable',
          })
          continue
        }
        await transfer(c.connection_id, workspace_id)
        emit('connect.connection_transferred', person, {
          connection_id: c.connection_id,
          to_workspace: workspace_id,
          from_join: join_id,
        })
        transferred_connections += 1
      }

      const result: JoinCompleteResult = {
        join_id,
        merged,
        created,
        kept,
        transferred_connections,
        aliases,
        range_rewrites,
      }
      backend.put({
        ...record,
        status: 'completed',
        payload: { ...record.payload, objects: decided },
        result,
      })
      emit('join.completed', actor.person_id, {
        join_id,
        merged,
        created,
        kept,
        transferred_connections,
        range_rewrites,
      })
      return result
    },

    leave(_actor, join_id) {
      const record = backend.get(join_id)
      if (record === undefined) throw JOIN_ERROR('not_found', `没有这次 Join：${join_id}`)
      if (record.result === undefined)
        throw JOIN_ERROR('conflict', '这次 Join 还没落地，没有别名可断')
      let restored = 0
      // 20 §4.4：公司那份留下，别名断开，个人那份恢复可编辑
      for (const alias of record.result.aliases) {
        if (alias.kind === 'range_group' && roles.rangeGroups.get(alias.from) !== undefined) {
          roles.rangeGroups.supersede(alias.from, undefined)
          restored += 1
        } else if (
          alias.kind === 'product_line' &&
          roles.productLines.get(alias.from) !== undefined
        ) {
          roles.productLines.supersede(alias.from, undefined)
          restored += 1
        }
      }
      const back = record.result.aliases.map((a) => ({ kind: a.kind, from: a.to, to: a.from }))
      const rewrites = rewriteAssignments(back, record.payload.person_id, 'back_to_personal')
      backend.put({ ...record, status: 'left' })
      emit('workspace.archived', record.payload.person_id, {
        join_id,
        left: true,
        restored,
        rewrites,
      })
      return { restored, rewrites }
    },
  }

  return {
    port,
    close() {
      backend.close()
    },
  }
}
