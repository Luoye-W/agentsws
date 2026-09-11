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
import type { DataSourceStatus, DeckCard, OrderRow } from '@agentsws/deck'
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

function dataSourceOf(world: World, pack: Pack): WorkstationDataSource {
  const sources: DataSourceStatus[] = [
    // 店铺后台 = mock OpenConnector，接上了；其余三个 demo 里都没连
    { id: 'shop', label: '店铺后台', connected: true },
    { id: 'approvals', label: '工作队列', connected: true },
    { id: 'ga4', label: 'GA4', connected: false },
    { id: 'gsc', label: 'Search Console', connected: false },
    { id: 'ads', label: '广告后台', connected: false },
    { id: 'csat', label: '满意度调查', connected: false },
  ]
  const alerts: DeckCard[] = []
  return {
    orders: () => ordersOf(world),
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

  const body = pack.fixtures.get('fixtures/anna-return.txt')
  if (body === undefined) throw new Error('pack 里没有 fixtures/anna-return.txt')
  await runInbound(world, pack, seed, body)
  await seedPolicyQuestion(world)

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
  const server = await createServer({
    clock: world.clock,
    random: world.random,
    mount,
    staticDir,
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

  await seedWorkModel({
    work: server.work,
    world,
    pack,
    seed,
    aftersales_id: world.assignment.id,
    analytics_id: analytics.id,
  })

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
