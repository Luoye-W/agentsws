/**
 * WP261（决策 175 第 1 步）：**「授权管理商品和页面」那一行**——岗位页上店铺管理 / 整站搭建 / 网页模板所在的岗位。
 *
 * 一键起 Shopify CLI 的 `store auth`（浏览器里点批准，**用户不建开发者应用、不开终端、不填技术参数**），
 * 授权成功记「已授权 + 有哪些权限 + 何时过期」；过期 / 缺权限时那一行回到「重新授权」并说清缺哪项。
 *
 * - `GET /v1/shop-admin?roles=a,b`：现状（`roles` = 这个岗位上的职责；权限按它们的并集算「还缺哪项」）；
 * - `POST /v1/shop-admin/run {action, roles}`：`install`（CLI 还没装：替用户装，与 WP245 同一条）/
 *   `authorize`（起 `store auth`）——**只给人点**，AI 运行（`runtime` 令牌）一律 403；
 * - `POST /v1/shop-admin/cancel`：停掉正在等浏览器的那次授权；
 * - `PUT /v1/shop-admin/store {store}`：不知道是哪家店时记一个（与网页模板那一格同一份设置）。
 *
 * 权限只能取平台登记表（`PlatformStoreAdminSpec.scopes_by_role`）里的；参数在服务端拼死。
 */
import type { MaybePromise } from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { assignmentOf, body, ok, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'

/** 三条职责（店铺管理 / 整站搭建 / 网页模板）都有「读商品」这一格。 */
const READ = {
  domain: 'product',
  op: 'read',
  range: 'assigned',
  sensitivity: 'internal',
} as const

export interface ShopAdminActor {
  workspace_id: string
  person_id: string
  assignment_id: string
}

/** 那一行现在是哪一档（顺序就是「还差哪一步」）。 */
export type ShopAdminState =
  /** 这台电脑还没装 Shopify CLI（或 Node 不够）→「一键安装」。 */
  | 'no_cli'
  /** 不知道是哪家店 → 一格店铺地址。 */
  | 'no_store'
  /** 没授权过 →「授权管理商品和页面」。 */
  | 'unauthorized'
  /** 正在等浏览器里点批准。 */
  | 'authorizing'
  /** 授权过期 / 被收回 →「重新授权」。 */
  | 'expired'
  /** 授权了，但这个岗位要的权限还缺几项 →「重新授权」并说缺哪项。 */
  | 'missing_scopes'
  | 'authorized'

/** 起 `store auth` 的那一次（轮询它画进度）。 */
export interface ShopAdminAuthJob {
  action: 'install' | 'authorize'
  phase: 'running' | 'waiting_browser' | 'done' | 'failed' | 'cancelled'
  started_at: string
  finished_at?: string
  /** CLI 没能自己打开浏览器时打出来的授权网址（只认 `https://<店>/admin/oauth/authorize`）。 */
  auth_url?: string
  /** CLI 说它会自己开浏览器（工作台不再开第二次）。 */
  browser_opened?: boolean
  error?: {
    code:
      | 'denied'
      | 'timeout'
      | 'port_busy'
      | 'missing_scopes'
      | 'store_mismatch'
      | 'network'
      | 'busy'
      | 'failed'
    /** 缺哪几项权限（`missing_scopes` 时）。 */
    missing?: string[]
    detail?: string
  }
}

export interface ShopAdminView {
  /** 这个品牌的平台能不能这样管店（不是 Shopify / CLI 不支持 = false，岗位页什么都不出）。 */
  applicable: boolean
  state?: ShopAdminState
  store?: string
  /** 这个岗位要的权限（按职责并集）。 */
  scopes_needed: string[]
  /** 授权给过的权限（`write_x` 已展开出 `read_x`）。 */
  scopes_granted: string[]
  /** 还缺哪几项。 */
  missing: string[]
  authorized_at?: string
  /** 令牌何时过期（CLI 回的 `expiresAt`；有续期令牌时 CLI 会自己续，见 `refreshable`）。 */
  expires_at?: string
  /** CLI 拿到了续期令牌：到期前每次执行会自己续，不用重新授权。 */
  refreshable?: boolean
  /** 上一次执行时 Shopify 说的问题（过期 / 被收回 / 缺权限）。 */
  problem?: { code: 'expired' | 'revoked' | 'missing_scope'; missing?: string[]; at: string }
  job?: ShopAdminAuthJob
}

export interface ShopAdminPort {
  view(actor: ShopAdminActor, input: { roles: string[] }): MaybePromise<ShopAdminView>
  run(
    actor: ShopAdminActor,
    input: { action: 'install' | 'authorize'; roles: string[] },
  ): MaybePromise<ShopAdminView>
  cancel(actor: ShopAdminActor, input: { roles: string[] }): MaybePromise<ShopAdminView>
  setStore(
    actor: ShopAdminActor,
    input: { store: string; roles: string[] },
  ): MaybePromise<ShopAdminView>
}

const ROLE_ID = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9_.-]+$/)
const RunBody = z.object({
  action: z.enum(['install', 'authorize']),
  roles: z.array(ROLE_ID).max(20).default([]),
})
const CancelBody = z.object({ roles: z.array(ROLE_ID).max(20).default([]) })
const StoreBody = z.object({
  store: z.string().min(1).max(300),
  roles: z.array(ROLE_ID).max(20).default([]),
})

