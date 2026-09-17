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
  BATTLE_REPORT_EVENT_TYPES,
  type BlockDef,
  battleReport,
  blockDef,
  computeBlock,
  computeTiles,
  type DeckCard,
  DeckError,
  type DeckFilters,
  type DeckKind,
  type DeckSource,
  type DeckWaiting,
  filterCards,
  foldCards,
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
import { DuplicateAck, guardSimilar, recordCatalogNote } from './catalog.js'

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
  // WP64（51 §2.3 / §2.4）：邮件营销那两块要 campaign 域（分群 / 活动 / 自动流都挂它），
  // 物流异常要 shipment 域。挂错域的后果是"别的岗位也看得见"，所以照职责 yml 的
  // scopes 一格一格对，不图省事套 order。
  email_marketing: { domain: 'campaign', range: 'assigned' },
  tracking: { domain: 'shipment', range: 'assigned' },
  // WP63（51 §2.1 评价管理）：评价应用的读走 `review` 域，与满意度同一格
  reviews: { domain: 'review', range: 'assigned' },
  // WP67（48 §5.1）：红人库那五块走 `creator` 域。
  //
  // 为什么不按分块各挂各的域（找人挂 platform_account、归因挂 tracked_link）：
  // 五块是**同一条职责的同一个面板**，而五条渠道职责的 scopes 里这六个域是一起给的
  // ——拆开挂只会让"某一块看得见另一块看不见"这种半截状态变得可能。
  // 挂 `creator` 是因为它是那一组里最根的一个：没有它，另外五个域一格数据都指不到人。
  kol: { domain: 'creator', range: 'assigned' },
  kol_channel: { domain: 'creator', range: 'assigned' },
  /*
   * WP72（56 §2）：社媒那九个源。
   *
   * 全部挂 `social_account` 域，理由与红人那两行逐字相同：九条渠道职责的
   * scopes 里 `social_account` 是最根的一个——没有它，帖子、线程、成员一格都指不到号。
   * 而客服的「社群管理」读得到 `community_thread` 却**没有** `social_account`，
   * 于是它天然看不到这几块面板（19 §3 过滤下推：无权的数据源连「去连接」都不该出）
   * ——那正是我们要的：内容与氛围是社媒运营的事，客户的问题才是它的事（56 边界行）。
   */
  social: { domain: 'social_account', range: 'assigned' },
  social_meta: { domain: 'social_account', range: 'assigned' },
  social_tiktok: { domain: 'social_account', range: 'assigned' },
  social_x: { domain: 'social_account', range: 'assigned' },
  social_youtube: { domain: 'social_account', range: 'assigned' },
  social_reddit: { domain: 'social_account', range: 'assigned' },
  social_discord: { domain: 'social_account', range: 'assigned' },
  social_telegram: { domain: 'social_account', range: 'assigned' },
  social_whatsapp: { domain: 'social_account', range: 'assigned' },
  /*
   * WP75（57 §1）：投放那五个源。
   *
   * 全部挂 `ad_account` 域，理由与红人 / 社媒那两组逐字相同：四条平台职责的
   * scopes 里 `ad_account` 是最根的一个——没有它，campaign、广告组、广告一格
   * 都指不到账户。
   *
   * **像素那一块也挂 `ad_account` 不挂 `pixel_event`**：`pixel_event` 是"改不改得动"
   * 那把闸（投放只读、建站能写），而"看不看得见这块面板"要的是"读不读得到这个
   * 广告账户"。挂 `pixel_event` 的话，将来建站那条职责会连带看见投放的面板——
   * 那不是我们要的（19 §3：无权的数据源连「去连接」都不该出）。
   */
  ads_meta: { domain: 'ad_account', range: 'assigned' },
  ads_google: { domain: 'ad_account', range: 'assigned' },
  ads_x: { domain: 'ad_account', range: 'assigned' },
  ads_tiktok: { domain: 'ad_account', range: 'assigned' },
  /*
   * WP78（60 §3）：公关那两个源。
   *
   * 两个都挂 `mention` 域，理由与上面那几行同一条：四条公关职责的 scopes 里
   * `mention` 是**唯一四条都有**的那一个（新闻稿要知道上一波舆情、外部露出要
   * 知道答哪条、监控本来就是它）。挂 `press_release` 的话，`pr.reddit` 与
   * `pr.forums` 会看不见提及流那一块——而它们正是靠那一块决定去答什么。
   */
  pr: { domain: 'mention', range: 'assigned' },
  google_alerts: { domain: 'mention', range: 'assigned' },
} as const

