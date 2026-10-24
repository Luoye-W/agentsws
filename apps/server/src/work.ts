/**
 * 37 工作模型端口的服务端实现。
 *
 * 这一层只做装配：`@agentsws/work` 出逻辑，审批总线出卡片，数据源出订单行，
 * 目标指标按 29 的命名查询名在服务端算（数字不经模型手）。
 *
 * 一条边界：**委托与在事项里说话都要起 Run**，运行时由调用方注入（`startRun`）；
 * 没注入时这两条路回 `not_implemented`，其余照常——工作台仍然能记事项、待办、目标。
 */
import {
  ApiError,
  type WorkActor,
  type WorkHome,
  type WorkPoolItem,
  type WorkPort,
} from '@agentsws/api'
import type {
  ApprovalItem,
  AssignmentId,
  CalendarItem,
  CalendarSource,
  ClaimPayload,
  Clock,
  GenuiSetupInput,
  GenuiSetupOutcome,
  GenuiToolInput,
  GenuiToolOutcome,
  Goal,
  GoalProgress,
  Iso8601,
  MatterAttachment,
  MatterEvent,
  MatterLiveRun,
  PersonId,
  ReasoningEffort,
  StartRun,
  Todo,
  WorkStore,
} from '@agentsws/contracts'
import type { OrderRow } from '@agentsws/deck'
import {
  battleReport,
  buildReview,
  type CalendarSources,
  type CardOutcome,
  cardRefOf,
  claimOf,
  createWork,
  DAY_MS,
  type DeliverableLike,
  ms,
  type PoolItem,
  planSummary,
  planTitle,
  poolItemOf,
  proposeSlots,
  type QueryRunner,
  type ReviewDuplicate,
  reviewSummary,
  reviewTitle,
  type ScheduledTaskLike,
  type SocialPostLike,
  type StandbyRenewalLike,
  type Work,
} from '@agentsws/work'
import { type AdsExportIntake, withIntakeNote } from './ads-data/export-intake.js'
import {
  attachedLine,
  attachmentsBrief,
  contextAttachment,
  readAssistantFile,
} from './assistant-files.js'
import { offsetToTz, reviewWindow } from './schedule.js'
import { createWorkHoursStore, type WorkHoursStore } from './work-hours.js'

/** 队列上还等着人的状态。 */
const WAITING_STATES = new Set(['pending', 'in_review'])

/**
 * 撞车候选里的 `owner` 是 person_id；界面上不该出现裸 id，所以在这里补一份展示名
 * （29 enrichment：服务端补，前端不猜）。翻译不出来就回落成 id 本身。
 */
function labelCandidates(err: unknown, label: (id: PersonId) => string): unknown {
  if (err === null || typeof err !== 'object') return err
  const rec = err as { details?: { reason?: string; candidates?: { owner: PersonId }[] } }
  const candidates = rec.details?.candidates
  if (rec.details?.reason !== 'similar_in_progress' || candidates === undefined) return err
  rec.details.candidates = candidates.map((c) => ({ ...c, owner_label: label(c.owner) }))
  return err
}

/** `PoolItem` → 网关的 `WorkPoolItem`（同形；显式抄一遍，别让内部形状漏出去）。 */
function poolItemView(item: PoolItem): WorkPoolItem {
  return {
    todo_id: item.todo_id,
    title: item.title,
    source: item.source,
    pooled_at: item.pooled_at,
    recycled: item.recycled,
    similar_to: item.similar_to,
    ...(item.note === undefined ? {} : { note: item.note }),
    ...(item.position_id === undefined ? {} : { position_id: item.position_id }),
    ...(item.matter_id === undefined ? {} : { matter_id: item.matter_id }),
    ...(item.due === undefined ? {} : { due: item.due }),
  }
}

