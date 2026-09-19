/**
 * WP119（68）：**浏览器插件的本地一面** `/v1/extension/*`。
 *
 * 插件的数据走本地，不走云。所以这条路上有两种调用方，判权方式完全不同：
 *
 * - **工作台（所有者）**：`POST /v1/extension/pairings` 出一个 6 位码、
 *   `GET /v1/extension/tokens` 看已配的几把、`POST …/revoke` 撤一把。
 *   走网关那套 Bearer + `X-Assignment`，域是 `store_config`（与连接页同一把闸）。
 * - **插件自己**：`POST /v1/extension/pair` 用码换令牌、
 *   `POST /v1/extension/observations` 报一批观测、`GET /v1/extension/hello` 问状态。
 *   这三条**不走网关鉴权**（`auth: 'public'`），因为插件令牌不是身份 token：
 *   它只有三个动作、绑死一个扩展 id、在 {@link ExtensionStore} 里自成一张表。
 *   判权在处理器里做，**Origin 与令牌同时对**才算通过。
 *
 * 为什么不需要 CORS：MV3 里只有 background service worker 能发这些请求
 * （它持有 `host_permissions`，跨源不受 CORS 检查），content script 一律经它转发。
 * 于是这台机器上不存在「通配 CORS」这件事——一个不在白名单里的网页
 * 连预检都发不出来。
 */

