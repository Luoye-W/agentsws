/**
 * 45 H4「建之后」那一半：夜里扫一遍，同唯一键或相似的三类对象出一张
 * `policy_change` 卡「这两条是同一个吗」，owner 选合并。
 *
 * 为什么还要扫：建之前那八个入口只拦得住走界面的人。并发（两个人同一秒各建一条）、
 * 走 API 的脚本、从 Join 带进来的老数据，都可能在公司里留下第二份。
 *
 * 三条纪律：
 *
 * 1. **一对一张卡，永远**。批了、驳了、过期了都不再出——`org_duplicate_pairs`
 *    记着这一对已经问过谁了。只靠审批总线的 `dedupe_key` 不够：同键的旧项进了终态，
 *    下一次 `create` 会另开一张新卡 supersede 它，于是每晚一张，成了噪音。
 * 2. **不自动合并**（45 §4）：这一步只出卡。合并发生在下一次扫描时看到"卡批了"，
 *    走的是 Join 用的同一段 `mergeOrgPair` + `rewriteAliasedAssignments`。
 * 3. **选"维持现状"就是两条**：卡上第二个选项不是"以后别问了"的开关，
 *    但因为第 1 条，它事实上就是——这一对不会再问第二遍。
 */
import { createRequire } from 'node:module'
import { join as joinPath } from 'node:path'
import {
  deriveStoreRanges,
  findOrgDuplicatePairs,
  mergeOrgPair,
  type OrgExisting,
  rewriteAliasedAssignments,
} from '@agentsws/catalog'
import type {
  ApprovalBus,
  ApprovalItem,
  Clock,
  EventEnvelope,
  Iso8601,
  JoinObjectKind,
  PersonId,
  WorkspaceId,
} from '@agentsws/contracts'
import { sha256 } from '@agentsws/core'
import type { RoleStore } from '@agentsws/roles'
import type BetterSqlite3 from 'better-sqlite3'

/** 已经问过的一对。 */
interface PairRecord {
  /** 去重键：kind + 两条 id（排过序）。 */
  id: string
  kind: JoinObjectKind
  approval_id: string
  keep: string
  drop: string
  status: 'asked' | 'merged' | 'dropped'
}

interface PairBackend {
  all(): PairRecord[]
  put(row: PairRecord): void
  close(): void
}

