/**
 * WP330（docs/102 附：甲方周报要求）：**Reddit 周报** `/v1/reddit-weekly/*`。
 *
 * | 路由 | 是什么 |
 * |---|---|
 * | `GET /v1/reddit-weekly` | 存着的某一周（`?week_of=`，不给 = 最近一份） |
 * | `GET /v1/reddit-weekly/preview` | 现在拼一份（不巡查、不出卡、不存） |
 * | `POST /v1/reddit-weekly/run` | 现在出一份（先巡查一次、出卡、记录去处；同一周 = 同一张的新一版） |
 * | `GET /v1/reddit-weekly/export` | 导出文档（Markdown，`{ filename, content }`） |
 * | `GET` / `PUT /v1/reddit-weekly/format` | 分节与措辞（PUT 只给要改的；`reset: true` 先回默认） |
 * | `GET` / `PUT /v1/reddit-weekly/schedule` | 每周几、几点出（默认周五 17:00） |
 *
 * 分节与措辞平常由用户几句话交代、AI 用工具改（`set_reddit_weekly_format`）；这里的 PUT 是同一条路的 HTTP 口。
 * 逻辑在 `apps/server/src/reddit-weekly.ts`。
 */
import type {
  MaybePromise,
  RedditWeeklyFormat,
  RedditWeeklyPayload,
  WeeklyReviewScheduleView,
} from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { body, ok, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'

const READ = { domain: 'approval', op: 'read', range: 'own', sensitivity: 'internal' } as const
const WRITE = {
  domain: 'policy',
  op: 'stage',
  range: 'workspace',
  sensitivity: 'internal',
} as const
const TAG = 'reddit-weekly'

export interface RedditWeeklyActor {
  workspace_id: string
  person_id: string
}

export interface RedditWeeklyRunView {
  approval_item_id?: string
  week_of?: string
  /** 没出的理由（没人担 Reddit 运营 / 没配巡查）。 */
  skipped?: string
  recorded?: boolean
  sweep_failed?: string
}

export interface RedditWeeklyPort {
  report(actor: RedditWeeklyActor, week_of?: string): MaybePromise<RedditWeeklyPayload | null>
  preview(actor: RedditWeeklyActor): MaybePromise<RedditWeeklyPayload | null>
  run(actor: RedditWeeklyActor): MaybePromise<RedditWeeklyRunView>
  export(
    actor: RedditWeeklyActor,
    week_of?: string,
  ): MaybePromise<{ filename: string; content: string } | null>
  format(actor: RedditWeeklyActor): MaybePromise<RedditWeeklyFormat>
  setFormat(
    actor: RedditWeeklyActor,
    input: { patch: Record<string, unknown>; reset?: boolean },
  ): MaybePromise<{ format: RedditWeeklyFormat; problems: string[] }>
  schedule(actor: RedditWeeklyActor): MaybePromise<WeeklyReviewScheduleView>
  setSchedule(
    actor: RedditWeeklyActor,
    input: { weekday: number; time: string },
  ): MaybePromise<WeeklyReviewScheduleView>
}

function portOf(deps: GatewayDeps): RedditWeeklyPort {
  const p = deps.redditWeekly
  if (p === undefined)
    throw new ApiError(
      'not_implemented',
      '这个服务进程没有装配 Reddit 周报（GatewayDeps.redditWeekly）',
    )
  return p
}

function actorOf(c: Parameters<typeof principalOf>[0]): RedditWeeklyActor {
  const p = principalOf(c)
  return { workspace_id: p.workspace_id, person_id: p.person_id }
}

const weekOf = (c: Parameters<typeof principalOf>[0]): string | undefined => {
  const v = c.req.query('week_of')?.trim()
  if (v === undefined || v === '') return undefined
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new ApiError('invalid_input', 'week_of 写成 YYYY-MM-DD')
  return v
}

const WEEK_PARAM = [
  { name: 'week_of', in: 'query' as const, required: false, description: '哪一周（窗口起始那天）' },
]

const FormatBody = z.object({
  patch: z.record(z.string(), z.unknown()),
  reset: z.boolean().optional(),
})
const ScheduleBody = z.object({
  weekday: z.number().int().min(0).max(6),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, '时间写成 HH:MM（24 小时）'),
})

