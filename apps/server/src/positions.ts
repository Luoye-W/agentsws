/**
 * WP69（54）：**岗位是任务主入口**——岗位实体、岗位内路由、从岗位开一件事。
 *
 * 用户面对的是岗位（客服、网站运营），不是职责。开一件事 = 交给一个岗位；岗位里的
 * Agent 自己判断该走哪条职责、用**那条职责的** Assignment 去做。
 *
 * 四条边界，每一条都能在下面指到具体的行：
 *
 * 1. **路由不是并集**（05 §4 / 31 §3.1）。路由挑出一条职责，然后起 Run 的时候用的是
 *    **那一条**的 Assignment——权限、额度、动作面、技能全是那一条的。岗位本身没有
 *    任何权限；`PositionInstance` 上一个 scope 字段都没有。
 * 2. **岗位实体是算出来的**（05 §2 不变）。`holders` / `roles` 每次现算，没有第二份真源，
 *    也没有任何写口会往"岗位"上落东西。
 * 3. **拿不准就问一句**（54 §2）。判据在 `@agentsws/roles` 的 `routeWithinPosition`；
 *    前两名太接近或谁都不太像时不猜，出一张选择卡（`claim` 类，四段式），选了再起 Run。
 * 4. **只在自己名下的职责里路由**。参赛的是**请求人自己持有的**那几条分配——
 *    路由不会把活派到他没有的职责上，那等于借岗位扩权。
 */
import type {
  AnswerComponent,
  ApprovalBus,
  ApprovalItem,
  AssignmentId,
  Clock,
  EventEnvelope,
  Matter,
  MatterEvent,
  MatterId,
  PersonId,
  Position,
  PositionInstance,
  PositionWorkView,
  RoleId,
  WorkspaceId,
} from '@agentsws/contracts'
import { isTaskBrief, splitAnswer, taskTextOf } from '@agentsws/contracts'
import { isQueueCard, isRouteChoiceItem } from '@agentsws/deck'
import {
  bundledPositionIcon,
  classifyEntryKind,
  type EntryClassifyComplete,
  type EntryKind,
  type EntryKindResult,
  looksLikeSmallTalk,
  namedRole,
  RoleError,
  type RoleStore,
  type RouteCandidate,
  type RouteRoleProfile,
  roleRouteTerms,
  routeWithinPosition,
  type SettledRouteResult,
  settleAlways,
  settleCloseCall,
  settleNoHit,
} from '@agentsws/roles'
import type { Work } from '@agentsws/work'
import { belongsTo, holdersByPlacement, WORKSPACE_BASE_ROLES } from './position-placements.js'
import {
  buildPositionWork,
  clip,
  matterRunStateOf,
  type WorkPostLike,
  type WorkScheduleLike,
} from './position-work.js'

/**
 * 工作区的底座职责。每个岗位模板都带着它（`org.ts` 的 `SEED_POSITIONS`），
 * 但它说的是"这个人是这个工作区的成员"，不是岗位的一条职责——
 * 岗位视图里的职责清单与计数都把它滤掉（见 `dutyRolesOf`）。
 */
const BASE_ROLE: RoleId = 'common.member'

/** WP234（docs/54 §6.5）：「负责人」那个岗位行的 id——身份，不是干活的岗位。 */
const OWNER_POSITION_ID = 'owner'

const POSITION_ERROR = (
  code: 'not_found' | 'conflict' | 'invalid_input' | 'forbidden',
  msg: string,
): RoleError => new RoleError(code, msg)

/** WP287 / WP291：一开始就判成要动手的，线程里头一句（带上按哪条职责做）。 */
export const taskLine = (role_name: string): string => `记成了任务，按「${role_name}」做`
/** WP287：问的那一句答的时候要动手（出了卡），转成任务时线程里那一句。 */
export const PROMOTED_LINE = '这件事要动手，转成了任务，在岗位「工作」里看进展'

/** 还等着人定的卡（与工作台面同一个口径）。 */
const WAITING_STATES = new Set(['pending', 'in_review'])

/** 审批项投到界面上是不是一张卡（日报 / 上线检查单是报表块，不是卡；判据在 deck 的 layout.ts）。 */
function isDeckCard(item: ApprovalItem): boolean {
  const payload = item.payload
  const changeKind =
    typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).kind
      : undefined
  return isQueueCard(item.kind, typeof changeKind === 'string' ? changeKind : undefined)
}

export interface PositionsOptions {
  workspace_id: WorkspaceId
  clock: Clock
  roles: RoleStore
  work: Work
  approvals: ApprovalBus
  /** 岗位模板（`createOrg().positions()`）——模板是制度层的东西，这里只读。 */
  positions(): Position[]
  /** 本人队列里的审批项（已按 recipient 过滤）；不给就是"数不出待审卡"，回 0。 */
  cards?(person_id: PersonId): Promise<ApprovalItem[]> | ApprovalItem[]
  /**
   * WP287：这个人点不点得动这张卡（与决定那一道同一把尺子）。点不动的不算「N 张等你定」。
   * 不给 = 都点得动（老口径）。
   */
  decidable?(person_id: PersonId): (item: ApprovalItem) => boolean
  /** 岗位层记忆的一句话（技能层条数 + 提到岗位层的教训条数）；不给就是空。 */
  memorySummary?(position_id: string): string
  /**
   * WP234（docs/54 §6.1）：这条分配安放在哪个岗位（`org.placementOf`）。不给 = 一条都没安放，
   * 全部按老规则算（与 WP69 逐字相同）。
   */
  placementOf?(assignment_id: AssignmentId): string | undefined
  appendEvent(e: Omit<EventEnvelope, 'id' | 'at'> & { at?: string }): void
  /**
   * WP237（Fable 10-06 代定）：停掉这件事上还在跑的运行（取消原因 `user`，`reason` 进时间线）。
   * 「换成 X」重跑之前先停，不让两次并行花钱。回停了几次；不给 = 这个进程没有运行时。
   */
  stopRuns?(matter_id: MatterId, reason: string): Promise<number>
  /**
   * WP241（docs/54 §7）：本人的定时任务（岗位页「工作」里的「定时」那一类）。
   * 不给 = 这个进程没有调度器，工作里就少这一类。
   */
  schedules?(
    person_id: PersonId,
  ): Promise<readonly WorkScheduleLike[]> | readonly WorkScheduleLike[]
  /** WP241：这个品牌的社媒帖子（「排期」那一类；按渠道 → 职责只留本岗位的）。 */
  socialPosts?(): readonly WorkPostLike[]
  /**
   * WP244：现在有运行在跑的事项（运行时的 `activeRuns`）。不给 = 不知道谁在跑——
   * 那时开着的事项照旧一律算「进行中」（老口径）。
   */
  runningMatters?(): ReadonlySet<string>
  /** WP244：这条职责还缺哪些**必需**连接（人话名）——卡住的事项说「缺什么」用。 */
  missingConnections?(role_id: RoleId): readonly string[]
  /**
   * WP251（决策 91）：「卡住了」改看运行时结构化标记的起点（这一版第一次启动的时刻）。
   * 在它之前跑的那几轮（老数据）才退回认 AI 末句；不给 = 一律当老数据（WP244 口径）。
   */
  runBlockMarkedSince?(): string | undefined
  /**
   * WP291（决策 356）：入口三分那一次便宜模型调用（`purpose: classify`，照常过网关计量）。
   * 回 `undefined` = 没接模型（那时按 WP287 的规则判）。`assignment_id` 是用量记在哪条分配上。
   */
  classifyComplete?(actor: { assignment_id: AssignmentId }): EntryClassifyComplete | undefined
}

