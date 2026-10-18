/**
 * WP392（docs/104）：**竞品监控**的工作台路由（Bearer + `X-Assignment`）。
 *
 * - `GET /v1/competitor-watch`：各监控源状态（连接卡「5 家 · 1 家没读到」）、下次读的时刻（计划卡）、最近一轮；
 * - `GET /v1/competitor-watch/changes`：竞品变化表（报表卡；按竞品 / 种类 / 来源 / 时间窗筛）；
 * - `PUT /v1/competitor-watch/settings`：改频率（决策 668：只给默认值，用户能改）；
 * - `POST /v1/competitor-watch/run`：现在读一次。
 *
 * 竞品清单本身不在这里改（C3：唯一工作清单是 GEO 关注设置那份，`PUT /v1/seo/watch`）。
 * 权限：店铺管理与 Amazon 店铺运营都读商品（`product` read）；改频率、现在读一次只动本机、只读外部公开页面，同一把闸。
 */
import {
  type AmazonOwnBrowserConsent,
  COMPETITOR_CHANGE_KINDS,
  type CompetitorChange,
  type CompetitorChangeKind,
  type CompetitorChangeQuery,
  type CompetitorSourceKind,
  type CompetitorWatchRun,
  type CompetitorWatchSettings,
  type CompetitorWatchView,
  type Iso8601,
  type MaybePromise,
  type WorkspaceId,
} from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { body, ok, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'

/** 变化表的一行：变化本身 + 服务端拼好的一句人话（中英各一句；不提任何数据供应商名）。 */
export type CompetitorChangeRow = CompetitorChange & { text: { zh: string; en: string } }

export interface CompetitorWatchPort {
  view(workspace_id: WorkspaceId): MaybePromise<CompetitorWatchView>
  changes(
    workspace_id: WorkspaceId,
    query: CompetitorChangeQuery,
  ): MaybePromise<CompetitorChangeRow[]>
  updateSettings(
    workspace_id: WorkspaceId,
    patch: Partial<CompetitorWatchSettings>,
  ): MaybePromise<CompetitorWatchSettings>
  runNow(workspace_id: WorkspaceId): Promise<CompetitorWatchRun>
  /**
   * WP402（决策 1140 / 1146）：Amazon 走你自己的浏览器——设置里同意 / 撤回（撤回 = 不用、不再问）。
   * 没装这一块的本机服务没有这一口。
   */
  setOwnBrowserConsent?(
    workspace_id: WorkspaceId,
    consent: 'granted' | 'revoked',
  ): MaybePromise<AmazonOwnBrowserConsent>
}

const READ = {
  domain: 'product',
  op: 'read',
  range: 'assigned',
  sensitivity: 'internal',
} as const

function portOf(deps: GatewayDeps): CompetitorWatchPort {
  const p = deps.competitorWatch
  if (p === undefined) throw new ApiError('not_implemented', '这个本机服务版本还没有竞品监控。')
  return p
}

const settingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    every_hours: z.number().int().min(1).max(336).optional(),
    day_start_hour: z.number().int().min(0).max(23).optional(),
    new_within_days: z.number().int().min(1).max(90).optional(),
  })
  .strict()

const ownBrowserSchema = z.object({ consent: z.enum(['granted', 'revoked']) }).strict()

const isoOf = (raw: string | undefined, name: string): Iso8601 | undefined => {
  if (raw === undefined || raw === '') return undefined
  const t = Date.parse(raw)
  if (Number.isNaN(t)) throw new ApiError('invalid_input', `${name} 不是时间`)
  return new Date(t).toISOString()
}

/** 交回来的 → 端口要的（去掉 zod 留下的 `undefined` 格：exactOptionalPropertyTypes）。 */
const clean = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

