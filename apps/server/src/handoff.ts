/**
 * WP276（docs/95 §4.3，决策 241 / 242）：**交给对方**的服务端装配——一个品牌一份。
 *
 * 交接本身（谁是主人、什么时候退回）在 `@agentsws/work`；这一层做四件 work 包做不了的事：
 *
 * 1. **出卡**：对方收一张 `claim` 卡（`form: 'handoff'`）——名字不是 id，带摘要 / 截止 / 做到哪了 /
 *    留言；选项是**他自己的岗位**（只有一个就是一个「接下」），「不接」理由可选。
 * 2. **接下时换分配**：之后的运行用接手人那条分配（职责规矩、模型设置都是他的，用量记他名下）。
 * 3. **未定的卡跟事走**（决策 242）：这件事上还等发起人定的卡改派给接手人；发起人已经点开、
 *    改了一半的（`in_review` 且他是 assignee）留给发起人做完。
 * 4. **收卡**：撤回、到点退回时把对方那张卡一起收掉（撤回 = withdrawn）。
 *
 * 名字一律经身份层翻（`label`），时间线、卡面、回给界面的视图里都不出现人员 id。
 */
import type {
  ColleagueView,
  HandoffActor,
  HandoffKind,
  HandoffLists,
  HandoffPort,
  HandoffView,
  MyWorkExport,
  WorkPort,
} from '@agentsws/api'
import { ApiError } from '@agentsws/api'
import type {
  ApprovalBus,
  ApprovalItem,
  AssignmentId,
  Handoff,
  Matter,
  PersonId,
  PositionInstance,
  RoleId,
  Todo,
  WorkspaceId,
} from '@agentsws/contracts'
import { HANDOFF_DECLINE_NO_REASON, isHandoffItem } from '@agentsws/deck'
import {
  claimOf,
  type HandoffItem,
  type HandoffRef,
  isHandoffPending,
  type Work,
  WorkError,
} from '@agentsws/work'

/** 只给人看的底座职责（不算一个可以接活的岗位）。 */
const BASE_ROLES = new Set<RoleId>(['common.member', 'common.owner'])

/** 卡上的一个选项：用哪条分配接下（以及那条分配属于哪个岗位）。 */
interface TakeOption {
  id: AssignmentId
  label: string
  role_id: RoleId
  position_template_id?: string
}

export interface HandoffOptions {
  workspace_id: WorkspaceId
  work: Work
  approvals: ApprovalBus
  /** 人名（翻不出来回 undefined——那就写「同事」，不印 id）。 */
  personName(id: PersonId): Promise<string | undefined>
  /** 这个品牌里还在的人（不含离开的）。 */
  members(): Promise<PersonId[]>
  /** 这个人在这个品牌里做的岗位（岗位页那一份）。 */
  positionsOf(person: PersonId): Promise<PositionInstance[]>
  /** 一条分配是谁的、哪条职责（撤销了回 undefined）。 */
  assignment(id: AssignmentId): { person_id: PersonId; role_id: RoleId } | undefined
  /** 交出去几天没人理退回（「设置 → 通用」那一格）。 */
  days(): number
  /** 发起人（组织所有者）——团队页上标一个小字。 */
  initiator?(): PersonId | undefined
  /**
   * WP276（决策 238）：这个月这个品牌的模型用量（本机事件日志里的 `model.usage`，只有数字）。
   * 不给 = 不出「按人用量」。
   */
  usage?(): { assignment_id: string; input_tokens: number; output_tokens: number }[]
  /**
   * WP277（决策 241）：③ 公司集体里 `from` 是 `to` 哪几个岗位的上级（回那几个岗位的模板 id）。
   * 回非空 = 这一次是**上级派给下属**：直接生效，不出「接下 / 不接」那张卡。不是 ③、不是上级回空；
   * 不给 = 一律按交给对方（要对方接下）。
   */
  supervisedBy?(from: PersonId, to: PersonId): Promise<readonly string[]>
}

