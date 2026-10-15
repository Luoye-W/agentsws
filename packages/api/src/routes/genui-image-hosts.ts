/**
 * WP341 追加（849）：AI 回话里外部图片的域名白名单（品牌级，「设置 → 通用」与对话里的「以后都直接显示」）。
 *
 * - `GET /v1/settings/image-hosts`：人加的那几个 + 已连店铺的域名（自动算、删不掉）；
 * - `POST /v1/settings/image-hosts`：加一个（网址 / 域名都认，规范成域名）；
 * - `DELETE /v1/settings/image-hosts/:host`：删一个。
 *
 * 只是「哪些网站的图不用点就加载」的偏好：品牌里谁在对话里都能加（同看图本身），不经 AI。
 */
import type { GenuiImageHostsView, MaybePromise } from '@agentsws/contracts'
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

const TAG = 'settings'

export interface GenuiImageHostsPort {
  view(workspace_id: string): MaybePromise<GenuiImageHostsView>
  /** 不像域名抛 `invalid_input`。 */
  add(workspace_id: string, host: string): MaybePromise<GenuiImageHostsView>
  remove(workspace_id: string, host: string): MaybePromise<GenuiImageHostsView>
}

const AddBody = z.object({ host: z.string().min(1).max(300) })

function portOf(deps: GatewayDeps): GenuiImageHostsPort {
  const p = deps.imageHosts
  if (p === undefined)
    throw new ApiError(
      'not_implemented',
      '这个服务进程没有装配图片白名单（GatewayDeps.imageHosts）',
    )
  return p
}

export function genuiImageHostsRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/settings/image-hosts',
        operationId: 'getImageHosts',
        summary: 'WP341 外部图片白名单：人加的域名 + 已连店铺的域名（品牌级）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'GenuiImageHostsView',
      },
      async (c, deps) => ok(c, await portOf(deps).view(principalOf(c).workspace_id)),
    ),
    route(
      {
        method: 'post',
        path: '/v1/settings/image-hosts',
        operationId: 'addImageHost',
        summary: 'WP341 加一个「图直接显示」的域名（网址 / 域名都认）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        body: AddBody,
        returns: 'GenuiImageHostsView',
      },
      async (c, deps) => {
        const { host } = await body(c, AddBody)
        return ok(c, await portOf(deps).add(principalOf(c).workspace_id, host))
      },
    ),
    route(
      {
        method: 'delete',
        path: '/v1/settings/image-hosts/:host',
        operationId: 'removeImageHost',
        summary: 'WP341 从外部图片白名单里删一个域名',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [{ name: 'host', in: 'path', required: true, description: '域名' }],
        returns: 'GenuiImageHostsView',
      },
      async (c, deps) =>
        ok(c, await portOf(deps).remove(principalOf(c).workspace_id, param(c, 'host'))),
    ),
  ]
}
