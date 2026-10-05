/**
 * WP216（Luoye 10-05）：**这个品牌的平台专属那一套**——官方技能、官方 MCP 工具、官方 CLI。
 *
 * 真源是 `@agentsws/contracts` 的 `PLATFORM_KITS`，判据是品牌档案的 `storefront_platform`。
 * 平台那一行没有专属的东西（WooCommerce / 还没建站 / 自己搭的）就回 `kit: null`，
 * 界面上什么都不出——不检测 CLI、不列技能、不出卡。
 *
 * 三条：
 *
 * - `GET /v1/platform-kit`：看现状。带 `position_id` 时只在那个岗位页需要 CLI 卡的时候才去检测本机；
 * - `POST /v1/platform-kit/cli/check`：用户点「再查一次」（装好之后），不走缓存；
 * - `PUT /v1/platform-kit/cli/login`：用户在浏览器里自己登录完，点「我登好了」——我们只记一个时间，
 *   **不跑登录命令、不碰账号密码、不读 CLI 存的会话**。
 */
import type {
  MaybePromise,
  PlatformCliSpec,
  PlatformMcpSpec,
  PlatformSkillSource,
} from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { assignmentOf, body, ok, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'

/** 看一眼这个品牌的平台套件：只读。 */
const READ = {
  // 平台套件说的是「这个品牌的 AI 手边有哪几样官方工具」——与技能页同一把闸（店主与建站四条都有）
  domain: 'skill',
  op: 'read',
  range: 'own',
  sensitivity: 'internal',
} as const

export interface PlatformKitActor {
  workspace_id: string
  person_id: string
  assignment_id: string
}

/** CLI 卡上那四档（36 §7 第四档：状态用图标）。 */
export type PlatformCliState = 'missing' | 'node_old' | 'needs_login' | 'ready'

export interface PlatformCliView {
  spec: PlatformCliSpec
  /** 本机检测（没检测过 = 没有这一格）。 */
  probe?: {
    installed: boolean
    version?: string
    node_version?: string
    node_ok: boolean
    min_node_major: number
    checked_at: string
  }
  /** 用户点「我登好了」的时间；没点过就没有。 */
  login_confirmed_at?: string
  state: PlatformCliState
  /** CLI 不在 / 没登录时，哪几条职责退回 Admin API 那条路（卡上照实说）。 */
  degraded_roles: string[]
}

export interface PlatformKitView {
  platform: string
  kit: null | {
    /** 平台专属的官方技能（目录名 + 给人看的名字）。 */
    skills: { name: string; display_name?: { zh: string; en: string } }[]
    skill_source?: PlatformSkillSource
    /** 官方 MCP 工具源（`enabled` = 这台机器上开着、并且起来了）。 */
    mcp?: PlatformMcpSpec & { enabled: boolean; tools: string[] }
    cli?: PlatformCliView
  }
}

export interface PlatformKitPort {
  view(actor: PlatformKitActor, input: { position_id?: string }): MaybePromise<PlatformKitView>
  checkCli(actor: PlatformKitActor): MaybePromise<PlatformKitView>
  confirmLogin(
    actor: PlatformKitActor,
    input: { confirmed: boolean },
  ): MaybePromise<PlatformKitView>
}

const LoginBody = z.object({ confirmed: z.boolean() })

function portOf(deps: GatewayDeps): PlatformKitPort {
  const p = deps.platformKit
  if (p === undefined)
    throw new ApiError('not_implemented', '这个服务进程没有装配平台套件（GatewayDeps.platformKit）')
  return p
}

function actorOf(c: Parameters<typeof principalOf>[0]): PlatformKitActor {
  const p = principalOf(c)
  return {
    workspace_id: p.workspace_id,
    person_id: p.person_id,
    assignment_id: assignmentOf(c).id,
  }
}

export function platformKitRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/platform-kit',
        operationId: 'getPlatformKit',
        summary:
          'WP216：这个品牌的平台专属那一套（官方技能 / 官方 MCP / 官方 CLI）。平台没有就回 kit: null，什么都不检测',
        tag: 'site',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [
          {
            name: 'position_id',
            in: 'query',
            description: '在哪个岗位页上看（CLI 卡只出在平台那一行写的岗位页上）',
          },
        ],
        returns: 'PlatformKitView',
      },
      async (c, deps) => {
        const position_id = c.req.query('position_id')
        return ok(
          c,
          await portOf(deps).view(
            actorOf(c),
            position_id === undefined || position_id === '' ? {} : { position_id },
          ),
        )
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/platform-kit/cli/check',
        operationId: 'checkPlatformCli',
        summary: 'WP216：再查一次本机的官方 CLI 与 Node（不走缓存）。平台没有 CLI 就不查',
        tag: 'site',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'PlatformKitView',
      },
      async (c, deps) => ok(c, await portOf(deps).checkCli(actorOf(c))),
    ),
    route(
      {
        method: 'put',
        path: '/v1/platform-kit/cli/login',
        operationId: 'confirmPlatformCliLogin',
        summary:
          'WP216：用户在浏览器里自己登录完点「我登好了」（或撤回）。只记一个时间，不跑登录命令、不碰任何凭据',
        tag: 'site',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        body: LoginBody,
        returns: 'PlatformKitView',
      },
      async (c, deps) =>
        ok(c, await portOf(deps).confirmLogin(actorOf(c), await body(c, LoginBody))),
    ),
  ]
}