export interface OpenAtPositionInput {
  position_id: string
  person_id: PersonId
  title: string
  summary?: string
  /** 关联对象引用（订单 / 客户 / 文件…），原样钉在事项上 */
  pinned?: { type: string; id: string }[]
  /**
   * WP84：**这件事已经知道该归哪条职责**，跳过岗位内路由。
   *
   * 唯一的来源是职责自己的 `quick_prompts`——那一条提示就写在那条职责的 yml 里，
   * 点它的人等于已经选了职责，再让路由去猜一遍只会猜错。
   *
   * 它**不是**扩权的口子：和 `reroute` 同一把尺子——必须在这个岗位的模板里，
   * 而且必须是**请求人自己名下**的那一条，否则拒（岗位仍然没有任何权限）。
   * 入口仍是岗位入口：事项照样 `entry: 'position'` + `position_template_id`（54 §2）。
   */
  role_id?: RoleId
  /**
   * WP287 / WP291：这句话怎么接。不给 / `auto` = 服务端三分（便宜模型判，判不了按 WP287 规则）；
   * `quick` = 当场答（岗位页上出「一句话 + 组件」）；`chat` / `ask` = 进会话；`task` = 开任务。
   */
  mode?: 'auto' | 'quick' | 'chat' | 'ask' | 'task'
  /**
   * WP287：不等运行跑完就回（界面拿到事项 id 立刻进会话线程，看它在线程里答）。
   * 不给 = 老样子，跑完才回（回答、`run_id` 都在回包里）。
   */
  detach?: boolean
}

/** WP287：岗位里问一句，当场的回答（岗位页输入框下面那一段）。 */
export interface PositionAnswer {
  /**
   * `answered` 答了；`failed` 没跑成（`failure` 是人话，下面出「重试」）；`stopped` 被停下；
   * `promoted` 答的时候要动手，已经转成了一件事（去事项页看）。
   */
  outcome: 'answered' | 'failed' | 'stopped' | 'promoted'
  /** AI 的回答（没答出来就是空串；去掉了 ```answer 那段） */
  text: string
  /** WP291：一句话（回答的第一段） */
  lead: string
  /** WP291：组件（表格 / 数字 / 一段字），按契约校验过 */
  components: AnswerComponent[]
  /** 来源：这次读了哪些东西（人话，最多 3 条） */
  sources: string[]
  failure?: string
}

/** WP291：一条当场问答（岗位「记录」里那一行）。 */
export interface PositionAnswerRecord {
  matter_id: MatterId
  at: string
  question: string
  lead: string
}

export interface OpenAtPositionResult {
  matter: Matter
  /**
   * WP287 / WP291：`quick` 当场答了（回答在 `answer` 里，岗位页上画）；`ask` 是一段会话（进线程）；
   * `task` 开了一件任务（进线程）。当场答的时候真要动手了（出了卡）→ 转成任务，回 `task`。
   */
  mode: 'quick' | 'ask' | 'task'
  /** WP291：这句话判成了哪一类、谁判的（`caller` = 调用方点名的） */
  entry?: { kind: EntryKind; by: EntryKindResult['by'] | 'caller' }
  /** WP287：`quick` / `ask` 时的回答（`ask` 只有不 `detach` 时才有） */
  answer?: PositionAnswer
  /** 判准了才有：这次用的是哪条职责、哪条分配 */
  picked?: { role_id: RoleId; role_name: string; assignment_id: AssignmentId }
  candidates: RouteCandidate[]
  ambiguous: boolean
  reason: string
  /** 拿不准时出的那张选择卡 */
  approval_item_id?: string
  /** 判准了就起了一次运行 */
  run_id?: string
}

export interface PositionsAssembly {
  /** 一个岗位的实体视图（54 §1）。 */
  instance(position_id: string, person_id: PersonId): Promise<PositionInstance>
  /** 本人持有的岗位（首页只列它们，职责不出现——54 §4）。 */
  mine(person_id: PersonId): Promise<PositionInstance[]>
  /** 交给这个岗位一件事（54 §2 主入口）。 */
  open(input: OpenAtPositionInput): Promise<OpenAtPositionResult>
  /**
   * 手动换职责：换后新的 Run 走新职责，旧 Run 不动。
   *
   * WP237：`run: true` = 换完立刻按这件事原来那段话起一次运行（时间线上「换成 B」、
   * 事项页上「走 A」都是它）；这件事还挂着一张没定的选择卡时顺手把卡按同一个选项定掉。
   */
  reroute(input: {
    matter_id: MatterId
    role_id: RoleId
    person_id: PersonId
    run?: boolean
  }): Promise<{ matter: Matter; assignment_id: AssignmentId; run_id?: string }>
  /**
   * WP237：「这件事该走哪条职责」那张卡定了 → 事项钉到选的那条、立刻起一次运行。
   * 不是那张卡、没批、或者事项已经在那条上了 → 什么都不做。
   */
  onChoiceDecided(item: ApprovalItem): Promise<void>
  /**
   * WP287：岗位里问的一句 →「转成一件事」（进「进行中」）。
   * WP291：`run: true`（当场回答下面「当成任务做」）= 转完按原话当任务再跑一次。
   */
  promote(
    matter_id: MatterId,
    person_id: PersonId,
    opts?: { run?: boolean },
  ): Promise<{ matter: Matter; run_id?: string }>
  /** WP291：当场回答下面「接着聊」——变成一段会话（进左栏会话历史），之后在线程里接着说。 */
  reveal(matter_id: MatterId, person_id: PersonId): Matter
  /** WP291：本人在这个岗位上的当场问答（岗位「记录」里列），新的在前。 */
  answers(position_id: string, person_id: PersonId): PositionAnswerRecord[]
  /**
   * WP237（Fable 10-06 真机补充）：在**从岗位开的**事项里说一句话。
   *
   * - 不是从岗位开的 → `undefined`（调用方走老路）；
   * - 已经定了职责、而那条分配是本人的 → 用**那条**分配起运行（不是请求头上带的那条）；
   * - 还没定职责 → 话里点名了哪条就钉哪条；没点名就把原话加这句一起再路由一次（打平按分取）；
   *   还是看不出 → 只记下这句话、再问一次，**绝不落到负责人的通用助手上**。
   */
  sayAt(input: {
    matter_id: MatterId
    person_id: PersonId
    text: string
  }): Promise<{ event: MatterEvent; run_id?: string } | undefined>
  /**
   * 一条职责属于哪个岗位（起 Run 拼 `position` 技能层时要它）。
   * 挂在多个岗位里、或者一个都没有时回 `undefined` 并给一句话——由调用方写进时间线。
   *
   * WP234：给了分配 id 且那条分配已安放 → 就是安放的那个岗位（docs/54 §6.1）。
   */
  positionOf(role_id: RoleId, assignment_id?: AssignmentId): { position_id?: string; note?: string }
  /** 岗位层上下文的三样（54 §3）。 */
  layerContext(position_id: string, person_id: PersonId): Promise<PositionLayerContext | undefined>
  /**
   * WP241（docs/54 §7）：岗位页「工作」——事项 + 本人的待办 + 定时 + 排期合成一份，
   * 每项带所属职责、分组、截止 / 下次、最近一句进展、等你的卡。
   */
  work(position_id: string, person_id: PersonId): Promise<PositionWorkView>
}

/** 54 §3 岗位层上下文：面板数字与告警摘要、进行中事项摘要、持有人可用时段。 */
export interface PositionLayerContext {
  position_id: string
  position_name: string
  /** 36 的数字块与告警，摘要级（数在服务端算好，这里只抄结论） */
  panel: { label: string; value: string }[]
  alerts: string[]
  /** 岗位下进行中的事项（标题 + 阶段，≤ 10 条） */
  open_matters: { title: string; status: string }[]
  /** 持有人可用时段 */
  holders: { person_id: PersonId; available: string }[]
}

