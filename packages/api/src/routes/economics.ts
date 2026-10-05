/**
 * WP224（docs/91 §2.2 #1 / #3）：**单位经济与经营一页纸**的 HTTP 投影。
 *
 * | 路由 | 是什么 | 谁能用 |
 * |---|---|---|
 * | `GET /v1/economics/margins` | 这个品牌的毛利率（品牌一格 + 按品类 / SKU 覆盖） | 读策略层的人（负责人） |
 * | `PUT /v1/economics/margins` | 填 / 改 / 清一格（就是一张事实卡；清 = 退役，留痕不删） | 改策略层的人（负责人） |
 * | `GET /v1/economics/line-compare` | 两条止损线逐日对照（现在的线 vs 盈亏线），两周后给人定 | 读策略层的人 |
 * | `GET /v1/economics/weekly-review` | 现在拼一份本周经营一页纸（只看，不出卡） | 读策略层的人 |
 * | `GET` / `PUT /v1/economics/weekly-review/schedule` | 一页纸每周几、几点推（设置里那一行） | 读 / 改策略层的人 |
 * | `POST /v1/economics/weekly-review/run` | 现在就推一张一页纸卡（同一周再推一次 = 同一张的新一版） | 读策略层的人 |
 *
 * 自动止损线（`stop_loss_roas_below`）这一组路由一个都不碰：盈亏线只并排显示（Luoye 10-05）。
 */
import type {
  AdsLineCompareView,
  GrossMarginInput,
  GrossMarginsView,
  MaybePromise,
  WeeklyReviewPayload,
  WeeklyReviewScheduleView,
} from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { assignmentOf, body, ok, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'

const READ = {
  domain: 'policy',
  op: 'read',
  range: 'workspace',
  sensitivity: 'internal',
} as const

const WRITE = {
  domain: 'policy',
  op: 'stage',
  range: 'workspace',
  sensitivity: 'restricted',
} as const

const TAG = 'economics'

export interface EconomicsActor {
  workspace_id: string
  person_id: string
  assignment_id: string
  role_id: string
}

export interface WeeklyReviewRunView {
  approval_item_id?: string
  /** 没出卡的理由（没有老板岗位 / 面板读不到）。 */
  skipped?: string
  week_of?: string
}

export interface EconomicsPort {
  margins(actor: EconomicsActor): MaybePromise<GrossMarginsView>
  saveMargin(actor: EconomicsActor, input: GrossMarginInput): MaybePromise<GrossMarginsView>
  lineCompare(actor: EconomicsActor): MaybePromise<AdsLineCompareView>
  /** 没有老板岗位 / 面板读不到 = `null`。 */
  weeklyReview(actor: EconomicsActor): MaybePromise<WeeklyReviewPayload | null>
  runWeeklyReview(actor: EconomicsActor): MaybePromise<WeeklyReviewRunView>
  /** 一页纸每周几、几点推（设置里那一行）。 */
  weeklyReviewSchedule(actor: EconomicsActor): MaybePromise<WeeklyReviewScheduleView>
  setWeeklyReviewSchedule(
    actor: EconomicsActor,
    input: { weekday: number; time: string },
  ): MaybePromise<WeeklyReviewScheduleView>
}

const ScheduleBody = z.object({
  weekday: z.number().int().min(0).max(6),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, '时间写成 HH:MM（24 小时）'),
})

const MarginBody = z.object({
  scope: z.enum(['brand', 'category', 'sku']),
  key: z.string().trim().min(1).max(120).optional(),
  // null = 清掉这一格
  margin_pct: z.number().gt(0).max(100).nullable(),
})

function portOf(deps: GatewayDeps): EconomicsPort {
  const p = deps.economics
  if (p === undefined)
    throw new ApiError('not_implemented', '这个服务进程没有装配单位经济（GatewayDeps.economics）')
  return p
}

function actorOf(c: Parameters<typeof principalOf>[0]): EconomicsActor {
  const p = principalOf(c)
  const a = assignmentOf(c)
  return {
    workspace_id: p.workspace_id,
    person_id: p.person_id,
    assignment_id: a.id,
    role_id: a.role_id,
  }
}

export function economicsRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/economics/margins',
        operationId: 'getGrossMargins',
        summary: '这个品牌的毛利率（品牌一格 + 按品类 / SKU 覆盖；没填就是没填）（WP224）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'GrossMarginsView',
      },
      async (c, deps) => ok(c, await portOf(deps).margins(actorOf(c))),
    ),
    route(
      {
        method: 'put',
        path: '/v1/economics/margins',
        operationId: 'saveGrossMargin',
        summary: '填 / 改 / 清一格毛利率（一张事实卡，负责人填的直接生效；清 = 退役，留痕不删）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: MarginBody,
        returns: 'GrossMarginsView',
      },
      async (c, deps) => {
        const input = await body(c, MarginBody)
        if (input.scope !== 'brand' && input.key === undefined)
          throw new ApiError('invalid_input', '按品类 / SKU 覆盖要写是哪个品类 / SKU')
        return ok(
          c,
          await portOf(deps).saveMargin(actorOf(c), {
            scope: input.scope,
            ...(input.key === undefined || input.scope === 'brand' ? {} : { key: input.key }),
            margin_pct: input.margin_pct,
          }),
        )
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/economics/line-compare',
        operationId: 'getStopLossLineCompare',
        summary: '两条止损线逐日对照（现在的固定线 vs 按毛利率算的盈亏线；只记账，不改止损）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'AdsLineCompareView',
      },
      async (c, deps) => ok(c, await portOf(deps).lineCompare(actorOf(c))),
    ),
    route(
      {
        method: 'get',
        path: '/v1/economics/weekly-review',
        operationId: 'previewWeeklyReview',
        summary: '现在拼一份本周经营一页纸（只看、不出卡；数字只从各岗位面板取，取不到写「没接」）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'WeeklyReviewPayload',
      },
      async (c, deps) => ok(c, await portOf(deps).weeklyReview(actorOf(c))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/economics/weekly-review/run',
        operationId: 'runWeeklyReview',
        summary: '现在就推一张本周经营一页纸（同一周再推 = 同一张出新一版，不会一周两张）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'WeeklyReviewRunView',
      },
      async (c, deps) => ok(c, await portOf(deps).runWeeklyReview(actorOf(c))),
    ),
    route(
      {
        method: 'get',
        path: '/v1/economics/weekly-review/schedule',
        operationId: 'getWeeklyReviewSchedule',
        summary: '一页纸每周几、几点推（工作区时区；默认周一 08:00）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'WeeklyReviewScheduleView',
      },
      async (c, deps) => ok(c, await portOf(deps).weeklyReviewSchedule(actorOf(c))),
    ),
    route(
      {
        method: 'put',
        path: '/v1/economics/weekly-review/schedule',
        operationId: 'setWeeklyReviewSchedule',
        summary: '改一页纸每周几、几点推（只改这个品牌那一条定时）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: ScheduleBody,
        returns: 'WeeklyReviewScheduleView',
      },
      async (c, deps) => {
        const input = await body(c, ScheduleBody)
        return ok(c, await portOf(deps).setWeeklyReviewSchedule(actorOf(c), input))
      },
    ),
  ]
}
