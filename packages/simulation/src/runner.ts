/**
 * 场景执行器（26 §1 §4）。
 *
 * 一条场景 = 一段公司生活：来信 → 草稿 + 待批的退款 → 人批准 → 施行 → 回信发出 → 客户回信。
 * 事件按**虚拟时间**执行；每推进一步都跑一次"合成人决定 + 执行器出队"，
 * 因为 14 §4.1 的取消窗口与 15 §5 的父子顺序都只有在时间真的流动时才成立。
 */
import type {
  ApprovalItem,
  DecisionAction,
  InboundEvent,
  Iso8601,
  ObjectRef,
  RunEvent,
  RunResult,
} from '@agentsws/contracts'
import type { ActorPolicy } from '@agentsws/stand-ins'
import { buildRunRequest } from './context.js'
import { SimulationError } from './errors.js'
import type { BlockedRecord, Evidence, RunRecord } from './evidence.js'
import { checkExpectations } from './expectations.js'
import { checkInvariants } from './invariants.js'
import { computeMetrics } from './metrics.js'
import type { Pack } from './pack.js'
import { loadPack } from './pack.js'
import type { ScenarioReport } from './report.js'
import { buildReport } from './report.js'
import type { RuntimeName } from './runtime-name.js'
import { parseDuration, parseRange, resolveAt } from './scenario/duration.js'
import type { Scenario, ScenarioEvent, Tier } from './scenario/types.js'
import type { RunContext, World } from './world.js'
import { createWorld } from './world.js'

/** 每推进一步的粒度：五分钟。取消窗口（120s）与升级（小时级）都能被看见。 */
const TICK_MS = 5 * 60 * 1000
/** 事件跑完后再让世界自己转一会儿，把批准后的施行与投递跑完。 */
const SETTLE_MS = 60 * 60 * 1000

export interface RunScenarioOptions {
  tier?: Tier
  /** 覆盖场景里的 seed（26 §6.1 同 seed 两次运行事件序列相同）。 */
  seed?: number
  /** pack 目录；不给就按 `dataset.pack` 在 `packsDir` 下找。 */
  packDir?: string
  packsDir?: string
  /** 已加载的 pack（批量跑时复用解析结果，但每条场景仍各起一个世界）。 */
  pack?: Pack
  /** 事件日志路径，缺省内存。 */
  dbPath?: string
  /** 用哪个运行时跑（17 §4）；缺省 `stub`。`dsh` 走 `@agentsws/dsh-adapter`；`direct` = direct-llm 的 turn loop。 */
  runtime?: RuntimeName
  /** 拿到原始证据（一致性用例要比对事件序列；报告里不塞这么大一坨）。 */
  captureEvidence?: (evidence: Evidence) => void
}

const POLICY_RE = /^edit_(\d{1,3})pct$/

function actorPolicy(policy: string, rejectRules: string[] | undefined): ActorPolicy {
  if (policy === 'always_approve') return { kind: 'always_approve' }
  if (policy === 'reject' || policy === 'reject_rules') {
    return { kind: 'reject_rules', patterns: rejectRules ?? [] }
  }
  const m = POLICY_RE.exec(policy)
  if (m?.[1] !== undefined) return { kind: 'edit_pct', pct: Number.parseInt(m[1], 10) }
  throw new SimulationError('invalid_input', `未知的合成人策略：${policy}`, { policy })
}

interface ThreadState {
  id: string
  ref: ObjectRef
  subject: string
  participants: string[]
  lastSummary?: string
  appEvents: string[]
  runs: number
}

/** 跑一条场景，产出报告。 */
export async function runScenario(
  scenario: Scenario,
  options: RunScenarioOptions = {},
): Promise<ScenarioReport> {
  const tier: Tier = options.tier ?? 'fast'
  if (tier !== 'fast') {
    throw new SimulationError('invalid_input', `v1 只实现了 fast 档（收到 ${tier}）`)
  }
  const seed = options.seed ?? scenario.dataset.seed
  const pack =
    options.pack ??
    loadPack(options.packDir ?? `${options.packsDir ?? 'packs'}/${scenario.dataset.pack}`)

  const world = await createWorld({
    pack,
    seed,
    start: scenario.clock.start,
    ...(options.dbPath === undefined ? {} : { dbPath: options.dbPath }),
    ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
  })

  try {
    return await execute(
      scenario,
      world,
      pack,
      seed,
      tier,
      options.runtime ?? 'stub',
      options.captureEvidence,
    )
  } finally {
    await world.close()
  }
}

