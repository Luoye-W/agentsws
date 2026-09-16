/**
 * 浏览器设置（55 §3 末段，WP82）的 HTTP 投影。
 *
 * 三条路由，一件事：**这台机器上的浏览器怎么配**。两种方式——
 *
 * | 方式 | 是什么 | 谁能用 |
 * |---|---|---|
 * | 连接我电脑上的 Chrome（`attach`） | 接一个已经开着 `--remote-debugging-port` 的 Chrome，带你自己的登录态 | **只有个人档**（服务就跑在你这台电脑上） |
 * | 用独立的 Chrome（`launch`） | 指一个本机的 Chrome / Chromium 可执行文件，每次运行起一个干净的 | 都能用 |
 *
 * 凭据边界（13 §4）：这条路上**没有任何凭据**。CDP 地址不是密码，密码永远是
 * 用户自己在浏览器里输的；我们既不读 cookie，也不代填任何登录表单。
 *
 * 权限与模型面 / 能力来源同一档：读走 `store_config.read@workspace`，
 * 改走 `policy.stage@workspace`——配浏览器是所有者的事，客服岗位看不到也改不了（05）。
 */
import type { BrowserProbeResult, BrowserSettingsView, MaybePromise } from '@agentsws/contracts'
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

export interface BrowserActor {
  workspace_id: string
  person_id: string
}

export interface BrowserPort {
  settings(actor: BrowserActor): MaybePromise<BrowserSettingsView>
  setSettings(
    actor: BrowserActor,
    input: {
      mode: 'off' | 'attach' | 'launch'
      endpoint?: string
      executable_path?: string
      headless?: boolean
    },
  ): MaybePromise<BrowserSettingsView>
  /** 给了 `endpoint` 就探那一个；不给就把常见端口挨个试一遍。 */
  probe(actor: BrowserActor, endpoint?: string): MaybePromise<BrowserProbeResult>
}

const SettingsBody = z.object({
  mode: z.enum(['off', 'attach', 'launch']),
  endpoint: z.string().min(1).max(2048).optional(),
  executable_path: z.string().min(1).max(4096).optional(),
  headless: z.boolean().optional(),
})

function portOf(deps: GatewayDeps): BrowserPort {
  const p = deps.browser
  if (p === undefined)
    throw new ApiError('not_implemented', '这个服务进程没有装配浏览器设置（GatewayDeps.browser）')
  return p
}

function actorOf(c: Parameters<typeof principalOf>[0]): BrowserActor {
  const p = principalOf(c)
  return { workspace_id: p.workspace_id, person_id: p.person_id }
}

export function browserRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/settings/browser',
        operationId: 'getBrowserSettings',
        summary:
          '这台机器上的浏览器怎么配（55 §3）。`attach_allowed` 说明这一档能不能接你自己的 Chrome',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'BrowserSettingsView',
      },
      async (c, deps) => ok(c, await portOf(deps).settings(actorOf(c))),
    ),
    route(
      {
        method: 'put',
        path: '/v1/settings/browser',
        operationId: 'setBrowserSettings',
        summary:
          '改浏览器设置。`attach` 只有个人档能用；`launch` 必须指一个本机可执行文件（我们不下载浏览器）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: SettingsBody,
        returns: 'BrowserSettingsView',
      },
      async (c, deps) => {
        const input = await body(c, SettingsBody)
        return ok(
          c,
          await portOf(deps).setSettings(actorOf(c), {
            mode: input.mode,
            ...(input.endpoint === undefined ? {} : { endpoint: input.endpoint }),
            ...(input.executable_path === undefined
              ? {}
              : { executable_path: input.executable_path }),
            ...(input.headless === undefined ? {} : { headless: input.headless }),
          }),
        )
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/settings/browser/probe',
        operationId: 'probeBrowser',
        summary:
          '探一下有没有开着调试口的浏览器（`GET <endpoint>/json/version`）。不带 endpoint = 自动探测常见端口',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [
          {
            name: 'endpoint',
            in: 'query',
            required: false,
            description: 'CDP 地址；不给就自动探测 127.0.0.1 上的常见端口',
          },
        ],
        returns: 'BrowserProbeResult',
      },
      async (c, deps) => {
        const endpoint = c.req.query('endpoint')
        return ok(c, await portOf(deps).probe(actorOf(c), endpoint === '' ? undefined : endpoint))
      },
    ),
  ]
}
