/**
 * `agentsws demo`（36 §5.7 / 37 §3）：用合成世界当后端，把工作台跑起来。
 *
 * 做的事就四件：
 * 1. 用 `packs/dtc-3c-3p` 建一个合成世界（`createWorld`，runtime `stub`），
 * 2. 把「退货窗口内」场景**跑到产生审批项为止**——回复草稿卡与退款变更卡是真跑出来的，不是写死的，
 * 3. 种一份工作模型（37）：1 个公司目标 + 2 个岗位目标、3 条长期待办、1 个 `conversation`
 *    事项（就是那封 Anna 的信）、今天一张 `daily_plan` 卡，
 * 4. 把这个世界接进服务进程（同一进程），在 127.0.0.1:4317 上托管工作台。
 *
 * 纪律：全程 **stub 模型**（`runtime: 'stub'` 根本不叫模型），所以事件日志里不该有任何 `model.*`；
 * 时间走合成时钟，随机走 seed，没有一处 `Date.now()` / `Math.random()`。
 */
import { readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type {
  ApprovalItem,
  DailyPlanDraft,
  InboundEvent,
  Iso8601,
  ObjectRef,
  RangeRef,
  RunEvent,
} from '@agentsws/contracts'
import type { DataSourceStatus, DeckCard, InventoryRow, OrderRow, PostRow } from '@agentsws/deck'
import { PLANNED_SOURCE_NOTES } from '@agentsws/deck'
import { contentHashOf } from '@agentsws/knowledge'
import { parseRole } from '@agentsws/roles'
import type {
  MatterRecordSource,
  MountedWorld,
  Server,
  WorkstationDataSource,
} from '@agentsws/server'
import { createServer, periodQueryRunner } from '@agentsws/server'
import type { Pack, RunContext, World } from '@agentsws/simulation'
import { buildRunRequest, createWorld, loadPack, parseScenario } from '@agentsws/simulation'
import { connectToolExecutor } from '@agentsws/stand-ins'
import { cardRefOf, DAY_MS, planSummary, planTitle, type Work } from '@agentsws/work'

export const DEMO_PACK = 'packs/dtc-3c-3p'
export const DEMO_SCENARIO = 'scenarios/aftersales/return-within-window.yml'

/**
 * 04 §1.11 的独立站运营岗位里的分析职责。
 *
 * `packages/roles` 目前只自带三个职责，而 36 §3 的示例默认值里「独立站运营」是一条独立的数据条，
 * 所以 demo 在这里补一份最小定义（只读，没有任何写动作）。真要长期存在，它属于职责包，
 * 不属于 demo——这条写进了交付报告的「需要契约改动 / 后续」。
 */
const ANALYTICS_ROLE = `
id: dtc.analytics
version: 1.0.0
domain: dtc
name: { zh: 独立站运营, en: DTC Operations }
description: 店铺销售、流量与转化的日常盯盘（只读）
scopes:
  - { domain: order, ops: [read], range: assigned, max_sensitivity: internal }
  - { domain: analytics, ops: [read], range: assigned, max_sensitivity: internal }
  - { domain: approval, ops: [read], range: own, max_sensitivity: internal }
connectors:
  - { kind: shopify, required: true, grants: [read_orders], ownership: workspace }
actions: []
automation: {}
skills: []
home_blocks: []
notifications: []
handover:
  transfers: [home_blocks]
  fallback: owner
  revoke_context_on_removal: false
requires: []
`

export interface DemoOptions {
  /** 仓库根（`packs/` 与 `apps/workstation/dist` 都相对它找） */
  root: string
  port?: number
  quiet?: boolean
  /** 工作台构建产物；不给就按 `apps/workstation/dist` 找 */
  staticDir?: string
  /**
   * WP66（52 O1）：多造一个品牌，用来看"一个进程装多套品牌模块"长什么样。
   *
   * **默认不造**（`false`）：demo 的本分是把一个品牌的活演完整，多一个品牌只会
   * 让第一眼看到的东西变多。`agentsws demo --two-brands` 打开它——
   * 公司页的品牌一览就有两行、各有各的待审卡 / 告警 / 今日销售。
   */
  twoBrands?: boolean
  /**
   * WP96：再种十一张卡，**十一种排版各一张**（09-18 设计画布《卡片排版一览》）。
   *
   * **默认不造**：demo 的本分是把一件真事演完整，十一张摆拍卡会把队列冲掉。
   * `agentsws demo --card-gallery` 打开它，用来出那张卡片一览的截图，
   * 也用来一眼看出"第十二种排版出现了却没人给它样子"。
   */
  cardGallery?: boolean
}

export interface Demo {
  server: Server
  world: World
  pack: Pack
  /** 施行队列：批准之后由它把变更真的施行掉（15 §5「通过 ≠ 施行」） */
  drain(): Promise<void>
  close(): Promise<void>
}

const fromRoot = (root: string, p: string): string => (isAbsolute(p) ? p : resolve(root, p))

/** 把 mock connect 的订单摊成工作台要的行（数在服务端算，前端只渲染）。 */
function ordersOf(world: World): OrderRow[] {
  return world.connect.state.orders.map((o) => ({
    id: o.id,
    name: o.name,
    email: o.email,
    currency: o.currency,
    created_at: o.created_at,
    ...(o.delivered_at === undefined ? {} : { delivered_at: o.delivered_at }),
    total_price: o.total_price,
    refunded_amount: o.refunded_amount,
    financial_status: o.financial_status,
    fulfillment_status: o.fulfillment_status,
  }))
}

/**
 * WP63：把合成世界里的商品摊成库存行。
 *
 * 没有 `inventory` 那一格的 pack（存量数据集）一行都不出——**不当成 0**，
 * 那样整店都会被报成断货（36 §3：算不出就说没有，不是编一个数）。
 */
function inventoryOf(world: World): InventoryRow[] {
  return world.connect.state.products
    .filter((p) => typeof p.inventory === 'number')
    .map((p) => ({
      id: `inv_${p.id}`,
      product_id: p.id,
      sku: p.id.toUpperCase(),
      title: p.title,
      quantity: p.inventory as number,
      location: '主仓',
    }))
}

/**
 * WP63（51 §2.2）：文章与页面。
 *
 * 合成公司里没有博客数据集，所以这里给一份**最小的、算得出来的**：每件商品
 * 一篇写它的草稿。它只为让「草稿队列」这一块在 demo 里不是空的——真数据来自
 * 店铺后台的 `list_articles`（连接器那条路，不在 demo 的范围里）。
 */
function postsOf(world: World, now: Iso8601): PostRow[] {
  return world.connect.state.products.slice(0, 4).map((p, i) => ({
    id: `art_${p.id}`,
    title: `${p.title} 怎么挑`,
    kind: 'article' as const,
    published: i < 2,
    updated_at: now,
    ...(i < 2 ? { published_at: now } : {}),
    author: '李默',
  }))
}

function dataSourceOf(world: World, pack: Pack): WorkstationDataSource {
  const sources: DataSourceStatus[] = [
    // 店铺后台 = mock OpenConnector，接上了；其余三个 demo 里都没连
    { id: 'shop', label: '店铺后台', connected: true },
    { id: 'approvals', label: '工作队列', connected: true },
    { id: 'ga4', label: 'GA4', connected: false },
    { id: 'gsc', label: 'Search Console', connected: false },
    { id: 'ads', label: '广告后台', connected: false },
    { id: 'csat', label: '满意度调查', connected: false },
    // WP64：邮件营销后台与物流追踪的连接器还是骨架 —— demo 里也照实说没连
    { id: 'email_marketing', label: '邮件营销后台', connected: false },
    { id: 'tracking', label: '物流追踪', connected: false },
    // WP63：评价应用的连接器还没做 —— 永远没连，并带上那句人话（51 §3 N2）
    {
      id: 'reviews',
      label: '评价应用',
      connected: false,
      note: PLANNED_SOURCE_NOTES.reviews ?? '',
    },
  ]
  const alerts: DeckCard[] = []
  return {
    orders: () => ordersOf(world),
    inventory: () => inventoryOf(world),
    // 评价应用没接：一条评价都没有，差评那一块出的是"还没连"不是空表
    reviews: () => [],
    posts: () => postsOf(world, world.clock.now()),
    sources: () => sources,
    label: (ref: ObjectRef) => {
      if (ref.type === 'customer') return pack.customers.find((c) => c.id === ref.id)?.name
      if (ref.type === 'order') return world.connect.state.orders.find((o) => o.id === ref.id)?.name
      return undefined
    },
    tz_offset_minutes: 480,
    base_currency: pack.workspace.base_currency,
    systemCards: () => ({ alerts }),
  }
}

/**
 * WP63（51 §2.1 / §2.2）：给 demo 的店铺管理面板铺几条真活。
 *
 * 四条车道各来一条、外加一张日报卡——全部走**真的**那条链（真读记录、真提案、
 * 真过 guardrail），不是往队列里塞几张假卡。于是 demo 里看到的"待审 4 条"
 * 与线上看到的是同一种东西：点开有 diff、有理由、有额度命中。
 *
 * 提案人是运营李默，卡落到店主手上——3 人公司里最常见的那种分工。
 */
async function seedStoreWork(world: World, pack: Pack): Promise<void> {
  const ops = pack.people.find((p) => p.id === 'p_li')?.id
  if (ops === undefined) return
  // ① 改价车道：降 31%，超过 20% 的线 → 命中额度，卡上说得出超了多少
  await world.shop.priceChange({
    who: ops,
    product: 'prod_2',
    price: 61,
    note: '清库存，力度大一点',
  })
  // ② 上下架车道：永远人审
  await world.shop.publishProduct({
    who: ops,
    product: 'prod_4',
    publish: true,
    note: '新到的车载支架，上架卖',
  })
  // ③ 文案车道：改一篇博客（草稿，不惊动人；发布那一下才要人点头）
  await world.shop.blogPost({
    who: ops,
    title: '快充头怎么挑：三个看得懂的参数',
    publish: true,
  })
  // ④ 日报卡：L3 自动出、看完归档
  await world.shop.dailyReport({ who: ops })
}

/**
 * 事项现场的记录来源（37 §2.2b）：委托与「在事项里说话」起 Run 时，
 * pinned 的订单 / 客户按本人身份取真记录注入，收件人只从这里解析（31 §3.3）。
 */
function recordSourceOf(world: World, pack: Pack): MatterRecordSource {
  return {
    record: (ref: ObjectRef) => {
      if (ref.type === 'order') return world.connect.state.orders.find((o) => o.id === ref.id)
      if (ref.type === 'customer') return pack.customers.find((c) => c.id === ref.id)
      return undefined
    },
    label: (ref: ObjectRef) => {
      if (ref.type === 'customer') return pack.customers.find((c) => c.id === ref.id)?.name
      if (ref.type === 'order') return world.connect.state.orders.find((o) => o.id === ref.id)?.name
      return undefined
    },
    contactOf: (email: string) => world.customerRefOf(email),
    readToken: () => world.issueReadToken(),
    executeTool: connectToolExecutor(world.connect),
  }
}

/** 把一封来信喂进世界，跑一次运行——这一步会产出回复草稿卡与退款变更卡。 */
async function runInbound(world: World, pack: Pack, seed: number, body: string): Promise<void> {
  const thread = { id: 'thr_demo_1', subject: 'Return request for #1001' }
  const participants = ['anna@example.com', `support@${pack.workspace.id}.example`]
  if (!world.connect.state.threads.some((t) => t.id === thread.id)) {
    world.connect.state.threads.push({
      id: thread.id,
      subject: thread.subject,
      participants: [...participants],
      message_ids: [],
    })
  }
  const { event: inbound } = await world.inbound.ingest(
    'email',
    {
      from: 'anna@example.com',
      to: [`support@${pack.workspace.id}.example`],
      subject: thread.subject,
      body,
      thread_id: thread.id,
      at: world.clock.now(),
    },
    world.workspace_id,
  )
  if (inbound === undefined) return

  const run_id = `run_demo_${seed}`
  const customer = pack.customerByEmail('anna@example.com')
  const order = pack.orders.find((o) => o.id === 'ord_1001')
  const ctx: RunContext = {
    run_id,
    inbound: inbound as InboundEvent,
    thread: {
      id: thread.id,
      ref: { type: 'thread', id: thread.id },
      subject: thread.subject,
      participants,
    },
    change_set_id: `cs_${run_id}`,
    child_approval_ids: [],
    events: [],
    ...(customer === undefined
      ? {}
      : { requester: { customer, ref: { type: 'customer', id: customer.id } } }),
    ...(order === undefined
      ? {}
      : {
          order: {
            id: order.id,
            ref: { type: 'order', id: order.id },
            ...(customer === undefined
              ? {}
              : { owner: { type: 'customer', id: customer.id } as ObjectRef }),
          },
        }),
  }
  world.runContexts.set(run_id, ctx)

  const request = await buildRunRequest({ world, ctx, inbound: inbound as InboundEvent, seed })
  ctx.request = request
  world.appendEvent('simulation.run_request', { request }, { run_id })
  const sink = (e: RunEvent): void => {
    ctx.events.push(e)
    world.appendRunEvent(request, e)
  }
  await world.runtime.run(request, sink, new AbortController().signal)
}

/**
 * 36 §2.2 的「业务边界问题」卡：第一次遇到就以选择题问一次，答案沉淀为策略（24 的 lesson → 提案）。
 * 场景本身不产这种卡，demo 手工建一条，好让工作台的选择题形态在首屏就能看见。
 */
async function seedPolicyQuestion(world: World): Promise<ApprovalItem> {
  return world.txn.approvals.create({
    workspace_id: world.workspace_id,
    schema_version: 1,
    kind: 'policy_change',
    role_id: world.role_id,
    subject: { object: { type: 'policy', id: 'pol_return_grace' } },
    dedupe_key: `${world.workspace_id}:policy_change:return_grace`,
    title: '超过退货窗口一周的请求，怎么办？',
    summary: '这周碰到 3 次。定一个答案，以后 Agent 自己按它走，不再问你。',
    payload: {
      target: 'workspace_policy',
      before: { late_return_grace_days: 0 },
      after: { late_return_grace_days: 7 },
      affected_assignments: [world.assignment.id],
      options: [
        { id: 'grace_7', label: '宽限 7 天，照常退款' },
        { id: 'store_credit', label: '只给店铺余额，不原路退款' },
        { id: 'refuse', label: '一律不退，按条款回绝' },
      ],
    },
    evidence: {
      source_events: [],
      provenance: { seen: [{ type: 'fact_card', id: 'fc_return_policy' }] },
      precheck: { permission_diff: 'ok', semantic_diff: 'ok' },
    },
    proposer: { kind: 'agent', id: 'agent_aftersales', assignment_id: world.assignment.id },
    automation: {
      level_at_creation: 'L1',
      auto_approved: false,
      mandate_check: { within: true, caps_hit: [] },
      sampling: { selected: false },
    },
    routing: {
      recipients: [{ person: world.owner, via: 'owner' }],
      rule: 'owner',
      escalation: {
        after_hours: 48,
        business_hours: true,
        chain: ['owner'],
        escalated_at: [],
      },
      separation_of_duties: false,
    },
    priority: 'queue',
  })
}

/**
 * WP96：十一种排版各一张（09-18 设计画布《卡片排版一览》）。
 *
 * 这些卡是**摆拍**：`--card-gallery` 才种，默认不种。它们走的是与真卡完全同一条路
 * （`world.txn.approvals.create` → `projectCard` → `layoutFor`），所以截出来的东西
 * 与真跑出来的一模一样——摆的是数据，不是界面。
 *
 * 十一种里有三种不用在这儿造：`outbound`（场景真跑出来的回信卡）、
 * `money`（退款变更卡）、`policy`（`seedPolicyQuestion` 那张边界问题卡）。
 */
async function seedCardGallery(world: World): Promise<void> {
  const base = {
    workspace_id: world.workspace_id,
    schema_version: 1 as const,
    role_id: world.role_id,
    evidence: {
      source_events: [],
      provenance: { seen: [] },
      precheck: { permission_diff: 'ok' as const, semantic_diff: 'ok' as const },
    },
    proposer: {
      kind: 'agent' as const,
      id: 'agent_store',
      assignment_id: world.assignment.id,
    },
    automation: {
      level_at_creation: 'L2' as const,
      auto_approved: false,
      mandate_check: { within: true, caps_hit: [] },
      sampling: { selected: false },
    },
    routing: {
      recipients: [{ person: world.owner, via: 'owner' as const }],
      rule: 'owner' as const,
      escalation: {
        after_hours: 24,
        business_hours: true,
        chain: ['owner' as const],
        escalated_at: [],
      },
      separation_of_duties: false,
    },
    priority: 'queue' as const,
  }

  /** ② 改动：before / after 双格 */
  await world.txn.approvals.create({
    ...base,
    kind: 'staged_change',
    subject: { object: { type: 'product', id: 'GB-12-CLR' } },
    // 写类卡的 provenance 必查：target 没在 `seen` 里，precheck 当场判 blocked
    evidence: { ...base.evidence, provenance: { seen: [{ type: 'product', id: 'GB-12-CLR' }] } },
    dedupe_key: `gallery_price_change:${world.workspace_id}:1`,
    title: 'GB-12-CLR 从 US$14.90 降到 US$13.40',
    summary:
      '竞品同款 US$13.99，我们不做最低价，差 10% 以内可以（职责记忆）。库存 42 件，不在告急线。',
    payload: {
      kind: 'price_change',
      before: { price: 'US$14.90' },
      after: { price: 'US$13.40（-10.1%）' },
    },
  })

  /** ③ 发布：左预览右说明 + 排期 + 受众数 */
  await world.txn.approvals.create({
    ...base,
    kind: 'staged_change',
    subject: { object: { type: 'post', id: 'post_unbox' } },
    // 写类卡的 provenance 必查：target 没在 `seen` 里，precheck 当场判 blocked
    evidence: { ...base.evidence, provenance: { seen: [{ type: 'post', id: 'post_unbox' }] } },
    dedupe_key: `gallery_social_post:${world.workspace_id}:1`,
    title: 'IG 帖子 · 三件套开箱，明天 14:00 发',
    summary: '开箱三件套：12cm 透明、16cm 琥珀、三件礼盒装。#glassbowl #kitchen',
    payload: {
      kind: 'social_post',
      channel: 'instagram',
      scheduled_at: '明天 14:00',
      audience: '1,204 人',
      after: { state: 'scheduled' },
    },
  })

  /** ⑤ 选择：路由拿不准，人点一个 */
  await world.txn.approvals.create({
    ...base,
    kind: 'ai_question',
    subject: { object: { type: 'work_item', id: 'mat_gallery' } },
    dedupe_key: `gallery_ai_question:${world.workspace_id}:1`,
    title: '这件事像两条职责，你定',
    summary: '命中「改价 · 商品」的是店铺管理，命中「页面 · 文案」的是内容与博客。',
    payload: {
      options: [
        { id: 'store', label: '店铺管理 · 命中 改价 · 商品' },
        { id: 'content', label: '内容与博客 · 命中 页面 · 文案' },
      ],
    },
  })

  /** ⑥ 变体：缩略图格 */
  await world.txn.approvals.create({
    ...base,
    kind: 'staged_change',
    subject: { object: { type: 'asset', id: 'banner_set3' } },
    // 写类卡的 provenance 必查：target 没在 `seen` 里，precheck 当场判 blocked
    evidence: { ...base.evidence, provenance: { seen: [{ type: 'asset', id: 'banner_set3' }] } },
    dedupe_key: `gallery_design_variant:${world.workspace_id}:1`,
    title: '首页 Banner · 三件套 · 挑一张',
    summary: '六张里挑一张；定稿入库另出一张永远人审的卡。',
    payload: {
      kind: 'design_variant',
      variants: [
        { id: 'v1' },
        { id: 'v2' },
        { id: 'v3' },
        { id: 'v4' },
        { id: 'v5' },
        { id: 'v6' },
      ],
    },
  })

  /** ⑦ 事后决定：系统已经止损了，问要不要恢复 */
  await world.txn.approvals.create({
    ...base,
    kind: 'staged_change',
    subject: { object: { type: 'campaign', id: 'cmp_autumn' } },
    // 写类卡的 provenance 必查：target 没在 `seen` 里，precheck 当场判 blocked
    evidence: { ...base.evidence, provenance: { seen: [{ type: 'campaign', id: 'cmp_autumn' }] } },
    dedupe_key: `gallery_pause_ad:${world.workspace_id}:1`,
    title: '秋季新品 campaign 已自动暂停，要恢复吗',
    summary: 'ROAS 连续两小时低于止损线，11:42 按 L3 自动停了。',
    payload: {
      kind: 'pause_ad',
      facts: {
        ROAS: '0.6（线 1.0）',
        今日花费: 'US$400 · 日预算 40%',
        暂停时间: '11:42 · 自动 L3',
      },
    },
  })

  /** ⑧ 人物：头像 + 资料摘要 + 规则匹配 */
  await world.txn.approvals.create({
    ...base,
    kind: 'staged_change',
    subject: { object: { type: 'person', id: 'maria_k' } },
    // 写类卡的 provenance 必查：target 没在 `seen` 里，precheck 当场判 blocked
    evidence: { ...base.evidence, provenance: { seen: [{ type: 'person', id: 'maria_k' }] } },
    dedupe_key: `gallery_community_membership:${world.workspace_id}:1`,
    title: 'Discord · @maria_k 申请入群',
    summary: '群规匹配通过，不在抑制名单。',
    payload: {
      kind: 'community_membership',
      person: {
        name: 'maria_k',
        profile: '加入 Discord 2 年 · 3 个共同群 · 答题：在 Reddit 看到你们的碗',
      },
    },
  })

  /** ⑨ 转交 / 认领：原话 + 分类依据 */
  await world.txn.approvals.create({
    ...base,
    kind: 'claim',
    subject: { object: { type: 'thread', id: 'thr_gallery' } },
    dedupe_key: `gallery_claim:${world.workspace_id}:1`,
    title: '群里有人问"我的单什么时候到"',
    summary: '看着像客户问题，转给社群管理那条职责。',
    payload: {
      quote: 'Discord #support · @tom：订单 #1088 上周下的，物流一直没动，能查一下吗？',
      reason: '客户问题 · 订单 #1088',
    },
  })

  /** ⑩ 接管：机器停在这儿了，要人上手 */
  await world.txn.approvals.create({
    ...base,
    kind: 'dev_handoff_result',
    subject: { object: { type: 'run', id: 'run_gallery' } },
    dedupe_key: `gallery_takeover:${world.workspace_id}:1`,
    title: 'Facebook 群组 · 登录态失效',
    summary:
      '在受控浏览器里打开时被要求重新登录。我不会替你输密码——请在右栏的浏览器里登录后点"继续"。',
    payload: { url: 'https://facebook.com/groups/glass-bowl' },
  })
}

/** 月初 / 月末（按工作区时区 +8 切），目标的期间用它。 */
function monthWindow(now: Iso8601): { start: Iso8601; end: Iso8601 } {
  const local = new Date(Date.parse(now) + 8 * 3_600_000)
  const start = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - 8 * 3_600_000
  const end = Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 1) - 8 * 3_600_000
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString() }
}

