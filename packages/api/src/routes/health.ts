/**
 * 28 §1 §4：模块健康与急停状态。
 * 未签名（failed）与 requires 不满足（pending）的模块必须在这里看得见（用例 2），
 * 因此这条路由不要求 Bearer——否则急停 / 挂起时连诊断入口都进不去。
 */
import { ok } from '../helpers.js'
import { type Route, route } from '../route-spec.js'

/**
 * 15 §5.8 / 31 §3.2「备份恢复后先跑对账再放开出站」在健康检查上的那一格。
 *
 * `pending` = 账本里还有认识不完整的变更（`unknown` / 半路断掉的 `applying`），
 * 这时出站是停着的；`done` = 都收口了。没装配这个端口（嵌入式用法）就不出这一格
 * ——**不要用 `done` 冒充「没装」**，那会让运维以为对完账了。
 */
export interface ReconcilePort {
  state(): 'pending' | 'done'
  /** 还有几条没对上账（0 = 干净）。 */
  pending(): number
}

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
        returns: '{ status, at, version, pid, port?, halt, reconcile?, modules }',
      },
      async (c, deps) => {
        const modules = deps.modules.health()
        const halt = deps.halt.state()
        const degraded = modules.some((m) => m.state !== 'active')
        const halted = Object.values(halt).some((h) => h.on)
        // 13 §5：桌面壳靠 pid / port 认出「这个 sidecar 就是我起的那个」——
        // 端口是启动后才知道的（0 = 随机端口），所以用一个取值函数，不在装配时钉死。
        const instance = deps.options?.instance
        const port = instance?.port()
        const reconcile = deps.reconcile
        return ok(c, {
          status: halted ? 'halted' : degraded ? 'degraded' : 'ok',
          at: deps.clock.now(),
          version: deps.options?.version ?? '0.0.0',
          pid: instance?.pid ?? process.pid,
          ...(port === undefined ? {} : { port }),
          halt,
          // 15 §5.8：出站为什么停着，要在诊断入口上一眼看得见
          ...(reconcile === undefined
            ? {}
            : { reconcile: { state: reconcile.state(), pending: reconcile.pending() } }),
          modules,
        })
      },
    ),
  ]
}
