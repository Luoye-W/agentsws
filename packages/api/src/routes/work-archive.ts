/**
 * WP207：左栏的「职责下正在进行的对话 / 任务」、自动归档、找回。
 *
 * 九条路由：
 * - `GET  /v1/work/rail`：左栏那一份——每条本人持有的职责下进行中的事项（带状态小点）、
 *   已归档条数、岗位右侧「等你处理的数」。读它的时候顺手把超过 N 天没动的归档（懒扫，没有定时器）。
 * - `GET  /v1/work/archived`：已归档列表（按时间 / 岗位 / 职责筛，可带搜索词）。
 * - `GET  /v1/work/search`：全文搜（标题、摘要、正文），进行中与归档的都给，归档的标出来（⌘K 用）。
 * - `POST /v1/work/archived/find`：「让 AI 找回」——**只读**，给候选，不恢复。
 * - `POST /v1/matters/:id/archive`：人手动归档一件（在跑 / 等你批的不许）。
 * - `POST /v1/matters/:id/unarchive`：放回来（人点了恢复 / 点选了 AI 的候选）。**一次一件**。
 * - `POST /v1/matters/:id/seen`：本人点开看过了（「做完待看」的小点灭掉）。
 * - `GET / PUT /v1/settings/work-archive`：自动归档天数（1–30 或不自动归档）。
 *
 * 权限与工作模型同一档（能读自己的队列就能看自己的事项）：归档只是"移出左栏"，
 * 内容、记忆、卡片历史一样不少，恢复是本机低风险动作。
 */
import type {
  ArchivedWorkCandidate,
  FindArchivedWorkInput,
  Matter,
  MaybePromise,
  WorkArchiveSettings,
} from '@agentsws/contracts'
import {
  MAX_ARCHIVE_IDLE_DAYS,
  MAX_HANDOFF_RETURN_DAYS,
  MIN_ARCHIVE_IDLE_DAYS,
  MIN_HANDOFF_RETURN_DAYS,
} from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { assignmentOf, body, ok, param, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'
import type { WorkActor } from './work.js'

const READ = { domain: 'approval', op: 'read', range: 'own', sensitivity: 'internal' } as const
const TAG = 'work'

/**
 * 左栏一件事的状态小点：
 * `running` 在跑；`awaiting` 等你批（有卡等你定）；`ready` Agent 做完了、最后一句是它说的（待你看）；
 * `idle` 都不是（开着、等下一步）。
 */
export type RailMatterState = 'running' | 'awaiting' | 'ready' | 'idle'

export interface RailMatterView {
  id: string
  title: string
  state: RailMatterState
  last_activity: string
  /** 等你定的卡数（`awaiting` 时 ≥ 1）。 */
  cards: number
}

export interface RailDutyView {
  role_id: string
  /** 进行中的事项，按最近活动倒序，最多 `limit` 条。 */
  matters: RailMatterView[]
  /** 还有几条没列出来（「更多」）。 */
  more: number
  /** 这条职责下已归档的条数（「已归档（n）」）。 */
  archived: number
}

export interface RailPositionView {
  position_id: string
  /** 等你处理的数：等你批的卡 + 做完待你看的事（岗位右侧那个数字）。 */
  awaiting: number
  duties: RailDutyView[]
}

export interface WorkRailView {
  /** 现在的自动归档天数（`null` = 不自动归档）。 */
  idle_days: number | null
  positions: RailPositionView[]
}

/** 已归档 / 搜到的一件事。 */
export interface ArchivedMatterView {
  id: string
  title: string
  /** 摘要（没有就是空串）。 */
  summary: string
  position_template_id?: string
  role_id?: string
  status: Matter['status']
  last_activity: string
  /** 没归档就没有。 */
  archived_at?: string
  /** 搜的时候：命中那一句的前后一小段（纯文本）。 */
  snippet?: string
}

export interface ArchivedListFilter {
  q?: string
  position_id?: string
  role_id?: string
  from?: string
  to?: string
  limit?: number
}

export interface WorkArchivePort {
  rail(actor: WorkActor, options: { limit?: number }): MaybePromise<WorkRailView>
  archived(actor: WorkActor, filter: ArchivedListFilter): MaybePromise<ArchivedMatterView[]>
  search(actor: WorkActor, input: { q: string; limit?: number }): MaybePromise<ArchivedMatterView[]>
  /** 只读：给候选，**不恢复**。`semantic` = 这次有没有用上语义分。 */
  find(
    actor: WorkActor,
    input: FindArchivedWorkInput,
  ): MaybePromise<{ candidates: ArchivedWorkCandidate[]; semantic: boolean }>
  /**
   * 人手动归档一件（Fable 09-30）。**在跑的、有卡等你批的不许归档**：回 `conflict`，
   * `details.reason` 是 `running` / `awaiting`，界面上按钮本来就置灰，这里是兜底。
   */
  archive(actor: WorkActor, id: string): MaybePromise<{ matter: Matter }>
  unarchive(
    actor: WorkActor,
    id: string,
    by: 'user' | 'ai_suggested',
  ): MaybePromise<{ matter: Matter }>
  /** 本人点开看过这件事了（「做完待看」那个小点就灭）。 */
  seen(actor: WorkActor, id: string): MaybePromise<{ ok: true }>
  settings(actor: WorkActor): MaybePromise<WorkArchiveSettings>
  setSettings(actor: WorkActor, input: WorkArchiveSettings): MaybePromise<WorkArchiveSettings>
}

const FindBody = z.object({
  query: z.string().min(1).max(500),
  since: z.string().min(1).optional(),
  until: z.string().min(1).optional(),
  position: z.string().min(1).max(120).optional(),
  participant: z.string().min(1).max(120).optional(),
  limit: z.number().int().min(1).max(8).optional(),
})

/** 恢复只收这两种来路：`activity`（有新活动自动放回）不是人能点出来的。 */
const UnarchiveBody = z.object({ by: z.enum(['user', 'ai_suggested']).optional() })

const SettingsBody = z.object({
  idle_days: z.number().int().min(MIN_ARCHIVE_IDLE_DAYS).max(MAX_ARCHIVE_IDLE_DAYS).nullable(),
  /** WP276（决策 241）：交给对方没人理几天自动退回（不给 = 不改）。 */
  handoff_days: z
    .number()
    .int()
    .min(MIN_HANDOFF_RETURN_DAYS)
    .max(MAX_HANDOFF_RETURN_DAYS)
    .optional(),
})

type Ctx = Parameters<typeof param>[0]

function portOf(deps: GatewayDeps): WorkArchivePort {
  const p = deps.workArchive
  if (p === undefined)
    throw new ApiError('not_implemented', '这个服务进程没有装配归档（GatewayDeps.workArchive）')
  return p
}

function actorOf(c: Ctx): WorkActor {
  const p = principalOf(c)
  return { workspace_id: p.workspace_id, person_id: p.person_id, assignment_id: assignmentOf(c).id }
}

function query(c: Ctx, name: string): string | undefined {
  const raw = c.req.query(name)?.trim()
  return raw === undefined || raw === '' ? undefined : raw
}

function limitOf(c: Ctx, max: number): number | undefined {
  const raw = query(c, 'limit')
  if (raw === undefined) return undefined
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0 || n > max)
    throw new ApiError('invalid_input', `limit 必须是 1–${max} 的整数`)
  return n
}