/** 当天本地 hh:00（工作区时区 +8）。 */
function todayAt(now: Iso8601, hour: number): Iso8601 {
  const shift = 8 * 3_600_000
  const day = Math.floor((Date.parse(now) + shift) / DAY_MS) * DAY_MS - shift
  return new Date(day + hour * 3_600_000).toISOString()
}

/**
 * 种一份工作模型（37）。**这里种的是「人的东西」**：目标、待办、事项；
 * 卡片仍然只来自场景真跑出来的审批项（回复草稿 + 退款变更 + 边界问题），
 * 外加一张今天的 `daily_plan`——它是系统卡，payload 就是 `draftDailyPlan` 的产物。
 */
async function seedWorkModel(options: {
  work: Work
  world: World
  pack: Pack
  seed: number
  aftersales_id: string
  analytics_id: string
}): Promise<void> {
  const { work, world, pack } = options
  const owner = world.roleHolder
  const now = world.clock.now()
  const period = monthWindow(now)

  // ① 1 个公司目标 + 2 个岗位目标
  const company = work.createGoal({
    level: 'company',
    title: '本月销售额 12 万',
    owner,
    metric: { query: 'sales.total', format: 'money' },
    target: 120000,
    period: { kind: 'month', ...period },
  })
  work.createGoal({
    level: 'position',
    title: '本月订单 800 单',
    owner,
    parent_id: company.id,
    position_id: options.analytics_id,
    metric: { query: 'orders.count', format: 'count' },
    target: 800,
    period: { kind: 'month', ...period },
  })
  work.createGoal({
    level: 'position',
    title: '本月退款额压到 3000 以内',
    owner,
    parent_id: company.id,
    position_id: options.aftersales_id,
    metric: { query: 'refunds.total', format: 'money' },
    target: 3000,
    period: { kind: 'month', ...period },
  })

  // ② 3 条长期待办：一条已拆两条短期，一条排期到今天
  const launch = work.createTodo({
    title: 'Q4 前上线新品页',
    owner,
    goal_id: company.id,
    position_id: options.analytics_id,
    note: '文案 + 主图 + 上架，卡在文案',
  })
  work.splitTodo(launch.id, [
    { title: '写新品页文案' },
    { title: '做新品页主图', due: new Date(Date.parse(now) + 3 * DAY_MS).toISOString() },
  ])
  work.createTodo({
    title: '把退货政策页重写一遍',
    owner,
    position_id: options.aftersales_id,
    note: '现在的写法和实际口径对不上，Agent 每次都要问',
  })
  work.createTodo({
    title: '核对昨天的退款单',
    owner,
    position_id: options.aftersales_id,
    scheduled: { start: todayAt(now, 10), end: todayAt(now, 11) },
  })

  // ③ 一个 conversation 事项：就是现在那封 Anna 的信
  const customer = pack.customerByEmail('anna@example.com')
  const matter = work.createMatter({
    kind: 'conversation',
    title: 'Anna 要退 #1001',
    position_id: options.aftersales_id,
    participants: [owner],
    summary: '客户 12 天前收货，要求退货退款。窗口内，已按流程起草回复并挂了一笔退款待批。',
    pinned: [
      { type: 'order', id: 'ord_1001' },
      ...(customer === undefined ? [] : [{ type: 'customer', id: customer.id } as ObjectRef]),
    ],
  })
  work.appendEvent(matter.id, {
    kind: 'human_message',
    text: 'Hi, I received the order 12 days ago and would like to return it.',
    actor: { kind: 'person', id: customer?.id ?? 'anna' },
  })
  work.appendEvent(matter.id, {
    kind: 'run',
    text: 'Agent 查了订单与退货政策，起草了回复并挂了一笔退款',
    actor: { kind: 'agent', id: options.aftersales_id },
    run_id: `run_demo_${options.seed}`,
  })
  // 场景真跑出来的卡挂到这个事项上（37 §2.2 交点：卡片是指向事项的指针）
  const items = world.txn.runtime.store.listApprovals({ workspace_id: world.workspace_id })
  const followUp = work.createTodo({
    title: '等 Anna 寄回后确认退款到账',
    owner,
    matter_id: matter.id,
    position_id: options.aftersales_id,
    source: 'card',
    due: new Date(Date.parse(now) + 5 * DAY_MS).toISOString(),
  })
  for (const item of items) {
    if (item.kind === 'policy_change') continue
    work.onCard({
      ...cardRefOf(item),
      matter_id: matter.id,
      todo_id: followUp.id,
    })
  }

  // ④ 今天一张 daily_plan 卡（系统卡；payload 就是计划草案，选择题：采纳 / 调整 / 稍后）
  const plan = work.todayPlan({
    person_id: owner,
    // 计划里的目标进度与 /v1/goals 用同一个执行器，两处数字不会打架
    goals: work.progress(
      periodQueryRunner(
        () => ordersOf(world),
        () => items,
        pack.workspace.base_currency,
      ),
    ),
    cards_waiting: items.filter((i) => i.state === 'pending').length,
    delegate_to: options.aftersales_id,
  })
  const draft: DailyPlanDraft = plan
  const card = await world.txn.approvals.create({
    workspace_id: world.workspace_id,
    schema_version: 1,
    kind: 'daily_plan',
    role_id: world.role_id,
    subject: { object: { type: 'daily_plan', id: plan.id } },
    dedupe_key: `${world.workspace_id}:daily_plan:${plan.date}`,
    title: planTitle(draft),
    summary: planSummary(draft),
    payload: draft,
    evidence: { source_events: [], provenance: { seen: [] }, precheck: {} },
    proposer: { kind: 'system', id: 'work.planner' },
    automation: {
      level_at_creation: 'L1',
      auto_approved: false,
      mandate_check: { within: true, caps_hit: [] },
      sampling: { selected: false },
    },
    routing: {
      recipients: [{ person: owner, via: 'role_holder' }],
      rule: 'role_holder',
      escalation: { after_hours: 24, business_hours: true, chain: ['owner'], escalated_at: [] },
      separation_of_duties: false,
    },
    priority: 'queue',
    options: draft.options.map((o) => ({ id: o.id, label: o.label })),
  })
  work.linkPlanApproval(plan.id, card.id)
}

