/**
 * WP181：官方「自动化任务」在我们的运行里**真用起来**——服务端这一层（「只包一层」的那一层）。
 *
 * 官方的（`@agentsws/dsh-adapter/official-schedule`，照用）：四个工具的名字 / 参数 / 描述、六种时间写法的
 * 校验与报错码、每天 / 每周几 / cron / 固定间隔的下一次怎么算、工具回给模型的 JSON、到点给模型的那段话。
 *
 * 我们包的（这个文件）：
 *
 * | 事 | 怎么做 |
 * |---|---|
 * | 开关 | `enabled()` 为真才挂四个工具、到点才跑；关了就停（任务留着）。WP181 时是「官方插件装没装」，WP293 起官方把它收进 Web 自己挂，服务端传的是一直开 |
 * | 谁能建 / 改 / 删 | 模型只动**这件事里、这个岗位自己建的**；界面上本人管自己的（`schedule.ts` 的端口） |
 * | 存哪 | 我们的调度器（落盘、重启续跑、不重入、`schedule.*` 事件）；官方那份记录原样放在 `params.official` |
 * | 到点 | 接着原来那件事跑一次这个岗位的运行（官方是投回原来那次对话）；对外动作照样出卡 |
 * | 出卡 | **会往外发 / 写数据的周期任务**先出一张 `scheduled_task` 卡，批了才开始（一次性提醒不出卡） |
 * | 上限 | 每个岗位最多 20 条；周期的两次之间至少 15 分钟；每个岗位每个自然日（公司时区）到点自动跑最多 24 次（落盘计数） |
 * | 审计 | 每次工具调用记 `automation.requested`（不带正文）；到了上限没跑记 `automation.capped` |
 */

import type {
  ApprovalItem,
  Clock,
  CreateApprovalInput,
  DecideInput,
  EventEnvelope,
  Matter,
  PersonId,
  RoleId,
  RunRequest,
  StartRun,
  WorkspaceId,
} from '@agentsws/contracts'
import {
  isRecurring,
  MAX_TITLE_LENGTH,
  OfficialScheduleError,
  type OfficialScheduleRecord,
  type OfficialSelector,
  officialRecord,
  officialView,
  reminderBrief,
  selectorCount,
  selectorOf,
  shortestGapSeconds,
  triggerOf,
  withZone,
} from '@agentsws/dsh-adapter/official-schedule'
import type { Scheduler, ScheduleTask } from '@agentsws/schedule'
import type { ToolExecution, ToolExecutor } from '@agentsws/stand-ins'
import { isScheduleTool } from '@agentsws/stand-ins'
import type { Work } from '@agentsws/work'
import Database from 'better-sqlite3'
import { settleScheduleApproval } from './schedule.js'

/** 到点交给谁（调度器里登记的名字）。 */
export const AUTOMATION_HANDLER = 'automation.reminder'

/** 包的那一层的上限（Fable 09-29：次数与花钱上限）。花钱那一道是到点那次运行自己的额度与预算，与手点的同一套。 */
export const AUTOMATION_LIMITS = {
  /** 一个岗位最多挂几条（在跑的 + 暂停的 + 等批的）。 */
  per_assignment: 20,
  /** 周期任务两次之间最短隔多久（秒）。官方下限是 60 秒；到点跑的是一次模型运行，所以我们收紧到一刻钟。 */
  min_gap_seconds: 15 * 60,
  /** 一个岗位一个自然日（公司时区）里到点自动跑最多几次（落盘计数，重启不清零）。 */
  fires_per_day: 24,
} as const

type AppendEvent = (e: Omit<EventEnvelope, 'id' | 'at'> & { at?: string }) => void

interface ApprovalsLike {
  create<P>(input: CreateApprovalInput<P>): Promise<ApprovalItem<P>>
}