/** 岗位下进行中事项摘要最多带几条（54 §3；再多就是噪音，也撑爆上下文）。 */
export const MAX_POSITION_MATTERS = 10

export function createPositions(options: PositionsOptions): PositionsAssembly {
  const { workspace_id, roles, work, clock } = options

  const templateOf = (position_id: string): Position => {
    const found = options.positions().find((p) => p.id === position_id)
    if (found === undefined) throw POSITION_ERROR('not_found', `没有这个岗位：${position_id}`)
    return found
  }

  const activeOf = (person_id: PersonId) =>
    roles.assignments
      .listByPerson(person_id, { workspace_id })
      .filter((a) => a.revoked_at === undefined)

  const roleName = (id: RoleId): string => roles.roles.get(id)?.name.zh ?? id

  /**
   * WP234（docs/54 §6.1）：这条分配属不属于这个岗位——安放了就只属于安放的那个，
   * 没安放按老规则（职责清单里有它就算）。`org.placementOf` 已经把「安放的岗位不在了」滤掉。
   */
  const belongs = (a: { id: string; role_id: RoleId }, position: Position): boolean =>
    belongsTo(a, position, options.placementOf, () => true)

  /** 这个岗位下、**这个人**持有的那几条分配（路由只在它们里面挑）。 */
  const minePerRole = (
    position: Position,
    person_id: PersonId,
  ): { role_id: RoleId; assignment_id: AssignmentId }[] => {
    const held = activeOf(person_id).filter((a) => belongs(a, position))
    const out: { role_id: RoleId; assignment_id: AssignmentId }[] = []
    for (const entry of position.roles) {
      const hit = held.find((a) => a.role_id === entry.role)
      if (hit !== undefined) out.push({ role_id: entry.role, assignment_id: hit.id })
    }
    return out
  }

  /** 参赛的职责：判据词现从职责定义抽（改了 yml 路由跟着变，不用改代码）。 */
  const profilesOf = (
    entries: { role_id: RoleId; assignment_id: AssignmentId }[],
  ): RouteRoleProfile[] =>
    entries
      .map((e) => {
        const def = roles.roles.get(e.role_id)
        if (def === undefined) return undefined
        return {
          role_id: def.id,
          role_name: def.name.zh,
          terms: roleRouteTerms(def),
          positions: [{ position_id: e.assignment_id, person_id: '' }],
        }
      })
      .filter((p): p is RouteRoleProfile => p !== undefined)

  const emit = (
    type: 'matter.routed' | 'matter.rerouted',
    matter_id: MatterId,
    actor: PersonId,
    payload: Record<string, unknown>,
  ): void => {
    options.appendEvent({
      schema_version: 1,
      workspace_id,
      type,
      actor: { kind: 'person', id: actor },
      subject: { type: 'matter', id: matter_id },
      correlation: { trace_id: `tr_position_${matter_id}` },
      payload,
    })
  }

  const cardsOf = async (person_id: PersonId): Promise<ApprovalItem[]> =>
    options.cards === undefined ? [] : await options.cards(person_id)

  /**
   * WP125（72 §6.6 #11）：**岗位的职责清单里不算工作区的底座职责**。
   *
   * `docs/73` #3 记的那个 bug：客服岗位页写「5 条职责」，而
   * `packages/roles/positions/customer-care.yml` 里只有 4 条。差的那一条是
   * `common.member`——种岗位时每个岗位都带着它（`org.ts` 的 `SEED_POSITIONS`），
   * 它是"这个人是这个工作区的成员"，不是客服岗位的一条职责。
   *
   * 于是岗位视图里把它滤掉：计数、折叠层、面板数字三处读的是同一个清单，
   * 于是三处永远对得上 yml。**只滤视图不改模板**——分配与权限照旧从模板走。
   *
   * 「普通成员」那个岗位本身只有这一条，那就不滤（滤完是空清单，等于这个岗位消失）。
   */
  const dutyRolesOf = (template: Position): Position['roles'] => {
    const kept = template.roles.filter((r) => r.role !== BASE_ROLE)
    return kept.length === 0 ? template.roles : kept
  }

  /** WP213（docs/36 §8.3）：岗位图标——存的那份优先，没有就取同 id 内置模板 yml 里的。 */
  const iconOf = (template: Position): { icon?: string } => {
    const icon = template.icon ?? bundledPositionIcon(template.id)
    return icon === undefined ? {} : { icon }
  }

  const instance = async (position_id: string, person_id: PersonId): Promise<PositionInstance> => {
    const template = templateOf(position_id)
    // 谁在做：WP234 起按安放算（docs/54 §6.1；与 org.ts 的 holdersOf 同一条规则——
    // 安放在这里的人，加上老规则：未安放的分配凑齐默认包的人）
    const byRole = new Map<RoleId, AssignmentId[]>()
    const people = new Set<PersonId>()
    for (const entry of template.roles) {
      const rows = roles.assignments
        .listByRole(entry.role, { workspace_id })
        .filter((a) => a.revoked_at === undefined && belongs(a, template))
      byRole.set(
        entry.role,
        rows.map((a) => a.id),
      )
      for (const a of rows) people.add(a.person_id)
    }
    const holders = new Set(
      holdersByPlacement(
        template,
        [...people].map((p) => ({ person_id: p, held: activeOf(p) })),
        options.placementOf,
        () => true,
      ),
    )
    // 本人在这个岗位下持有的那几条：界面上的每一个入口都只能用它们
    const mine = new Map(minePerRole(template, person_id).map((m) => [m.role_id, m.assignment_id]))
    const assignmentIds = new Set([...byRole.values()].flat())
    const open_matters = work
      // WP287：岗位里问的一句是会话，不算「N 件在办」
      .listMatters({ status: ['open', 'waiting'], asks: false })
      .filter((m) => matterInPosition(m, position_id, assignmentIds)).length
    /*
     * WP141（docs/78 §2 首页 / 客服第 37 步）：「N 张待审」与牌堆**同一个口径**——
     * 本人在这个岗位下持有的那几条职责上、还等着人定的、**真是卡**的那些
     * （日报 / 上线检查单不算，36 §2.2b）。原来按「这几条职责的所有分配提出的」数，
     * 于是页头写 3、牌堆里是 4（每日计划没有提案分配），日报还被多算一张。
     */
    const myDutyRoles = new Set(
      dutyRolesOf(template)
        .map((r) => r.role)
        .filter((r) => mine.has(r)),
    )
    const cards = await cardsOf(person_id)
    /*
     * WP278（决策 284）：只有一个岗位的人，首页就是这个岗位页——发给他、挂在底座职责（`common.*`）上的卡
     * （「知道了 / 撤回」、有人申请加入…）也算在这里（牌堆那边同一个口径：`?base=1`）。
     */
    const sole = soleTemplateOf(person_id) === template.id
    // WP287：只数真要他定、他也点得动的卡（过期 / 已定的本来就不在等待状态里）
    const can = options.decidable?.(person_id) ?? (() => true)
    const nowMs = Date.parse(clock.now())
    const pending_cards = cards.filter(
      (i) =>
        WAITING_STATES.has(i.state) &&
        // 到期了（定时清理还没来得及记成过期）的也不算
        (i.expires_at === undefined || Date.parse(i.expires_at) > nowMs) &&
        can(i) &&
        (myDutyRoles.has(i.role_id) || (sole && i.role_id.startsWith('common.'))) &&
        isDeckCard(i),
    ).length
    return {
      position_id: template.id,
      workspace_id,
      name: { ...template.name },
      template_version: template.version,
      holders: [...holders].sort(),
      roles: dutyRolesOf(template).map((r) => {
        const my = mine.get(r.role)
        // WP84：快捷提示与示例任务原样从职责定义抄来（改 yml 这里就变，没有第二份）
        const def = roles.roles.get(r.role)
        const prompts = def?.quick_prompts ?? []
        const examples = def?.task_examples ?? []
        return {
          role_id: r.role,
          role_name: roleName(r.role),
          default: r.default,
          assignment_ids: byRole.get(r.role) ?? [],
          ...(my === undefined ? {} : { my_assignment_id: my }),
          ...(prompts.length === 0 ? {} : { quick_prompts: prompts }),
          ...(examples.length === 0 ? {} : { task_examples: examples }),
          // WP171：第二批的职责（`status: planned`）界面上标「第二批」
          ...(def?.status === 'planned' ? { planned: true as const } : {}),
        }
      }),
      open_matters,
      pending_cards,
      memory_summary: options.memorySummary?.(template.id) ?? '',
      // WP213：存下来的那份没写就按同 id 的内置模板补（负责人 / 自建岗位没有，界面自己推）
      ...iconOf(template),
    }
  }

  /**
   * 本人的岗位：有分配**归属于**它的那些（WP234 按安放算，docs/54 §6.1）。
   *
   * WP234（§6.5）：工作区底座职责（`common.member` / `common.owner`）不算岗位的活——
   * 一个岗位对这个人来说只剩它们，就不出现在这里。「负责人」于是从左栏与首页隐去，
   * 而 `common.owner` 那条分配原样在（审批默认收件、brandAnchor 都还靠它）。
   */
  /** WP278：这个人只在做一个岗位时回那个岗位的模板 id（与 `mine` 同一个判据：「负责人」那一行不算）。 */
  const soleTemplateOf = (person_id: PersonId): string | undefined => {
    const held = activeOf(person_id).filter((a) => !WORKSPACE_BASE_ROLES.has(a.role_id))
    const hit = options
      .positions()
      .filter((t) => t.id !== OWNER_POSITION_ID && held.some((a) => belongs(a, t)))
    return hit.length === 1 ? hit[0]?.id : undefined
  }

  const mine = async (person_id: PersonId): Promise<PositionInstance[]> => {
    const held = activeOf(person_id).filter((a) => !WORKSPACE_BASE_ROLES.has(a.role_id))
    const out: PositionInstance[] = []
    for (const template of options.positions()) {
      // 「负责人」那一行是身份（docs/54 §6.5）：它下面就算还挂着别的职责也不进「我的岗位」
      if (template.id === OWNER_POSITION_ID) continue
      if (!held.some((a) => belongs(a, template))) continue
      out.push(await instance(template.id, person_id))
    }
    return out
  }

  const positionOf = (
    role_id: RoleId,
    assignment_id?: AssignmentId,
  ): { position_id?: string; note?: string } => {
    // WP234：分配已安放 → 就是那个岗位（docs/54 §6.1），不用再猜
    const placed = assignment_id === undefined ? undefined : options.placementOf?.(assignment_id)
    if (placed !== undefined) return { position_id: placed }
    const hits = options.positions().filter((p) => p.roles.some((r) => r.role === role_id))
    const only = hits[0]
    if (only === undefined || hits.length === 0)
      return { note: `「${roleName(role_id)}」不在任何岗位模板里，这次运行跳过岗位层` }
    if (hits.length > 1) {
      // WP234：这条职责所有还在的分配都安放在同一个岗位 → 就是它
      const live = roles.assignments
        .listByRole(role_id, { workspace_id })
        .filter((a) => a.revoked_at === undefined)
      const where = new Set(live.map((a) => options.placementOf?.(a.id)))
      const sole = [...where][0]
      if (live.length > 0 && where.size === 1 && sole !== undefined) return { position_id: sole }
    }
    if (hits.length > 1)
      return {
        note: `「${roleName(role_id)}」同时挂在 ${hits.length} 个岗位里，分配上没记是哪一个，这次运行跳过岗位层`,
      }
    return { position_id: only.id }
  }

  const layerContext = async (
    position_id: string,
    person_id: PersonId,
  ): Promise<PositionLayerContext | undefined> => {
    let view: PositionInstance
    try {
      view = await instance(position_id, person_id)
    } catch {
      return undefined
    }
    const assignmentIds = new Set(view.roles.flatMap((r) => r.assignment_ids))
    // WP207：归档的事不进岗位层上下文（它这阵子没人动，喂给模型只是噪音）
    const open_matters = work
      .listMatters({ status: ['open', 'waiting'], archived: false, asks: false })
      .filter((m) => matterInPosition(m, position_id, assignmentIds))
      .slice(0, MAX_POSITION_MATTERS)
      .map((m) => ({ title: m.title, status: m.status }))
    const cards = await cardsOf(person_id)
    const waiting = cards.filter(
      (i) => WAITING_STATES.has(i.state) && assignmentIds.has(i.proposer.assignment_id ?? ''),
    )
    return {
      position_id: view.position_id,
      position_name: view.name.zh,
      // 数字块：29 原则 ③，数在服务端算好，这里只抄结论（不经模型手）
      panel: [
        { label: '待你定的卡', value: String(view.pending_cards) },
        { label: '进行中的事项', value: String(view.open_matters) },
        { label: '这个岗位的职责', value: String(view.roles.length) },
      ],
      alerts: waiting
        .filter((i) => i.priority === 'immediate')
        .slice(0, 5)
        .map((i) => i.title),
      open_matters,
      holders: view.holders.map((id) => ({
        person_id: id,
        available: work.listTodos({ owner: id, status: ['doing'] }).length > 0 ? '在做事' : '空着',
      })),
    }
  }

  /** WP237：不是交活的话（「你好」）——只回一句问要做什么，不起运行、不出卡。 */
  const askWhat = (
    matter_id: MatterId,
    duties: readonly { role_id: RoleId; role_name: string }[],
  ): MatterEvent =>
    work.appendEvent(matter_id, {
      kind: 'agent_message',
      text:
        duties.length === 0
          ? '想让我做什么？说一句要办的事，我就开始做。'
          : `想让我做什么？说一句要办的事，我就开始做（这个岗位能做：${duties.map((d) => `「${d.role_name}」`).join('、')}）。`,
      actor: { kind: 'agent', id: 'position_router' },
    })

  /**
   * WP287：岗位里路由**永远有个结果**——判得准就是它；打平按分取（WP237）；一个都没命中按先后取；
   * 几条都沾一点、谁都不像也按分 / 先后取（`settleAlways`）。不再出「走哪条职责」的选择卡。
   */
  const routeIn = (
    text: string,
    template: Position,
    held: { role_id: RoleId; assignment_id: AssignmentId }[],
  ): SettledRouteResult => {
    const duties = held.map((h) => ({ role_id: h.role_id, role_name: roleName(h.role_id) }))
    const routed = settleAlways(
      settleNoHit(
        settleCloseCall(
          routeWithinPosition(text, profilesOf(held), {
            duty_count: dutyRolesOf(template).length,
          }),
          held.map((h) => h.role_id),
        ),
        duties,
      ),
      duties,
    )
    if (routed.picked !== undefined) return routed
    // 本人在这个岗位下只有底座职责（参赛的一条都没有）：就用他持有的第一条
    const first = held[0]
    if (first === undefined) return routed
    return {
      picked: first.role_id,
      candidates: [
        { role_id: first.role_id, role_name: roleName(first.role_id), score: 0, why: [] },
      ],
      ambiguous: false,
      reason: `先按「${roleName(first.role_id)}」来做的`,
      settled: true,
      alternatives: [],
    }
  }

  /**
   * WP287：问的那一句跑完了，从时间线上取回答。这次运行出了卡 / 推了预览 = 要动手了，
   * 转成一件事（时间线上记一句）。
   */
  const answerOf = (matter_id: MatterId, run_id: string | undefined): PositionAnswer => {
    if (run_id === undefined)
      return {
        outcome: 'failed',
        text: '',
        lead: '',
        components: [],
        sources: [],
        failure: '这里还没接上 AI，答不了',
      }
    const events = work.store.listMatterEvents(matter_id, { limit: 500 })
    const mine = events.filter((e) => e.run_id === run_id)
    // WP291：回答 = 一句话 + 组件（```answer 那段按契约校验；没有就认正文里的 Markdown 表格）
    const split = splitAnswer(
      mine
        .filter((e) => e.kind === 'agent_message')
        .map((e) => e.text)
        .join('\n\n')
        .trim(),
    )
    const said = { text: split.text, lead: split.lead, components: split.components }
    const digest = mine.find((e) => e.run_digest !== undefined)?.run_digest
    const sources = [
      ...new Set((digest?.steps ?? []).filter((st) => st.status === 'ok').map((st) => st.text)),
    ].slice(0, 3)
    const failed = mine.find((e) => e.failed !== undefined)
    if (failed !== undefined) return { outcome: 'failed', ...said, sources, failure: failed.text }
    const acting = mine.some((e) => e.kind === 'card' || e.preview !== undefined)
    if (acting) {
      work.promoteAsk(matter_id, {
        text: PROMOTED_LINE,
        actor: { kind: 'agent', id: 'position_router' },
      })
      return { outcome: 'promoted', ...said, sources }
    }
    if (digest?.outcome === 'stopped') return { outcome: 'stopped', ...said, sources }
    if (digest?.outcome === 'failed')
      return {
        outcome: 'failed',
        ...said,
        sources,
        failure: '工坊这边出错了，已记下，点重试或稍后再试',
      }
    return { outcome: 'answered', ...said, sources }
  }

  const open = async (input: OpenAtPositionInput): Promise<OpenAtPositionResult> => {
    const template = templateOf(input.position_id)
    const held = minePerRole(template, input.person_id)
    if (held.length === 0)
      throw POSITION_ERROR(
        'forbidden',
        `你名下没有「${template.name.zh}」这个岗位下的任何一条职责，开不了这里的事`,
      )
    /*
     * 路由与首轮运行用的那段话。WP259：标题是从一大段话里摘出来的（「第一句…」）时，
     * 就是那段完整原文；否则照老规矩「标题 + 描述」（随便聊带过来的上下文）。
     */
    const text = taskTextOf(input.title, input.summary)
    /*
     * WP84：从快捷提示点进来的，职责是**已经定好的**，不跑路由。
     *
     * 两道判定和 `reroute` 逐字一样，一道都不省：不在这个岗位的模板里 → 拒；
     * 不在请求人自己名下 → 拒。
     */
    const pinned = input.role_id
    if (pinned !== undefined) {
      if (!template.roles.some((r) => r.role === pinned))
        throw POSITION_ERROR(
          'invalid_input',
          `「${roleName(pinned)}」不在「${template.name.zh}」这个岗位里`,
        )
      if (!held.some((h) => h.role_id === pinned))
        throw POSITION_ERROR('forbidden', `你名下没有「${roleName(pinned)}」这条职责，开不了`)
    }
    const named = held.map((h) => ({ role_id: h.role_id, role_name: roleName(h.role_id) }))
    // WP237（Fable 代定）：「你好」这类明显不是交活的话——不起运行，只回一句问要做什么
    // WP291：它就是一次当场问答（岗位页上回一句，不进线程）
    const smallTalk = pinned === undefined && input.mode !== 'task' && looksLikeSmallTalk(text)
    /*
     * WP291（决策 356）：调用方点了名的照办；否则下面三分。快捷提示（定了职责）也照样三分——
     * 定的是**哪条职责**，不是「这是一件任务」（「看看今天的订单」也是当场答）。老的 `ask` 就是会话。
     */
    const called: EntryKind | undefined =
      input.mode === 'quick'
        ? 'quick'
        : input.mode === 'ask' || input.mode === 'chat'
          ? 'chat'
          : input.mode === 'task'
            ? 'task'
            : undefined

    if (smallTalk) {
      const matter = work.createMatter({
        kind: 'adhoc',
        title: input.title,
        entry: 'position',
        position_template_id: template.id,
        participants: [input.person_id],
        ask: true,
        quick: called === undefined || called === 'quick',
        ...(input.summary === undefined ? {} : { summary: input.summary }),
      })
      emit('matter.routed', matter.id, input.person_id, {
        position_id: template.id,
        ambiguous: true,
        mode: 'ask',
        entry: { kind: 'quick', by: 'rules', why: 'small_talk' },
        candidates: [],
      })
      work.appendEvent(matter.id, {
        kind: 'human_message',
        text,
        actor: { kind: 'person', id: input.person_id },
      })
      const reply = askWhat(matter.id, named)
      const quickHere = called === undefined || called === 'quick'
      return {
        matter: work.getMatter(matter.id) ?? matter,
        mode: quickHere ? 'quick' : 'ask',
        entry: { kind: quickHere ? 'quick' : 'chat', by: 'rules' },
        answer: {
          outcome: 'answered',
          text: reply.text,
          lead: reply.text,
          components: [],
          sources: [],
        },
        candidates: [],
        ambiguous: true,
        reason: '像是打个招呼，还没说要做什么',
      }
    }

    const routed: SettledRouteResult =
      pinned === undefined
        ? routeIn(text, template, held)
        : {
            picked: pinned,
            candidates: [],
            ambiguous: false,
            reason: `按「${roleName(pinned)}」这条职责的快捷提示开的，没走岗位内路由`,
          }
    const pickedEntry = held.find((h) => h.role_id === routed.picked) ?? held[0]
    if (pickedEntry === undefined)
      throw POSITION_ERROR('forbidden', `你名下没有「${template.name.zh}」这个岗位下的职责`)

    /*
     * WP291（决策 356）：三分——便宜模型判（用量记在路由到的那条分配上）；没接模型 / 超时 /
     * 坏 JSON 退回 WP287 的规则。判断理由只进本机事件。
     */
    const judged: EntryKindResult | undefined =
      called === undefined
        ? await classifyEntryKind(
            text,
            options.classifyComplete?.({ assignment_id: pickedEntry.assignment_id }),
          )
        : undefined
    // 退回规则时照 WP287 的规则来：指定了职责（快捷提示）默认是交办
    const kind: EntryKind =
      called ?? (judged?.by === 'rules' && pinned !== undefined ? 'task' : judged?.kind) ?? 'quick'
    const ask = kind !== 'task'
    const quick = kind === 'quick'
    const entry = { kind, by: judged?.by ?? ('caller' as const) }

    const matter = work.createMatter({
      kind: 'adhoc',
      title: input.title,
      entry: 'position',
      position_template_id: template.id,
      participants: [input.person_id],
      ...(input.summary === undefined ? {} : { summary: input.summary }),
      ...(input.pinned === undefined ? {} : { pinned: input.pinned }),
      ...(ask ? { ask: true, ...(quick ? { quick: true } : {}) } : {}),
      position_id: pickedEntry.assignment_id,
      role_id: pickedEntry.role_id,
    })

    const alternatives = routed.alternatives ?? []
    emit('matter.routed', matter.id, input.person_id, {
      position_id: template.id,
      picked: pickedEntry.role_id,
      ambiguous: false,
      mode: ask ? 'ask' : 'task',
      // WP291：三分的结果与理由（本机事件，不上界面）
      entry: {
        kind,
        by: entry.by,
        ...(judged === undefined ? {} : { why: judged.why }),
        ...(judged?.fallback === undefined ? {} : { fallback: judged.fallback }),
      },
      // WP237 / WP287：没问人、自己定的——打平按分取（top_score）或一个都没命中按先后取（first_duty）
      ...(routed.settled === true
        ? { settled: routed.candidates.every((c) => c.score === 0) ? 'first_duty' : 'top_score' }
        : {}),
      // 判据词与原话不进日志（21 §1）：只有 id 与分数
      candidates: routed.candidates.map((c) => ({ role_id: c.role_id, score: c.score })),
    })

    const route =
      alternatives.length === 0
        ? undefined
        : {
            picked: pickedEntry.role_id,
            options: alternatives.map((c) => ({ role_id: c.role_id, role_name: c.role_name })),
          }
    // 路由结果进事项时间线（会话 / 当场问答的线程里不显示这一行；任务那一行排在原话后面，见下）
    if (ask)
      work.appendEvent(matter.id, {
        kind: 'status',
        text: routed.reason,
        actor: { kind: 'agent', id: 'position_router' },
        ref: { type: 'position', id: template.id },
        ...(route === undefined ? {} : { route }),
      })

    // 起 Run：用的是**被路由到的那条职责**的 Assignment（权限 / 额度 / 技能全是它的）。
    // `say` 同步记下原话、再起运行；这里先不等它跑完（WP287：`detach` 时界面立刻进会话线程看它答）
    const running = work.say(matter.id, {
      person_id: input.person_id,
      assignment_id: pickedEntry.assignment_id,
      text,
    })
    // WP287 / WP291：一开始就判成任务的——原话后面头一句「记成了任务，按「X」做」（还能换的话带「换一条」）
    if (!ask)
      work.appendEvent(matter.id, {
        kind: 'status',
        text: taskLine(roleName(pickedEntry.role_id)),
        actor: { kind: 'agent', id: 'position_router' },
        ref: { type: 'position', id: template.id },
        route: {
          picked: pickedEntry.role_id,
          options: route?.options ?? [],
          task: true,
        },
      })
    const view = {
      mode: quick ? ('quick' as const) : ask ? ('ask' as const) : ('task' as const),
      entry,
      picked: {
        role_id: pickedEntry.role_id,
        role_name: roleName(pickedEntry.role_id),
        assignment_id: pickedEntry.assignment_id,
      },
      candidates: routed.candidates,
      ambiguous: false,
      reason: routed.reason,
    }
    // 问的那一句跑完了再看：要动手（出了卡）就转成任务（线程里说一句）
    const settle = async (): Promise<{ run_id?: string; answer?: PositionAnswer }> => {
      const said = await running
      const answer = ask ? answerOf(matter.id, said.run_id) : undefined
      return {
        ...(said.run_id === undefined ? {} : { run_id: said.run_id }),
        ...(answer === undefined ? {} : { answer }),
      }
    }
    // WP291：当场问答没有线程可进——一律等它答完（界面在输入框下面先出「…」）
    if (input.detach === true && !quick) {
      void settle().catch(() => undefined)
      return { matter: work.getMatter(matter.id) ?? matter, ...view }
    }
    const done = await settle()
    // WP291：当场答的时候真要动手了（出了卡）→ 已转成任务，回包按任务回（界面进它的线程）
    const mode = quick && done.answer?.outcome === 'promoted' ? 'task' : view.mode
    return { matter: work.getMatter(matter.id) ?? matter, ...view, ...done, mode }
  }

  /**
   * WP287：「转成一件事」——问的那一句变成一件普通的事（进「进行中」）。只有参与者能转。
   */
  const promote = async (
    matter_id: MatterId,
    person_id: PersonId,
    opts?: { run?: boolean },
  ): Promise<{ matter: Matter; run_id?: string }> => {
    const matter = work.getMatter(matter_id)
    if (matter === undefined || !matter.context.participants.includes(person_id))
      throw POSITION_ERROR('not_found', `没有这个事项：${matter_id}`)
    const was = matter.ask
    const next = work.promoteAsk(matter_id, {
      text: '转成了任务，在岗位「工作」里跟进',
      actor: { kind: 'person', id: person_id },
    })
    // WP291：「当成任务做」——按原话当任务再跑一次（当场问答那一次只查只答）
    if (opts?.run !== true || was === undefined) return { matter: next }
    const own =
      next.position_id === undefined
        ? undefined
        : activeOf(person_id).find((a) => a.id === next.position_id)
    if (own === undefined) return { matter: next }
    const ran = await work.run(matter_id, {
      person_id,
      assignment_id: own.id,
      brief: briefOf(next),
      text: '当成任务开始做了',
    })
    return {
      matter: work.getMatter(matter_id) ?? next,
      ...(ran.run_id === undefined ? {} : { run_id: ran.run_id }),
    }
  }

  /** WP291：「接着聊」——当场问答变成一段会话。只有参与者能转。 */
  const reveal = (matter_id: MatterId, person_id: PersonId): Matter => {
    const matter = work.getMatter(matter_id)
    if (matter === undefined || !matter.context.participants.includes(person_id))
      throw POSITION_ERROR('not_found', `没有这个事项：${matter_id}`)
    return work.revealQuick(matter_id, { kind: 'person', id: person_id })
  }

  /** WP291：本人在这个岗位上答过的当场问答（没跑成的不列），新的在前，最多 20 条。 */
  const answers = (position_id: string, person_id: PersonId): PositionAnswerRecord[] =>
    work
      .listMatters({ quick: true, participant: person_id })
      .filter((m) => m.position_template_id === position_id)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .flatMap((m) => {
        const events = work.store.listMatterEvents(m.id, { limit: 200 })
        if (events.some((e) => e.failed !== undefined)) return []
        const said = events
          .filter((e) => e.kind === 'agent_message')
          .map((e) => e.text)
          .join('\n\n')
        const lead = splitAnswer(said).lead
        if (lead === '') return []
        const question = events.find((e) => e.kind === 'human_message')?.text ?? m.title
        return [
          { matter_id: m.id, at: m.created_at, question: clip(question, 80) ?? question, lead },
        ]
      })
      .slice(0, 20)

  /**
   * 这件事原来那段话：岗位入口开事项时记下的那句人话（以标题打头的那一句），没有就用标题
   * （WP237 之前开的、还没定职责的事项没记原话）。
   */
  const briefOf = (matter: Matter): string => {
    const said = work.store.listMatterEvents(matter.id).filter((e) => e.kind === 'human_message')
    return (
      // WP259：标题拆过（「第一句…」）的，原话以去掉「…」的那段开头
      said.find((e) => isTaskBrief(matter.title, e.text))?.text ??
      // WP264：标题换成了 AI 起的短标题 / 人改过的——原话就是这件事的第一句人话
      (matter.title_source === undefined ? undefined : said[0]?.text) ??
      matter.title
    )
  }

  /** 这件事上还没定的那张「走哪条职责」卡（时间线上路由那一条记着卡号）。 */
  const pendingChoiceOf = async (matter_id: MatterId): Promise<ApprovalItem | undefined> => {
    const ids = work.store
      .listMatterEvents(matter_id, { limit: 500 })
      .filter((e) => e.actor.id === 'position_router' && e.approval_item_id !== undefined)
      .map((e) => e.approval_item_id as string)
    for (const id of ids.reverse()) {
      const item = await options.approvals.get(id)
      if (item !== undefined && isRouteChoice(item) && WAITING_STATES.has(item.state)) return item
    }
    return undefined
  }

  /**
   * 别处已经选定了（事项页按钮 / 续的那句话点了名）→ 那张卡按同一个选项定掉，
   * 不留一张「还等你定」的卡。定卡会回到 `onChoiceDecided`，那时事项已经在那条上，什么都不做。
   */
  const settleCard = async (
    matter_id: MatterId,
    role_id: RoleId,
    person_id: PersonId,
  ): Promise<void> => {
    const card = await pendingChoiceOf(matter_id)
    if (card === undefined) return
    const token = [...card.deliveries]
      .reverse()
      .find(
        (d) => d.to === person_id && d.status !== 'expired' && d.status !== 'acted',
      )?.decision_token
    if (token === undefined) return
    try {
      await options.approvals.decide(card.id, person_id, {
        decision_token: token,
        action: 'approve_edited',
        edited_payload: { ...asRecord(card.payload), selected_option_id: role_id },
        selected_option_id: role_id,
        via: 'workstation',
      })
    } catch {
      // 卡定不掉不影响这件事已经开跑；它会按 24 小时规则升级 / 过期
    }
  }

  const reroute = async (input: {
    matter_id: MatterId
    role_id: RoleId
    person_id: PersonId
    run?: boolean
  }): Promise<{ matter: Matter; assignment_id: AssignmentId; run_id?: string }> => {
    const matter = work.getMatter(input.matter_id)
    if (matter === undefined) throw POSITION_ERROR('not_found', `没有这个事项：${input.matter_id}`)
    const position_id = matter.position_template_id ?? positionOf(input.role_id).position_id
    if (position_id === undefined)
      throw POSITION_ERROR('invalid_input', '这件事不属于任何岗位，换不了职责')
    const template = templateOf(position_id)
    if (!template.roles.some((r) => r.role === input.role_id))
      throw POSITION_ERROR(
        'invalid_input',
        `「${roleName(input.role_id)}」不在「${template.name.zh}」这个岗位里`,
      )
    // 换到的必须是**他自己**持有的那一条：换职责不是扩权的口子
    const hit = minePerRole(template, input.person_id).find((h) => h.role_id === input.role_id)
    if (hit === undefined)
      throw POSITION_ERROR(
        'forbidden',
        `你名下没有「${roleName(input.role_id)}」这条职责，换不过去`,
      )
    const before = matter.role_id
    // WP237（Fable 代定）：「换成 X」重跑之前先停掉这件事上还在跑的那次（不两次并行花钱）
    if (input.run === true)
      await options.stopRuns?.(matter.id, `已换成「${roleName(input.role_id)}」重跑`)
    const next: Matter = {
      ...matter,
      role_id: input.role_id,
      position_id: hit.assignment_id,
      position_template_id: template.id,
      updated_at: clock.now(),
    }
    work.store.putMatter(next)
    work.appendEvent(matter.id, {
      kind: 'status',
      text:
        before === undefined
          ? `改成走「${roleName(input.role_id)}」这条职责`
          : `职责从「${roleName(before)}」换成「${roleName(input.role_id)}」；之前跑过的那几次不动`,
      actor: { kind: 'person', id: input.person_id },
      ref: { type: 'position', id: template.id },
    })
    emit('matter.rerouted', matter.id, input.person_id, {
      position_id: template.id,
      ...(before === undefined ? {} : { from: before }),
      to: input.role_id,
    })
    // WP237：别处定了，那张还挂着的选择卡跟着定掉（先钉再定卡：回调看到已在这条上就不重跑）
    await settleCard(matter.id, input.role_id, input.person_id)
    if (input.run !== true) return { matter: next, assignment_id: hit.assignment_id }
    const ran = await work.run(matter.id, {
      person_id: input.person_id,
      assignment_id: hit.assignment_id,
      brief: briefOf(next),
      text: `按「${roleName(input.role_id)}」开始做了`,
    })
    return {
      matter: work.getMatter(matter.id) ?? next,
      assignment_id: hit.assignment_id,
      ...(ran.run_id === undefined ? {} : { run_id: ran.run_id }),
    }
  }

  const onChoiceDecided = async (item: ApprovalItem): Promise<void> => {
    if (!isRouteChoice(item) || item.workspace_id !== workspace_id) return
    if (item.state !== 'approved' && item.state !== 'approved_edited' && item.state !== 'applied')
      return
    const payload = asRecord(item.payload)
    const matter_id = typeof payload.matter_id === 'string' ? payload.matter_id : undefined
    const matter = matter_id === undefined ? undefined : work.getMatter(matter_id)
    if (matter === undefined) return
    // 工作台那一路把选项放在 edited_payload 里（`deck/decide.ts`：选择题 = approve_edited）；
    // 老卡（按钮还是「认领」时）批了没带选项 → 按分最高的那条（卡上排第一的就是它）
    const edited = asRecord(item.decision?.edited_payload)
    const candidates = Array.isArray(payload.candidates) ? payload.candidates : []
    const top = asRecord(candidates[0]).role_id
    const option =
      item.decision?.selected_option_id ??
      (typeof edited.selected_option_id === 'string' ? edited.selected_option_id : undefined) ??
      (typeof top === 'string' ? top : undefined)
    if (option === undefined || matter.role_id === option) return
    const by = item.decision?.by
    const person_id =
      by !== undefined && by !== 'mandate'
        ? by
        : (item.routing.explicit ?? matter.context.participants[0])
    if (person_id === undefined) return
    await reroute({ matter_id: matter.id, role_id: option, person_id, run: true })
  }

  const sayAt = async (input: {
    matter_id: MatterId
    person_id: PersonId
    text: string
  }): Promise<{ event: MatterEvent; run_id?: string } | undefined> => {
    const found = work.getMatter(input.matter_id)
    if (found === undefined || found.entry !== 'position') return undefined
    // WP291：在当场问答的线程里又说了一句 = 接着聊（它变成一段会话，进左栏会话历史）
    const matter =
      found.ask?.quick === true
        ? work.revealQuick(found.id, { kind: 'person', id: input.person_id })
        : found
    const template_id = matter.position_template_id
    if (template_id === undefined) return undefined
    // 已经定了职责：用**那条**分配接着做（请求头上带的可能是负责人那条）
    if (matter.role_id !== undefined) {
      const own =
        matter.position_id === undefined
          ? undefined
          : activeOf(input.person_id).find((a) => a.id === matter.position_id)
      if (own === undefined) return undefined
      const said = await work.say(matter.id, {
        person_id: input.person_id,
        assignment_id: own.id,
        text: input.text,
      })
      // WP287：会话里接着说的那一句真要动手了（出了卡）——同样转成任务、线程里说一句
      if (matter.ask !== undefined && said.run_id !== undefined) answerOf(matter.id, said.run_id)
      return said.run_id === undefined ? { event: said.event } : said
    }
    const template = options.positions().find((p) => p.id === template_id)
    if (template === undefined) return undefined
    const held = minePerRole(template, input.person_id)
    if (held.length === 0) return undefined
    const original = briefOf(matter)
    // ① 话里点名了哪条（「按 Reddit 运营这条来」）就是哪条
    const named = namedRole(
      input.text,
      held.map((h) => {
        const def = roles.roles.get(h.role_id)
        return {
          role_id: h.role_id,
          names: [def?.name.zh, def?.name.en].filter((n): n is string => n !== undefined),
        }
      }),
    )
    const duties = held.map((h) => ({ role_id: h.role_id, role_name: roleName(h.role_id) }))
    // ② 没点名、又只是打个招呼：记下这句话，回一句问要做什么（不起运行）
    if (named === undefined && looksLikeSmallTalk(input.text)) {
      const event = work.appendEvent(matter.id, {
        kind: 'human_message',
        text: input.text,
        actor: { kind: 'person', id: input.person_id },
      })
      askWhat(matter.id, duties)
      return { event }
    }
    // ③ 没点名：原话加这一句再路由一次；打平按分取、一个都没命中按先后取（同一个人的职责）
    // WP287：几条都沾一点也按分 / 先后取（`routeIn`），不再停下来问
    const routed =
      named === undefined ? routeIn(`${original} ${input.text}`, template, held) : undefined
    const role_id = named ?? routed?.picked
    if (role_id === undefined) {
      // ④ 还是看不出（几条都沾一点、谁都不像）：只记下这句话，再问一次。不起运行——更不落到负责人的通用助手上
      const event = work.appendEvent(matter.id, {
        kind: 'human_message',
        text: input.text,
        actor: { kind: 'person', id: input.person_id },
      })
      work.appendEvent(matter.id, {
        kind: 'status',
        text: '还没定这件事走哪条职责，先在下面选一条，选了就开始做',
        actor: { kind: 'agent', id: 'position_router' },
        ref: { type: 'position', id: template.id },
        route: {
          options: held.map((h) => ({ role_id: h.role_id, role_name: roleName(h.role_id) })),
        },
      })
      return { event }
    }
    const pinned = await reroute({ matter_id: matter.id, role_id, person_id: input.person_id })
    const said = await work.say(matter.id, {
      person_id: input.person_id,
      assignment_id: pinned.assignment_id,
      text: input.text,
      // 刚定下职责的头一次运行：把原来那件事一起带上（「开始吧」本身不是任务）
      brief: `${original}\n\n${input.text}`,
    })
    return said.run_id === undefined ? { event: said.event } : said
  }

  /**
   * WP241（docs/54 §7）：本岗位的工作项。归属规则与 `instance` 同一套——
   * 事项按 `matterInPosition`（与页头「N 件在办」同口径），待办 / 定时只取**本人**挂在
   * 这个岗位某条分配上的，卡只取本人队列里这个岗位职责上的真卡（与 `pending_cards` 同口径）。
   */
  const work_ = async (position_id: string, person_id: PersonId): Promise<PositionWorkView> => {
    const template = templateOf(position_id)
    const view = await instance(position_id, person_id)
    const duties = view.roles.flatMap((r) =>
      r.my_assignment_id === undefined || WORKSPACE_BASE_ROLES.has(r.role_id)
        ? []
        : [{ role_id: r.role_id, role_name: r.role_name, assignment_id: r.my_assignment_id }],
    )
    const mineIds = new Set(minePerRole(template, person_id).map((m) => m.assignment_id))
    const allIds = new Set(view.roles.flatMap((r) => r.assignment_ids))
    const dutyRoles = new Set(duties.map((d) => d.role_id))
    const cards = (await cardsOf(person_id)).filter(
      (i) => WAITING_STATES.has(i.state) && dutyRoles.has(i.role_id) && isDeckCard(i),
    )
    const schedules = (await options.schedules?.(person_id)) ?? []
    const running = options.runningMatters?.()
    return buildPositionWork({
      position_id: template.id,
      now: clock.now(),
      today: work.todayRange(),
      duties,
      // WP287：岗位里问的一句是会话，不进「工作」（左栏会话历史里找得到）
      matters: work
        .listMatters({ asks: false })
        .filter((m) => matterInPosition(m, position_id, allIds)),
      todos: work
        .listTodos({ owner: person_id })
        .filter((t) => t.position_id !== undefined && mineIds.has(t.position_id)),
      schedules: schedules.filter((s) => mineIds.has(s.assignment_id)),
      posts: options.socialPosts?.() ?? [],
      cards,
      roleName,
      roleOfAssignment: (id) => roles.assignments.get(id)?.role_id,
      // WP244：开着的事项看最近那一轮运行（在跑 / 答完了 / 交不出来）；不知道谁在跑就不判
      ...(running === undefined
        ? {}
        : {
            runOf: (m: Matter) => {
              const role_id =
                m.role_id ??
                (m.position_id === undefined
                  ? undefined
                  : roles.assignments.get(m.position_id)?.role_id)
              return matterRunStateOf(
                work.store.listMatterEvents(m.id, { limit: 40 }),
                running.has(m.id),
                role_id === undefined ? undefined : options.missingConnections?.(role_id),
                options.runBlockMarkedSince?.(),
              )
            },
          }),
      // 「到哪了」摘要优先；没有就拿时间线最后一句人话（运行、状态、Agent 的话）
      progressOf: (m) =>
        clip(m.context.summary) ??
        clip(
          work.store
            .listMatterEvents(m.id, { limit: 6 })
            .filter((e) => e.kind !== 'human_message' && e.text.trim() !== '')
            .at(-1)?.text,
        ),
    })
  }

  return {
    instance,
    mine,
    open,
    reroute,
    onChoiceDecided,
    promote,
    reveal,
    answers,
    sayAt,
    positionOf,
    layerContext,
    work: work_,
  }
}

