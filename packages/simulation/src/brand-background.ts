/**
 * WP215（52 §4 收口）：**每个品牌一套后台，共用一个调度循环**——模拟回路里的最小版。
 *
 * 服务端那一份在 `apps/server`；这里不依赖它（包不该依赖应用，见 `routine.ts` 开头），
 * 用的是同一套零件：`@agentsws/schedule` 的 `createScheduler` + `createBrandRouter`
 * + `brandBackgroundStatus`。所以"到点之后用谁的东西去做"在两边是同一条规矩：
 * **按任务自己的 `workspace_id` 找那个品牌登记的处理器**，找不到就失败，绝不借别人的。
 *
 * 装不装是场景说了算（`org.brand_background` 事件）：不装的世界没有这个调度器，
 * runner 每一拍也不碰它，原有场景的指标一个不变。
 *
 * 一条巡检做的事（照 INMO Reddit 代运营的样子）：在**这个品牌自己的**审批队列里
 * 出一张"待回的帖子"草稿卡（信封照 `world.org.brand` 的那张种子卡），并记一条
 * 带这个品牌 `workspace_id` 的 `simulation.brand_patrol`。眼前切在哪个品牌，
 * 只记进事件里（断言要看"视图停在 A 时 B 照跑"），处理器一个字节都不读它来决定写哪儿。
 */
import type { ApprovalItem, Iso8601, PersonId, WorkspaceId } from '@agentsws/contracts'
import {
  type BrandBackgroundStatus,
  type BrandRouter,
  brandBackgroundStatus,
  createBrandRouter,
  createScheduler,
  MemoryScheduleStore,
  type Scheduler,
  type ScheduleTask,
} from '@agentsws/schedule'
import { SimulationError } from './errors.js'
import type { World } from './world.js'

/** 巡检处理器的名字（每个品牌登记同一个名字，路由按任务的品牌分发）。 */
export const BRAND_PATROL_HANDLER = 'brand.patrol'
/** 巡检卡的去重键里夹着这一段：`<品牌>:brand_patrol:<任务>:<第几次>`。 */
const PATROL_MARK = ':brand_patrol:'
/** 全进程同时跑几个品牌（WP215 ④ 写进设置的那一格；模拟里定死 2，好让两个品牌真并行）。 */
const CONCURRENCY = 2

export interface BrandBackgroundInput {
  brand: WorkspaceId
  who: PersonId
  /** 巡检间隔（毫秒）。 */
  every_ms: number
  /** 装上时就停着（品牌急停按着）。 */
  halted?: boolean
}

/** `org.brand_background_check` 报告的东西：数，不是内容。 */
export interface BrandBackgroundReport {
  brand: WorkspaceId
  who: PersonId
  state: BrandBackgroundStatus['state']
  /** 在跑的定时任务条数（切换器上那个数字）。 */
  scheduled: number
  errors: number
  last_run_at?: Iso8601
  /** 调度器上这个品牌的巡检一共触发了几次（看调度器，不看处理器写了什么）。 */
  patrols: number
  /** 这个品牌队列里、**这个品牌自己的**巡检卡几张。 */
  own_cards: number
  /** 这个品牌队列里、**别的品牌的**巡检卡（按品牌分）——应当永远是空的。 */
  foreign_cards: Record<string, number>
}

export interface BrandBackground {
  scheduler: Scheduler
  router: BrandRouter
  /** 给一个品牌装一条巡检定时任务（处理器登记在这个品牌自己的登记口上）。 */
  add(input: BrandBackgroundInput): Promise<ScheduleTask>
  /** 品牌急停：按下 / 放开。只停这一个品牌。 */
  halt(brand: WorkspaceId, on: boolean): void
  halted(brand: WorkspaceId): boolean
  check(brand: WorkspaceId, who: PersonId): Promise<BrandBackgroundReport>
}

/** 这个人在这个品牌里的那条岗位（巡检卡交给他）。 */
function assignmentIn(world: World, who: PersonId, brand: WorkspaceId) {
  const asg = world.roles.assignments
    .listByPerson(who, { workspace_id: brand })
    .find((a) => a.revoked_at === undefined)
  if (asg === undefined) {
    throw new SimulationError('invalid_input', `${who} 在品牌 ${brand} 里没有岗位，巡检卡没人收`, {
      who,
      brand,
    })
  }
  return asg
}

