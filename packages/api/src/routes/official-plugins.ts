/**
 * WP180：设置 →「官方插件」的 HTTP 投影。
 *
 * | 路由 | 是什么 | 谁能用 |
 * |---|---|---|
 * | `GET /v1/settings/official-plugins` | 审过的清单里每一项在这台机器上的样子（已装 / 可装 / 可升级 / 等批 / 版本没审过） | 读：`store_config.read` |
 * | `POST /v1/settings/official-plugins/requests` | 点装 / 升级 / 卸载：清单外直接拒，过了**出一张卡**（批了才做） | 改：`policy.stage`（所有者的事） |
 * | `PUT /v1/settings/official-plugins/config` | 运行中保存某一行的配置：锁定表里的行一律拒（记事件），别的写进插件层 | 同「改」 |
 *
 * 凭据边界（13 §4）：这条路上没有任何凭据；插件是 dsh 自带的官方可选包，不下载。
 */
import type {
  MaybePromise,
  OfficialPluginsView,
  ProfileConfigWriteResult,
} from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { body, ok, principalOf } from '../helpers.js'
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

export interface OfficialPluginsActor {
  workspace_id: string
  person_id: string
}

export interface OfficialPluginsPort {
  view(actor: OfficialPluginsActor): MaybePromise<OfficialPluginsView>
  /** 装 / 升级 / 卸载：出一张 `official_plugin` 卡（清单外 / 说不通 → 403 / 409）。 */
  request(
    actor: OfficialPluginsActor,
    input: { action: 'install' | 'upgrade' | 'uninstall'; name: string },
  ): MaybePromise<OfficialPluginsView>
  /** 运行中保存配置（只许写不在锁定表里的行）。 */
  saveConfig(
    actor: OfficialPluginsActor,
    input: { row_id: string; config: Record<string, unknown> },
  ): MaybePromise<ProfileConfigWriteResult>
}

const RequestBody = z.object({
  action: z.enum(['install', 'upgrade', 'uninstall']),
  name: z.string().min(1).max(214),
})

const ConfigBody = z.object({
  row_id: z.string().min(1).max(200),
  config: z.record(z.string(), z.unknown()),
})

function portOf(deps: GatewayDeps): OfficialPluginsPort {
  const p = deps.officialPlugins
  if (p === undefined)
    throw new ApiError(
      'not_implemented',
      '这个服务进程没有装配官方插件（GatewayDeps.officialPlugins）',
    )
  return p
}

function actorOf(c: Parameters<typeof principalOf>[0]): OfficialPluginsActor {
  const p = principalOf(c)
  return { workspace_id: p.workspace_id, person_id: p.person_id }
}

export function officialPluginsRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/settings/official-plugins',
        operationId: 'getOfficialPlugins',
        summary: 'WP180：官方插件——审过的清单里每一项在这台机器上的样子',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'OfficialPluginsView',
      },
      async (c, deps) => ok(c, await portOf(deps).view(actorOf(c))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/settings/official-plugins/requests',
        operationId: 'requestOfficialPluginChange',
        summary:
          'WP180：装 / 升级 / 卸载一个官方插件——只许清单里的，过了出一张卡（批了才做，做完 profile patch 逐字节不变）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: RequestBody,
        returns: 'OfficialPluginsView',
      },
      async (c, deps) => {
        const input = await body(c, RequestBody)
        return ok(c, await portOf(deps).request(actorOf(c), input))
      },
    ),
    route(
      {
        method: 'put',
        path: '/v1/settings/official-plugins/config',
        operationId: 'saveOfficialPluginConfig',
        summary:
          'WP180：运行中保存某一行的配置——锁定表里的行（数据外发、开关）一律拒并记事件，别的写进插件层',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: ConfigBody,
        returns: 'ProfileConfigWriteResult',
      },
      async (c, deps) => {
        const input = await body(c, ConfigBody)
        return ok(c, await portOf(deps).saveConfig(actorOf(c), input))
      },
    ),
  ]
}