export interface WorkPortOptions {
  /**
   * WP447：事项里附上的文件有广告平台导出的报表就直接入库（`ads-data/export-intake.ts`），
   * 每份回一句写在附件文字前面。不给 = 附件只读成文字（老口径）。
   */
  fileIntake?: AdsExportIntake
  /**
   * WP417（自查客服 D8）：社媒运营转过来的「转客服卡」（`form: 'support_handoff'`）点了「接」→
   * 在社群管理那条职责下开一件事（钉着那条线程）、起运行，起草回帖。以前点了只改卡状态，什么都不发生。
   */
  acceptHandoff?(actor: WorkActor, item: ApprovalItem): Promise<void>
  /**
   * WP417（自查 F11 / F12）：替我答那几张卡（`meet` 约时间、`secretary_answer` 先给本人看）点了之后真生效
   * ——以前「约时间」卡批了会议不建、状态不变。
   */
  acceptSecretary?(actor: WorkActor, item: ApprovalItem): Promise<void>
  /**
   * WP342（决策 853）：这个模型 id（`provider_id/model`）现在能不能选（= 在「设置 → 模型」已接的里面）。
   * 不给 = 不判（单测里的老装配）。认不出的：开事项时不记、换模型时拒。
   */
  knownModel?: (id: string) => boolean | Promise<boolean>
  /**
   * WP370：这个模型有没有这一档思考程度（= AI 钮里给它列了这一档）。不给 = 不判。
   * 没有的：开事项时不记、换的时候拒。
   */
  knownEffort?: (id: string, effort: ReasoningEffort) => boolean | Promise<boolean>
  clock: Clock
  work: Work
  /** 本人可见的审批项（已按 recipient 过滤）——卡片到期叠层与战报四格都从它数 */
  approvals(actor: WorkActor): Promise<ApprovalItem[]> | ApprovalItem[]
  /**
   * WP237：在事项里说话时先问一句岗位面——从岗位开的事项要用**那条职责**的分配接着做
   * （还没定职责时先定）。回 `undefined` = 不归它管，走老路（请求头上那条分配）。
   */
  sayAt?(
    actor: WorkActor,
    matter_id: string,
    text: string,
    /** WP357：这句话附上的资料（已读成文字）与交给运行的那段话（话 + 附件围起来）。 */
    attached?: { attachments: MatterAttachment[]; brief: string },
  ): Promise<{ event: MatterEvent; run_id?: string } | undefined>
  /** WP264：这件事上正在跑的那一次（事项页「正在做…」）；不给 = 不显示。 */
  liveRun?(matter_id: string): MatterLiveRun | undefined
  /** WP287：这个人是不是还持有这条分配（重试时优先用事项钉的那条）。不给 = 一律用请求头那条。 */
  holds?(person_id: PersonId, assignment_id: AssignmentId): boolean
  /** WP264：停下这件事上正在跑的运行（回停了几次）；不给 = 停不了。 */
  stopRuns?(matter_id: string, reason: string): Promise<number>
  /** WP341：对话里点了「调工具」的 genui 按钮（运行时的工具执行器）；不给 = 不接。 */
  genuiTool?(actor: WorkActor, matter_id: string, input: GenuiToolInput): Promise<GenuiToolOutcome>
  /** WP348：对话里点了 `setup:目标` 的 genui 按钮（就地出方案卡）；不给 = 不接。 */
  genuiSetup?(
    actor: WorkActor,
    matter_id: string,
    input: GenuiSetupInput,
  ): Promise<GenuiSetupOutcome>
  /** 店铺侧订单行；目标指标从它算 */
  orders(): OrderRow[]
  /** ObjectRef → 人话 */
  label(ref: { type: string; id: string }): string | undefined
  /** 25 的定时任务；不给就是没有 */
  scheduledTasks?(actor: WorkActor): ScheduledTaskLike[]
  /**
   * WP74 的三条新图层（37 §2.5）。三条都是 `?`：不给就是这个部署没有那一摊东西，
   * 日历少一层而已，别的照常。
   *
   * 品牌隔离由**调用方**负责：这三个回调是在 `workPortFor(ws)` 里按品牌闭包起来的，
   * 所以这一层拿到的永远只是这个品牌自己那一份（社媒帖子尤其——56 §2 一个号只属于一个品牌）。
   */
  socialPosts?(actor: WorkActor): SocialPostLike[]
  kolDeliverables?(actor: WorkActor): DeliverableLike[]
  /** 值守续期日；一个工作区最多一条，没开通值守就是空 */
  standbyRenewals?(actor: WorkActor): StandbyRenewalLike[]
  /** WP23 的会议；不给就是没有（会议上日历，37 §2 表第三行） */
  meetings?(
    actor: WorkActor,
    range: { from: Iso8601; to: Iso8601 },
  ): Promise<CalendarItem[]> | CalendarItem[]
  /**
   * WP69（54 §2）：`X-Assignment` → 它是哪条职责。
   * 不给就是"记不下职责入口的 role_id"——事项照常能开（存量事项本来就没有这个字段）。
   */
  roleOf?(assignment_id: AssignmentId): string | undefined
  /** 24 的 lesson，进复盘的「Agent 学到的」 */
  lessons?(actor: WorkActor): { id: string; text: string }[]
  /**
   * 40 §2.2 第 4 条：复盘里那一段"疑似重复"。
   * 日复盘不报（同一对东西天天提醒一次就是噪音），周 / 月才报。
   */
  duplicates?(kind: 'week' | 'month'): Promise<ReviewDuplicate[]> | ReviewDuplicate[]
  /** WP388：周复盘取数用的时区（品牌目标市场的）；不给 = 工作区时区。 */
  reportTz?(): string
  /** WP474（决策 1530）：「我的作息」存哪；不给 = 内存档（单测、没有数据目录的装配）。 */
  workHours?: WorkHoursStore
}