export interface HandoffAssembly extends HandoffPort {
  /** 交给对方那张卡有了决定（审批总线 decide 之后调）。 */
  onDecided(item: ApprovalItem): Promise<void>
  /** 到点退回（读首页 / 待办 / 事项时顺手跑——懒扫，不起定时器，同 WP207 归档）。 */
  sweep(): Promise<number>
  /** 已经落成「交出去」、还没出卡的（撞车时「交给他」）补一张卡。 */
  adopt(actor: HandoffActor, ref: HandoffRef): Promise<void>
  /**
   * WP276（docs/95 §3.6「某人退出 ②」）：有人退出 / 被请离开——他手上的事退回原处：
   * 交给他还没接的退回发起人、他交出去还没接的撤回、从待认领池认下的回池、别人交给他的再交还给
   * 原来那个人（要对方接下）。别的留在品牌里（共享的东西留下）。回动了几件。
   */
  release(person: PersonId, by: PersonId): Promise<number>
  /** 这个人在这个品牌里参与过的事项（含时间线）与名下的待办——退出时带走一份副本。 */
  exportOf(person: PersonId): MyWorkExport
}

const isAccepted = (item: ApprovalItem): boolean =>
  item.state === 'approved' || item.state === 'approved_edited' || item.state === 'applied'

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {}
}

/** 卡上的选项（或老卡没有选项时）选的是哪条分配。 */
function pickedOption(item: ApprovalItem): string | undefined {
  const edited = asRecord(item.decision?.edited_payload)
  const picked =
    item.decision?.selected_option_id ??
    (typeof edited.selected_option_id === 'string' ? edited.selected_option_id : undefined)
  return picked === '' ? undefined : picked
}

