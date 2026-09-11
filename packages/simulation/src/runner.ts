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
import type { JudgeReport } from './judge.js'
import { judgeConfigOf, runModelJudge, runRuleJudge } from './judge.js'
import { computeMetrics } from './metrics.js'
import type { Pack } from './pack.js'
import { loadPack } from './pack.js'
import type { ScenarioReport } from './report.js'
import { buildReport } from './report.js'
import type { RuntimeName } from './runtime-name.js'
import { parseDuration, parseRange, resolveAt } from './scenario/duration.js'
import type {
  Scenario,
  ScenarioEvent,
  ScenarioSecretaryAsk,
  ScenarioSecretaryDecide,
  ScenarioSecretaryMeet,
  ScenarioSecretaryRoute,
  ScenarioWorkClaim,
  ScenarioWorkTodo,
  Tier,
} from './scenario/types.js'
import type { SecretaryLoop } from './secretary.js'
import { installSecretary } from './secretary.js'
import type { RealModelBinding, RunContext, World } from './world.js'
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
  /** WP32 realistic 档：真模型绑定（key 只从环境变量取）。 */
  model?: RealModelBinding
  /**
   * WP32 realistic 档：合成人的决定与客户来信交给真模型演（26 §3）。
   * 是个工厂，因为钩子要用这个世界的网关（记账、预算、驻留策略都在网关里）。
   * 不给就是规则版合成人 + fixture 来信，fast 档一个字节不变。
   */
  realistic?: (world: World) => RealisticHooks
  /** WP32：跑不跑模型 judge（规则 judge 一直跑）。 */
  modelJudge?: boolean
}

/** realistic 档的两个钩子：客户来信怎么写、人怎么决定。 */
export interface RealisticHooks {
  /**
   * 客户来信的正文。同 seed 下**内容固定**：第一次经模型生成后写进缓存，
   * 之后一律回放缓存（26 原则 ①：一切随机来自 seed，失败可复现）。
   */
  writeInbound?: (input: {
    scenario: string
    index: number
    from: string
    subject: string
    fallback: string
  }) => Promise<string>
  /** 人怎么处置这张卡（只影响 `actor.decide` 没点名的那部分行为，点名的照场景走）。 */
  decide?: (input: {
    person: string
    item: ApprovalItem
    action: DecisionAction
  }) => Promise<{ action: DecisionAction; reason?: string }>
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
  const seed = options.seed ?? scenario.dataset.seed
  const pack =
    options.pack ??
    loadPack(options.packDir ?? `${options.packsDir ?? 'packs'}/${scenario.dataset.pack}`)

  // realistic 档默认走 direct 运行时：stub 运行时压根不看模型说了什么，
  // 用真模型跑它等于花钱买一份规则草稿（26 §4 realistic = 真模型质量评测那一类）
  const runtime: RuntimeName =
    options.runtime ?? (tier === 'realistic' && options.model !== undefined ? 'direct' : 'stub')

  const world = await createWorld({
    pack,
    seed,
    start: scenario.clock.start,
    runtime,
    ...(options.dbPath === undefined ? {} : { dbPath: options.dbPath }),
    ...(scenario.policy === undefined ? {} : { txnPolicy: scenario.policy }),
    ...(options.model === undefined ? {} : { model: options.model }),
  })

