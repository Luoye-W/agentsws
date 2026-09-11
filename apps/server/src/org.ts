/**
 * 制度面的装配（WP28 交付 A / B）：把 05 的职责 / 岗位 / 分配 / 策略层与 20 的成员、邀请
 * 装成 `@agentsws/api` 的 `OrgPort`。网关那一层只做路由与权限，业务全在这里（28 §2）。
 *
 * 四条纪律：
 *
 * 1. **改职责模板与改策略层不直接生效**（14 §1 `policy_change`、§13.3「只有 owner 可决」）：
 *    这两件事只建一张卡 + 记一条待办的变更；批准之后才落库。落库发生在**下一次读**
 *    （每个端口方法先 `reconcile()` 一遍）——不需要往审批总线里插钩子，
 *    也就不会与 WP27 的调度、txn 的执行器抢同一个口子。
 * 2. **岗位不落在分配上**：Assignment 里没有 position_id（05 §2「岗位只在分配那一刻展开」）。
 *    所以"谁在做这个岗位" = 谁名下有这个岗位默认包里的全部职责，算出来的，不是存出来的。
 *    好处是撤销一条分配，岗位持有关系自动就没了，不会留下对不上的映射。
 * 3. **撤销即失效**：撤销分配走 `roles.assignments.revoke`（策略行同步摘掉）；
 *    移出成员再加一步 `identity.leaveWorkspace`（该人在本工作区的 token 立刻全废）。
 * 4. **token 不进日志**：邀请的明文 token 只出现在返回给 owner 的那一个链接里，
 *    事件日志与库里都只有它的 sha256。
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type {
  AcceptedInvitationView,
  AssignInput,
  AssignmentView,
  CopyRoleInput,
  InvitationView,
  InviteInput,
  LocalIdentityService,
  MemberView,
  OrgActor,
  OrgChangeReceipt,
  OrgDuplicateQuery,
  OrgPort,
  PolicyPatchInput,
  PositionInput,
  PositionView,
  ProductLineInput,
  ProductLineView,
  RangeGroupView,
  RoleDetailView,
  RolePatchInput,
  RoleSummaryView,
  UpdateAssignInput,
  WorkspacePolicyView,
} from '@agentsws/api'
import {
  deriveStoreRanges,
  findOrgSimilar,
  type OrgCandidate,
  type OrgExisting,
  platformOfRange,
} from '@agentsws/catalog'
import type {
  ApprovalBus,
  ApprovalItem,
  Assignment,
  Clock,
  EventEnvelope,
  Level,
  Mandate,
  Person,
  PersonId,
  Position,
  ProductLine,
  ProductLineRule,
  RangeGroup,
  RangeRef,
  RoleId,
  WorkspaceId,
  WorkspacePolicy,
} from '@agentsws/contracts'
import { canonicalJson, sha256 } from '@agentsws/core'
import {
  parseRole,
  type RangeExpanded,
  type RoleDefinitionFull,
  RoleError,
  type RoleStore,
  shopifyLineQuery,
} from '@agentsws/roles'
import type BetterSqlite3 from 'better-sqlite3'

/** 岗位模板的存储形状（契约 `Position` + 从哪来）。 */
interface StoredPosition extends Position {
  source: 'bundled' | 'custom'
}

/** 一条等审批的制度变更。 */
interface PendingChange {
  id: string
  approval_id: string
  /** 45 H5 加了 `range_group` / `product_line`：成员改不了组织结构，只能提议。 */
  kind: 'role' | 'policy' | 'range_group' | 'product_line'
  /**
   * kind=role 时是改完的整份职责定义；kind=policy 时是改完的整份策略层；
   * 两种范围对象时是一条 {@link PendingRangeChange}（只带真正要改的那几格）。
   */
  doc: string
  status: 'pending' | 'applied' | 'dropped'
}

/** 45 H5：一条批了才落地的「改品牌 / 改产品线」。 */
interface PendingRangeChange {
  /** 落在**真源**那一条上（提议时给的可能是被取代的那份别名）。 */
  id: string
  name?: string
  members?: RangeRef[]
  parent?: RangeRef
  rule?: ProductLineRule
}

interface OrgBackend {
  positions(): StoredPosition[]
  putPosition(p: StoredPosition): void
  deletePosition(id: string): void
  customRoles(): string[]
  putCustomRole(id: string, json: string): void
  pending(): PendingChange[]
  putPending(row: PendingChange): void
  close(): void
}

