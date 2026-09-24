/**
 * WP136（docs/79）：dsh 场景（Profile）的 HTTP 投影。
 *
 * Agents 工坊是 dsh 里的一个场景；用户想编程、做别的事，切到 dsh 官方的场景或自建的，
 * 不必另装一份 dsh。这几条路由只做「入口」：列、建、删自建的、起 / 停 / 重启网页场景。
 * 其他场景怎么跑是 DeepSeek 官方的事——我们不改它们的配置，也不对它们负责。
 *
 * 权限与浏览器设置同一档（都是"这台电脑上的东西怎么配"）：读 `store_config.read@workspace`，
 * 改 `policy.stage@workspace`——只有所有者动得了。
 *
 * 打开 / 重启回的网址带 dsh 发的一次性 token：只在响应体里出现这一次，服务端不记日志。
 */
import type {
  DshSceneOpenResult,
  DshScenesView,
  DshSceneView,
  MaybePromise,
} from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { body, ok, param, principalOf } from '../helpers.js'
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

export interface DshScenesActor {
  workspace_id: string
  person_id: string
}

export interface DshScenesPort {
  list(actor: DshScenesActor): MaybePromise<DshScenesView>
  /** 从官方模板建一个新场景（只建目录，不起）。 */
  create(
    actor: DshScenesActor,
    input: { name: string; template: string },
  ): MaybePromise<DshSceneView>
  /** 删一个**自建**场景：先停、再删 `$DSH_HOME/profiles/<name>`。`confirm` 必须等于 `name`。 */
  remove(actor: DshScenesActor, name: string, confirm: string): MaybePromise<{ deleted: true }>
  /** 网页场景：没起就起，起好了回带 token 的网址。 */
  open(actor: DshScenesActor, name: string): MaybePromise<DshSceneOpenResult>
  stop(actor: DshScenesActor, name: string): MaybePromise<DshSceneView>
  restart(actor: DshScenesActor, name: string): MaybePromise<DshSceneOpenResult>
}

const CreateBody = z.object({
  name: z.string().min(1).max(64),
  template: z.string().min(1).max(64),
})

function portOf(deps: GatewayDeps): DshScenesPort {
  const p = deps.dshScenes
  if (p === undefined)
    throw new ApiError('not_implemented', '这个服务进程没有装配场景切换（GatewayDeps.dshScenes）')
  return p
}

function actorOf(c: Parameters<typeof principalOf>[0]): DshScenesActor {
  const p = principalOf(c)
  return { workspace_id: p.workspace_id, person_id: p.person_id }
}

const NAME_PARAM = [{ name: 'name', in: 'path' as const, required: true, description: '场景名' }]

export function dshScenesRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/dsh-scenes',
        operationId: 'listDshScenes',
        summary: 'WP136：dsh 的场景——Agents 工坊（第一个、默认）+ 官方模板 + 自建的，各自在不在跑',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'DshScenesView',
      },
      async (c, deps) => ok(c, await portOf(deps).list(actorOf(c))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/dsh-scenes',
        operationId: 'createDshScene',
        summary: 'WP136：从官方模板建一个新场景（`dsh --from-default-profile`；只建不起）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: CreateBody,
        returns: 'DshSceneView',
      },
      async (c, deps) => {
        const input = await body(c, CreateBody)
        return ok(c, await portOf(deps).create(actorOf(c), input))
      },
    ),
    route(
      {
        method: 'delete',
        path: '/v1/dsh-scenes/:name',
        operationId: 'deleteDshScene',
        summary:
          'WP136：删一个自建场景（只删 `$DSH_HOME/profiles/<name>`）。`confirm` 必须再写一遍场景名',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        params: [
          ...NAME_PARAM,
          { name: 'confirm', in: 'query', required: true, description: '二次确认：再写一遍场景名' },
        ],
        returns: '{ deleted: true }',
      },
      async (c, deps) =>
        ok(
          c,
          await portOf(deps).remove(actorOf(c), param(c, 'name'), c.req.query('confirm') ?? ''),
        ),
    ),
    route(
      {
        method: 'post',
        path: '/v1/dsh-scenes/:name/open',
        operationId: 'openDshScene',
        summary:
          'WP136：打开一个网页场景——没起就用捆绑的 Node 起 `dsh --profile <name>`（只听 127.0.0.1），回带一次性 token 的网址',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        params: NAME_PARAM,
        returns: 'DshSceneOpenResult',
      },
      async (c, deps) => ok(c, await portOf(deps).open(actorOf(c), param(c, 'name'))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/dsh-scenes/:name/stop',
        operationId: 'stopDshScene',
        summary: 'WP136：关掉一个在跑的场景',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        params: NAME_PARAM,
        returns: 'DshSceneView',
      },
      async (c, deps) => ok(c, await portOf(deps).stop(actorOf(c), param(c, 'name'))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/dsh-scenes/:name/restart',
        operationId: 'restartDshScene',
        summary: 'WP136：重启一个网页场景（改了它的插件 / 配置之后用）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        params: NAME_PARAM,
        returns: 'DshSceneOpenResult',
      },
      async (c, deps) => ok(c, await portOf(deps).restart(actorOf(c), param(c, 'name'))),
    ),
  ]
}
