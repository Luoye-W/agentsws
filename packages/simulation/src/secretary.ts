/**
 * 把秘书 Agent 接进模拟世界（41 §1，WP39）。
 *
 * 与 `routine` / `learning` 一样是**惰性**的：场景里没有 `secretary.*` 事件就一个都不装，
 * 原有场景的事件序列与指标一个字节不变。
 *
 * 世界里没有真的会议内核（那是服务进程的事），所以这里给一个最小的会议表：
 * 一场会 = 标题 + 时段 + 与会人。它只做一件事——证明"对方点头之后，**双方**日历上都有"。
 */
import type { CalendarItem, Iso8601, PersonId } from '@agentsws/contracts'
import {
  createSecretary,
  type ProfilePosition,
  type RoleProfile,
  roleTermsOf,
  type Secretary,
} from '@agentsws/secretary'
import { buildCalendar } from '@agentsws/work'
import type { World } from './world.js'

export interface SimMeeting {
  id: string
  title: string
  start: Iso8601
  end: Iso8601
  participants: PersonId[]
}

export interface SecretaryLoop {
  secretary: Secretary
  /** 这个世界里已经约成的会（`createMeeting` 往里加） */
  meetings: SimMeeting[]
  /** 秘书替谁路由到了哪个职责（场景的 `routed_to` 断言读它） */
  routed: { role_id: string; owner?: PersonId }[]
  /** 每一次代答的类别（场景的 `secretary_kinds` 断言读它） */
  answers: string[]
  /** 某个人的日程（断言"双方日历都有"时用） */
  agendaOf(person: PersonId, range: { from: Iso8601; to: Iso8601 }): CalendarItem[]
}

export function installSecretary(world: World): SecretaryLoop {
  const meetings: SimMeeting[] = []
  const routed: SecretaryLoop['routed'] = []
  const answers: string[] = []
  const people = new Map(world.pack.people.map((p) => [p.id, p]))

  const positionsOf = (person_id: PersonId): ProfilePosition[] =>
    world.roles.assignments
      .listByPerson(person_id, { workspace_id: world.workspace_id })
      .filter((a) => a.revoked_at === undefined)
      .map((a) => ({
        position_id: a.id,
        role_id: a.role_id,
        role_name: world.roles.roles.get(a.role_id)?.name.zh ?? a.role_id,
        ranges: [...a.ranges],
      }))

  const agendaOf = (person_id: PersonId, range: { from: Iso8601; to: Iso8601 }): CalendarItem[] =>
    buildCalendar({
      range: { from: range.from, to: range.to, include_card_due: false },
      todos: world.work.listTodos({ owner: person_id, status: ['open', 'doing', 'blocked'] }),
      meetings: meetings
        .filter((m) => m.participants.includes(person_id))
        .map((m) => ({
          id: `cal_meeting_${m.id}`,
          source: 'meeting' as const,
          title: m.title,
          start: m.start,
          end: m.end,
          all_day: false,
          ref: { type: 'meeting', id: m.id },
        })),
    })

  const secretary = createSecretary({
    workspace_id: world.workspace_id,
    clock: { now: () => world.clock.now() },
    random: () => world.random(),
    tz_offset_minutes: world.work.tz_offset_minutes,
    appendEvent: (e) => {
      world.appendEvent(e.type, e.payload, { actor: e.actor })
    },
    personName: (id) => people.get(id)?.name,
    isMember: (id) => people.has(id),
    positionsOf,
    skillsOf: (id) => [
      ...new Set(
        positionsOf(id).flatMap(
          (p) => world.roles.roles.get(p.role_id)?.skills.map((s) => s.name) ?? [],
        ),
      ),
    ],
    inProgressOf: (id) =>
      world.work
        .inProgress({ scope: 'workspace' })
        .filter((i) => i.owner === id)
        .map((i) => ({ id: i.id, title: i.title })),
    agendaOf,
    roleProfiles: (): RoleProfile[] =>
      world.roles.roles.list().map((role) => ({
        role_id: role.id,
        role_name: role.name.zh,
        terms: roleTermsOf(role),
        positions: world.roles.assignments
          .listByRole(role.id, { workspace_id: world.workspace_id })
          .filter((a) => a.revoked_at === undefined)
          .map((a) => ({ position_id: a.id, person_id: a.person_id })),
      })),
    findSimilar: (subject) =>
      world.work
        .findSimilar({ title: subject.title, at: subject.at })
        .slice(0, 3)
        .map((c) => ({
          id: c.id,
          title: c.title,
          owner: c.owner,
          owner_label: people.get(c.owner)?.name ?? c.owner,
          similarity: c.similarity,
        })),
    /**
     * 40 §3.2：路由出来的活**先进待认领池**——谁点「我来」谁是主人。
     *
     * 模拟世界里没有审批总线上的那张卡（那是服务进程的装配），所以这里只落池子；
     * "卡到了哪个岗位"由 `routed` 记着，场景用 `routed_to` 断言。
     */
    createClaim: (input) => {
      const todo = world.work.poolTodo({
        title: input.title,
        source: 'card',
        ...(input.position_id === undefined ? {} : { position_id: input.position_id }),
        similar_to: input.similar_to,
      })
      routed.push({
        role_id: input.role_id ?? 'common.member',
        ...(input.owner === undefined ? {} : { owner: input.owner }),
      })
      return { todo_id: todo.id }
    },
    createMeeting: (input) => {
      const id = `mtg_${meetings.length + 1}`
      meetings.push({
        id,
        title: input.title,
        start: input.start,
        end: input.end,
        participants: [...input.participants],
      })
      return { meeting_id: id }
    },
  })

  return { secretary, meetings, routed, answers, agendaOf }
}
