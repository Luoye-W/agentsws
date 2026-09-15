/**
 * 49 M1 的工作区关联：签发 / 续期 / 撤销 / 列表。
 *
 * 两条鉴权路线，分得很清：
 *
 * - **会话**（人在管自己的账号）：签一把新的、看清单、续期、撤掉某一条。
 *   每一条都按会话所属的**组织**过滤——别的组织的关联查不到、撤不动，
 *   连"存不存在"都问不出来（一律 `not_found`，不是 `forbidden`）。
 * - **令牌自己**（一台机器上的工作区）：只认自己、只撤自己。这两条不要求任何
 *   `scope`——认自己与放弃自己，是任何一把令牌都该有的权利（18 §1 里"可撤"的
 *   本地那一半：解除关联时本地要能把云侧那条也切掉）。
 */

import {
  ApiError,
  type CloudRoute,
  cloudBody,
  cloudOk,
  cloudParam,
  cloudRoute,
  cloudSession,
  cloudToken,
} from '@agentsws/api'
import type { Clock, CloudScope } from '@agentsws/contracts'
import { z } from 'zod'
import type { CloudStore } from '../store.js'
import { linkView } from '../views.js'

/**
 * zod 要的是字面量元组，契约给的是 `readonly CloudScope[]`——所以这里重写一遍。
 * 它不是第二份真源：`test/links.test.ts` 有一条断言钉住它与 `CLOUD_SCOPES` 逐字相同，
 * 契约里加一个动作而这里忘了加，测试当场红。
 */
const SCOPE_VALUES = [
  'ai',
  'wallet:read',
  'wallet:topup',
  'wallet:admin',
  'standby',
] as const satisfies readonly CloudScope[]

export const ScopeSchema = z.enum(SCOPE_VALUES)

const CreateLinkBody = z.object({
  workspace_id: z.string().min(1).max(200),
  label: z.string().min(1).max(200).optional(),
  scopes: z.array(ScopeSchema).min(1).optional(),
  /** 默认 90 天；最长 365（18 §1「短期」：没有"永不过期"这一档）。 */
  ttl_days: z.number().int().min(1).max(365).optional(),
})

const RenewBody = z.object({ ttl_days: z.number().int().min(1).max(365).optional() })

const DAY_MS = 24 * 60 * 60 * 1000

export interface LinkRouteDeps {
  store: CloudStore
  clock: Clock
}

