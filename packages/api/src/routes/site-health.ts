/**
 * WP381（决策 1066）：网站 / 商品体检与 AI 来源流量的 HTTP 投影。
 *
 * | 路由 | 是什么 |
 * |---|---|
 * | `GET /v1/site-health` | 最近一次体检、近 7 天 AI 来源流量（实测）、体检设置 |
 * | `POST /v1/site-health/run` | 现在体检一次（只读：只 GET 公开页面、只读店铺；不一致交给网站运营开一件事） |
 * | `POST /v1/site-health/ai-traffic` | 现在重算一次 AI 来源流量 |
 * | `PUT /v1/site-health/settings` | 改设置：商品 feed、各平台上架页、抽查几件、AI 爬虫 / AI 来源清单的加减 |
 * | `POST /v1/site-health/drift` | WP448：现在比一次改版回归（只读；严重的交给建站开一件事） |
 */
import type {
  AiTrafficSummary,
  MaybePromise,
  SeoDriftView,
  SiteHealthRun,
  SiteHealthSettings,
} from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { body, ok, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'

const READ = { domain: 'content', op: 'read', range: 'assigned', sensitivity: 'internal' } as const
const STAGE = { ...READ, op: 'stage' } as const
const TAG = 'site-health'

export interface SiteHealthActor {
  workspace_id: string
  person_id: string
}

export interface SiteHealthView {
  run?: SiteHealthRun
  ai_traffic?: AiTrafficSummary
  settings: SiteHealthSettings
  /** WP448：改版回归（最近一次与最近一次有发现的那一次）。 */
  drift?: SeoDriftView
}

export interface SiteHealthPort {
  view(actor: SiteHealthActor): MaybePromise<SiteHealthView>
  run(actor: SiteHealthActor): MaybePromise<SiteHealthView>
  aiTraffic(actor: SiteHealthActor): MaybePromise<SiteHealthView>
  saveSettings(actor: SiteHealthActor, input: SiteHealthSettings): MaybePromise<SiteHealthView>
  /** WP448：现在比一次改版回归（没接的宿主不给 = 路由回 404 那一类错）。 */
  drift?(actor: SiteHealthActor): MaybePromise<SiteHealthView>
}

const Crawler = z.object({
  token: z.string().trim().min(1).max(80),
  vendor: z.string().trim().min(1).max(80),
  purpose: z.enum(['search', 'user', 'training']),
  platform: z.string().trim().min(1).max(80).optional(),
})
const Referrer = z.object({
  platform: z.string().trim().min(1).max(80),
  hosts: z.array(z.string().trim().min(3).max(120)).min(1).max(10),
  utm_sources: z.array(z.string().trim().min(1).max(80)).max(10).optional(),
})
const httpUrl = z
  .string()
  .trim()
  .url()
  .refine((u) => /^https?:\/\//i.test(u), '只收 http / https 网址')
const SettingsBody = z.object({
  feed_url: httpUrl.optional(),
  listings: z
    .array(
      z.object({
        handle: z.string().trim().min(1).max(200),
        platform: z.string().trim().min(1).max(60),
        url: httpUrl,
      }),
    )
    .max(50)
    .optional(),
  sample_products: z.number().int().min(1).max(20).optional(),
  crawlers_add: z.array(Crawler).max(50).optional(),
  crawlers_remove: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
  referrers_add: z.array(Referrer).max(30).optional(),
  referrers_remove: z.array(z.string().trim().min(1).max(80)).max(30).optional(),
})

function portOf(deps: GatewayDeps): SiteHealthPort {
  const p = deps.siteHealth
  if (p === undefined)
    throw new ApiError('not_implemented', '这个服务进程没有装配网站体检（GatewayDeps.siteHealth）')
  return p
}

const actorOf = (c: Parameters<typeof principalOf>[0]): SiteHealthActor => {
  const p = principalOf(c)
  return { workspace_id: p.workspace_id, person_id: p.person_id }
}

/** zod 的可选格给的是 `undefined`，契约是 exactOptional——去掉没给的那几格。 */
const compact = <T extends Record<string, unknown>>(x: T): T =>
  Object.fromEntries(Object.entries(x).filter(([, v]) => v !== undefined)) as T

export function siteHealthRoutes(): Route[] {
  const spec = (
    method: 'get' | 'post' | 'put',
    path: string,
    operationId: string,
    summary: string,
    write = false,
  ) => ({
    method,
    path,
    operationId,
    summary,
    tag: TAG,
    auth: 'bearer' as const,
    assignment: true,
    authz: write ? STAGE : READ,
    returns: 'SiteHealthView',
  })
  return [
    route(
      spec(
        'get',
        '/v1/site-health',
        'getSiteHealth',
        '最近一次网站 / 商品体检、AI 来源流量（实测）与体检设置（WP381）',
      ),
      async (c, deps) => ok(c, await portOf(deps).view(actorOf(c))),
    ),
    route(
      spec(
        'post',
        '/v1/site-health/run',
        'runSiteHealth',
        '现在体检一次（只读：只 GET 公开页面、只读店铺；不一致交给网站运营）',
      ),
      async (c, deps) => ok(c, await portOf(deps).run(actorOf(c))),
    ),
    route(
      spec(
        'post',
        '/v1/site-health/ai-traffic',
        'refreshAiTraffic',
        '现在重算近 7 天 AI 来源流量（Shopify 自己记的来源，实测）',
      ),
      async (c, deps) => ok(c, await portOf(deps).aiTraffic(actorOf(c))),
    ),
    route(
      spec(
        'post',
        '/v1/site-health/drift',
        'runSiteDrift',
        '现在比一次改版回归（首页 / 两件商品 / 一个合集 / 一篇文章，与上一次基线比；只读，严重的交给建站）（WP448）',
      ),
      async (c, deps) => {
        const port = portOf(deps)
        if (port.drift === undefined)
          throw new ApiError('not_implemented', '这个服务进程没有装配改版回归')
        return ok(c, await port.drift(actorOf(c)))
      },
    ),
    route(
      {
        ...spec(
          'put',
          '/v1/site-health/settings',
          'saveSiteHealthSettings',
          '改体检设置：商品 feed、各平台上架页、抽查几件、两张清单的加减',
          true,
        ),
        body: SettingsBody,
      },
      async (c, deps) => {
        const input = await body(c, SettingsBody)
        const clean = compact({
          ...input,
          ...(input.crawlers_add === undefined
            ? {}
            : { crawlers_add: input.crawlers_add.map(compact) }),
          ...(input.referrers_add === undefined
            ? {}
            : { referrers_add: input.referrers_add.map(compact) }),
        }) as SiteHealthSettings
        return ok(c, await portOf(deps).saveSettings(actorOf(c), clean))
      },
    ),
  ]
}