/** `?roles=a,b` → 只留像职责 id 的那几个。 */
function rolesOf(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => ROLE_ID.safeParse(s).success)
    .slice(0, 20)
}

/** 安装与授权只给人点：AI 运行那条路（`runtime` 令牌）一律拒。 */
function humanOnly(c: Parameters<typeof principalOf>[0]): void {
  if (principalOf(c).kind === 'runtime')
    throw new ApiError('forbidden', '安装与授权只能由人在工作台上点，AI 运行不能调用')
}

function portOf(deps: GatewayDeps): ShopAdminPort {
  const p = deps.shopAdmin
  if (p === undefined)
    throw new ApiError('not_implemented', '这个服务进程没有装配店铺授权（GatewayDeps.shopAdmin）')
  return p
}

function actorOf(c: Parameters<typeof principalOf>[0]): ShopAdminActor {
  const p = principalOf(c)
  return { workspace_id: p.workspace_id, person_id: p.person_id, assignment_id: assignmentOf(c).id }
}

export function shopAdminRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/shop-admin',
        operationId: 'getShopAdmin',
        summary:
          'WP261：「授权管理商品和页面」那一行的现状（装没装 CLI、知不知道是哪家店、授没授权、有哪些权限、何时过期、还缺哪项）。`roles` = 这个岗位上的职责',
        tag: 'site',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'ShopAdminView',
      },
      async (c, deps) =>
        ok(c, await portOf(deps).view(actorOf(c), { roles: rolesOf(c.req.query('roles')) })),
    ),
    route(
      {
        method: 'post',
        path: '/v1/shop-admin/run',
        operationId: 'runShopAdmin',
        summary:
          'WP261：替用户装 Shopify CLI（install）或起店铺授权（authorize：浏览器里点批准，权限按岗位职责从登记表取）。只给人点',
        tag: 'site',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        body: RunBody,
        returns: 'ShopAdminView',
      },
      async (c, deps) => {
        humanOnly(c)
        return ok(c, await portOf(deps).run(actorOf(c), await body(c, RunBody)))
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/shop-admin/cancel',
        operationId: 'cancelShopAdmin',
        summary: 'WP261：停掉正在等浏览器的那次店铺授权',
        tag: 'site',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        body: CancelBody,
        returns: 'ShopAdminView',
      },
      async (c, deps) => {
        humanOnly(c)
        return ok(c, await portOf(deps).cancel(actorOf(c), await body(c, CancelBody)))
      },
    ),
    route(
      {
        method: 'put',
        path: '/v1/shop-admin/store',
        operationId: 'setShopAdminStore',
        summary:
          'WP261：记下这个品牌是哪家店（xxx.myshopify.com 或后台地址栏那一串；与网页模板那一格同一份设置）。只给人点',
        tag: 'site',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        body: StoreBody,
        returns: 'ShopAdminView',
      },
      async (c, deps) => {
        humanOnly(c)
        return ok(c, await portOf(deps).setStore(actorOf(c), await body(c, StoreBody)))
      },
    ),
  ]
}