export function redditWeeklyRoutes(): Route[] {
  const base = { tag: TAG, auth: 'bearer' as const, assignment: true }
  return [
    route(
      {
        ...base,
        method: 'get',
        path: '/v1/reddit-weekly',
        operationId: 'getRedditWeekly',
        summary: '存着的 Reddit 周报（不给 week_of = 最近一份；没有 = null）',
        authz: READ,
        params: WEEK_PARAM,
        returns: 'RedditWeeklyPayload | null',
      },
      async (c, deps) => ok(c, await portOf(deps).report(actorOf(c), weekOf(c))),
    ),
    route(
      {
        ...base,
        method: 'get',
        path: '/v1/reddit-weekly/preview',
        operationId: 'previewRedditWeekly',
        summary: '现在拼一份 Reddit 周报（不巡查、不出卡、不存；没配巡查 = null）',
        authz: READ,
        returns: 'RedditWeeklyPayload | null',
      },
      async (c, deps) => ok(c, await portOf(deps).preview(actorOf(c))),
    ),
    route(
      {
        ...base,
        method: 'post',
        path: '/v1/reddit-weekly/run',
        operationId: 'runRedditWeekly',
        summary: '现在出一份 Reddit 周报（先巡查一次；同一周再出 = 同一张卡的新一版）',
        authz: READ,
        returns: 'RedditWeeklyRunView',
      },
      async (c, deps) => ok(c, await portOf(deps).run(actorOf(c))),
    ),
    route(
      {
        ...base,
        method: 'get',
        path: '/v1/reddit-weekly/export',
        operationId: 'exportRedditWeekly',
        summary: '导出 Reddit 周报（Markdown；飞书 / Notion / Google 文档都能直接贴）',
        authz: READ,
        params: WEEK_PARAM,
        returns: '{ filename: string; content: string } | null',
      },
      async (c, deps) => ok(c, await portOf(deps).export(actorOf(c), weekOf(c))),
    ),
    route(
      {
        ...base,
        method: 'get',
        path: '/v1/reddit-weekly/format',
        operationId: 'getRedditWeeklyFormat',
        summary: 'Reddit 周报的分节与措辞（这个品牌的；没改过 = 默认）',
        authz: READ,
        returns: 'RedditWeeklyFormat',
      },
      async (c, deps) => ok(c, await portOf(deps).format(actorOf(c))),
    ),
    route(
      {
        ...base,
        method: 'put',
        path: '/v1/reddit-weekly/format',
        operationId: 'setRedditWeeklyFormat',
        summary: '改 Reddit 周报的分节与措辞（只给要改的；reset 先回默认；认不出的照实回）',
        authz: WRITE,
        body: FormatBody,
        returns: '{ format: RedditWeeklyFormat; problems: string[] }',
      },
      async (c, deps) => {
        const input = await body(c, FormatBody)
        return ok(
          c,
          await portOf(deps).setFormat(actorOf(c), {
            patch: input.patch,
            ...(input.reset === undefined ? {} : { reset: input.reset }),
          }),
        )
      },
    ),
    route(
      {
        ...base,
        method: 'get',
        path: '/v1/reddit-weekly/schedule',
        operationId: 'getRedditWeeklySchedule',
        summary: 'Reddit 周报每周几、几点出（工作区时区；默认周五 17:00）',
        authz: READ,
        returns: 'WeeklyReviewScheduleView',
      },
      async (c, deps) => ok(c, await portOf(deps).schedule(actorOf(c))),
    ),
    route(
      {
        ...base,
        method: 'put',
        path: '/v1/reddit-weekly/schedule',
        operationId: 'setRedditWeeklySchedule',
        summary: '改 Reddit 周报每周几、几点出（只改这个品牌那一条定时）',
        authz: WRITE,
        body: ScheduleBody,
        returns: 'WeeklyReviewScheduleView',
      },
      async (c, deps) => {
        const input = await body(c, ScheduleBody)
        return ok(c, await portOf(deps).setSchedule(actorOf(c), input))
      },
    ),
  ]
}
