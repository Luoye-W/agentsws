/**
 * WP406（私有 docs/107 §5）：**岗位更新**——第三栏「设定 · 岗位更新」与「挑着看」的 HTTP 投影。
 *
 * | 路由 | 是什么 |
 * |---|---|
 * | `GET /v1/content-updates/positions/:position_id` | 这个岗位：三档设置、订阅、等着的几项、应用过的、最近一批、没订阅那一行小字 |
 * | `PUT /v1/content-updates/positions/:position_id/policy` | 每次问我 / 没撞的自动应用 / 不再更新 |
 * | `GET /v1/content-updates/positions/:position_id/items/:item_id/diff` | 一项按段 / 按条的改动（原来 / 新版 / 你的） |
 * | `POST /v1/content-updates/positions/:position_id/apply` | 挑着应用（不给条目 = 全部）；撞了的那几处怎么选 |
 * | `POST /v1/content-updates/positions/:position_id/skip` | 这次跳过（下周的卡一起带上） |
 * | `POST /v1/content-updates/positions/:position_id/ai-merge` | AI 合一版（只出，不落） |
 * | `POST /v1/content-updates/positions/:position_id/rollback` | 整批退回 / 单项退回 |
 * | `POST /v1/content-updates/positions/:position_id/nudge/dismiss` | 没订阅那一行小字关 30 天 |
 * | `GET /v1/content-updates/subscription` | 订阅在本机看来的样子 |
 * | `POST /v1/content-updates/subscription` | 订阅「岗位更新」（走云上订阅那一条，按公司扣积分） |
 * | `POST /v1/content-updates/check` | 现在查一次 |
 *
 * 谁能应用 / 退回 / 改设置：**服务端判一处**（公司模式只有品牌负责人与这个岗位的负责人，`canApplyContentUpdates`），
 * 所以路由只要读权限；不够格的人在 `view.can_apply` 上看到 `false`，点了回 403「有更新，等负责人看」。
 */
import type {
  ContentAiMergeInput,
  ContentAiMergeResult,
  ContentApplyInput,
  ContentItemDiffView,
  ContentRollbackInput,
  MaybePromise,
  OfficialSubscriptionLocalView,
  PositionContentUpdatesView,
  PositionUpdatePolicy,
} from '@agentsws/contracts'
import { CONTENT_CLASH_CHOICES, POSITION_UPDATE_POLICIES } from '@agentsws/contracts'
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

export interface ContentDigestActor {
  workspace_id: string
  person_id: string
}

export interface ContentDigestPort {
  view(actor: ContentDigestActor, position_id: string): MaybePromise<PositionContentUpdatesView>
  setPolicy(
    actor: ContentDigestActor,
    position_id: string,
    policy: PositionUpdatePolicy,
  ): MaybePromise<PositionContentUpdatesView>
  diff(
    actor: ContentDigestActor,
    position_id: string,
    item_id: string,
  ): MaybePromise<ContentItemDiffView>
  apply(
    actor: ContentDigestActor,
    position_id: string,
    input: ContentApplyInput,
  ): MaybePromise<PositionContentUpdatesView>
  skip(actor: ContentDigestActor, position_id: string): MaybePromise<PositionContentUpdatesView>
  aiMerge(
    actor: ContentDigestActor,
    position_id: string,
    input: ContentAiMergeInput,
  ): MaybePromise<ContentAiMergeResult>
  rollback(
    actor: ContentDigestActor,
    position_id: string,
    input: ContentRollbackInput,
  ): MaybePromise<PositionContentUpdatesView>
  dismissNudge(
    actor: ContentDigestActor,
    position_id: string,
  ): MaybePromise<PositionContentUpdatesView>
  subscription(actor: ContentDigestActor): MaybePromise<OfficialSubscriptionLocalView>
  subscribe(actor: ContentDigestActor): MaybePromise<OfficialSubscriptionLocalView>
  check(actor: ContentDigestActor): MaybePromise<{ carded: number; applied: number; state: string }>
}

const POSITION_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
const ITEM_ID = /^[a-z_]+:[a-z0-9][a-z0-9._-]*$/

const PolicyBody = z.object({ policy: z.enum(POSITION_UPDATE_POLICIES) })
const ApplyBody = z.object({
  item_ids: z.array(z.string().regex(ITEM_ID)).max(200).optional(),
  choices: z.record(z.string().max(300), z.enum(CONTENT_CLASH_CHOICES)).optional(),
  ai_texts: z.record(z.string().max(300), z.string().max(20_000)).optional(),
})
const AiMergeBody = z.object({
  item_id: z.string().regex(ITEM_ID),
  part_key: z.string().min(1).max(200),
})
const RollbackBody = z.object({ item_id: z.string().regex(ITEM_ID).optional() })

function portOf(deps: GatewayDeps): ContentDigestPort {
  const p = deps.contentDigest
  if (p === undefined)
    throw new ApiError(
      'not_implemented',
      '这个服务进程没有装配岗位更新（GatewayDeps.contentDigest）',
    )
  return p
}

function actorOf(c: Parameters<typeof principalOf>[0]): ContentDigestActor {
  const p = principalOf(c)
  return { workspace_id: p.workspace_id, person_id: p.person_id }
}

function positionId(c: Parameters<typeof param>[0]): string {
  const id = decodeURIComponent(param(c, 'position_id'))
  if (!POSITION_ID.test(id)) throw new ApiError('invalid_input', `岗位 id 不对：${id}`)
  return id
}

function itemId(c: Parameters<typeof param>[0]): string {
  const id = decodeURIComponent(param(c, 'item_id'))
  if (!ITEM_ID.test(id)) throw new ApiError('invalid_input', `条目 id 不对：${id}`)
  return id
}

