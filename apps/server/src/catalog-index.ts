/**
 * 工具箱的装配（40 §2.2）：把散在各处的"被建出来的东西"投影成同一张卡片。
 *
 * `@agentsws/catalog` 只有判定，不认识调度器、技能库、流程引擎——这里才是它们见面的地方。
 * 每个来源都是一个回调，给不出的字段就不给（相似匹配会少一把钥匙，不会算错）。
 *
 * 四个来源：
 * - **定时任务** ← 调度库（`scheduler.list`）：标题、谁建的、哪个岗位在用、上次触发、触发器
 * - **流程** ← 流程引擎（`workflows.list`）：按定义聚合实例，一个定义一条
 * - **技能** ← 技能库的技能名 + 各岗位职责里声明的技能：哪些岗位在用一目了然
 * - **目录自己保管的** ← 对话里定制的卡、指导落成的规矩（它们在别处没有一张自己的表）
 *
 * 一处诚实的近似：定时任务的"最近 30 天跑了几次"用的是 `fire_count`（累计次数）。
 * 调度库没有按天的触发流水，要么在这里回放事件日志（贵），要么先用累计数（会偏大）。
 * v1 取后者，并在工具箱上写"累计"。
 */

import { join } from 'node:path'
import type {
  CatalogDuplicateView,
  CatalogEntryView,
  CatalogPort,
  CatalogSimilarHit,
} from '@agentsws/api'
// 与 `POST /v1/schedules` 算的是同一把钥匙——一处定义，两处用
import { triggerKeyOf } from '@agentsws/api'
import {
  type CatalogEntry,
  CatalogError,
  type CatalogIndex,
  createCatalog,
  type PromotionCandidate,
} from '@agentsws/catalog'
import type {
  ApprovalBus,
  ApprovalItem,
  AssignmentId,
  Clock,
  PersonId,
  WorkspaceId,
} from '@agentsws/contracts'
import type { Scheduler, ScheduleTask, WorkflowEngine } from '@agentsws/schedule'
import { HANDLERS } from './schedule.js'

/** 已经停掉的不进工具箱：工具箱是"现在有什么能用"，不是墓地。 */
const LIVE_TASK_STATES = new Set<ScheduleTask['state']>(['pending', 'active', 'running', 'paused'])

/**
 * 系统巡检（每日计划、复盘、会议轮询、幂等清理、令牌刷新……）不进工具箱。
 *
 * 工具箱回答的是"**别人**做过哪些自动化，我要不要复用"；系统自己排的那十来条
 * 既不是谁建的，也复用不了，放进去只会把真正有用的两三条淹掉——而且它们彼此
 * 长得很像（day / week / month 三条复盘），会天天在"疑似重复"里刷屏。
 *
 * 判据是 `handler` 在系统处理器名单里，不是 `created_by`：`systemTask()` 把
 * 巡检任务也记成 `created_by: 'user'`（它们要在定时任务页上被人管），改它会牵动别处。
 */
const SYSTEM_HANDLERS: ReadonlySet<string> = new Set(Object.values(HANDLERS))
const isHumanMade = (t: ScheduleTask): boolean =>
  t.handler === undefined || !SYSTEM_HANDLERS.has(t.handler)

export interface CatalogPositionView {
  id: AssignmentId
  person_id: PersonId
  role_id: string
  /** 这个岗位的职责里声明了哪些技能（05 RoleDefinition.skills） */
  skills: string[]
}

export interface CatalogIndexOptions {
  workspace_id: WorkspaceId
  clock: Clock
  /** 落盘目录；不给就是内存档（demo / 测试） */
  dbDir?: string
  /**
   * 都是**惰性**的：目录要在审批总线之前装配（它要包一层总线，好在晋升卡批准后升层），
   * 而调度器与流程引擎在总线之后才起来。取值发生在请求到来时，那时它们早就在了。
   */
  scheduler?: () => Scheduler | undefined
  workflows?: () => WorkflowEngine | undefined
  /** 工作区里现在有哪些岗位（用来算"哪些岗位在用"） */
  positions?: () => CatalogPositionView[]
  /** 技能库里现在有哪些技能名 */
  skillNames?: () => string[]
  /** 某个技能是谁的个人层 overlay（有就说明这是个人副本） */
  skillOwner?: (name: string) => { owner: PersonId; layer: 'personal' | 'dept' | 'company' }
}

