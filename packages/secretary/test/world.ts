/**
 * 测试用的"世界"：15 人公司的最小切片。
 *
 * 秘书不认识存储与运行时——日程、撞车、查重、认领卡全是注入的，所以这份替身就是
 * 一个普通对象：几个人、几场会、几条在做的活、三份职责定义。
 */
import type { CalendarItem, EventEnvelope, Iso8601, PersonId } from '@agentsws/contracts'
import {
  type ClaimRequest,
  createSecretary,
  type ProfilePosition,
  type Secretary,
} from '../src/index.js'
import {
  ADS,
  AFTERSALES,
  fixedClock,
  OPS,
  roleProfile,
  seeded,
  type TestClock,
  TZ,
  WS,
} from './helpers.js'

export interface FakeMeeting {
  id: string
  title: string
  start: Iso8601
  end: Iso8601
  participants: PersonId[]
}

export interface FakeWorld {
  secretary: Secretary
  clock: TestClock
  events: Omit<EventEnvelope, 'id' | 'at'>[]
  meetings: FakeMeeting[]
  claims: ClaimRequest[]
  inProgress: Map<PersonId, { id: string; title: string }[]>
  positions: Map<PersonId, ProfilePosition[]>
  agendaOf(person: PersonId): CalendarItem[]
}

const NAMES: Record<string, string> = {
  p_wang: '王岚',
  p_li: '李默',
  p_chen: '陈晓',
  p_wu: '吴迪',
  p_out: '外人',
}

export function fakeWorld(at?: Iso8601): FakeWorld {
  const clock = fixedClock(at)
  const events: Omit<EventEnvelope, 'id' | 'at'>[] = []
  const meetings: FakeMeeting[] = []
  const claims: ClaimRequest[] = []
  const inProgress = new Map<PersonId, { id: string; title: string }[]>()
  const positions = new Map<PersonId, ProfilePosition[]>([
    [
      'p_li',
      [
        {
          position_id: 'a_li_ops',
          role_id: 'dtc.ops',
          role_name: '独立站运营',
          ranges: [{ kind: 'store', id: 'store_main' }],
        },
      ],
    ],
    [
      'p_chen',
      [
        {
          position_id: 'a_chen',
          role_id: 'dtc.aftersales',
          role_name: '独立站售后客服',
          ranges: [{ kind: 'store', id: 'store_main' }],
        },
      ],
    ],
    [
      'p_wu',
      [
        {
          position_id: 'a_wu',
          role_id: 'ads.performance',
          role_name: '效果投放',
          ranges: [],
        },
      ],
    ],
    ['p_wang', [{ position_id: 'a_wang', role_id: 'common.owner', role_name: '店主', ranges: [] }]],
  ])

  const agendaOf = (person: PersonId): CalendarItem[] =>
    meetings
      .filter((m) => m.participants.includes(person))
      .map((m) => ({
        id: `cal_meeting_${m.id}`,
        source: 'meeting' as const,
        title: m.title,
        start: m.start,
        end: m.end,
        all_day: false,
        ref: { type: 'meeting', id: m.id },
      }))

  const secretary = createSecretary({
    workspace_id: WS,
    clock,
    random: seeded(),
    tz_offset_minutes: TZ,
    appendEvent: (e) => {
      events.push(e)
    },
    personName: (id) => NAMES[id],
    isMember: (id) => id !== 'p_out' && NAMES[id] !== undefined,
    positionsOf: (id) => positions.get(id) ?? [],
    skillsOf: (id) => (id === 'p_li' ? ['退款政策'] : []),
    inProgressOf: (id) => inProgress.get(id) ?? [],
    agendaOf: (id, range) =>
      agendaOf(id).filter(
        (i) =>
          Date.parse(i.start) < Date.parse(range.to) &&
          Date.parse(i.end ?? i.start) > Date.parse(range.from),
      ),
    roleProfiles: () => [
      roleProfile(AFTERSALES, [{ position_id: 'a_chen', person_id: 'p_chen' }]),
      roleProfile(OPS, [{ position_id: 'a_li_ops', person_id: 'p_li' }]),
      roleProfile(ADS, [{ position_id: 'a_wu', person_id: 'p_wu' }]),
    ],
    findTools: () => [],
    findSimilar: () => [],
    createClaim: (input) => {
      claims.push(input)
      return { approval_item_id: `item_${claims.length}`, todo_id: `todo_${claims.length}` }
    },
    createMeeting: (input) => {
      const id = `mtg_${meetings.length + 1}`
      meetings.push({
        id,
        title: input.title,
        start: input.start,
        end: input.end,
        participants: input.participants,
      })
      return { meeting_id: id }
    },
  })

  return { secretary, clock, events, meetings, claims, inProgress, positions, agendaOf }
}