const POS = [{ name: 'position_id', in: 'path' as const, required: true, description: '岗位 id' }]
const BASE = '/v1/content-updates/positions/:position_id'

export function contentDigestRoutes(): Route[] {
  const spec = {
    tag: TAG,
    auth: 'bearer' as const,
    assignment: true,
    authz: READ,
  }
  return [
    route(
      {
        ...spec,
        method: 'get',
        path: '/v1/content-updates/subscription',
        operationId: 'getContentSubscription',
        summary: 'WP406：岗位更新订阅在本机看来的样子（本机记 7 天）',
        returns: 'OfficialSubscriptionLocalView',
      },
      async (c, deps) => ok(c, await portOf(deps).subscription(actorOf(c))),
    ),
    route(
      {
        ...spec,
        method: 'post',
        path: '/v1/content-updates/subscription',
        operationId: 'subscribeContentUpdates',
        summary: 'WP406：订阅「岗位更新」（按公司订，走云上订阅那一条；没有试用）',
        returns: 'OfficialSubscriptionLocalView',
      },
      async (c, deps) => ok(c, await portOf(deps).subscribe(actorOf(c))),
    ),
    route(
      {
        ...spec,
        method: 'post',
        path: '/v1/content-updates/check',
        operationId: 'checkOfficialContent',
        summary: 'WP406：现在查一次官方岗位更新（平时每 6 小时与启动时各查一次）',
        returns: '{ carded: number; applied: number; state: string }',
      },
      async (c, deps) => ok(c, await portOf(deps).check(actorOf(c))),
    ),
    route(
      {
        ...spec,
        method: 'get',
        path: BASE,
        operationId: 'getPositionContentUpdates',
        summary: 'WP406：这个岗位的岗位更新——设置、等着的几项、应用过的、最近一批、没订阅那行小字',
        params: POS,
        returns: 'PositionContentUpdatesView',
      },
      async (c, deps) => ok(c, await portOf(deps).view(actorOf(c), positionId(c))),
    ),
    route(
      {
        ...spec,
        method: 'put',
        path: `${BASE}/policy`,
        operationId: 'putPositionContentPolicy',
        summary: 'WP406：岗位设置三档——每次问我 / 没撞的自动应用 / 不再更新（按品牌按岗位存）',
        params: POS,
        body: PolicyBody,
        returns: 'PositionContentUpdatesView',
      },
      async (c, deps) => {
        const input = await body(c, PolicyBody)
        return ok(c, await portOf(deps).setPolicy(actorOf(c), positionId(c), input.policy))
      },
    ),
    route(
      {
        ...spec,
        method: 'get',
        path: `${BASE}/items/:item_id/diff`,
        operationId: 'getPositionContentDiff',
        summary: 'WP406：一项按段 / 按条的改动（原来 / 新版 / 你的；撞了的标出来）',
        params: [
          ...POS,
          { name: 'item_id', in: 'path' as const, required: true, description: '条目 id' },
        ],
        returns: 'ContentItemDiffView',
      },
      async (c, deps) => ok(c, await portOf(deps).diff(actorOf(c), positionId(c), itemId(c))),
    ),
    route(
      {
        ...spec,
        method: 'post',
        path: `${BASE}/apply`,
        operationId: 'applyPositionContent',
        summary: 'WP406：挑着应用（不给条目 = 等着的全部）；撞了的那几处按选的落，没选的先保留你的',
        params: POS,
        body: ApplyBody,
        returns: 'PositionContentUpdatesView',
      },
      async (c, deps) => {
        const input = await body(c, ApplyBody)
        return ok(
          c,
          await portOf(deps).apply(actorOf(c), positionId(c), input as ContentApplyInput),
        )
      },
    ),
    route(
      {
        ...spec,
        method: 'post',
        path: `${BASE}/skip`,
        operationId: 'skipPositionContent',
        summary: 'WP406：这次跳过（这批不装，下周的卡一起带上）',
        params: POS,
        returns: 'PositionContentUpdatesView',
      },
      async (c, deps) => ok(c, await portOf(deps).skip(actorOf(c), positionId(c))),
    ),
    route(
      {
        ...spec,
        method: 'post',
        path: `${BASE}/ai-merge`,
        operationId: 'aiMergePositionContent',
        summary:
          'WP406：撞了的一段让 AI 合一版（品牌默认模型；只出不落，点了「用 AI 合好的这版」才用）',
        params: POS,
        body: AiMergeBody,
        returns: 'ContentAiMergeResult',
      },
      async (c, deps) => {
        const input = await body(c, AiMergeBody)
        return ok(c, await portOf(deps).aiMerge(actorOf(c), positionId(c), input))
      },
    ),
    route(
      {
        ...spec,
        method: 'post',
        path: `${BASE}/rollback`,
        operationId: 'rollbackPositionContent',
        summary: 'WP406：整批退回上一批（不给条目）或单项退回（照 docs/90 保留的上一版）',
        params: POS,
        body: RollbackBody,
        returns: 'PositionContentUpdatesView',
      },
      async (c, deps) => {
        const input = await body(c, RollbackBody)
        return ok(
          c,
          await portOf(deps).rollback(
            actorOf(c),
            positionId(c),
            input.item_id === undefined ? {} : { item_id: input.item_id },
          ),
        )
      },
    ),
    route(
      {
        ...spec,
        method: 'post',
        path: `${BASE}/nudge/dismiss`,
        operationId: 'dismissPositionContentNudge',
        summary: 'WP406：没订阅时那一行小字关掉（30 天不提）',
        params: POS,
        returns: 'PositionContentUpdatesView',
      },
      async (c, deps) => ok(c, await portOf(deps).dismissNudge(actorOf(c), positionId(c))),
    ),
  ]
}