/**
 * 45（WP50）：让「并进来」与「建之前先查」这两件事在 demo 里看得见。
 *
 * 两步：公司先有一个「品牌B」（店主建的，运营岗位挂着），然后把陈晓个人工作区的包
 * 导进来——「品牌乙」（主店 + 他自己那家）与厨房线。导入**不改任何东西**，只出一张
 * `join_mapping` 卡：公司页「并进来」Tab 上那张三类分组的对照表就是它。
 *
 * 顺带也让查重有东西可查：公司里已经有「品牌B」，新建表单里再打一遍这个名字就会命中。
 */
async function seedJoin(world: World, server: Server): Promise<void> {
  const at = world.clock.now()
  world.roles.rangeGroups.create({
    id: 'rg_brand_b',
    workspace_id: world.workspace_id,
    name: '品牌B',
    members: [
      { kind: 'store', id: 'store_main' },
      { kind: 'store', id: 'store_eu' },
    ],
    created_by: world.owner,
  })
  const solo = 'ws_chen'
  const mine = 'p_chen'
  await server.join.port.import(
    {
      workspace_id: world.workspace_id,
      person_id: world.owner,
      assignment_id: server.bootstrap.ownerAssignment.id,
      role_id: server.bootstrap.ownerAssignment.role_id,
    },
    {
      schema_version: 1,
      workspace_id: solo,
      person_id: mine,
      exported_at: at,
      range_groups: [
        {
          id: 'rg_chen_b',
          workspace_id: solo,
          name: '品牌乙',
          members: [
            { kind: 'store', id: 'store_main' },
            { kind: 'store', id: 'store_chen' },
          ],
          created_at: at,
          updated_at: at,
        },
      ],
      product_lines: [
        {
          id: 'pl_chen_kitchen',
          workspace_id: solo,
          name: '厨房线',
          parent: { kind: 'store', id: 'store_main' },
          rule: { platform: 'shopify', tags: ['kitchen'] },
          created_at: at,
          updated_at: at,
        },
      ],
      store_ranges: [
        {
          range: { kind: 'store', id: 'store_chen' },
          platform: 'shopify',
          external_id: 'store_chen',
          name: 'store_chen',
        },
        {
          range: { kind: 'store', id: 'store_main' },
          platform: 'shopify',
          external_id: 'store_main',
          name: 'store_main',
        },
      ],
      // 45 H2 第三条：凭据不跟着走，开关默认关着
      connections: [
        {
          connection_id: 'conn_chen_shopify',
          service: 'shopify_admin',
          label: 'Shopify · 陈晓自己那家店',
          transfer: false,
        },
      ],
    },
  )
}

