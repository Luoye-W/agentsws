/**
 * WP265：连接页 Shopify 店铺卡的「连接 Shopify」一键授权（接私有云 WP263）。
 *
 * 用户没有 IT 知识（Luoye）：不建开发者应用、不填客户端 ID / 密钥。点一下 → 系统浏览器打开
 * Shopify 自己的授权页 → 店主点「安装」→ 回来卡上就是「已连接」。店铺令牌**只在云上**
 * （决策 185），本机手里只有这个品牌的工作区令牌（动作集 `store`，决策 186）。
 *
 * 五条路，前缀 `/v1/shopify-connect`（新前缀，与 `/v1/connections/:id` 那几条不撞）：
 * - `GET  /v1/shopify-connect`：卡上要画的一切（账号关联没有、这个品牌连了哪些店、建议填哪家店）
 * - `POST /v1/shopify-connect/start`：起一次授权，回 Shopify 授权页的地址
 * - `GET  /v1/shopify-connect/attempts/:id`：轮询这次授权（pending / connected / failed / expired）
 * - `POST /v1/shopify-connect/test`：测试连接（云端代发一次只读查询：店名 + 域名）
 * - `POST /v1/shopify-connect/disconnect`：断开（这个品牌的；最后一个断开时云上顺手卸载应用）
 * - `POST /v1/shopify-connect/upgrade`（WP267，决策 208）：老令牌缺 `store` 时一点补签（云上就地补动作集），
 *   不用重新登录；云上没这一条 / 令牌不认 → `upgrade_unavailable`，界面退回「重新登录」
 *
 * 出错一律带 `details.reason`，界面按它说人话：
 * `not_linked`（没登录 Agents 工坊账号）/ `scope_missing`（老令牌缺 `store`，重新登录一次）/
 * `unsupported`（云上 501：这家店暂不支持一键授权）/ `offline`（连不上云）。
 *
 * 权限与连接面同一档：读 `store_config.read@workspace`，改 `policy.stage@workspace`（owner 专属）。
 */
import type { MaybePromise } from '@agentsws/contracts'
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

const TAG = 'shopify-connect'

// ── 端口类型（apps/server 实现）────────────────────────────────────────

export interface ShopifyConnectActor {
  workspace_id: string
  person_id: string
}

/** 卡上为什么现在点不了「连接 Shopify」。 */
export type ShopifyConnectBlockedReason = 'not_linked' | 'scope_missing' | 'offline'

/** 建议填的店从哪来（排在前面的先用）。 */
export type ShopifyShopSource = 'profile' | 'site' | 'cli' | 'connection'

/** 这个品牌连上的一家店。**没有任何令牌字段**——店铺令牌只在云上。 */
export interface ShopifyConnectRow {
  shop: string
  /** 店名（测试过 / 云上记了才有）。 */
  name?: string
  app?: string
  status: 'connected' | 'reauth_required'
  reauth_reason?: string
  /** 已授的 Shopify 权限（原名，界面翻成人话）。 */
  scopes: string[]
  /** 应用要、但没授到的权限。非空 = 要「重新授权」。 */
  missing_scopes: string[]
  expires_at?: string
}

export interface ShopifyConnectView {
  /** 这个品牌有没有 Agents 工坊账号的工作区令牌。 */
  linked: boolean
  /** 账号邮箱（重新登录时预填；没关联没有）。 */
  email?: string
  /**
   * WP272：`scope_missing` 只在**后台自动补签也没成**时出现（界面引导去「设置 → 账号」重新登录）；
   * `offline` 只在自动重试一次之后仍连不上时出现，`cause_code` 是根本原因的码（`ENOTFOUND` /
   * `timeout` …，界面放在问号里）。
   */
  blocked?: { reason: ShopifyConnectBlockedReason; message: string; cause_code?: string }
  connections: ShopifyConnectRow[]
  /** 自动带上的店铺域名（品牌档案 → 建站找到的店 → CLI 店铺清单 → 老连接）。 */
  suggested_shop?: string
  candidates: { shop: string; source: ShopifyShopSource }[]
}

export interface ShopifyConnectStarted {
  attempt_id: string
  authorize_url: string
  shop: string
  expires_at: string
}

export interface ShopifyConnectAttemptView {
  status: 'pending' | 'connected' | 'failed' | 'expired'
  shop?: string
  message?: string
}

export interface ShopifyConnectTestResult {
  ok: boolean
  shop: string
  name?: string
  domain?: string
  message?: string
  checked_at: string
}