export function linkRoutes(deps: LinkRouteDeps): CloudRoute[] {
  /** 按会话所属组织取一条关联；不属于这个组织的一律当不存在。 */
  const ownedLink = (id: string, org_id: string) => {
    const link = deps.store.link(id)
    if (link === undefined || link.cloud_org_id !== org_id)
      throw new ApiError('not_found', '没有这条关联')
    return link
  }

  return [
    cloudRoute(
      {
        method: 'post',
        path: '/v1/cloud/links',
        operationId: 'createWorkspaceLink',
        summary: '给一个工作区签一把服务令牌（明文只回一次）',
        tag: 'cloud-links',
        auth: 'session',
        body: CreateLinkBody,
        returns: '{ link, token }——`token` 之后哪儿都查不到',
      },
      async (c) => {
        const { account_id, org_id } = cloudSession(c)
        const input = await cloudBody(c, CreateLinkBody)
        try {
          const issued = deps.store.createLink({
            workspace_id: input.workspace_id,
            cloud_org_id: org_id,
            created_by: account_id,
            ...(input.label === undefined ? {} : { label: input.label }),
            ...(input.scopes === undefined ? {} : { scopes: [...input.scopes] }),
            ...(input.ttl_days === undefined ? {} : { ttlMs: input.ttl_days * DAY_MS }),
          })
          return cloudOk(
            c,
            { link: linkView(issued.link, deps.clock.now()), token: issued.token },
            201,
          )
        } catch (err) {
          if (err instanceof Error && err.message.startsWith('workspace_already_linked:'))
            throw new ApiError('conflict', '这个工作区已经关联到另一个账号了，先在那边解除')
          throw err
        }
      },
    ),
    cloudRoute(
      {
        method: 'get',
        path: '/v1/cloud/links',
        operationId: 'listWorkspaceLinks',
        summary: '本组织的全部关联（含已撤销的：撤过什么必须看得到）',
        tag: 'cloud-links',
        auth: 'session',
        returns: '{ links: WorkspaceLinkView[] }（没有令牌，也没有哈希）',
      },
      async (c) => {
        const { org_id } = cloudSession(c)
        const now = deps.clock.now()
        return cloudOk(c, { links: deps.store.links(org_id).map((l) => linkView(l, now)) })
      },
    ),
    // `current` 必须排在 `:id` 那两条之前：`/links/current/revoke` 与
    // `/links/:id/revoke` 是同一个形状，Hono 按注册顺序匹配。
    cloudRoute(
      {
        method: 'get',
        path: '/v1/cloud/links/current',
        operationId: 'currentWorkspaceLink',
        summary: '这把令牌自己是谁（本地"关联状态"那一格靠它刷新）',
        tag: 'cloud-links',
        auth: 'workspace_token',
        returns: '{ link, org, account }',
      },
      async (c) => {
        const token = cloudToken(c)
        const link = deps.store.activeLinkOfWorkspace(token.workspace_id)
        if (link === undefined) throw new ApiError('not_found', '没有这条关联')
        const org = deps.store.org(token.org_id)
        const account = deps.store.account(token.account_id)
        return cloudOk(c, {
          link: linkView(link, deps.clock.now()),
          ...(org === undefined ? {} : { org: { id: org.id, name: org.name } }),
          ...(account === undefined ? {} : { account: { id: account.id, email: account.email } }),
        })
      },
    ),
    /*
     * WP66（52 O1）：**同一家公司下的另一个品牌**补签一把。
     *
     * 为什么要有这一条：账号与余额在组织级（49 M1），而令牌是按工作区签的；
     * 关联过之后再加一个品牌，本机手上**只剩这把工作区令牌**——关联时那张
     * 云侧会话用完就注销了（本机不留第二把能管账号的钥匙）。没有这一条，
     * 新品牌就只能让用户把整家公司重新关联一次。
     *
     * 它能做的**只有一件事**：在**调用者自己那条关联所属的组织里**多签一把。
     * 读不到别的关联、撤不掉任何东西、换不出会话；工作区已经挂在别的账号下时
     * 照旧 409。也就是说，一把泄漏的工作区令牌在这里拿不到它本来没有的东西
     * ——它本来就能花这个组织的积分。
     */
    cloudRoute(
      {
        method: 'post',
        path: '/v1/cloud/links/sibling',
        operationId: 'createSiblingWorkspaceLink',
        summary: '给同一组织下的另一个工作区补签一把服务令牌（明文只回一次）',
        tag: 'cloud-links',
        auth: 'workspace_token',
        body: CreateLinkBody,
        returns: '{ link, token }——`token` 之后哪儿都查不到',
      },
      async (c) => {
        const token = cloudToken(c)
        const mine = deps.store.activeLinkOfWorkspace(token.workspace_id)
        if (mine === undefined) throw new ApiError('not_found', '没有这条关联')
        const input = await cloudBody(c, CreateLinkBody)
        if (input.workspace_id === token.workspace_id)
          throw new ApiError('conflict', '这就是调用者自己那个工作区，它已经有一把了')
        try {
          const issued = deps.store.createLink({
            workspace_id: input.workspace_id,
            // 组织从**调用者那条关联**上取，不从请求体里读——请求体说了不算
            cloud_org_id: mine.cloud_org_id,
            created_by: mine.created_by,
            ...(input.label === undefined ? {} : { label: input.label }),
            // 补签出来的那一把与调用者同权，不多不少
            scopes: [...mine.scopes],
            ...(input.ttl_days === undefined ? {} : { ttlMs: input.ttl_days * DAY_MS }),
          })
          return cloudOk(
            c,
            { link: linkView(issued.link, deps.clock.now()), token: issued.token },
            201,
          )
        } catch (err) {
          if (err instanceof Error && err.message.startsWith('workspace_already_linked:'))
            throw new ApiError('conflict', '这个工作区已经关联到另一个账号了，先在那边解除')
          throw err
        }
      },
    ),
    cloudRoute(
      {
        method: 'post',
        path: '/v1/cloud/links/current/revoke',
        operationId: 'revokeCurrentWorkspaceLink',
        summary: '这台机器自己解除关联（本地"解除关联"按钮走这条）',
        tag: 'cloud-links',
        auth: 'workspace_token',
        returns: 'WorkspaceLinkView（`revoked_at` 已写上）',
      },
      async (c) => {
        const token = cloudToken(c)
        const link = deps.store.activeLinkOfWorkspace(token.workspace_id)
        if (link === undefined) throw new ApiError('not_found', '没有这条关联')
        const revoked = deps.store.revokeLink(link.id)
        if (revoked === undefined) throw new ApiError('not_found', '没有这条关联')
        return cloudOk(c, linkView(revoked, deps.clock.now()))
      },
    ),
    cloudRoute(
      {
        method: 'post',
        path: '/v1/cloud/links/:id/renew',
        operationId: 'renewWorkspaceLink',
        summary: '续期 = 换一把新的（旧明文当场作废）',
        tag: 'cloud-links',
        auth: 'session',
        params: [{ name: 'id', in: 'path', required: true, description: '关联 id' }],
        body: RenewBody,
        returns: '{ link, token }',
      },
      async (c) => {
        const { org_id } = cloudSession(c)
        const id = cloudParam(c, 'id')
        const link = ownedLink(id, org_id)
        if (link.revoked_at !== undefined)
          throw new ApiError('conflict', '这条关联已经撤销了，续不了——重新签一把')
        const input = await cloudBody(c, RenewBody)
        const issued =
          input.ttl_days === undefined
            ? deps.store.renewLink(id)
            : deps.store.renewLink(id, input.ttl_days * DAY_MS)
        if (issued === undefined) throw new ApiError('not_found', '没有这条关联')
        return cloudOk(c, { link: linkView(issued.link, deps.clock.now()), token: issued.token })
      },
    ),
    cloudRoute(
      {
        method: 'post',
        path: '/v1/cloud/links/:id/revoke',
        operationId: 'revokeWorkspaceLink',
        summary: '撤掉一条关联（写 revoked_at，不删行）',
        tag: 'cloud-links',
        auth: 'session',
        params: [{ name: 'id', in: 'path', required: true, description: '关联 id' }],
        returns: 'WorkspaceLinkView',
      },
      async (c) => {
        const { org_id } = cloudSession(c)
        const id = cloudParam(c, 'id')
        ownedLink(id, org_id)
        const revoked = deps.store.revokeLink(id)
        if (revoked === undefined) throw new ApiError('not_found', '没有这条关联')
        return cloudOk(c, linkView(revoked, deps.clock.now()))
      },
    ),
  ]
}