import type { Iso8601, KolChannel, MaybePromise } from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import type { ExtensionScope, ExtensionSession, ExtensionStore } from '../extension-store.js'
import { body, ok, param, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'

/** 插件报上来的一条观测。字段就是这几个——**正文、评论、私信一个都没有**。 */
export interface ExtensionObservation {
  channel: KolChannel
  /** 平台上的 handle（YouTube 保留前导 `@`）。 */
  handle: string
  external_id?: string | undefined
  display_name?: string | undefined
  url?: string | undefined
  avatar_url?: string | undefined
  followers?: number | undefined
  /** 页面上原样渲染的那串（`1.2万位订阅者`）——解析对不对由服务端再判一次。 */
  followers_text?: string | undefined
  avg_views?: number | undefined
  video_count?: number | undefined
  country?: string | undefined
  bio?: string | undefined
  /** 用户显式点过「收下这个邮箱」才有；明文当场进本机加密库。 */
  contact?: { kind: 'email' | 'dm' | 'phone' | 'form'; value: string; source?: string } | undefined
  observed_at: Iso8601
  page_url?: string | undefined
  source: 'channel_page' | 'content_page' | 'search_results'
}

export type ExtensionIngestStatus = 'ok' | 'deduped' | 'invalid'

export interface ExtensionIngestRow {
  handle: string
  status: ExtensionIngestStatus
  creator_id?: string
  reason?: string
}

export interface ExtensionIngestResult {
  rows: ExtensionIngestRow[]
  /** 这一批里有几条同时转发去了云端公共红人库（未登录 = 0）。 */
  forwarded_to_public_library: number
}

/** 插件开屏那一行要的全部事实。 */
export interface ExtensionHello {
  workspace_id: string
  workspace_name: string
  /** 关联了 agentsws 云账号 = 观测默认共享到公共红人库。 */
  cloud_linked: boolean
  shares_to_public_library: boolean
  scopes: ExtensionScope[]
  server_version: string
}

export interface ExtensionPort {
  store: ExtensionStore
  ingest(
    session: ExtensionSession,
    input: { observations: ExtensionObservation[] },
  ): MaybePromise<ExtensionIngestResult>
  hello(session: ExtensionSession): MaybePromise<ExtensionHello>
}

const MANAGE = {
  domain: 'store_config',
  op: 'write',
  range: 'workspace',
  sensitivity: 'confidential',
} as const
const READ = { ...MANAGE, op: 'read' } as const

function portOf(deps: GatewayDeps): ExtensionPort {
  const p = deps.extension
  if (p === undefined)
    throw new ApiError(
      'not_implemented',
      '这个服务进程没有装配浏览器插件的本地一面（GatewayDeps.extension）。插件配不上对，工作台其余一切照常。',
    )
  return p
}

/**
 * 插件令牌 + Origin 双校验。
 *
 * 失败一律 `unauthenticated` 且**不区分原因**（码错了 / 撤了 / 过期了 / Origin 不对
 * 都是同一句）——区分等于给人一台探测机。
 */
function sessionOf(c: Parameters<Route['handler']>[0], deps: GatewayDeps): ExtensionSession {
  const raw = c.req.header('Authorization') ?? ''
  const session = portOf(deps).store.authenticate(raw, c.req.header('Origin'))
  if (session === undefined)
    throw new ApiError('unauthenticated', '插件令牌无效、已撤销、已过期，或不是从配对时那个扩展发来的')
  return session
}

const contactSchema = z.object({
  kind: z.enum(['email', 'dm', 'phone', 'form']),
  value: z.string().min(1).max(320),
  source: z.string().max(300).optional(),
})

/**
 * 观测的**白名单**。`.strict()` 不是洁癖：多一个键整批拒，是因为
 * 一条带正文的观测是一个信号，悄悄丢掉它等于把信号也丢了（同 48 §5.3）。
 */
const observationSchema = z
  .object({
    channel: z.enum(['youtube', 'instagram', 'tiktok', 'facebook', 'x']),
    handle: z.string().min(1).max(120),
    external_id: z.string().max(120).optional(),
    display_name: z.string().max(200).optional(),
    url: z.string().max(600).optional(),
    avatar_url: z.string().max(600).optional(),
    followers: z.number().int().nonnegative().optional(),
    followers_text: z.string().max(120).optional(),
    avg_views: z.number().nonnegative().optional(),
    video_count: z.number().int().nonnegative().optional(),
    country: z.string().max(80).optional(),
    bio: z.string().max(2000).optional(),
    contact: contactSchema.optional(),
    observed_at: z.string().min(1),
    page_url: z.string().max(600).optional(),
    source: z.enum(['channel_page', 'content_page', 'search_results']),
  })
  .strict()

/** 一批最多 100 条（插件自己按 20 条分块发，100 是给别的调用方留的上限）。 */
const ingestSchema = z.object({ observations: z.array(observationSchema).min(1).max(100) })

const pairSchema = z.object({ code: z.string().min(1).max(12) })

const pairingSchema = z.object({ label: z.string().min(1).max(60).optional() })

export function extensionRoutes(): Route[] {
  return [
    route(
      {
        method: 'post',
        path: '/v1/extension/pairings',
        operationId: 'createExtensionPairing',
        summary: '出一个 6 位配对码（5 分钟、一次性；再按一下上一码作废）',
        tag: 'extension',
        auth: 'bearer',
        assignment: true,
        authz: MANAGE,
        body: pairingSchema,
        returns: 'PairingView',
      },
      async (c, deps) => {
        const p = principalOf(c)
        const input = await body(c, pairingSchema)
        return ok(
          c,
          portOf(deps).store.createPairing({
            workspace_id: p.workspace_id,
            person_id: p.person_id,
            ...(input.label === undefined ? {} : { label: input.label }),
          }),
        )
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/extension/tokens',
        operationId: 'listExtensionTokens',
        summary: '已配上的插件（扩展 id、最近使用时间、撤销状态）',
        tag: 'extension',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: '{ tokens: ExtensionTokenView[] }',
      },
      async (c, deps) =>
        ok(c, { tokens: portOf(deps).store.list(principalOf(c).workspace_id) }),
    ),
    route(
      {
        method: 'post',
        path: '/v1/extension/tokens/:id/revoke',
        operationId: 'revokeExtensionToken',
        summary: '撤一把插件令牌（写 revoked_at，不删行）',
        tag: 'extension',
        auth: 'bearer',
        assignment: true,
        authz: MANAGE,
        returns: 'ExtensionTokenView',
      },
      async (c, deps) => {
        const view = portOf(deps).store.revoke(principalOf(c).workspace_id, param(c, 'id'))
        if (view === undefined) throw new ApiError('not_found', '没有这把插件令牌')
        return ok(c, view)
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/extension/pair',
        operationId: 'redeemExtensionPairing',
        summary: '插件用 6 位码换一把只给它用的令牌（Origin 必须是扩展自己的）',
        tag: 'extension',
        auth: 'public',
        body: pairSchema,
        returns: 'RedeemedToken',
      },
      async (c, deps) => {
        const input = await body(c, pairSchema)
        const out = portOf(deps).store.redeem({
          code: input.code,
          origin: c.req.header('Origin'),
        })
        if (!out.ok) {
          // Origin 不对是「你不是扩展」，其余都是「码不对」——两句人话，不给码。
          if (out.reason === 'bad_origin')
            throw new ApiError('forbidden', '这条只给浏览器扩展用（Origin 必须是 chrome-extension://…）')
          throw new ApiError('unauthenticated', '配对码不对、已经用过，或已经过期了。回工作台再生成一个。')
        }
        return ok(c, out.issued)
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/extension/hello',
        operationId: 'extensionHello',
        summary: '插件问状态：这是哪个品牌、登录了没有、观测会不会上公共库',
        tag: 'extension',
        auth: 'public',
        returns: 'ExtensionHello',
      },
      async (c, deps) => ok(c, await portOf(deps).hello(sessionOf(c, deps))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/extension/observations',
        operationId: 'ingestExtensionObservations',
        summary: '插件报一批观测（写本地红人库；登录态同时转发到公共红人库）',
        tag: 'extension',
        auth: 'public',
        body: ingestSchema,
        returns: 'ExtensionIngestResult',
      },
      async (c, deps) => {
        const session = sessionOf(c, deps)
        if (!session.scopes.includes('kol.observe'))
          throw new ApiError('forbidden', '这把令牌没有 kol.observe')
        const input = await body(c, ingestSchema)
        return ok(c, await portOf(deps).ingest(session, input as { observations: ExtensionObservation[] }))
      },
    ),
  ]
}
