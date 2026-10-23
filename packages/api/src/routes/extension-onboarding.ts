/**
 * WP360（决策 947，Luoye 10-16）：**需要插件的岗位，一开始就引导装好插件**。
 *
 * 「哪些岗位要插件」只从职责定义的 `browser_extension` 推（契约 `extensionNeedOf`）；这三条路由把它连同
 * 「配上了没有、配上之后还差哪一步、接哪张方案卡、今天是不是点过稍后」一起端给岗位页顶上那张卡：
 *
 * - `GET /v1/extension/needs?roles=a,b`：这几条职责（岗位页传本岗位的；不传 = 本人担着的全部）要不要插件、现在走到哪；
 * - `POST /v1/extension/needs/snooze`：「稍后」——当天（本地日）收起，同一个品牌所有岗位一起收（只一张卡）；
 * - `POST /v1/extension/needs/plan`：装好、该连的都连上了，接 WP348 的方案卡（如 Reddit 巡查设置）。
 *
 * 准入与岗位连接清单同一档（岗位页绑的是那条岗位自己的分配）：这里没有任何凭据，也没有配对码。
 */
import type { BrowserExtensionUse, MaybePromise, WorkspaceId } from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { assignmentOf, body, listParam, ok, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'

/** 配对之后在插件里还要做的那一步。 */
export type ExtensionFollowStep = 'reddit' | 'google_ads' | 'meta_ads'

/** `GET /v1/extension/needs` 的回执。 */
export interface ExtensionNeedsView {
  /** 这几条职责里有要插件的。 */
  needed: boolean
  /** 拿插件做哪几样（界面按它说一句为什么）。 */
  uses: BrowserExtensionUse[]
  /** 哪几条职责要它（名字给人看，id 给界面对）。 */
  roles: { role_id: string; name: { zh: string; en: string } }[]
  /** 这个品牌已经有一个没撤掉的插件配上了。 */
  paired: boolean
  /**
   * WP409（内测 10-18 #4，只加）：配上的是哪一个（最近配的那把）——工坊出一行「插件已连上 · Chrome · Windows」。
   * `label` 是令牌名（配对码没起名字时按浏览器认）；没配上 / 老服务没有这一格。
   */
  paired_with?: { label: string; paired_at: string; last_used_at?: string }
  /** 配上之后还要在插件里做的几步；`done` 不知道（查不了）就没有这一格。 */
  steps: { step: ExtensionFollowStep; done?: boolean }[]
  /** 都连好之后要接的方案卡（WP348 设置目标；这个品牌没登记的不列）。 */
  plans: { target: string; name: string; satisfied: boolean }[]
  /** 今天点过「稍后」。 */
  snoozed: boolean
  /**
   * WP416（自查 kol U3）：「要你处理」里已经有一张还没处理的装插件连接卡（卡 id）——岗位页顶上那张就不再出，
   * 配对说明与「生成配对码」只留一处。没有 / 老服务没有这一格。
   */
  connect_card_id?: string
  /**
   * WP493（决策 1718）：这几样 ego 能做（ego 能用时才有）——`uses` / `steps` 里已经去掉它们，不再为它们催装插件。
   */
  ego_covers?: BrowserExtensionUse[]
  /** WP493：要插件做的几样 ego 全都能做——插件只是备用（岗位页不催装，连接卡上显示「备用」）。 */
  plugin_backup?: boolean
}

export interface ExtensionNeedsActor {
  workspace_id: WorkspaceId
  person_id: string
  assignment_id: string
  role_id: string
}

export interface ExtensionOnboardingPort {
  needs(actor: ExtensionNeedsActor, role_ids?: string[]): MaybePromise<ExtensionNeedsView>
  snooze(actor: ExtensionNeedsActor, role_ids?: string[]): MaybePromise<ExtensionNeedsView>
  /** 出那张方案卡（已经设好 / 没登记回没有卡）。 */
  plan(actor: ExtensionNeedsActor, target: string): Promise<{ card_id?: string }>
}

const READ = {
  domain: 'approval',
  op: 'read',
  range: 'own',
  sensitivity: 'internal',
} as const

function portOf(deps: GatewayDeps): ExtensionOnboardingPort {
  const p = deps.extensionOnboarding
  if (p === undefined) throw new ApiError('not_implemented', '这个本机服务版本还不会引导装插件。')
  return p
}

const ROLE_ID = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/)
const snoozeSchema = z.object({ roles: z.array(ROLE_ID).max(64).optional() }).strict()
const planSchema = z
  .object({
    target: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9_.-]*$/),
  })
  .strict()

function actorOf(c: Parameters<typeof principalOf>[0]): ExtensionNeedsActor {
  const p = principalOf(c)
  const a = assignmentOf(c)
  return {
    workspace_id: p.workspace_id,
    person_id: p.person_id,
    assignment_id: a.id,
    role_id: a.role_id,
  }
}

export function extensionOnboardingRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/extension/needs',
        operationId: 'extensionNeeds',
        summary:
          '这几条职责要不要浏览器插件（由职责定义推）、配上了没有、配上之后还差哪一步、接哪张方案卡、今天点过稍后没有',
        tag: 'extension',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [
          {
            name: 'roles',
            in: 'query',
            required: false,
            description: '职责 id，逗号分隔；不给 = 本人担着的全部',
          },
        ],
        returns: 'ExtensionNeedsView',
      },
      async (c, deps) => {
        const roles = listParam(c, 'roles')
        if (roles?.some((r) => !ROLE_ID.safeParse(r).success))
          throw new ApiError('invalid_input', 'roles 里有认不出的职责 id')
        return ok(c, await portOf(deps).needs(actorOf(c), roles))
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/extension/needs/snooze',
        operationId: 'extensionNeedsSnooze',
        summary: '装插件那张引导卡点了「稍后」：当天收起（同一品牌所有岗位一起）',
        tag: 'extension',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        body: snoozeSchema,
        returns: 'ExtensionNeedsView',
      },
      async (c, deps) => {
        const input = await body(c, snoozeSchema)
        return ok(c, await portOf(deps).snooze(actorOf(c), input.roles))
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/extension/needs/plan',
        operationId: 'extensionNeedsPlan',
        summary: '插件装好、该连的都连上了：出接下来那张方案卡（WP348，如 Reddit 巡查设置）',
        tag: 'extension',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        body: planSchema,
        returns: '{ card_id?: string }',
      },
      async (c, deps) => {
        const input = await body(c, planSchema)
        return ok(c, await portOf(deps).plan(actorOf(c), input.target))
      },
    ),
  ]
}
