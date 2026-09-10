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
import {
  type CatalogEntry,
  CatalogError,
  type CatalogIndex,
  createCatalog,
  type PromotionCandidate,
} from '@agentsws/catalog'
import type { AssignmentId, Clock, PersonId, WorkspaceId } from '@agentsws/contracts'
import type { Scheduler, ScheduleTask, WorkflowEngine } from '@agentsws/schedule'

/** 触发器 → 那把"同触发器"的钥匙。写法规整成一行，两条一样的定时任务才认得出来。 */
export function triggerKeyOf(trigger: ScheduleTask['trigger'] | undefined): string | undefined {
  if (trigger === undefined) return undefined
  switch (trigger.kind) {
    case 'cron':
      return `cron:${trigger.expr}@${trigger.tz}`
    case 'interval':
      return `interval:${trigger.every_ms}`
    case 'once':
      return `once:${trigger.at}`
    case 'after_event':
      return `event:${trigger.event}`
    default:
      return undefined
  }
}

/** 已经停掉的不进工具箱：工具箱是"现在有什么能用"，不是墓地。 */
const LIVE_TASK_STATES = new Set<ScheduleTask['state']>(['pending', 'active', 'running', 'paused'])

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
  scheduler?: Scheduler
  workflows?: WorkflowEngine
  /** 工作区里现在有哪些岗位（用来算"哪些岗位在用"） */
  positions?: () => CatalogPositionView[]
  /** 技能库里现在有哪些技能名 */
  skillNames?: () => string[]
  /** 某个技能是谁的个人层 overlay（有就说明这是个人副本） */
  skillOwner?: (name: string) => { owner: PersonId; layer: 'personal' | 'dept' | 'company' }
}

export interface CatalogAssembly {
  index: CatalogIndex
  port: CatalogPort
  /** 周复盘"疑似重复"段与工具箱高亮同一份 */
  duplicates(limit?: number): Promise<CatalogDuplicateView[]>
  /** 好东西往上浮：过了 Wilson 门槛的那些 */
  promotions(named_in_review?: Iterable<string>): Promise<PromotionCandidate[]>
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

  const scheduler = options.scheduler
  if (scheduler !== undefined) {
    index.register({
      kind: 'schedule',
      list: ({ workspace_id: ws }) =>
        scheduler
          .list({ workspace_id: ws })
          .filter((t) => LIVE_TASK_STATES.has(t.state))
          .map((t) => scheduleEntry(t, ws)),
    })
  }

  const workflows = options.workflows
  if (workflows !== undefined) {
    index.register({
      kind: 'workflow',
      list: ({ workspace_id: ws }) => {
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
    close: () => {
      index.close()
    },
  }
}
