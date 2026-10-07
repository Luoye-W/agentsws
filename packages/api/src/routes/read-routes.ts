/**
 * WP246（决策 87 / 88）：**取数路线**的 HTTP 投影（本机）——连接页「取数路线」那一块。
 *
 * - 看：每个平台一行，现在走哪一级、哪级断了（快查，不连网）；
 * - 重新体检：真去连一下（接口中台问一次价、读号读一页页头、YouTube / 第三方各探一下）；
 * - 设置：网页转文字的第三方那一级（默认关）、Reddit 自动读取时浏览器怎么开；
 * - Reddit 读号：打开「登录读号」窗口（用户自己在网页上登录，我们不碰密码、不读 cookie）、体检读号。
 *
 * 权限与连接页其余设置同一档：读 `store_config.read@workspace`，改 `policy.stage@workspace`。
 */
import type {
  MaybePromise,
  ReadRoutesSettings,
  ReadRoutesView,
  RedditReadAccountStatus,
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

const TAG = 'read-routes'

export interface ReadRoutesActor {
  workspace_id: string
  person_id: string
}

export interface ReadRoutesApiPort {
  view(actor: ReadRoutesActor): MaybePromise<ReadRoutesView>
  doctor(actor: ReadRoutesActor): MaybePromise<ReadRoutesView>
  setSettings(
    actor: ReadRoutesActor,
    patch: Partial<ReadRoutesSettings>,
  ): MaybePromise<ReadRoutesView>
  openRedditLogin(actor: ReadRoutesActor): MaybePromise<RedditReadAccountStatus>
  checkRedditAccount(actor: ReadRoutesActor): MaybePromise<RedditReadAccountStatus>
}

const SettingsBody = z.object({
  web_third_party_reader: z.boolean().optional(),
  reddit_browser_window: z.enum(['minimized', 'headless']).optional(),
})

function portOf(deps: GatewayDeps): ReadRoutesApiPort {
  const p = deps.readRoutes
  if (p === undefined)
    throw new ApiError('not_implemented', '这个服务进程没有装配取数路线（GatewayDeps.readRoutes）')
  return p
}

function actorOf(c: Parameters<typeof principalOf>[0]): ReadRoutesActor {
  const p = principalOf(c)
  return { workspace_id: p.workspace_id, person_id: p.person_id }
}

export function readRoutesRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/settings/read-routes',
        operationId: 'getReadRoutes',
        summary: '取数路线：每个平台现在走哪一级、哪级断了（快查，不连网）（WP246）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'ReadRoutesView',
      },
      async (c, deps) => ok(c, await portOf(deps).view(actorOf(c))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/settings/read-routes/doctor',
        operationId: 'runReadRoutesDoctor',
        summary: '重新体检：真去连一下每一级（接口中台、读号、YouTube、第三方转文字）（WP246）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'ReadRoutesView',
      },
      async (c, deps) => ok(c, await portOf(deps).doctor(actorOf(c))),
    ),
    route(
      {
        method: 'put',
        path: '/v1/settings/read-routes',
        operationId: 'setReadRoutesSettings',
        summary:
          '改取数路线的设置：网页转文字的第三方那一级（默认关，开了网址会经过对方）、Reddit 读取时浏览器怎么开（WP246）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: SettingsBody,
        returns: 'ReadRoutesView',
      },
      async (c, deps) => {
        const input = await body(c, SettingsBody)
        const patch: Partial<ReadRoutesSettings> = {}
        if (input.web_third_party_reader !== undefined)
          patch.web_third_party_reader = input.web_third_party_reader
        if (input.reddit_browser_window !== undefined)
          patch.reddit_browser_window = input.reddit_browser_window
        return ok(c, await portOf(deps).setSettings(actorOf(c), patch))
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/settings/reddit-read-account/login',
        operationId: 'openRedditReadAccountLogin',
        summary:
          '登录读号：有头打开只读浏览器那份目录到 Reddit 登录页，用户自己在网页上登录（我们不碰密码、不读 cookie）；关掉窗口后自动体检（WP246）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        returns: 'RedditReadAccountStatus',
      },
      async (c, deps) => ok(c, await portOf(deps).openRedditLogin(actorOf(c))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/settings/reddit-read-account/check',
        operationId: 'checkRedditReadAccount',
        summary: '体检读号：读页头上登录的是谁；是品牌登记的号（官方 / 版主）就拦下（WP246）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'RedditReadAccountStatus',
      },
      async (c, deps) => ok(c, await portOf(deps).checkRedditAccount(actorOf(c))),
    ),
  ]
}
