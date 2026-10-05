/**
 * WP236：运行时长线（「设置 → 通用」）——空闲多久算卡死、一次最多跑多久。
 *
 * - `GET /v1/settings/run-limits`：现在的两个数（秒）。
 * - `PUT /v1/settings/run-limits`：改（空闲 1–30 分钟、总时长 5–120 分钟；空闲线不长过总时长）。
 *
 * 这台机器一份（与浏览器设置同理）。职责阈值 `run_idle_timeout_seconds` /
 * `run_max_duration_seconds` 比这里优先——研究类职责可以单独放长。
 */
import {
  type MaybePromise,
  RUN_IDLE_TIMEOUT_RANGE,
  RUN_MAX_DURATION_RANGE,
  type RunTimeLimits,
} from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { body, ok } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'

const READ = {
  domain: 'store_config',
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

export interface RunLimitsPort {
  get(): MaybePromise<RunTimeLimits>
  set(input: RunTimeLimits): MaybePromise<RunTimeLimits>
}

const LimitsBody = z.object({
  idle_timeout_seconds: z
    .number()
    .int()
    .min(RUN_IDLE_TIMEOUT_RANGE.min)
    .max(RUN_IDLE_TIMEOUT_RANGE.max),
  max_duration_seconds: z
    .number()
    .int()
    .min(RUN_MAX_DURATION_RANGE.min)
    .max(RUN_MAX_DURATION_RANGE.max),
})

function portOf(deps: GatewayDeps): RunLimitsPort {
  const p = deps.runLimits
  if (p === undefined)
    throw new ApiError(
      'not_implemented',
      '这个服务进程没有装配运行时长设置（GatewayDeps.runLimits）',
    )
  return p
}

export function runLimitsRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/settings/run-limits',
        operationId: 'getRunLimits',
        summary: 'WP236 运行时长线：连续多久没动静算卡死、一次最多跑多久（秒）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'RunTimeLimits',
      },
      async (c, deps) => ok(c, await portOf(deps).get()),
    ),
    route(
      {
        method: 'put',
        path: '/v1/settings/run-limits',
        operationId: 'putRunLimits',
        summary: 'WP236 改运行时长线（空闲 60–1800 秒，总时长 300–7200 秒）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: LimitsBody,
        returns: 'RunTimeLimits',
      },
      async (c, deps) => {
        const input = await body(c, LimitsBody)
        return ok(
          c,
          await portOf(deps).set({
            idle_timeout_seconds: input.idle_timeout_seconds,
            max_duration_seconds: input.max_duration_seconds,
          }),
        )
      },
    ),
  ]
}