/**
 * 目标指标：**按目标自己的期间**跑 29 的命名查询。
 *
 * `@agentsws/deck` 的 `runQuery` 只认「昨天 / 近 7 天」两个窗口（36 §3 的数字块就那两档），
 * 而目标是周 / 月 / 季，所以窗口在这里自己切，行的语义与 deck 逐条对齐（同一批 `OrderRow`）。
 * 不认识的查询名回 `undefined` → 进度显示 `no_data`，而不是编一个数。
 */
export function periodQueryRunner(
  orders: () => OrderRow[],
  approvals: () => ApprovalItem[],
  base_currency: string,
): QueryRunner {
  return (goal: Goal) => {
    const from = ms(goal.period.start)
    const to = ms(goal.period.end)
    const inWindow = (at: Iso8601): boolean => {
      const t = ms(at)
      return t >= from && t < to
    }
    const rows = orders().filter((o) => inWindow(o.created_at))
    switch (goal.metric.query) {
      case 'sales.total':
        return {
          value: round2(rows.reduce((s, o) => s + o.total_price - o.refunded_amount, 0)),
          currency: base_currency,
        }
      case 'orders.count':
        return { value: rows.length }
      case 'refunds.total':
        return {
          value: round2(rows.reduce((s, o) => s + o.refunded_amount, 0)),
          currency: base_currency,
        }
      case 'approvals.pending_replies':
        return {
          value: approvals().filter((i) => WAITING_STATES.has(i.state) && inWindow(i.created_at))
            .length,
        }
      default:
        return undefined
    }
  }
}

function round2(v: number): number {
  return Math.round(v * 100) / 100
}

function outcomeOf(item: ApprovalItem): CardOutcome {
  const by = item.decision?.by
  return {
    id: item.id,
    kind: item.kind,
    state: item.state,
    auto_approved: item.automation.auto_approved || item.state === 'auto_approved',
    decided_by_person: by !== undefined && by !== 'mandate',
    applied: item.state === 'applied',
    blocked: item.state === 'blocked',
  }
}