export interface AutomationOptions {
  /** 调度器（一个进程一个，跨品牌；任务上带着各自的 `workspace_id`）。惰性：装配时它还没起来。 */
  scheduler(): Scheduler
  clock: Clock
  appendEvent: AppendEvent
  /** 出卡那条审批总线（惰性：总线要先包上这一层才建得出来）。 */
  approvals(): ApprovalsLike
  /** 自动化任务开没开（**每次现问**）。WP293 起服务端一直传真（官方改成内置）；测试仍用它钉「关了就停」。 */
  enabled(): Promise<boolean> | boolean
  /** 这个品牌的公司时区（`+08:00` 或 IANA）；模型没写时区就按它。 */
  companyZone(workspace_id: WorkspaceId): Promise<string> | string
  /** 到点接着跑：这个品牌的事项与运行入口（品牌模块懒建，所以是异步的）。 */
  runner?(
    workspace_id: WorkspaceId,
  ):
    | Promise<{ work: Work; startRun?: StartRun } | undefined>
    | { work: Work; startRun?: StartRun }
    | undefined
  limits?: Partial<typeof AUTOMATION_LIMITS>
  random?: () => number
  /** 每天到点自动跑的次数记在哪（服务端有数据目录时给落盘那一份）；不给 = 内存（重启清零）。 */
  fires?: AutomationFireCounter
}

/**
 * WP181（Fable 终审）：每个岗位每个自然日（公司时区）到点自动跑了几次。**落盘**——重启不清零，
 * 否则「每天最多 24 次」重启一次就又有 24 次。
 */
export interface AutomationFireCounter {
  count(assignment_id: string, day: string): number
  /** 记一次，回记完之后的次数。 */
  bump(assignment_id: string, day: string): number
  close?(): void
}

export function memoryFireCounter(): AutomationFireCounter {
  const counts = new Map<string, number>()
  const key = (a: string, d: string): string => `${a}\u0000${d}`
  return {
    count: (a, d) => counts.get(key(a, d)) ?? 0,
    bump(a, d) {
      const n = (counts.get(key(a, d)) ?? 0) + 1
      counts.set(key(a, d), n)
      return n
    },
  }
}

/** 落盘那一份：数据目录下 `automation.sqlite` 的一张表（岗位 × 自然日 → 次数）。只留最近 7 天。 */
export function sqliteFireCounter(dbPath: string): AutomationFireCounter {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.exec(
    `CREATE TABLE IF NOT EXISTS automation_fires (
       assignment_id TEXT NOT NULL,
       day TEXT NOT NULL,
       count INTEGER NOT NULL,
       PRIMARY KEY (assignment_id, day)
     )`,
  )
  const get = db.prepare('SELECT count FROM automation_fires WHERE assignment_id = ? AND day = ?')
  const up = db.prepare(
    `INSERT INTO automation_fires (assignment_id, day, count) VALUES (?, ?, 1)
     ON CONFLICT (assignment_id, day) DO UPDATE SET count = count + 1`,
  )
  const prune = db.prepare('DELETE FROM automation_fires WHERE day < ?')
  const count = (a: string, d: string): number =>
    (get.get(a, d) as { count: number } | undefined)?.count ?? 0
  return {
    count,
    bump(a, d) {
      up.run(a, d)
      // 自然日是 `YYYY-MM-DD`，按字符串比就是按日期比
      const cutoff = new Date(Date.parse(`${d}T00:00:00Z`) - 7 * 86_400_000)
        .toISOString()
        .slice(0, 10)
      prune.run(cutoff)
      return count(a, d)
    },
    close() {
      db.close()
    },
  }
}

/** 某一刻在某个时区里是哪一天（`YYYY-MM-DD`）；时区认不出按 UTC。 */
export function localDay(at: string, zone: string): string {
  const fmt = (tz: string): string =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(at))
  try {
    return fmt(zone)
  } catch {
    return fmt('UTC')
  }
}

export interface AutomationAssembly {
  /** 四个工具的执行器（服务端工具链里认 `schedule_*` 就交给它）。 */
  executeTool: ToolExecutor
  enabled(): Promise<boolean>
  /** 登记到点的处理器（装配时调一次）。 */
  register(): void
  /** 审批总线包一层：`scheduled_task` 卡批了就开始、拒了就取消。 */
  wrap<B extends { decide(id: string, by: never, input: DecideInput): Promise<ApprovalItem> }>(
    bus: B,
  ): B
  /** 界面改时间（「每天 / 每周几点」）：按官方校验重算，回新的触发器与 params。 */
  retime(task: ScheduleTask, selector: OfficialSelector): Promise<ScheduleTask>
}