/**
 * 这件事算不算挂在这个岗位下。
 *
 * 两条都算：显式记了岗位的（WP69 之后开的），以及**用这个岗位下某条分配**开的
 * （存量事项——它们没有 `position_template_id`，但 `position_id` 就是那条分配）。
 */
function matterInPosition(
  matter: Matter,
  position_id: string,
  assignmentIds: ReadonlySet<AssignmentId>,
): boolean {
  if (matter.position_template_id !== undefined) return matter.position_template_id === position_id
  return matter.position_id !== undefined && assignmentIds.has(matter.position_id)
}

/**
 * WP234（docs/54 §6.4）：岗位合并 / 移动之后，事项跟着改岗位。
 *
 * 只改 `position_template_id`（「这件事属于哪个岗位」）；`position_id`（用谁的哪条分配在做）
 * 一个字不动——分配没变，权限与额度也就没变（§5.2 第 1 条那两格各管各的）。
 * 给了 `role_id` 只动走那条职责的（移动职责：A 下面别的事留在 A）。归档的也改：
 * 它们翻出来时也该在新岗位下。回改了几件。
 */
export function retargetPositionMatters(
  work: Work,
  input: { from: string; to: string; role_id?: RoleId; to_name?: string },
  now: string,
): number {
  let moved = 0
  // WP291：当场问答也跟着改（它们只在「记录」里，默认列表不见它们）
  for (const m of [...work.listMatters({}), ...work.listMatters({ quick: true })]) {
    if (m.position_template_id !== input.from) continue
    if (input.role_id !== undefined && m.role_id !== input.role_id) continue
    work.store.putMatter({ ...m, position_template_id: input.to, updated_at: now })
    work.appendEvent(m.id, {
      kind: 'status',
      text:
        input.to_name === undefined
          ? '岗位调整：这件事跟着改归了新的岗位'
          : `岗位调整：这件事改归「${input.to_name}」`,
      actor: { kind: 'system', id: 'org' },
      ref: { type: 'position', id: input.to },
    })
    moved += 1
  }
  return moved
}

/** WP237：「这件事该走哪条职责」那张卡（判据在 deck 层，投影与回调同一个）。 */
export const isRouteChoice = isRouteChoiceItem

/** 选择卡上的选项：按钮就是候选职责（「走「Reddit 运营」」）。 */

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {}
}