export function createHandoff(options: HandoffOptions): HandoffAssembly {
  const { work, approvals, workspace_id } = options

  /** 一次请求内的人名缓存（时间线、卡面、视图都要翻）。 */
  const namesFor = async (ids: readonly PersonId[]): Promise<(id: PersonId) => string> => {
    const map = new Map<PersonId, string>()
    for (const id of new Set(ids)) map.set(id, (await options.personName(id)) ?? '同事')
    return (id) => map.get(id) ?? '同事'
  }

  const refOf = (kind: HandoffKind, id: string): HandoffRef => ({ kind, id })

  const wrap = <T>(fn: () => T): T => {
    try {
      return fn()
    } catch (err) {
      if (err instanceof WorkError)
        throw new ApiError(err.code, err.message, { details: err.details })
      throw err
    }
  }

  /** 事项最早到期的那条未完待办 / 待办自己的截止。 */
  const dueOf = (item: HandoffItem): string | undefined => {
    if (item.ref.kind === 'todo') return item.due
    const dues = work
      .listTodos({ matter_id: item.ref.id, status: ['open', 'doing', 'blocked'] })
      .map((t) => t.due)
      .filter((d): d is string => d !== undefined)
      .sort()
    return dues[0]
  }

  /** 做到哪了：一句话（数在服务端算，29 原则 ③）。 */
  const progressOf = (item: HandoffItem): string | undefined => {
    const matter_id = item.ref.kind === 'matter' ? item.ref.id : undefined
    if (matter_id === undefined) return undefined
    const todos = work.listTodos({ matter_id })
    const runs = work.store
      .listMatterEvents(matter_id, { limit: 500 })
      .filter((e) => e.kind === 'run')
    const parts: string[] = []
    if (todos.length > 0)
      parts.push(`待办 ${todos.filter((t) => t.status === 'done').length}/${todos.length} 做完`)
    if (runs.length > 0) parts.push(`AI 做过 ${runs.length} 轮`)
    return parts.length === 0 ? undefined : parts.join('，')
  }

  const viewOf = async (item: HandoffItem): Promise<HandoffView> => {
    const name = await namesFor([item.handoff.from, item.handoff.to])
    const due = dueOf(item)
    const progress = progressOf(item)
    return {
      kind: item.ref.kind,
      id: item.ref.id,
      title: item.title,
      handoff: item.handoff,
      from_label: name(item.handoff.from),
      to_label: name(item.handoff.to),
      status: item.status,
      ...(item.matter_id === undefined ? {} : { matter_id: item.matter_id }),
      ...(item.summary === undefined || item.summary === '' ? {} : { summary: item.summary }),
      ...(due === undefined ? {} : { due }),
      ...(progress === undefined ? {} : { progress }),
    }
  }

  const itemOf = (ref: HandoffRef): HandoffItem => {
    if (ref.kind === 'matter') {
      const m = work.requireMatter(ref.id)
      if (m.handoff === undefined) throw new ApiError('not_found', '这件事没交给过谁')
      return {
        ref,
        title: m.title,
        handoff: m.handoff,
        matter_id: m.id,
        summary: m.context.summary,
        status: m.status,
      }
    }
    const t = work.requireTodo(ref.id)
    if (t.handoff === undefined) throw new ApiError('not_found', '这条没交给过谁')
    return {
      ref,
      title: t.title,
      handoff: t.handoff,
      status: t.status,
      ...(t.matter_id === undefined ? {} : { matter_id: t.matter_id }),
      ...(t.note === undefined ? {} : { summary: t.note }),
      ...(t.due === undefined ? {} : { due: t.due }),
    }
  }

  /**
   * 接手人能用哪几条分配接：每个**他在做的岗位**一个选项（底座职责不算）。
   * 这件事原来是哪条职责、他在那个岗位里也做这条，就用这一条；否则用那个岗位里他的第一条。
   */
  const optionsFor = async (person: PersonId, ref: HandoffRef): Promise<TakeOption[]> => {
    const wanted = ref.kind === 'matter' ? work.getMatter(ref.id)?.role_id : undefined
    const template =
      ref.kind === 'matter' ? work.getMatter(ref.id)?.position_template_id : undefined
    const out: TakeOption[] = []
    for (const p of await options.positionsOf(person)) {
      const mine = p.roles.filter(
        (r) => r.my_assignment_id !== undefined && !BASE_ROLES.has(r.role_id),
      )
      const hit = mine.find((r) => r.role_id === wanted) ?? mine[0]
      if (hit?.my_assignment_id === undefined) continue
      out.push({
        id: hit.my_assignment_id,
        label: p.name.zh,
        role_id: hit.role_id,
        position_template_id: p.position_id,
      })
    }
    // 原来那个岗位排第一（卡上第一个按钮就是它）
    return out.sort(
      (a, b) =>
        Number(b.position_template_id === template) - Number(a.position_template_id === template),
    )
  }

  /** 出那张「X 想把「…」交给你」的卡；回卡 id（被预检拦下回 undefined）。 */
  const issueCard = async (ref: HandoffRef, actor: HandoffActor): Promise<string | undefined> => {
    const item = itemOf(ref)
    const h = item.handoff
    const name = await namesFor([h.from, h.to])
    const takes = await optionsFor(h.to, ref)
    const view = await viewOf(item)
    const facts = [
      view.summary === undefined ? undefined : `到哪了：${view.summary}`,
      view.progress,
      view.due === undefined ? undefined : `截止 ${view.due.slice(0, 10)}`,
    ].filter((x): x is string => x !== undefined)
    const role_id =
      takes[0]?.role_id ?? options.assignment(actor.assignment_id)?.role_id ?? 'common.member'
    const card = await approvals.create({
      workspace_id,
      schema_version: 1,
      kind: 'claim',
      role_id,
      subject: {
        object: { type: ref.kind, id: ref.id },
        ...(item.matter_id === undefined
          ? {}
          : { matter_id: item.matter_id, work_item_id: item.matter_id }),
        ...(ref.kind === 'todo' ? { todo_id: ref.id } : {}),
      },
      dedupe_key: `${workspace_id}:handoff:${ref.kind}:${ref.id}:${h.at}`,
      title: `${name(h.from)}想把「${item.title}」交给你`,
      // 留言是发起人的原话，排第一；没写就是事项摘要 / 进度
      summary: h.note ?? (facts.join('；') || '接下以后这件事就是你的了。'),
      payload: {
        form: 'handoff',
        object: ref.kind,
        id: ref.id,
        title: item.title,
        from_label: name(h.from),
        ...(h.note === undefined ? {} : { note: h.note }),
        ...(view.summary === undefined ? {} : { matter_summary: view.summary }),
        ...(view.progress === undefined ? {} : { progress: view.progress }),
        ...(view.due === undefined ? {} : { due: view.due }),
        expires_at: h.expires_at,
        // 只有一个岗位：一个「接下」；几个岗位：每个一个按钮（docs/95 §4.3 第 3 步）
        options:
          takes.length <= 1
            ? [{ id: takes[0]?.id ?? 'self', label: '接下' }]
            : takes.map((o) => ({ id: o.id, label: `用「${o.label}」接下` })),
        takes: takes.map((o) => ({
          id: o.id,
          role_id: o.role_id,
          ...(o.position_template_id === undefined
            ? {}
            : { position_template_id: o.position_template_id }),
        })),
      },
      evidence: {
        source_events: [],
        provenance: { seen: [{ type: ref.kind, id: ref.id }] },
        precheck: { fencing: 'ok' },
      },
      proposer: { kind: 'person', id: h.from },
      automation: {
        level_at_creation: 'L1',
        auto_approved: false,
        mandate_check: { within: true, caps_hit: [] },
        sampling: { selected: false },
      },
      routing: {
        recipients: [{ person: h.to, via: 'explicit' }],
        explicit: h.to,
        rule: 'explicit',
        // ① ② 没有升级链：没人理只提醒他本人，到点由交接自己退回
        escalation: { after_hours: 24, business_hours: true, chain: [], escalated_at: [] },
        separation_of_duties: false,
      },
      priority: 'queue',
      expires_at: h.expires_at,
    })
    return card.state === 'blocked' ? undefined : card.id
  }

  /** 收掉对方那张卡（撤回 / 退回之后）。卡已经没了或定过了就算了。 */
  const retire = async (h: Handoff | undefined, by: PersonId): Promise<void> => {
    if (h?.card_id === undefined) return
    const card = await approvals.get(h.card_id)
    if (card === undefined || (card.state !== 'pending' && card.state !== 'in_review')) return
    try {
      await approvals.withdraw(card.id, by)
    } catch {
      // 卡收不掉不影响交接本身（对方点了也会回「已经不在等你接了」）
    }
  }

  /**
   * 决策 242：这件事上还等发起人定的卡跟着走——改派给接手人。发起人已经点开、改了一半的
   * （`in_review` 且他是 assignee）留给他做完。回改派了几张。
   */
  const moveCards = async (ref: HandoffRef, h: Handoff, title: string): Promise<number> => {
    if (approvals.reroute === undefined) return 0
    const matter_id = ref.kind === 'matter' ? ref.id : undefined
    const mine = (await approvals.queue({
      workspace_id,
      person_id: h.from,
      lane: 'mine',
      state: ['pending', 'in_review'],
    })) as ApprovalItem[]
    let moved = 0
    for (const card of mine) {
      if (isHandoffItem(card)) continue
      const onIt =
        matter_id !== undefined
          ? (card.subject.matter_id ?? card.subject.work_item_id) === matter_id
          : card.subject.todo_id === ref.id
      if (!onIt) continue
      if (card.state === 'in_review' && card.routing.assignee === h.from) continue
      const out = await approvals.reroute(card.id, {
        from: h.from,
        to: h.to,
        via: 'explicit',
        reason: `跟着「${title}」一起交给了你`,
      })
      if (out !== undefined) moved += 1
    }
    return moved
  }

  /** 接下：换分配 → 改派未定的卡 → 记交接结果。 */
  const accept = async (
    ref: HandoffRef,
    person: PersonId,
    picked: string | undefined,
    takes?: { id: string; role_id?: string; position_template_id?: string }[],
    dispatched = false,
  ): Promise<Matter | Todo> => {
    const item = itemOf(ref)
    const h = item.handoff
    if (!isHandoffPending(h))
      throw new ApiError('conflict', '这件事已经不在等你接了', { details: { state: h.state } })
    if (h.to !== person) throw new ApiError('forbidden', '这件事不是交给你的')
    const choices = takes ?? (await optionsFor(person, ref))
    const chosen =
      choices.find((o) => o.id === picked) ?? (choices.length === 1 ? choices[0] : undefined)
    if (picked !== undefined && picked !== 'self' && chosen === undefined && choices.length > 1)
      throw new ApiError('invalid_input', '选的岗位不在你名下')
    const asg = chosen === undefined ? undefined : options.assignment(chosen.id)
    if (chosen !== undefined && asg?.person_id !== person)
      throw new ApiError('forbidden', '这条分配不是你的')
    const moved = await moveCards(ref, h, item.title)
    const name = await namesFor([h.from, h.to])
    return wrap(() =>
      work.acceptHandoff(ref, {
        person,
        label: name,
        cards_moved: moved,
        ...(dispatched ? { dispatched: true } : {}),
        ...(chosen === undefined
          ? {}
          : {
              position_id: chosen.id,
              ...(ref.kind === 'matter'
                ? {
                    role_id: asg?.role_id ?? chosen.role_id,
                    ...(chosen.position_template_id === undefined
                      ? {}
                      : { position_template_id: chosen.position_template_id }),
                  }
                : {}),
            }),
      }),
    )
  }

  const adopt = async (actor: HandoffActor, ref: HandoffRef): Promise<void> => {
    const h = itemOf(ref).handoff
    if (!isHandoffPending(h) || h.card_id !== undefined) return
    const card_id = await issueCard(ref, actor)
    if (card_id !== undefined) work.attachHandoffCard(ref, card_id)
  }

  const sweep = async (): Promise<number> => {
    const name = await namesFor(await options.members())
    const returned = work.expireHandoffs(name)
    for (const r of returned) await retire(r.handoff, r.handoff.from)
    return returned.length
  }

  return {
    async offer(actor, kind, id, input) {
      const ref = refOf(kind, id)
      const members = await options.members()
      if (!members.includes(input.to))
        throw new ApiError('invalid_input', '只能交给这个品牌里的同事')
      const name = await namesFor([actor.person_id, input.to])
      wrap(() =>
        work.offer(ref, {
          from: actor.person_id,
          to: input.to,
          note: input.note,
          days: options.days(),
          label: name,
        }),
      )
      /*
       * WP277（决策 241）：③ 里上级给下属是「派」——直接生效，不出卡、不用对方接；用的是他在
       * 这位上级管的那个岗位（几个就挑第一个对得上的）。平级之间照 WP276 交给对方。
       */
      const led = (await options.supervisedBy?.(actor.person_id, input.to)) ?? []
      if (led.length > 0) {
        const choices = await optionsFor(input.to, ref)
        const chosen =
          choices.find(
            (o) => o.position_template_id !== undefined && led.includes(o.position_template_id),
          ) ?? choices[0]
        await accept(ref, input.to, chosen?.id, choices, true)
        return viewOf(itemOf(ref))
      }
      const card_id = await issueCard(ref, actor)
      if (card_id !== undefined) work.attachHandoffCard(ref, card_id)
      return viewOf(itemOf(ref))
    },

    async accept(actor, kind, id, input) {
      const ref = refOf(kind, id)
      const before = itemOf(ref).handoff
      await accept(ref, actor.person_id, input.position_id)
      // 卡还开着（从事项页上点的「接下」）就一起收掉——事已经接了
      await retire(before, actor.person_id)
      return viewOf(itemOf(ref))
    },

    async decline(actor, kind, id, input) {
      const ref = refOf(kind, id)
      const before = itemOf(ref).handoff
      const name = await namesFor([before.from, before.to])
      wrap(() =>
        work.declineHandoff(ref, { person: actor.person_id, reason: input.reason, label: name }),
      )
      await retire(before, actor.person_id)
      return viewOf(itemOf(ref))
    },

    async withdraw(actor, kind, id) {
      const ref = refOf(kind, id)
      const before = itemOf(ref).handoff
      wrap(() => work.withdrawHandoff(ref, { by: actor.person_id }))
      await retire(before, actor.person_id)
      return viewOf(itemOf(ref))
    },

    seen(actor, kind, id) {
      wrap(() => work.markHandoffSeen(refOf(kind, id), actor.person_id))
      return { ok: true as const }
    },

    async list(actor, opts): Promise<HandoffLists> {
      await sweep()
      const to_me = await Promise.all(work.handoffsTo(actor.person_id).map(viewOf))
      const from_me = await Promise.all(
        work.handoffsFrom(actor.person_id, { all: opts.all === true }).map(viewOf),
      )
      const dispatched = await Promise.all(work.handoffsDispatchedTo(actor.person_id).map(viewOf))
      return { to_me, from_me, ...(dispatched.length === 0 ? {} : { dispatched }) }
    },

    async colleagues(actor): Promise<ColleagueView[]> {
      const busy = new Map<PersonId, number>()
      for (const i of work.inProgress()) busy.set(i.owner, (busy.get(i.owner) ?? 0) + 1)
      const initiator = options.initiator?.()
      const out: ColleagueView[] = []
      for (const person_id of await options.members()) {
        if (person_id === actor.person_id) continue
        const n = busy.get(person_id) ?? 0
        out.push({
          person_id,
          name: (await options.personName(person_id)) ?? '同事',
          in_progress: n,
          load: n === 0 ? '空着' : `手上 ${n} 件`,
          ...(initiator === person_id ? { initiator: true } : {}),
        })
      }
      // 闲的排前面（交给同事时先看到空着的）
      return out.sort((a, b) => a.in_progress - b.in_progress || a.name.localeCompare(b.name))
    },

    async onDecided(item) {
      if (!isHandoffItem(item) || item.workspace_id !== workspace_id) return
      const p = asRecord(item.payload)
      const kind = p.object === 'todo' ? 'todo' : p.object === 'matter' ? 'matter' : undefined
      const id = typeof p.id === 'string' ? p.id : undefined
      const by = item.decision?.by
      if (kind === undefined || id === undefined || by === undefined || by === 'mandate') return
      const ref = refOf(kind, id)
      const h = itemOf(ref).handoff
      if (!isHandoffPending(h) || h.card_id !== item.id) return
      if (isAccepted(item)) {
        const takes = Array.isArray(p.takes)
          ? (p.takes as { id: string; role_id?: string; position_template_id?: string }[])
          : undefined
        await accept(ref, by, pickedOption(item), takes)
        return
      }
      if (item.state === 'rejected') {
        const reason = item.decision?.reason
        const name = await namesFor([h.from, h.to])
        work.declineHandoff(ref, {
          person: by,
          label: name,
          ...(reason === undefined || reason === HANDOFF_DECLINE_NO_REASON ? {} : { reason }),
        })
      }
    },

    sweep,

    async release(person, by) {
      let moved = 0
      const name = await namesFor([...(await options.members()), person])
      for (const i of work.handoffsTo(person)) {
        work.declineHandoff(i.ref, { person, reason: '他退出了', label: name })
        await retire(i.handoff, by)
        moved += 1
      }
      for (const i of work.handoffsFrom(person).filter((x) => x.handoff.state === 'offered')) {
        work.withdrawHandoff(i.ref, { by: person })
        await retire(i.handoff, by)
        moved += 1
      }
      const members = new Set(await options.members())
      for (const t of work.listTodos({ owner: person, status: ['open', 'doing', 'blocked'] })) {
        const back = t.handoff?.state === 'accepted' ? t.handoff.from : undefined
        if (back !== undefined && back !== person && members.has(back)) {
          work.offer(
            { kind: 'todo', id: t.id },
            { from: person, to: back, days: options.days(), label: name },
          )
          await adopt(
            { workspace_id, person_id: by, assignment_id: '' },
            { kind: 'todo', id: t.id },
          )
          moved += 1
        } else if (claimOf(t).pooled_at !== undefined) {
          work.recycleTodo(t.id, 'member_left')
          moved += 1
        }
      }
      for (const m of work.listMatters({ participant: person, status: ['open', 'waiting'] })) {
        if (m.context.participants[0] !== person) continue
        const back = m.handoff?.state === 'accepted' ? m.handoff.from : undefined
        if (back === undefined || back === person || !members.has(back)) continue
        work.offer(
          { kind: 'matter', id: m.id },
          { from: person, to: back, days: options.days(), label: name },
        )
        await adopt(
          { workspace_id, person_id: by, assignment_id: '' },
          { kind: 'matter', id: m.id },
        )
        moved += 1
      }
      return moved
    },

    async peopleUsage() {
      const rows = options.usage?.() ?? []
      const per = new Map<PersonId, { calls: number; tokens: number }>()
      for (const r of rows) {
        const who = options.assignment(r.assignment_id)?.person_id
        if (who === undefined) continue
        const cur = per.get(who) ?? { calls: 0, tokens: 0 }
        per.set(who, {
          calls: cur.calls + 1,
          tokens: cur.tokens + r.input_tokens + r.output_tokens,
        })
      }
      const people = new Set([...(await options.members()), ...per.keys()])
      const out = []
      for (const person_id of people) {
        const u = per.get(person_id) ?? { calls: 0, tokens: 0 }
        out.push({ person_id, name: (await options.personName(person_id)) ?? '同事', ...u })
      }
      return out.sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name))
    },
    exportMine: (actor) => exportOf(actor.person_id),
    exportOf: (person) => exportOf(person),
    adopt,
  }

  function exportOf(person: PersonId): MyWorkExport {
    const matters = work.listMatters({ participant: person }).map((matter) => ({
      matter,
      timeline: work.store
        .listMatterEvents(matter.id, { limit: 1000 })
        .map((e) => ({ at: e.at, kind: e.kind, text: e.text })),
    }))
    const todos = work.listTodos().filter((t) => t.owner === person || t.handoff?.from === person)
    return { exported_at: work.now(), matters, todos }
  }
}