  try {
    return await execute(scenario, world, pack, seed, tier, runtime, options)
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
  options: RunScenarioOptions,
): Promise<ScenarioReport> {
  const captureEvidence = options.captureEvidence
  const realistic = options.realistic?.(world)
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
    // 22 §2 降级：provider 挂了 → **冻结队列**。冻结的不只是"不起新草稿"，
    // 施行与投递也一起停——半冻结的系统正是 `freeze_on_model_outage` 要挡的东西：
    // 模型不可用时谁也说不清这条草稿还该不该发。恢复后照常出队，
    // 同一 idempotency_key 不会发第二次（17 §5.7）。
    // soak 档第一次把这个洞压出来了：停机前批准的回信，停机中照发不误。
    if (!world.modelDown()) await drainApprovals()
    // 14 §4.4 / §7 / §13.2：过期、升级链、抽检复核。真实进程里这是定时任务，
    // 模拟回路里合成时钟每推进一拍就得走一遍——否则"没人理就升级"在虚拟时间里永远不发生。
    await world.tickApprovals()
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
    requested: DecisionAction,
    requestedReason: string | undefined,
    option?: string,
  ): Promise<void> => {
    // realistic 档：这个人会不会照场景写的那样决定，交给真模型按人设判（26 §3）
    let action = requested
    let reason = requestedReason
    if (realistic?.decide !== undefined) {
      const verdict = await realistic.decide({ person: who, item, action: requested })
      action = verdict.action
      reason = verdict.reason ?? requestedReason
    }
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

  /* ── WP38 认领与撞车（40 §3）──────────────────────────────────────── */

  /** 一次被拦下的动作。`rule` 就是服务端给的 `details.reason`，场景用 `blocked_rules` 断言。 */
  const workBlocked = (err: unknown, fallback: string): void => {
    const rec = err as { code?: string; message?: string; details?: { reason?: string } }
    world.blocked.push({
      rule: rec.details?.reason ?? rec.code ?? fallback,
      at: clock.now(),
      message: typeof rec.message === 'string' ? rec.message : fallback,
    })
  }

  /**
   * 某人记一条待办，**建之前先查**（40 §3.1）。
   * 撞上了就不建：这一次拦截进 `blocked`，候选的主人写进消息里。
   */
  const workTodo = (input: ScenarioWorkTodo): void => {
    try {
      const made = world.work.createTodoChecked({
        title: input.title,
        owner: input.who,
        position_id: world.assignment.id,
        ...(input.order === undefined
          ? {}
          : { refs: [{ type: 'order', id: input.order }] as const }),
        ...(input.collision === undefined ? {} : { collision: input.collision }),
        ...(input.distinct_reason === undefined ? {} : { distinct_reason: input.distinct_reason }),
      })
      world.appendEvent(
        'simulation.work_todo',
        {
          title: made.todo.title,
          owner: made.todo.owner,
          ...(made.joined_matter_id === undefined
            ? {}
            : { joined_matter_id: made.joined_matter_id }),
          ...(made.offered_to === undefined ? {} : { offered_to: made.offered_to }),
        },
        { subject: { type: 'todo', id: made.todo.id } },
      )
    } catch (e) {
      workBlocked(e, 'similar_in_progress')
    }
  }

  /** 某人点「我来」：第一个成功的是主人，其余进 `blocked`（`already_claimed`）。 */
  const workClaim = (input: ScenarioWorkClaim): void => {
    const target = world.work
      .listTodos({})
      .filter((t) => t.title === input.title)
      .pop()
    if (target === undefined) {
      world.blocked.push({
        rule: 'not_found',
        at: clock.now(),
        message: `池里没有这条活：${input.title}`,
      })
      return
    }
    try {
      const todo = world.work.claimTodo(target.id, input.who, {
        position_id: world.assignment.id,
      })
      world.appendEvent(
        'simulation.work_claimed',
        { title: todo.title, owner: todo.owner },
        { subject: { type: 'todo', id: todo.id } },
      )
    } catch (e) {
      workBlocked(e, 'already_claimed')
    }
  }

  /* ── WP39 秘书 Agent（41 §1）──────────────────────────────────────── */

  /** 惰性装：场景里没有 `secretary.*` 就一个都不装，原有场景一条指标不变。 */
  const secretaryLoop = (): SecretaryLoop => {
    if (world.secretary === undefined) world.secretary = installSecretary(world)
    return world.secretary
  }

  /** 一天的窗口（"双方日历都有"那条断言按它取）。 */
  const dayRange = (at: Iso8601): { from: Iso8601; to: Iso8601 } => ({
    from: new Date(Date.parse(at) - 86_400_000).toISOString(),
    to: new Date(Date.parse(at) + 7 * 86_400_000).toISOString(),
  })

  const secretaryAsk = async (input: ScenarioSecretaryAsk): Promise<void> => {
    const loop = secretaryLoop()
    try {
      const out = await loop.secretary.ask({
        viewer: input.who,
        person_id: input.about,
        question: input.question,
        assignment_id: world.assignment.id,
      })
      loop.answers.push(out.kind)
      // 被拒也是一次"挡下"：场景用 `blocked_rules: [secretary_refused]` 断言
      if (out.refused)
        world.blocked.push({
          rule: 'secretary_refused',
          at: clock.now(),
          message: out.answer,
        })
      world.appendEvent('simulation.secretary_asked', {
        asked_by: input.who,
        about: input.about,
        kind: out.kind,
        refused: out.refused,
        fields: out.fields,
      })
    } catch (e) {
      workBlocked(e, 'secretary_ask_failed')
    }
  }

  const secretaryMeet = async (input: ScenarioSecretaryMeet): Promise<void> => {
    const loop = secretaryLoop()
    const minutes = input.minutes ?? 30
    try {
      const proposal = await loop.secretary.meet({
        from: input.who,
        to: input.with,
        title: input.title ?? '聊一下',
        candidates: [
          {
            start: input.slot,
            end: new Date(Date.parse(input.slot) + minutes * 60_000).toISOString(),
          },
        ],
        duration_minutes: minutes,
        assignment_id: world.assignment.id,
      })
      world.appendEvent('simulation.meet_proposed', {
        meet_id: proposal.id,
        from: proposal.from,
        to: proposal.to,
      })
    } catch (e) {
      workBlocked(e, 'slot_conflict')
    }
  }

  const secretaryDecide = async (input: ScenarioSecretaryDecide): Promise<void> => {
    const loop = secretaryLoop()
    const pending = loop.secretary
      .meets(input.who, { state: ['proposed'] })
      .find((m) => m.to === input.who)
    if (pending === undefined) {
      world.blocked.push({
        rule: 'not_found',
        at: clock.now(),
        message: `没有等 ${input.who} 点头的约时间卡`,
      })
      return
    }
    try {
      const decided = await loop.secretary.decideMeet(pending.id, input.who, {
        action: input.action,
      })
      if (decided.state !== 'accepted') return
      // 41 §1.2「对方点头才进双方日历」——这一条断言就是这么钉住的
      const range = dayRange(decided.accepted?.start ?? clock.now())
      const onBoth = [decided.from, decided.to].every((person) =>
        loop.agendaOf(person, range).some((i) => i.ref.id === decided.meeting_id),
      )
      if (onBoth)
        world.appendEvent('simulation.meet_on_both_calendars', {
          meet_id: decided.id,
          meeting_id: decided.meeting_id,
          from: decided.from,
          to: decided.to,
        })
    } catch (e) {
      workBlocked(e, 'meet_decide_failed')
    }
  }

  const secretaryRoute = async (input: ScenarioSecretaryRoute): Promise<void> => {
    const loop = secretaryLoop()
    try {
      const out = await loop.secretary.route({
        person_id: input.who,
        assignment_id: world.assignment.id,
        text: input.text,
      })
      world.appendEvent('simulation.secretary_routed', {
        kind: out.kind,
        confidence: out.confidence,
        ...(out.role_id === undefined ? {} : { role_id: out.role_id }),
        ...(out.owner === undefined ? {} : { owner: out.owner }),
      })
    } catch (e) {
      workBlocked(e, 'secretary_route_failed')
    }
  }

  const dispatch = async (event: ScenarioEvent): Promise<void> => {
    switch (event.type) {
      case 'inbound.email': {
        const spec = event.inbound
        const fallback =
          spec.body ??
          pack.fixtures.get(spec.body_ref ?? '') ??
          (() => {
            throw new SimulationError('not_found', `pack 里没有 fixture：${String(spec.body_ref)}`)
          })()
        const subject = spec.subject ?? `Message from ${spec.from}`
        // realistic 档：来信由真模型按人设写；同 seed 下内容固定（缓存 + 回放）
        const body =
          realistic?.writeInbound === undefined
            ? fallback
            : await realistic.writeInbound({
                scenario: scenario.id,
                index: scenario.events.indexOf(event),
                from: spec.from,
                subject,
                fallback,
              })
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
      case 'reconcile.run': {
        // 15 §5.8：unknown 的对账。soak 档每天跑一次，所以"下一次对账内清零"是可断言的
        await world.reconcileUnknown()
        await tick()
        return
      }
      case 'process.restart': {
        const res = await world.restartEventLog()
        world.appendEvent('simulation.process_restarted', { ...res })
        if (!res.chain_ok || res.events_after < res.events_before) {
          throw new SimulationError(
            'conflict',
            `重启后事件日志对不上：${res.events_before} → ${res.events_after}，chain_ok=${res.chain_ok}`,
          )
        }
        await tick()
        return
      }
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
      // ── WP38 认领与撞车（40 §3）────────────────────────────────────
      case 'work.todo': {
        workTodo(event.todo)
        return
      }
      case 'work.pool': {
        const item = world.work.poolTodo({
          title: event.pool.title,
          source: (event.pool.source ?? 'meeting') as 'meeting' | 'plan' | 'alert' | 'review',
        })
        world.appendEvent(
          'simulation.work_pooled',
          { title: item.title, source: item.source },
          { subject: { type: 'todo', id: item.id } },
        )
        return
      }
      case 'work.claim': {
        workClaim(event.claim)
        return
      }
      case 'work.idle_sweep': {
        const swept = world.work.sweepIdleTodos(
          event.idle.idle_days === undefined ? {} : { idle_days: event.idle.idle_days },
        )
        world.appendEvent('simulation.work_idle_swept', {
          checked: swept.checked,
          reminded: swept.reminded.length,
          recycled: swept.recycled.length,
        })
        return
      }
      // ── WP39 秘书 Agent（41 §1）────────────────────────────────────
      case 'secretary.profile': {
        secretaryLoop().secretary.updateProfile(event.profile.who, {
          disclosure: {
            [event.profile.field]: event.profile.level,
          } as Record<string, 'self' | 'colleagues' | 'workspace'>,
        })
        world.appendEvent('simulation.secretary_profile', {
          who: event.profile.who,
          field: event.profile.field,
          level: event.profile.level,
        })
        return
      }
      case 'secretary.ask': {
        await secretaryAsk(event.ask)
        return
      }
      case 'secretary.meet': {
        await secretaryMeet(event.meet)
        return
      }
      case 'secretary.meet_decide': {
        await secretaryDecide(event.decide_meet)
        return
      }
      case 'secretary.route': {
        await secretaryRoute(event.route)
        return
      }
      // ── WP44 店铺操作（08 §2.3 读走原生 Action、写走 Backend）──────
      case 'shop.price_change': {
        const out = await world.shop.priceChange(event.price_change)
        world.appendEvent('simulation.shop_price_change', {
          product: event.price_change.product,
          price: event.price_change.price,
          staged: out.staged,
          ...(out.reason === undefined ? {} : { reason: out.reason }),
        })
        return
      }
      case 'shop.theme_push': {
        const pushed = await world.shop.themePush(event.theme_push)
        world.appendEvent('simulation.shop_theme_pushed', {
          theme_id: pushed.theme_id,
          theme_name: pushed.theme_name,
        })
        return
      }
      case 'shop.theme_publish': {
        const out = await world.shop.themePublish({
          who: event.theme_publish.who,
          ...(event.theme_publish.theme === undefined ? {} : { theme: event.theme_publish.theme }),
          ...(event.theme_publish.level === undefined ? {} : { level: event.theme_publish.level }),
        })
        world.appendEvent('simulation.shop_theme_publish_staged', {
          staged: out.staged,
          ...(out.reason === undefined ? {} : { reason: out.reason }),
        })
        return
      }
      // ── WP47 范围模型（44 G1 / G2 / G3 / G5）──────────────────────
      case 'org.range_group': {
        const out = await world.org.rangeGroup({
          id: event.range_group.id,
          name: event.range_group.name,
          members: event.range_group.members,
        })
        world.appendEvent('simulation.range_group', {
          range_group: event.range_group.id,
          created: out.created,
          members: event.range_group.members.length,
          affected_assignments: out.affected,
        })
        await tick()
        return
      }
      case 'org.product_line': {
        const out = world.org.productLine({
          id: event.product_line.id,
          name: event.product_line.name,
          parent: event.product_line.parent,
          rule: event.product_line.rule,
        })
        world.appendEvent('simulation.product_line', {
          product_line: event.product_line.id,
          created: out.created,
          platform: event.product_line.rule.platform,
        })
        return
      }
      case 'org.assign_range': {
        const out = world.org.assignRange({
          who: event.assign_range.who,
          role: event.assign_range.role,
          ...(event.assign_range.ranges === undefined ? {} : { ranges: event.assign_range.ranges }),
          ...(event.assign_range.range_groups === undefined
            ? {}
            : { range_groups: event.assign_range.range_groups }),
        })
        world.appendEvent('simulation.assign_range', {
          who: event.assign_range.who,
          role: event.assign_range.role,
          assignment_id: out.assignment_id,
          ranges: out.ranges,
        })
        return
      }
      // ── WP50 个人用 → 公司用（45 H1 / H2 / H3）────────────────────
      case 'org.personal': {
        const out = world.org.personalWorkspace({
          who: event.personal.who,
          workspace: event.personal.workspace,
          role: event.personal.role,
          ...(event.personal.range_groups === undefined
            ? {}
            : { range_groups: event.personal.range_groups }),
          ...(event.personal.product_lines === undefined
            ? {}
            : { product_lines: event.personal.product_lines }),
        })
        world.appendEvent('simulation.personal_workspace', {
          who: event.personal.who,
          workspace: event.personal.workspace,
          assignment_id: out.assignment_id,
          ranges: out.ranges,
        })
        return
      }
      case 'org.join': {
        const out = await world.org.join({
          who: event.join.who,
          from: event.join.from,
          ...(event.join.decisions === undefined ? {} : { decisions: event.join.decisions }),
        })
        world.appendEvent('simulation.joined', {
          who: event.join.who,
          from: event.join.from,
          counts: out.counts,
          merged: out.merged,
          created: out.created,
          range_rewrites: out.range_rewrites,
        })
        await tick()
        return
      }
      case 'org.scope_check': {
        const seen = world.org.visible(event.scope_check.who, event.scope_check.role)
        world.appendEvent('simulation.scope_checked', {
          who: event.scope_check.who,
          role: event.scope_check.role,
          orders: seen.orders,
          products: seen.products,
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
    // WP44：入站信件起的运行在 `runs` 里，工作台上点出来的店铺操作在 `world.shopRuns` 里；
    // 证据只认一份清单，按开始时间并起来
    runs: [...runs, ...world.shopRuns].sort(
      (a, b) => Date.parse(a.started_at) - Date.parse(b.started_at),
    ),
    inbound: inboundEvents,
    observations: world.standIns.observations.all(),
    cards: world.standIns.deliveries.workstation.all(),
    emails: world.standIns.deliveries.email.all(),
    approvals: txn.runtime.store.listApprovals({ workspace_id: world.workspace_id }),
    changes: txn.runtime.store.listChanges({ workspace_id: world.workspace_id }),
    outages: world.outages,
    notifications: world.notifications,
    blocked: [...world.blocked, ...applyErrors],
    sampling_reviews: [...world.samplingReviews],
    assignments: world.assignmentSnapshots(),
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

  // judge（26 §1）：规则 judge 每档都跑并进门禁；模型 judge 只在拿到真模型时跑，只报不拦
  const { config: judgeConfig, rubric, ref: rubricRef } = judgeConfigOf(pack.judges)
  const judge: JudgeReport = { rule: runRuleJudge(evidence, judgeConfig) }
  if (rubricRef !== undefined) judge.rubric_ref = rubricRef
  const rubricText = scenario.rubric ?? rubric
  if (options.modelJudge === true && rubricText !== undefined) {
    judge.model = await runModelJudge({
      gateway: { complete: (r) => world.gateway().complete(r) },
      evidence,
      rubric: rubricText,
      meta: {
        workspace_id: world.workspace_id,
        assignment_id: world.assignment.id,
        role_id: world.assignment.role_id,
        run_id: `judge_${scenario.id.replace(/[^a-z0-9]+/gi, '_')}`,
      },
    })
  }

  const metrics = computeMetrics(evidence, judge)
  const invariants = checkInvariants(scenario.invariants, { evidence, writeActions })
  const expectations = checkExpectations(scenario.expected, evidence, metrics, judge)

  return buildReport({
    scenario,
    tier,
    seed,
    runtime,
    evidence,
    metrics,
    invariants,
    expectations,
    judge,
  })
}
