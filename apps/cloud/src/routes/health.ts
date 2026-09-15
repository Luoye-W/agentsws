/** 云侧的诊断入口。只有"活着没有、什么版本、几点了"——没有任何计数与身份。 */

import { type CloudRoute, cloudOk, cloudRoute } from '@agentsws/api'
import type { Clock } from '@agentsws/contracts'

export function cloudHealthRoutes(deps: { clock: Clock; version: string }): CloudRoute[] {
  return [
    cloudRoute(
      {
        method: 'get',
        path: '/v1/cloud/health',
        operationId: 'cloudHealth',
        summary: '活着没有',
        tag: 'cloud-health',
        auth: 'public',
        returns: '{ status, version, at }',
      },
      async (c) => cloudOk(c, { status: 'ok', version: deps.version, at: deps.clock.now() }),
    ),
  ]
}