const RANGE_PARAM = {
  name: 'range',
  in: 'query',
  description: 'yesterday | last_7d，默认 yesterday（36 §3）',
} as const

/** 37 §1 末段的筛选行：岗位 / 等待 / 卡型 / 来源。 */
const FILTER_PARAMS = [
  { name: 'position_id', in: 'query', description: '只看这个岗位的卡（37 §1 岗位 chip）' },
  {
    name: 'waiting',
    in: 'query',
    description: 'customer_waiting | nobody_waiting（37 §1 等待 chip）',
  },
  { name: 'kind', in: 'query', description: '卡型（37 §1 卡型下拉）' },
  { name: 'source', in: 'query', description: 'todo | conversation | system（来源）' },
] as const

const WAITINGS: readonly DeckWaiting[] = ['customer_waiting', 'nobody_waiting']
const SOURCES: readonly DeckSource[] = ['todo', 'conversation', 'system']

/**
 * query → `DeckFilters`。
 *
 * 值一律先校验再进：`waiting=lol` 回 400 而不是悄悄退成"全部"——一个被默默忽略的
 * 筛选条件，界面上显示的是"客户在等"，给的却是全部，比报错难查得多。
 * `kind` 不查白名单（14 的 kind 表会长），未知值只是筛不出东西。
 */
function filtersOf(c: { req: { query(name: string): string | undefined } }): DeckFilters {
  const pick = (name: string): string | undefined => {
    const raw = c.req.query(name)
    return raw === undefined || raw === '' ? undefined : raw
  }
  const waiting = pick('waiting')
  if (waiting !== undefined && !WAITINGS.includes(waiting as DeckWaiting))
    throw new ApiError('invalid_input', 'waiting 只能是 customer_waiting 或 nobody_waiting')
  const source = pick('source')
  if (source !== undefined && !SOURCES.includes(source as DeckSource))
    throw new ApiError('invalid_input', 'source 只能是 todo / conversation / system')
  const position_id = pick('position_id')
  const kind = pick('kind')
  return {
    ...(position_id === undefined ? {} : { position_id }),
    ...(waiting === undefined ? {} : { waiting: waiting as DeckWaiting }),
    ...(kind === undefined ? {} : { kind: kind as DeckKind }),
    ...(source === undefined ? {} : { source: source as DeckSource }),
  }
}

/**
 * 37 §1 第 9 行的今日战报。
 *
 * 事件日志按类型预过滤后一次读完；`limit` 是保险丝，不是分页——战报是"今天"的，
 * 一个工作区一天不会有两万条这四类事件；真到那个量级，多出来的只会让四个数偏小，
 * 不会算错别的东西。
 */
async function todaysReport(
  deps: GatewayDeps,
  workspace_id: string,
  tz_offset_minutes: number,
): Promise<ReturnType<typeof battleReport>> {
  const events = []
  for await (const e of deps.eventLog.read({
    workspace_id,
    types: [...BATTLE_REPORT_EVENT_TYPES],
    limit: 5000,
  }))
    events.push(e)
  return battleReport(events, { now: deps.clock.now(), tz_offset_minutes })
}

