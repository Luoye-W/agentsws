/**
 * 云侧的诊断入口。
 *
 * WP110 把它从"活着没有"扩成"活着没有、什么版本、哪几块挂上了、上游通不通"——
 * 因为 runbook 里的冒烟脚本只有这一条公开路由可用：装完之后要能一眼看出
 * 是"服务没起来"、"模块没挂上"还是"New API 那一头没通"，三种情况的下一步完全不同。
 *
 * **一条纪律**：这里不回任何密钥，也不回任何地址。上游那一格只有 `reachable`
 * 与 `checked_at`——把 New API 的内网地址端出来等于告诉扫描的人下一个目标在哪。
 */

import { type CloudRoute, cloudOk, cloudRoute } from '@agentsws/api'
import type { Clock } from '@agentsws/contracts'

/** 上游探活的结果。`unknown` = 还没探过 / 探不出来，**不假装它是通的**。 */
export interface UpstreamHealth {
  reachable: boolean | 'unknown'
  checked_at?: string
}

/**
 * 这个节点的活动状态。装配方（`index.ts`）在挂完模块之后往里写——
 * 路由是在挂模块**之前**收集的，所以它读的必须是一个活对象，不是一份快照。
 */
export interface CloudHealthState {
  /** 模块名 → 挂上了没有。名字与 `pages.ts` 里那张标签表对得上。 */
  modules: Record<string, boolean>
  /** New API 可达性探针；不给就回 `unknown`。 */
  probeUpstream?: () => Promise<UpstreamHealth>
}

export interface HealthRouteDeps {
  clock: Clock
  version: string
  /** WP110：活的状态对象。不给就只回 `status` / `version` / `at`（与 WP58 那一版同形）。 */
  state?: CloudHealthState
}

export function cloudHealthRoutes(deps: HealthRouteDeps): CloudRoute[] {
  return [
    cloudRoute(
      {
        method: 'get',
        path: '/v1/cloud/health',
        operationId: 'cloudHealth',
        summary: '活着没有：版本、各模块挂没挂上、New API 通不通（不回任何密钥与地址）',
        tag: 'cloud-health',
        auth: 'public',
        returns: '{ status, version, at, modules, newapi }',
      },
      async (c) => {
        const base = { status: 'ok', version: deps.version, at: deps.clock.now() }
        if (deps.state === undefined) return cloudOk(c, base)
        let newapi: UpstreamHealth = { reachable: 'unknown' }
        if (deps.state.probeUpstream !== undefined) {
          try {
            newapi = await deps.state.probeUpstream()
          } catch {
            // 探针自己炸了不该把诊断口也带走——那正是最需要它的时候
            newapi = { reachable: 'unknown' }
          }
        }
        return cloudOk(c, { ...base, modules: { ...deps.state.modules }, newapi })
      },
    ),
  ]
}
