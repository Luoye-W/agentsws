/**
 * 28 §1「急停一个变量」的**运行期**入口（13 §5：桌面壳托盘的「暂停」）。
 *
 * 在这条路由之前，急停只能靠启动时的环境变量——桌面壳只好写 `halt.json` 再重启 sidecar。
 * 现在它可以直接调这里；内核那边认 `AGENTSWS_HALT_FILE`，改完写回同一个文件，
 * 所以「按下暂停」与「重启后仍然是停的」是同一份真源。
 *
 * 两条纪律：
 * - **只有 owner 能改**（策略层写权限；`halt` 是全工作区的开关，不是岗位的）；
 * - 这条路由**不受 `all` 急停拦截**——否则停下来就再也解不开了（`/v1/health` 同理）。
 */
import type { HaltScope } from '@agentsws/contracts'
import { z } from 'zod'
import { assignmentOf, body, ok, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'

export const HALT_SCOPES: readonly HaltScope[] = ['all', 'model', 'outbound', 'learning']

const HaltBody = z.object({
  scope: z.enum(['all', 'model', 'outbound', 'learning']),
  on: z.boolean(),
  reason: z.string().max(200).optional(),
})

/** 只有能写工作区策略层的人能按急停（v1 = owner）。 */
const OWNER = {
  domain: 'policy',
  op: 'stage',
  range: 'workspace',
  sensitivity: 'restricted',
} as const

export function haltRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/halt',
        operationId: 'getHalt',
        summary: '四个档位的急停状态',
        tag: 'kernel',
        auth: 'bearer',
        returns: 'Record<HaltScope, { on, reason? }>',
      },
      async (c, deps) => {
        principalOf(c)
        return ok(c, deps.halt.state())
      },
    ),
    route(
      {
        method: 'put',
        path: '/v1/halt',
        operationId: 'setHalt',
        summary: '运行期改急停（owner；四个 scope）',
        tag: 'kernel',
        auth: 'bearer',
        assignment: true,
        authz: OWNER,
        body: HaltBody,
        returns: '{ halt, changed }',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        const input = await body(c, HaltBody)
        const before = deps.halt.isHalted(input.scope)
        deps.halt.set(input.scope, input.on, input.reason ?? `PUT /v1/halt by ${p.person_id}`)
        const changed = before !== deps.halt.isHalted(input.scope)
        if (changed) {
          // 21 §1：谁在什么时候把什么停了 / 解了，必须在日志里看得见
          deps.eventLog.append?.({
            schema_version: 1,
            workspace_id: p.workspace_id,
            type: 'halt.changed',
            actor: { kind: 'person', id: p.person_id },
            correlation: { trace_id: c.get('rctx').trace_id },
            payload: {
              scope: input.scope,
              on: input.on,
              ...(input.reason === undefined ? {} : { reason: input.reason }),
            },
          })
        }
        return ok(c, { halt: deps.halt.state(), changed })
      },
    ),
  ]
}