function createMemoryBackend(): PairBackend {
  const rows = new Map<string, PairRecord>()
  return {
    all: () => [...rows.values()].map((r) => ({ ...r })),
    put: (row) => {
      rows.set(row.id, { ...row })
    },
    close: () => {
      rows.clear()
    },
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS org_duplicate_pairs (id TEXT PRIMARY KEY, json TEXT NOT NULL);
`

function createSqliteBackend(dbPath: string): PairBackend {
  const require = createRequire(import.meta.url)
  const Database = require('better-sqlite3') as typeof BetterSqlite3
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA)
  const put = db.prepare(
    'INSERT INTO org_duplicate_pairs (id, json) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET json = excluded.json',
  )
  return {
    all: () =>
      (
        db.prepare('SELECT json FROM org_duplicate_pairs ORDER BY id').all() as { json: string }[]
      ).map((r) => JSON.parse(r.json) as PairRecord),
    put: (row) => {
      put.run(row.id, JSON.stringify(row))
    },
    close: () => {
      db.close()
    },
  }
}

export interface OrgDuplicateScanOptions {
  workspace_id: WorkspaceId
  clock: Clock
  roles: RoleStore
  approvals: ApprovalBus
  appendEvent(e: Omit<EventEnvelope, 'id' | 'at'> & { at?: string }): void
  /**
   * 卡发给谁。14 §13.3：`policy_change` 只有 owner 可决——收件人是空的，
   * 那张卡谁都点不动（`没有属于本人的 decision_token`）。
   */
  owner(): Promise<PersonId | undefined>
  /** 给了就落盘（`org-duplicates.sqlite`）。 */
  dbDir?: string
}

export interface OrgDuplicateScanResult {
  /** 这一轮新问出去几张卡。 */
  asked: number
  /** 这一轮把几对真的合了（上一轮的卡批了）。 */
  merged: number
  /** 有几对被人选了"维持现状"。 */
  kept: number
  /** 有几条岗位范围因为合并被改指。 */
  range_rewrites: number
}

export interface OrgDuplicateScan {
  run(now?: Iso8601): Promise<OrgDuplicateScanResult>
  close(): void
}

const APPROVED = new Set(['approved', 'approved_edited', 'auto_approved', 'applying', 'applied'])
const DEAD = new Set(['rejected', 'withdrawn', 'expired', 'superseded', 'blocked'])

/**
 * 卡上那两个选项。
 *
 * 自己写而不是让 deck 拿 `before` / `after` 兜底：这张卡问的不是"改不改"，
 * 是"这两条是不是同一个"。「按提议改 / 维持现状」在这儿读着莫名其妙。
 */
const OPTIONS = [
  { id: 'merge', label: '是同一个，合成一条' },
  { id: 'keep_both', label: '不是，当两条' },
] as const

/** 选择题卡上选的是"当两条"。 */
function keptAsIs(item: ApprovalItem): boolean {
  const edited = item.decision?.edited_payload
  if (edited === null || typeof edited !== 'object') return false
  return (edited as { selected_option_id?: unknown }).selected_option_id === 'keep_both'
}

const KIND_TEXT: Record<JoinObjectKind, string> = {
  range_group: '品牌',
  product_line: '产品线',
  store_range: '店铺 / 平台账号',
}

export function createOrgDuplicateScan(options: OrgDuplicateScanOptions): OrgDuplicateScan {
  const { clock, roles, approvals, appendEvent, workspace_id } = options
  const backend =
    options.dbDir === undefined
      ? createMemoryBackend()
      : createSqliteBackend(joinPath(options.dbDir, 'org-duplicates.sqlite'))

  const emit = (type: string, payload: Record<string, unknown>): void => {
    appendEvent({
      schema_version: 1,
      workspace_id,
      type,
      actor: { kind: 'system', id: 'org.duplicates' },
      correlation: { trace_id: 'org-duplicates' },
      payload,
    })
  }

  /** 公司现在还活着的三类对象（被取代的是别名，不是第二份）。 */
  const snapshot = (): OrgExisting[] => {
    const groups = roles.rangeGroups.list(workspace_id).filter((g) => g.superseded_by === undefined)
    const lines = roles.productLines.list(workspace_id).filter((l) => l.superseded_by === undefined)
    const live = roles.assignments
      .listByWorkspace(workspace_id, {})
      .filter((a) => a.revoked_at === undefined)
    const out: OrgExisting[] = [
      ...groups.map((g) => ({
        kind: 'range_group' as const,
        id: g.id,
        name: g.name,
        members: g.members,
        holders: roles.rangeGroups.assignments(g.id).length,
        ...(g.created_by === undefined ? {} : { created_by: g.created_by }),
      })),
      ...lines.map((l) => ({
        kind: 'product_line' as const,
        id: l.id,
        name: l.name,
        parent: l.parent,
        rule: l.rule,
        holders: roles.productLines.assignments(l.id).length,
        ...(l.created_by === undefined ? {} : { created_by: l.created_by }),
      })),
    ]
    // 店铺范围：同一家店被两个 id 指着（一个填了域名、一个填了 handle）也是一对
    for (const s of deriveStoreRanges({
      assignment_ranges: live.flatMap((a) => a.ranges),
      range_groups: groups,
      product_lines: lines,
    }))
      out.push({
        kind: 'store_range',
        id: s.range.id,
        name: s.name,
        platform: s.platform,
        external_id: s.external_id,
        holders: live.filter((a) => a.ranges.some((r) => r.id === s.range.id)).length,
      })
    return out
  }

  const pairIdOf = (kind: JoinObjectKind, a: string, b: string): string =>
    `dup_${kind}_${sha256(`${a}|${b}`).slice(0, 16)}`

  /** 上一轮问出去的卡有结论了吗——批了就合，驳了 / 过期了就记一笔"两条"。 */
  const settle = async (): Promise<{ merged: number; kept: number; rewrites: number }> => {
    let merged = 0
    let kept = 0
    let rewrites = 0
    for (const row of backend.all()) {
      if (row.status !== 'asked') continue
      const item = await approvals.get(row.approval_id)
      if (item === undefined) continue
      if (DEAD.has(item.state) || (APPROVED.has(item.state) && keptAsIs(item))) {
        backend.put({ ...row, status: 'dropped' })
        kept += 1
        emit('policy_change.applied', {
          target: 'org_duplicate',
          pair: row.id,
          decision: 'keep_both',
        })
        continue
      }
      if (!APPROVED.has(item.state)) continue
      const result = mergeOrgPair(roles, { kind: row.kind, keep: row.keep, drop: row.drop })
      const aliases = result === undefined ? [] : [{ kind: row.kind, from: row.drop, to: row.keep }]
      const rewrite = rewriteAliasedAssignments(roles, aliases, {
        assignments: roles.assignments.listByWorkspace(workspace_id, {}),
      })
      rewrites += rewrite.rewrites
      for (const trace of rewrite.traces)
        emit(trace.type, {
          assignment_id: trace.assignment_id,
          reason: 'org_duplicate_merge',
          ...(trace.type === 'range.alias_resolved'
            ? { changed: trace.changed }
            : {
                person_id: trace.person_id,
                role_id: trace.role_id,
                added: trace.added,
                removed: trace.removed,
              }),
        })
      if (result !== undefined)
        emit(`${row.kind}.merged`, {
          ...(row.kind === 'range_group'
            ? { range_group_id: result.keep, members: result.members }
            : row.kind === 'product_line'
              ? { product_line_id: result.keep, platform: result.platform }
              : { store_range_id: result.keep }),
          from: result.drop,
          name: result.name,
          reason: 'nightly_scan',
        })
      backend.put({ ...row, status: 'merged' })
      merged += 1
    }
    return { merged, kept, rewrites }
  }

  return {
    async run() {
      const settled = await settle()
      const owner = await options.owner()
      const asked = new Set(backend.all().map((r) => r.id))
      let created = 0
      for (const pair of findOrgDuplicatePairs(snapshot())) {
        const id = pairIdOf(pair.kind, pair.a.id, pair.b.id)
        // 45 H4 幂等：这一对问过一次就够了，批没批都不再问
        if (asked.has(id)) continue
        // 留岗位挂得多的那一条（要改指的分配最少）；一样多就留 id 小的那条——
        // `findOrgDuplicatePairs` 已经把对里两条按 id 排定，于是这个选择每晚都一样。
        const [keep, drop] =
          (pair.a.holders ?? 0) >= (pair.b.holders ?? 0) ? [pair.a, pair.b] : [pair.b, pair.a]
        const what = KIND_TEXT[pair.kind]
        const summary = `公司里有两条${what}看着是同一个：「${keep.name}」（${keep.holders ?? 0} 个岗位挂着）与「${drop.name}」（${drop.holders ?? 0} 个）。${pair.reasons.join('；')}。合了就只剩前面那一条，后面那条变成指向它的别名（随时断得开）；不合就当两条，以后不再问。`
        const item = (await approvals.create({
          workspace_id,
          schema_version: 1,
          kind: 'policy_change',
          role_id: 'common.owner',
          subject: { object: { type: 'policy', id: `${pair.kind}:${keep.id}` } },
          dedupe_key: `${workspace_id}:org_duplicate:${id}`,
          title: `这两条${what}是同一个吗`,
          summary,
          payload: {
            target: 'org_duplicate',
            kind: pair.kind,
            keep: keep.id,
            drop: drop.id,
            verdict: pair.verdict,
            similarity: pair.similarity,
            reasons: pair.reasons,
            options: OPTIONS,
          },
          evidence: {
            source_events: [],
            diff: { before: { a: keep.name, b: drop.name }, after: { merged: keep.name }, summary },
            provenance: { seen: [] },
            precheck: { permission_diff: 'ok', semantic_diff: 'ok' },
          },
          proposer: { kind: 'system', id: 'org.duplicates' },
          // 14：合并组织结构永远是 owner 的事，**不自动放行**（45 §4「任何合并都要人点头」）
          automation: {
            level_at_creation: 'L1',
            auto_approved: false,
            mandate_check: { within: true, caps_hit: [] },
            sampling: { selected: false },
          },
          routing: {
            recipients: owner === undefined ? [] : [{ person: owner, via: 'owner' as const }],
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
        })) as ApprovalItem
        backend.put({
          id,
          kind: pair.kind,
          approval_id: item.id,
          keep: keep.id,
          drop: drop.id,
          status: 'asked',
        })
        asked.add(id)
        created += 1
        emit('policy_change.proposed', {
          target: 'org_duplicate',
          pair: id,
          kind: pair.kind,
          keep: keep.id,
          drop: drop.id,
          approval_item_id: item.id,
          at: clock.now(),
        })
      }
      return {
        asked: created,
        merged: settled.merged,
        kept: settled.kept,
        range_rewrites: settled.rewrites,
      }
    },
    close() {
      backend.close()
    },
  }
}