function timeOf(c: Ctx, name: string): string | undefined {
  const raw = query(c, name)
  if (raw !== undefined && Number.isNaN(Date.parse(raw)))
    throw new ApiError('invalid_input', `${name} 不是时间（要 ISO8601）`)
  return raw
}

export function workArchiveRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/work/rail',
        operationId: 'getWorkRail',
        summary:
          'WP207 左栏：每条本人持有的职责下进行中的对话 / 任务（在跑 / 等你批 / 做完待看）、已归档条数、岗位等你处理的数；读时顺手自动归档',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [
          { name: 'limit', in: 'query', description: '每条职责最多列几条（默认 5，最多 20）' },
        ],
        returns: 'WorkRailView',
      },
      async (c, deps) => {
        const limit = limitOf(c, 20)
        return ok(c, await portOf(deps).rail(actorOf(c), limit === undefined ? {} : { limit }))
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/work/archived',
        operationId: 'listArchivedWork',
        summary: 'WP207 已归档的对话 / 任务（按时间 / 岗位 / 职责筛，可带搜索词）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [
          {
            name: 'q',
            in: 'query',
            description: '搜索词（标题、摘要、正文；空格分开的词都要出现）',
          },
          { name: 'position_id', in: 'query', description: '岗位模板 id' },
          { name: 'role_id', in: 'query', description: '职责 id' },
          { name: 'from', in: 'query', description: '最后活动不早于（ISO8601）' },
          { name: 'to', in: 'query', description: '最后活动早于（ISO8601）' },
          { name: 'limit', in: 'query', description: '最多几条（默认 50，最多 200）' },
        ],
        returns: '{ matters: ArchivedMatterView[] }',
      },
      async (c, deps) => {
        const q = query(c, 'q')
        const position_id = query(c, 'position_id')
        const role_id = query(c, 'role_id')
        const from = timeOf(c, 'from')
        const to = timeOf(c, 'to')
        const limit = limitOf(c, 200)
        const matters = await portOf(deps).archived(actorOf(c), {
          ...(q === undefined ? {} : { q }),
          ...(position_id === undefined ? {} : { position_id }),
          ...(role_id === undefined ? {} : { role_id }),
          ...(from === undefined ? {} : { from }),
          ...(to === undefined ? {} : { to }),
          ...(limit === undefined ? {} : { limit }),
        })
        return ok(c, { matters })
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/work/search',
        operationId: 'searchWork',
        summary: 'WP207 全文搜对话 / 任务（进行中与已归档都给，已归档的带 archived_at）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [
          { name: 'q', in: 'query', required: true, description: '搜索词' },
          { name: 'limit', in: 'query', description: '最多几条（默认 20，最多 50）' },
        ],
        returns: '{ matters: ArchivedMatterView[] }',
      },
      async (c, deps) => {
        const q = query(c, 'q')
        if (q === undefined) throw new ApiError('invalid_input', '缺少查询参数 q')
        const limit = limitOf(c, 50)
        const matters = await portOf(deps).search(actorOf(c), {
          q: q.slice(0, 200),
          ...(limit === undefined ? {} : { limit }),
        })
        return ok(c, { matters })
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/work/archived/find',
        operationId: 'findArchivedWork',
        summary:
          'WP207「让 AI 找回」：一句模糊的话 → 最像的几个已归档候选（关键词 + 语义，没有嵌入就只有关键词）。只读，不恢复',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        body: FindBody,
        returns: '{ candidates: ArchivedWorkCandidate[], semantic }',
      },
      async (c, deps) => {
        const input = await body(c, FindBody)
        return ok(
          c,
          await portOf(deps).find(actorOf(c), {
            query: input.query,
            ...(input.since === undefined ? {} : { since: input.since }),
            ...(input.until === undefined ? {} : { until: input.until }),
            ...(input.position === undefined ? {} : { position: input.position }),
            ...(input.participant === undefined ? {} : { participant: input.participant }),
            ...(input.limit === undefined ? {} : { limit: input.limit }),
          }),
        )
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/matters/:id/archive',
        operationId: 'archiveMatter',
        summary: 'WP207 手动归档一件对话 / 任务（在跑的、有卡等你批的回 409；撤销走 unarchive）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [{ name: 'id', in: 'path', required: true, description: 'matter_id' }],
        returns: '{ matter: Matter }',
      },
      async (c, deps) => ok(c, await portOf(deps).archive(actorOf(c), param(c, 'id'))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/matters/:id/unarchive',
        operationId: 'unarchiveMatter',
        summary:
          'WP207 把一件归档的对话 / 任务放回来（一次一件；`by: ai_suggested` = 人点选了 AI 的候选）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [{ name: 'id', in: 'path', required: true, description: 'matter_id' }],
        body: UnarchiveBody,
        returns: '{ matter: Matter }',
      },
      async (c, deps) => {
        const input = await body(c, UnarchiveBody)
        return ok(c, await portOf(deps).unarchive(actorOf(c), param(c, 'id'), input.by ?? 'user'))
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/matters/:id/seen',
        operationId: 'markMatterSeen',
        summary: 'WP207 本人点开看过这件事了（左栏「做完待看」的小点就灭；不改事项本身）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [{ name: 'id', in: 'path', required: true, description: 'matter_id' }],
        returns: '{ ok: true }',
      },
      async (c, deps) => ok(c, await portOf(deps).seen(actorOf(c), param(c, 'id'))),
    ),
    route(
      {
        method: 'get',
        path: '/v1/settings/work-archive',
        operationId: 'getWorkArchiveSettings',
        summary: 'WP207 自动归档设置：超过几天没新活动就归档（null = 不自动归档）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'WorkArchiveSettings',
      },
      async (c, deps) => ok(c, await portOf(deps).settings(actorOf(c))),
    ),
    route(
      {
        method: 'put',
        path: '/v1/settings/work-archive',
        operationId: 'putWorkArchiveSettings',
        summary: 'WP207 改自动归档天数（1–30，或 null 不自动归档）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        body: SettingsBody,
        returns: 'WorkArchiveSettings',
      },
      async (c, deps) => {
        const input = await body(c, SettingsBody)
        return ok(
          c,
          await portOf(deps).setSettings(actorOf(c), {
            idle_days: input.idle_days,
            ...(input.handoff_days === undefined ? {} : { handoff_days: input.handoff_days }),
          }),
        )
      },
    ),
  ]
}
