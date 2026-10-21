/**
 * WP438（WP434 设计第二阶段，决策 1332–1336）：**报表**的几条路由。
 *
 * - 看板那几行：`GET /v1/reports?position=web-ops[&duty=dtc.store]`（头条数 + 小走势）；
 * - 一整份：`GET /v1/reports/:id?range=30d`（打开时补最新：现算一份，到了重算的点就留一张快照）；
 * - 往回翻：`GET /v1/reports/:id/snapshots`、`GET /v1/reports/:id?at=<快照时间>`；
 * - 跟 AI 说想看什么：`POST /v1/reports/compose`（出一份小报表草稿）→ `POST /v1/reports/:id/pin`（固定）；
 *   报表页「问 AI」接着改：`POST /v1/reports/:id/revise`；拿掉：`DELETE /v1/reports/:id`；
 * - 首页关键数字与岗位卡的代表数：`GET /v1/reports/overview`。
 *
 * 纪律照岗位面板（29 / 36 §3）：数在服务端由 deck 的指标表算；**每份报表在本人那条职责的分配下算**，
 * 无权的数据源那几块直接不出（19 §3 过滤下推）；AI 只挑配方、起标题，数不经模型手。
 */
import { randomBytes } from 'node:crypto'
import {
  computeReport,
  DEFAULT_REPORTS,
  FALLBACK_RECIPE,
  matchRecipe,
  metricSpark,
  PINNED_REPORT_LIMIT,
  type QueryContext,
  REPORT_EXAMPLES,
  type ReportBlockSpec,
  type ReportData,
  type ReportRange,
  type ReportSpec,
  type ReportSummary,
  reportMetricDef,
  specFromRecipe,
  summarizeReport,
  validateReportSpec,
} from '@agentsws/deck'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { body, ok, param, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type {
  GatewayDeps,
  PositionSummary,
  ReportStorePort,
  SavedReport,
  WorkstationActor,
} from '../types.js'
import { sourceAllowed, workstationOf } from './workstation.js'

const READ = { domain: 'approval', op: 'read', range: 'own', sensitivity: 'internal' } as const
const RANGES: readonly ReportRange[] = ['1d', '7d', '30d', '90d']
const DAY = 86_400_000

function rangeOf(raw: string | undefined, fallback: ReportRange): ReportRange {
  if (raw === undefined || raw === '') return fallback
  if (!(RANGES as readonly string[]).includes(raw))
    throw new ApiError('invalid_input', 'range 只能是 1d / 7d / 30d / 90d')
  return raw as ReportRange
}

const actorOf = (c: Parameters<typeof principalOf>[0]): WorkstationActor => {
  const p = principalOf(c)
  return { workspace_id: p.workspace_id, person_id: p.person_id }
}

/** 本人这几条职责里，按规格给的顺序找第一条持有的（报表在它的分配下算）。 */
function holderOf(
  positions: PositionSummary[],
  roles: readonly string[],
): PositionSummary | undefined {
  for (const r of roles) {
    const hit = positions.find((p) => p.role_id === r)
    if (hit !== undefined) return hit
  }
  return undefined
}

/**
 * 无权的数据源那几块不出（KPI 条里那几格也拿掉）。一块都不剩的规格回 `undefined`。
 */
function restrict(spec: ReportSpec, allow: (source: string) => boolean): ReportSpec {
  const blocks = spec.blocks.flatMap((b): ReportBlockSpec[] => {
    if (b.kind === 'kpis') {
      const metrics = b.metrics.filter((k) => allow(reportMetricDef(k)?.source ?? ''))
      return metrics.length === 0 ? [] : [{ ...b, metrics }]
    }
    if (b.kind === 'trend') return allow(reportMetricDef(b.metric)?.source ?? '') ? [b] : []
    return [b]
  })
  return { ...spec, blocks }
}

function storeOf(deps: GatewayDeps): ReportStorePort | undefined {
  return deps.workstation?.reports
}

interface Located {
  spec: ReportSpec
  saved?: SavedReport
}

/** 默认报表 + 本人固定的 AI 报表（AI 的新的在前，默认的照表里顺序）。 */
async function specsFor(
  deps: GatewayDeps,
  actor: WorkstationActor,
  positions: PositionSummary[],
  filter: { position?: string; duty?: string },
): Promise<Located[]> {
  const saved = (await storeOf(deps)?.list(actor.workspace_id, actor.person_id)) ?? []
  const ai = saved
    .filter(
      (s) =>
        (filter.position === undefined || s.position === filter.position) &&
        (filter.duty === undefined || s.duty === filter.duty),
    )
    .sort((a, b) => b.pinned_at.localeCompare(a.pinned_at))
    .map((s) => ({ spec: s.spec, saved: s }))
  const defaults = DEFAULT_REPORTS.filter(
    (r) =>
      (filter.position === undefined || r.position === filter.position) &&
      (filter.duty === undefined || r.duties.includes(filter.duty)) &&
      holderOf(positions, r.compute_roles) !== undefined,
  ).map((spec) => ({ spec }))
  return [...ai, ...defaults].filter((x) => holderOf(positions, x.spec.compute_roles) !== undefined)
}

async function locate(
  deps: GatewayDeps,
  actor: WorkstationActor,
  id: string,
): Promise<Located | undefined> {
  const def = DEFAULT_REPORTS.find((r) => r.id === id)
  if (def !== undefined) return { spec: def }
  const store = storeOf(deps)
  const saved = await store?.get(actor.workspace_id, id)
  if (saved !== undefined && saved.person_id === actor.person_id) return { spec: saved.spec, saved }
  const draft = store?.draft(actor.workspace_id, id)
  return draft === undefined ? undefined : { spec: draft }
}

/** 在本人那条职责的分配下取上下文、按权限收窄规格。拿不到（没持有那几条职责）回 `undefined`。 */
async function contextFor(
  deps: GatewayDeps,
  actor: WorkstationActor,
  positions: PositionSummary[],
  spec: ReportSpec,
): Promise<{ ctx: QueryContext; spec: ReportSpec } | undefined> {
  const holder = holderOf(positions, spec.compute_roles)
  if (holder === undefined) return undefined
  const ctx = await workstationOf(deps).queryContext(actor, holder, 'last_7d')
  return {
    ctx,
    spec: restrict(spec, (source) => sourceAllowed(deps, holder.position_id, source)),
  }
}

/**
 * 决策 1336 甲：这份报表**最近一个该重算的点**（每天 06:00 / 每周一 06:00；「打开时」= 每次打开，至少隔一小时）。
 * 时间按工作区时区。快照早于这个点就再留一张。
 */
export function lastSlot(
  refresh: ReportSpec['refresh'],
  now: string,
  tz: number,
): number | undefined {
  const nowMs = Date.parse(now)
  if (refresh === 'on_open') return nowMs - 3_600_000
  const local = nowMs + tz * 60_000
  let slot = Math.floor(local / DAY) * DAY + 6 * 3_600_000
  if (slot > local) slot -= DAY
  if (refresh === 'weekly') {
    while (new Date(slot).getUTCDay() !== 1) slot -= DAY
  }
  return slot - tz * 60_000
}

async function remember(
  deps: GatewayDeps,
  actor: WorkstationActor,
  spec: ReportSpec,
  data: ReportData,
  tz: number,
): Promise<void> {
  const store = storeOf(deps)
  if (store === undefined || spec.id.startsWith('draft_')) return
  const slot = lastSlot(spec.refresh, data.computed_at, tz)
  if (slot === undefined) return
  const all = await store.snapshots(actor.workspace_id, spec.id)
  const latest = all
    .filter((s) => s.range === data.range)
    .map((s) => Date.parse(s.at))
    .sort((a, b) => b - a)[0]
  if (latest === undefined || latest < slot) await store.addSnapshot(actor.workspace_id, data)
}

const ComposeBody = z.object({
  prompt: z.string().trim().min(1).max(500),
  /** 在哪个岗位上说的（AI 预选固定到这里）。 */
  position: z.string().min(1).max(60).optional(),
  duty: z.string().min(1).max(80).optional(),
})

const PinBody = z.object({
  position: z.string().min(1).max(60),
  duty: z.string().min(1).max(80).optional(),
  refresh: z.enum(['daily', 'weekly', 'on_open']).default('daily'),
  title: z.string().trim().min(1).max(60).optional(),
})

const ReviseBody = z.object({ prompt: z.string().trim().min(1).max(500) })

const newId = (prefix: string): string => `${prefix}_${randomBytes(6).toString('hex')}`

/** 「读了…」那几行（对话里小报表上面）。数从上下文里数，不估。 */
function readsOf(recipe: { reads: readonly string[] }, ctx: QueryContext, days: number): string[] {
  const since = Date.parse(ctx.now) - days * DAY
  const out: string[] = []
  for (const r of recipe.reads) {
    if (r === 'orders')
      out.push(
        `读了店铺后台近 ${days} 天的 ${ctx.orders.filter((o) => Date.parse(o.created_at) >= since).length.toLocaleString('en-US')} 笔订单`,
      )
    if (r === 'campaigns')
      out.push(
        `读了工作队列里这段时间发出去的 ${
          ctx.approvals.filter(
            (i) =>
              i.state === 'applied' &&
              typeof i.payload === 'object' &&
              i.payload !== null &&
              /email|campaign|newsletter/.test(
                String((i.payload as { kind?: unknown }).kind ?? ''),
              ),
          ).length
        } 次邮件活动`,
      )
    if (r === 'gsc') out.push('读了 Search Console 最近一段的搜索词')
    if (r === 'ga4') out.push('读了 GA4 最近一段的汇总')
    if (r === 'mentions') out.push(`读了 ${ctx.pr?.mentions.length ?? 0} 条品牌提及`)
    if (r === 'drafts') out.push('读了工作队列里的回信与退款')
  }
  return out
}

export function reportRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/reports',
        operationId: 'listReports',
        summary:
          '看板「报表」卡：这个岗位 / 职责固定的报表（头条数 + 涨跌 + 近 30 天小走势；AI 做的在前）',
        tag: 'workstation',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [
          { name: 'position', in: 'query', description: '岗位模板 id（web-ops…）' },
          { name: 'duty', in: 'query', description: '职责层：只要固定在这条职责上的' },
        ],
        returns: '{ reports: ReportSummary[], limit, examples }',
      },
      async (c, deps) => {
        const actor = actorOf(c)
        const positions = await workstationOf(deps).positions(actor)
        const position = c.req.query('position') || undefined
        const duty = c.req.query('duty') || undefined
        const found = await specsFor(deps, actor, positions, {
          ...(position === undefined ? {} : { position }),
          ...(duty === undefined ? {} : { duty }),
        })
        const reports: ReportSummary[] = []
        for (const x of found) {
          const got = await contextFor(deps, actor, positions, x.spec)
          if (got === undefined) continue
          reports.push(summarizeReport(got.spec, got.ctx))
        }
        return ok(c, { reports, limit: PINNED_REPORT_LIMIT, examples: REPORT_EXAMPLES })
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/reports/overview',
        operationId: 'getReportsOverview',
        summary:
          '首页：关键数字（按开着的岗位挑、每岗位最多 1 个、优先有数的，最多 4 个）+ 一句话 + 缺连接那一行 + 各岗位代表数',
        tag: 'workstation',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [{ name: 'range', in: 'query', description: '1d（昨天，默认）/ 7d / 30d' }],
        returns: '{ range, key, sentence?, missing?, positions }',
      },
      async (c, deps) => {
        const actor = actorOf(c)
        const range = rangeOf(c.req.query('range'), '1d')
        const positions = await workstationOf(deps).positions(actor)
        const order = [...new Set(DEFAULT_REPORTS.map((r) => r.position))]
        const cards: {
          position: string
          report_id: string
          title: string
          headline_label: string
          headline: ReportSummary['headline']
          spark?: number[]
        }[] = []
        const key: {
          position: string
          report_id: string
          metric: ReportSummary['headline']
          spark?: number[]
        }[] = []
        let sentence: { text: string; report_id: string; title: string } | undefined
        let missing: { label: string; source: string; unlocks: string } | undefined
        for (const pos of order) {
          const first = DEFAULT_REPORTS.find(
            (r) => r.position === pos && holderOf(positions, r.compute_roles) !== undefined,
          )
          if (first === undefined) continue
          const got = await contextFor(deps, actor, positions, first)
          if (got === undefined) continue
          const summary = summarizeReport(got.spec, got.ctx)
          cards.push({
            position: pos,
            report_id: first.id,
            title: first.title,
            headline_label: summary.headline_label,
            headline: summary.headline,
            ...(summary.spark === undefined ? {} : { spark: summary.spark }),
          })
          // 关键数字：这一档时间窗下算一次 KPI 条；头条数没数就挑同一份里第一个有数的（每岗位最多 1 个）
          const data = computeReport(
            { ...got.spec, blocks: got.spec.blocks.filter((b) => b.kind === 'kpis') },
            got.ctx,
            range,
          )
          const items =
            (data.blocks[0]?.payload as { items: ReportSummary['headline'][] } | undefined)
              ?.items ?? []
          const head = items.find((m) => m.key === first.headline)
          if (head?.status === 'not_connected')
            missing ??= {
              label: head.need?.label ?? head.source,
              source: head.source,
              unlocks: head.label,
            }
          const pick =
            head?.status === 'ok'
              ? head
              : items.find((m) => m.status === 'ok' && m.value !== undefined)
          if (pick === undefined) continue
          const spark = metricSpark(pick.key, got.ctx, 14)
          if (key.length < 4)
            key.push({
              position: pos,
              report_id: first.id,
              metric: pick,
              ...(spark === undefined ? {} : { spark }),
            })
          if (sentence === undefined && pick === head && data.conclusion !== undefined) {
            const word = range === '1d' ? '昨天' : range === '7d' ? '近 7 天' : '近 30 天'
            const line = (data.conclusion.lines[0] ?? '').replace('比前 1 天', '比前一天')
            sentence = { text: `${word}${line}`, report_id: first.id, title: first.title }
          }
        }
        return ok(c, {
          range,
          key,
          ...(sentence === undefined ? {} : { sentence }),
          ...(missing === undefined ? {} : { missing }),
          positions: cards,
        })
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/reports/:id',
        operationId: 'getReport',
        summary: '一整份报表：现算（打开时补最新），到了重算的点留一张快照；给 at = 看那一张快照',
        tag: 'workstation',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [
          { name: 'id', in: 'path', required: true, description: '报表 id' },
          { name: 'range', in: 'query', description: '7d / 30d / 90d（默认按报表自己的）' },
          { name: 'at', in: 'query', description: '快照时间（往回翻）' },
        ],
        returns: 'ReportData & { snapshot?: true }',
      },
      async (c, deps) => {
        const actor = actorOf(c)
        const id = param(c, 'id')
        const found = await locate(deps, actor, id)
        if (found === undefined) throw new ApiError('not_found', `没有这份报表：${id}`)
        const at = c.req.query('at')
        if (at !== undefined && at !== '') {
          const snap = await storeOf(deps)?.snapshot(actor.workspace_id, id, at)
          if (snap === undefined) throw new ApiError('not_found', '没有这一张快照')
          return ok(c, { ...snap, snapshot: true })
        }
        const range = rangeOf(c.req.query('range'), found.spec.default_range)
        const positions = await workstationOf(deps).positions(actor)
        const got = await contextFor(deps, actor, positions, found.spec)
        if (got === undefined) throw new ApiError('forbidden', '这份报表要的职责你没有')
        const data = computeReport(got.spec, got.ctx, range)
        await remember(deps, actor, got.spec, data, got.ctx.tz_offset_minutes)
        return ok(c, data)
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/reports/:id/snapshots',
        operationId: 'listReportSnapshots',
        summary: '这份报表留过的快照（新的在前）',
        tag: 'workstation',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [{ name: 'id', in: 'path', required: true, description: '报表 id' }],
        returns: '{ snapshots: { at, range }[] }',
      },
      async (c, deps) => {
        const actor = actorOf(c)
        const id = param(c, 'id')
        if ((await locate(deps, actor, id)) === undefined)
          throw new ApiError('not_found', `没有这份报表：${id}`)
        const all = (await storeOf(deps)?.snapshots(actor.workspace_id, id)) ?? []
        return ok(c, { snapshots: [...all].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 60) })
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/reports/compose',
        operationId: 'composeReport',
        summary:
          '跟 AI 说想看什么：认出配方 → 出一份小报表草稿（3 个数 + 1 张图）、读了哪些数、预选固定到哪与多久更新',
        tag: 'workstation',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        body: ComposeBody,
        returns: '{ draft: ReportData, spec, reads, answer, matched, suggest }',
      },
      async (c, deps) => {
        const actor = actorOf(c)
        const input = await body(c, ComposeBody)
        const recipe = matchRecipe(input.prompt)
        const used = recipe ?? FALLBACK_RECIPE
        const position =
          recipe === undefined && input.position !== undefined ? input.position : used.position
        const spec = specFromRecipe(used, {
          id: newId('draft'),
          prompt: input.prompt,
          at: new Date(Date.parse(deps.clock.now())).toISOString(),
          position,
          ...(input.duty !== undefined && recipe === undefined ? { duty: input.duty } : {}),
        })
        const problems = validateReportSpec(spec)
        if (problems.length > 0) throw new ApiError('invalid_input', problems.join('；'))
        const positions = await workstationOf(deps).positions(actor)
        const got = await contextFor(deps, actor, positions, spec)
        if (got === undefined)
          throw new ApiError('forbidden', '这一份要看的数，你手上的职责都读不到')
        storeOf(deps)?.putDraft(actor.workspace_id, spec)
        const draft = computeReport(got.spec, got.ctx, spec.default_range)
        const first = draft.conclusion?.lines[0]
        const answer =
          recipe === undefined
            ? `没认出要看哪一类，先按经营概览出了一份${first === undefined ? '' : `：${first}`}`
            : (first ?? '这一段还没有能算的数，先把要的数据源连上。')
        return ok(c, {
          draft,
          spec,
          reads: readsOf(used, got.ctx, 30),
          answer,
          matched: recipe !== undefined,
          suggest: {
            position: spec.position,
            ...(spec.duties[0] === undefined ? {} : { duty: spec.duties[0] }),
            refresh: spec.refresh,
          },
        })
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/reports/:id/pin',
        operationId: 'pinReport',
        summary: '把对话里那份小报表固定到面板（活的：存规格，按频率重算、留快照）',
        tag: 'workstation',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [{ name: 'id', in: 'path', required: true, description: '草稿 id' }],
        body: PinBody,
        returns: 'ReportSummary',
      },
      async (c, deps) => {
        const actor = actorOf(c)
        const store = storeOf(deps)
        if (store === undefined)
          throw new ApiError('not_implemented', '这个服务进程没有装报表存放处')
        const id = param(c, 'id')
        const input = await body(c, PinBody)
        const draft = store.draft(actor.workspace_id, id)
        if (draft === undefined) throw new ApiError('not_found', '这份草稿找不到了，再说一次')
        const spec: ReportSpec = {
          ...draft,
          id: newId('rpt'),
          position: input.position,
          duties: input.duty === undefined ? [] : [input.duty],
          refresh: input.refresh,
          ...(input.title === undefined ? {} : { title: input.title }),
        }
        const saved: SavedReport = {
          workspace_id: actor.workspace_id,
          person_id: actor.person_id,
          spec,
          position: input.position,
          ...(input.duty === undefined ? {} : { duty: input.duty }),
          pinned_at: deps.clock.now(),
          version: 1,
        }
        await store.save(saved)
        const positions = await workstationOf(deps).positions(actor)
        const got = await contextFor(deps, actor, positions, spec)
        if (got === undefined) throw new ApiError('forbidden', '这份报表要的职责你没有')
        const data = computeReport(got.spec, got.ctx, spec.default_range)
        await remember(deps, actor, spec, data, got.ctx.tz_offset_minutes)
        return ok(c, summarizeReport(got.spec, got.ctx), 201)
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/reports/:id/revise',
        operationId: 'reviseReport',
        summary: '报表页「问 AI」接着改：认出要加的那一块并进这份报表（新版本）；认不出照实说',
        tag: 'workstation',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [{ name: 'id', in: 'path', required: true, description: '报表 id（AI 做的那种）' }],
        body: ReviseBody,
        returns: '{ changed, answer, report? }',
      },
      async (c, deps) => {
        const actor = actorOf(c)
        const id = param(c, 'id')
        const input = await body(c, ReviseBody)
        const store = storeOf(deps)
        const saved = await store?.get(actor.workspace_id, id)
        if (store === undefined || saved === undefined || saved.person_id !== actor.person_id)
          throw new ApiError('not_found', '默认报表不能在这里改；说一句做一份新的')
        const recipe = matchRecipe(input.prompt)
        if (recipe === undefined)
          return ok(c, {
            changed: false,
            answer: '没认出要加哪一块，换个说法试试（比如「加一块：分新老客」）',
          })
        const have = new Set(saved.spec.blocks.map((b) => ('dataset' in b ? b.dataset : b.id)))
        const key = 'dataset' in recipe.chart ? recipe.chart.dataset : recipe.chart.id
        if (have.has(key))
          return ok(c, {
            changed: false,
            answer: `「${recipe.chart.title ?? recipe.title}」已经在这份里了`,
          })
        const spec: ReportSpec = {
          ...saved.spec,
          blocks: [
            ...saved.spec.blocks,
            { ...recipe.chart, id: `${recipe.id}-${saved.version + 1}`, wide: false },
          ],
        }
        await store.save({ ...saved, spec, version: saved.version + 1 })
        return ok(c, {
          changed: true,
          answer: `加了一块「${recipe.chart.title ?? recipe.title}」`,
          version: saved.version + 1,
        })
      },
    ),
    route(
      {
        method: 'delete',
        path: '/v1/reports/:id',
        operationId: 'unpinReport',
        summary: '从面板拿掉一份 AI 做的报表（默认报表拿不掉）',
        tag: 'workstation',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [{ name: 'id', in: 'path', required: true, description: '报表 id' }],
        returns: '{ removed: true }',
      },
      async (c, deps) => {
        const actor = actorOf(c)
        const id = param(c, 'id')
        const store = storeOf(deps)
        const saved = await store?.get(actor.workspace_id, id)
        if (store === undefined || saved === undefined || saved.person_id !== actor.person_id)
          throw new ApiError('not_found', `没有这份报表：${id}`)
        await store.remove(actor.workspace_id, id)
        return ok(c, { removed: true })
      },
    ),
  ]
}
