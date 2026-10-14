/**
 * WP328（docs/102，Luoye 10-14 定）：**Reddit 每日巡查**的路由。
 *
 * - **插件**（插件令牌 + Origin，scope `reddit.read`）：定时来问有没有要读的（`next`），读完交回（`result`）。
 *   还是插件主动找本机；本机服务永远不能伸手进浏览器。老令牌没有 `reddit.read`——重新配一次对就有了。
 * - **工作台**（Bearer + `X-Assignment`）：看状态与待处理、改设置、现在巡查一次、标「不回」、拿一周汇总（WP330）。
 */

import type { RedditReadNextResponse, RedditReadResultInput } from '@agentsws/browser-action'
import type {
  Iso8601,
  MaybePromise,
  RedditWatchDigest,
  RedditWatchEntry,
  RedditWatchItemStatus,
  RedditWatchRun,
  RedditWatchSettings,
  RedditWatchSource,
  RedditWatchView,
  WorkspaceId,
} from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import type { ExtensionSession } from '../extension-store.js'
import { body, ok, param, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'
import { extensionSessionOf } from './extension.js'

export interface RedditWatchItemsQuery {
  source?: RedditWatchSource
  status?: RedditWatchItemStatus
  reply?: boolean
  since?: Iso8601
  until?: Iso8601
  limit?: number
}

export interface RedditWatchPort {
  /* ── 插件 ─────────────────────────────────────────────────────────── */
  next(
    session: ExtensionSession,
    input: { connected: boolean },
  ): MaybePromise<RedditReadNextResponse>
  result(
    session: ExtensionSession,
    id: string,
    input: RedditReadResultInput,
  ): MaybePromise<{ accepted: true } | undefined>
  /* ── 工作台 ───────────────────────────────────────────────────────── */
  view(workspace_id: WorkspaceId): MaybePromise<RedditWatchView>
  updateSettings(
    workspace_id: WorkspaceId,
    patch: Partial<RedditWatchSettings>,
  ): MaybePromise<RedditWatchSettings>
  runNow(workspace_id: WorkspaceId): Promise<RedditWatchRun>
  items(workspace_id: WorkspaceId, query: RedditWatchItemsQuery): MaybePromise<RedditWatchEntry[]>
  setStatus(
    workspace_id: WorkspaceId,
    id: string,
    status: RedditWatchItemStatus,
  ): MaybePromise<RedditWatchEntry | undefined>
  digest(
    workspace_id: WorkspaceId,
    window?: { since: Iso8601; until: Iso8601 },
  ): MaybePromise<RedditWatchDigest>
}

const READ = {
  domain: 'community_thread',
  op: 'read',
  range: 'assigned',
  sensitivity: 'internal',
} as const
const STAGE = { ...READ, op: 'stage' } as const

function portOf(deps: GatewayDeps): RedditWatchPort {
  const p = deps.redditWatch
  if (p === undefined) throw new ApiError('not_implemented', '这个本机服务版本还没有 Reddit 巡查。')
  return p
}

function extActorOf(c: Parameters<Route['handler']>[0], deps: GatewayDeps): ExtensionSession {
  const session = extensionSessionOf(c, deps)
  if (!session.scopes.includes('reddit.read'))
    throw new ApiError(
      'forbidden',
      '这把配对还没有读 Reddit 的权限。在工作台重新生成配对码、插件里再配一次。',
    )
  return session
}

const missing = (): never => {
  throw new ApiError('not_found', '没有这一件，或者它已经结束了。')
}

const FULLNAME = /^t[1-6]_[a-z0-9]{1,13}$/u
const itemSchema = z
  .object({
    name: z.string().regex(FULLNAME),
    kind: z.enum(['post', 'comment', 'message']),
    author: z.string().max(40).optional(),
    subreddit: z.string().max(30).optional(),
    title: z.string().max(300).optional(),
    text: z.string().max(4_000),
    url: z.string().max(2_000).optional(),
    parent_id: z.string().max(20).optional(),
    link_id: z.string().max(20).optional(),
    link_title: z.string().max(300).optional(),
    inbox_type: z.enum(['comment_reply', 'post_reply', 'username_mention', 'message']).optional(),
    created_utc: z.number().finite(),
    score: z.number().finite().optional(),
    num_comments: z.number().finite().optional(),
    deleted: z.literal(true).optional(),
  })
  .strict()

const resultSchema = z
  .object({
    outcome: z.enum(['done', 'not_logged_in', 'wrong_user', 'blocked', 'failed', 'stopped']),
    message: z.string().max(600),
    user: z.string().max(40).optional(),
    parts: z
      .array(
        z
          .object({
            key: z.string().min(1).max(80),
            ok: z.boolean(),
            items: z.array(itemSchema).max(500),
            pages: z.number().int().min(0).max(10),
            reached_stop: z.boolean(),
            message: z.string().max(600).optional(),
            // WP329（决策 764）：`sub_rules` 那一路读到的版规
            rules: z.array(z.string().max(600)).max(30).optional(),
          })
          .strict(),
      )
      .max(12),
  })
  .strict()

const settingsSchema = z
  .object({
    own_subreddits: z.array(z.string().max(80)).max(10).optional(),
    keywords: z.array(z.string().max(60)).max(30).optional(),
    brand_username: z.string().max(40).optional(),
    every_hours: z.number().int().min(1).max(168).optional(),
    day_start_hour: z.number().int().min(0).max(23).optional(),
    keyword_limit: z.number().int().min(1).max(50).optional(),
    enabled: z.boolean().optional(),
  })
  .strict()

const statusSchema = z
  .object({ status: z.enum(['open', 'drafting', 'done', 'dismissed']) })
  .strict()

const SOURCES = new Set(['inbox', 'own_sub', 'external'])
const STATUSES = new Set(['open', 'drafting', 'done', 'dismissed'])
const isoOf = (raw: string | undefined, name: string): Iso8601 | undefined => {
  if (raw === undefined || raw === '') return undefined
  const t = Date.parse(raw)
  if (Number.isNaN(t)) throw new ApiError('invalid_input', `${name} 不是时间`)
  return new Date(t).toISOString()
}

/** 交回来的 → 端口要的（去掉 zod 留下的 `undefined` 格：exactOptionalPropertyTypes）。 */
function clean<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

export function redditWatchRoutes(): Route[] {
  return [
    /* ── 插件 ─────────────────────────────────────────────────────────── */
    route(
      {
        method: 'get',
        path: '/v1/extension/reddit/next',
        operationId: 'extensionRedditNext',
        summary:
          '插件来问有没有要读的 Reddit（只读：收件箱 mark=false、自家版块）；connected=0 = 还没连 Reddit',
        tag: 'extension',
        auth: 'public',
        params: [{ name: 'connected', in: 'query', description: '1 = 插件里连上 Reddit 了' }],
        returns: 'RedditReadNextResponse',
      },
      async (c, deps) => {
        const session = extActorOf(c, deps)
        return ok(
          c,
          await portOf(deps).next(session, { connected: c.req.query('connected') === '1' }),
        )
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/extension/reddit/:id/result',
        operationId: 'extensionRedditResult',
        summary: '插件交回读到的条目（没登录 / 号不对 / 被拦都照实回）',
        tag: 'extension',
        auth: 'public',
        body: resultSchema,
        returns: '{ accepted: true }',
      },
      async (c, deps) => {
        const session = extActorOf(c, deps)
        const input = clean(await body(c, resultSchema)) as RedditReadResultInput
        return ok(c, (await portOf(deps).result(session, param(c, 'id'), input)) ?? missing())
      },
    ),

    /* ── 工作台 ───────────────────────────────────────────────────────── */
    route(
      {
        method: 'get',
        path: '/v1/reddit-watch',
        operationId: 'redditWatchView',
        summary: 'Reddit 巡查：设置、插件状态、最近一次、待处理（要回还没回的）',
        tag: 'social',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'RedditWatchView',
      },
      async (c, deps) => ok(c, await portOf(deps).view(principalOf(c).workspace_id)),
    ),
    route(
      {
        method: 'put',
        path: '/v1/reddit-watch/settings',
        operationId: 'updateRedditWatchSettings',
        summary: '改巡查设置（自家版块、关键词、品牌号、频率）',
        tag: 'social',
        auth: 'bearer',
        assignment: true,
        authz: STAGE,
        body: settingsSchema,
        returns: 'RedditWatchSettings',
      },
      async (c, deps) => {
        const patch = clean(await body(c, settingsSchema)) as Partial<RedditWatchSettings>
        return ok(c, await portOf(deps).updateSettings(principalOf(c).workspace_id, patch))
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/reddit-watch/run',
        operationId: 'runRedditWatch',
        summary: '现在巡查一次（正在跑的那一轮没结束就回那一轮）',
        tag: 'social',
        auth: 'bearer',
        assignment: true,
        authz: STAGE,
        returns: 'RedditWatchRun',
      },
      async (c, deps) => ok(c, await portOf(deps).runNow(principalOf(c).workspace_id)),
    ),
    route(
      {
        method: 'get',
        path: '/v1/reddit-watch/items',
        operationId: 'listRedditWatchItems',
        summary: '巡查到的条目（按发帖时间，新的在前）',
        tag: 'social',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [
          { name: 'source', in: 'query', description: 'inbox / own_sub / external' },
          { name: 'status', in: 'query', description: 'open / drafting / done / dismissed' },
          { name: 'reply', in: 'query', description: '1 = 只要要回的' },
          { name: 'since', in: 'query', description: 'ISO 时间（含）' },
          { name: 'until', in: 'query', description: 'ISO 时间（不含）' },
          { name: 'limit', in: 'query', description: '最多几条（默认 200）' },
        ],
        returns: '{ items: RedditWatchEntry[] }',
      },
      async (c, deps) => {
        const q: RedditWatchItemsQuery = {}
        const source = c.req.query('source')
        if (source !== undefined && source !== '') {
          if (!SOURCES.has(source)) throw new ApiError('invalid_input', 'source 不对')
          q.source = source as RedditWatchSource
        }
        const status = c.req.query('status')
        if (status !== undefined && status !== '') {
          if (!STATUSES.has(status)) throw new ApiError('invalid_input', 'status 不对')
          q.status = status as RedditWatchItemStatus
        }
        const reply = c.req.query('reply')
        if (reply === '1' || reply === '0') q.reply = reply === '1'
        const since = isoOf(c.req.query('since'), 'since')
        if (since !== undefined) q.since = since
        const until = isoOf(c.req.query('until'), 'until')
        if (until !== undefined) q.until = until
        const limit = Number(c.req.query('limit') ?? '')
        if (Number.isInteger(limit) && limit > 0) q.limit = Math.min(limit, 2000)
        return ok(c, { items: await portOf(deps).items(principalOf(c).workspace_id, q) })
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/reddit-watch/items/:id/status',
        operationId: 'setRedditWatchItemStatus',
        summary: '标一条：不回 / 回过了 / 起草中 / 重新打开',
        tag: 'social',
        auth: 'bearer',
        assignment: true,
        authz: STAGE,
        body: statusSchema,
        returns: 'RedditWatchEntry',
      },
      async (c, deps) => {
        const input = await body(c, statusSchema)
        const out = await portOf(deps).setStatus(
          principalOf(c).workspace_id,
          param(c, 'id'),
          input.status,
        )
        return ok(c, out ?? missing())
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/reddit-watch/digest',
        operationId: 'redditWatchDigest',
        summary: '一周汇总（周报用；不给窗口 = 本周日 00:00 到现在）',
        tag: 'social',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [
          { name: 'since', in: 'query', description: 'ISO 时间' },
          { name: 'until', in: 'query', description: 'ISO 时间' },
        ],
        returns: 'RedditWatchDigest',
      },
      async (c, deps) => {
        const since = isoOf(c.req.query('since'), 'since')
        const until = isoOf(c.req.query('until'), 'until')
        if ((since === undefined) !== (until === undefined))
          throw new ApiError('invalid_input', 'since 和 until 要一起给')
        const ws = principalOf(c).workspace_id
        return ok(
          c,
          await portOf(deps).digest(
            ws,
            since === undefined || until === undefined ? undefined : { since, until },
          ),
        )
      },
    ),
  ]
}
