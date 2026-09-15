/**
 * 云侧那一面在本地的投影（49 M2 / M5，WP59）。
 *
 * 四条路由，两件事：
 *
 * 1. **余额与价目**（`/v1/cloud/credits`、`/v1/cloud/pricing`）——本地不自己算账，
 *    只是把云上的余额与本月用量透传过来（缓存 60 秒）。账本在云侧，本地这一层
 *    连一个数字都不该自己记：两本账必然对不上（49 §1 的同一条理由）。
 * 2. **每项能力用谁的**（`/v1/settings/capability-sources`）——49 M2 那个开关。
 *    默认全 `mine`（开源本地优先，40 §1）：填自己的 key、本地直连、一分不扣。
 *
 * 权限与模型面同一套元组：读走 `store_config.read@workspace`，改走
 * `policy.stage@workspace`——花钱的事归所有者，客服岗位看不到也改不了（05）。
 */
import type {
  CapabilitySourceSettings,
  CloudCreditsView,
  MaybePromise,
  Pricing,
  UsageGroup,
  UsageReport,
} from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { assignmentOf, body, ok, principalOf } from '../helpers.js'
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

const TAG = 'cloud'

export interface CloudActor {
  workspace_id: string
  person_id: string
  assignment_id: string
  role_id: string
}

export interface CloudPort {
  /** 余额 + 本月用了多少积分。没关联账号回 `{ linked: false, reason }`，**不是错**。 */
  credits(actor: CloudActor): MaybePromise<CloudCreditsView>
  /** 价目表（云上那份；取不到就回本地内置的那份）。 */
  pricing(actor: CloudActor): MaybePromise<Pricing>
  /**
   * 用量明细（按能力 / 按工作区 / 按天）。
   *
   * **看得到多少由云上那把令牌说了算**：owner 那把看整个组织，成员那把只看自己
   * 那个工作区。本地这一层不做第二次裁剪——裁两次就会有一次是错的。
   */
  usage(
    actor: CloudActor,
    filter: { group: UsageGroup; from?: string | undefined; to?: string | undefined },
  ): MaybePromise<UsageReport | undefined>
  capabilitySources(actor: CloudActor): MaybePromise<CapabilitySourceSettings>
  setCapabilitySources(
    actor: CloudActor,
    input: { capability_sources: Record<string, 'mine' | 'agentsws'> },
  ): MaybePromise<CapabilitySourceSettings>
}

/**
 * 改开关的请求体。
 *
 * **整张表一次给全**（不是逐项 patch）：这张表小、又是一个"现在到底谁在花钱"的
 * 快照，一次给全才能在界面上看见全貌，也不会因为两个标签页各改一项而互相覆盖。
 */
const SourcesBody = z.object({
  capability_sources: z.record(z.string().min(1).max(64), z.enum(['mine', 'agentsws'])),
})

function portOf(deps: GatewayDeps): CloudPort {
  const p = deps.cloud
  if (p === undefined)
    throw new ApiError('not_implemented', '这个服务进程没有装配云侧那一面（GatewayDeps.cloud）')
  return p
}

function actorOf(c: Parameters<typeof principalOf>[0]): CloudActor {
  const p = principalOf(c)
  const a = assignmentOf(c)
  return {
    workspace_id: p.workspace_id,
    person_id: p.person_id,
    assignment_id: a.id,
    role_id: a.role_id,
  }
}

export function cloudRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/cloud/credits',
        operationId: 'getCloudCredits',
        summary:
          '云上的余额（两类积分分开）与本月用了多少积分。没关联账号时回 linked=false + 一句人话，**不是错**',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'CloudCreditsView',
      },
      async (c, deps) => ok(c, await portOf(deps).credits(actorOf(c))),
    ),
    route(
      {
        method: 'get',
        path: '/v1/cloud/pricing',
        operationId: 'getCloudPricing',
        summary: '积分价目表（能力 → 单位 → 积分）。对用户只显示最终积分价',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'Pricing',
      },
      async (c, deps) => ok(c, await portOf(deps).pricing(actorOf(c))),
    ),
    route(
      {
        method: 'get',
        path: '/v1/cloud/usage',
        operationId: 'getCloudUsage',
        summary:
          '积分用量明细（按能力 / 按工作区 / 按天）。**只聚合计量事件**，聚合不出任何正文。没关联账号时回 null',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [
          {
            name: 'group',
            in: 'query',
            required: false,
            description: 'capability（默认）/ workspace / day',
          },
          { name: 'from', in: 'query', required: false, description: 'ISO 时间；默认本月一号' },
          { name: 'to', in: 'query', required: false, description: 'ISO 时间；默认现在' },
        ],
        returns: 'UsageReport | null',
      },
      async (c, deps) => {
        const raw = c.req.query('group')
        if (raw !== undefined && raw !== 'capability' && raw !== 'workspace' && raw !== 'day') {
          throw new ApiError('invalid_input', 'group 只能是 capability / workspace / day')
        }
        const from = c.req.query('from')
        const to = c.req.query('to')
        const report = await portOf(deps).usage(actorOf(c), {
          group: raw ?? 'capability',
          ...(from === undefined ? {} : { from }),
          ...(to === undefined ? {} : { to }),
        })
        return ok(c, report ?? null)
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/settings/capability-sources',
        operationId: 'getCapabilitySources',
        summary: '每项能力"用我的 / 用 agentsws 的"（49 M2）。缺的那些一律是 mine',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'CapabilitySourceSettings',
      },
      async (c, deps) => ok(c, await portOf(deps).capabilitySources(actorOf(c))),
    ),
    route(
      {
        method: 'put',
        path: '/v1/settings/capability-sources',
        operationId: 'setCapabilitySources',
        summary: '改开关。切换即时生效、随时切回；切回"用我的"之后不再产生任何扣费（49 M2）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: SourcesBody,
        returns: 'CapabilitySourceSettings',
      },
      async (c, deps) => {
        const input = await body(c, SourcesBody)
        return ok(c, await portOf(deps).setCapabilitySources(actorOf(c), input))
      },
    ),
  ]
}
