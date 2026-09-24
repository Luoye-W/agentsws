/**
 * 电脑操控（docs/80，WP144）的 HTTP 投影。
 *
 * 两组路由：
 *
 * | 路由 | 是什么 | 谁能用 |
 * |---|---|---|
 * | `GET` / `PUT /v1/settings/computer-use` | 总开关、哪几条职责可以、授权几分钟 | 读：`store_config.read`；改：`policy.stage`（所有者的事） |
 * | `POST …/install` / `…/check` / `…/open-settings` | 向导三步：下载驱动、打开系统设置那一页、自检 | 同「改」 |
 * | `GET /v1/computer-use/active` / `POST /v1/computer-use/stop` | 托盘与第三栏：现在有没有 AI 在操作这台电脑、点一下停下 | 读设置的人都能看、都能停——停是往安全的那一侧走 |
 *
 * 凭据边界（13 §4）：这条路上**没有任何凭据**。驱动是钉版本 + sha256 下载的公开产物；
 * 系统权限只在系统设置里由人自己点，我们只把那一页打开。
 */
import type {
  ComputerUseActive,
  ComputerUseSelfCheck,
  ComputerUseSettingsView,
  MaybePromise,
} from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { body, ok, principalOf } from '../helpers.js'
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

const TAG = 'settings'

export interface ComputerUseActor {
  workspace_id: string
  person_id: string
}

export interface ComputerUsePort {
  settings(actor: ComputerUseActor): MaybePromise<ComputerUseSettingsView>
  setSettings(
    actor: ComputerUseActor,
    input: { enabled?: boolean; roles?: string[]; minutes?: number },
  ): MaybePromise<ComputerUseSettingsView>
  /** 向导第 ① 步：按钉死的版本 + sha256 下载驱动（校验不过什么都不装）。 */
  install(actor: ComputerUseActor): MaybePromise<ComputerUseSettingsView>
  /** 向导第 ③ 步：起一次驱动调 `check_permissions {prompt:false}`，原样列出。 */
  check(actor: ComputerUseActor): MaybePromise<ComputerUseSelfCheck>
  /** 向导第 ② 步：打开系统设置里那一页（只打开，不替人点）。 */
  openSettings(
    actor: ComputerUseActor,
    pane: 'accessibility' | 'screen_recording',
  ): MaybePromise<{ opened: boolean; url: string }>
  /** 现在有没有一次运行正在操作这台电脑。 */
  active(actor: ComputerUseActor): MaybePromise<{ active?: ComputerUseActive }>
  /** 停止：撤销授权 + 中断那次运行。 */
  stop(actor: ComputerUseActor): MaybePromise<{ stopped: number }>
}

const SettingsBody = z.object({
  enabled: z.boolean().optional(),
  roles: z.array(z.string().min(1).max(200)).max(500).optional(),
  minutes: z.number().int().min(1).max(60).optional(),
})

const OpenBody = z.object({ pane: z.enum(['accessibility', 'screen_recording']) })

function portOf(deps: GatewayDeps): ComputerUsePort {
  const p = deps.computerUse
  if (p === undefined)
    throw new ApiError('not_implemented', '这个服务进程没有装配电脑操控（GatewayDeps.computerUse）')
  return p
}

function actorOf(c: Parameters<typeof principalOf>[0]): ComputerUseActor {
  const p = principalOf(c)
  return { workspace_id: p.workspace_id, person_id: p.person_id }
}

export function computerUseRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/settings/computer-use',
        operationId: 'getComputerUseSettings',
        summary:
          'WP144：电脑操控的总开关、可以操作电脑的职责、授权分钟数、驱动装没装、正在操作的那一次',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'ComputerUseSettingsView',
      },
      async (c, deps) => ok(c, await portOf(deps).settings(actorOf(c))),
    ),
    route(
      {
        method: 'put',
        path: '/v1/settings/computer-use',
        operationId: 'putComputerUseSettings',
        summary:
          'WP144：改电脑操控设置（只有本机档能打开；关掉会同时撤销授权并停下正在操作的运行）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: SettingsBody,
        returns: 'ComputerUseSettingsView',
      },
      async (c, deps) => {
        const input = await body(c, SettingsBody)
        return ok(
          c,
          await portOf(deps).setSettings(actorOf(c), {
            ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
            ...(input.roles === undefined ? {} : { roles: input.roles }),
            ...(input.minutes === undefined ? {} : { minutes: input.minutes }),
          }),
        )
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/settings/computer-use/install',
        operationId: 'installComputerUseDriver',
        summary:
          'WP144：下载电脑操控驱动（版本与 sha256 钉死在 computer-use.lock.json；校验不过就什么都不装）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        returns: 'ComputerUseSettingsView',
      },
      async (c, deps) => ok(c, await portOf(deps).install(actorOf(c))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/settings/computer-use/check',
        operationId: 'checkComputerUsePermissions',
        summary:
          'WP144：自检——起一次驱动调 check_permissions {prompt:false}（只读状态，不弹系统框、不截屏、不点）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        returns: 'ComputerUseSelfCheck',
      },
      async (c, deps) => ok(c, await portOf(deps).check(actorOf(c))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/settings/computer-use/open-settings',
        operationId: 'openComputerUseSystemSettings',
        summary: 'WP144：打开系统设置里「辅助功能」或「录屏」那一页（macOS；只打开，不替人点）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: OpenBody,
        returns: 'ComputerUseOpenSettingsResult',
      },
      async (c, deps) => {
        const input = await body(c, OpenBody)
        return ok(c, await portOf(deps).openSettings(actorOf(c), input.pane))
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/computer-use/active',
        operationId: 'getComputerUseActive',
        summary: 'WP144：现在有没有 AI 在操作这台电脑（托盘变色与第三栏那一行读它）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'ComputerUseActiveView',
      },
      async (c, deps) => ok(c, await portOf(deps).active(actorOf(c))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/computer-use/stop',
        operationId: 'stopComputerUse',
        summary: 'WP144：停止——撤销所有授权并中断正在操作这台电脑的运行（驱动随之断开）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        // 停是往安全的那一侧走：看得见「正在操作」的人都能按
        authz: READ,
        returns: 'ComputerUseStopResult',
      },
      async (c, deps) => ok(c, await portOf(deps).stop(actorOf(c))),
    ),
  ]
}