export function createWorkPort(options: WorkPortOptions): WorkPort {
  const hours = options.workHours ?? createWorkHoursStore()
  const work = options.work

  const cardsOf = async (actor: WorkActor): Promise<ApprovalItem[]> => options.approvals(actor)

  const waitingCount = (items: readonly ApprovalItem[]): number =>
    items.filter((i) => WAITING_STATES.has(i.state)).length

  /**
   * 装配日历的各路来源。
   *
   * `wanted` 是这一次要的图层（WP74；不给 = 全部）。**关掉的层就不去取**——
   * 社媒那一层每条都要算一次撞车（`social-core` 的 `scheduleConflicts`），
   * 职责页上只开社媒的那一屏没有理由顺带把红人交付物也捞一遍。
   * 过滤本身仍然在 `buildCalendar` 的最后一步做，这里只是省掉白取的那几次。
   */
  const sourcesFor = async (
    actor: WorkActor,
    range: { from: Iso8601; to: Iso8601 },
    cards: readonly ApprovalItem[],
    wanted?: readonly CalendarSource[],
  ): Promise<CalendarSources> => {
    const want = (s: CalendarSource): boolean => wanted === undefined || wanted.includes(s)
    return {
      cards: want('card_due') ? cards.filter((i) => WAITING_STATES.has(i.state)) : [],
      ...(options.scheduledTasks === undefined || !want('scheduled_task')
        ? {}
        : { tasks: options.scheduledTasks(actor) }),
      ...(options.meetings === undefined || !want('meeting')
        ? {}
        : { meetings: await options.meetings(actor, range) }),
      ...(options.socialPosts === undefined || !want('social_post')
        ? {}
        : { social_posts: options.socialPosts(actor) }),
      ...(options.kolDeliverables === undefined || !want('kol_deliverable')
        ? {}
        : { deliverables: options.kolDeliverables(actor) }),
      ...(options.standbyRenewals === undefined || !want('standby')
        ? {}
        : { standby: options.standbyRenewals(actor) }),
    }
  }

  const runnerFor = (cards: readonly ApprovalItem[]): QueryRunner =>
    periodQueryRunner(options.orders, () => [...cards], 'USD')

  const progressFor = async (
    actor: WorkActor,
    filter: { level?: Goal['level']; position_id?: string } = {},
  ): Promise<GoalProgress[]> => {
    const cards = await cardsOf(actor)
    return work.progress(runnerFor(cards), { ...filter, status: ['active'] })
  }

  const todayDue = (person_id: PersonId): Todo[] =>
    work.listTodos({ owner: person_id, horizon: ['today'], status: ['open', 'doing', 'blocked'] })

  /**
   * WP248（决策 79，Luoye 10-07）：首页「今天的待办」把**已过期没做完的**也算进来，并单独点出是哪几条。
   *
   * `horizon` 是写入那一刻推出来的（过期的当时算今天），之后不会自己变——上周写的「本周」待办
   * 今天过了期，`horizon` 还是 `week`。所以过期的这几条按截止现算（与岗位页同一个口径：
   * 截止 = `due`，没有就看 `scheduled.start`；早于工作区时区的今天零点 = 已过期），排在最前。
   */
  const homeDue = (person_id: PersonId): { todos: Todo[]; overdue_ids: string[] } => {
    const dayStart = ms(work.todayRange().from)
    const dueOf = (t: Todo): string | undefined => t.due ?? t.scheduled?.start
    const late = (t: Todo): boolean => {
      const at = dueOf(t)
      return at !== undefined && ms(at) < dayStart
    }
    const today = todayDue(person_id)
    const seen = new Set(today.map((t) => t.id))
    const extra = work
      .listTodos({ owner: person_id, status: ['open', 'doing', 'blocked'] })
      .filter((t) => !seen.has(t.id) && late(t))
    const todos = [...extra, ...today].sort(
      (a, b) => Number(late(b)) - Number(late(a)) || (dueOf(a) ?? '').localeCompare(dueOf(b) ?? ''),
    )
    return { todos, overdue_ids: todos.filter(late).map((t) => t.id) }
  }

  return {
    async home(actor): Promise<WorkHome> {
      const cards = await cardsOf(actor)
      const range = work.todayRange()
      const review = work.latestReview(actor.person_id, 'day')
      const dayStart = ms(range.from)
      const plan = work.store.findPlan(work.workspace_id, actor.person_id, work.todayDate())
      return {
        goals: await progressFor(actor),
        // 白天的四格战报：今天动过的卡
        report: battleReport(cards.filter((i) => ms(i.updated_at) >= dayStart).map(outcomeOf)),
        today: {
          timeline: work.calendar(
            range,
            { person_id: actor.person_id },
            await sourcesFor(actor, range, cards),
          ),
          due: { ...homeDue(actor.person_id), cards_waiting: waitingCount(cards) },
        },
        ...(review === undefined ? {} : { review }),
        ...(plan === undefined ? {} : { plan }),
      }
    },

    /**
     * WP207：**归档的事移出默认列表**（`archived` 不给 = exclude）；要看归档的带 `only` / `all`。
     * 老数据里一件归档的都没有，所以老调用方看到的一条不少。
     */
    matters: (_actor, { archived, ...filter }) =>
      work.listMatters({
        ...filter,
        ...(archived === 'all' ? {} : { archived: archived === 'only' }),
      }),
    matter: (_actor, id) => {
      const view = work.matterView(id, { label: (ref) => options.label(ref) })
      const live = options.liveRun?.(id)
      return {
        ...view,
        ...(live === undefined ? {} : { live }),
        // 40 §3.3：事项页显示参与者（展示名由服务端补，翻译不出来回落成 id）
        participant_labels: view.matter.context.participants.map((person_id) => ({
          person_id,
          label: options.label({ type: 'person', id: person_id }) ?? person_id,
        })),
      }
    },
    /**
     * WP69（54 §2）**职责入口**：这条口子一个签名没改，但现在会记下"从哪儿开的"。
     *
     * `entry: 'role'` 与 `role_id` 都是从 `X-Assignment` 反查出来的——用户带着哪条
     * 分配来，就是指定用那条职责的规矩做。所以它跳过岗位内路由（岗位入口才路由）。
     * 反查不到职责（分配已撤销）时两个字段都不写：存量事项长什么样，它就长什么样。
     */
    createMatter: async (actor, { model, model_effort, ...input }) => {
      const role_id = options.roleOf?.(actor.assignment_id)
      // WP342：输入框左下角选的 AI；认不出 / 现在不能用的不记（跟品牌默认走）
      const chosen =
        model !== undefined &&
        (options.knownModel === undefined || (await options.knownModel(model)))
          ? model
          : undefined
      // WP370：思考程度只在这个模型真有这一档时记
      const effort =
        chosen !== undefined &&
        model_effort !== undefined &&
        (options.knownEffort === undefined || (await options.knownEffort(chosen, model_effort)))
          ? model_effort
          : undefined
      return work.createMatter({
        ...input,
        ...(chosen === undefined ? {} : { model: chosen }),
        ...(effort === undefined ? {} : { model_effort: effort }),
        position_id: actor.assignment_id,
        participants: [actor.person_id],
        entry: 'role',
        ...(role_id === undefined ? {} : { role_id }),
      })
    },
    closeMatter: (actor, id, unfinished) =>
      work.closeMatter(id, { unfinished, by: actor.person_id }),
    timeline: (_actor, id, opts) => {
      const events = work.store.listMatterEvents(id, opts)
      return { events, has_more: work.store.countMatterEvents(id) > events.length }
    },
    say: async (actor, id, text, files, context) => {
      // WP357：附上的资料与助理同一套读法（抹口令、截断、读不出照实说），运行拿到「话 + 附件」
      // WP447：拖进来的是投放平台的报表就先入库，那一句写在附件文字前面
      const m0 = work.getMatter(id)
      const intake =
        files === undefined || options.fileIntake === undefined
          ? []
          : options.fileIntake(files, {
              person_id: actor.person_id,
              ...(m0?.role_id === undefined ? {} : { role_id: m0.role_id }),
              ...(m0?.position_template_id === undefined
                ? {}
                : { position_template_id: m0.position_template_id }),
            })
      const attachments = [
        // WP504：第三栏「问 AI」引用的卡（结构化摘要）排在附件前面
        ...(context ?? []).map(contextAttachment),
        ...(files ?? []).map((f, i) => withIntakeNote(readAssistantFile(f), intake[i])),
      ]
      const attached =
        attachments.length === 0
          ? undefined
          : { attachments, brief: attachmentsBrief(text, attachments) }
      const said = text.trim() === '' && attached !== undefined ? attachedLine(attachments) : text
      const routed = await options.sayAt?.(actor, id, said, attached)
      if (routed !== undefined) return routed
      /*
       * WP276（docs/95 §4.3 第 4a 步）：交接过的事项，之后起的运行用**接手人**那条分配——
       * 发起人（现在是参与者）在里面说一句，话记他的名字，运行仍是接手人的职责规矩与用量。
       */
      const m = work.getMatter(id)
      const owner = m?.context.participants[0]
      const run_by =
        m?.handoff?.state === 'accepted' &&
        owner !== undefined &&
        owner !== actor.person_id &&
        m.position_id !== undefined
          ? { person_id: owner, assignment_id: m.position_id }
          : undefined
      return work.say(id, {
        person_id: actor.person_id,
        assignment_id: actor.assignment_id,
        text: said,
        ...(run_by === undefined ? {} : { run_by }),
        ...(attached === undefined
          ? {}
          : { attachments: attached.attachments, brief: attached.brief }),
      })
    },
    // WP341：对话里点了「调工具」的按钮（只认这件事上的；别人的事项点不了）
    ...(options.genuiTool === undefined
      ? {}
      : {
          genuiTool: (actor: WorkActor, id: string, input: GenuiToolInput) => {
            const m = work.requireMatter(id)
            if (!m.context.participants.includes(actor.person_id))
              throw new ApiError('forbidden', '这件事不是你的，点不了')
            return options.genuiTool?.(actor, id, input) as Promise<GenuiToolOutcome>
          },
        }),
    // WP348：对话里点了 `setup:目标` 的按钮（只认这件事上的；别人的事项点不了）
    ...(options.genuiSetup === undefined
      ? {}
      : {
          genuiSetup: (actor: WorkActor, id: string, input: GenuiSetupInput) => {
            const m = work.requireMatter(id)
            if (!m.context.participants.includes(actor.person_id))
              throw new ApiError('forbidden', '这件事不是你的，点不了')
            return options.genuiSetup?.(actor, id, input) as Promise<GenuiSetupOutcome>
          },
        }),
    // WP264（决策 177）：人改的标题之后不再被自动覆盖
    retitleMatter: (_actor, id, title) => work.retitle(id, title, 'user'),
    // WP342（决策 853）：换这件事用的 AI（只这一件；不动品牌默认）
    setMatterModel: async (_actor, id, model, effort) => {
      work.requireMatter(id)
      if (
        model !== undefined &&
        options.knownModel !== undefined &&
        !(await options.knownModel(model))
      )
        throw new ApiError('invalid_input', '这个 AI 现在用不了（没接上或已经删了），换一个再试')
      // WP370：这个模型没有这一档思考程度
      if (
        model !== undefined &&
        effort !== undefined &&
        options.knownEffort !== undefined &&
        !(await options.knownEffort(model, effort))
      )
        throw new ApiError('invalid_input', '这个 AI 不能调这一档思考程度，换一档再试')
      return work.setModel(id, model, effort)
    },
    /*
     * WP287：「没跑成」下面的「重试」——按最近那次没跑成之前人说的那句（没有就按事项第一句 / 标题）
     * 再跑一次。用事项钉的那条分配（本人持有时），否则请求头那条；时间线只记「重试了一次」。
     */
    retryMatter: async (actor, id) => {
      const m = work.requireMatter(id)
      const events = work.store.listMatterEvents(id, { limit: 500 })
      const lastFail = events.map((e) => e.failed !== undefined).lastIndexOf(true)
      const before = lastFail < 0 ? events : events.slice(0, lastFail)
      const said = before.filter((e) => e.kind === 'human_message')
      const brief = said[said.length - 1]?.text ?? m.title
      const own =
        m.position_id !== undefined && options.holds?.(actor.person_id, m.position_id) === true
          ? m.position_id
          : actor.assignment_id
      return work.run(id, {
        person_id: actor.person_id,
        assignment_id: own,
        brief,
        text: '重试了一次',
      })
    },
    stopMatter: async (_actor, id) => {
      work.requireMatter(id)
      const stopped = (await options.stopRuns?.(id, '你点了停，这一轮先停在这里')) ?? 0
      return { stopped }
    },

    async goals(actor, filter) {
      return {
        goals: work.listGoals(filter),
        progress: await progressFor(actor, filter),
      }
    },
    createGoal: (actor, input) => work.createGoal({ ...input, owner: actor.person_id }),

    todos: (actor, filter) =>
      work.listTodos({
        ...(filter.mine === false ? {} : { owner: actor.person_id }),
        ...(filter.horizon === undefined ? {} : { horizon: filter.horizon }),
        ...(filter.status === undefined ? {} : { status: filter.status }),
        ...(filter.matter_id === undefined ? {} : { matter_id: filter.matter_id }),
        ...(filter.goal_id === undefined ? {} : { goal_id: filter.goal_id }),
      }),
    /**
     * 40 §3.1「建之前先查」：撞上进行中的相似项就不建，抛 `conflict` 带候选
     * （网关映射成 409，`details.reason = 'similar_in_progress'`）。
     * 带上 `collision` 才放行：`join` 加进对方的事项、`handoff` 交给对方、`force` 要写一句区别。
     */
    createTodo: (actor, input) => {
      const { from_inbox, ...rest } = input
      /**
       * WP469（决策 1521）：收件箱那一行「记成待办」。同一行记过、还没做完的直接回那一条（不建第二条）；
       * 新建的记下是从哪一行来的（收件箱按它把那一行收起来），来自卡的也记 `card_id`、来源算 `card`。
       */
      if (from_inbox !== undefined) {
        const same = work
          .listTodos({ owner: actor.person_id, status: ['open', 'doing', 'blocked'] })
          .find((t) => t.origin?.inbox_item === from_inbox)
        if (same !== undefined) return same
      }
      const card_id = from_inbox?.startsWith('card:') === true ? from_inbox.slice(5) : undefined
      try {
        return work.createTodoChecked({
          ...rest,
          owner: actor.person_id,
          position_id: actor.assignment_id,
          ...(from_inbox === undefined
            ? {}
            : {
                origin: { inbox_item: from_inbox, ...(card_id === undefined ? {} : { card_id }) },
                ...(card_id === undefined ? {} : { source: 'card' as const }),
              }),
        }).todo
      } catch (err) {
        throw labelCandidates(err, (id) => options.label({ type: 'person', id }) ?? id)
      }
    },

    pool: (actor) => [
      ...work.poolView({ position_id: actor.assignment_id }).map(poolItemView),
      // 「交给你」的那几条也挂在这一区：它们同样是「等你点头才形成责任」
      ...work.offeredTo(actor.person_id).map((t) => {
        const c = claimOf(t)
        return {
          ...poolItemView(poolItemOf(t)),
          ...(c.offered_by === undefined
            ? {}
            : {
                offered_by: c.offered_by,
                // WP276：名字由服务端补（docs/95 §4.2 第 5 条）
                offered_by_label:
                  options.label({ type: 'person', id: c.offered_by }) ?? c.offered_by,
              }),
        }
      }),
    ],

    claimTodo: (actor, id) =>
      work.claimTodo(id, actor.person_id, { position_id: actor.assignment_id }),
    transferTodo: (actor, id, to) => work.transferTodo(id, { to, by: actor.person_id }),
    addCollaborator: (_actor, id, person_id) => work.addCollaborator(id, person_id),

    inProgress: (actor, scope) =>
      work
        .inProgress(scope === 'workspace' ? {} : { position_id: actor.assignment_id, scope })
        .map((i) => ({
          kind: i.kind,
          id: i.id,
          title: i.title,
          owner: i.owner,
          // 展示名由服务端补（29 enrichment）；数据源翻译不出来就回落成 id
          owner_label: options.label({ type: 'person', id: i.owner }) ?? i.owner,
          collaborators: i.collaborators,
          status: i.status,
          started_at: i.started_at,
          last_activity: i.last_activity,
          cards: i.cards,
          ...(i.position_id === undefined ? {} : { position_id: i.position_id }),
          ...(i.matter_id === undefined ? {} : { matter_id: i.matter_id }),
        })),
    updateTodo: (_actor, id, patch) => work.updateTodo(id, patch),
    scheduleTodo: (_actor, id, slot) => work.schedule(id, slot),
    delegateTodo: (actor, id, input) =>
      work.delegate(id, {
        assignment_id: input.assignment_id ?? actor.assignment_id,
        by: actor.person_id,
        ...(input.brief === undefined ? {} : { brief: input.brief }),
      }),
    splitTodo: (_actor, id, children) => work.splitTodo(id, children),

    async calendar(actor, range) {
      const cards = await cardsOf(actor)
      return work.calendar(
        range,
        { person_id: actor.person_id },
        await sourcesFor(actor, range, cards, range.sources),
      )
    },

    /**
     * WP469（决策 1522）：「帮我排进空档」。空档按这个人日历上已有的事算（会议、排了钟点的待办），
     * 不碰别人的日历；只给候选，什么都不写。
     */
    async proposeSlots(actor, input) {
      const cards = await cardsOf(actor)
      const range = { from: input.from, to: input.to }
      const items = work.calendar(
        range,
        { person_id: actor.person_id },
        await sourcesFor(actor, range, cards, ['meeting', 'todo']),
      )
      const todos = input.todo_ids
        .map((id) => work.getTodo(id))
        .filter((t): t is Todo => t !== undefined && t.owner === actor.person_id)
      return proposeSlots({
        todos,
        items,
        from: input.from,
        to: input.to,
        now: work.now(),
        tz_offset_minutes: input.tz_offset_minutes ?? work.tz_offset_minutes,
        // WP474（决策 1530）：按本人的作息找空档
        hours: hours.get(actor.person_id),
      })
    },
    workHours: (actor) => hours.get(actor.person_id),
    setWorkHours: (actor, input) => hours.set(actor.person_id, input),

    async todayPlan(actor, refresh) {
      const cards = await cardsOf(actor)
      const range = work.todayRange()
      const meetings = work
        .calendar(range, { person_id: actor.person_id }, await sourcesFor(actor, range, cards))
        .filter((i) => i.source === 'meeting')
      return work.todayPlan({
        person_id: actor.person_id,
        goals: await progressFor(actor),
        today_meetings: meetings,
        cards_waiting: waitingCount(cards),
        delegate_to: actor.assignment_id,
        refresh,
      })
    },
    decidePlan: async (actor, id, input) => {
      if (input.option === 'later') return { plan: work.deferPlan(id), todos: [] }
      return work.adoptPlan(id, {
        by: actor.person_id,
        ...(input.option === 'adjust' ? { selected_ids: input.selected_ids ?? [] } : {}),
      })
    },

    reviews: (actor, filter) => work.listReviews({ person_id: actor.person_id, ...filter }),
    async createReview(actor, kind) {
      const cards = await cardsOf(actor)
      const range = work.todayRange()
      // WP388：周复盘 = 上一周（目标市场时区；周四起是这一周），日 / 月照旧往回数
      const { start, end } = reviewWindow(
        kind,
        work.now(),
        range.to,
        options.reportTz?.() ?? offsetToTz(work.tz_offset_minutes),
      )
      const sources = await sourcesFor(actor, range, cards)
      const meetings = work
        .calendar(range, { person_id: actor.person_id }, sources)
        .filter((i) => i.source === 'meeting')
      const duplicates =
        kind === 'day' || options.duplicates === undefined ? [] : await options.duplicates(kind)
      const draft = buildReview({
        now: work.now(),
        person_id: actor.person_id,
        tz_offset_minutes: work.tz_offset_minutes,
        period: { kind, start, end },
        goals: await progressFor(actor),
        cards_events: cards
          .filter((i) => ms(i.updated_at) >= ms(start) && ms(i.updated_at) < ms(end))
          .map(outcomeOf),
        todos: todayDue(actor.person_id),
        meetings,
        ...(duplicates.length === 0 ? {} : { duplicates }),
        ...(options.lessons === undefined ? {} : { lessons: options.lessons(actor) }),
        tomorrow: {
          now: new Date(ms(work.now()) + DAY_MS).toISOString(),
          todos: work.inbox(actor.person_id),
          today_meetings: [],
          cards_waiting: waitingCount(cards),
          delegate_to: actor.assignment_id,
        },
      })
      return work.saveReview(draft)
    },

    /**
     * 37 §4.1：认领卡接下来 → 一条真待办。
     *
     * `source: 'meeting'`，`matter_id` 指向会议事项（`ClaimPayload.matter_id` 由会议侧回填），
     * `anchor` 指向事项时间线上那条产出——点待办标题就回到会议现场的那一处（37 §2.2b）。
     * **本人确认前不形成责任**（31 I13）：这一步只在本人按下"接"之后才发生。
     */
    async acceptClaim(actor, item) {
      const payload = item.payload as ClaimPayload | undefined
      const form = (payload as { form?: string } | undefined)?.form
      if (form === 'support_handoff') {
        await options.acceptHandoff?.(actor, item)
        return undefined
      }
      if (form === 'meet' || form === 'secretary_answer') {
        await options.acceptSecretary?.(actor, item)
        return undefined
      }
      if (payload?.form !== 'claim') return undefined
      const matter_id = payload.matter_id
      // 同一张卡按两次不重复建（认领卡的 dedupe_key 稳定，卡本身也只能决定一次）
      const existing = work
        .listTodos({ owner: actor.person_id, ...(matter_id === undefined ? {} : { matter_id }) })
        .find((t) => t.origin?.card_id === item.id)
      if (existing !== undefined) return existing
      /**
       * 40 §3.2「认领卡批准 = 认领」：会议侧已经把这条活放进待认领池了，
       * 批准这张卡就是从池里把它认下来——**第一个成功的是主人**，
       * 别人再点同一张卡会拿到 `conflict / already_claimed`。
       */
      const pooled = work.pool().find((t) => t.origin?.card_id === item.id)
      if (pooled !== undefined)
        return work.claimTodo(pooled.id, actor.person_id, { position_id: actor.assignment_id })
      const anchor =
        matter_id === undefined
          ? undefined
          : work.store
              .listMatterEvents(matter_id, { limit: 500 })
              .find((e) => e.text === payload.text)
      return work.createTodo({
        title: payload.text,
        owner: actor.person_id,
        source: 'meeting',
        position_id: actor.assignment_id,
        origin: { card_id: item.id },
        ...(matter_id === undefined ? {} : { matter_id }),
        ...(anchor === undefined ? {} : { anchor: { matter_event_id: anchor.id } }),
        ...(payload.due === undefined ? {} : { due: payload.due }),
      })
    },
  }
}

/** demo 与服务进程共用的装配：给了 store 就落盘，没给就是内存档。 */
export function createWorkModel(options: {
  workspace_id: string
  clock: Clock
  random?: () => number
  store?: WorkStore
  startRun?: StartRun
  tz_offset_minutes?: number
}): Work {
  return createWork(options)
}

export type { CardOutcome }
export { battleReport, cardRefOf, planSummary, planTitle, reviewSummary, reviewTitle }
