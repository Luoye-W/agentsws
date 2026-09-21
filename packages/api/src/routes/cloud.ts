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
  DataSourceRoute,
  KolCloudDeleteResult,
  KolCloudExport,
  KolCloudLocalStatus,
  KolCloudSyncRun,
  KolObjectKind,
  MaybePromise,
  Pricing,
  ServiceSubscription,
  TopupOrder,
  TopupTiers,
  UsageGroup,
  UsageReport,
} from '@agentsws/contracts'
import { KOL_OBJECT_KINDS } from '@agentsws/contracts'
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
  /**
   * 充值四档（67 §2，WP118）。取不到就回本地内置那一份——四张卡不该因为断网
   * 就变成一片空白（与价目表同一条）。
   */
  topupTiers(actor: CloudActor): MaybePromise<TopupTiers>
  /**
   * 按档建一笔充值单，回一个**去云上付款的链接**。
   *
   * 本地永远不碰卡号、不碰支付凭据——付款在 Stripe 自己的页面上（13 §4.3）。
   * 云上没配 Stripe 就回一句人话（501），不是一个红框。
   */
  createTopup(actor: CloudActor, input: { tier_id: string }): MaybePromise<TopupOrder>
  /**
   * 红人营销增值服务（67 §3，WP118）：本地看到的那一份状态。
   *
   * 没关联账号、没订阅、云连不通**都不是错**——回一句人话加一个状态，界面上那张卡
   * 照着画。这一条与 `credits` 同一条纪律：一张卡不该因为云上取不到就一片空白。
   */
  kolCloudStatus(actor: CloudActor): MaybePromise<KolCloudLocalStatus>
  /** 立即同步一趟：把本地改过的推上去，把云上改过的拉下来。 */
  kolCloudSync(actor: CloudActor): MaybePromise<KolCloudSyncRun>
  /** 开通（当场扣第一期 30 积分）。 */
  kolCloudSubscribe(actor: CloudActor): MaybePromise<ServiceSubscription>
  /** 取消（当期用完为止，**数据一条不动**）。 */
  kolCloudCancel(actor: CloudActor): MaybePromise<ServiceSubscription>
  /**
   * 一条同步冲突怎么处理。
   *
   * `winner` = 就这样（当前值不动），`loser` = 把被盖掉的那一份挑回来。两种都
   * **不删另一份**：输的那一份留在账上，导出时也一起带走。
   */
  kolCloudResolveConflict(
    actor: CloudActor,
    input: { kind: KolObjectKind; id: string; pick: 'winner' | 'loser' },
  ): MaybePromise<KolCloudSyncRun>
  /** 导出云端这一份（**欠费也给导**——这时候拦着等于拿数据当人质）。 */
  kolCloudExport(actor: CloudActor): MaybePromise<KolCloudExport>
  /** 删掉云端这一份。**本地一条不动**，订阅也不动（用户可能只是想清空重来）。 */
  kolCloudDelete(actor: CloudActor): MaybePromise<KolCloudDeleteResult>
  capabilitySources(actor: CloudActor): MaybePromise<CapabilitySourceSettings>
  setCapabilitySources(
    actor: CloudActor,
    input: {
      capability_sources: Record<string, 'mine' | 'agentsws'>
      /** WP126：数据接口路由（键 `kol.<channel>`）。不给就不改这一块。 */
      data_source_routing?: Record<string, DataSourceRoute> | undefined
    },
  ): MaybePromise<CapabilitySourceSettings>
}

/**
 * 改开关的请求体。
 *
 * **整张表一次给全**（不是逐项 patch）：这张表小、又是一个"现在到底谁在花钱"的
 * 快照，一次给全才能在界面上看见全貌，也不会因为两个标签页各改一项而互相覆盖。
 */
/** 按哪一档充。**只有档位 id，没有金额**——金额由云上那张表说了算。 */
const TopupBody = z.object({ tier_id: z.string().min(1).max(64) })

/**
 * 一条同步冲突怎么处理（67 §3）。
 *
 * `pick` 只有两个值，而且**没有"删掉两份"那一项**：输的那一份是用户的数据，
 * 处理冲突不等于同意扔掉它。
 */
const ConflictBody = z.object({
  kind: z.enum(KOL_OBJECT_KINDS as [KolObjectKind, ...KolObjectKind[]]),
  id: z.string().min(1).max(120),
  pick: z.enum(['winner', 'loser']),
})

