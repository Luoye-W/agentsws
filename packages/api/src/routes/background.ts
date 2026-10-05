/**
 * WP215（52 §4 收口）：**每个品牌一套后台**的 HTTP 投影。
 *
 * 后台 = 这台电脑上的服务进程替每个品牌按时做的事（巡检、收信、每日计划 / 复盘、自动化任务、
 * 自建定时……）。它们按品牌常驻，与「眼前切在哪个品牌」无关；这一组路由只回答三件事：
 *
 * | 路由 | 是什么 | 谁能用 |
 * |---|---|---|
 * | `GET /v1/settings/background` | 每个品牌一行：在跑几条、最近一次、红点、停没停；全进程同时最多跑几件 | 读策略层的人（owner / 管理员） |
 * | `PUT /v1/settings/background` | 改「同时最多跑几件」（全进程一个数，不是每个品牌一个） | 改策略层的人 |
 * | `PUT /v1/settings/background/brands/:ws` | 只停 / 放开**这一个品牌**的后台（品牌急停）；全局急停照旧在 `/v1/halt` | 改策略层的人 |
 *
 * 品牌急停停的是这个品牌的：到点的定时任务、对外发送、模型调用。别的品牌一概不动。
 */
import type { MaybePromise } from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { body, ok, param, principalOf } from '../helpers.js'
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

const TAG = 'settings'

/** 「同时最多跑几件」的上下限（一台个人电脑；再多就是在跟人抢机器）。 */
export const BACKGROUND_CONCURRENCY_MIN = 1
export const BACKGROUND_CONCURRENCY_MAX = 4

export interface BackgroundActor {
  workspace_id: string
  person_id: string
}

/**
 * 一个品牌的后台状态（品牌切换器与组织页「品牌一览」那一格；36 第四档：图标 + 数字，
 * 细节进 tooltip）。
 */
export interface BrandBackgroundView {
  workspace_id: string
  /**
   * - `running`：照常在跑；
   * - `halted`：这个品牌按了急停（或全局急停），到点也不跑；
   * - `stopped`：品牌停用了，整套后台不跑。
   */
  state: 'running' | 'halted' | 'stopped'
  /** 在跑的定时任务条数（暂停的、等批的、跑完的不算）。 */
  scheduled: number
  /** 最近一次有任务跑起来的时刻（tooltip「最近一次巡检」）。 */
  last_run_at?: string
  /** 最近一条要跑的时刻。 */
  next_run_at?: string
  /** 上一次跑失败、还没跑好的条数（> 0 出红点）。 */
  errors: number
  /** 最近那条失败的标题与原因。 */
  last_error?: { task_id: string; title: string; message: string; at?: string }
  /** 这个品牌自己的急停开着没有。 */
  halted: boolean
  /** 全局急停开着没有（开着时所有品牌都停）。 */
  global_halted: boolean
}

/** 设置页那一张：每个品牌一行 + 全进程一个并发数。 */
export interface BackgroundSettingsView {
  /** 全进程同时最多跑几件（品牌之间并行，同一品牌永远一件接一件）。 */
  max_concurrent: number
  limits: { min: number; max: number }
  global_halted: boolean
  /** 本人有成员资格的那几个品牌。 */
  brands: (BrandBackgroundView & { name: string; current: boolean })[]
  /**
   * 后台跑在哪：现在只有「这台电脑」——关机、睡眠、断网时所有品牌都停。
   * 托管（云上常驻）按品牌订阅另议（52 O5）。
   */
  runs_on: 'this_device'
}

export interface BackgroundPort {
  settings(actor: BackgroundActor): MaybePromise<BackgroundSettingsView>
  setConcurrency(
    actor: BackgroundActor,
    max_concurrent: number,
  ): MaybePromise<BackgroundSettingsView>
  setBrandHalt(
    actor: BackgroundActor,
    workspace_id: string,
    input: { halted: boolean; reason?: string | undefined },
  ): MaybePromise<BrandBackgroundView>
}

const ConcurrencyBody = z.object({
  max_concurrent: z.number().int().min(BACKGROUND_CONCURRENCY_MIN).max(BACKGROUND_CONCURRENCY_MAX),
})

const BrandHaltBody = z.object({
  halted: z.boolean(),
  reason: z.string().max(200).optional(),
})

function portOf(deps: GatewayDeps): BackgroundPort {
  const p = deps.background
  if (p === undefined)
    throw new ApiError('not_implemented', '这个服务进程没有装配品牌后台（GatewayDeps.background）')
  return p
}

function actorOf(c: Parameters<typeof principalOf>[0]): BackgroundActor {
  const p = principalOf(c)
  return { workspace_id: p.workspace_id, person_id: p.person_id }
}

export function backgroundRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/settings/background',
        operationId: 'getBackgroundSettings',
        summary: '每个品牌的后台状态（在跑几条 / 最近一次 / 出错）与全进程并发上限（WP215）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'BackgroundSettingsView',
      },
      async (c, deps) => ok(c, await portOf(deps).settings(actorOf(c))),
    ),
    route(
      {
        method: 'put',
        path: '/v1/settings/background',
        operationId: 'setBackgroundSettings',
        summary: '改「同时最多跑几件」（全进程一个数；同一品牌永远一件接一件）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: ConcurrencyBody,
        returns: 'BackgroundSettingsView',
      },
      async (c, deps) => {
        const input = await body(c, ConcurrencyBody)
        return ok(c, await portOf(deps).setConcurrency(actorOf(c), input.max_concurrent))
      },
    ),
    route(
      {
        method: 'put',
        path: '/v1/settings/background/brands/:ws',
        operationId: 'setBrandBackgroundHalt',
        summary: '品牌急停：只停 / 放开这一个品牌的后台、对外发送与模型调用（全局急停在 /v1/halt）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        params: [{ name: 'ws', in: 'path', required: true, description: '品牌的 workspace_id' }],
        body: BrandHaltBody,
        returns: 'BrandBackgroundView',
      },
      async (c, deps) => {
        const input = await body(c, BrandHaltBody)
        return ok(
          c,
          await portOf(deps).setBrandHalt(actorOf(c), param(c, 'ws'), {
            halted: input.halted,
            ...(input.reason === undefined ? {} : { reason: input.reason }),
          }),
        )
      },
    ),
  ]
}
