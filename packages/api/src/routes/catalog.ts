/**
 * 40 §2 工具箱与查重面。
 *
 * 三条路由是"看得见"那一半：整个工作区建过的自动化列在一起（`GET /v1/catalog`）、
 * 建之前先查（`POST /v1/catalog/similar`）、疑似重复的成对（`GET /v1/catalog/duplicates`）。
 *
 * 真正管用的那一半是 {@link guardSimilar}：五个"建"的入口在保存前都调它，
 * 查到像的就**不直接建**，回 `409 similar_exists` + 候选，界面出一张选择题卡
 * 「复用它 / 合并进它 / 我这个不一样，仍新建」。选"仍新建"必须写一句为什么，
 * 少于 {@link MIN_DUPLICATE_REASON} 个字回 400——那句话会进目录，下次别人查得到。
 *
 * 鉴权元组沿用 `schedules.ts` / `work.ts` 那一条（`approval.read/own`）：
 * 工具箱列的是"公司里建过哪些自动化"，不是业务数据；每条东西的内容仍然在它自己的
 * 那条路由上按自己的域判权限。
 */
import type { MaybePromise, PersonId, WorkspaceId } from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { assignmentOf, body, listParam, ok, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'

const READ = { domain: 'approval', op: 'read', range: 'own', sensitivity: 'internal' } as const

/** "仍新建"那句理由的最短长度（40 §5 E4）。与 `@agentsws/catalog` 的同名常量一致。 */
export const MIN_DUPLICATE_REASON = 8

export const CATALOG_KINDS = [
  'app',
  'skill',
  'workflow',
  'schedule',
  'custom_card',
  'rule',
] as const
export type CatalogKindName = (typeof CATALOG_KINDS)[number]

export const CATALOG_LAYERS = ['personal', 'dept', 'company'] as const
export type CatalogLayerName = (typeof CATALOG_LAYERS)[number]

/** 工具箱里的一条（`@agentsws/catalog` 的 `CatalogEntry` 的网络投影）。 */
export interface CatalogEntryView {
  kind: CatalogKindName
  id: string
  title: string
  summary: string
  owner: PersonId
  layer: CatalogLayerName
  used_by_positions: string[]
  last_run_at?: string
  runs_30d: number
  created_from?: { entry_id?: string; conversation_id?: string; message_ref?: string }
  reason_for_duplicate?: string
  superseded_by?: string
  trigger?: string
  target?: string
  workspace_id: WorkspaceId
  created_at?: string
}

export interface CatalogSimilarHit {
  entry: CatalogEntryView
  similarity: number
  keys: string[]
  reasons: string[]
}

export interface CatalogDuplicateView {
  a: CatalogEntryView
  b: CatalogEntryView
  similarity: number
  both_in_use: boolean
  reasons: string[]
}

export interface CatalogSimilarQuery {
  workspace_id: WorkspaceId
  kind: CatalogKindName
  title: string
  summary?: string
  trigger?: string
  target?: string
  exclude_id?: string
  limit?: number
}

export interface CatalogPort {
  list(query: {
    workspace_id: WorkspaceId
    kind?: CatalogKindName[]
    layer?: CatalogLayerName[]
    position_id?: string
    owner?: PersonId
    text?: string
  }): MaybePromise<CatalogEntryView[]>
  similar(query: CatalogSimilarQuery): MaybePromise<CatalogSimilarHit[]>
  duplicates(query: {
    workspace_id: WorkspaceId
    limit?: number
  }): MaybePromise<CatalogDuplicateView[]>
  /** "我这个不一样，仍新建"：理由与它顶掉的那些条目一起进目录。 */
  noteDuplicate(input: {
    workspace_id: WorkspaceId
    entry_id: string
    similar_to: string[]
    reason: string
  }): MaybePromise<void>
  /** "复用它 / 合并进它"：新建出来的这条记一下从哪来。 */
  noteReuse(input: {
    workspace_id: WorkspaceId
    entry_id: string
    reused: string
  }): MaybePromise<void>
  /**
   * 复盘卡 / 工具箱上的"一键合并"：出一张 `policy_change` 卡，
   * 批了才把留下的那条升层、把并掉的那条指过去。**只出卡，不合并**。
   */
  merge?(input: {
    workspace_id: WorkspaceId
    /** 留下的那条 */
    keep: string
    /** 并进去的那条 */
    drop: string
    by: PersonId
    assignment_id: string
  }): MaybePromise<{ approval_item_id: string } | undefined>
  /**
   * 记一条"没有家的条目"：对话里定制出来的卡、指导落成的规矩，
   * 在别的包里没有一张自己的表，目录替它们保管一份。可选面：没装就少两种 kind。
   */
  record?(entry: CatalogEntryView): MaybePromise<void>
}

/**
 * 触发器 → 那把"同触发器"的钥匙。
 *
 * **一处定义，两处用**：建定时任务时（网关）与把调度库投影进目录时（宿主）
 * 必须算出同一个字符串，否则"同一个 cron 上的两条"永远认不出来。
 */
export function triggerKeyOf(
  trigger:
    | { kind: 'once'; at: string }
    | { kind: 'interval'; every_ms: number; from?: string | undefined }
    | { kind: 'cron'; expr: string; tz: string }
    | { kind: 'after_event'; event: string }
    | undefined,
): string | undefined {
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

const MergeBody = z.object({
  keep: z.string().min(1),
  drop: z.string().min(1),
})

const SimilarBody = z.object({
  kind: z.enum(CATALOG_KINDS),
  title: z.string().min(1).max(200),
  summary: z.string().max(500).optional(),
  trigger: z.string().max(200).optional(),
  target: z.string().max(200).optional(),
  exclude_id: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(20).optional(),
})

/**
 * 五个"建"的入口都带这一段：人在选择题卡上按了什么。
 *
 * 只有 `new`（"我这个不一样，仍新建"）需要服务端放行——`reuse` / `merge` 根本
 * 不会走到创建这条路由上（界面直接打开已有的那条，或另开一张合并卡）。
 */
export const DuplicateAck = z.object({
  decision: z.literal('new'),
  reason: z.string().min(1).max(500),
  /** 选择题卡上列出的候选（回写进目录，下次别人查得到"他为什么没复用"） */
  similar_to: z.array(z.string().min(1)).default([]),
})
export type DuplicateAckInput = z.infer<typeof DuplicateAck>

export interface GuardResult {
  /** 建完之后要回写进目录的那句理由；没走"仍新建"就没有 */
  note?: { reason: string; similar_to: string[] }
}

/**
 * 建之前先查（40 §2.2 第 2 条）。**五个"建"的入口共用这一个函数**——
 * 判据只写一遍，五处的行为不可能漂移。
 *
 * - 没装目录（`deps.catalog` 不在）→ 什么都不做，照常建
 * - 带了 `ack` → 校验理由长度；短了 400，够了放行并把理由带回给调用方回写
 * - 没带 `ack` 且查到像的 → 抛 `409 similar_exists`，`details.candidates` 是候选
 */
export async function guardSimilar(
  deps: GatewayDeps,
  input: {
    workspace_id: WorkspaceId
    kind: CatalogKindName
    title: string
    summary?: string
    trigger?: string
    target?: string
    exclude_id?: string
    ack?: DuplicateAckInput
  },
): Promise<GuardResult> {
  const ack = input.ack
  if (ack !== undefined) {
    const reason = ack.reason.trim()
    if (reason.length < MIN_DUPLICATE_REASON) {
      throw new ApiError(
        'invalid_input',
        `选"仍新建"要写一句为什么（至少 ${MIN_DUPLICATE_REASON} 个字），它会进工具箱，下次别人查得到`,
        { details: { field: 'duplicate_ack.reason', min: MIN_DUPLICATE_REASON } },
      )
    }
    return { note: { reason, similar_to: [...ack.similar_to] } }
  }
  const port = deps.catalog
  if (port === undefined) return {}
  const hits = await port.similar({
    workspace_id: input.workspace_id,
    kind: input.kind,
    title: input.title,
    ...(input.summary === undefined ? {} : { summary: input.summary }),
    ...(input.trigger === undefined ? {} : { trigger: input.trigger }),
    ...(input.target === undefined ? {} : { target: input.target }),
    ...(input.exclude_id === undefined ? {} : { exclude_id: input.exclude_id }),
  })
  if (hits.length === 0) return {}
  const first = hits[0]
  throw new ApiError(
    'similar_exists',
    first === undefined
      ? '已经有像的了'
      : `已有「${first.entry.title}」（${first.entry.owner} 建的）：复用它 / 合并进它 / 我这个不一样，仍新建（要写一句为什么）`,
    {
      details: {
        kind: input.kind,
        candidates: hits,
        /** 界面照这个字段渲染选择题卡的三个选项 */
        options: [
          { id: 'reuse', label: '复用它' },
          { id: 'merge', label: '合并进它' },
          { id: 'new', label: '我这个不一样，仍新建', requires_reason: true },
        ],
      },
    },
  )
}

/** 建完之后把那句理由 / 复用关系回写进目录。写失败不该让"已经建好"的东西回滚。 */
export async function recordCatalogNote(
  deps: GatewayDeps,
  input: { workspace_id: WorkspaceId; entry_id: string; guard: GuardResult },
): Promise<void> {
  const port = deps.catalog
  const note = input.guard.note
  if (port === undefined || note === undefined) return
  await port.noteDuplicate({
    workspace_id: input.workspace_id,
    entry_id: input.entry_id,
    similar_to: note.similar_to,
    reason: note.reason,
  })
}

function portOf(deps: GatewayDeps): CatalogPort {
  if (deps.catalog === undefined) {
    throw new ApiError('not_implemented', '这个进程没有装工具箱')
  }
  return deps.catalog
}

export function catalogRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/catalog',
        operationId: 'listCatalog',
        summary: '工具箱：本工作区建过的应用 / 技能 / 流程 / 定时任务 / 定制卡 / 规矩（40 §2.2）',
        tag: 'catalog',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [
          { name: 'kind', in: 'query', description: `逗号分隔：${CATALOG_KINDS.join(' | ')}` },
          { name: 'layer', in: 'query', description: `逗号分隔：${CATALOG_LAYERS.join(' | ')}` },
          { name: 'position', in: 'query', description: '只看这个岗位在用的' },
          { name: 'owner', in: 'query', description: '只看这个人建的' },
          { name: 'q', in: 'query', description: '按用途搜索（与 ⌘K 同源）' },
        ],
        returns: 'CatalogEntry[]',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        const kind = listParam(c, 'kind')
        const layer = listParam(c, 'layer')
        for (const k of kind ?? [])
          if (!(CATALOG_KINDS as readonly string[]).includes(k))
            throw new ApiError('invalid_input', `kind 只能是 ${CATALOG_KINDS.join(' / ')}`)
        for (const l of layer ?? [])
          if (!(CATALOG_LAYERS as readonly string[]).includes(l))
            throw new ApiError('invalid_input', `layer 只能是 ${CATALOG_LAYERS.join(' / ')}`)
        const position = c.req.query('position')
        const owner = c.req.query('owner')
        const text = c.req.query('q')
        return ok(
          c,
          await portOf(deps).list({
            workspace_id: p.workspace_id,
            ...(kind === undefined ? {} : { kind: kind as CatalogKindName[] }),
            ...(layer === undefined ? {} : { layer: layer as CatalogLayerName[] }),
            ...(position === undefined || position === '' ? {} : { position_id: position }),
            ...(owner === undefined || owner === '' ? {} : { owner }),
            ...(text === undefined || text.trim() === '' ? {} : { text }),
          }),
        )
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/catalog/duplicates',
        operationId: 'listCatalogDuplicates',
        summary: '疑似重复的成对（相似度高但两条都还在用；周复盘那一段用同一份）',
        tag: 'catalog',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [{ name: 'limit', in: 'query', description: '最多几对（默认全给）' }],
        returns: 'CatalogDuplicate[]',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        const raw = c.req.query('limit')
        const limit = raw === undefined || raw.trim() === '' ? undefined : Number(raw)
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1))
          throw new ApiError('invalid_input', 'limit 必须是正整数')
        return ok(
          c,
          await portOf(deps).duplicates({
            workspace_id: p.workspace_id,
            ...(limit === undefined ? {} : { limit }),
          }),
        )
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/catalog/merge',
        operationId: 'mergeCatalogEntries',
        summary: '一键合并两条疑似重复的（40 §2.2 第 4 条）：出一张 policy_change 卡，批了才合',
        tag: 'catalog',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        body: MergeBody,
        returns: '{ approval_item_id }',
      },
      async (c, deps) => {
        const p = principalOf(c)
        const assignment = assignmentOf(c)
        const port = portOf(deps)
        if (port.merge === undefined) throw new ApiError('not_implemented', '这个进程不支持合并')
        const input = await body(c, MergeBody)
        if (input.keep === input.drop)
          throw new ApiError('invalid_input', '留下的和并掉的不能是同一条')
        const out = await port.merge({
          workspace_id: p.workspace_id,
          keep: input.keep,
          drop: input.drop,
          by: p.person_id,
          assignment_id: assignment.id,
        })
        if (out === undefined) throw new ApiError('not_found', '目录里没有这两条')
        return ok(c, out, 201)
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/catalog/similar',
        operationId: 'findSimilarCatalogEntries',
        summary: '建之前先查：有没有人已经做过一样的（40 §2.2 第 2 条）',
        tag: 'catalog',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        body: SimilarBody,
        returns: 'CatalogSimilarHit[]',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        const input = await body(c, SimilarBody)
        return ok(
          c,
          await portOf(deps).similar({
            workspace_id: p.workspace_id,
            kind: input.kind,
            title: input.title,
            ...(input.summary === undefined ? {} : { summary: input.summary }),
            ...(input.trigger === undefined ? {} : { trigger: input.trigger }),
            ...(input.target === undefined ? {} : { target: input.target }),
            ...(input.exclude_id === undefined ? {} : { exclude_id: input.exclude_id }),
            ...(input.limit === undefined ? {} : { limit: input.limit }),
          }),
        )
      },
    ),
  ]
}