const SourcesBody = z.object({
  capability_sources: z.record(z.string().min(1).max(64), z.enum(['mine', 'agentsws'])),
  // WP126：数据接口路由。等级枚举在服务端再洗一遍（zod 这一层只管形状）
  data_source_routing: z
    .record(
      z.string().min(1).max(64),
      z.object({
        order: z.array(z.enum(['official_key', 'byo_source', 'workshop'])).max(3),
        disabled: z.array(z.enum(['official_key', 'byo_source', 'workshop'])).max(3),
      }),
    )
    .optional(),
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
        path: '/v1/cloud/topup/tiers',
        operationId: 'getTopupTiers',
        summary: '充值四档（US$20 / 50 / 100 / 200，1 美元 = 7 积分）。价目数据化，不是代码',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'TopupTiers',
      },
      async (c, deps) => ok(c, await portOf(deps).topupTiers(actorOf(c))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/cloud/topup',
        operationId: 'createTopup',
        summary: '按档建一笔充值单，回一个去云上付款的链接。**本地不碰任何支付凭据**',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: TopupBody,
        returns: 'TopupOrder',
      },
      async (c, deps) => {
        const input = TopupBody.parse(await c.req.json())
        return ok(c, await portOf(deps).createTopup(actorOf(c), input), 201)
      },
    ),
    /*
     * ── 红人营销增值服务（67 §3，WP118）──────────────────────────────────
     *
     * 七条路由一件事：**本地这一份与云上那一份是两份数据**，谁都不是谁的备份。
     * 所以"删掉云上这一份"与"退订"是两条路，"同步"也不会替用户做任何删除决定
     * （冲突的两个版本都留着，见 `kolCloudResolveConflict`）。
     */
    route(
      {
        method: 'get',
        path: '/v1/cloud/kol/status',
        operationId: 'getKolCloudStatus',
        summary: '红人营销增值服务：订阅状态 + 待推条数 + 云端条数 + 没处理的冲突',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'KolCloudLocalStatus',
      },
      async (c, deps) => ok(c, await portOf(deps).kolCloudStatus(actorOf(c))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/cloud/kol/sync',
        operationId: 'syncKolCloud',
        summary: '立即同步一趟：推本地改过的、拉云上改过的。**任何一步失败都不动本地数据**',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        returns: 'KolCloudSyncRun',
      },
      async (c, deps) => ok(c, await portOf(deps).kolCloudSync(actorOf(c))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/cloud/kol/subscription',
        operationId: 'subscribeKolCloud',
        summary: '开通红人营销增值服务（30 积分 / 月，当场扣第一期）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        returns: 'ServiceSubscription',
      },
      async (c, deps) => ok(c, await portOf(deps).kolCloudSubscribe(actorOf(c)), 201),
    ),
    route(
      {
        method: 'delete',
        path: '/v1/cloud/kol/subscription',
        operationId: 'cancelKolCloud',
        summary: '取消（当期用完为止）。**数据一条不删**——删数据是另一条路',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        returns: 'ServiceSubscription',
      },
      async (c, deps) => ok(c, await portOf(deps).kolCloudCancel(actorOf(c))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/cloud/kol/conflicts/resolve',
        operationId: 'resolveKolCloudConflict',
        summary: '一条同步冲突处理完了：留当前值，或把被盖掉的那一份挑回来（两份都不删）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: ConflictBody,
        returns: 'KolCloudSyncRun',
      },
      async (c, deps) => {
        const input = await body(c, ConflictBody)
        return ok(c, await portOf(deps).kolCloudResolveConflict(actorOf(c), input))
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/cloud/kol/export',
        operationId: 'exportKolCloud',
        summary: '导出云端这一份（可读的 json，含被盖掉的那些版本）。**欠费也给导**',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'KolCloudExport',
      },
      async (c, deps) => ok(c, await portOf(deps).kolCloudExport(actorOf(c))),
    ),
    route(
      {
        method: 'delete',
        path: '/v1/cloud/kol',
        operationId: 'deleteKolCloud',
        summary: '删掉云端这一份。**本地一条不动、订阅也不动**（用户可能只是想清空重来）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        returns: 'KolCloudDeleteResult',
      },
      async (c, deps) => ok(c, await portOf(deps).kolCloudDelete(actorOf(c))),
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