/** 晋升卡的 payload：批准之后照它把条目升层、把个人副本指过去。 */
export interface CatalogPromotionPayload {
  form: 'catalog_promotion'
  entry_id: string
  kind: string
  to_layer: 'dept' | 'company'
  /** 这些个人副本从此指向升上去的那一条 */
  supersede: string[]
  positions: number
  runs_30d: number
  lower_bound: number
}

export function isCatalogPromotion(payload: unknown): payload is CatalogPromotionPayload {
  return (
    payload !== null &&
    typeof payload === 'object' &&
    (payload as { form?: unknown }).form === 'catalog_promotion'
  )
}

export interface PromotionDeps {
  approvals: ApprovalBus
  owner: PersonId
  role_id: string
}

/** 合并两条疑似重复的：留下的那条升到部门层，并掉的那条指向它。 */
export interface MergeDeps extends PromotionDeps {
  keep: string
  drop: string
  /** 谁按的那个"合并" */
  by?: PersonId
}

export interface CatalogAssembly {
  index: CatalogIndex
  port: CatalogPort
  /** 周复盘"疑似重复"段与工具箱高亮同一份 */
  duplicates(limit?: number): Promise<CatalogDuplicateView[]>
  /** 好东西往上浮：过了 Wilson 门槛的那些 */
  promotions(named_in_review?: Iterable<string>): Promise<PromotionCandidate[]>
  /**
   * 给过了门槛的候选各出一张卡：技能走 24 的 `skill_promotion`，其余走 05 的 `policy_change`。
   * **只出卡，不落层**——升不升是人在卡上按的。
   */
  proposePromotions(
    deps: PromotionDeps,
    named_in_review?: Iterable<string>,
  ): Promise<{ created: string[]; blocked: string[] }>
  /** 复盘卡上那个"合并"：出一张 `policy_change` 卡；批了才合。 */
  proposeMerge(deps: MergeDeps): Promise<{ approval_item_id: string } | undefined>
  /** 包一层审批总线：晋升卡批准了才真的升层。 */
  wrap(bus: ApprovalBus): ApprovalBus
  close(): void
}

function scheduleEntry(task: ScheduleTask, workspace_id: WorkspaceId): CatalogEntry {
  const trigger = triggerKeyOf(task.trigger)
  return {
    kind: 'schedule',
    id: `schedule:${task.id}`,
    title: task.title ?? task.handler ?? task.id,
    summary: task.handler === undefined ? '一条只提醒的定时' : `到点交给「${task.handler}」做一次`,
    owner: task.owner,
    layer: 'personal',
    used_by_positions: [task.assignment_id],
    ...(task.last_fire_at === undefined ? {} : { last_run_at: task.last_fire_at }),
    runs_30d: task.fire_count,
    ...(task.origin?.conversation_id === undefined
      ? {}
      : { created_from: { conversation_id: task.origin.conversation_id } }),
    ...(trigger === undefined ? {} : { trigger }),
    workspace_id,
    ...(task.created_at === undefined ? {} : { created_at: task.created_at }),
  }
}

