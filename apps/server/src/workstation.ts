/**
 * 36 工作台端口的服务端实现。
 *
 * 「岗位」= 一条 Assignment（`position_id === assignment_id`），所以这里只是把
 * 职责库 + 审批总线 + 一个数据源包成 `WorkstationPort`；数怎么算在 `@agentsws/deck`，
 * 界面怎么画在 `apps/workstation`——这一层不算数也不画。
 */
import type {
  PositionSummary,
  WorkstationActor,
  WorkstationPort,
  WorkstationRange,
} from '@agentsws/api'
import type { ApprovalBus, ApprovalItem, Clock, ObjectRef } from '@agentsws/contracts'
import type {
  AdsDeckData,
  DataSourceStatus,
  DeckCard,
  InventoryRow,
  KolDeckData,
  OrderRow,
  PostRow,
  QueryContext,
  ReviewRow,
  SocialDeckData,
} from '@agentsws/deck'
import { defaultTilesFor, PLANNED_SOURCE_NOTES } from '@agentsws/deck'
import type { RoleStore } from '@agentsws/roles'

/** 工作台要的那点外部数据；接了连接器就换成真的，没接就 `connected: false`。 */
export interface WorkstationDataSource {
  /**
   * 店铺侧的订单行（v1 来自 mock OpenConnector 的状态）。
   *
   * 44 G2：给了 `view.assignment_id` 就按这个岗位的产品线切一刀——一张混了两条
   * 产品线的订单两边都看得见，但金额只算自己那部分行项目。不给（老调用方）原样回全部。
   */
  orders(view?: { assignment_id?: string }): OrderRow[]
  /**
   * WP63：库存行（库存告急表、「库存告急数」、断货异常卡都从它算）。
   * 不给 = 这台机器还拉不到库存，那几块自己就是空的——不编数。
   */
  inventory?(view?: { assignment_id?: string }): InventoryRow[]
  /**
   * WP63：评价行。评价应用连接器待增加，所以它今天一定不存在——
   * 差评那一块照 36 §3 出"还没连"而不是空表。
   */
  reviews?(view?: { assignment_id?: string }): ReviewRow[]
  /** WP63：文章与页面（草稿队列、近 30 天发布）。 */
  posts?(view?: { assignment_id?: string }): PostRow[]
  /**
   * WP67（48 §5.1）：红人面板五块要的那几行。
   *
   * 不给 = 这台机器上还没有红人岗位，五块是空表。与"还没连"分得开：
   * 红人库永远算连上（`ALWAYS_CONNECTED`），空的意思是"还没有人，先导入一张表"。
   */
  kol?(view?: { assignment_id?: string }): KolDeckData | undefined
  /**
   * WP72（56 §2）：社媒面板那几块要的行。
   *
   * 不给 = 这台机器上还没有社媒岗位，那几块是空表。与"还没连"分得开：
   * 社媒库永远算连上（`ALWAYS_CONNECTED`），空的意思是"还没排内容，先排一条"；
   * "还没连"说的是渠道那八个源（一条渠道一个，连哪条亮哪条）。
   */
  social?(view?: { assignment_id?: string }): SocialDeckData | undefined
  /**
   * WP75（57 §3）：投放面板那几块要的行。
   *
   * 不给 = 这台机器上还没有投放岗位，那几块是空表。与"还没连"分得开：
   * campaign 表与止损记录是**我们自己库里**的行，空的意思是"还没有广告账户，
   * 先连一个平台"；"还没连"说的是四个平台那四个源（连哪个亮哪个）。
   */
  ads?(view?: { assignment_id?: string }): AdsDeckData | undefined
  /** 数据源连接状态（36 §3：没接的显示「去连接」而不是空图） */
  sources(): DataSourceStatus[]
  /** ObjectRef → 人话 */
  label(ref: ObjectRef): string | undefined
  /** 工作区时区偏移（分钟），日界线按它切 */
  tz_offset_minutes: number
  base_currency: string
  /** 系统卡与每日摘要；v1 缺省没有 */
  systemCards?(actor: WorkstationActor): { alerts: DeckCard[]; digest?: DeckCard }
  /**
   * WP46：读之前先把数据拉新一轮（活数据源用；写死的表不需要，所以是可选的）。
   *
   * `orders()` / `sources()` 是同步的——不能在里面等一次上游请求。于是把「要不要
   * 拉一轮」放在这里：`queryContext` 组装之前 await 一次，缓存还新就立刻返回。
   * **永不抛**：上游挂了就用上一份缓存，面板照常出，不该让整页 500。
   */
  ensureFresh?(): Promise<void>
}

/** 队列上的状态；记录 Tab 要看全部。 */
const OPEN_STATES = ['pending', 'in_review'] as const
const ALL_STATES = [
  'pending',
  'in_review',
  'approved',
  'approved_edited',
  'auto_approved',
  'rejected',
  'deferred',
  'applying',
  'applied',
  'apply_failed',
  'expired',
  'withdrawn',
  'superseded',
] as const

export interface WorkstationPortOptions {
  clock: Clock
  roles: RoleStore
  approvals: ApprovalBus
  data: WorkstationDataSource
  /** 用户挑过的数字块与时间范围（v1 内存；换机迁移时随个人设置走） */
  preferences?: Map<string, { tile_ids: string[]; range: WorkstationRange }>
}

