/**
 * WP337（Luoye 10-15）：点「重启并更新」时还有任务在做——问一句、暂停全部、新版起来接着做。
 *
 * | 路由 | 是什么 | 谁能用 |
 * |---|---|---|
 * | `GET /v1/update/readiness` | 正在做什么：正在输出 / 后台作业 / 定时任务各几件、每件一句话；空闲没有；暂停着没有 | 读策略层的人（owner / 管理员） |
 * | `POST /v1/update/pause` | 暂停全部：正在输出的在安全点停下、后台与定时挂起，落盘（新版开机读回、接着做） | 改策略层的人 |
 * | `POST /v1/update/resume` | 没重启成：在这个进程里放开、接着做 | 改策略层的人 |
 *
 * 谁读它：桌面壳。重启会把**所有品牌**的事一起打断，所以跨品牌数、跨品牌列——只给能看全公司策略层的人。
 * 新版开机时的「接着做」在服务进程里自己做（不经这条路由）。
 */
import type { MaybePromise } from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { body, ok } from '../helpers.js'
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

/** 三类：正在输出的对话运行 / 后台作业 / 定时（自动化）任务。 */
export type UpdateBusyKind = 'output' | 'background' | 'scheduled'

export interface UpdateBusyItem {
  kind: UpdateBusyKind
  /** 一句话（事项名 / 任务名）。 */
  title: string
}

export interface UpdateBusyCounts {
  output: number
  background: number
  scheduled: number
}

export interface UpdateResumeSummary {
  at: string
  /** 接着做的运行 / 没接上的。 */
  runs: number
  failed: number
  /** 被打断、补跑一次的后台 / 定时。 */
  reran: number
  /** 暂停期间错过、补跑一次的定时。 */
  caught_up: number
}

export interface UpdateReadinessView {
  /** 没有正在输出的运行（「空闲时重启」看它）。 */
  idle: boolean
  /** 已经因为更新暂停着。 */
  paused: boolean
  counts: UpdateBusyCounts
  items: UpdateBusyItem[]
  /** 这次开机接着做了什么（上一版暂停过才有）。 */
  last_resume?: UpdateResumeSummary
}

export interface UpdatePausePort {
  readiness(): MaybePromise<UpdateReadinessView>
  pause(input: { to?: string }): Promise<{ paused: UpdateBusyCounts }>
  resume(): Promise<UpdateResumeSummary>
}

const PauseBody = z.object({
  /** 要更新到哪一版（只进记录与日志）。 */
  to: z.string().min(1).max(64).optional(),
})

function portOf(deps: GatewayDeps): UpdatePausePort {
  if (deps.updatePause === undefined)
    throw new ApiError('not_implemented', '这台部署没有装配「更新前暂停」')
  return deps.updatePause
}

export function updatePauseRoutes(): Route[] {
  const spec = {
    tag: 'settings',
    auth: 'bearer',
    assignment: true,
  } as const
  return [
    route(
      {
        ...spec,
        method: 'get',
        path: '/v1/update/readiness',
        operationId: 'getUpdateReadiness',
        summary: 'WP337：重启并更新前看一眼——正在输出 / 后台 / 定时各几件、每件一句话',
        authz: READ,
        returns: 'UpdateReadinessView',
      },
      async (c, deps) => ok(c, await portOf(deps).readiness()),
    ),
    route(
      {
        ...spec,
        method: 'post',
        path: '/v1/update/pause',
        operationId: 'pauseForUpdate',
        summary: 'WP337：因更新暂停全部（落盘；新版开机自动接着做）',
        authz: WRITE,
        body: PauseBody,
        returns: '{ paused: UpdateBusyCounts }',
      },
      async (c, deps) => {
        const input = await body(c, PauseBody)
        return ok(c, await portOf(deps).pause(input.to === undefined ? {} : { to: input.to }))
      },
    ),
    route(
      {
        ...spec,
        method: 'post',
        path: '/v1/update/resume',
        operationId: 'resumeAfterUpdatePause',
        summary: 'WP337：没重启成——放开暂停的、接着做',
        authz: WRITE,
        returns: 'UpdateResumeSummary',
      },
      async (c, deps) => ok(c, await portOf(deps).resume()),
    ),
  ]
}
