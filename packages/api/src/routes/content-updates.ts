/**
 * WP219（docs/90 §6）：设置 → 通用「已审的内容更新」的 HTTP 投影。
 *
 * | 路由 | 是什么 | 谁能用 |
 * |---|---|---|
 * | `GET /v1/settings/content-updates` | 这个品牌：自动 / 每次问我、通道状态、更新过或有新版的条目 | 读：`store_config.read` |
 * | `PUT /v1/settings/content-updates` | 改成自动 / 每次问我（按品牌存） | 改：`policy.stage`（所有者的事） |
 * | `POST /v1/settings/content-updates/check` | 现在查一次 | 同「改」 |
 * | `POST /v1/settings/content-updates/items/:id/apply` | 更新这一条（设置里点的；卡上点的走审批） | 同「改」 |
 * | `POST /v1/settings/content-updates/items/:id/rollback` | 退回上一版（没有就回到随软件带的那一版） | 同「改」 |
 * | `GET /v1/settings/content-updates/items/:id/diff` | 查看改动（按段） | 读 |
 *
 * 条目 id 形如 `skill:shopify`，放进路径时要 `encodeURIComponent`。这条路上没有任何凭据。
 */
import type {
  ContentDiffView,
  ContentUpdateMode,
  ContentUpdatesView,
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

export interface ContentUpdatesActor {
  workspace_id: string
  person_id: string
}

export interface ContentUpdatesPort {
  view(actor: ContentUpdatesActor): MaybePromise<ContentUpdatesView>
  setMode(actor: ContentUpdatesActor, mode: ContentUpdateMode): MaybePromise<ContentUpdatesView>
  check(actor: ContentUpdatesActor): MaybePromise<ContentUpdatesView>
  apply(actor: ContentUpdatesActor, item_id: string): MaybePromise<ContentUpdatesView>
  rollback(actor: ContentUpdatesActor, item_id: string): MaybePromise<ContentUpdatesView>
  diff(actor: ContentUpdatesActor, item_id: string): MaybePromise<ContentDiffView>
}

const ModeBody = z.object({ mode: z.enum(['auto', 'ask']) })

const ITEM_ID = /^[a-z]+:[a-z0-9][a-z0-9.-]*$/

function portOf(deps: GatewayDeps): ContentUpdatesPort {
  const p = deps.contentUpdates
  if (p === undefined)
    throw new ApiError(
      'not_implemented',
      '这个服务进程没有装配内容更新（GatewayDeps.contentUpdates）',
    )
  return p
}

function actorOf(c: Parameters<typeof principalOf>[0]): ContentUpdatesActor {
  const p = principalOf(c)
  return { workspace_id: p.workspace_id, person_id: p.person_id }
}

function itemId(c: Parameters<typeof param>[0]): string {
  const id = decodeURIComponent(param(c, 'id'))
  if (!ITEM_ID.test(id)) throw new ApiError('invalid_input', `条目 id 不对：${id}`)
  return id
}

const ID_PARAM = [
  { name: 'id', in: 'path' as const, required: true, description: '条目 id（`skill:<名字>`）' },
]

export function contentUpdatesRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/settings/content-updates',
        operationId: 'getContentUpdates',
        summary: 'WP219：已审的内容更新——这个品牌的设置、通道状态、更新过或有新版的条目',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'ContentUpdatesView',
      },
      async (c, deps) => ok(c, await portOf(deps).view(actorOf(c))),
    ),
    route(
      {
        method: 'put',
        path: '/v1/settings/content-updates',
        operationId: 'putContentUpdates',
        summary: 'WP219：已审的内容更新改成自动 / 每次问我（按品牌存，默认每次问我）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: ModeBody,
        returns: 'ContentUpdatesView',
      },
      async (c, deps) => {
        const input = await body(c, ModeBody)
        return ok(c, await portOf(deps).setMode(actorOf(c), input.mode))
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/settings/content-updates/check',
        operationId: 'checkContentUpdates',
        summary: 'WP219：现在查一次已审内容的清单（平时每 6 小时与启动时各查一次）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        returns: 'ContentUpdatesView',
      },
      async (c, deps) => ok(c, await portOf(deps).check(actorOf(c))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/settings/content-updates/items/:id/apply',
        operationId: 'applyContentUpdate',
        summary:
          'WP219：更新这一条（原子换这个品牌的基础层、保留旧版一份；与你的改动冲突的段出卡）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        params: ID_PARAM,
        returns: 'ContentUpdatesView',
      },
      async (c, deps) => ok(c, await portOf(deps).apply(actorOf(c), itemId(c))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/settings/content-updates/items/:id/rollback',
        operationId: 'rollbackContentUpdate',
        summary: 'WP219：一键退回上一版（没有就回到随软件带的那一版；这一版不再自动提）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        params: ID_PARAM,
        returns: 'ContentUpdatesView',
      },
      async (c, deps) => ok(c, await portOf(deps).rollback(actorOf(c), itemId(c))),
    ),
    route(
      {
        method: 'get',
        path: '/v1/settings/content-updates/items/:id/diff',
        operationId: 'getContentUpdateDiff',
        summary: 'WP219：查看改动——按段列出加了 / 改了 / 删了',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: ID_PARAM,
        returns: 'ContentDiffView',
      },
      async (c, deps) => ok(c, await portOf(deps).diff(actorOf(c), itemId(c))),
    ),
  ]
}
