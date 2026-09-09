/**
 * 36 工作台面：首页、岗位（卡片 / 面板 / 记录）、积木数据、数字块设置。
 *
 * 三条边界：
 * - **一次请求一个 Assignment**（31 §3.1）：`position_id === assignment_id`，岗位路由一律要求
 *   `:id` 与 `X-Assignment` 相同；首页跨岗位，但每个岗位的数各自在自己的 Assignment 下算，不并集。
 * - **数字不经模型手**（29 原则 ③）：payload 全在服务端由 `@agentsws/deck` 的命名查询算好。
 * - **组件与查询只能来自注册表**（29 原则 ①）：未注册的积木 id / 查询名一律拒。
 */
import type { RoleId } from '@agentsws/contracts'
import {
  assembleHome,
  assembleView,
  type BlockDef,
  blockDef,
  computeBlock,
  computeTiles,
  type DeckCard,
  DeckError,
  type HomePosition,
  MAX_TILES_PER_POSITION,
  projectCard,
  queryDef,
  sortCards,
  TILE_LIBRARY,
  validateTileSelection,
} from '@agentsws/deck'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { assignmentOf, body, ok, param, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type {
  GatewayDeps,
  PositionSummary,
  WorkstationActor,
  WorkstationPort,
  WorkstationRange,
} from '../types.js'

/** 工作台的基础准入：能读自己的审批队列。逐条查询的域权限在处理器里另查（29 §2）。 */
const READ = { domain: 'approval', op: 'read', range: 'own', sensitivity: 'internal' } as const

/** 29 §2「校验 actor 对 query 的权限」：数据源 → (数据域, 范围)。 */
const SOURCE_AUTHZ = {
  shop: { domain: 'order', range: 'assigned' },
  approvals: { domain: 'approval', range: 'own' },
  ga4: { domain: 'analytics', range: 'assigned' },
  gsc: { domain: 'analytics', range: 'assigned' },
  ads: { domain: 'ad_account', range: 'assigned' },
  csat: { domain: 'review', range: 'assigned' },
} as const

const RANGE_PARAM = {
  name: 'range',
  in: 'query',
  description: 'yesterday | last_7d，默认 yesterday（36 §3）',
} as const

const HomeTilesBody = z.object({
  position_id: z.string().min(1),
  tile_ids: z.array(z.string().min(1)).max(MAX_TILES_PER_POSITION),
  range: z.enum(['yesterday', 'last_7d']).optional(),
})

function workstationOf(deps: GatewayDeps): WorkstationPort {
  const w = deps.workstation
  if (w === undefined)
    throw new ApiError('not_implemented', '这个服务进程没有装配工作台面（GatewayDeps.workstation）')
  return w
}

function rangeOf(c: { req: { query(name: string): string | undefined } }): WorkstationRange {
  const raw = c.req.query('range')
  if (raw === undefined || raw === '') return 'yesterday'
  if (raw !== 'yesterday' && raw !== 'last_7d')
    throw new ApiError('invalid_input', 'range 只能是 yesterday 或 last_7d')
  return raw
}

/** DeckError → 网关错误（`OPTION_REQUIRED` → invalid_input，`VERSION_MISMATCH` → conflict）。 */
export function fromDeckError(err: unknown): never {
  if (err instanceof DeckError)
    throw new ApiError(err.code, err.message, {
      details: { reason: err.reason, ...(typeof err.details === 'object' ? err.details : {}) },
    })
  throw err
}

/** 岗位路由：`:id` 必须就是本次绑定的 Assignment（31 §3.1）。 */
async function positionOf(
  c: Parameters<typeof param>[0],
  deps: GatewayDeps,
  actor: WorkstationActor,
): Promise<PositionSummary> {
  const id = param(c, 'id')
  if (id !== assignmentOf(c).id)
    throw new ApiError('forbidden', '岗位 id 必须与 X-Assignment 一致（一次请求一个 Assignment）')
  const positions = await workstationOf(deps).positions(actor)
  const found = positions.find((p) => p.position_id === id)
  if (found === undefined) throw new ApiError('not_found', `没有这个岗位：${id}`)
  return found
}

/** 29 §2：跑查询之前先按数据源查一次域权限。 */
function assertQueryAllowed(
  deps: GatewayDeps,
  assignment_id: string,
  source: keyof typeof SOURCE_AUTHZ,
): void {
  const spec = SOURCE_AUTHZ[source]
  if (
    !deps.roles.can(assignment_id, spec.domain, 'read', {
      range: spec.range,
      sensitivity: 'internal',
    })
  )
    throw new ApiError('forbidden', `无权读这个数据源：${source}`, { details: { source, ...spec } })
}

async function cardsOf(
  deps: GatewayDeps,
  actor: WorkstationActor,
  position: PositionSummary,
): Promise<DeckCard[]> {
  const w = workstationOf(deps)
  const items = await w.items(actor, position)
  const now = deps.clock.now()
  return sortCards(
    items.map((i) =>
      projectCard(i, { now, position_id: position.position_id, label: (r) => w.label(r) }),
    ),
  )
}

export function workstationRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/home',
        operationId: 'getHome',
        summary:
          '首页（37 §3 第三稿）：目标进度 + 今天（时间轴 / 到期清单）+ 卡片队列 + 告警 + 核心数据条 + 复盘',
        tag: 'workstation',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [RANGE_PARAM],
        returns:
          '{ queue, alerts, tiles, digest?, estimated_minutes, range, goals?, today?, review?, plan? }',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        const w = workstationOf(deps)
        const actor: WorkstationActor = { workspace_id: p.workspace_id, person_id: p.person_id }
        const range = rangeOf(c)
        const positions = await w.positions(actor)
        const home: HomePosition[] = []
        for (const position of positions) {
          const items = await w.items(actor, position)
          // 没有默认数字块的职责（common.member 之类）不出数据条，但它的卡照样进队列。
          const tile_ids = position.show_tiles ? position.tile_ids : []
          home.push({
            position_id: position.position_id,
            role_id: position.role_id,
            role_name: position.role_name,
            items: [...items],
            tile_ids,
            range: position.range,
            query: await w.queryContext(actor, position, range),
          })
        }
        const system = await w.systemCards(actor)
        // 37 §3 首页第三稿：在原有四区之外**只加字段**——目标进度、今天（时间轴 + 到期清单）、
        // 复盘 / 每日计划。装了工作模型才有；没装配时这几个键直接不出，老前端照旧。
        const workHome =
          deps.work === undefined
            ? undefined
            : await deps.work.home({
                workspace_id: p.workspace_id,
                person_id: p.person_id,
                assignment_id: assignmentOf(c).id,
              })
        try {
          return ok(c, {
            ...assembleHome({
              now: deps.clock.now(),
              positions: home,
              alerts: system.alerts,
              ...(system.digest === undefined ? {} : { digest: system.digest }),
              range,
              label: (r) => w.label(r),
            }),
            ...(workHome === undefined ? {} : workHome),
          })
        } catch (err) {
          return fromDeckError(err)
        }
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/positions',
        operationId: 'listPositions',
        summary: '本人持有的岗位（= 未撤销的 Assignment）与其职责',
        tag: 'workstation',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'PositionSummary[]',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        const positions = await workstationOf(deps).positions({
          workspace_id: p.workspace_id,
          person_id: p.person_id,
        })
        return ok(c, { positions, tile_library: TILE_LIBRARY, max_tiles: MAX_TILES_PER_POSITION })
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/positions/:id/cards',
        operationId: 'getPositionCards',
        summary: '岗位的卡片 Tab（只这个岗位的队列）',
        tag: 'workstation',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [
          { name: 'id', in: 'path', required: true, description: 'position_id = assignment_id' },
        ],
        returns: 'DeckCard[]',
      },
      async (c, deps) => {
        const p = principalOf(c)
        const actor: WorkstationActor = { workspace_id: p.workspace_id, person_id: p.person_id }
        const position = await positionOf(c, deps, actor)
        return ok(c, { position, cards: await cardsOf(deps, actor, position) })
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/positions/:id/view',
        operationId: 'getPositionView',
        summary: '岗位的面板 Tab：按数据源分块（店铺后台 / GA4 / Search Console / 广告后台）',
        tag: 'workstation',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [
          { name: 'id', in: 'path', required: true, description: 'position_id = assignment_id' },
          RANGE_PARAM,
        ],
        returns: '{ position, range, sections: [{ source, connected, blocks, report_url? }] }',
      },
      async (c, deps) => {
        const p = principalOf(c)
        const actor: WorkstationActor = { workspace_id: p.workspace_id, person_id: p.person_id }
        const position = await positionOf(c, deps, actor)
        const range = rangeOf(c)
        const ctx = await workstationOf(deps).queryContext(actor, position, range)
        const sections = assembleView(position.role_id as RoleId, ctx).map((s) => ({
          ...s,
          // 无权读的数据源在面板上直接不出块（19 §3 的过滤下推：不是先给再脱敏）
          blocks: s.blocks.filter((b: BlockDef) => allowed(deps, position.position_id, b.source)),
        }))
        return ok(c, { position, range, sections: sections.filter((s) => s.blocks.length > 0) })
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/positions/:id/records',
        operationId: 'getPositionRecords',
        summary: '岗位的记录 Tab（过往决定与变更）',
        tag: 'workstation',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [
          { name: 'id', in: 'path', required: true, description: 'position_id = assignment_id' },
        ],
        returns: '{ rows: RecordRow[] }',
      },
      async (c, deps) => {
        const p = principalOf(c)
        const actor: WorkstationActor = { workspace_id: p.workspace_id, person_id: p.person_id }
        const position = await positionOf(c, deps, actor)
        const ctx = await workstationOf(deps).queryContext(actor, position, position.range)
        try {
          const data = computeBlock('records.timeline', ctx, position.range)
          return ok(c, { position, ...data })
        } catch (err) {
          return fromDeckError(err)
        }
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/blocks/:id/data',
        operationId: 'getBlockData',
        summary: '积木数据（29 §2 渲染管线：命名查询 → enrichment → payload_schema 校验）',
        tag: 'workstation',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [
          { name: 'id', in: 'path', required: true, description: '积木 id（必须在注册表里）' },
          RANGE_PARAM,
        ],
        returns: '{ block, range, status, payload? }',
      },
      async (c, deps) => {
        const p = principalOf(c)
        const assignment = assignmentOf(c)
        const actor: WorkstationActor = { workspace_id: p.workspace_id, person_id: p.person_id }
        const id = param(c, 'id')
        const range = rangeOf(c)
        // 先查注册表与权限，再取上下文：无权的数据源根本不该跑查询（19 §3 过滤下推的同一条原则）
        let source: keyof typeof SOURCE_AUTHZ
        try {
          source = queryDef(blockDef(id).query).source
        } catch (err) {
          return fromDeckError(err)
        }
        assertQueryAllowed(deps, assignment.id, source)
        const positions = await workstationOf(deps).positions(actor)
        const position = positions.find((x) => x.position_id === assignment.id)
        if (position === undefined)
          throw new ApiError('not_found', `没有这个岗位：${assignment.id}`)
        try {
          const ctx = await workstationOf(deps).queryContext(actor, position, range)
          return ok(c, computeBlock(id, ctx, range))
        } catch (err) {
          return fromDeckError(err)
        }
      },
    ),
    route(
      {
        method: 'put',
        path: '/v1/me/home-tiles',
        operationId: 'setHomeTiles',
        summary: '换 / 增减首页数字块（上限 6 / 岗位；时间范围跟随岗位记忆）',
        tag: 'workstation',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        body: HomeTilesBody,
        returns: '{ position, tiles }',
      },
      async (c, deps) => {
        const p = principalOf(c)
        const assignment = assignmentOf(c)
        const actor: WorkstationActor = { workspace_id: p.workspace_id, person_id: p.person_id }
        const input = await body(c, HomeTilesBody)
        if (input.position_id !== assignment.id)
          throw new ApiError('forbidden', '只能改本次绑定的那个岗位的数字块')
        try {
          const tile_ids = validateTileSelection(input.tile_ids)
          const position = await workstationOf(deps).setHomeTiles(actor, {
            position_id: input.position_id,
            tile_ids,
            ...(input.range === undefined ? {} : { range: input.range }),
          })
          const ctx = await workstationOf(deps).queryContext(actor, position, position.range)
          return ok(c, { position, tiles: computeTiles(position.tile_ids, ctx, position.range) })
        } catch (err) {
          return fromDeckError(err)
        }
      },
    ),
  ]
}

function allowed(
  deps: GatewayDeps,
  assignment_id: string,
  source: keyof typeof SOURCE_AUTHZ,
): boolean {
  const spec = SOURCE_AUTHZ[source]
  return deps.roles.can(assignment_id, spec.domain, 'read', {
    range: spec.range,
    sensitivity: 'internal',
  })
}