export function createCatalogIndex(options: CatalogIndexOptions): CatalogAssembly {
  const { workspace_id, clock } = options
  const index = createCatalog({
    clock,
    ...(options.dbDir === undefined ? {} : { dbPath: join(options.dbDir, 'catalog.sqlite') }),
  })

  const schedulerOf = options.scheduler
  if (schedulerOf !== undefined) {
    index.register({
      kind: 'schedule',
      list: ({ workspace_id: ws }) =>
        (schedulerOf()?.list({ workspace_id: ws }) ?? [])
          .filter((t) => LIVE_TASK_STATES.has(t.state) && isHumanMade(t))
          .map((t) => scheduleEntry(t, ws)),
    })
  }

  const workflowsOf = options.workflows
  if (workflowsOf !== undefined) {
    index.register({
      kind: 'workflow',
      list: ({ workspace_id: ws }) => {
        const workflows = workflowsOf()
        if (workflows === undefined) return []
        // 一个流程定义一条：实例是"跑了几次"，不是"建了几个东西"
        const byDef = new Map<string, CatalogEntry>()
        for (const instance of workflows.list({ workspace_id: ws })) {
          const id = `workflow:${instance.def.id}`
          const found = byDef.get(id)
          if (found === undefined) {
            byDef.set(id, {
              kind: 'workflow',
              id,
              title: instance.definition.name,
              summary: `${instance.definition.steps.length} 步的流程（${instance.def.version}）`,
              // 流程定义来自包，没有"谁建的"；挂在职责上
              owner: instance.role_id as PersonId,
              layer: 'company',
              used_by_positions: [],
              runs_30d: 1,
              trigger: `workflow:${instance.def.id}`,
              target: `${instance.subject.type}:${instance.subject.id}`,
              workspace_id: ws,
              created_at: instance.started_at,
            })
            continue
          }
          found.runs_30d += 1
          if (found.last_run_at === undefined || found.last_run_at < instance.updated_at)
            found.last_run_at = instance.updated_at
        }
        return [...byDef.values()]
      },
    })
  }

  const skillNames = options.skillNames
  if (skillNames !== undefined) {
    index.register({
      kind: 'skill',
      list: ({ workspace_id: ws }) => {
        const positions = options.positions?.() ?? []
        return [...new Set(skillNames())].sort().map((name) => {
          const who = options.skillOwner?.(name)
          return {
            kind: 'skill' as const,
            id: `skill:${name}`,
            title: name,
            summary: who?.layer === 'personal' ? '个人改过的技能副本' : '公司在用的技能',
            owner: who?.owner ?? ('package' as PersonId),
            layer: who?.layer ?? 'company',
            used_by_positions: positions.filter((p) => p.skills.includes(name)).map((p) => p.id),
            runs_30d: 0,
            target: `skill:${name}`,
            workspace_id: ws,
          }
        })
      },
    })
  }

  const view = (e: CatalogEntry): CatalogEntryView => e as CatalogEntryView

  const port: CatalogPort = {
    list: async (query) =>
      (
        await index.list({
          workspace_id: query.workspace_id,
          ...(query.kind === undefined ? {} : { kind: query.kind }),
          ...(query.layer === undefined ? {} : { layer: query.layer }),
          ...(query.position_id === undefined ? {} : { position_id: query.position_id }),
          ...(query.owner === undefined ? {} : { owner: query.owner }),
          ...(query.text === undefined ? {} : { text: query.text }),
        })
      ).map(view),
    similar: async (query): Promise<CatalogSimilarHit[]> =>
      (await index.similar(query)).map((h) => ({
        entry: view(h.entry),
        similarity: h.similarity,
        keys: [...h.keys],
        reasons: [...h.reasons],
      })),
    duplicates: async (query): Promise<CatalogDuplicateView[]> =>
      (
        await index.duplicates(query.workspace_id, {
          ...(query.limit === undefined ? {} : { limit: query.limit }),
        })
      ).map((d) => ({
        a: view(d.a),
        b: view(d.b),
        similarity: d.similarity,
        both_in_use: d.both_in_use,
        reasons: [...d.reasons],
      })),
    noteDuplicate: (input) => {
      try {
        index.noteDuplicate({
          workspace_id: input.workspace_id,
          entry_id: input.entry_id,
          similar_to: input.similar_to,
          reason: input.reason,
        })
      } catch (err) {
        // 目录只会因为"理由太短"拒绝；网关那一层已经先判过一次，到这里还错就照原样翻上去
        if (err instanceof CatalogError) throw err
        throw err
      }
    },
    noteReuse: (input) => {
      index.noteReuse({
        workspace_id: input.workspace_id,
        entry_id: input.entry_id,
        reused: input.reused,
      })
    },
  }

  /** 晋升卡批了 → 条目升层，个人副本指向升上去的那一条（40 §2.2 第 3 条）。 */
  const applyDecided = (item: ApprovalItem): void => {
    const payload = item.payload
    if (!isCatalogPromotion(payload)) return
    if (item.state !== 'approved' && item.state !== 'approved_edited') return
    index.promote({
      workspace_id,
      entry_id: payload.entry_id,
      to_layer: payload.to_layer,
      supersede: payload.supersede,
    })
  }

  return {
    index,
    port,
    duplicates: async (limit) =>
      port.duplicates({ workspace_id, ...(limit === undefined ? {} : { limit }) }),
    promotions: async (named_in_review) =>
      (
        await index.promotionCandidates({
          workspace_id,
          ...(named_in_review === undefined ? {} : { named_in_review }),
        })
      ).filter((c) => c.passed),
    async proposePromotions(deps, named_in_review) {
      const created: string[] = []
      const blocked: string[] = []
      const candidates = await index.promotionCandidates({
        workspace_id,
        ...(named_in_review === undefined ? {} : { named_in_review }),
      })
      for (const c of candidates) {
        if (!c.passed) continue
        const to_layer: 'dept' | 'company' = c.to_layer === 'company' ? 'company' : 'dept'
        const payload: CatalogPromotionPayload = {
          form: 'catalog_promotion',
          entry_id: c.entry.id,
          kind: c.entry.kind,
          to_layer,
          supersede: [],
          positions: c.positions,
          runs_30d: c.entry.runs_30d,
          lower_bound: c.lower_bound,
        }
        const item = (await deps.approvals.create({
          workspace_id,
          schema_version: 1,
          kind: c.card_kind,
          role_id: deps.role_id,
          proposer: { kind: 'system', id: 'catalog' },
          // 晋升本身不改任何东西，改不改由人按一次
          automation: { level_at_creation: 'L1' },
          routing: {
            recipients: [{ person: deps.owner, via: 'owner' }],
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
          subject: { object: { type: 'policy', id: c.entry.id } },
          dedupe_key: `${workspace_id}:catalog_promotion:${c.entry.id}:${to_layer}`,
          title: c.title,
          summary: c.summary,
          payload,
          evidence: {
            source_events: [],
            diff: {
              before: { layer: c.entry.layer },
              after: { layer: to_layer },
              summary: `${c.entry.title}：${c.entry.layer} → ${to_layer}`,
            },
            provenance: { seen: [] },
            precheck: { permission_diff: 'ok', semantic_diff: 'ok' },
          },
        })) as ApprovalItem
        if (item.state === 'blocked') blocked.push(c.entry.id)
        else created.push(item.id)
      }
      return { created, blocked }
    },

    async proposeMerge(deps) {
      const all = await index.entries(workspace_id)
      const keep = all.find((e) => e.id === deps.keep)
      const drop = all.find((e) => e.id === deps.drop)
      if (keep === undefined || drop === undefined) return undefined
      const to_layer: 'dept' | 'company' = keep.layer === 'company' ? 'company' : 'dept'
      const payload: CatalogPromotionPayload = {
        form: 'catalog_promotion',
        entry_id: keep.id,
        kind: keep.kind,
        to_layer,
        supersede: [drop.id],
        positions: keep.used_by_positions.length,
        runs_30d: keep.runs_30d,
        lower_bound: 1,
      }
      const item = (await deps.approvals.create({
        workspace_id,
        schema_version: 1,
        kind: 'policy_change',
        role_id: deps.role_id,
        proposer: { kind: 'person', id: deps.by ?? deps.owner },
        automation: { level_at_creation: 'L1' },
        routing: {
          recipients: [{ person: deps.owner, via: 'owner' }],
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
        subject: { object: { type: 'policy', id: keep.id } },
        dedupe_key: `${workspace_id}:catalog_merge:${keep.id}:${drop.id}`,
        title: `合成一份：「${drop.title}」并进「${keep.title}」`,
        summary: `两条做的是同一件事，而且都还在用。合并之后大家用同一份，${drop.owner} 那条自动指向它。`,
        payload,
        evidence: {
          source_events: [],
          diff: {
            before: { keep: keep.id, drop: drop.id },
            after: { keep: keep.id, superseded: [drop.id] },
            summary: `${drop.title} → ${keep.title}`,
          },
          provenance: { seen: [] },
          precheck: { permission_diff: 'ok', semantic_diff: 'ok' },
        },
      })) as ApprovalItem
      return item.state === 'blocked' ? undefined : { approval_item_id: item.id }
    },

    wrap(bus) {
      // 用 Proxy 而不是展开：总线是个类实例，方法在原型上（照 learning.wrap 的做法）
      return new Proxy(bus, {
        get(target, prop, receiver) {
          if (prop !== 'decide') {
            const value = Reflect.get(target, prop, receiver)
            return typeof value === 'function' ? value.bind(target) : value
          }
          return async (id: string, by: PersonId, input: unknown): Promise<ApprovalItem> => {
            const out = await (
              target.decide as (i: string, b: PersonId, x: unknown) => Promise<ApprovalItem>
            )(id, by, input)
            applyDecided(out)
            return out
          }
        },
      })
    },

    close: () => {
      index.close()
    },
  }
}