/**
 * 48 §4 #6（WP56）：让知识页上真的有知识，并且「源页改了、口径先不动、等人复核」
 * 这条链看得见。
 *
 * **为什么要在这儿单独种一遍**：`MountedWorld` 没有 knowledge 这一格——
 * 服务进程自己 `createKnowledge` 一个库，模拟世界另有一个，两边不通。
 * 在 WP56 之前知识页是个壳，这件事看不出来；现在那一页要显示卡片、复核、缺口，
 * 空库就等于整页空白。所以这里把 pack 的知识按**服务进程这一侧**再登记一遍，
 * 用的是同样的 `store.propose` / `activate` / `intake.addSource`（19 §1.3、§4）。
 *
 * 然后喂一份"官网保修页改过的正文"：24 个月 → 12 个月，顺带换了标题、
 * 加了段营销文案。措辞那部分产生不了指纹项，真正触发复核的是那个月数——
 * 走的是 `recheck.syncSource`，与模拟题 `knowledge/source-changed-recheck` 同一个函数。
 */
async function seedKnowledgeRecheck(server: Server, world: World, pack: Pack): Promise<void> {
  const { knowledge } = server
  const workspace_id = world.workspace_id
  const owner = world.roleHolder
  const at = world.clock.now()

  for (const doc of pack.knowledge) {
    const card = await knowledge.store.propose({
      schema_version: 1,
      workspace_id,
      layer: doc.layer,
      domain: doc.domain as 'company',
      scope: [],
      sensitivity: doc.sensitivity,
      subject: { type: doc.domain, key: doc.subject_key },
      statement: doc.body.trim(),
      provenance: [{ source: 'document', ref: doc.path, at }],
      confidence: { value: 0.9, state: 'probable' },
      valid: {},
      owner,
      created_by: { kind: 'person', id: owner },
    })
    await knowledge.store.activate(card.id, owner)
    const src = knowledge.intake.addSource({
      workspace_id,
      kind: 'upload',
      ref: doc.path,
      parser: 'anydoc',
    })
    knowledge.intake.markSynced(src.id, 1, contentHashOf(doc.body))
  }

  const source = knowledge.intake
    .sources(workspace_id)
    .find((s) => s.ref === 'knowledge/fact-warranty.md')
  if (source === undefined) return
  const content = [
    '# 保修期（2026 秋季更新）',
    '',
    '好消息：我们把保修流程简化了，理赔更快！',
    '',
    '充电类产品的保修期是 **12 个月**，从签收日算起。',
    '',
  ].join('\n')
  await knowledge.recheck.syncSource({ source, content })
  knowledge.intake.markSynced(source.id, source.chunks, contentHashOf(content))
}