export function createWorkstationPort(options: WorkstationPortOptions): WorkstationPort {
  const prefs =
    options.preferences ?? new Map<string, { tile_ids: string[]; range: WorkstationRange }>()

  const summarize = (assignment_id: string, role_id: string): PositionSummary => {
    const config = options.roles.effectiveConfig(assignment_id)
    const definition = options.roles.roles.get(role_id)
    const defaults = defaultTilesFor(role_id)
    const pref = prefs.get(assignment_id)
    return {
      position_id: assignment_id,
      role_id,
      role_name: definition?.name.zh ?? role_id,
      ranges: [...config.ranges],
      ready: config.ready,
      missing_connectors: [...config.missing_connectors],
      tile_ids: pref?.tile_ids ?? defaults,
      range: pref?.range ?? 'yesterday',
      show_tiles: (pref?.tile_ids ?? defaults).length > 0,
    }
  }

  const positions = (actor: WorkstationActor): PositionSummary[] =>
    options.roles.assignments
      .listByPerson(actor.person_id, { workspace_id: actor.workspace_id })
      .filter((a) => a.revoked_at === undefined)
      .map((a) => summarize(a.id, a.role_id))

  const itemsFor = async (
    actor: WorkstationActor,
    position: PositionSummary,
    states: readonly string[],
  ): Promise<ApprovalItem[]> => {
    const rows = await options.approvals.queue({
      workspace_id: actor.workspace_id,
      person_id: actor.person_id,
      lane: 'mine',
      role_id: position.role_id,
      state: [...states] as ApprovalItem['state'][],
    })
    return rows
  }

  return {
    positions,

    items: (actor, position) => itemsFor(actor, position, OPEN_STATES),

    async queryContext(actor, position, range): Promise<QueryContext> {
      // 活数据源在这里拉新（缓存还新就是个空操作）；写死的表没有这个方法
      await options.data.ensureFresh?.()
      const view = { assignment_id: position.position_id }
      const inventory = options.data.inventory?.(view)
      const reviews = options.data.reviews?.(view)
      const posts = options.data.posts?.(view)
      const kol = options.data.kol?.(view)
      const social = options.data.social?.(view)
      const ads = options.data.ads?.(view)
      const thresholds = options.roles.roles.get(position.role_id)?.thresholds
      return {
        now: options.clock.now(),
        tz_offset_minutes: options.data.tz_offset_minutes,
        base_currency: options.data.base_currency,
        role_id: position.role_id,
        position_id: position.position_id,
        // 44 G2：岗位视角——挂产品线的岗位只看得到自己那条线的订单与金额
        orders: options.data.orders({ assignment_id: position.position_id }),
        // 记录 Tab 与几个「存量」指标要看全部状态，不只是队列里那几条
        approvals: await itemsFor(actor, position, ALL_STATES),
        sources: options.data.sources(),
        ...(inventory === undefined ? {} : { inventory }),
        ...(reviews === undefined ? {} : { reviews }),
        ...(posts === undefined ? {} : { posts }),
        ...(kol === undefined ? {} : { kol }),
        ...(social === undefined ? {} : { social }),
        ...(ads === undefined ? {} : { ads }),
        // WP63（51 §2.1）：异常卡的阈值从**职责定义**来，不硬写在积木里——
        // 什么叫"销售骤降"，卖家具的和卖快消的不是一个数
        ...(thresholds === undefined ? {} : { thresholds }),
        ...(range === undefined ? {} : {}),
      }
    },

    systemCards: (actor) => options.data.systemCards?.(actor) ?? { alerts: [] },

    label: (ref) => options.data.label(ref),

    setHomeTiles(_actor, input) {
      const previous = prefs.get(input.position_id)
      prefs.set(input.position_id, {
        tile_ids: input.tile_ids,
        range: input.range ?? previous?.range ?? 'yesterday',
      })
      const assignment = options.roles.assignments.get(input.position_id)
      if (assignment === undefined) throw new Error(`没有这个岗位：${input.position_id}`)
      return summarize(assignment.id, assignment.role_id)
    },
  }
}

/** 没有任何连接器时的数据源：什么都没接，界面上全是「去连接」。 */
export function emptyDataSource(
  tz_offset_minutes = 480,
  base_currency = 'USD',
): WorkstationDataSource {
  const sources: DataSourceStatus[] = [
    { id: 'shop', label: '店铺后台', connected: false },
    { id: 'approvals', label: '工作队列', connected: true },
    { id: 'ga4', label: 'GA4', connected: false },
    { id: 'gsc', label: 'Search Console', connected: false },
    { id: 'ads', label: '广告后台', connected: false },
    { id: 'csat', label: '满意度调查', connected: false },
    // WP64：连接器还是骨架，这两块永远是「去连接」（36 §3：明说，不出空图）
    { id: 'email_marketing', label: '邮件营销后台', connected: false },
    { id: 'tracking', label: '物流追踪', connected: false },
    // WP63：评价应用的连接器还没做——这一条永远 `connected: false`，并带那句人话
    {
      id: 'reviews',
      label: '评价应用',
      connected: false,
      note: PLANNED_SOURCE_NOTES.reviews ?? '',
    },
  ]
  return {
    orders: () => [],
    sources: () => sources,
    label: () => undefined,
    tz_offset_minutes,
    base_currency,
  }
}