/** 官方那份记录（没有就不是这一层建的任务）。 */
export function officialOf(task: ScheduleTask): OfficialScheduleRecord | undefined {
  const r = task.params?.official
  return r !== null && typeof r === 'object' && typeof (r as { kind?: unknown }).kind === 'string'
    ? (r as OfficialScheduleRecord)
    : undefined
}

/**
 * 到点会不会往外发 / 写数据（执行器自己判，不信模型的自述）。宁可多出一张卡：
 * 判错成「会发」的代价是人多点一下；判漏了到点那次运行的对外动作照样出卡（第二道闸）。
 */
const EXTERNAL =
  /发邮件|发信|发消息|发帖|发布|发送|发给|群发|推送|回复客户|回信|回复买家|寄|退款|下单|改价|调价|上架|下架|删除|付款|转账|出价|提交|\bsend\b|\bemail\b|\breply\b|\bpost\b|\bpublish\b|\brefund\b|\border\b|\bdelete\b|\bpay\b/i

export function effectOf(text: string): 'read_only' | 'sends' {
  return EXTERNAL.test(text) ? 'sends' : 'read_only'
}

const LIVE: readonly ScheduleTask['state'][] = ['active', 'paused', 'running', 'pending']

const bare = (name: string): string =>
  name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name

/** 官方的报错值（工具原样回给模型的那种 `{ code, message }`）。 */
const failure = (code: string, message: string): ToolExecution => ({
  status: 'ok',
  data: { code, message },
})

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