export async function createDemo(options: DemoOptions): Promise<Demo> {
  const root = options.root
  const pack = loadPack(fromRoot(root, DEMO_PACK))
  const scenario = parseScenario(
    readFileSync(join(fromRoot(root, DEMO_PACK), DEMO_SCENARIO), 'utf8'),
    DEMO_SCENARIO,
  )
  const seed = scenario.dataset.seed

  const world = await createWorld({
    pack,
    seed,
    start: scenario.clock.start,
    runtime: 'stub',
  })

  // 独立站运营岗位：补一份只读的分析职责，并把它分给同一个人（36 §3 每岗位一条数据条）
  world.roles.roles.register(parseRole(ANALYTICS_ROLE, 'demo:dtc.analytics'))
  const analytics = world.roles.assignments.create({
    person_id: world.roleHolder,
    workspace_id: world.workspace_id,
    role_id: 'dtc.analytics',
    granted_by: world.owner,
    ranges: [{ kind: 'store', id: 'store_main' }],
  })

  // WP64（51 §2.4）：订单履约也分给同一个人，好让 demo 的侧栏里有那条分块。
  // 3 人 pack 里它挂在李默身上（`assignments.yml`），而 demo 只以王岚的身份登录——
  // 不补这一条，"待发货 / 超期未发 / 物流异常 / 今日发货数"这四块在 demo 里根本看不见。
  world.roles.assignments.create({
    person_id: world.roleHolder,
    workspace_id: world.workspace_id,
    role_id: 'dtc.fulfillment',
    granted_by: world.owner,
    ranges: [{ kind: 'store', id: 'store_main' }],
  })
  // WP63（51 §2）：**网站运营**岗位也要在 demo 里看得见。
  //
  // 合成 pack 里挂店铺管理的是运营李默，而 demo 登录的是店主——于是给店主也挂一条
  // （3 人公司里店主本来就什么都管一点）。不挂的话，51 §2.1 那一整页面板在 demo 里
  // 一眼都看不到，截图与人工验收都无从谈起。
  // WP67（48 §5.1）：红人营销岗位也给店主挂一条——理由与上面那两条逐字相同。
  // 3 人 pack 的 `assignments.yml` 里 `kol.youtube` 挂在运营李默身上，
  // 而 demo 只以王岚的身份登录；不挂这一条，找人 / 建联 / 合作 / 审核 / 归因
  // 这五块在 demo 里一眼都看不到。
  // WP72（56 §2）：**社媒运营**岗位同理，挂两条——一条内容账号组（`social.meta`）、
  // 一条社群组（`social.discord`）。两组的面板骨架不一样（内容日历 / 待发布 /
  // 近 30 天表现 / 待回评论 vs 待审入群 / 待处理 / 群发队列 / 活跃度），
  // 只挂一条就只看得见一半，56 §2 那张表在 demo 里就演示不完整。
  // 社媒库那几行由 `seedDemoSocial` 放（`apps/server/src/social.ts`）。
  // WP78（60 §1）：**公共关系**岗位也挂两条——`pr.monitoring`（提及流 / 负面预警 /
  // 转客服）与 `pr.reddit`（外部露出 + 版规检查）。挑这两条是因为它们各自演示了
  // 60 里最要紧的两句话：**客户的问题转客服，公关不答**，以及**在别人的地盘上
  // 版主说了算**。公关库那几行由 `seedDemoPr` 放（`apps/server/src/pr.ts`）。
  for (const role of [
    'dtc.store',
    'dtc.content',
    'kol.youtube',
    'social.meta',
    'social.discord',
    'pr.monitoring',
    'pr.reddit',
    // WP75（57 §3）：投放挂一条 `ads.meta`，四条平台职责的面板骨架相同
    'ads.meta',
    // WP77（59 §3）：建站岗位四条（模板默认全勾；只挂一条时另三块面板看不见）
    'site.shopify-build',
    'site.shopify-theme',
    'site.shopify-email',
    'site.shopify-apps',
    // WP76（58 §3）：设计岗位挂一条 `design.dtc`（五条骨架相同，只挂一条就够）
    'design.dtc',
  ]) {
    world.roles.assignments.create({
      person_id: world.roleHolder,
      workspace_id: world.workspace_id,
      role_id: role,
      granted_by: world.owner,
      ranges: [{ kind: 'store', id: 'store_main' }],
    })
  }

  const body = pack.fixtures.get('fixtures/anna-return.txt')
  if (body === undefined) throw new Error('pack 里没有 fixtures/anna-return.txt')
  await runInbound(world, pack, seed, body)
  await seedPolicyQuestion(world)
  await seedStoreWork(world, pack)

  const owner = pack.people.find((p) => p.id === world.roleHolder) ?? pack.people[0]
  if (owner === undefined) throw new Error('pack 里没有人')

  const mount: MountedWorld = {
    workspace_id: world.workspace_id,
    workspace_name: pack.workspace.name,
    owner: { id: owner.id, email: owner.email, name: owner.name },
    roles: world.roles,
    approvals: world.txn.approvals,
    data: dataSourceOf(world, pack),
    // 21 §1：世界的事件日志与服务进程的合一，首页四格战报才有真数
    eventLog: world.kernel.eventLog,
  }

  const staticDir = options.staticDir ?? resolve(root, 'apps/workstation/dist')
  /**
   * WP66（52 O1）：第二个品牌那一份合成数据。
   *
   * 服务进程装配的时候这个品牌还不存在（它是启动之后建出来的），所以这里传的是
   * 一张**会被填上的表**——装配层每次按 `workspace_id` 现查，查得到就用它，
   * 查不到就走活数据源。生产路径一个字节不变（生产从不传 `brandData`）。
   */
  const extraBrandData = new Map<string, WorkstationDataSource>()
  const server = await createServer({
    clock: world.clock,
    random: world.random,
    mount,
    staticDir,
    brandData: (ws) => extraBrandData.get(ws),
    // 37：委托与事项发言在 demo 里真跑（stub 运行时；事件日志里不会有任何 model.*）
    records: recordSourceOf(world, pack),
    ...(options.quiet === undefined ? {} : { quiet: options.quiet }),
    env: {
      ...process.env,
      // demo 一律 stub 运行时：即使机器上配了 DEEPSEEK_API_KEY 也不叫模型
      DEEPSEEK_API_KEY: '',
      AGENTSWS_PORT: String(options.port ?? 4317),
    },
  })

  /**
   * WP28 交付 D：合成公司的**三个人都真的是成员**。
   *
   * 在这之前 demo 里只有 owner 一个身份，职责库里却有三个人的分配——「公司」页上
   * 就会出现"岗位有人做，但成员只有一个"这种自相矛盾。这里把另外两位也建成 Person
   * 并加进工作区；他们的分配本来就在 pack 的 assignments.yml 里，不用再造一遍。
   */
  for (const person of pack.people) {
    if (person.id === owner.id) continue
    const created = await server.identity.createPerson({
      id: person.id,
      email: person.email,
      name: person.name,
    })
    const ranges = new Map<string, RangeRef>()
    for (const assignment of world.roles.assignments.listByPerson(created.id, {
      workspace_id: world.workspace_id,
    }))
      for (const range of assignment.ranges) ranges.set(`${range.kind}:${range.id}`, range)
    await server.identity.addMember({
      workspace_id: world.workspace_id,
      person_id: created.id,
      role: 'member',
      ranges: [...ranges.values()],
    })
  }

  /**
   * 15 §5「通过 ≠ 施行」：批准只是写下批准，施行由执行器发起，而且有 2 分钟取消窗口。
   * demo 里时间是合成的，所以每次 drain 先把合成时钟往前推 3 分钟——只在真的有东西要施行时推，
   * 不会把「昨天」推成「今天」。
   */
  const drain = async (): Promise<void> => {
    const waiting = world.txn.runtime.store
      .listApprovals({ workspace_id: world.workspace_id })
      .filter((i) => ['approved', 'approved_edited', 'auto_approved'].includes(i.state))
    if (waiting.length === 0) return
    world.clock.advance(3 * 60 * 1000)
    const order = (i: ApprovalItem): number => (i.kind === 'staged_change' ? 0 : 1)
    for (const item of [...waiting].sort((a, b) => order(a) - order(b))) {
      try {
        await world.txn.executor.applyApproval(item.id)
      } catch {
        // 取消窗口 / 父子顺序没到：下一拍再来
      }
    }
  }

  // 45（WP50）：公司页「并进来」Tab 与新建品牌时的查重提示都要有东西可看
  await seedJoin(world, server)

  // 48 §4 #6（WP56）：知识页的复核卡要有东西可看
  await seedKnowledgeRecheck(server, world, pack)

  await seedWorkModel({
    work: server.work,
    world,
    pack,
    seed,
    aftersales_id: world.assignment.id,
    analytics_id: analytics.id,
  })

  // WP96：十一种排版各一张（默认不造，见 `DemoOptions.cardGallery`）
  if (options.cardGallery === true) await seedCardGallery(world)
  // WP66（52 O1）：第二个品牌（默认不造，见 `DemoOptions.twoBrands`）
  if (options.twoBrands === true)
    await seedSecondBrand({ server, world, pack, data: extraBrandData })

  return {
    server,
    world,
    pack,
    drain,
    async close() {
      await server.close()
      await world.close()
    },
  }
}