function createMemoryBackend(): OrgBackend {
  const positions = new Map<string, StoredPosition>()
  const roles = new Map<string, string>()
  const pending = new Map<string, PendingChange>()
  return {
    positions: () => [...positions.values()].map((p) => structuredClone(p)),
    putPosition: (p) => {
      positions.set(p.id, structuredClone(p))
    },
    deletePosition: (id) => {
      positions.delete(id)
    },
    customRoles: () => [...roles.values()],
    putCustomRole: (id, json) => {
      roles.set(id, json)
    },
    pending: () => [...pending.values()].map((p) => ({ ...p })),
    putPending: (row) => {
      pending.set(row.id, { ...row })
    },
    close: () => {
      positions.clear()
      roles.clear()
      pending.clear()
    },
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS org_positions (id TEXT PRIMARY KEY, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS org_roles (id TEXT PRIMARY KEY, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS org_pending (
  id TEXT PRIMARY KEY,
  approval_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  doc TEXT NOT NULL,
  status TEXT NOT NULL
);
`

function createSqliteBackend(dbPath: string): OrgBackend {
  const require = createRequire(import.meta.url)
  const Database = require('better-sqlite3') as typeof BetterSqlite3
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA)
  const upsert = (table: string) =>
    db.prepare(
      `INSERT INTO ${table} (id, json) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET json = excluded.json`,
    )
  const putPositionStmt = upsert('org_positions')
  const putRoleStmt = upsert('org_roles')
  const putPendingStmt = db.prepare(
    `INSERT INTO org_pending (id, approval_id, kind, doc, status) VALUES (@id,@approval_id,@kind,@doc,@status)
     ON CONFLICT(id) DO UPDATE SET status = excluded.status, doc = excluded.doc`,
  )
  return {
    positions: () =>
      (db.prepare('SELECT json FROM org_positions ORDER BY id').all() as { json: string }[]).map(
        (r) => JSON.parse(r.json) as StoredPosition,
      ),
    putPosition: (p) => {
      putPositionStmt.run(p.id, JSON.stringify(p))
    },
    deletePosition: (id) => {
      db.prepare('DELETE FROM org_positions WHERE id = ?').run(id)
    },
    customRoles: () =>
      (db.prepare('SELECT json FROM org_roles ORDER BY id').all() as { json: string }[]).map(
        (r) => r.json,
      ),
    putCustomRole: (id, json) => {
      putRoleStmt.run(id, json)
    },
    pending: () => db.prepare('SELECT * FROM org_pending ORDER BY id').all() as PendingChange[],
    putPending: (row) => {
      putPendingStmt.run(row)
    },
    close: () => {
      db.close()
    },
  }
}

/**
 * 首批岗位（27 §1 三人包那三行）。只保留"职责定义真的在这台机器上"的那些条目：
 * 默认包里一个职责都不剩的岗位不种——界面上出现一个点不动的卡片比没有它更糟。
 */
const SEED_POSITIONS: readonly {
  id: string
  zh: string
  en: string
  roles: [RoleId, boolean][]
}[] = [
  {
    id: 'owner',
    zh: '店主 / 负责人',
    en: 'Owner',
    roles: [
      ['common.owner', true],
      ['dtc.analytics', true],
    ],
  },
  {
    id: 'dtc-support',
    zh: '独立站售后客服',
    en: 'DTC After-sales Support',
    roles: [
      ['dtc.aftersales', true],
      ['common.member', false],
    ],
  },
  { id: 'member', zh: '普通成员', en: 'Member', roles: [['common.member', true]] },
]

export interface OrgOptions {
  clock: Clock
  identity: LocalIdentityService
  roles: RoleStore
  approvals: ApprovalBus
  workspace_id: WorkspaceId
  appendEvent(e: Omit<EventEnvelope, 'id' | 'at'> & { at?: string }): void
  /** 给了就落盘（`org.sqlite`）；不给就纯内存。 */
  dbDir?: string
  /** 邀请链接的前缀；缺省是相对路径（同源打开工作台就能用）。 */
  baseUrl?: string
}

export interface OrgAssembly {
  port: OrgPort
  /**
   * 岗位模板本身（27）。WP51 的首次设置向导要拿它列"你做什么"，
   * 而 `port.positions` 回的是**带持有人**的视图、还要一个 OrgActor——
   * 向导那一步只需要模板，不该为了读一张表先编一个 actor 出来。
   */
  positions(): Position[]
  /**
   * 44 G5：把它接到 `createRoleStore({ onRangeExpanded })` 上——品牌成员一变，
   * 挂它的岗位范围跟着变，这里记事件 + 给 owner 发一张 L3 卡。
   *
   * 为什么不直接在 `updateRangeGroup` 里做：职责层是唯一知道"哪几条分配受影响、
   * 各自多了少了什么"的地方，在这边重算一遍等于把同一条规则写两份。
   */
  onRangeExpanded(e: RangeExpanded): void
  close(): void
}

const ORG_ERROR = (code: 'not_found' | 'conflict' | 'invalid_input' | 'forbidden', msg: string) =>
  new RoleError(code, msg)

/**
 * 45 H5「提议修改」那句理由的最短长度。与 40 §5 E4 的"仍新建"同一个口径：
 * 一句话说不清的改动不该走这条路，owner 是照这句话点头的。
 */
export const MIN_PROPOSAL_REASON = 8

const APPROVED = new Set(['approved', 'approved_edited', 'auto_approved', 'applying', 'applied'])
const DEAD = new Set(['rejected', 'withdrawn', 'expired', 'superseded', 'blocked'])

/** 决定里选的是"维持现状"（deck 给 policy_change 生成的第二个选项）。 */
function keptAsIs(item: ApprovalItem): boolean {
  const edited = item.decision?.edited_payload
  if (edited === null || typeof edited !== 'object') return false
  return (edited as { selected_option_id?: unknown }).selected_option_id === 'before'
}

const capText = (value: Mandate['caps'][string]): string =>
  Array.isArray(value) ? value.join('、') : String(value)

export function createOrg(options: OrgOptions): OrgAssembly {
  const { clock, identity, roles, approvals, workspace_id, appendEvent } = options
  const backend =
    options.dbDir === undefined
      ? createMemoryBackend()
      : createSqliteBackend(join(options.dbDir, 'org.sqlite'))

  // 自定义职责在进程起来时就要挂回注册表，否则重启之后已分配的人解析不到定义
  const custom = new Set<RoleId>()
  for (const json of backend.customRoles()) {
    const role = parseRole(json, 'org:custom')
    roles.roles.register(role)
    custom.add(role.id)
  }

  // 首批岗位：库里空的时候种一次；之后用户怎么改就是怎么样
  if (backend.positions().length === 0) {
    for (const seed of SEED_POSITIONS) {
      const kept = seed.roles.filter(([id]) => roles.roles.get(id) !== undefined)
      if (!kept.some(([, isDefault]) => isDefault)) continue
      backend.putPosition({
        id: seed.id,
        version: '1.0.0',
        name: { zh: seed.zh, en: seed.en },
        roles: kept.map(([role, isDefault]) => ({ role, default: isDefault })),
        source: 'bundled',
      })
    }
  }

  const now = (): string => clock.now()
  const roleName = (id: RoleId): string => roles.roles.get(id)?.name.zh ?? id
  const positionOf = (id: string): StoredPosition | undefined =>
    backend.positions().find((p) => p.id === id)

  const activeAssignments = (person_id?: PersonId): Assignment[] => {
    const all = person_id === undefined ? [] : roles.assignments.listByPerson(person_id, {})
    return all.filter((a) => a.workspace_id === workspace_id && a.revoked_at === undefined)
  }

  const emit = (type: string, actor: PersonId, payload: Record<string, unknown>): void => {
    appendEvent({
      schema_version: 1,
      workspace_id,
      type,
      actor: { kind: 'person', id: actor },
      correlation: { trace_id: 'org' },
      payload,
    })
  }

  // ── 等审批的制度变更 ───────────────────────────────────────────────

  const applyPending = (row: PendingChange): void => {
    if (row.kind === 'role') {
      const role = parseRole(row.doc, 'org:approved-role')
      backend.putCustomRole(role.id, row.doc)
      roles.roles.register(role)
      custom.add(role.id)
      emit('policy_change.applied', 'system', { target: 'role', role_id: role.id })
      return
    }
    // 45 H5：批准之后，成员提的那条改动才真的落到公司那份上
    if (row.kind === 'range_group' || row.kind === 'product_line') {
      const change = JSON.parse(row.doc) as PendingRangeChange
      if (row.kind === 'range_group') {
        roles.rangeGroups.update(change.id, {
          ...(change.name === undefined ? {} : { name: change.name }),
          ...(change.members === undefined ? {} : { members: change.members }),
        })
        emit('range_group.updated', 'system', {
          range_group_id: change.id,
          from_proposal: true,
          ...(change.name === undefined ? {} : { name: change.name }),
        })
      } else {
        roles.productLines.update(change.id, {
          ...(change.name === undefined ? {} : { name: change.name }),
          ...(change.parent === undefined ? {} : { parent: change.parent }),
          ...(change.rule === undefined ? {} : { rule: change.rule }),
        })
        emit('product_line.updated', 'system', {
          product_line_id: change.id,
          from_proposal: true,
          ...(change.name === undefined ? {} : { name: change.name }),
        })
      }
      emit('policy_change.applied', 'system', { target: row.kind, object_id: change.id })
      return
    }
    const policy = JSON.parse(row.doc) as WorkspacePolicy
    roles.policies.set(policy)
    emit('policy_change.applied', 'system', { target: 'workspace_policy' })
  }

  /**
   * 把已经有结论的卡落地。**每个端口方法开头都跑一遍**——制度变更不多，
   * 一次几条 `approvals.get` 便宜过在审批总线上另开一个订阅口。
   */
  const reconcile = async (): Promise<void> => {
    for (const row of backend.pending()) {
      if (row.status !== 'pending') continue
      const item = await approvals.get(row.approval_id)
      if (item === undefined) continue
      if (APPROVED.has(item.state)) {
        // 36 §2.2：policy_change 是选择题卡，"维持现状"也是一次批准——
        // 状态同样是 approved_edited，得看他选的是哪一个（选 before 就是不改）
        if (keptAsIs(item)) backend.putPending({ ...row, status: 'dropped' })
        else {
          applyPending(row)
          backend.putPending({ ...row, status: 'applied' })
        }
      } else if (DEAD.has(item.state)) {
        backend.putPending({ ...row, status: 'dropped' })
      }
    }
  }

  const propose = async (
    actor: OrgActor,
    input: {
      kind: PendingChange['kind']
      doc: string
      title: string
      summary: string
      target: 'role' | 'workspace_policy' | 'range_group' | 'product_line'
      before: unknown
      after: unknown
      affected: string[]
    },
  ): Promise<OrgChangeReceipt> => {
    const workspace = await identity.getWorkspace(workspace_id)
    const owner = workspace?.owner_id ?? actor.person_id
    const fingerprint = sha256(canonicalJson({ kind: input.kind, doc: input.doc })).slice(0, 12)
    const item = (await approvals.create({
      workspace_id,
      schema_version: 1,
      kind: 'policy_change',
      role_id: actor.role_id,
      subject: { object: { type: 'policy', id: `${input.target}:${fingerprint}` } },
      dedupe_key: `${workspace_id}:policy_change:${input.target}:${fingerprint}`,
      title: input.title,
      summary: input.summary,
      payload: {
        target: input.target,
        before: input.before,
        after: input.after,
        affected_assignments: input.affected,
      },
      evidence: {
        source_events: [],
        diff: { before: input.before, after: input.after, summary: input.summary },
        provenance: { seen: [] },
        precheck: { permission_diff: 'ok', semantic_diff: 'ok' },
      },
      proposer: { kind: 'person', id: actor.person_id },
      automation: {
        level_at_creation: 'L1',
        auto_approved: false,
        mandate_check: { within: true, caps_hit: [] },
        sampling: { selected: false },
      },
      routing: {
        // 14 §13.3：policy_change 只有 owner 可决，范围管理者不可
        recipients: [{ person: owner, via: 'owner' }],
        rule: 'owner',
        escalation: { after_hours: 48, business_hours: true, chain: ['owner'], escalated_at: [] },
        separation_of_duties: false,
      },
      priority: 'queue',
    })) as ApprovalItem
    if (item.state === 'blocked') throw ORG_ERROR('conflict', `这条改动没过预检：${item.summary}`)
    backend.putPending({
      id: `pnd_${fingerprint}`,
      approval_id: item.id,
      kind: input.kind,
      doc: input.doc,
      status: 'pending',
    })
    emit('policy_change.proposed', actor.person_id, {
      target: input.target,
      approval_item_id: item.id,
    })
    return {
      status: 'pending_approval',
      approval_item_id: item.id,
      summary: input.summary,
    }
  }

  // ── 视图拼装 ───────────────────────────────────────────────────────

  const summaryOf = (role: RoleDefinitionFull): RoleSummaryView => ({
    id: role.id,
    name: role.name.zh,
    name_en: role.name.en,
    description: role.description,
    domain: role.domain,
    version: role.version,
    source: custom.has(role.id) ? 'custom' : 'bundled',
    editable: custom.has(role.id),
    holders: roles.assignments.listByRole(role.id, { workspace_id }).length,
    home_blocks: role.home_blocks.map((b) => ({
      id: b.id,
      placement: b.placement,
      component: b.component,
    })),
    actions: role.actions.map((a) => ({
      id: a.id,
      kind: a.kind,
      target: a.target,
      route_to: typeof a.route_to === 'string' ? a.route_to : `role:${a.route_to.role}`,
      review_cannot_be_disabled: a.review_cannot_be_disabled ?? false,
      caps: Object.entries(a.mandate.caps).map(([key, value]) => ({
        key,
        value: capText(value),
      })),
      ...(a.mandate.window === undefined
        ? {}
        : { window: { max_count: a.mandate.window.max_count, per: a.mandate.window.per } }),
    })),
    automation: Object.entries(role.automation).map(([action_id, spec]) => ({
      action_id,
      ceiling: spec.ceiling,
      initial: spec.initial,
      hard_ceiling: spec.hard_ceiling ?? false,
    })),
    connectors: role.connectors.map((c) => ({ kind: c.kind, required: c.required })),
  })

  const detailOf = (role: RoleDefinitionFull): RoleDetailView => ({
    ...summaryOf(role),
    scopes: role.scopes.map((s) => ({
      domain: s.domain,
      ops: [...s.ops],
      range: s.range,
      max_sensitivity: s.max_sensitivity,
    })),
    skills: role.skills.map((s) => ({ name: s.name, tier: s.tier, load: s.load })),
  })

  const personName = async (id: PersonId): Promise<string> =>
    (await identity.getPerson(id))?.name ?? id

  const viewOf = async (a: Assignment): Promise<AssignmentView> => {
    const role = roles.roles.get(a.role_id)
    const needsRanges = role?.scopes.some((s) => s.range === 'assigned') ?? false
    return {
      assignment_id: a.id,
      person_id: a.person_id,
      person_name: await personName(a.person_id),
      role_id: a.role_id,
      role_name: roleName(a.role_id),
      role_version: a.role_version,
      ranges: [...a.ranges],
      ...(a.range_groups === undefined || a.range_groups.length === 0
        ? {}
        : { range_groups: [...a.range_groups] }),
      granted_at: a.granted_at,
      ...(a.revoked_at === undefined ? {} : { revoked_at: a.revoked_at }),
      unassigned_range: needsRanges && a.ranges.length === 0,
    }
  }

  // ── 44 品牌与产品线的视图 ─────────────────────────────────────────

  const rangeGroupView = (g: RangeGroup, alias_of?: string): RangeGroupView => ({
    id: g.id,
    name: g.name,
    members: [...g.members],
    created_at: g.created_at,
    updated_at: g.updated_at,
    holders: roles.rangeGroups.assignments(g.id).length,
    // 45 H3：被取代的那一份只能看——改的是公司那条
    ...(g.superseded_by === undefined ? {} : { superseded_by: g.superseded_by, readonly: true }),
    ...(g.origin === undefined ? {} : { origin: { ...g.origin } }),
    ...(alias_of === undefined || alias_of === g.id ? {} : { alias_of }),
  })

  const productLineView = (l: ProductLine, alias_of?: string): ProductLineView => ({
    id: l.id,
    name: l.name,
    parent: { ...l.parent },
    rule: structuredClone(l.rule),
    created_at: l.created_at,
    updated_at: l.updated_at,
    holders: roles.productLines.assignments(l.id).length,
    ...(l.superseded_by === undefined ? {} : { superseded_by: l.superseded_by, readonly: true }),
    ...(l.origin === undefined ? {} : { origin: { ...l.origin } }),
    ...(alias_of === undefined || alias_of === l.id ? {} : { alias_of }),
    // 19 §3：这条判据交得出 `query:` 吗（界面上说"上游先切一刀"还是"拉回来本地切"）
    pushdown: shopifyLineQuery(l.rule) !== undefined,
  })

  /** zod 解出来的可选键带着 `undefined`，契约类型不收——存之前把它们去掉。 */
  const cleanRule = (rule: ProductLineInput['rule']): ProductLineRule => {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(rule)) if (v !== undefined) out[k] = v
    return out as unknown as ProductLineRule
  }

  /**
   * 44 G5：品牌成员变了 → 挂它的岗位范围自动跟上，**但要留痕**。
   *
   * 两件事：一条 `assignment.range_expanded` 事件（40 §1 数据归属的底线），
   * 加一张给 owner 的卡。卡按 **L3** 提（14：默认放行、只通知），因为品牌就是
   * 为了少一遍挨个改——真要拦，owner 在卡上驳回再去改岗位。
   */
  const onRangeExpanded = (e: RangeExpanded): void => {
    emit('assignment.range_expanded', 'system', {
      assignment_id: e.assignment_id,
      person_id: e.person_id,
      role_id: e.role_id,
      range_group: e.range_group,
      added: e.added,
      removed: e.removed,
    })
    pendingExpanded.push(e)
    void flushExpanded()
  }

  /** 攒一拍再发卡：一次改品牌常常影响好几个岗位，人只该看到一张卡。 */
  const pendingExpanded: RangeExpanded[] = []
  let flushing: Promise<void> | undefined
  const flushExpanded = async (): Promise<void> => {
    if (flushing !== undefined) return flushing
    flushing = (async () => {
      // 让同一次 `rangeGroups.update` 里的全部回调先落完，再攒成一张卡
      await Promise.resolve()
      const batch = pendingExpanded.splice(0)
      if (batch.length === 0) return
      const first = batch[0]
      if (first === undefined) return
      const workspace = await identity.getWorkspace(workspace_id)
      const owner = workspace?.owner_id
      if (owner === undefined) return
      const added = batch.flatMap((e) => e.added)
      const removed = batch.flatMap((e) => e.removed)
      const what =
        added.length > 0
          ? `新增了 ${[...new Set(added.map((r) => r.id))].join('、')}`
          : `去掉了 ${[...new Set(removed.map((r) => r.id))].join('、')}`
      const summary = `「${first.range_group_name}」${what}，这 ${batch.length} 个岗位现在跟着看得到 / 看不到了。不想这样就改岗位的范围。`
      const fingerprint = sha256(
        canonicalJson({ group: first.range_group, batch: batch.map((e) => e.assignment_id), what }),
      ).slice(0, 12)
      try {
        await approvals.create({
          workspace_id,
          schema_version: 1,
          kind: 'policy_change',
          role_id: 'common.owner',
          subject: { object: { type: 'policy', id: `range_group:${first.range_group}` } },
          dedupe_key: `${workspace_id}:range_expanded:${fingerprint}`,
          title: `品牌「${first.range_group_name}」的范围变了`,
          summary,
          payload: {
            target: 'range_group',
            range_group: first.range_group,
            affected_assignments: batch.map((e) => e.assignment_id),
            added,
            removed,
          },
          evidence: {
            source_events: [],
            diff: { before: { removed }, after: { added }, summary },
            provenance: { seen: [] },
            precheck: { permission_diff: 'ok', semantic_diff: 'ok' },
          },
          proposer: { kind: 'system', id: 'org.ranges' },
          // 14：L3 = 默认放行、只通知（44 G5「自动跟，但留痕」）
          automation: {
            level_at_creation: 'L3',
            auto_approved: true,
            mandate_check: { within: true, caps_hit: [] },
            sampling: { selected: false },
          },
          routing: {
            recipients: [{ person: owner, via: 'owner' }],
            rule: 'owner',
            escalation: {
              after_hours: 48,
              business_hours: true,
              chain: ['owner'],
              escalated_at: [],
            },
            separation_of_duties: false,
          },
          priority: 'queue',
        })
      } catch {
        // 发不出卡不该把已经改好的范围回滚——事件已经记上了
      }
    })().finally(() => {
      flushing = undefined
      if (pendingExpanded.length > 0) void flushExpanded()
    })
    return flushing
  }

  /** 谁在做这个岗位：默认包里的职责都在他名下才算（05 §2 岗位只是模板）。 */
  const holdersOf = async (
    position: StoredPosition,
    people: PersonId[],
  ): Promise<PositionView['holders']> => {
    const wanted = position.roles.filter((r) => r.default).map((r) => r.role)
    if (wanted.length === 0) return []
    const out: PositionView['holders'] = []
    for (const person of people) {
      const held = activeAssignments(person)
      if (!wanted.every((role) => held.some((a) => a.role_id === role))) continue
      const ranges = new Map<string, RangeRef>()
      for (const a of held)
        if (wanted.includes(a.role_id)) for (const r of a.ranges) ranges.set(`${r.kind}:${r.id}`, r)
      out.push({ person_id: person, name: await personName(person), ranges: [...ranges.values()] })
    }
    return out
  }

  const memberIds = async (): Promise<PersonId[]> =>
    (await identity.members(workspace_id))
      .filter((m) => m.left_at === undefined)
      .map((m) => m.person_id)

  const positionViews = async (): Promise<PositionView[]> => {
    const people = await memberIds()
    const out: PositionView[] = []
    for (const p of backend.positions()) {
      out.push({
        id: p.id,
        name: p.name.zh,
        name_en: p.name.en,
        version: p.version,
        source: p.source,
        roles: p.roles.map((r) => ({
          role_id: r.role,
          name: roleName(r.role),
          default: r.default,
          loaded: roles.roles.get(r.role) !== undefined,
        })),
        holders: await holdersOf(p, people),
      })
    }
    return out
  }

  const policyView = (): WorkspacePolicyView => {
    const policy = roles.policies.get(workspace_id) ?? {
      workspace_id,
      mandates: {},
      global_caps: {},
    }
    return {
      workspace_id,
      mandates: policy.mandates,
      global_caps: policy.global_caps,
      separation_of_duties: policy.separation_of_duties ?? [],
      ...(policy.sensitivity_overrides === undefined
        ? {}
        : { sensitivity_overrides: policy.sensitivity_overrides }),
    }
  }

  const invitationView = (
    inv: Awaited<ReturnType<LocalIdentityService['createInvitation']>>['invitation'],
    url?: string,
  ): InvitationView => ({
    id: inv.id,
    email: inv.email,
    ...(inv.name === undefined ? {} : { name: inv.name }),
    role: inv.role,
    ...(inv.position_id === undefined ? {} : { position_id: inv.position_id }),
    ranges: inv.ranges,
    created_at: inv.created_at,
    expires_at: inv.expires_at,
    ...(inv.accepted_at === undefined ? {} : { accepted_at: inv.accepted_at }),
    used: inv.used,
    ...(url === undefined ? {} : { url }),
    delivered: 'link',
  })

  /** 一个人拿到一个岗位 = 拿到它默认包里的全部职责（已经在做的不重复给）。 */
  const grant = (input: {
    person_id: PersonId
    granted_by: PersonId
    roleIds: RoleId[]
    ranges: RangeRef[]
    /** 44 G1：挂的品牌（范围组）；判权限时展开成成员。 */
    range_groups?: string[]
  }): Assignment[] => {
    const held = activeAssignments(input.person_id)
    const created: Assignment[] = []
    for (const role_id of input.roleIds) {
      if (roles.roles.get(role_id) === undefined)
        throw ORG_ERROR('not_found', `这台机器上没装「${role_id}」这个职责的定义`)
      if (held.some((a) => a.role_id === role_id)) continue
      created.push(
        roles.assignments.create({
          person_id: input.person_id,
          workspace_id,
          role_id,
          granted_by: input.granted_by,
          ranges: input.ranges,
          ...(input.range_groups === undefined || input.range_groups.length === 0
            ? {}
            : { range_groups: input.range_groups }),
        }),
      )
    }
    return created
  }

  // ── 45 H4 建之前先查 ──────────────────────────────────────────────

  /** 问的那一条翻成 catalog 的判定形状（三类各填各的那几格）。 */
  const candidateOf = (query: OrgDuplicateQuery): OrgCandidate => {
    if (query.kind === 'range_group')
      return { kind: 'range_group', name: query.name, members: query.members ?? [] }
    if (query.kind === 'product_line') {
      if (query.parent === undefined || query.rule === undefined)
        throw ORG_ERROR('invalid_input', '查产品线要给"切在哪里面"与"按什么切"')
      return {
        kind: 'product_line',
        name: query.name,
        parent: query.parent,
        rule: cleanRule(query.rule),
      }
    }
    const external_id = query.external_id ?? query.name
    const platform = query.platform ?? platformOfRange({ kind: 'store', id: external_id })
    return { kind: 'store_range', name: query.name, platform, external_id }
  }

  /** 公司这边同类的东西（被取代的那些不算——它们是别名，不是第二份）。 */
  const existingOrgObjects = (kind: OrgDuplicateQuery['kind']): OrgExisting[] => {
    const groups = roles.rangeGroups.list(workspace_id).filter((g) => g.superseded_by === undefined)
    const lines = roles.productLines.list(workspace_id).filter((l) => l.superseded_by === undefined)
    if (kind === 'range_group')
      return groups.map((g) => ({
        kind: 'range_group' as const,
        id: g.id,
        name: g.name,
        members: g.members,
        holders: roles.rangeGroups.assignments(g.id).length,
        ...(g.created_by === undefined ? {} : { created_by: g.created_by }),
      }))
    if (kind === 'product_line')
      return lines.map((l) => ({
        kind: 'product_line' as const,
        id: l.id,
        name: l.name,
        parent: l.parent,
        rule: l.rule,
        holders: roles.productLines.assignments(l.id).length,
        ...(l.created_by === undefined ? {} : { created_by: l.created_by }),
      }))
    const live = roles.assignments
      .listByWorkspace(workspace_id, {})
      .filter((a) => a.revoked_at === undefined)
    return deriveStoreRanges({
      assignment_ranges: live.flatMap((a) => a.ranges),
      range_groups: groups,
      product_lines: lines,
    }).map((s) => ({
      kind: 'store_range' as const,
      id: s.range.id,
      name: s.name,
      platform: s.platform,
      external_id: s.external_id,
      holders: live.filter((a) => a.ranges.some((r) => r.id === s.range.id)).length,
    }))
  }

  // ── 端口 ───────────────────────────────────────────────────────────

  const port: OrgPort = {
    async roles(_actor) {
      await reconcile()
      return roles.roles.list().map(summaryOf)
    },

    async role(_actor, id) {
      await reconcile()
      const found = roles.roles.get(id)
      return found === undefined ? undefined : detailOf(found)
    },

    async copyRole(actor, input: CopyRoleInput) {
      await reconcile()
      const base = roles.roles.get(input.from)
      if (base === undefined) throw ORG_ERROR('not_found', `没有这个职责：${input.from}`)
      let id = `${base.id}-custom`
      for (let n = 2; roles.roles.get(id) !== undefined; n += 1) id = `${base.id}-custom-${n}`
      const next: RoleDefinitionFull = {
        ...structuredClone(base),
        id,
        version: '1.0.0',
        name: {
          zh: input.name ?? `${base.name.zh}（本公司）`,
          en: input.name ?? `${base.name.en} (custom)`,
        },
      }
      const json = JSON.stringify(next)
      // 存之前再过一遍 schema：库里永远只有校验过的定义（05 §0）
      parseRole(json, `org:copy:${id}`)
      backend.putCustomRole(id, json)
      roles.roles.register(next)
      custom.add(id)
      emit('role.copied', actor.person_id, { from: base.id, role_id: id })
      return detailOf(next)
    },

    async proposeRoleChange(actor, id, patch: RolePatchInput) {
      await reconcile()
      const base = roles.roles.get(id)
      if (base === undefined) throw ORG_ERROR('not_found', `没有这个职责：${id}`)
      if (!custom.has(id))
        throw ORG_ERROR(
          'conflict',
          '内置职责模板不给直接改。先「复制一份」，改自己那一份（05 §0：职责定义是配置，带版本）',
        )
      const next: RoleDefinitionFull = structuredClone(base)
      if (patch.name !== undefined) next.name = { ...next.name, zh: patch.name }
      if (patch.name_en !== undefined) next.name = { ...next.name, en: patch.name_en }
      if (patch.description !== undefined) next.description = patch.description
      for (const change of patch.actions ?? []) {
        const action = next.actions.find((a) => a.id === change.id)
        if (action === undefined)
          throw ORG_ERROR('invalid_input', `职责 ${id} 没有「${change.id}」这个动作`)
        for (const [key, value] of Object.entries(change.caps ?? {}))
          action.mandate.caps[key] = value
        if (change.window_max_count !== undefined)
          action.mandate.window = {
            per: action.mandate.window?.per ?? 'day',
            max_count: change.window_max_count,
          }
      }
      for (const change of patch.automation ?? []) {
        const spec = next.automation[change.action_id]
        if (spec === undefined)
          throw ORG_ERROR('invalid_input', `职责 ${id} 没有「${change.action_id}」的自动化设置`)
        if (spec.hard_ceiling === true && change.ceiling !== spec.ceiling)
          throw ORG_ERROR(
            'invalid_input',
            `「${change.action_id}」的自动化上限是写死的（05 §1.4 hard_ceiling），不能改`,
          )
        spec.ceiling = change.ceiling as Level
      }
      const [major = '1', minor = '0', bug = '0'] = next.version.split('.')
      next.version = `${major}.${minor}.${String(Number(bug) + 1)}`
      const json = JSON.stringify(next)
      parseRole(json, `org:patch:${id}`)
      const affected = roles.assignments.listByRole(id, { workspace_id }).map((a) => a.id)
      return propose(actor, {
        kind: 'role',
        doc: json,
        title: `改职责：${base.name.zh}`,
        summary: `${base.name.zh} 的设置要改一处。批准后对这个职责的 ${affected.length} 位在岗同事生效。`,
        target: 'role',
        before: { name: base.name.zh, version: base.version, actions: base.actions },
        after: { name: next.name.zh, version: next.version, actions: next.actions },
        affected,
      })
    },

    async positions(_actor) {
      await reconcile()
      return positionViews()
    },

    async createPosition(actor, input: PositionInput) {
      await reconcile()
      const id =
        input.id ?? `pos-${sha256(canonicalJson({ name: input.name, at: now() })).slice(0, 8)}`
      if (positionOf(id) !== undefined) throw ORG_ERROR('conflict', `岗位 ${id} 已经有了`)
      const stored: StoredPosition = {
        id,
        version: '1.0.0',
        name: { zh: input.name, en: input.name_en ?? input.name },
        roles: input.roles.map((r) => ({ role: r.role_id, default: r.default ?? true })),
        source: 'custom',
      }
      backend.putPosition(stored)
      emit('position.created', actor.person_id, { position_id: id })
      const found = (await positionViews()).find((p) => p.id === id)
      if (found === undefined) throw ORG_ERROR('conflict', '岗位没存住')
      return found
    },

    async updatePosition(actor, id, input: PositionInput) {
      await reconcile()
      const existing = positionOf(id)
      if (existing === undefined) throw ORG_ERROR('not_found', `没有这个岗位：${id}`)
      const [major = '1', minor = '0'] = existing.version.split('.')
      backend.putPosition({
        ...existing,
        name: { zh: input.name, en: input.name_en ?? existing.name.en },
        roles: input.roles.map((r) => ({ role: r.role_id, default: r.default ?? true })),
        version: `${major}.${String(Number(minor) + 1)}.0`,
        // 05 §2：改模板不影响已分配的人，所以这里只动模板，一条分配都不碰
        source: existing.source === 'bundled' ? 'custom' : existing.source,
      })
      emit('position.updated', actor.person_id, { position_id: id })
      const found = (await positionViews()).find((p) => p.id === id)
      if (found === undefined) throw ORG_ERROR('not_found', `没有这个岗位：${id}`)
      return found
    },

    async deletePosition(actor, id) {
      await reconcile()
      const existing = positionOf(id)
      if (existing === undefined) throw ORG_ERROR('not_found', `没有这个岗位：${id}`)
      const holders = await holdersOf(existing, await memberIds())
      if (holders.length > 0)
        throw ORG_ERROR(
          'conflict',
          `还有 ${holders.length} 位同事在做这个岗位（${holders.map((h) => h.name).join('、')}）。先把他们的分配撤掉再删。`,
        )
      backend.deletePosition(id)
      emit('position.deleted', actor.person_id, { position_id: id })
    },

    async assign(actor, input: AssignInput) {
      await reconcile()
      const members = await identity.members(workspace_id)
      if (!members.some((m) => m.person_id === input.person_id && m.left_at === undefined))
        throw ORG_ERROR('not_found', '这个人还不是本工作区的成员，先邀请他加入')
      let roleIds: RoleId[]
      if (input.position_id !== undefined) {
        const position = positionOf(input.position_id)
        if (position === undefined)
          throw ORG_ERROR('not_found', `没有这个岗位：${input.position_id}`)
        const extra = new Set(input.include ?? [])
        const unknown = [...extra].filter((r) => !position.roles.some((x) => x.role === r))
        if (unknown.length > 0)
          throw ORG_ERROR('invalid_input', `岗位 ${position.id} 里没有：${unknown.join('、')}`)
        roleIds = position.roles.filter((r) => r.default || extra.has(r.role)).map((r) => r.role)
      } else if (input.role_id !== undefined) {
        roleIds = [input.role_id]
      } else {
        throw ORG_ERROR('invalid_input', '要么给岗位，要么给一个职责')
      }
      const created = grant({
        person_id: input.person_id,
        granted_by: actor.person_id,
        roleIds,
        ranges: input.ranges,
        ...(input.range_groups === undefined ? {} : { range_groups: input.range_groups }),
      })
      for (const a of created)
        emit('assignment.granted', actor.person_id, {
          assignment_id: a.id,
          person_id: a.person_id,
          role_id: a.role_id,
          ranges: a.ranges,
        })
      return Promise.all(created.map(viewOf))
    },

    async updateAssignment(actor, id, input: UpdateAssignInput) {
      await reconcile()
      const found = roles.assignments.get(id)
      if (found === undefined || found.workspace_id !== workspace_id)
        throw ORG_ERROR('not_found', `没有这条分配：${id}`)
      const overrides: Record<string, Partial<Mandate>> = {}
      for (const [actionId, value] of Object.entries(input.mandate_overrides ?? {}))
        overrides[actionId] = { caps: { ...(value.caps ?? {}) } }
      const next = roles.assignments.update(id, {
        ...(input.ranges === undefined ? {} : { ranges: input.ranges }),
        ...(input.range_groups === undefined ? {} : { range_groups: input.range_groups }),
        ...(input.mandate_overrides === undefined ? {} : { mandate_overrides: overrides }),
      })
      emit('assignment.updated', actor.person_id, { assignment_id: id, ranges: next.ranges })
      return viewOf(next)
    },

    async revokeAssignment(actor, id, input) {
      await reconcile()
      const found = roles.assignments.get(id)
      if (found === undefined || found.workspace_id !== workspace_id)
        throw ORG_ERROR('not_found', `没有这条分配：${id}`)
      const revoked = roles.assignments.revoke(id, {
        ...(input.handover_to === undefined ? {} : { handover_to: input.handover_to }),
      })
      emit('assignment.revoked', actor.person_id, {
        assignment_id: id,
        person_id: revoked.person_id,
        role_id: revoked.role_id,
      })
      return viewOf(revoked)
    },

    async policy(_actor) {
      await reconcile()
      return policyView()
    },

    async proposePolicyChange(actor, input: PolicyPatchInput) {
      await reconcile()
      const before = policyView()
      const sod = input.separation_of_duties ?? before.separation_of_duties
      const next: WorkspacePolicy = {
        workspace_id,
        mandates: (input.mandates ?? before.mandates) as WorkspacePolicy['mandates'],
        global_caps: input.global_caps ?? before.global_caps,
        ...(sod.length === 0 ? {} : { separation_of_duties: sod }),
      }
      return propose(actor, {
        kind: 'policy',
        doc: JSON.stringify(next),
        title: '改公司策略层',
        summary: '公司的授权额度 / 总量上限 / 谁审谁要改一处。批准后对全工作区生效（05 §3）。',
        target: 'workspace_policy',
        before,
        after: next,
        affected: [],
      })
    },

    async members(_actor) {
      await reconcile()
      const list = await identity.members(workspace_id)
      const positions = await positionViews()
      const out: MemberView[] = []
      for (const m of list) {
        const person: Person | undefined = await identity.getPerson(m.person_id)
        const assignments = roles.assignments
          .listByPerson(m.person_id, { workspace_id })
          .filter((a) => a.revoked_at === undefined)
        out.push({
          person_id: m.person_id,
          name: person?.name ?? m.person_id,
          email: person?.email ?? '',
          role: m.role,
          joined_at: m.joined_at,
          ...(m.left_at === undefined ? {} : { left_at: m.left_at }),
          positions: positions
            .filter((p) => p.holders.some((h) => h.person_id === m.person_id))
            .map((p) => ({ id: p.id, name: p.name })),
          assignments: await Promise.all(assignments.map(viewOf)),
        })
      }
      return out
    },

    async removeMember(actor, person_id) {
      await reconcile()
      const workspace = await identity.getWorkspace(workspace_id)
      if (workspace?.owner_id === person_id)
        throw ORG_ERROR('conflict', '工作区所有者不能被移出（先把所有者换给别人）')
      const active = activeAssignments(person_id)
      for (const a of active) roles.assignments.revoke(a.id)
      await identity.leaveWorkspace(workspace_id, person_id)
      emit('membership.removed', actor.person_id, {
        person_id,
        revoked_assignments: active.length,
      })
      return { revoked_assignments: active.length }
    },

    async invitations(_actor) {
      await reconcile()
      return identity.listInvitations(workspace_id).map((inv) => invitationView(inv))
    },

    async invite(actor, input: InviteInput) {
      await reconcile()
      if (input.position_id !== undefined && positionOf(input.position_id) === undefined)
        throw ORG_ERROR('not_found', `没有这个岗位：${input.position_id}`)
      const issued = await identity.createInvitation({
        workspace_id,
        email: input.email,
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.role === undefined ? {} : { role: input.role }),
        ...(input.position_id === undefined ? {} : { position_id: input.position_id }),
        ranges: input.ranges ?? [],
        invited_by: actor.person_id,
      })
      // 事件里只有邀请 id 与邮箱，**没有 token**（21 §5 秘密不落库、不进日志）
      emit('invitation.created', actor.person_id, {
        invitation_id: issued.invitation.id,
        email: issued.invitation.email,
      })
      const url = `${options.baseUrl ?? ''}/invite/${issued.token}`
      return invitationView(issued.invitation, url)
    },

    async accept(token, input) {
      const accepted = await identity.acceptInvitation(token, {
        ...(input.name === undefined ? {} : { name: input.name }),
      })
      if (accepted.invitation.workspace_id !== workspace_id)
        throw ORG_ERROR('not_found', '邀请链接无效或已过期')
      const position =
        accepted.invitation.position_id === undefined
          ? undefined
          : positionOf(accepted.invitation.position_id)
      const roleIds: RoleId[] = position
        ? position.roles.filter((r) => r.default).map((r) => r.role)
        : []
      // 20 §1：加入工作区就有"工作区成员"这条通用职责，不属于任何岗位
      if (roles.roles.get('common.member') !== undefined) roleIds.unshift('common.member')
      const created = grant({
        person_id: accepted.person.id,
        granted_by: accepted.invitation.invited_by,
        roleIds,
        ranges: accepted.invitation.ranges,
      })
      emit('invitation.accepted', accepted.person.id, {
        invitation_id: accepted.invitation.id,
        person_id: accepted.person.id,
      })
      return {
        workspace_id,
        workspace_name: accepted.workspace.name,
        email: accepted.person.email,
        person_id: accepted.person.id,
        assignments: await Promise.all(created.map(viewOf)),
      } satisfies AcceptedInvitationView
    },

    // ── 44 品牌与产品线 ──────────────────────────────────────────────
    //
    // 这两组**不走审批**：品牌加一家店是组织结构的日常，不是改职责模板（14 §1
    // 的 `policy_change` 管的是后者）。留痕靠 `range_group.*` / `product_line.*`
    // 两类事件，加上成员变动时每条受影响分配一条 `assignment.range_expanded`（44 G5）。
    rangeGroups(_actor) {
      return Promise.resolve(roles.rangeGroups.list(workspace_id).map((g) => rangeGroupView(g)))
    },

    /**
     * 45 H3 别名解析的**读**那一侧：打开一条被并进公司的品牌，看到的是公司那份。
     *
     * 回的是真源那一条（`alias_of` 记着"你点进来的是哪一条"），`readonly` 让界面
     * 把"改"换成"提议修改"。链断了或成环就停在走得到的最后一条（读路径不该打不开）。
     */
    rangeGroup(_actor, id) {
      const found = roles.rangeGroups.resolve(id)
      return Promise.resolve(found === undefined ? undefined : rangeGroupView(found, id))
    },

    createRangeGroup(actor, input) {
      const created = roles.rangeGroups.create({
        workspace_id,
        name: input.name,
        members: input.members,
        created_by: actor.person_id,
      })
      emit('range_group.created', actor.person_id, {
        range_group_id: created.id,
        name: created.name,
        members: created.members.length,
        // 45 H4：查到像的还是建了的，那句为什么进日志——下次谁查到这一对看得见
        ...(input.duplicate_ack === undefined
          ? {}
          : {
              duplicate_reason: input.duplicate_ack.reason,
              duplicate_of: input.duplicate_ack.similar_to,
            }),
      })
      return Promise.resolve(rangeGroupView(created))
    },

    updateRangeGroup(actor, id, input) {
      const before = roles.rangeGroups.get(id)
      if (before === undefined || before.workspace_id !== workspace_id)
        throw ORG_ERROR('not_found', `没有这个品牌：${id}`)
      const next = roles.rangeGroups.update(id, { name: input.name, members: input.members })
      emit('range_group.updated', actor.person_id, {
        range_group_id: id,
        name: next.name,
        members: next.members.length,
        members_before: before.members.length,
      })
      return Promise.resolve(rangeGroupView(next))
    },

    deleteRangeGroup(actor, id) {
      const found = roles.rangeGroups.get(id)
      if (found === undefined || found.workspace_id !== workspace_id)
        throw ORG_ERROR('not_found', `没有这个品牌：${id}`)
      roles.rangeGroups.delete(id)
      emit('range_group.deleted', actor.person_id, { range_group_id: id, name: found.name })
      return Promise.resolve()
    },

    productLines(_actor) {
      return Promise.resolve(roles.productLines.list(workspace_id).map((l) => productLineView(l)))
    },

    /** 45 H3 别名解析（同 {@link OrgPort.rangeGroup}，产品线那一份）。 */
    productLine(_actor, id) {
      const found = roles.productLines.resolve(id)
      return Promise.resolve(found === undefined ? undefined : productLineView(found, id))
    },

    createProductLine(actor, input) {
      const created = roles.productLines.create({
        workspace_id,
        name: input.name,
        parent: input.parent,
        rule: cleanRule(input.rule),
        created_by: actor.person_id,
      })
      emit('product_line.created', actor.person_id, {
        product_line_id: created.id,
        name: created.name,
        parent: created.parent,
        platform: created.rule.platform,
        ...(input.duplicate_ack === undefined
          ? {}
          : {
              duplicate_reason: input.duplicate_ack.reason,
              duplicate_of: input.duplicate_ack.similar_to,
            }),
      })
      return Promise.resolve(productLineView(created))
    },

    updateProductLine(actor, id, input) {
      const found = roles.productLines.get(id)
      if (found === undefined || found.workspace_id !== workspace_id)
        throw ORG_ERROR('not_found', `没有这条产品线：${id}`)
      const next = roles.productLines.update(id, {
        name: input.name,
        parent: input.parent,
        rule: cleanRule(input.rule),
      })
      emit('product_line.updated', actor.person_id, {
        product_line_id: id,
        name: next.name,
        platform: next.rule.platform,
      })
      return Promise.resolve(productLineView(next))
    },

    deleteProductLine(actor, id) {
      const found = roles.productLines.get(id)
      if (found === undefined || found.workspace_id !== workspace_id)
        throw ORG_ERROR('not_found', `没有这条产品线：${id}`)
      roles.productLines.delete(id)
      emit('product_line.deleted', actor.person_id, { product_line_id: id, name: found.name })
      return Promise.resolve()
    },

    /**
     * 45 H4「建之前先查」：查同唯一键或相似的三类组织对象。**只读，不改任何东西**。
     *
     * 公司这边的"店铺 / 平台账号范围"是**推**出来的（没有店铺表）：岗位范围、
     * 品牌成员、产品线归属里出现过的那些 id 就是它——与 Join 那条路用同一个
     * `deriveStoreRanges`，不然同一家店在两条路上会长出两把不同的钥匙。
     */
    async checkDuplicate(_actor, query) {
      await reconcile()
      const hits = findOrgSimilar(
        candidateOf(query),
        existingOrgObjects(query.kind),
        query.exclude_id === undefined ? {} : { exclude_id: query.exclude_id },
      )
      return Promise.all(
        hits.map(async (h) => ({
          ...h,
          ...(h.created_by === undefined
            ? {}
            : { created_by_name: await personName(h.created_by) }),
        })),
      )
    },

    /**
     * 45 H5 / H3：**提议修改**一条品牌 / 产品线。
     *
     * 两种人走这条路：公司里的普通成员（组织结构对他只读，44 里范围直接决定
     * 谁看得到什么，让他随手改等于让他自己给自己扩权限），以及打开了被取代的
     * 那份个人对象的本人（那一份是别名，改的是公司那条）。
     *
     * 给的 id 是别名时，卡落在**真源**那一条上——不然批下来会去改一份没人读的副本。
     */
    async proposeRangeChange(actor, input) {
      await reconcile()
      const isGroup = input.target === 'range_group'
      const target = isGroup
        ? roles.rangeGroups.resolve(input.id)
        : roles.productLines.resolve(input.id)
      if (target === undefined || target.workspace_id !== workspace_id)
        throw ORG_ERROR('not_found', `没有这一条：${input.id}`)
      const reason = input.reason.trim()
      if (reason.length < MIN_PROPOSAL_REASON)
        throw ORG_ERROR(
          'invalid_input',
          `提议修改要写一句为什么（至少 ${MIN_PROPOSAL_REASON} 个字）——owner 是照这句话点头的`,
        )
      const group = isGroup ? (target as RangeGroup) : undefined
      const line = isGroup ? undefined : (target as ProductLine)
      const change: PendingRangeChange = {
        id: target.id,
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.members === undefined || !isGroup ? {} : { members: input.members }),
        ...(input.parent === undefined || isGroup ? {} : { parent: input.parent }),
        ...(input.rule === undefined || isGroup ? {} : { rule: cleanRule(input.rule) }),
      }
      const what = isGroup ? '品牌' : '产品线'
      const alias = target.id === input.id ? '' : `（他点开的是自己那份 ${input.id}）`
      return propose(actor, {
        kind: input.target,
        doc: JSON.stringify(change),
        target: input.target,
        title: `${actor.person_id} 想改${what}「${target.name}」`,
        summary: `${reason}${alias}。批了才改；不批就维持现状。`,
        before: isGroup
          ? { name: group?.name, members: group?.members }
          : { name: line?.name, parent: line?.parent, rule: line?.rule },
        after: change,
        affected: (isGroup
          ? roles.rangeGroups.assignments(target.id)
          : roles.productLines.assignments(target.id)
        ).map((a) => a.id),
      })
    },

    async rangeOptions(_actor) {
      await reconcile()
      // 候选就是这个工作区里已经用过的那些范围；第一次分配时允许手填一个新的
      const seen = new Map<string, { kind: RangeRef['kind']; id: string; label: string }>()
      for (const person of await memberIds())
        for (const a of activeAssignments(person))
          for (const r of a.ranges) seen.set(`${r.kind}:${r.id}`, { ...r, label: r.id })
      // 44 G2：建好的产品线也是候选，而且显示的是名字不是 id
      for (const line of roles.productLines.list(workspace_id))
        seen.set(`product_line:${line.id}`, {
          kind: 'product_line',
          id: line.id,
          label: line.name,
        })
      return [...seen.values()]
    },
  }

  return {
    port,
    positions: () => backend.positions(),
    onRangeExpanded,
    close() {
      backend.close()
    },
  }
}
