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
  MatterId,
  PersonId,
  Position,
  PositionInstance,
  RoleId,
  WorkspaceId,
} from '@agentsws/contracts'
import {
  RoleError,
  type RoleStore,
  type RouteCandidate,
  type RouteRoleProfile,
  roleRouteTerms,
  routeWithinPosition,
} from '@agentsws/roles'
import type { Work } from '@agentsws/work'

const POSITION_ERROR = (
  code: 'not_found' | 'conflict' | 'invalid_input' | 'forbidden',
  msg: string,
): RoleError => new RoleError(code, msg)

/** 还等着人定的卡（与工作台面同一个口径）。 */
const WAITING_STATES = new Set(['pending', 'in_review'])

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
  appendEvent(e: Omit<EventEnvelope, 'id' | 'at'> & { at?: string }): void
}

export interface OpenAtPositionInput {
  position_id: string
  person_id: PersonId
  title: string
  summary?: string
  /** 关联对象引用（订单 / 客户 / 文件…），原样钉在事项上 */
  pinned?: { type: string; id: string }[]
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
  /** 手动换职责：换后新的 Run 走新职责，旧 Run 不动。 */
  reroute(input: {
    matter_id: MatterId
    role_id: RoleId
    person_id: PersonId
  }): Promise<{ matter: Matter; assignment_id: AssignmentId }>
  /**
   * 一条职责属于哪个岗位（起 Run 拼 `position` 技能层时要它）。
   * 挂在多个岗位里、或者一个都没有时回 `undefined` 并给一句话——由调用方写进时间线。
   */
  positionOf(role_id: RoleId): { position_id?: string; note?: string }
  /** 岗位层上下文的三样（54 §3）。 */
  layerContext(position_id: string, person_id: PersonId): Promise<PositionLayerContext | undefined>
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

  /** 这个岗位下、**这个人**持有的那几条分配（路由只在它们里面挑）。 */
  const minePerRole = (
    position: Position,
    person_id: PersonId,
  ): { role_id: RoleId; assignment_id: AssignmentId }[] => {
    const held = activeOf(person_id)
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

  const instance = async (position_id: string, person_id: PersonId): Promise<PositionInstance> => {
    const template = templateOf(position_id)
    // 谁在做：默认包里的职责都在他名下才算（05 §2；与 org.ts 的 holdersOf 同一条规则）
    const wanted = template.roles.filter((r) => r.default).map((r) => r.role)
    const byRole = new Map<RoleId, AssignmentId[]>()
    const holders = new Set<PersonId>()
    for (const entry of template.roles) {
      const rows = roles.assignments
        .listByRole(entry.role, { workspace_id })
        .filter((a) => a.revoked_at === undefined)
      byRole.set(
        entry.role,
        rows.map((a) => a.id),
      )
      for (const a of rows) {
        const held = activeOf(a.person_id)
        if (wanted.length > 0 && wanted.every((r) => held.some((h) => h.role_id === r)))
          holders.add(a.person_id)
      }
    }
    const assignmentIds = new Set([...byRole.values()].flat())
    const open_matters = work
      .listMatters({ status: ['open', 'waiting'] })
      .filter((m) => matterInPosition(m, position_id, assignmentIds)).length
    const cards = await cardsOf(person_id)
    const pending_cards = cards.filter(
      (i) => WAITING_STATES.has(i.state) && assignmentIds.has(i.proposer.assignment_id ?? ''),
    ).length
    return {
      position_id: template.id,
      workspace_id,
      name: { ...template.name },
      template_version: template.version,
      holders: [...holders].sort(),
      roles: template.roles.map((r) => ({
        role_id: r.role,
        role_name: roleName(r.role),
        default: r.default,
        assignment_ids: byRole.get(r.role) ?? [],
      })),
      open_matters,
      pending_cards,
      memory_summary: options.memorySummary?.(template.id) ?? '',
    }
  }

  const mine = async (person_id: PersonId): Promise<PositionInstance[]> => {
    const held = new Set(activeOf(person_id).map((a) => a.role_id))
    const out: PositionInstance[] = []
    for (const template of options.positions()) {
      if (!template.roles.some((r) => held.has(r.role))) continue
      out.push(await instance(template.id, person_id))
    }
    return out
  }

  const positionOf = (role_id: RoleId): { position_id?: string; note?: string } => {
    const hits = options.positions().filter((p) => p.roles.some((r) => r.role === role_id))
    const only = hits[0]
    if (only === undefined || hits.length === 0)
      return { note: `「${roleName(role_id)}」不在任何岗位模板里，这次运行跳过岗位层` }
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
    const open_matters = work
      .listMatters({ status: ['open', 'waiting'] })
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
      options: input.candidates.map((c) => ({ id: c.role_id, label: c.role_name })),
    })
    return item.state === 'blocked' ? undefined : item.id
  }

  const open = async (input: OpenAtPositionInput): Promise<OpenAtPositionResult> => {
    const template = templateOf(input.position_id)
    const held = minePerRole(template, input.person_id)
    if (held.length === 0)
      throw POSITION_ERROR(
        'forbidden',
        `你名下没有「${template.name.zh}」这个岗位下的任何一条职责，开不了这里的事`,
      )
    const text = input.summary === undefined ? input.title : `${input.title} ${input.summary}`
    const routed = routeWithinPosition(text, profilesOf(held))
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

    // 路由结果进事项时间线（候选与判据都在这一条上，界面直接拿来显示"路由到 X · 换"）
    work.appendEvent(matter.id, {
      kind: 'status',
      text: routed.reason,
      actor: { kind: 'agent', id: 'position_router' },
      ref: { type: 'position', id: template.id },
    })
    emit('matter.routed', matter.id, input.person_id, {
      position_id: template.id,
      ...(routed.picked === undefined ? {} : { picked: routed.picked }),
      ambiguous: routed.ambiguous,
      // 判据词与原话不进日志（21 §1）：只有 id 与分数
      candidates: routed.candidates.map((c) => ({ role_id: c.role_id, score: c.score })),
    })

    if (pickedEntry === undefined) {
      const first = held[0]
      const approval_item_id = await choiceCard({
        matter,
        person_id: input.person_id,
        position: template,
        candidates:
          routed.candidates.length > 0
            ? routed.candidates
            : held.map((h) => ({
                role_id: h.role_id,
                role_name: roleName(h.role_id),
                score: 0,
                why: [],
              })),
        reason: routed.reason,
        role_id: first?.role_id ?? 'common.member',
      })
      return {
        matter,
        candidates: routed.candidates,
        ambiguous: true,
        reason: routed.reason,
        ...(approval_item_id === undefined ? {} : { approval_item_id }),
      }
    }

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

  const reroute = async (input: {
    matter_id: MatterId
    role_id: RoleId
    person_id: PersonId
  }): Promise<{ matter: Matter; assignment_id: AssignmentId }> => {
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
    return { matter: next, assignment_id: hit.assignment_id }
  }

  return { instance, mine, open, reroute, positionOf, layerContext }
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
