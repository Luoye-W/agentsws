/**
 * `agentsws demo`（36 §5.7）：用合成世界当后端，把工作台跑起来。
 *
 * 做的事就三件：
 * 1. 用 `packs/dtc-3c-3p` 建一个合成世界（`createWorld`，runtime `stub`），
 * 2. 把「退货窗口内」场景**跑到产生审批项为止**——回复草稿卡与退款变更卡是真跑出来的，不是写死的，
 * 3. 把这个世界接进服务进程（同一进程），在 127.0.0.1:4317 上托管工作台。
 *
 * 纪律：全程 **stub 模型**（`runtime: 'stub'` 根本不叫模型），所以事件日志里不该有任何 `model.*`；
 * 时间走合成时钟，随机走 seed，没有一处 `Date.now()` / `Math.random()`。
 */
import { readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type { ApprovalItem, InboundEvent, ObjectRef, RunEvent } from '@agentsws/contracts'
import type { DataSourceStatus, DeckCard, OrderRow } from '@agentsws/deck'
import { parseRole } from '@agentsws/roles'
import type { MountedWorld, Server, WorkstationDataSource } from '@agentsws/server'
import { createServer } from '@agentsws/server'
import type { Pack, RunContext, World } from '@agentsws/simulation'
import { buildRunRequest, createWorld, loadPack, parseScenario } from '@agentsws/simulation'

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
  world.roles.assignments.create({
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
  }

  const staticDir = options.staticDir ?? resolve(root, 'apps/workstation/dist')
  const server = await createServer({
    clock: world.clock,
    random: world.random,
    mount,
    staticDir,
    ...(options.quiet === undefined ? {} : { quiet: options.quiet }),
    env: { ...process.env, AGENTSWS_PORT: String(options.port ?? 4317) },
  })

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
