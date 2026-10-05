/**
 * WP225（WP218 决定 ③）：这台服务进程里**岗位 AI 正在干活**没有——一个只读、统一的信号。
 *
 * | 路由 | 是什么 | 谁能用 |
 * |---|---|---|
 * | `GET /v1/activity` | 正在跑的岗位 AI 运行有几次（这台服务进程装着的**所有**品牌，含后台定时任务起的） | 有岗位分配的人都能看 |
 *
 * 谁读它：桌面壳「重启并更新」之前问一句——有就先弹「有任务在跑，确定现在重启？」（重启会把所有品牌的
 * 运行一起打断，所以跨品牌数）。只回**数量**，不回事项名、不回内容：别的品牌的事不该从这条缝里露出来。
 */
import type { MaybePromise } from '@agentsws/contracts'
import { ApiError } from '../errors.js'
import { ok } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'

const READ = {
  domain: 'approval',
  op: 'read',
  range: 'own',
  sensitivity: 'internal',
} as const

export interface ActivityView {
  /** 有没有岗位 AI 正在干活（`runs > 0`）。 */
  busy: boolean
  /** 正在跑的运行次数（跨品牌）。 */
  runs: number
}

export interface ActivityPort {
  snapshot(): MaybePromise<ActivityView>
}

function portOf(deps: GatewayDeps): ActivityPort {
  if (deps.activity === undefined)
    throw new ApiError('not_implemented', '这台部署没有装配「正在干活」信号')
  return deps.activity
}

export function activityRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/activity',
        operationId: 'getActivity',
        summary: 'WP225：岗位 AI 正在干活没有（跨品牌，只回数量；桌面壳重启并更新前问它）',
        tag: 'work',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'ActivityView',
      },
      async (c, deps) => ok(c, await portOf(deps).snapshot()),
    ),
  ]
}
