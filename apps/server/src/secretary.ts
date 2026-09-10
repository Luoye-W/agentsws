/**
 * 41 §1 秘书 Agent 的服务端装配。
 *
 * 这一层只做装配：`@agentsws/secretary` 出判断，`@agentsws/work` 出日程与撞车，
 * 工具箱出查重，审批总线出卡片，职责库出"这件事该谁做"的判据。
 *
 * 四条边界：
 * - **岗位与范围从制度层算**，profile 里不存一份（存了就会和分配对不上）。
 * - **别人的日程只出忙闲**：算别人忙不忙时只喂会议与排期待办，**不喂他的卡片**——
 *   那是他队列里的东西，不该经由"忙闲"泄漏出去。
 * - **路由出的是一张认领卡**（进 WP38 的待认领池），不是一个动作；秘书没有任何外部写口。
 * - 时间经 Clock，随机经注入的 seed，没有一处 `Date.now()` / `Math.random()`。
 */
import { join } from 'node:path'
import type {
  AgendaCheckView,
  AskedView,
  AskView,
  CatalogPort,
  MeetingBriefView,
  MeetView,
  MyProfileView,
  PersonCardView,
  ProfileFieldName,
  RouteView,
  SecretaryActor,
  SecretaryPort,
  VisibleProfileView,
} from '@agentsws/api'
import type {
  ApprovalBus,
  CalendarItem,
  Clock,
  EventEnvelope,
  Iso8601,
  Meeting,
  MeetingCreateInput,
  Membership,
  Person,
  PersonId,
  RoleId,
  WorkspaceId,
} from '@agentsws/contracts'
import type { RoleStore } from '@agentsws/roles'
import {
  createSecretary,
  createSqliteSecretaryStore,
  type MeetingBriefSource,
  type MeetProposal,
  type ProfilePosition,
  type RoleProfile,
  roleTermsOf,
  type Secretary,
  SecretaryError,
  type SecretaryStore,
} from '@agentsws/secretary'
import { buildCalendar, type ScheduledTaskLike, type Work } from '@agentsws/work'

/** 秘书面能看到的会议（只用到这几件事，所以放宽成结构类型）。 */
export interface MeetingsLike {
  list(filter: {
    workspace_id: WorkspaceId
    participant?: string
    from?: Iso8601
    to?: Iso8601
  }): Promise<Meeting[]> | Meeting[]
  get(id: string): Promise<Meeting | undefined> | Meeting | undefined
  create(input: MeetingCreateInput): Promise<Meeting> | Meeting
}

export interface IdentityLike {
  members(workspace_id: WorkspaceId): Promise<Membership[]> | Membership[]
  getPerson(id: PersonId): Promise<Person | undefined> | Person | undefined
}

export interface SecretaryAssemblyOptions {
  workspace_id: WorkspaceId
  clock: Clock
  random: () => number
  dbDir?: string
  tz_offset_minutes?: number
  appendEvent(e: Omit<EventEnvelope, 'id' | 'at'> & { at?: string }): void
  identity: IdentityLike
  roles: RoleStore
  work: Work
  approvals: ApprovalBus
  meetings?: MeetingsLike
  catalog?: CatalogPort
  /** 25 的定时任务（本人的）；不给就是日程里没有这一类 */
  scheduledTasks?(person_id: PersonId): ScheduledTaskLike[]
  /** 卡片挂在哪个职责下；秘书永远是 `common.member`（06 §2.1） */
  role_id?: RoleId
}

export interface SecretaryAssembly {
  secretary: Secretary
  port: SecretaryPort
  close(): void
}

/** 一个人的展示名缓存：`identity.members` 是异步的，判断可见性却要同步。 */
interface Directory {
  names: Map<PersonId, string>
  members: Set<PersonId>
}

