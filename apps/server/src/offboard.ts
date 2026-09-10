/**
 * 「离职」的**统一编排**（40 §1.2 第三条规则、§5 E1–E2；05 §3 `handover`；21 §4 擦除）。
 *
 * 在这之前，一个人走了要做的事散在四个地方：`removeMember` 撤分配、`revokeAssignment`
 * 把 `handover_to` 透传给一条已撤销的记录、`POST /v1/privacy/erase` 删主体、
 * 个人层 overlay 谁也没管。于是"人走了"这件事的正确性取决于 owner 记不记得四处都做——
 * 而**在办的事项与未完的待办从来没有真的转过去**，它们还挂在一个已经没有 token 的人名下。
 *
 * 这个模块把这四件事变成一个动作，六条纪律：
 *
 * 1. **公司库是唯一真源**（40 E1）。离职走的是权限与个人化，不是数据：事项、待办、
 *    知识、账本一条都不删，只换主人。
 * 2. **交接必须真转**（40 E2）。`handover_to` 不再只是撤销记录上的一个字段，
 *    在办事项的参与者、未完待办的 owner、他建的定时任务真的换成接手人，
 *    事项时间线上留一行看得见的痕。
 * 3. **个人层默认归档不删**（40 E2）。他攒在技能上的改动搬进只读的"前员工层"，
 *    接手人可以一键采纳进部门层——那一步走 `policy_change` 审批（14 §13.3 只有 owner 可决）。
 * 4. **管理员对个人数据没有"读"**（40 E1）。这里每一步只回**条数**，一个字的正文都不返回；
 *    owner 能做的只有迁移 / 归档 / 销毁三件事，没有第四条路。
 * 5. **每一步幂等、整体可重跑**。撤销幂等、交接幂等（转完他就不再是主人）、归档幂等、
 *    迁移幂等。任一步失败整体记 `partial`，同一个请求再发一次就是补做没成的那几步——
 *    不需要跨库事务，也不该需要：各库不共享表（35 §2）。
 * 6. **等审批的那两步在下一次读时落地**。与 `org.ts` 的 `reconcile()` 同一个做法：
 *    不往审批总线里插钩子，就不会与调度器、执行器抢同一个口子。
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type {
  ApprovalBus,
  ApprovalItem,
  Assignment,
  Clock,
  EventEnvelope,
  Iso8601,
  ObjectRef,
  PersonId,
  RoleId,
  WorkspaceId,
} from '@agentsws/contracts'
import type { SqliteMemoryStore } from '@agentsws/knowledge'
import type { LearningPool } from '@agentsws/learning'
import type { RoleStore } from '@agentsws/roles'
import type { ScheduleStore } from '@agentsws/schedule'
import type { ArchivedOverlay, MemorySkillRegistry } from '@agentsws/skills'
import type { Work } from '@agentsws/work'
import type BetterSqlite3 from 'better-sqlite3'

/** 个人层 overlay 怎么处置：归档成"前员工层"只读（默认），或整个销毁。 */
export type PersonalLayerPolicy = 'archive' | 'erase'
/** 个人记忆怎么处置：工作相关的迁给接手人（经审批），其余按 21 擦除；或全擦。 */
export type MemoryPolicy = 'migrate_work' | 'erase'

export interface OffboardInput {
  person_id: PersonId
  /** 接手人（05 §3）。不给就按他每条职责的 `handover.fallback` 兜底算出来。 */
  handover_to?: PersonId | undefined
  personal_layer?: PersonalLayerPolicy | undefined
  memory?: MemoryPolicy | undefined
}

export type OffboardStepId = 'revoke' | 'handover' | 'skills' | 'memory' | 'lessons' | 'report'

export interface OffboardStep {
  step: OffboardStepId
  /** `pending_approval` = 这一步的动作已经变成一张卡，批了才落地（下一次跑这条路由时落）。 */
  status: 'done' | 'skipped' | 'failed' | 'pending_approval'
  /** 这一步的口径：转了几件、归档了几条、擦了几条。**只有数字，没有内容**。 */
  counts?: Record<string, number>
  approval_item_id?: string
  /** 失败原因（人话；不含任何个人数据）。 */
  error?: string
}