async function execute(
  scenario: Scenario,
  world: World,
  pack: Pack,
  seed: number,
  tier: Tier,
  runtime: RuntimeName,
  captureEvidence?: (evidence: Evidence) => void,
): Promise<ScenarioReport> {
  const { clock, standIns, txn } = world

  // 合成人（26 §3）：策略 + 延迟分布 + 驳回规则，随机全部经 seed
  for (const [person_id, spec] of Object.entries(scenario.actors)) {
    standIns.actors.add({
      person_id,
      workspace_id: world.workspace_id,
      policy: actorPolicy(spec.policy, spec.reject_rules),
      ...(spec.reject_rules === undefined ? {} : { reject_rules: spec.reject_rules }),
      ...(spec.latency === undefined ? {} : { latency: parseRange(spec.latency) }),
      ...(spec.lane === undefined ? {} : { lane: spec.lane }),
    })
  }

  const runs: RunRecord[] = []
  const inboundEvents: InboundEvent[] = []
  const threads = new Map<string, ThreadState>()
  const byIdempotency = new Map<string, RunResult>()
  const retryQueue: { inbound: InboundEvent; thread: ThreadState }[] = []
  let runSeq = 0
  let lastThread: ThreadState | undefined

  const applyErrors: BlockedRecord[] = []

  /** 施行队列：子项（staged_change）先于父项（回信）；取消窗口没过就等下一拍。 */
  const drainApprovals = async (): Promise<void> => {
    const items = txn.runtime.store
      .listApprovals({ workspace_id: world.workspace_id })
      .filter((i) => ['approved', 'approved_edited', 'auto_approved'].includes(i.state))
    const order = (i: ApprovalItem): number => (i.kind === 'staged_change' ? 0 : 1)
    for (const item of [...items].sort((a, b) => order(a) - order(b))) {
      try {
        await txn.executor.applyApproval(item.id)
      } catch (err) {
        const e = err as { code?: string; message?: string }
        // 取消窗口 / 父子顺序未满足：不是错误，下一拍再来
        if (e.code === 'conflict') continue
        applyErrors.push({
          rule: e.code ?? 'apply_failed',
          at: clock.now(),
          message: e.message ?? String(err),
        })
      }
    }
  }

  const tick = async (): Promise<void> => {
    await standIns.actors.tick()
    // 25 §4：合成时钟每推进一步驱动一次调度器与流程引擎（真实进程里是 setInterval）
    const routine = world.routine
    if (routine !== undefined) {
      await routine.scheduler.runDue(clock.now())
      await routine.workflows.tick(clock.now())
    }
    await drainApprovals()
    await txn.approvals.expire(clock.now())
    // 模型恢复后把冻结期间的工作项重跑（17 §5.7 同 idempotency_key 不重复出结果）
    while (retryQueue.length > 0 && !world.modelDown()) {
      const next = retryQueue.shift()
      if (next === undefined) break
      await runInbound(next.inbound, next.thread)
    }
  }

  const advanceTo = async (target: Iso8601): Promise<void> => {
    if (Date.parse(target) < clock.nowMs()) {
      throw new SimulationError('invalid_input', `事件时间倒流：${clock.now()} → ${target}`)
    }
    await clock.runUntil(target, TICK_MS, async () => {
      await tick()
    })
    await tick()
  }

  const runInbound = async (inbound: InboundEvent, thread: ThreadState): Promise<void> => {
    const prior = byIdempotency.get(`idem_${inbound.dedupe_key}`)
    if (prior !== undefined) return // 17 §5.7 幂等：同一 trigger 重复投递不重复跑

    runSeq += 1
    const run_id = `run_${String(runSeq).padStart(4, '0')}_${seed}`
    const requesterCustomer =
      inbound.actor?.external_id === undefined
        ? undefined
        : pack.customerByEmail(inbound.actor.external_id)
    const orderId = inbound.parts
      .map((p) => (p.type === 'text' ? p.text : ''))
      .join('\n')
      .match(/#(\d{3,})/)?.[1]
    const order =
      orderId === undefined ? undefined : pack.orders.find((o) => o.id === `ord_${orderId}`)
    const ownerCustomer = order === undefined ? undefined : pack.customerByEmail(order.email)

    const ctx: RunContext = {
      run_id,
      inbound,
      thread: {
        id: thread.id,
        ref: thread.ref,
        subject: thread.subject,
        participants: thread.participants,
      },
      change_set_id: `cs_${run_id}`,
      child_approval_ids: [],
      events: [],
      ...(requesterCustomer === undefined
        ? {}
        : {
            requester: {
              customer: requesterCustomer,
              ref: { type: 'customer', id: requesterCustomer.id },
            },
          }),
      ...(order === undefined
        ? {}
        : {
            order: {
              id: order.id,
              ref: { type: 'order', id: order.id },
              ...(ownerCustomer === undefined
                ? {}
                : { owner: { type: 'customer', id: ownerCustomer.id } as ObjectRef }),
            },
          }),
    }
    world.runContexts.set(run_id, ctx)

    const request = await buildRunRequest({
      world,
      ctx,
      inbound,
      seed,
      ...(thread.lastSummary === undefined ? {} : { previousSummary: thread.lastSummary }),
      ...(thread.appEvents.length === 0 ? {} : { appEvents: [...thread.appEvents] }),
    })
    ctx.request = request
    const started_at = clock.now()

    // 事件日志里留一份 RunRequest：`agentsws replay` 与 prompt_replayable 都从这里回放
    world.appendEvent(
      'simulation.run_request',
      { request },
      {
        run_id,
        ...(request.work_item === undefined ? {} : { work_item_id: request.work_item.id }),
      },
    )

    const sink = (e: RunEvent): void => {
      ctx.events.push(e)
      world.appendRunEvent(request, e)
    }

    // 模型预检：模型挂了 / 预算冻结 → 整条运行冻结，不起草不写外部（09 §5.7）
    try {
      const { assemblePrompt } = await import('@agentsws/stand-ins')
      const prompt = assemblePrompt(request)
      await world.gateway().complete({
        messages: prompt.messages,
        tools: prompt.tools,
        seed,
        max_cost_base: request.budget.max_cost_base,
        meta: {
          workspace_id: world.workspace_id,
          assignment_id: request.actor.assignment_id,
          role_id: request.actor.role_id,
          run_id,
          purpose: 'run',
        },
      })
    } catch (err) {
      const e = err as { code?: string; message?: string }
      const code =
        e.code === 'budget_exhausted'
          ? 'budget_exhausted'
          : e.code === 'halted'
            ? 'halted'
            : 'provider_unavailable'
      const failure = { code, message: e.message ?? String(err), retryable: code !== 'halted' }
      sink({ type: 'run.failed', error: failure })
      runs.push({
        request,
        started_at,
        finished_at: clock.now(),
        status: 'failed',
        events: ctx.events,
        failure,
      })
      if (code === 'provider_unavailable') {
        retryQueue.push({ inbound, thread })
      }
      if (code === 'budget_exhausted') {
        world.notify({
          to: world.owner,
          channel: 'workstation',
          title: '模型预算耗尽，队列已冻结',
          at: clock.now(),
          reason: failure.message,
        })
      }
      return
    }

    const controller = new AbortController()
    const result = await world.runtime.run(request, sink, controller.signal)
    runs.push({
      request,
      started_at,
      finished_at: clock.now(),
      status: result.status,
      events: ctx.events,
      result,
    })
    byIdempotency.set(request.idempotency_key, result)
    thread.lastSummary = result.summary
    thread.appEvents = []
    thread.runs += 1
    await tick()
  }

  const threadFor = (from: string, ref: string, subject: string): ThreadState => {
    if (ref === '$thread') {
      if (lastThread === undefined) {
        throw new SimulationError('invalid_input', '$thread 引用了还不存在的线程')
      }
      return lastThread
    }
    if (ref !== 'new') {
      const existing = threads.get(ref)
      if (existing !== undefined) return existing
    }
    const id = ref === 'new' ? `thr_sim_${threads.size + 1}` : ref
    const state: ThreadState = {
      id,
      ref: { type: 'thread', id },
      subject,
      participants: [from, `support@${pack.workspace.id}.example`],
      appEvents: [],
      runs: 0,
    }
    threads.set(id, state)
    // 线程要在 mock provider 的状态里存在，回信才能挂到同一条上
    if (!world.connect.state.threads.some((t) => t.id === id)) {
      world.connect.state.threads.push({
        id,
        subject,
        participants: [...state.participants],
        message_ids: [],
      })
    }
    return state
  }

  const resolveItem = (ref: string): ApprovalItem => {
    const all = txn.runtime.store.listApprovals({ workspace_id: world.workspace_id })
    if (ref === '$last_outbound_draft') {
      const item = [...all].reverse().find((i) => i.kind === 'outbound_draft')
      if (item === undefined) throw new SimulationError('not_found', '还没有对外草稿可决定')
      return item
    }
    if (ref === '$last_skill_lesson') {
      const item = [...all].reverse().find((i) => i.kind === 'skill_lesson')
      if (item === undefined) throw new SimulationError('not_found', '还没有学习提案卡可决定')
      return item
    }
    if (ref === '$last_staged_change') {
      const item = [...all].reverse().find((i) => i.kind === 'staged_change')
      if (item === undefined) throw new SimulationError('not_found', '还没有待批变更可决定')
      return item
    }
    const item = all.find((i) => i.id === ref)
    if (item === undefined) throw new SimulationError('not_found', `审批项不存在：${ref}`)
    return item
  }

  const decideOne = async (
    item: ApprovalItem,
    who: string,
    action: DecisionAction,
    reason: string | undefined,
    option?: string,
  ): Promise<void> => {
    const delivery = [...item.deliveries].reverse().find((d) => d.to === who && d.status === 'sent')
    if (delivery === undefined) {
      throw new SimulationError(
        'forbidden',
        `${who} 手上没有 ${item.id}（${item.kind} / ${item.state}）的 decision_token`,
      )
    }
    const decided = await txn.approvals.decide(item.id, who, {
      decision_token: delivery.decision_token,
      action,
      via: 'workstation',
      ...(reason === undefined ? {} : { reason }),
      ...(option === undefined ? {} : { selected_option_id: option }),
      ...(action === 'approve_edited'
        ? { edited_payload: standIns.actors.applyEdits(item.payload) }
        : {}),
    })
    // WP29：人的决定就是最强的学习信号（24 §3）。装了学习回路才收。
    await world.learning?.onDecided(decided, {
      ...(option === undefined ? {} : { selected_option_id: option }),
    })
  }

  const dispatch = async (event: ScenarioEvent): Promise<void> => {
    switch (event.type) {
      case 'inbound.email': {
        const spec = event.inbound
        const body =
          spec.body ??
          pack.fixtures.get(spec.body_ref ?? '') ??
          (() => {
            throw new SimulationError('not_found', `pack 里没有 fixture：${String(spec.body_ref)}`)
          })()
        const subject = spec.subject ?? `Message from ${spec.from}`
        const thread = threadFor(spec.from, spec.thread, subject)
        lastThread = thread
        const { event: inbound, deduped } = await world.inbound.ingest(
          'email',
          {
            from: spec.from,
            to: [`support@${pack.workspace.id}.example`],
            subject,
            body,
            thread_id: thread.id,
            at: clock.now(),
            ...(spec.message_id === undefined ? {} : { message_id: spec.message_id }),
          },
          world.workspace_id,
        )
        if (inbound === undefined) return
        world.appendEvent(
          deduped ? 'inbound.deduped' : 'inbound.received',
          {
            channel: inbound.channel,
            dedupe_key: inbound.dedupe_key,
            from: inbound.actor?.external_id,
            thread: inbound.thread?.external_id,
            secrets_scrubbed: inbound.secrets_scrubbed,
            routing: inbound.routing,
          },
          { subject: { type: 'thread', id: thread.id } },
        )
        if (deduped) return
        inboundEvents.push(inbound)
        // 18 §2.2：解析不出发件人身份或路由不到职责的进死信（owner 车道），不起运行
        const dead = await world.inbound.deadLetters(world.workspace_id)
        if (dead.some((d) => d.id === inbound.id)) {
          world.appendEvent('inbound.dead_letter', {
            dedupe_key: inbound.dedupe_key,
            reason: inbound.actor?.resolved === undefined ? 'unresolved_sender' : 'unrouted',
          })
          return
        }
        await runInbound(inbound, thread)
        return
      }
      case 'actor.decide': {
        const item = resolveItem(event.decide.item)
        // 14 §12：父项（回信）与随信的子项一起决定
        for (const childId of item.links.children) {
          const child = txn.runtime.store.getApproval(childId)
          if (child !== undefined && ['pending', 'in_review'].includes(child.state)) {
            await decideOne(child, event.decide.who, event.decide.action, event.decide.reason)
          }
        }
        await decideOne(
          item,
          event.decide.who,
          event.decide.action,
          event.decide.reason,
          event.decide.option,
        )
        await tick()
        return
      }
      case 'clock.advance':
        await tick()
        return
      case 'inject.fault': {
        world.connect.inject({
          action: event.fault.action,
          code: event.fault.code,
          times: event.fault.times,
        })
        world.appendEvent('simulation.fault_injected', { ...event.fault })
        return
      }
      case 'model.outage': {
        const ms = parseDuration(event.outage.duration ?? '1h')
        world.startOutage(ms)
        world.appendEvent('simulation.model_outage', { duration_ms: ms })
        return
      }
      case 'inject.budget': {
        world.setBudget(event.budget)
        world.appendEvent('simulation.budget_changed', { ...event.budget })
        return
      }
      case 'learning.start': {
        // WP29：装上学习回路（它自己会先把「一天的例行公事」的调度器起起来）
        world.startLearning({
          ...(event.learning.propose_hour === undefined
            ? {}
            : { proposeHour: event.learning.propose_hour }),
          ...(event.learning.propose_minute === undefined
            ? {}
            : { proposeMinute: event.learning.propose_minute }),
        })
        world.appendEvent('simulation.learning_started', {
          skills: world.pack.skills.map((s) => s.name),
        })
        return
      }
      default: {
        // 25：装上一天的例行公事；不出现这条事件的场景一条定时任务都没有
        const routine = world.startRoutine({
          ...(event.routine.plan_hour === undefined ? {} : { planHour: event.routine.plan_hour }),
          ...(event.routine.review_hour === undefined
            ? {}
            : { reviewHour: event.routine.review_hour }),
        })
        world.appendEvent('simulation.routine_started', {
          tasks: routine.scheduler.list({ workspace_id: world.workspace_id }).map((t) => t.handler),
        })
        return
      }
    }
  }

  const start = clock.now()
  for (const event of scenario.events) {
    await advanceTo(resolveAt(event.at, scenario.clock.start))
    await dispatch(event)
  }
  await advanceTo(new Date(clock.nowMs() + SETTLE_MS).toISOString())

  const evidence: Evidence = {
    workspace_id: world.workspace_id,
    start,
    end: clock.now(),
    events: [...world.events],
    runs,
    inbound: inboundEvents,
    observations: world.standIns.observations.all(),
    cards: world.standIns.deliveries.workstation.all(),
    emails: world.standIns.deliveries.email.all(),
    approvals: txn.runtime.store.listApprovals({ workspace_id: world.workspace_id }),
    changes: txn.runtime.store.listChanges({ workspace_id: world.workspace_id }),
    outages: world.outages,
    notifications: world.notifications,
    blocked: [...world.blocked, ...applyErrors],
    ...(world.learning === undefined
      ? {}
      : {
          learning: {
            pooled: world.learning.pool.list({ workspace_id: world.workspace_id }).length,
            proposals: world.learning.proposals.length,
            filtered: world.learning.filtered.map((f) => f.reason),
            resolved_skills: (await world.learning.promptSections()).map((s) => s.text),
          },
        }),
  }

  const writeActions = new Set(
    world.connect
      .allActions()
      .filter((a) => a.side_effect === 'write')
      .map((a) => a.id),
  )
  captureEvidence?.(evidence)
  const metrics = computeMetrics(evidence)
  const invariants = checkInvariants(scenario.invariants, { evidence, writeActions })
  const expectations = checkExpectations(scenario.expected, evidence, metrics)

  return buildReport({
    scenario,
    tier,
    seed,
    runtime,
    evidence,
    metrics,
    invariants,
    expectations,
  })
}