export function createSecretaryAssembly(options: SecretaryAssemblyOptions): SecretaryAssembly {
  const { workspace_id, clock, work, roles } = options
  const role_id: RoleId = options.role_id ?? 'common.member'
  const store: SecretaryStore | undefined =
    options.dbDir === undefined
      ? undefined
      : createSqliteSecretaryStore({ dbPath: join(options.dbDir, 'secretary.sqlite'), clock })

  const dir: Directory = { names: new Map(), members: new Set() }
  let lastRefresh = ''

  /** 名册刷新：每次请求最多刷一次（同一毫秒内不重复问身份服务）。 */
  const refresh = async (): Promise<void> => {
    const now = clock.now()
    if (now === lastRefresh) return
    lastRefresh = now
    const members = await options.identity.members(workspace_id)
    dir.members = new Set(members.filter((m) => m.left_at === undefined).map((m) => m.person_id))
    for (const m of members) {
      if (dir.names.has(m.person_id)) continue
      const person = await options.identity.getPerson(m.person_id)
      dir.names.set(m.person_id, person?.name ?? person?.email ?? m.person_id)
    }
  }

  const positionsOf = (person_id: PersonId): ProfilePosition[] =>
    roles.assignments
      .listByPerson(person_id, { workspace_id })
      .filter((a) => a.revoked_at === undefined)
      .map((a) => ({
        position_id: a.id,
        role_id: a.role_id,
        role_name: roles.roles.get(a.role_id)?.name.zh ?? a.role_id,
        ranges: [...a.ranges],
      }))

  const roleProfiles = (): RoleProfile[] =>
    roles.roles.list().map((role) => ({
      role_id: role.id,
      role_name: role.name.zh,
      terms: roleTermsOf(role),
      positions: roles.assignments
        .listByRole(role.id, { workspace_id })
        .filter((a) => a.revoked_at === undefined)
        .map((a) => ({ position_id: a.id, person_id: a.person_id })),
    }))

  /**
   * 一个人的日程：会议（他是与会者的那些）+ 他自己排了期的待办 + 他的定时任务。
   *
   * **不含卡片到期**：卡片是他队列里的东西，不该经由"忙闲"漏给别人。本人自己看日程时
   * 少这一层叠层，代价是可以接受的——首页的「今天」那条时间线仍然是全的（WP22 的 `work.calendar`）。
   */
  const agendaOf = async (
    person_id: PersonId,
    range: { from: Iso8601; to: Iso8601 },
  ): Promise<CalendarItem[]> => {
    const meetings = await meetingItems(person_id, range)
    const todos = work.listTodos({ owner: person_id, status: ['open', 'doing', 'blocked'] })
    return buildCalendar({
      range: { from: range.from, to: range.to, include_card_due: false },
      todos,
      meetings,
      ...(options.scheduledTasks === undefined ? {} : { tasks: options.scheduledTasks(person_id) }),
    })
  }

  const meetingItems = async (
    person_id: PersonId,
    range: { from: Iso8601; to: Iso8601 },
  ): Promise<CalendarItem[]> => {
    if (options.meetings === undefined) return []
    const rows = await options.meetings.list({
      workspace_id,
      participant: person_id,
      from: range.from,
      to: range.to,
    })
    return rows
      .filter((m) => m.status !== 'cancelled')
      .map((m) => ({
        id: `cal_meeting_${m.id}`,
        source: 'meeting' as const,
        title: m.title,
        start: m.start,
        end: m.end,
        all_day: false,
        ref: { type: 'meeting', id: m.id },
        status: m.status,
      }))
  }

  const secretary = createSecretary({
    workspace_id,
    clock,
    random: options.random,
    appendEvent: options.appendEvent,
    ...(store === undefined ? {} : { store }),
    ...(options.tz_offset_minutes === undefined
      ? {}
      : { tz_offset_minutes: options.tz_offset_minutes }),
    personName: (id) => dir.names.get(id),
    isMember: (id) => dir.members.has(id),
    positionsOf,
    // 24 的技能层：一个人"擅长什么"的第一来源是他岗位挂着的技能
    skillsOf: (id) => [
      ...new Set(
        positionsOf(id).flatMap((p) => roles.roles.get(p.role_id)?.skills.map((s) => s.name) ?? []),
      ),
    ],
    inProgressOf: (id) =>
      work
        .inProgress({ scope: 'workspace' })
        .filter((i) => i.owner === id)
        .map((i) => ({ id: i.id, title: i.title })),
    agendaOf,
    roleProfiles,
    findTools: async (text) => {
      if (options.catalog === undefined) return []
      const hits = await options.catalog.similar({
        workspace_id,
        kind: 'workflow',
        title: text,
        limit: 3,
      })
      return hits.map((h) => ({
        id: h.entry.id,
        title: h.entry.title,
        kind: h.entry.kind,
        similarity: h.similarity,
      }))
    },
    findSimilar: (subject) =>
      work
        .findSimilar({ title: subject.title, at: subject.at })
        .slice(0, 3)
        .map((c) => ({
          id: c.id,
          title: c.title,
          owner: c.owner,
          owner_label: dir.names.get(c.owner) ?? c.owner,
          similarity: c.similarity,
        })),
    /**
     * 40 §3.2「认领即锁」：路由出来的活**先进待认领池**（没有主人），
     * 同时发一张认领卡给对的岗位。批准那张卡就是从池里认下来。
     */
    createClaim: async (input) => {
      const recipient = input.owner ?? input.by
      const run_id = input.run_id
      const item = await options.approvals.create({
        workspace_id,
        schema_version: 1,
        kind: 'claim',
        role_id: input.role_id ?? role_id,
        subject: { object: { type: 'person', id: recipient } },
        dedupe_key: `${workspace_id}:claim:secretary:${run_id}`,
        title: input.title,
        summary: input.reason,
        payload: {
          form: 'claim',
          claim_kind: 'action_item',
          source: 'email',
          source_id: run_id,
          text: input.title,
          quote: input.note,
          speech_state: 'commitment',
          speech_state_reasons: ['秘书路由'],
          route_confidence: 1,
          /** 卡面上那句「秘书判断：售后岗位，因为…」 */
          secretary_reason: input.reason,
        },
        evidence: {
          run_id,
          source_events: [],
          provenance: { seen: [] },
          precheck: { fencing: 'ok' },
        },
        proposer: { kind: 'agent', id: 'secretary' },
        automation: {
          level_at_creation: 'L1',
          auto_approved: false,
          mandate_check: { within: true, caps_hit: [] },
          sampling: { selected: false },
        },
        routing: {
          recipients: [{ person: recipient, via: 'role_holder' }],
          rule: 'role_holder',
          escalation: {
            after_hours: 24,
            business_hours: true,
            chain: ['owner'],
            escalated_at: [],
          },
          separation_of_duties: false,
        },
        priority: 'queue',
      })
      /**
       * 卡建完再进池：`origin.card_id` 指回那张卡，于是"批准这张卡 = 从池里认下来"
       * （见 `createWorkPort().acceptClaim`），而不是又建一条新的。
       */
      const todo = work.poolTodo({
        title: input.title,
        // 契约的 `TodoSource` 里还没有 `secretary`（见报告 §4），先归到"卡片来的"
        source: 'card',
        origin: { card_id: item.id },
        ...(input.position_id === undefined ? {} : { position_id: input.position_id }),
        similar_to: input.similar_to,
      })
      return { approval_item_id: item.id, todo_id: todo.id }
    },

    /** "约时间"卡：`claim` 形态，但 payload 不是 `form: 'claim'`——它不该变成一条待办。 */
    createMeetCard: async (proposal: MeetProposal) => {
      const item = await options.approvals.create({
        workspace_id,
        schema_version: 1,
        kind: 'claim',
        role_id,
        subject: { object: { type: 'person', id: proposal.from } },
        dedupe_key: `${workspace_id}:meet:${proposal.id}`,
        title: `${dir.names.get(proposal.from) ?? proposal.from}想约你：${proposal.title}`,
        summary: `${proposal.candidates.length} 个候选时段，${proposal.duration_minutes} 分钟`,
        payload: {
          form: 'meet',
          meet_id: proposal.id,
          from: proposal.from,
          title: proposal.title,
          duration_minutes: proposal.duration_minutes,
          candidates: proposal.candidates,
        },
        evidence: {
          source_events: [],
          provenance: { seen: [] },
          precheck: { fencing: 'ok' },
        },
        proposer: { kind: 'agent', id: 'secretary' },
        automation: {
          level_at_creation: 'L1',
          auto_approved: false,
          mandate_check: { within: true, caps_hit: [] },
          sampling: { selected: false },
        },
        routing: {
          recipients: [{ person: proposal.to, via: 'explicit' }],
          explicit: proposal.to,
          rule: 'explicit',
          escalation: {
            after_hours: 24,
            business_hours: true,
            chain: ['owner'],
            escalated_at: [],
          },
          separation_of_duties: false,
        },
        priority: 'queue',
        options: [
          { id: 'accept', label: '这个时间可以' },
          { id: 'decline', label: '换个时间' },
        ],
      })
      return { approval_item_id: item.id }
    },
    createMeeting: async (input) => {
      if (options.meetings === undefined)
        throw new SecretaryError('not_implemented', '这个服务进程没有装会议内核')
      const made = await options.meetings.create({
        workspace_id,
        title: input.title,
        start: input.start,
        end: input.end,
        participants: input.participants.map((person_id) => ({
          person_id,
          name: dir.names.get(person_id) ?? person_id,
        })),
        status: 'scheduled',
        created_by: input.created_by,
      })
      return { meeting_id: made.id }
    },
    meetingBriefSource: async (meeting_id): Promise<MeetingBriefSource | undefined> => {
      const meeting = await options.meetings?.get(meeting_id)
      if (meeting === undefined || meeting.workspace_id !== workspace_id) return undefined
      const people = meeting.participants
        .map((p) => p.person_id)
        .filter((id): id is PersonId => id !== undefined)
      const matters =
        meeting.matter_id === undefined
          ? []
          : [work.getMatter(meeting.matter_id)].filter((m) => m !== undefined)
      return {
        meeting_id: meeting.id,
        title: meeting.title,
        start: meeting.start,
        end: meeting.end,
        participants: meeting.participants.map((p) => ({
          ...(p.person_id === undefined ? {} : { person_id: p.person_id }),
          ...(p.name === undefined ? {} : { name: p.name }),
          ...(p.email === undefined ? {} : { email: p.email }),
        })),
        ...(meeting.agenda === undefined ? {} : { agenda: meeting.agenda }),
        matters: matters.map((m) => ({
          id: m.id,
          title: m.title,
          summary: m.context.summary,
          status: m.status,
        })),
        // 与会人手上还没做完的活：会前该看的正是这些
        open_items: work
          .inProgress({ scope: 'workspace' })
          .filter((i) => people.includes(i.owner))
          .map((i) => ({ title: i.title, owner: i.owner })),
      }
    },
  })

  /* ── 端口：视图投影 ───────────────────────────────────────────────── */

  const profileView = (person_id: PersonId): MyProfileView => {
    const p = secretary.profile(person_id)
    return {
      person_id: p.person_id,
      name: p.name,
      positions: p.positions,
      ranges: p.ranges,
      skills: p.skills,
      contact_policy: p.contact_policy,
      availability: p.availability,
      disclosure: p.disclosure,
      updated_at: p.updated_at,
    }
  }

  const meetView = (m: MeetProposal): MeetView => ({
    id: m.id,
    from: m.from,
    from_label: dir.names.get(m.from) ?? m.from,
    to: m.to,
    to_label: dir.names.get(m.to) ?? m.to,
    title: m.title,
    duration_minutes: m.duration_minutes,
    candidates: m.candidates,
    state: m.state,
    alternatives: m.alternatives,
    created_at: m.created_at,
    ...(m.accepted === undefined ? {} : { accepted: m.accepted }),
    ...(m.approval_item_id === undefined ? {} : { approval_item_id: m.approval_item_id }),
    ...(m.meeting_id === undefined ? {} : { meeting_id: m.meeting_id }),
    ...(m.decline_reason === undefined ? {} : { decline_reason: m.decline_reason }),
    ...(m.decided_at === undefined ? {} : { decided_at: m.decided_at }),
  })

  const port: SecretaryPort = {
    async myProfile(actor: SecretaryActor): Promise<MyProfileView> {
      await refresh()
      return profileView(actor.person_id)
    },

    async updateProfile(actor, patch): Promise<MyProfileView> {
      await refresh()
      secretary.updateProfile(actor.person_id, {
        ...(patch.skills === undefined
          ? {}
          : {
              skills: patch.skills.map((s) => ({
                name: s.name,
                source: s.source,
                ...(s.hidden === undefined ? {} : { hidden: s.hidden }),
              })),
            }),
        ...(patch.contact_policy === undefined ? {} : { contact_policy: patch.contact_policy }),
        ...(patch.availability === undefined ? {} : { availability: patch.availability }),
        ...(patch.disclosure === undefined ? {} : { disclosure: patch.disclosure }),
      })
      return profileView(actor.person_id)
    },

    async profileOf(actor, person_id): Promise<VisibleProfileView> {
      await refresh()
      const v = secretary.visibleProfile(actor.person_id, person_id)
      return {
        person_id: v.person_id,
        name: v.name,
        relation: v.relation,
        hidden_fields: v.hidden_fields as ProfileFieldName[],
        ...(v.positions === undefined ? {} : { positions: v.positions }),
        ...(v.ranges === undefined ? {} : { ranges: v.ranges }),
        ...(v.skills === undefined ? {} : { skills: v.skills }),
        ...(v.availability === undefined ? {} : { availability: v.availability }),
        ...(v.contact_policy === undefined ? {} : { contact_policy: v.contact_policy }),
        ...(v.disclosure === undefined ? {} : { disclosure: v.disclosure }),
      }
    },

    async people(actor): Promise<PersonCardView[]> {
      await refresh()
      const out: PersonCardView[] = []
      for (const person_id of [...dir.members].sort()) {
        const visible = secretary.visibleFields(actor.person_id, person_id)
        const profile = secretary.profile(person_id)
        const inProgress = work
          .inProgress({ scope: 'workspace' })
          .filter((i) => i.owner === person_id).length
        out.push({
          person_id,
          name: profile.name,
          positions: visible.has('positions')
            ? profile.positions.map((p) => ({ role_id: p.role_id, role_name: p.role_name }))
            : [],
          ...(visible.has('in_progress') ? { in_progress: inProgress } : {}),
        })
      }
      return out
    },

    async ask(actor, person_id, question): Promise<AskView> {
      await refresh()
      const out = await secretary.ask({
        viewer: actor.person_id,
        person_id,
        question,
        assignment_id: actor.assignment_id,
      })
      return {
        answer: out.answer,
        kind: out.kind,
        fields: out.fields as ProfileFieldName[],
        refused: out.refused,
        run_id: out.run_id,
        ...(out.refer_to === undefined ? {} : { refer_to: out.refer_to }),
      }
    },

    async asked(actor, limit): Promise<AskedView[]> {
      await refresh()
      return secretary
        .asked(actor.person_id, actor.person_id, limit === undefined ? {} : { limit })
        .map((r) => ({
          id: r.id,
          asked_by: r.asked_by,
          asked_by_label: dir.names.get(r.asked_by) ?? r.asked_by,
          at: r.at,
          kind: r.kind,
          question: r.question,
          answer: r.answer,
          fields: r.fields as ProfileFieldName[],
          refused: r.refused,
        }))
    },

    agenda: (actor, range) => secretary.agenda(actor.person_id, range),

    async checkAgenda(actor, slot): Promise<AgendaCheckView> {
      await refresh()
      return secretary.checkAgenda(actor.person_id, slot)
    },

    async meet(actor, person_id, input): Promise<MeetView> {
      await refresh()
      return meetView(
        await secretary.meet({
          from: actor.person_id,
          to: person_id,
          title: input.title,
          candidates: input.candidates,
          assignment_id: actor.assignment_id,
          ...(input.duration === undefined ? {} : { duration_minutes: input.duration }),
        }),
      )
    },

    async meets(actor): Promise<MeetView[]> {
      await refresh()
      return secretary.meets(actor.person_id).map(meetView)
    },

    async decideMeet(actor, id, input): Promise<MeetView> {
      await refresh()
      return meetView(await secretary.decideMeet(id, actor.person_id, input))
    },

    async brief(_actor, meeting_id): Promise<MeetingBriefView> {
      await refresh()
      return secretary.brief(meeting_id)
    },

    async route(actor, input): Promise<RouteView> {
      await refresh()
      const text = await textOf(input)
      const out = await secretary.route({
        person_id: actor.person_id,
        assignment_id: actor.assignment_id,
        text,
      })
      return {
        kind: out.kind,
        confidence: out.confidence,
        reason: out.reason,
        existing_tools: out.existing_tools,
        similar_in_progress: out.similar_in_progress,
        run_id: out.run_id,
        ...(out.role_id === undefined ? {} : { role_id: out.role_id }),
        ...(out.role_name === undefined ? {} : { role_name: out.role_name }),
        ...(out.position_id === undefined ? {} : { position_id: out.position_id }),
        ...(out.owner === undefined
          ? {}
          : { owner: out.owner, owner_label: dir.names.get(out.owner) ?? out.owner }),
        ...(out.claim_item_id === undefined ? {} : { claim_item_id: out.claim_item_id }),
        ...(out.todo_id === undefined ? {} : { todo_id: out.todo_id }),
      }
    },
  }

  /**
   * `inbound_ref` / `meeting_output_ref` 先解析成一段文本再路由。
   * 解析不出来就直接报错——秘书不猜"你说的那封信是哪封"。
   */
  const textOf = async (input: {
    text?: string | undefined
    inbound_ref?: string | undefined
    meeting_output_ref?: string | undefined
  }): Promise<string> => {
    if (input.text !== undefined && input.text.trim() !== '') return input.text
    const ref = input.meeting_output_ref ?? input.inbound_ref
    if (ref === undefined) throw new SecretaryError('invalid_input', '没说要路由什么')
    // 会议产出：事项时间线上那一条就是原文
    const matter = work
      .listMatters({})
      .map((m) => work.store.listMatterEvents(m.id, { limit: 500 }).find((e) => e.id === ref))
      .find((e) => e !== undefined)
    if (matter !== undefined) return matter.text
    const todo = work.getTodo(ref)
    if (todo !== undefined)
      return todo.note === undefined ? todo.title : `${todo.title} ${todo.note}`
    throw new SecretaryError('not_found', `找不到这条来源：${ref}`)
  }

  return {
    secretary,
    port,
    close() {
      store?.close?.()
    },
  }
}