/** 40 §1.2 最后一步的那张「离职报告」。 */
export interface OffboardReport {
  person_id: PersonId
  person_name: string
  /** 真正接手的人（可能是兜底算出来的 owner）。 */
  handover_to: PersonId
  handover_to_name: string
  /** true = 调用方没给接手人，是按 `Role.handover.fallback` 兜底找的。 */
  fallback_used: boolean
  personal_layer: PersonalLayerPolicy
  memory: MemoryPolicy
  /** 全成 `done`；有等审批的 `pending_approval`；任一步失败 `partial`（可重跑）。 */
  status: 'done' | 'partial' | 'pending_approval'
  at: Iso8601
  steps: OffboardStep[]
  /** 一句人话的总结，界面上直接显示。 */
  summary: string
  /** 还需人工的（谁也替不了的那几件）。 */
  manual: string[]
  /** 报告落在哪个事项上（接手人的待办入口）。 */
  matter_id?: string
}

/** 归档区里的一条在界面上的样子（**只有段数，没有正文**——40 E1）。 */
export interface ArchivedSkillView {
  skill: string
  owner: PersonId
  owner_name: string
  sections: number
  base_version: string
  archived_at: Iso8601
  reason?: string
}

export interface AdoptInput {
  skill: string
  /** 前员工 */
  owner: PersonId
  to_tier: 'company' | 'department'
  /** 部门层要落在哪个部门；不给就落在工作区上。 */
  scope_id?: string | undefined
}

export interface AdoptReceipt {
  status: 'pending_approval'
  approval_item_id: string
  summary: string
}

/** 一条等审批的离职动作。 */
interface PendingOffboard {
  id: string
  approval_id: string
  kind: 'memory_migrate' | 'skill_adopt'
  doc: string
  status: 'pending' | 'applied' | 'dropped'
}

interface OffboardBackend {
  pending(): PendingOffboard[]
  put(row: PendingOffboard): void
  close(): void
}

