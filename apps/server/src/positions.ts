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
import { isTaskBrief, taskTextOf } from '@agentsws/contracts'
import { isQueueCard, isRouteChoiceItem } from '@agentsws/deck'
import {
  bundledPositionIcon,
  looksLikeSmallTalk,
  namedRole,
  RoleError,
  type RoleStore,
  type RouteCandidate,
  type RouteRoleProfile,
  roleRouteTerms,
  routeWithinPosition,
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
}

export interface OpenAtPositionResult {
  matter: Matter
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
      .listMatters({ status: ['open', 'waiting'] })
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
    const pending_cards = cards.filter(
      (i) =>
        WAITING_STATES.has(i.state) &&
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
      .listMatters({ status: ['open', 'waiting'], archived: false })
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

  /** 拿不准时的那张选择卡（14 的 `claim` 类；四段式：这件事像 A 也像 B，你定）。 */
  const choiceCard = async (input: {
    matter: Matter
    person_id: PersonId
    position: Position
    candidates: RouteCandidate[]
    reason: string
    role_id: RoleId
  }): Promise<string | undefined> => {
    const item = await options.approvals.create({
      workspace_id,
      schema_version: 1,
      kind: 'claim',
      role_id: input.role_id,
      subject: {
        object: { type: 'position', id: input.position.id },
        matter_id: input.matter.id,
        work_item_id: input.matter.id,
      },
      dedupe_key: `${workspace_id}:route_choice:${input.matter.id}`,
      title: `这件事该走哪条职责：${input.matter.title}`,
      summary: input.reason,
      payload: {
        form: 'route_choice',
        matter_id: input.matter.id,
        position_id: input.position.id,
        position_name: input.position.name.zh,
        candidates: input.candidates.map((c) => ({
          role_id: c.role_id,
          role_name: c.role_name,
          score: c.score,
          why: c.why,
        })),
        // WP237：卡上的按钮就是这几条职责（工作台按 `payload.options` 出选项，36 §2）
        options: choiceOptions(input.candidates),
      },
      evidence: {
        source_events: [],
        provenance: { seen: [{ type: 'position', id: input.position.id }] },
        precheck: { fencing: 'ok' },
      },
      proposer: { kind: 'agent', id: 'position_router' },
      automation: {
        level_at_creation: 'L1',
        auto_approved: false,
        mandate_check: { within: true, caps_hit: [] },
        sampling: { selected: false },
      },
      routing: {
        recipients: [{ person: input.person_id, via: 'explicit' }],
        explicit: input.person_id,
        rule: 'explicit',
        escalation: { after_hours: 24, business_hours: true, chain: ['owner'], escalated_at: [] },
        separation_of_duties: false,
      },
      priority: 'queue',
      // 选了哪条职责就用哪条起 Run（`POST /v1/matters/:id/reroute` 也走同一条路）
      options: choiceOptions(input.candidates),
    })
    return item.state === 'blocked' ? undefined : item.id
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
     * 不在请求人自己名下 → 拒。指定得成立，路由就不掺和（拿不准的那条路也就走不到）。
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
    const order = held.map((h) => h.role_id)
    const named = held.map((h) => ({ role_id: h.role_id, role_name: roleName(h.role_id) }))
    // WP237（Fable 代定）：「你好」这类明显不是交活的话——不起运行、不出卡，只回一句问要做什么
    const smallTalk = pinned === undefined && looksLikeSmallTalk(text)
    const routed =
      pinned === undefined && smallTalk
        ? {
            candidates: [],
            ambiguous: true,
            reason: '像是打个招呼，还没说要做什么',
          }
        : pinned === undefined
          ? settleNoHit(
              // WP117b（66 复测 #17）：路由那句话要与岗位页标题上的数字对得上。
              // 递进去的是 WP125 那份滤掉 `common.member` 的清单（`dutyRolesOf`），
              // 也就是岗位页「N 条职责」读的同一份——两处一个来源，不会再打架。
              //
              // WP237：参赛的全是**请求人自己名下**的职责（54 §4），所以候选永远是同一个人的——
              // 打平（前两名都够像、只是分不开）不再问人，按分高的那条直接做（`settleCloseCall`）。
              //
              // WP237（Fable 代定）：一个判据词都没命中（「看看这周」）也不问人——按岗位里职责的先后
              // 取第一条直接做，其余几条留作「换成」（`settleNoHit`）。
              settleCloseCall(
                routeWithinPosition(text, profilesOf(held), {
                  duty_count: dutyRolesOf(template).length,
                }),
                order,
              ),
              named,
            )
          : {
              picked: pinned,
              candidates: [],
              ambiguous: false,
              reason: `按「${roleName(pinned)}」这条职责的快捷提示开的，没走岗位内路由`,
            }
    const pickedEntry =
      routed.picked === undefined ? undefined : held.find((h) => h.role_id === routed.picked)

    const matter = work.createMatter({
      kind: 'adhoc',
      title: input.title,
      entry: 'position',
      position_template_id: template.id,
      participants: [input.person_id],
      ...(input.summary === undefined ? {} : { summary: input.summary }),
      ...(input.pinned === undefined ? {} : { pinned: input.pinned }),
      // 判准了就钉在那条分配上；拿不准时先不钉——没有职责就没有权限，这一点不能含糊
      ...(pickedEntry === undefined
        ? {}
        : { position_id: pickedEntry.assignment_id, role_id: pickedEntry.role_id }),
    })

    const settled = 'settled' in routed && routed.settled === true
    const alternatives = 'alternatives' in routed ? (routed.alternatives ?? []) : []
    emit('matter.routed', matter.id, input.person_id, {
      position_id: template.id,
      ...(routed.picked === undefined ? {} : { picked: routed.picked }),
      ambiguous: routed.ambiguous,
      // WP237：没问人、自己定的——打平按分取（top_score）或一个都没命中按先后取（first_duty）
      ...(settled
        ? { settled: routed.candidates.every((c) => c.score === 0) ? 'first_duty' : 'top_score' }
        : {}),
      // 判据词与原话不进日志（21 §1）：只有 id 与分数
      candidates: routed.candidates.map((c) => ({ role_id: c.role_id, score: c.score })),
    })

    if (pickedEntry === undefined && smallTalk) {
      work.appendEvent(matter.id, {
        kind: 'human_message',
        text,
        actor: { kind: 'person', id: input.person_id },
      })
      askWhat(matter.id, named)
      return { matter, candidates: [], ambiguous: true, reason: routed.reason }
    }

    if (pickedEntry === undefined) {
      const first = held[0]
      const candidates =
        routed.candidates.length > 0
          ? routed.candidates
          : held.map((h) => ({
              role_id: h.role_id,
              role_name: roleName(h.role_id),
              score: 0,
              why: [],
            }))
      // WP237：没定职责时，原话也进时间线（事后在事项页选、或者续一句话时，按它起运行）
      work.appendEvent(matter.id, {
        kind: 'human_message',
        text,
        actor: { kind: 'person', id: input.person_id },
      })
      const approval_item_id = await choiceCard({
        matter,
        person_id: input.person_id,
        position: template,
        candidates,
        reason: routed.reason,
        role_id: first?.role_id ?? 'common.member',
      })
      // 路由结果进事项时间线；还没定时这一条下面就是那几条职责的按钮（WP237：事项页上也能选）
      work.appendEvent(matter.id, {
        kind: 'status',
        text: routed.reason,
        actor: { kind: 'agent', id: 'position_router' },
        ref: { type: 'position', id: template.id },
        route: { options: candidates.map((c) => ({ role_id: c.role_id, role_name: c.role_name })) },
        ...(approval_item_id === undefined ? {} : { approval_item_id }),
      })
      return {
        matter,
        candidates: routed.candidates,
        ambiguous: true,
        reason: routed.reason,
        ...(approval_item_id === undefined ? {} : { approval_item_id }),
      }
    }

    // 路由结果进事项时间线（候选与判据都在这一条上，界面直接拿来显示"路由到 X · 换"）。
    // WP237：打平按分取的那一条下面挂「换成 B」（一键改派并重跑）
    work.appendEvent(matter.id, {
      kind: 'status',
      text: routed.reason,
      actor: { kind: 'agent', id: 'position_router' },
      ref: { type: 'position', id: template.id },
      ...(alternatives.length === 0
        ? {}
        : {
            route: {
              picked: pickedEntry.role_id,
              options: alternatives.map((c) => ({ role_id: c.role_id, role_name: c.role_name })),
            },
          }),
    })

    // 起 Run：用的是**被路由到的那条职责**的 Assignment（权限 / 额度 / 技能全是它的）
    const said = await work.say(matter.id, {
      person_id: input.person_id,
      assignment_id: pickedEntry.assignment_id,
      text,
    })
    return {
      matter: work.getMatter(matter.id) ?? matter,
      picked: {
        role_id: pickedEntry.role_id,
        role_name: roleName(pickedEntry.role_id),
        assignment_id: pickedEntry.assignment_id,
      },
      candidates: routed.candidates,
      ambiguous: false,
      reason: routed.reason,
      ...(said.run_id === undefined ? {} : { run_id: said.run_id }),
    }
  }

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
    const matter = work.getMatter(input.matter_id)
    if (matter === undefined || matter.entry !== 'position') return undefined
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
    const routed =
      named === undefined
        ? settleNoHit(
            settleCloseCall(
              routeWithinPosition(`${original} ${input.text}`, profilesOf(held), {
                duty_count: dutyRolesOf(template).length,
              }),
              held.map((h) => h.role_id),
            ),
            duties,
          )
        : undefined
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
      matters: work.listMatters({}).filter((m) => matterInPosition(m, position_id, allIds)),
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
  for (const m of work.listMatters({})) {
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
function choiceOptions(candidates: readonly RouteCandidate[]): { id: string; label: string }[] {
  return candidates.map((c) => ({ id: c.role_id, label: `走「${c.role_name}」` }))
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {}
}