export function installBrandBackground(world: World): BrandBackground {
  const halted = new Set<WorkspaceId>()
  const scheduler = createScheduler({
    clock: world.clock,
    store: new MemoryScheduleStore(),
    random: world.random,
    // 品牌急停：停着的品牌到点不触发、不挪排期；放开后按 misfire 规矩补一次
    hold: (task) => halted.has(task.workspace_id),
    concurrency: CONCURRENCY,
    // 调度器自己的事件（触发 / 失败 / 错过）照写**任务自己的**工作区
    eventSink: (e) => {
      world.appendEvent(e.type, e.payload, {
        workspace_id: e.workspace_id,
        ...(e.subject === undefined ? {} : { subject: e.subject }),
      })
    },
  })
  const router = createBrandRouter(scheduler)

  const register = (brand: WorkspaceId, who: PersonId): void => {
    if (router.handlersOf(brand).includes(BRAND_PATROL_HANDLER)) return
    const asg = assignmentIn(world, who, brand)
    // 闭包里只有**这个品牌**的东西：工作区、岗位、收卡的人
    router.for(brand).register(BRAND_PATROL_HANDLER, async (ctx) => {
      const n = ctx.fire_count
      const thread = `thr_${brand}_patrol_${n}`
      const customer = `cus_${brand}`
      const card = (await world.txn.approvals.create({
        workspace_id: brand,
        schema_version: 1,
        kind: 'outbound_draft',
        role_id: asg.role_id,
        subject: { object: { type: 'thread', id: thread } },
        dedupe_key: `${brand}${PATROL_MARK}${ctx.task.id}:${n}`,
        title: `巡检发现一条待回的帖子（第 ${n} 轮）`,
        summary: '后台巡检拟好的回复，等你看一眼再发',
        payload: {
          channel: 'email',
          to: { type: 'customer', id: customer },
          body: { subject: '回复', text: '巡检拟好的回复草稿' },
        },
        evidence: {
          source_events: [],
          provenance: {
            seen: [
              { type: 'thread', id: thread },
              { type: 'customer', id: customer },
            ],
          },
          precheck: { permission_diff: 'ok', semantic_diff: 'ok' },
        },
        proposer: { kind: 'system', id: 'brand.patrol' },
        automation: {
          level_at_creation: 'L1',
          auto_approved: false,
          mandate_check: { within: true, caps_hit: [] },
          sampling: { selected: false },
        },
        routing: {
          recipients: [{ person: who, via: 'role_holder' }],
          rule: 'role_holder',
          escalation: {
            after_hours: 72,
            business_hours: true,
            chain: ['owner'],
            escalated_at: [],
          },
          separation_of_duties: false,
        },
        priority: 'queue',
        context: { thread_participants: [customer], verified_contacts: [customer] },
      })) as ApprovalItem
      world.appendEvent(
        'simulation.brand_patrol',
        {
          brand,
          // 只是记一下"跑的时候眼前切在哪"——断言用，处理器不拿它决定任何事
          viewing: world.viewingBrand ?? null,
          fire: n,
          card: card.id,
        },
        { workspace_id: brand, subject: { type: 'scheduled_task', id: ctx.task.id } },
      )
      return { card: card.id }
    })
  }

  return {
    scheduler,
    router,
    async add({ brand, who, every_ms, halted: on }) {
      register(brand, who)
      if (on === true) halted.add(brand)
      const asg = assignmentIn(world, who, brand)
      return scheduler.schedule({
        workspace_id: brand,
        owner: who,
        role_id: asg.role_id,
        assignment_id: asg.id,
        created_by: 'user',
        misfire_policy: 'run_once_now',
        title: '后台巡检',
        handler: BRAND_PATROL_HANDLER,
        trigger: { kind: 'interval', every_ms },
      })
    },
    halt(brand, on) {
      if (on) halted.add(brand)
      else halted.delete(brand)
      world.appendEvent('simulation.brand_halted', { brand, on }, { workspace_id: brand })
    },
    halted: (brand) => halted.has(brand),
    async check(brand, who) {
      const tasks = scheduler.list({ workspace_id: brand })
      const status = brandBackgroundStatus(tasks, {
        workspace_id: brand,
        halted: halted.has(brand),
        stopped: false,
      })
      const patrols = tasks
        .filter((t) => t.handler === BRAND_PATROL_HANDLER)
        .reduce((sum, t) => sum + t.fire_count, 0)
      const queue = await world.txn.approvals.queue({
        workspace_id: brand,
        person_id: who,
        lane: 'scope',
        state: ['pending', 'in_review'],
      })
      let own_cards = 0
      const foreign_cards: Record<string, number> = {}
      for (const item of queue) {
        const at = item.dedupe_key.indexOf(PATROL_MARK)
        if (at < 0) continue
        const from = item.dedupe_key.slice(0, at)
        if (from === brand) own_cards += 1
        else foreign_cards[from] = (foreign_cards[from] ?? 0) + 1
      }
      return {
        brand,
        who,
        state: status.state,
        scheduled: status.scheduled,
        errors: status.errors,
        ...(status.last_run_at === undefined ? {} : { last_run_at: status.last_run_at }),
        patrols,
        own_cards,
        foreign_cards,
      }
    },
  }
}