function createMemoryBackend(): OffboardBackend {
  const rows = new Map<string, PendingOffboard>()
  return {
    pending: () => [...rows.values()].map((r) => ({ ...r })),
    put: (row) => {
      rows.set(row.id, { ...row })
    },
    close: () => {
      rows.clear()
    },
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS offboard_pending (
  id TEXT PRIMARY KEY,
  approval_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  doc TEXT NOT NULL,
  status TEXT NOT NULL
);
`

function createSqliteBackend(dbPath: string): OffboardBackend {
  const require = createRequire(import.meta.url)
  const Database = require('better-sqlite3') as typeof BetterSqlite3
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA)
  const put = db.prepare(
    `INSERT INTO offboard_pending (id, approval_id, kind, doc, status)
     VALUES (@id,@approval_id,@kind,@doc,@status)
     ON CONFLICT(id) DO UPDATE SET status = excluded.status, doc = excluded.doc`,
  )
  return {
    pending: () =>
      db.prepare('SELECT * FROM offboard_pending ORDER BY id').all() as PendingOffboard[],
    put: (row) => {
      put.run(row)
    },
    close: () => {
      db.close()
    },
  }
}

export interface OffboardOptions {
  workspace_id: WorkspaceId
  clock: Clock
  appendEvent(e: Omit<EventEnvelope, 'id' | 'at'> & { at?: string }): void
  identity: {
    getPerson(id: PersonId): Promise<{ id: PersonId; name: string; email: string } | undefined>
    getWorkspace(id: WorkspaceId): Promise<{ id: WorkspaceId; owner_id: PersonId } | undefined>
    leaveWorkspace(workspace_id: WorkspaceId, person_id: PersonId): Promise<unknown>
  }
  roles: RoleStore
  approvals: ApprovalBus
  work: Work
  skills: MemorySkillRegistry
  lessons: LearningPool
  /** 个人记忆（19 §1.2 的 MemoryStore）。不给就跳过记忆那一步。 */
  memory?: SqliteMemoryStore
  /** 定时任务与流程实例（25）。不给就跳过那一小步。 */
  schedule?: ScheduleStore
  /** 给了就落盘（`offboard.sqlite`）；不给就纯内存。 */
  dbDir?: string
}

export interface Offboard {
  /** 把已经有结论的卡落地（与 org.ts 同一个做法：下一次读时落）。 */
  reconcile(): Promise<void>
  offboard(input: OffboardInput, actor: PersonId): Promise<OffboardReport>
  /** 归档区（**只有段数，没有正文**）。 */
  archivedSkills(owner?: PersonId): Promise<ArchivedSkillView[]>
  /** 接手人一键"采纳进部门层"：建一张 `policy_change` 卡，批了才落。 */
  adopt(input: AdoptInput, actor: { person_id: PersonId; role_id: RoleId }): Promise<AdoptReceipt>
  close(): void
}

const APPROVED = new Set(['approved', 'approved_edited', 'auto_approved', 'applying', 'applied'])
const DEAD = new Set(['rejected', 'withdrawn', 'expired', 'superseded', 'blocked'])

/**
 * 决定里选的是「维持现状」（deck 给 `policy_change` 生成的第二个选项）。
 * 与 `org.ts` 同一条判断：卡的状态同样是 `approved_edited`，得看他选的是哪一个。
 */
function keptAsIs(item: ApprovalItem): boolean {
  const edited = item.decision?.edited_payload
  if (edited === null || typeof edited !== 'object') return false
  return (edited as { selected_option_id?: unknown }).selected_option_id === 'before'
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** 个人记忆挂在哪个主体上。 */
export const personSubject = (id: PersonId): ObjectRef => ({ type: 'person', id })

export function createOffboard(options: OffboardOptions): Offboard {
  const { workspace_id, clock, roles, work, skills, approvals } = options
  const backend =
    options.dbDir === undefined
      ? createMemoryBackend()
      : createSqliteBackend(join(options.dbDir, 'offboard.sqlite'))

  const nameOf = async (id: PersonId): Promise<string> =>
    (await options.identity.getPerson(id))?.name ?? id

  const activeOf = (person: PersonId): Assignment[] =>
    roles.assignments
      .listByPerson(person, { workspace_id })
      .filter((a) => a.revoked_at === undefined)

  const emit = (type: string, actor: PersonId, payload: Record<string, unknown>): void => {
    options.appendEvent({
      schema_version: 1,
      workspace_id,
      type,
      actor: { kind: 'person', id: actor },
      correlation: { trace_id: `tr_offboard_${clock.now()}` },
      payload,
    })
  }

  // ── 等审批的那两步 ─────────────────────────────────────────────────

  const applyPending = (row: PendingOffboard): Record<string, number> => {
    if (row.kind === 'memory_migrate') {
      const doc = JSON.parse(row.doc) as { from: PersonId; to: PersonId }
      const moved =
        options.memory?.migrateSubject(personSubject(doc.from), personSubject(doc.to), {
          workspace_id,
        }) ?? 0
      return { migrated: moved }
    }
    const doc = JSON.parse(row.doc) as {
      skill: string
      owner: PersonId
      to_tier: 'company' | 'department'
      scope_id?: string
      base_version: string
    }
    const archived = skills.getArchivedOverlay(doc.skill, doc.owner)
    if (archived === undefined) return { adopted: 0 }
    const target = doc.to_tier === 'company' ? workspace_id : (doc.scope_id ?? workspace_id)
    const existing = skills.getOverlay(doc.skill, doc.to_tier, target)
    void skills.setOverlay({
      skill: doc.skill,
      tier: doc.to_tier,
      owner: target,
      ops: [...(existing?.ops ?? []), ...archived.ops.map((op) => ({ ...op }))],
      base_version: archived.base_version,
      version: existing?.version ?? 0,
    })
    return { adopted: archived.ops.length }
  }

  const reconcile = async (): Promise<void> => {
    for (const row of backend.pending()) {
      if (row.status !== 'pending') continue
      const item = await approvals.get(row.approval_id)
      if (item === undefined) continue
      if (APPROVED.has(item.state)) {
        if (keptAsIs(item)) {
          backend.put({ ...row, status: 'dropped' })
          continue
        }
        const counts = applyPending(row)
        backend.put({ ...row, status: 'applied' })
        emit('member.offboard_applied', 'system', { kind: row.kind, ...counts })
      } else if (DEAD.has(item.state)) {
        backend.put({ ...row, status: 'dropped' })
      }
    }
  }

  const propose = async (input: {
    id: string
    kind: PendingOffboard['kind']
    doc: string
    role_id: RoleId
    proposer: PersonId
    title: string
    summary: string
    payload: Record<string, unknown>
  }): Promise<ApprovalItem> => {
    const workspace = await options.identity.getWorkspace(workspace_id)
    const owner = workspace?.owner_id ?? input.proposer
    const item = (await approvals.create({
      workspace_id,
      schema_version: 1,
      kind: 'policy_change',
      role_id: input.role_id,
      subject: { object: { type: 'policy', id: input.id } },
      dedupe_key: `${workspace_id}:offboard:${input.id}`,
      title: input.title,
      summary: input.summary,
      payload: { target: 'offboard', ...input.payload },
      evidence: {
        source_events: [],
        diff: { before: null, after: input.payload, summary: input.summary },
        provenance: { seen: [] },
        precheck: { permission_diff: 'ok', semantic_diff: 'ok' },
      },
      proposer: { kind: 'person', id: input.proposer },
      automation: {
        level_at_creation: 'L1',
        auto_approved: false,
        mandate_check: { within: true, caps_hit: [] },
        sampling: { selected: false },
      },
      routing: {
        // 14 §13.3：动别人的个人数据、动公司技能层，只有 owner 可决
        recipients: [{ person: owner, via: 'owner' }],
        rule: 'owner',
        escalation: { after_hours: 48, business_hours: true, chain: ['owner'], escalated_at: [] },
        separation_of_duties: false,
      },
      priority: 'queue',
    })) as ApprovalItem
    backend.put({
      id: input.id,
      approval_id: item.id,
      kind: input.kind,
      doc: input.doc,
      status: 'pending',
    })
    return item
  }

  // ── 接手人是谁 ─────────────────────────────────────────────────────

  /**
   * 05 §3：没有指定接手人时，按他每条职责的 `handover.fallback` 兜底。
   * v1 单工作区里 `scope_manager` 与 `owner` 都落到 owner 身上（14 §7 升级链同一条道理）。
   */
  const fallbackSuccessor = async (person: PersonId): Promise<PersonId> => {
    const workspace = await options.identity.getWorkspace(workspace_id)
    return workspace?.owner_id ?? person
  }

  // ── 报告 ───────────────────────────────────────────────────────────

  const reportText = (report: Omit<OffboardReport, 'summary' | 'matter_id'>): string => {
    const n = (id: OffboardStepId, key: string): number =>
      report.steps.find((s) => s.step === id)?.counts?.[key] ?? 0
    return [
      `${report.person_name} 的权限已全部撤销（${n('revoke', 'assignments')} 条分配，token 立刻失效）`,
      `在办的 ${n('handover', 'matters')} 件事、${n('handover', 'todos')} 条未完待办、${n('handover', 'scheduled_tasks')} 个定时任务转给了 ${report.handover_to_name}`,
      report.personal_layer === 'archive'
        ? `技能个人层归档了 ${n('skills', 'archived')} 条（只读，接手人可采纳进部门层）`
        : `技能个人层销毁了 ${n('skills', 'erased')} 条`,
      report.memory === 'migrate_work'
        ? `个人记忆：${n('memory', 'to_migrate')} 条工作相关的等你批准后迁走，${n('memory', 'erased')} 条已擦除`
        : `个人记忆：${n('memory', 'erased')} 条已全部擦除`,
    ].join('；')
  }

  // ── 端口 ───────────────────────────────────────────────────────────

  return {
    reconcile,

    async archivedSkills(owner) {
      const list = skills.listArchivedOverlays(owner === undefined ? {} : { owner })
      const out: ArchivedSkillView[] = []
      for (const a of list) {
        out.push({
          skill: a.skill,
          owner: a.owner,
          owner_name: await nameOf(a.owner),
          sections: a.ops.length,
          base_version: a.base_version,
          archived_at: a.archived_at,
          ...(a.reason === undefined ? {} : { reason: a.reason }),
        })
      }
      return out
    },

    async adopt(input, actor) {
      await reconcile()
      const archived: ArchivedOverlay | undefined = skills.getArchivedOverlay(
        input.skill,
        input.owner,
      )
      if (archived === undefined)
        throw new Error(`归档区里没有「${input.skill}」（${input.owner}）这一条`)
      const id = `adopt_${input.skill}_${input.owner}_${input.to_tier}`
      const tierName = input.to_tier === 'company' ? '公司层' : '部门层'
      const item = await propose({
        id,
        kind: 'skill_adopt',
        doc: JSON.stringify({
          skill: input.skill,
          owner: input.owner,
          to_tier: input.to_tier,
          ...(input.scope_id === undefined ? {} : { scope_id: input.scope_id }),
          base_version: archived.base_version,
        }),
        role_id: actor.role_id,
        proposer: actor.person_id,
        title: `把前员工留下的「${input.skill}」${archived.ops.length} 段采纳进${tierName}`,
        summary: `${await nameOf(input.owner)} 走的时候在这个技能上留下 ${archived.ops.length} 段改动。批准后它们进${tierName}，全公司都用得上（24 §2）。`,
        payload: {
          skill: input.skill,
          from_owner: input.owner,
          to_tier: input.to_tier,
          sections: archived.ops.length,
        },
      })
      return {
        status: 'pending_approval',
        approval_item_id: item.id,
        summary: `已提交审批：${archived.ops.length} 段进${tierName}`,
      }
    },

    async offboard(input, actor) {
      await reconcile()
      const at = clock.now()
      const personal_layer = input.personal_layer ?? 'archive'
      const memory = input.memory ?? 'migrate_work'
      const workspace = await options.identity.getWorkspace(workspace_id)
      if (workspace?.owner_id === input.person_id)
        throw new Error('工作区所有者不能离职（先把所有者换给别人）')

      const fallback_used = input.handover_to === undefined
      const handover_to = input.handover_to ?? (await fallbackSuccessor(input.person_id))
      if (handover_to === input.person_id) throw new Error('接手人不能是他自己')

      const steps: OffboardStep[] = []
      const manual: string[] = []
      const person_name = await nameOf(input.person_id)
      const handover_to_name = await nameOf(handover_to)

      // ① 撤销全部分配 + 移出工作区（token 立即失效，20 §4）
      const active = activeOf(input.person_id)
      const revokedRoles = new Set<RoleId>(active.map((a) => a.role_id))
      const revokedAssignments = new Set<string>(active.map((a) => a.id))
      try {
        for (const a of active) roles.assignments.revoke(a.id, { handover_to })
        await options.identity.leaveWorkspace(workspace_id, input.person_id)
        steps.push({ step: 'revoke', status: 'done', counts: { assignments: active.length } })
      } catch (e) {
        steps.push({ step: 'revoke', status: 'failed', error: messageOf(e) })
      }

      // ② 真转：在办事项 / 未完待办 / 他建的定时任务与流程实例
      try {
        const moved = work.handover({
          from: input.person_id,
          to: handover_to,
          by: actor,
          reason: `${person_name}离职`,
        })
        let scheduled = 0
        const store = options.schedule
        if (store !== undefined) {
          const successor = activeOf(handover_to)[0]
          for (const task of store.listTasks({ workspace_id, owner: input.person_id })) {
            if (task.state === 'done' || task.state === 'cancelled') continue
            store.putTask({
              ...task,
              owner: handover_to,
              ...(successor === undefined
                ? {}
                : { role_id: successor.role_id, assignment_id: successor.id }),
              updated_at: at,
            })
            scheduled += 1
          }
          // 25 的流程实例挂的是职责不是人（`WorkflowInstanceRecord` 没有 owner），
          // 所以这里不猜：还在跑 / 还在等的，如实报出来让人看一眼
          const running = store
            .listInstances({ workspace_id, state: ['running', 'waiting'] })
            .filter((i) => revokedRoles.has(i.role_id))
          if (running.length > 0)
            manual.push(
              `${running.length} 个还在跑的流程实例挂在他做过的职责上，确认一下要不要继续（25 §4）`,
            )
        }
        for (const id of moved.matters)
          emit('matter.handover', actor, {
            matter_id: id,
            from: input.person_id,
            to: handover_to,
            reason: 'offboard',
          })
        steps.push({
          step: 'handover',
          status: 'done',
          counts: {
            matters: moved.matters.length,
            todos: moved.todos.length,
            scheduled_tasks: scheduled,
          },
        })
      } catch (e) {
        steps.push({ step: 'handover', status: 'failed', error: messageOf(e) })
      }

      // ③ 个人层技能 overlay：归档成"前员工层"只读，或整个销毁
      try {
        const archived = skills.archivePersonalOverlays(input.person_id, at, {
          reason: `${person_name}离职`,
        })
        if (personal_layer === 'erase') {
          const dropped = skills.dropArchivedOverlays(input.person_id)
          steps.push({ step: 'skills', status: 'done', counts: { erased: dropped } })
        } else {
          steps.push({ step: 'skills', status: 'done', counts: { archived: archived.length } })
          if (archived.length > 0)
            manual.push(
              `${archived.length} 条技能改动归档成了前员工层（只读）。要用就在成员页点「采纳进部门层」，走一次审批`,
            )
        }
      } catch (e) {
        steps.push({ step: 'skills', status: 'failed', error: messageOf(e) })
      }

      // ④ 个人记忆：工作相关的迁给接手人（经审批），其余按 21 擦除；或全擦
      const mem = options.memory
      if (mem === undefined) {
        steps.push({ step: 'memory', status: 'skipped' })
      } else {
        try {
          const subject = personSubject(input.person_id)
          if (memory === 'erase') {
            const erased = mem.eraseSubject(subject, { scope: 'all' })
            steps.push({ step: 'memory', status: 'done', counts: { erased } })
          } else {
            const counts = mem.countSubject(subject, { workspace_id })
            // 其余（不带本工作区域引用的）当场擦掉——那是他自己的，不该留在公司库里
            const purged = mem.eraseSubject(subject, { workspace_id, scope: 'other' })
            if (counts.work === 0) {
              steps.push({
                step: 'memory',
                status: 'done',
                counts: { to_migrate: 0, erased: purged },
              })
            } else {
              const item = await propose({
                id: `memory_${input.person_id}`,
                kind: 'memory_migrate',
                doc: JSON.stringify({ from: input.person_id, to: handover_to }),
                role_id: active[0]?.role_id ?? 'common.member',
                proposer: actor,
                title: `把 ${person_name} 的 ${counts.work} 条工作记忆迁给 ${handover_to_name}`,
                summary:
                  '这些是带本工作区域引用的运行记忆（客户偏好、约定过的口径）。批准后迁给接手人；不批就随他一起擦掉（40 §1.2）。',
                payload: { from: input.person_id, to: handover_to, facts: counts.work },
              })
              steps.push({
                step: 'memory',
                status: 'pending_approval',
                counts: { to_migrate: counts.work, erased: purged },
                approval_item_id: item.id,
              })
              manual.push(`${counts.work} 条工作记忆等你批准后才迁给 ${handover_to_name}`)
            }
          }
        } catch (e) {
          steps.push({ step: 'memory', status: 'failed', error: messageOf(e) })
        }
      }

      // ⑤ 教训池里他还没被采纳的那些：归档（不再提）或销毁
      try {
        const n =
          personal_layer === 'erase'
            ? options.lessons.eraseContributor({
                workspace_id,
                assignment_ids: [...revokedAssignments],
                at,
              })
            : options.lessons.archiveContributor({
                workspace_id,
                assignment_ids: [...revokedAssignments],
                at,
              })
        steps.push({
          step: 'lessons',
          status: 'done',
          counts: personal_layer === 'erase' ? { erased: n } : { archived: n },
        })
      } catch (e) {
        steps.push({ step: 'lessons', status: 'failed', error: messageOf(e) })
      }

      const failed = steps.some((s) => s.status === 'failed')
      const pending = steps.some((s) => s.status === 'pending_approval')
      const status: OffboardReport['status'] = failed
        ? 'partial'
        : pending
          ? 'pending_approval'
          : 'done'
      if (failed) manual.push('有步骤没做成，把同一个请求再发一次就是补做没成的那几步')

      const base = {
        person_id: input.person_id,
        person_name,
        handover_to,
        handover_to_name,
        fallback_used,
        personal_layer,
        memory,
        status,
        at,
        steps,
        manual,
      }
      const summary = reportText(base)

      // ⑥ 报告落到接手人名下的一个事项上（"还需人工的"得有个能接着办的地方），
      //    再记一条 `member.offboarded`（payload 只有数字与处置方式，没有任何正文）
      let matter_id: string | undefined
      try {
        const matter = work.createMatter({
          kind: 'adhoc',
          title: `离职交接：${person_name} → ${handover_to_name}`,
          summary,
          participants: [handover_to],
        })
        work.appendEvent(matter.id, {
          kind: 'note',
          text: manual.length === 0 ? '没有需要人工处理的' : `还需人工：${manual.join('；')}`,
          actor: { kind: 'system', id: 'offboard' },
        })
        matter_id = matter.id
      } catch (e) {
        manual.push(`报告事项没建起来：${messageOf(e)}`)
      }

      emit('member.offboarded', actor, {
        person_id: input.person_id,
        handover_to,
        fallback_used,
        personal_layer,
        memory,
        status,
        steps: steps.map((s) => ({
          step: s.step,
          status: s.status,
          ...(s.counts === undefined ? {} : { counts: s.counts }),
        })),
      })

      return { ...base, summary, ...(matter_id === undefined ? {} : { matter_id }) }
    },

    close() {
      backend.close()
    },
  }
}