export function createAutomation(options: AutomationOptions): AutomationAssembly {
  const { clock } = options
  const scheduler = new Proxy({} as Scheduler, {
    get: (_t, prop) => {
      const real = options.scheduler()
      const value = Reflect.get(real, prop, real)
      return typeof value === 'function' ? value.bind(real) : value
    },
  })
  const limits = { ...AUTOMATION_LIMITS, ...options.limits }
  const random = options.random ?? Math.random
  /** 每个岗位每个自然日到点跑过几次（服务端给的是落盘那一份，重启不清零）。 */
  const fires = options.fires ?? memoryFireCounter()

  const enabled = async (): Promise<boolean> => {
    try {
      return (await options.enabled()) === true
    } catch {
      return false
    }
  }

  const emit = (
    workspace_id: string,
    type: 'automation.requested' | 'automation.capped',
    actor: { kind: 'agent' | 'system'; id: string },
    payload: Record<string, unknown>,
  ): void => {
    options.appendEvent({
      schema_version: 1,
      workspace_id: workspace_id as WorkspaceId,
      type,
      actor,
      ...(typeof payload.task_id === 'string'
        ? { subject: { type: 'scheduled_task', id: payload.task_id } }
        : {}),
      correlation: { trace_id: `tr_automation_${clock.now()}` },
      payload,
    })
  }

  const newTaskId = (): string => {
    const tail = Math.floor(random() * 36 ** 6)
      .toString(36)
      .padStart(6, '0')
    return `sched_auto_${Date.parse(clock.now()).toString(36)}${tail}`
  }

  /** 这件事里、这个岗位用官方工具建的那几条。 */
  const mine = (req: RunRequest): ScheduleTask[] =>
    scheduler
      .list({
        workspace_id: req.workspace_id as WorkspaceId,
        assignment_id: req.actor.assignment_id,
      })
      .filter(
        (t) =>
          t.handler === AUTOMATION_HANDLER &&
          t.origin?.conversation_id === req.work_item?.id &&
          officialOf(t) !== undefined,
      )

  /** 给模型看的那一份：官方 view，下一次用调度器里排着的那一刻；等批的多一句话。 */
  const viewOf = (task: ScheduleTask): Record<string, unknown> => {
    const record = officialOf(task) as OfficialScheduleRecord
    const at = task.next_fire_at ?? record.scheduledAt
    const view = officialView(
      { ...record, title: task.title ?? record.title, scheduledAt: at },
      Date.parse(clock.now()),
    ) as unknown as Record<string, unknown>
    return task.params?.awaiting_approval === true
      ? { ...view, approval: 'pending', note: '到点会往外发或写数据，已出卡请人确认，批了才开始。' }
      : view
  }

  /** 会往外发的周期任务：出一张 `scheduled_task` 卡给这条任务的主人（批了才开始）。 */
  const card = async (
    workspace_id: string,
    task_id: string,
    record: OfficialScheduleRecord,
    who: { person_id: PersonId; role_id: RoleId },
    run_id: string | undefined,
  ): Promise<string> => {
    const item = await options.approvals().create({
      workspace_id: workspace_id as WorkspaceId,
      schema_version: 1,
      kind: 'scheduled_task',
      role_id: who.role_id,
      subject: { object: { type: 'scheduled_task', id: task_id } },
      // 一条任务一个键：还在等批时内容又改了，审批总线按键改写同一张卡（新内容、新一版），不多出一张；
      // 批过之后再改，旧卡已结束，总线出新卡并标「取代」。`wrap` 里再核一遍卡上的内容与任务现在的一致
      dedupe_key: `${workspace_id}:scheduled_task:${task_id}`,
      title: `要不要设这条定时：${record.title}`,
      summary: '到点会往外发或写数据。批了才开始；到点那次运行里的对外动作照样一张张出卡。',
      payload: {
        task_id,
        title: record.title,
        prompt: record.prompt,
        rule: triggerOf(record),
        effect: 'sends',
        ...(run_id === undefined ? {} : { run_id }),
      },
      evidence: { source_events: [], provenance: { seen: [] }, precheck: {} },
      proposer: { kind: 'agent', id: run_id ?? 'automation' },
      automation: {
        level_at_creation: 'L1',
        auto_approved: false,
        mandate_check: { within: true, caps_hit: [] },
        sampling: { selected: false },
      },
      routing: {
        recipients: [{ person: who.person_id, via: 'role_holder' }],
        rule: 'role_holder',
        escalation: { after_hours: 24, business_hours: true, chain: ['owner'], escalated_at: [] },
        separation_of_duties: false,
      },
      priority: 'queue',
    } as CreateApprovalInput<Record<string, unknown>>)
    return item.id
  }

  /** 上限：条数（建的时候）与频率（建 / 改都查）。过了回官方形状的报错值。 */
  const overLimit = (
    req: RunRequest,
    record: OfficialScheduleRecord,
    creating: boolean,
  ): ToolExecution | undefined => {
    if (creating) {
      const live = scheduler
        .list({
          workspace_id: req.workspace_id as WorkspaceId,
          assignment_id: req.actor.assignment_id,
        })
        .filter((t) => t.handler === AUTOMATION_HANDLER && LIVE.includes(t.state))
      if (live.length >= limits.per_assignment) {
        return failure(
          'limit_reached',
          `这个岗位已经挂了 ${live.length} 条定时，最多 ${limits.per_assignment} 条；先删掉不用的再建。`,
        )
      }
    }
    const gap = shortestGapSeconds(record)
    if (gap !== undefined && gap < limits.min_gap_seconds) {
      return failure(
        'frequency_too_high',
        `周期任务两次之间至少隔 ${limits.min_gap_seconds / 60} 分钟（每次到点都是一次模型运行）。`,
      )
    }
    return undefined
  }

  const actorOf = (req: RunRequest) => ({ kind: 'agent' as const, id: req.id })

  async function create(req: RunRequest, input: Record<string, unknown>): Promise<ToolExecution> {
    const nowMs = Date.parse(clock.now())
    const selector = withZone(
      selectorOf(input),
      await options.companyZone(req.workspace_id as WorkspaceId),
    )
    const id = newTaskId()
    const record = officialRecord({
      id,
      title: str(input.title) ?? '',
      prompt: str(input.prompt) ?? '',
      selector,
      nowMs,
    })
    const limited = overLimit(req, record, true)
    if (limited !== undefined) return limited
    const effect = isRecurring(record) ? effectOf(`${record.title}\n${record.prompt}`) : 'read_only'
    const needsCard = effect !== 'read_only'
    const who = { person_id: req.actor.person_id, role_id: req.actor.role_id }
    const approval = needsCard ? await card(req.workspace_id, id, record, who, req.id) : undefined
    const task = await scheduler.schedule({
      id,
      workspace_id: req.workspace_id as WorkspaceId,
      owner: req.actor.person_id,
      role_id: req.actor.role_id,
      assignment_id: req.actor.assignment_id,
      title: record.title,
      trigger: triggerOf(record),
      // 等批的先停着（我们调度器里 `pending` 也会到点跑，所以用 `paused`；批了 `resume`）
      state: needsCard ? 'paused' : 'active',
      created_by: 'agent',
      // 官方：关机错过的周期提醒只补最近那一次
      misfire_policy: 'run_once_now',
      handler: AUTOMATION_HANDLER,
      params: {
        official: record,
        effect,
        ...(needsCard ? { awaiting_approval: true } : {}),
      },
      origin: { conversation_id: req.work_item?.id ?? '' },
      ...(approval === undefined ? {} : { approval }),
    })
    emit(req.workspace_id, 'automation.requested', actorOf(req), {
      tool: 'schedule_create',
      run_id: req.id,
      task_id: task.id,
      kind: record.kind,
      outcome: needsCard ? 'awaiting_approval' : 'created',
      ...(approval === undefined ? {} : { approval_item_id: approval }),
    })
    return { status: 'ok', data: viewOf(task) }
  }

  function list(req: RunRequest): ToolExecution {
    const tasks = mine(req).filter(
      (t) => t.state === 'active' || t.state === 'running' || t.state === 'paused',
    )
    emit(req.workspace_id, 'automation.requested', actorOf(req), {
      tool: 'schedule_list',
      run_id: req.id,
      outcome: 'listed',
      count: tasks.length,
    })
    return { status: 'ok', data: tasks.map(viewOf) }
  }

  async function remove(req: RunRequest, input: Record<string, unknown>): Promise<ToolExecution> {
    const id = str(input.id) ?? ''
    if (id === '' || id.trim() !== id) {
      return failure(
        'invalid_rule',
        'schedule_delete id must be non-empty without surrounding whitespace.',
      )
    }
    const task = mine(req).find((t) => t.id === id && t.state !== 'cancelled')
    if (task === undefined) {
      emit(req.workspace_id, 'automation.requested', actorOf(req), {
        tool: 'schedule_delete',
        run_id: req.id,
        task_id: id,
        outcome: 'rejected',
        code: 'schedule_not_found',
      })
      return { status: 'ok', data: { id, deleted: false, code: 'schedule_not_found' } }
    }
    await scheduler.cancel(id)
    emit(req.workspace_id, 'automation.requested', actorOf(req), {
      tool: 'schedule_delete',
      run_id: req.id,
      task_id: id,
      outcome: 'deleted',
    })
    return { status: 'ok', data: { id, deleted: true } }
  }

  const UPDATE_KEYS = new Set([
    'id',
    'title',
    'prompt',
    'at',
    'every_seconds',
    'daily',
    'weekly',
    'cron',
  ])

  async function update(req: RunRequest, input: Record<string, unknown>): Promise<ToolExecution> {
    const id = str(input.id) ?? ''
    const selector = selectorOf(input)
    if (Object.keys(input).some((k) => !UPDATE_KEYS.has(k)) || selectorCount(selector) > 1) {
      return failure(
        'invalid_selector',
        'schedule_update accepts at most one of at, every_seconds, daily, weekly, or cron.',
      )
    }
    if (id === '' || id.trim() !== id) {
      return failure(
        'invalid_rule',
        'schedule_update id must be non-empty without surrounding whitespace.',
      )
    }
    const title = str(input.title)
    const prompt = str(input.prompt)
    if (selectorCount(selector) === 0 && title === undefined && prompt === undefined) {
      return failure(
        'invalid_selector',
        'schedule_update needs a new title, prompt, or one of at, every_seconds, daily, weekly, or cron.',
      )
    }
    if (title !== undefined && (title.trim() === '' || title.trim().length > MAX_TITLE_LENGTH)) {
      return failure(
        'invalid_prompt',
        `title must be non-empty and at most ${MAX_TITLE_LENGTH} characters.`,
      )
    }
    if (prompt !== undefined && prompt.trim() === '') {
      return failure('invalid_prompt', 'prompt must be non-empty after trimming.')
    }
    const task = mine(req).find((t) => t.id === id)
    if (task === undefined)
      return { status: 'ok', data: { id, updated: false, code: 'schedule_not_found' } }
    if (!LIVE.includes(task.state)) {
      return { status: 'ok', data: { id, updated: false, code: 'schedule_ended' } }
    }
    const old = officialOf(task) as OfficialScheduleRecord
    const nextTitle = title?.trim() ?? task.title ?? old.title
    const nextPrompt = prompt ?? old.prompt
    const retimed = selectorCount(selector) === 1
    const record: OfficialScheduleRecord = retimed
      ? officialRecord({
          id,
          title: nextTitle,
          prompt: nextPrompt,
          selector: withZone(selector, await options.companyZone(req.workspace_id as WorkspaceId)),
          nowMs: Date.parse(clock.now()),
        })
      : ({ ...old, title: nextTitle, prompt: nextPrompt } as OfficialScheduleRecord)
    const limited = overLimit(req, record, false)
    if (limited !== undefined) return limited
    const effect = isRecurring(record) ? effectOf(`${record.title}\n${record.prompt}`) : 'read_only'
    const unchanged = nextPrompt === old.prompt && nextTitle === old.title
    // 批过的、或已经在等批的，内容没变就不再出卡；内容变了出一张新的（旧卡批了也不算数，见 `wrap`）
    const settled = task.params?.approved === true || task.params?.awaiting_approval === true
    const needsCard = effect !== 'read_only' && !(settled && unchanged)
    const approval = needsCard
      ? await card(
          task.workspace_id,
          id,
          record,
          { person_id: task.owner, role_id: task.role_id },
          req.id,
        )
      : undefined
    await scheduler.update(id, {
      ...(retimed ? { trigger: triggerOf(record) } : {}),
      title: record.title,
      params: {
        ...task.params,
        official: record,
        effect,
        ...(needsCard ? { awaiting_approval: true, approved: false } : {}),
      },
    })
    if (needsCard && task.state !== 'paused') await scheduler.pause(id)
    emit(req.workspace_id, 'automation.requested', actorOf(req), {
      tool: 'schedule_update',
      run_id: req.id,
      task_id: id,
      outcome: needsCard ? 'awaiting_approval' : 'updated',
      ...(approval === undefined ? {} : { approval_item_id: approval }),
    })
    return { status: 'ok', data: viewOf(scheduler.get(id) ?? task) }
  }

  const executeTool: ToolExecutor = async (call) => {
    const name = bare(call.name)
    if (!isScheduleTool(name)) {
      return { status: 'error', reason: `unsupported_tool：这个进程没接「${call.name}」。` }
    }
    if (!(await enabled())) {
      return { status: 'blocked', reason: '自动化任务这会儿关着' }
    }
    const req = call.request
    if (req.work_item?.id === undefined) {
      return { status: 'blocked', reason: '提醒要挂在一件事上，这次运行没有事项' }
    }
    try {
      if (name === 'schedule_create') return await create(req, call.input)
      if (name === 'schedule_list') return list(req)
      if (name === 'schedule_delete') return await remove(req, call.input)
      return await update(req, call.input)
    } catch (e) {
      const code = e instanceof OfficialScheduleError ? e.code : 'internal_error'
      const message =
        e instanceof OfficialScheduleError ? e.message : 'The schedule operation failed.'
      emit(req.workspace_id, 'automation.requested', actorOf(req), {
        tool: name,
        run_id: req.id,
        outcome: 'rejected',
        code,
      })
      return failure(code, message)
    }
  }

  /** 公司时区的自然日（`YYYY-MM-DD`）：每天的次数按它切。 */
  const dayOf = async (workspace_id: WorkspaceId, at: string): Promise<string> =>
    localDay(at, await options.companyZone(workspace_id))

  function register(): void {
    scheduler.register(AUTOMATION_HANDLER, async (ctx) => {
      const task = ctx.task
      const record = officialOf(task)
      if (record === undefined) throw new Error('这条定时没有官方规则记录，跑不了')
      // 关着：任务留着、到点不跑（官方：关掉之后存着的任务还在盘上）；跳过码沿用 WP181 的 `plugin_off`
      if (!(await enabled())) return { skipped: 'plugin_off' }
      const day = await dayOf(task.workspace_id, ctx.at)
      const count = fires.count(task.assignment_id, day)
      if (count >= limits.fires_per_day) {
        emit(
          task.workspace_id,
          'automation.capped',
          { kind: 'system', id: 'automation' },
          { task_id: task.id, limit: limits.fires_per_day, count, day },
        )
        return { skipped: 'daily_cap' }
      }
      const brand = await options.runner?.(task.workspace_id)
      const work = brand?.work
      const startRun = brand?.startRun
      const matter_id = task.origin?.conversation_id
      const matter: Matter | undefined =
        matter_id === undefined || matter_id === '' ? undefined : work?.getMatter(matter_id)
      if (work === undefined || startRun === undefined || matter === undefined) {
        throw new Error('原来那件事找不到了（或者这个进程不跑运行），这一次没跑')
      }
      fires.bump(task.assignment_id, day)
      const title = task.title ?? record.title
      work.appendEvent(matter.id, {
        kind: 'status',
        text: `到点了：${title}`,
        actor: { kind: 'system', id: 'automation' },
      })
      const { run_id } = await startRun({
        matter,
        // 官方的外框：这是提醒内容，不是新指令（防注入）
        brief: reminderBrief({ ...record, title }, ctx.at),
        actor: { person_id: task.owner, assignment_id: task.assignment_id },
      })
      work.appendEvent(matter.id, {
        kind: 'run',
        text: `到点接着这件事跑了一次（${title}）`,
        actor: { kind: 'agent', id: task.assignment_id },
        run_id,
      })
      return { run_id }
    })
  }

  function wrap<
    B extends { decide(id: string, by: never, input: DecideInput): Promise<ApprovalItem> },
  >(bus: B): B {
    return new Proxy(bus, {
      get(target, prop, receiver) {
        if (prop !== 'decide') {
          const value = Reflect.get(target, prop, receiver)
          return typeof value === 'function' ? value.bind(target) : value
        }
        return async (id: string, by: never, input: DecideInput): Promise<ApprovalItem> => {
          const out = await target.decide(id, by, input)
          if (out.kind !== 'scheduled_task') return out
          // 老路（`POST /v1/schedules` 给别人岗位建的）：按任务上记的卡 id 激活 / 取消
          await settleScheduleApproval(scheduler, out)
          const payload = (out.payload ?? {}) as {
            task_id?: unknown
            prompt?: unknown
            title?: unknown
          }
          const task =
            typeof payload.task_id === 'string' ? scheduler.get(payload.task_id) : undefined
          const record = task === undefined ? undefined : officialOf(task)
          if (task === undefined || record === undefined || task.state === 'cancelled') return out
          // 卡发出去之后内容又改过：这张旧卡批了不算数（等新的那张）
          if (payload.prompt !== record.prompt || payload.title !== record.title) return out
          if (out.state === 'approved' || out.state === 'approved_edited') {
            await scheduler.update(task.id, {
              params: { ...task.params, awaiting_approval: false, approved: true },
            })
            if (task.state === 'paused') await scheduler.resume(task.id)
          } else if (
            out.state === 'rejected' ||
            out.state === 'withdrawn' ||
            out.state === 'expired'
          ) {
            await scheduler.cancel(task.id)
          }
          return out
        }
      },
    })
  }

  async function retime(task: ScheduleTask, selector: OfficialSelector): Promise<ScheduleTask> {
    const old = officialOf(task)
    if (old === undefined) {
      throw new OfficialScheduleError(
        'invalid_rule',
        '这条定时不是按官方规则建的，改不了成「每天 / 每周几点」',
      )
    }
    const record = officialRecord({
      id: task.id,
      title: task.title ?? old.title,
      prompt: old.prompt,
      selector: withZone(selector, await options.companyZone(task.workspace_id)),
      nowMs: Date.parse(clock.now()),
    })
    const gap = shortestGapSeconds(record)
    if (gap !== undefined && gap < limits.min_gap_seconds) {
      throw new OfficialScheduleError(
        'frequency_too_high',
        `周期任务两次之间至少隔 ${limits.min_gap_seconds / 60} 分钟`,
      )
    }
    return scheduler.update(task.id, {
      trigger: triggerOf(record),
      params: { ...task.params, official: record },
    })
  }

  return { executeTool, enabled, register, wrap, retime }
}