export function competitorWatchRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/competitor-watch',
        operationId: 'competitorWatchView',
        summary: '竞品监控：各监控源状态（没读到的照实说）、下次读的时刻、最近一轮',
        tag: 'store',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'CompetitorWatchView',
      },
      async (c, deps) => ok(c, await portOf(deps).view(principalOf(c).workspace_id)),
    ),
    route(
      {
        method: 'get',
        path: '/v1/competitor-watch/changes',
        operationId: 'listCompetitorChanges',
        summary: '竞品变化表（新的在前）：上新 / 下架 / 改价 / 打折 / 断货 / 评分 / 评论数 / 排名',
        tag: 'store',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [
          { name: 'competitor', in: 'query', description: '竞品 id' },
          { name: 'kind', in: 'query', description: '变化种类（逗号隔开）' },
          { name: 'source', in: 'query', description: 'shop / amazon' },
          { name: 'since', in: 'query', description: 'ISO 时间（含）' },
          { name: 'until', in: 'query', description: 'ISO 时间（不含）' },
          { name: 'limit', in: 'query', description: '最多几条（默认 500）' },
        ],
        returns: '{ changes: CompetitorChangeRow[] }',
      },
      async (c, deps) => {
        const q: CompetitorChangeQuery = {}
        const competitor = c.req.query('competitor')
        if (competitor !== undefined && competitor !== '') q.competitor_id = competitor
        const kind = c.req.query('kind')
        if (kind !== undefined && kind !== '') {
          const kinds = kind.split(',').map((k) => k.trim())
          const bad = kinds.find((k) => !(COMPETITOR_CHANGE_KINDS as readonly string[]).includes(k))
          if (bad !== undefined) throw new ApiError('invalid_input', `kind 不认识：${bad}`)
          q.kinds = kinds as CompetitorChangeKind[]
        }
        const source = c.req.query('source')
        if (source !== undefined && source !== '') {
          const map: Record<string, CompetitorSourceKind> = {
            shop: 'shop_catalog',
            amazon: 'amazon_asin',
          }
          const kindOf = map[source]
          if (kindOf === undefined) throw new ApiError('invalid_input', 'source 只认 shop / amazon')
          q.source_kind = kindOf
        }
        const since = isoOf(c.req.query('since'), 'since')
        if (since !== undefined) q.since = since
        const until = isoOf(c.req.query('until'), 'until')
        if (until !== undefined) q.until = until
        const limit = Number(c.req.query('limit') ?? '')
        if (Number.isInteger(limit) && limit > 0) q.limit = Math.min(limit, 2000)
        return ok(c, { changes: await portOf(deps).changes(principalOf(c).workspace_id, q) })
      },
    ),
    route(
      {
        method: 'put',
        path: '/v1/competitor-watch/settings',
        operationId: 'updateCompetitorWatchSettings',
        summary: '改竞品监控的频率（隔几小时读一次、本地几点后读、上新看最近几天、总开关）',
        tag: 'store',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        body: settingsSchema,
        returns: 'CompetitorWatchSettings',
      },
      async (c, deps) => {
        const patch = clean(await body(c, settingsSchema)) as Partial<CompetitorWatchSettings>
        return ok(c, await portOf(deps).updateSettings(principalOf(c).workspace_id, patch))
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/competitor-watch/run',
        operationId: 'runCompetitorWatch',
        summary: '现在读一次（正在跑的那一轮没结束就等它）',
        tag: 'store',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'CompetitorWatchRun',
      },
      async (c, deps) => ok(c, await portOf(deps).runNow(principalOf(c).workspace_id)),
    ),
    route(
      {
        method: 'put',
        path: '/v1/competitor-watch/own-browser',
        operationId: 'setCompetitorOwnBrowserConsent',
        summary:
          'Amazon 读不到时用你自己的浏览器读（只读、每家每天至多一次）：同意 / 撤回（撤回 = 不用、不再问）',
        tag: 'store',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        body: ownBrowserSchema,
        returns: 'AmazonOwnBrowserConsent',
      },
      async (c, deps) => {
        const { consent } = await body(c, ownBrowserSchema)
        const set = portOf(deps).setOwnBrowserConsent
        if (set === undefined)
          throw new ApiError(
            'not_implemented',
            '这个本机服务版本没有「用你自己的浏览器读」这一项。',
          )
        return ok(c, await set(principalOf(c).workspace_id, consent))
      },
    ),
  ]
}
