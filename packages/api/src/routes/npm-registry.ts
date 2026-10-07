/**
 * WP254（决策 100 / 123）：**下载源**（本机，每台机一份）——一键安装平台 CLI、下载连接器从哪儿取包。
 *
 * - 看：现在是官方源还是国内源（npmmirror），用户环境里有没有自己设的源；
 * - 改：失败那一行的「换国内源再试」先改成国内源再重试；「设置 · 诊断」里能改回官方源。
 *
 * 默认官方源。换源不换校验（连接器锁文件的 sha512、npm 本身的 sha512 照旧对）。
 * 与「一键安装」同一档权限：能点安装的人就能换源；AI 运行（`runtime` 令牌）不能改。
 */
import type { MaybePromise } from '@agentsws/contracts'
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

const TAG = 'npm-registry'

/** 下载源的样子（设置 · 诊断那一行）。 */
export interface NpmRegistryView {
  source: 'official' | 'npmmirror'
  /** 两个源的地址（界面上「详情」里给人看）。 */
  urls: { official: string; npmmirror: string }
  /** 用户环境里自己设了 `npm_config_registry`（官方源时实际用的是它；不回地址）。 */
  env_override: boolean
  updated_at?: string
}

export interface NpmRegistryPort {
  get(): MaybePromise<NpmRegistryView>
  set(source: 'official' | 'npmmirror'): MaybePromise<NpmRegistryView>
}

const SetBody = z.object({ source: z.enum(['official', 'npmmirror']) })

function portOf(deps: GatewayDeps): NpmRegistryPort {
  const p = deps.npmRegistry
  if (p === undefined)
    throw new ApiError(
      'not_implemented',
      '这个服务进程没有装配下载源设置（GatewayDeps.npmRegistry）',
    )
  return p
}

export function npmRegistryRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/settings/npm-registry',
        operationId: 'getNpmRegistry',
        summary:
          '下载源（每台机一份）：一键安装平台 CLI、下载连接器从官方源还是国内源取包（WP254）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'NpmRegistryView',
      },
      async (c, deps) => ok(c, await portOf(deps).get()),
    ),
    route(
      {
        method: 'put',
        path: '/v1/settings/npm-registry',
        operationId: 'setNpmRegistry',
        summary:
          '换下载源：official = 官方源（默认）/ npmmirror = 国内源。换源不换校验（锁文件与 npm 的 sha512 照旧对）。只给人点（WP254）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        body: SetBody,
        returns: 'NpmRegistryView',
      },
      async (c, deps) => {
        if (principalOf(c).kind === 'runtime')
          throw new ApiError('forbidden', '下载源只能由人在工作台上改，AI 运行不能调用')
        const input = await body(c, SetBody)
        return ok(c, await portOf(deps).set(input.source))
      },
    ),
  ]
}