/** WP267：一点补签的结果（令牌不变；`added` 是这次补上的动作集，已经齐了 = 空）。 */
export interface ShopifyConnectUpgradeResult {
  upgraded: boolean
  added: string[]
  scopes: string[]
}

export interface ShopifyConnectPort {
  view(actor: ShopifyConnectActor): MaybePromise<ShopifyConnectView>
  start(actor: ShopifyConnectActor, input: { shop?: string }): MaybePromise<ShopifyConnectStarted>
  attempt(actor: ShopifyConnectActor, id: string): MaybePromise<ShopifyConnectAttemptView>
  test(actor: ShopifyConnectActor, shop: string): MaybePromise<ShopifyConnectTestResult>
  disconnect(actor: ShopifyConnectActor, shop: string): MaybePromise<{ disconnected: boolean }>
  /** WP267：一点补签（没装配 = 501，界面退回重新登录）。 */
  upgrade?(actor: ShopifyConnectActor): MaybePromise<ShopifyConnectUpgradeResult>
}

const StartBody = z.object({ shop: z.string().trim().min(1).max(255).optional() })
const ShopBody = z.object({ shop: z.string().trim().min(1).max(255) })

function portOf(deps: GatewayDeps): ShopifyConnectPort {
  const p = deps.shopifyConnect
  if (p === undefined)
    throw new ApiError(
      'not_implemented',
      '这个服务进程没有装配 Shopify 一键授权（GatewayDeps.shopifyConnect）',
    )
  return p
}

function actorOf(c: Parameters<typeof principalOf>[0]): ShopifyConnectActor {
  const p = principalOf(c)
  return { workspace_id: p.workspace_id, person_id: p.person_id }
}

export function shopifyConnectRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/shopify-connect',
        operationId: 'getShopifyConnect',
        summary:
          'WP265：连接页 Shopify 卡——账号关联没有、这个品牌连了哪些店（云上一键授权的）、自动带上的店铺域名',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'ShopifyConnectView',
      },
      async (c, deps) => ok(c, await portOf(deps).view(actorOf(c))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/shopify-connect/start',
        operationId: 'startShopifyConnect',
        summary:
          'WP265：起一次 Shopify 一键授权（云上 oauth/start），回 Shopify 授权页地址；店铺域名不给就用自动带上的那家',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        outbound: true,
        body: StartBody,
        returns: 'ShopifyConnectStarted',
      },
      async (c, deps) => {
        const input = await body(c, StartBody)
        return ok(
          c,
          await portOf(deps).start(
            actorOf(c),
            input.shop === undefined ? {} : { shop: input.shop },
          ),
          201,
        )
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/shopify-connect/attempts/:id',
        operationId: 'getShopifyConnectAttempt',
        summary: 'WP265：这次授权到哪了（pending / connected / failed / expired）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [{ name: 'id', in: 'path', required: true, description: '云上回的 attempt_id' }],
        returns: 'ShopifyConnectAttemptView',
      },
      async (c, deps) => ok(c, await portOf(deps).attempt(actorOf(c), param(c, 'id'))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/shopify-connect/test',
        operationId: 'testShopifyConnect',
        summary: 'WP265：测试连接——云端代发一次只读查询（店名 + 店铺域名），不改店里任何东西',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        outbound: true,
        body: ShopBody,
        returns: 'ShopifyConnectTestResult',
      },
      async (c, deps) => {
        const input = await body(c, ShopBody)
        return ok(c, await portOf(deps).test(actorOf(c), input.shop))
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/shopify-connect/disconnect',
        operationId: 'disconnectShopifyConnect',
        summary:
          'WP265：断开这个品牌连的这家店（云上删绑定；最后一个工作区断开时云上顺手卸载应用）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        outbound: true,
        body: ShopBody,
        returns: '{ disconnected }',
      },
      async (c, deps) => {
        const input = await body(c, ShopBody)
        return ok(c, await portOf(deps).disconnect(actorOf(c), input.shop))
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/shopify-connect/upgrade',
        operationId: 'upgradeShopifyConnect',
        summary:
          'WP267：账号授权一点补签——这个品牌的工作区令牌在云上就地补上 store（不换令牌、不用重新登录）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        outbound: true,
        returns: 'ShopifyConnectUpgradeResult',
      },
      async (c, deps) => {
        const port = portOf(deps)
        if (port.upgrade === undefined)
          throw new ApiError('not_implemented', '这个服务进程没有装配一点补签', {
            details: { reason: 'upgrade_unavailable' },
          })
        return ok(c, await port.upgrade(actorOf(c)))
      },
    ),
  ]
}