/** 第二个品牌的名字（截图与文档里都用它，别改来改去）。 */
export const DEMO_SECOND_BRAND = '诺伏特课程'

/**
 * WP66（52 O1）：造第二个品牌，并给它自己的数据与自己的队列。
 *
 * 这一段**只证明一件事**：两个品牌各是各的。所以它刻意不复用第一个品牌的任何
 * 东西——另一个数据源、另一批订单、另一张卡。品牌一览上那三个数因此是两行
 * 各自算出来的，不是同一份数据显示两遍。
 */
async function seedSecondBrand(input: {
  server: Server
  world: World
  pack: Pack
  data: Map<string, WorkstationDataSource>
}): Promise<void> {
  const { server, world, pack } = input
  const owner = server.bootstrap.person.id
  const orgs = server.identity.organizationsOf(owner)
  const org = orgs[0]
  if (org === undefined) return
  const actor = {
    person_id: owner,
    workspace_id: server.bootstrap.workspace.id,
    assignment_id: server.bootstrap.ownerAssignment.id,
    role_id: server.bootstrap.ownerAssignment.role_id,
  }
  const brand = await server.organizations.port.createBrand(actor, org.id, {
    name: DEMO_SECOND_BRAND,
    vertical: 'digital',
    storefront_platform: 'other',
  })

  /*
   * 这个品牌自己的订单：三张，都落在合成时钟的"今天"——品牌一览那一格才有数。
   * 币种与第一个品牌一样（同一家公司），但金额与单号完全是另一批。
   */
  const today = world.clock.now().slice(0, 10)
  const orders: OrderRow[] = [
    {
      id: 'ord_c_1',
      name: '#C1001',
      email: 'mika@example.com',
      currency: 'USD',
      total_price: 129,
      refunded_amount: 0,
      created_at: `${today}T02:10:00.000Z`,
      financial_status: 'paid',
      fulfillment_status: 'fulfilled',
    },
    {
      id: 'ord_c_2',
      name: '#C1002',
      email: 'jonas@example.com',
      currency: 'USD',
      total_price: 249,
      refunded_amount: 0,
      created_at: `${today}T05:40:00.000Z`,
      financial_status: 'paid',
      fulfillment_status: 'unfulfilled',
    },
    {
      id: 'ord_c_3',
      name: '#C1003',
      email: 'lena@example.com',
      currency: 'USD',
      total_price: 89,
      refunded_amount: 0,
      created_at: `${today}T07:55:00.000Z`,
      financial_status: 'paid',
      fulfillment_status: 'unfulfilled',
    },
  ]
  input.data.set(brand.workspace_id, {
    orders: () => orders,
    inventory: () => [],
    reviews: () => [],
    posts: () => [],
    sources: () => [
      { id: 'shop', label: '店铺后台', connected: true },
      { id: 'approvals', label: '工作队列', connected: true },
    ],
    label: (ref: ObjectRef) => orders.find((o) => o.id === ref.id)?.name,
    tz_offset_minutes: 480,
    base_currency: pack.workspace.base_currency,
  })
  /*
   * 建品牌那一步已经把这个品牌的模块建出来了（品牌一览要算它那三个数），
   * 而那会儿上面这份数据还没放进表里——丢掉重建一次，下一次请求才读得到它。
   */
  await server.brands.release(brand.workspace_id)

  // 自己的队列：一张等人定的回信草稿（品牌一览的"待审卡"那一格）
  const position = server.roles.assignments
    .listByPerson(owner, { workspace_id: brand.workspace_id })
    .find((a) => a.revoked_at === undefined)
  if (position === undefined) return
  // demo 里工作台读的是**世界**那条审批总线（`mount.approvals`），不是服务进程自己那条
  await world.txn.approvals.create({
    workspace_id: brand.workspace_id,
    schema_version: 1,
    kind: 'outbound_draft',
    role_id: position.role_id,
    subject: { object: { type: 'thread', id: 'thr_course_1' } },
    dedupe_key: `${brand.workspace_id}:outbound_draft:thr_course_1`,
    title: '课程学员问能不能换一门课',
    summary: '开课前 7 天内换课要按政策走一次人工确认。',
    payload: {
      channel: 'email',
      to: { type: 'customer', id: 'cus_course_1' },
      body: { subject: 'Course swap', text: 'Happy to look into swapping your course.' },
    },
    evidence: {
      source_events: [],
      // 写类卡必查来源：草稿里提到的线程与收件人，这次运行都真读过（15 §3.1）
      provenance: {
        seen: [
          { type: 'thread', id: 'thr_course_1' },
          { type: 'customer', id: 'cus_course_1' },
        ],
      },
      precheck: {},
    },
    proposer: { kind: 'agent', id: 'agent', assignment_id: position.id },
    automation: { level_at_creation: 'L1' },
    routing: {
      recipients: [{ person: owner, via: 'role_holder' }],
      rule: 'role_holder',
      escalation: { after_hours: 8, business_hours: true, chain: ['owner'], escalated_at: [] },
      separation_of_duties: false,
    },
    priority: 'queue',
    // 31 §3.3 收件人门禁：只许回给线程里本来就在的人
    context: { thread_participants: ['cus_course_1'], verified_contacts: ['cus_course_1'] },
  })
}
