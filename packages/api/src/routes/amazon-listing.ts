/**
 * WP396（docs/106 §13）：**自家 Amazon Listing 体检**的工作台路由（Bearer + `X-Assignment`）。
 *
 * - `GET /v1/amazon-listing`：面板那一块（最近一次体检、自家 ASIN 几个、规则表、这里能不能读、卡底那一句）；
 * - `POST /v1/amazon-listing/run`：现在体检一次（只读 Amazon 前台公开页，不改 Amazon 上任何东西）；
 * - `PUT /v1/amazon-listing/rules`：改一条规则的建议值 / 开关 / 核对日期，或记下自家店铺名（只动本机）。
 *
 * 自家 ASIN 清单不在这里改（唯一一份在关注设置 `PUT /v1/seo/watch` 的 `brand_amazon`，WP392）。
 * 权限：亚马逊店铺运营读商品（`product` read）；体检只读外部公开页、改规则只动本机，同一把闸。
 */
import type {
  ListingCheckupRun,
  ListingCheckupView,
  ListingRule,
  MaybePromise,
  WorkspaceId,
} from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { body, ok, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'

export interface AmazonListingRunView {
  run?: ListingCheckupRun
  /** 自家 ASIN 还没填（设置目标 id）：去对话里说一句，AI 出卡让人勾。 */
  needs_setup?: string
  message?: string
}

export interface AmazonListingRulePatch {
  rule_id?: string
  params?: Record<string, unknown>
  enabled?: boolean
  checked_at?: string
  own_sellers?: string[]
}

export interface AmazonListingPort {
  view(workspace_id: WorkspaceId): MaybePromise<ListingCheckupView>
  run(workspace_id: WorkspaceId): Promise<AmazonListingRunView>
  setRule(
    workspace_id: WorkspaceId,
    patch: AmazonListingRulePatch,
  ): MaybePromise<{ ok: boolean; problems?: string[]; rule?: ListingRule }>
}

const READ = {
  domain: 'product',
  op: 'read',
  range: 'assigned',
  sensitivity: 'internal',
} as const

function portOf(deps: GatewayDeps): AmazonListingPort {
  const p = deps.amazonListing
  if (p === undefined)
    throw new ApiError('not_implemented', '这个本机服务版本还没有 Listing 体检。')
  return p
}

const ruleSchema = z
  .object({
    rule_id: z.string().min(1).max(80).optional(),
    params: z.record(z.string(), z.unknown()).optional(),
    enabled: z.boolean().optional(),
    checked_at: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    own_sellers: z.array(z.string().max(120)).max(10).optional(),
  })
  .strict()

/** 去掉 zod 留下的 `undefined` 格（exactOptionalPropertyTypes）。 */
const clean = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

export function amazonListingRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/amazon-listing',
        operationId: 'amazonListingView',
        summary:
          'Listing 体检：最近一次结果、自家 ASIN 几个、规则表（出处 + 核对日期 + 建议值）、这里能不能读 Amazon 前台',
        tag: 'store',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'ListingCheckupView',
      },
      async (c, deps) => ok(c, await portOf(deps).view(principalOf(c).workspace_id)),
    ),
    route(
      {
        method: 'post',
        path: '/v1/amazon-listing/run',
        operationId: 'runAmazonListingCheckup',
        summary:
          '现在体检一次：读自家 ASIN 的前台商品页（被拦就停、不绕），按规则表判，只出建议、不改 Amazon',
        tag: 'store',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'AmazonListingRunView',
      },
      async (c, deps) => ok(c, await portOf(deps).run(principalOf(c).workspace_id)),
    ),
    route(
      {
        method: 'put',
        path: '/v1/amazon-listing/rules',
        operationId: 'updateAmazonListingRule',
        summary:
          '改 Listing 体检的一条规则（建议值 / 开关 / 核对日期），或记下自家店铺名（判购物车是不是你）',
        tag: 'store',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        body: ruleSchema,
        returns: '{ ok: boolean; problems?: string[]; rule?: ListingRule }',
      },
      async (c, deps) => {
        const patch = clean(await body(c, ruleSchema)) as AmazonListingRulePatch
        return ok(c, await portOf(deps).setRule(principalOf(c).workspace_id, patch))
      },
    ),
  ]
}