/** 29 §4 对话定制：模型只提出"把哪个积木钉成卡"，payload 永远由服务端算（原则 ③）。 */
const ProposeBlockBody = z.object({
  block_id: z.string().min(1),
  /** 不给就用积木自己的标题 */
  title: z.string().min(1).max(120).optional(),
  /** 29 §1 `CustomCard.created_from`：从哪次对话来的 */
  conversation_id: z.string().min(1),
  message_ref: z.string().min(1).optional(),
  duplicate_ack: DuplicateAck.optional(),
})

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
      projectCard(i, {
        now,
        position_id: position.position_id,
        // WP66：翻的是**这个品牌**的订单 / 客户（没装多品牌就退回 `label`）
        label: (r) => w.labelFor?.(actor, r) ?? w.label(r),
      }),
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
          '首页（37 §3 第三稿）：目标进度 + 今天（时间轴 / 到期清单）+ 卡片 deck（筛选 + 合并）+ 告警 + 核心数据条 + 今日战报 + 复盘',
        tag: 'workstation',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [RANGE_PARAM, ...FILTER_PARAMS],
        returns:
          '{ queue, alerts, tiles, digest?, estimated_minutes, range, filters, counts, pinned_p0, battle_report, goals?, today?, review?, plan? }',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        const w = workstationOf(deps)
        const actor: WorkstationActor = { workspace_id: p.workspace_id, person_id: p.person_id }
        const range = rangeOf(c)
        const filters = filtersOf(c)
        const positions = await w.positions(actor)
        const home: HomePosition[] = []
        let tz_offset_minutes = 0
        for (const position of positions) {
          const items = await w.items(actor, position)
          // 没有默认数字块的职责（common.member 之类）不出数据条，但它的卡照样进队列。
          const tile_ids = position.show_tiles ? position.tile_ids : []
          const query = await w.queryContext(actor, position, range)
          tz_offset_minutes = query.tz_offset_minutes
          home.push({
            position_id: position.position_id,
            role_id: position.role_id,
            role_name: position.role_name,
            items: [...items],
            tile_ids,
            range: position.range,
            query,
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
          const assembled = assembleHome({
            now: deps.clock.now(),
            positions: home,
            alerts: system.alerts,
            ...(system.digest === undefined ? {} : { digest: system.digest }),
            range,
            // 29 §2 enrichment：ObjectRef → 展示名，以本人身份查；查不到的 ref 在
            // 投影时就被丢掉，只在 detail.enrichment.dropped_refs 上留个数。
            label: (r) => w.labelFor?.(actor, r) ?? w.label(r),
          })
          // 筛选 → 合并 → 一次一张。计数按张数（合并前），P0 被筛掉时回带置顶。
          const filtered = filterCards(assembled.queue, filters)
          return ok(c, {
            ...assembled,
            queue: foldCards(filtered.cards),
            filters,
            counts: filtered.counts,
            pinned_p0: filtered.pinned_p0,
            battle_report: await todaysReport(deps, p.workspace_id, tz_offset_minutes),
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
        summary:
          '本人持有的岗位（= 未撤销的 Assignment）与其职责；装了岗位面时多带一份 54 §1 的岗位实体（instances）',
        tag: 'workstation',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'PositionSummary[]',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        const actor = { workspace_id: p.workspace_id, person_id: p.person_id }
        const positions = await workstationOf(deps).positions(actor)
        /*
         * WP69（54 §4）：**首页只列岗位卡，职责不出现**。
         *
         * 上面那份 `positions` 是"本人持有的每一条分配"——那是职责粒度的，首页照它列
         * 就会出现"店铺管理 / 内容与博客 / 邮件营销 / 订单履约"四张卡，而用户心里只有
         * 一个"网站运营"。所以这里多带一份按岗位聚合的：卡片计数、进行中事项、
         * 岗位层记忆一句话都在它上面。**只加字段**，老前端照旧读 `positions`。
         */
        const instances =
          deps.positions === undefined
            ? undefined
            : await deps.positions.mine({ ...actor, assignment_id: assignmentOf(c).id })
        return ok(c, {
          positions,
          ...(instances === undefined ? {} : { instances }),
          tile_library: TILE_LIBRARY,
          max_tiles: MAX_TILES_PER_POSITION,
        })
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/positions/:id/cards',
        operationId: 'getPositionCards',
        summary: '岗位的卡片 Tab（只这个岗位的队列；同一套筛选与合并）',
        tag: 'workstation',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [
          { name: 'id', in: 'path', required: true, description: 'position_id = assignment_id' },
          ...FILTER_PARAMS,
        ],
        returns: '{ position, cards, filters, counts, pinned_p0 }',
      },
      async (c, deps) => {
        const p = principalOf(c)
        const actor: WorkstationActor = { workspace_id: p.workspace_id, person_id: p.person_id }
        const position = await positionOf(c, deps, actor)
        // 岗位页天生只看这一个岗位；query 里再传 position_id 也不许换成别的（31 §3.1）。
        const filters: DeckFilters = { ...filtersOf(c), position_id: position.position_id }
        const filtered = filterCards(await cardsOf(deps, actor, position), filters)
        return ok(c, {
          position,
          cards: foldCards(filtered.cards),
          filters,
          counts: filtered.counts,
          pinned_p0: filtered.pinned_p0,
        })
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/positions/:id/summary',
        operationId: 'getPositionSummary',
        summary: '岗位页三个 Tab 各自的计数（首屏一发请求就够，不用三条各拉一遍）',
        tag: 'workstation',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [
          { name: 'id', in: 'path', required: true, description: 'position_id = assignment_id' },
          RANGE_PARAM,
        ],
        returns: '{ position, range, counts, sections }',
      },
      async (c, deps) => {
        const p = principalOf(c)
        const actor: WorkstationActor = { workspace_id: p.workspace_id, person_id: p.person_id }
        const position = await positionOf(c, deps, actor)
        const range = rangeOf(c)
        const w = workstationOf(deps)
        // 三个 Tab 读的是同一份 QueryContext（29 原则 ③：数都在服务端算）——
        // 这条路由存在的全部理由就是「只算一次」。
        const ctx = await w.queryContext(actor, position, range)
        const cards = await cardsOf(deps, actor, position)
        const filtered = filterCards(cards, { position_id: position.position_id })
        const sections = assembleView(position.role_id as RoleId, ctx)
          .map((s) => ({
            source: s.source,
            connected: s.connected,
            blocks: s.blocks.filter((b: BlockDef) => allowed(deps, position.position_id, b.source))
              .length,
          }))
          .filter((s) => s.blocks > 0)
        let records = 0
        try {
          const data = computeBlock('records.timeline', ctx, range) as {
            payload?: { rows?: unknown[] }
          }
          records = Array.isArray(data.payload?.rows) ? data.payload.rows.length : 0
        } catch (err) {
          // 记录 Tab 的块算不出来不该让整张摘要 500：这个计数留 0，其余照给
          if (!(err instanceof DeckError)) throw err
        }
        return ok(c, {
          position,
          range,
          counts: {
            cards: filtered.counts.total,
            folded: foldCards(filtered.cards).length,
            pinned_p0: filtered.pinned_p0.length,
            customer_waiting: filtered.counts.customer_waiting,
            nobody_waiting: filtered.counts.nobody_waiting,
            sections: sections.length,
            blocks: sections.reduce((n, s) => n + s.blocks, 0),
            records,
          },
          sections,
        })
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
        method: 'post',
        path: '/v1/blocks/propose',
        operationId: 'proposeBlock',
        summary: '对话定制卡：把一个积木钉成自己的卡（29 §4）；建之前先查',
        tag: 'workstation',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        body: ProposeBlockBody,
        returns: 'CustomCard',
      },
      async (c, deps) => {
        const p = principalOf(c)
        const assignment = assignmentOf(c)
        const input = await body(c, ProposeBlockBody)
        // 29 原则 ①：组件与查询只能来自注册表；未注册的积木 id 一律拒
        let source: keyof typeof SOURCE_AUTHZ
        let def: BlockDef
        try {
          def = blockDef(input.block_id)
          source = queryDef(def.query).source
        } catch (err) {
          return fromDeckError(err)
        }
        // 29 §2：查询以本人身份执行，无权的数据源连卡都不给定制
        assertQueryAllowed(deps, assignment.id, source)
        const title = input.title ?? def.title
        // 40 §2.2：定制卡也走"建之前先查"——同一个积木上钉两张一样的卡最常见
        const guard = await guardSimilar(deps, {
          workspace_id: p.workspace_id,
          kind: 'custom_card',
          title,
          target: `block:${input.block_id}`,
          ...(input.duplicate_ack === undefined ? {} : { ack: input.duplicate_ack }),
        })
        const card = {
          id: `card_${assignment.id}_${input.block_id}`,
          placement: def.placement,
          component: def.component,
          query: { name: def.query, params: {} },
          pinnable: true,
          adaptive: false,
          source: 'user' as const,
          owner: p.person_id,
          created_from: {
            conversation_id: input.conversation_id,
            ...(input.message_ref === undefined ? {} : { message_ref: input.message_ref }),
          },
        }
        // 定制卡在别处没有一张自己的表：目录替它保管一份（工具箱上看得见、下次查得到）
        await deps.catalog?.record?.({
          kind: 'custom_card',
          id: `custom_card:${card.id}`,
          title,
          summary: `对话里定制的卡：${def.title}`,
          owner: p.person_id,
          layer: 'personal',
          used_by_positions: [assignment.id],
          runs_30d: 0,
          created_from: card.created_from,
          target: `block:${input.block_id}`,
          workspace_id: p.workspace_id,
          created_at: deps.clock.now(),
        })
        await recordCatalogNote(deps, {
          workspace_id: p.workspace_id,
          entry_id: `custom_card:${card.id}`,
          guard,
        })
        return ok(c, card, 201)
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
