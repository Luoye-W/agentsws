/**
 * 28 §1 §4：模块健康与急停状态。
 * 未签名（failed）与 requires 不满足（pending）的模块必须在这里看得见（用例 2），
 * 因此这条路由不要求 Bearer——否则急停 / 挂起时连诊断入口都进不去。
 */
import { ok } from '../helpers.js'
import { type Route, route } from '../route-spec.js'

export function healthRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/health',
        operationId: 'health',
        summary: '模块健康 + 急停状态',
        tag: 'kernel',
        auth: 'public',
        returns: '{ status, at, version, halt, modules }',
      },
      async (c, deps) => {
        const modules = deps.modules.health()
        const halt = deps.halt.state()
        const degraded = modules.some((m) => m.state !== 'active')
        const halted = Object.values(halt).some((h) => h.on)
        return ok(c, {
          status: halted ? 'halted' : degraded ? 'degraded' : 'ok',
          at: deps.clock.now(),
          version: deps.options?.version ?? '0.0.0',
          halt,
          modules,
        })
      },
    ),
  ]
}