/**
 * 工作模型端口外面套一层：读首页 / 待认领 / 事项之前先把到点的交接退回；转交走「交给对方」
 * （出卡、带到期）；撞车「交给他」建出来的那条补一张卡；已经出了卡的转交不再挂进「待认领」
 * （它在卡片队列里，两处都出就是同一件事说两遍）。
 */
export function withHandoff(
  port: WorkPort,
  work: Work,
  handoff: () => Promise<HandoffAssembly>,
): WorkPort {
  return {
    ...port,
    async home(actor) {
      await (await handoff()).sweep()
      return port.home(actor)
    },
    async matter(actor, id) {
      await (await handoff()).sweep()
      return port.matter(actor, id)
    },
    async pool(actor) {
      await (await handoff()).sweep()
      const items = await port.pool(actor)
      return items.filter(
        (i) =>
          i.offered_by === undefined || work.getTodo(i.todo_id)?.handoff?.card_id === undefined,
      )
    },
    async transferTodo(actor, id, to) {
      await (await handoff()).offer(actor, 'todo', id, { to })
      return work.requireTodo(id)
    },
    async createTodo(actor, input) {
      const todo = await port.createTodo(actor, input)
      if (isHandoffPending(todo.handoff))
        await (await handoff()).adopt(actor, { kind: 'todo', id: todo.id })
      return work.getTodo(todo.id) ?? todo
    },
  }
}
