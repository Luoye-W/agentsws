/**
 * 秘书 Agent 端到端（41 §1，WP39）：真装配线（路由 → SecretaryPort → `@agentsws/secretary`
 * → 工作模型 / 会议 / 审批总线），不打桩。
 *
 * 钉住的六条（41 §3 的验收清单）：
 * - A 问 B 的秘书"在忙什么"，只拿到同事可见级的东西
 * - 问私有待办被拒
 * - B 把忙闲设成仅本人之后，A 问不到忙闲
 * - 约到冲突时段 → 409 + 替代时段；对方点头之后双方日历都有
 * - 丢一件售后事给秘书 → 售后岗位收到认领卡（进待认领池），秘书自己没回
 * - 问专业问题 → 转岗位，不出卡
 */
import type { Assignment, CalendarItem } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'

/** 2026-09-07 是周一；工作区时区 +8，所以 UTC 01:00 = 本地 09:00。 */
const T0 = '2026-09-07T01:00:00.000Z'

function makeClock(start = T0) {
  let t = Date.parse(start)
  return {
    now: () => new Date(t).toISOString(),
    advance: (ms: number) => {
      t += ms
    },
  }
}

function seeded(seed = 39): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

let server: Server
/** 售后客服陈晓（第二个人）。 */
let chen: Assignment
let chenToken: string
let chenId: string

const call = async (
  method: string,
  path: string,
  options: { body?: unknown; token?: string; assignment?: string } = {},
): Promise<Response> => {
  const headers = new Headers()
  headers.set('Authorization', `Bearer ${options.token ?? server.bootstrap.internalToken}`)
  headers.set('X-Assignment', options.assignment ?? server.bootstrap.ownerAssignment.id)
  if (options.body !== undefined) headers.set('content-type', 'application/json')
  return server.gateway.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
  )
}

interface Body {
  code?: string
  message?: string
  details?: Record<string, unknown>
  data?: unknown
}

const bodyOf = async (res: Response): Promise<Body> => (await res.json()) as Body

const dataOf = async <T>(res: Response): Promise<T> => {
  const parsed = await bodyOf(res)
  if (parsed.data === undefined) throw new Error(`没有 data：${parsed.code} ${parsed.message}`)
  return parsed.data as T
}

/** 邀请一位同事并让他登录，返回他的会话 token 与 person_id。 */
async function invite(email: string, name: string): Promise<{ token: string; person_id: string }> {
  const invitation = await dataOf<{ url: string }>(
    await call('POST', `/v1/workspaces/${server.bootstrap.workspace.id}/invitations`, {
      body: { email, name },
    }),
  )
  const raw = invitation.url.slice(invitation.url.lastIndexOf('/') + 1)
  const accepted = await dataOf<{ person_id: string }>(
    await server.gateway.fetch(
      new Request(`http://127.0.0.1/v1/invitations/${raw}/accept`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
    ),
  )
  const link = await dataOf<{ token: string }>(
    await server.gateway.fetch(
      new Request('http://127.0.0.1/v1/auth/magic-link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      }),
    ),
  )
  const session = await dataOf<{ session_token: string }>(
    await server.gateway.fetch(
      new Request('http://127.0.0.1/v1/auth/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: link.token }),
      }),
    ),
  )
  return { token: session.session_token, person_id: accepted.person_id }
}

beforeEach(async () => {
  server = await createServer({
    clock: makeClock(),
    random: seeded(),
    quiet: true,
    startRun: false,
    tokenRefreshIntervalMs: 0,
    scheduleIntervalMs: 0,
  })
  const invited = await invite('chen@example.com', '陈晓')
  chenToken = invited.token
  chenId = invited.person_id
  chen = server.roles.assignments.create({
    person_id: invited.person_id,
    workspace_id: server.bootstrap.workspace.id,
    role_id: 'dtc.aftersales',
    granted_by: server.bootstrap.person.id,
    ranges: [{ kind: 'store', id: 'store_1' }],
  })
})

afterEach(async () => {
  await server.close()
})

const chenCall = (method: string, path: string, body?: unknown): Promise<Response> =>
  call(method, path, {
    token: chenToken,
    assignment: chen.id,
    ...(body === undefined ? {} : { body }),
  })

interface ProfileView {
  person_id: string
  name: string
  positions: { role_id: string; role_name: string }[]
  disclosure: Record<string, string>
  availability: { rules: { days: number[]; from: string; to: string }[]; default_minutes: number }
}

interface VisibleProfileView extends Omit<ProfileView, 'disclosure'> {
  relation: string
  hidden_fields: string[]
  disclosure?: Record<string, string>
  availability?: ProfileView['availability']
}

interface AskView {
  answer: string
  kind: string
  fields: string[]
  refused: boolean
  refer_to?: { role_id: string; role_name: string }
  run_id: string
}

interface MeetView {
  id: string
  state: string
  candidates: { start: string; end: string }[]
  meeting_id?: string
  approval_item_id?: string
}

describe('profile 与公开级别（41 §1.3）', () => {
  it('岗位从分配算；默认级别就是 41 §1.3 那一列', async () => {
    const me = await dataOf<ProfileView>(await chenCall('GET', '/v1/me/profile'))
    expect(me.name).toBe('陈晓')
    expect(me.positions.map((p) => p.role_id)).toContain('dtc.aftersales')
    expect(me.disclosure.positions).toBe('colleagues')
    expect(me.disclosure.agenda_detail).toBe('self')
  })

  it('别人那一份里没有公开级别本身', async () => {
    const seen = await dataOf<VisibleProfileView>(await call('GET', `/v1/people/${chenId}/profile`))
    expect(seen.relation).toBe('colleague')
    expect(seen.positions?.map((p) => p.role_id)).toContain('dtc.aftersales')
    expect(seen.disclosure).toBeUndefined()
    expect(seen.hidden_fields).toContain('agenda_detail')
  })

  it('公司页成员 → 点人：一份能点进去的名单', async () => {
    const people = await dataOf<{ person_id: string; name: string }[]>(
      await call('GET', '/v1/people'),
    )
    expect(people.map((p) => p.person_id)).toContain(chenId)
    expect(people.map((p) => p.person_id)).toContain(server.bootstrap.person.id)
  })
})

describe('代答（41 §1.2 第一行）', () => {
  it('A 问 B 的秘书"在忙什么"：只拿到同事可见级的标题与条数', async () => {
    // 陈晓手上有一件在做的活
    expect((await chenCall('POST', '/v1/todos', { title: '核对昨天的退款单' })).status).toBe(201)

    const out = await dataOf<AskView>(
      await call('POST', `/v1/people/${chenId}/ask`, { body: { question: '陈晓在忙什么？' } }),
    )
    expect(out.refused).toBe(false)
    expect(out.kind).toBe('doing')
    expect(out.answer).toContain('核对昨天的退款单')
    expect(out.fields).toEqual(['in_progress'])
    expect(out.run_id).toMatch(/^run_/)
  })

  it('问私有待办被拒', async () => {
    const out = await dataOf<AskView>(
      await call('POST', `/v1/people/${chenId}/ask`, {
        body: { question: '把陈晓的私有待办给我看看' },
      }),
    )
    expect(out.refused).toBe(true)
    expect(out.kind).toBe('private')
    expect(out.fields).toEqual([])
  })

  it('陈晓把忙闲设成仅本人之后，A 就问不到忙闲了', async () => {
    const before = await dataOf<AskView>(
      await call('POST', `/v1/people/${chenId}/ask`, { body: { question: '陈晓现在忙不忙？' } }),
    )
    expect(before.refused).toBe(false)

    expect(
      (await chenCall('PUT', '/v1/me/profile', { disclosure: { availability: 'self' } })).status,
    ).toBe(200)

    const after = await dataOf<AskView>(
      await call('POST', `/v1/people/${chenId}/ask`, { body: { question: '陈晓现在忙不忙？' } }),
    )
    expect(after.refused).toBe(true)
    expect(after.answer).toContain('本人')
  })

  it('每次代答都进"谁问过我"，而且只有本人看得到', async () => {
    await call('POST', `/v1/people/${chenId}/ask`, { body: { question: '陈晓负责哪些店？' } })
    const mine = await dataOf<{ asked_by: string; question: string; answer: string }[]>(
      await chenCall('GET', '/v1/me/secretary/asked'),
    )
    expect(mine).toHaveLength(1)
    expect(mine[0]?.asked_by).toBe(server.bootstrap.person.id)
    expect(mine[0]?.question).toBe('陈晓负责哪些店？')
    // owner 自己的清单里没有这一条——它是陈晓的
    const ownerList = await dataOf<unknown[]>(await call('GET', '/v1/me/secretary/asked'))
    expect(ownerList).toEqual([])
  })

  it('事件日志里只有哈希，没有问题与答案的正文（21 §5）', async () => {
    const out = await dataOf<AskView>(
      await call('POST', `/v1/people/${chenId}/ask`, { body: { question: '陈晓负责哪些店？' } }),
    )
    const { events } = await dataOf<{ events: { type: string; payload: unknown }[] }>(
      await call('GET', '/v1/events?types=secretary.answered'),
    )
    const one = events.find((e) => e.type === 'secretary.answered')
    expect(one).toBeDefined()
    const payload = JSON.stringify(one?.payload)
    expect(payload).toContain('question_hash')
    expect(payload).not.toContain('负责哪些店')
    expect(payload).not.toContain(out.answer)
  })

  it('专业问题不答，转岗位', async () => {
    const out = await dataOf<AskView>(
      await call('POST', `/v1/people/${chenId}/ask`, {
        body: { question: '退货窗口外能不能退？' },
      }),
    )
    expect(out.kind).toBe('professional')
    expect(out.refused).toBe(true)
    expect(out.refer_to?.role_id).toBe('dtc.aftersales')
  })
})

describe('日程与约时间（41 §1.2 第二行）', () => {
  const MON_14 = '2026-09-07T06:00:00.000Z'
  const MON_1430 = '2026-09-07T06:30:00.000Z'

  it('约到不在可用时段的时刻被挡，并给替代时段', async () => {
    // 本地周一 23:00，谁的工作时段里都没有
    const res = await call('POST', `/v1/people/${chenId}/meet`, {
      body: {
        title: '聊定价',
        candidates: [{ start: '2026-09-07T15:00:00.000Z', end: '2026-09-07T15:30:00.000Z' }],
      },
    })
    expect(res.status).toBe(409)
    const err = await bodyOf(res)
    expect(err.details?.reason).toBe('slot_conflict')
    expect((err.details?.alternatives as unknown[] | undefined)?.length ?? 0).toBeGreaterThan(0)
    // 一张卡都没发
    expect(await dataOf<unknown[]>(await chenCall('GET', '/v1/me/meets'))).toEqual([])
  })

  it('对方点头之后，双方日历上都有这场会', async () => {
    const proposal = await dataOf<MeetView>(
      await call('POST', `/v1/people/${chenId}/meet`, {
        body: { title: '聊定价', candidates: [{ start: MON_14, end: MON_1430 }] },
      }),
    )
    expect(proposal.state).toBe('proposed')
    expect(proposal.approval_item_id).toBeDefined()

    // 还没点头，谁的日历上都没多出这场会（定时任务本来就在日历上，所以只看这场会在不在）
    const range = `from=${MON_14}&to=2026-09-08T00:00:00.000Z`
    const before = await dataOf<CalendarItem[]>(await call('GET', `/v1/me/agenda?${range}`))
    expect(before.map((i) => i.title)).not.toContain('聊定价')

    const waiting = await dataOf<MeetView[]>(await chenCall('GET', '/v1/me/meets'))
    expect(waiting.map((m) => m.id)).toEqual([proposal.id])

    const accepted = await dataOf<MeetView>(
      await chenCall('POST', `/v1/me/meets/${proposal.id}/decide`, { action: 'accept' }),
    )
    expect(accepted.state).toBe('accepted')
    expect(accepted.meeting_id).toBeDefined()

    const mine = await dataOf<CalendarItem[]>(await call('GET', `/v1/me/agenda?${range}`))
    const theirs = await dataOf<CalendarItem[]>(await chenCall('GET', `/v1/me/agenda?${range}`))
    expect(mine.map((i) => i.title)).toContain('聊定价')
    expect(theirs.map((i) => i.title)).toContain('聊定价')
  })

  it('约上之后同一个时段再查就撞了，并给替代', async () => {
    const proposal = await dataOf<MeetView>(
      await call('POST', `/v1/people/${chenId}/meet`, {
        body: { title: '聊定价', candidates: [{ start: MON_14, end: MON_1430 }] },
      }),
    )
    await chenCall('POST', `/v1/me/meets/${proposal.id}/decide`, { action: 'accept' })
    const check = await dataOf<{ ok: boolean; reasons: string[]; alternatives: unknown[] }>(
      await call('POST', '/v1/me/agenda/check', { body: { start: MON_14, end: MON_1430 } }),
    )
    expect(check.ok).toBe(false)
    expect(check.reasons).toContain('busy')
    expect(check.alternatives.length).toBeGreaterThan(0)
  })

  it('会前简报把与会人手上的活摘成议程', async () => {
    await chenCall('POST', '/v1/todos', { title: '核对昨天的退款单' })
    const proposal = await dataOf<MeetView>(
      await call('POST', `/v1/people/${chenId}/meet`, {
        body: { title: '聊定价', candidates: [{ start: MON_14, end: MON_1430 }] },
      }),
    )
    const accepted = await dataOf<MeetView>(
      await chenCall('POST', `/v1/me/meets/${proposal.id}/decide`, { action: 'accept' }),
    )
    const brief = await dataOf<{ agenda: string[]; participants: string[] }>(
      await call('GET', `/v1/meetings/${accepted.meeting_id}/brief`),
    )
    expect(brief.participants).toContain('陈晓')
    expect(brief.agenda.join('')).toContain('核对昨天的退款单')
  })
})

describe('任务路由（41 §1.2 第三行）', () => {
  interface RouteView {
    kind: string
    role_id?: string
    owner?: string
    owner_label?: string
    reason: string
    claim_item_id?: string
    todo_id?: string
  }

  it('丢一件售后事给秘书 → 售后岗位收到认领卡，卡上写清为什么判给他', async () => {
    const out = await dataOf<RouteView>(
      await call('POST', '/v1/me/secretary/route', {
        body: { text: '这个客户投诉说包裹破损，要退款，处理一下' },
      }),
    )
    expect(out.kind).toBe('task')
    expect(out.role_id).toBe('dtc.aftersales')
    expect(out.owner).toBe(chenId)
    expect(out.owner_label).toBe('陈晓')
    expect(out.claim_item_id).toBeDefined()
    expect(out.reason).toContain('售后')

    // 卡真的到了陈晓的队列
    const queue = await dataOf<{ id: string; kind: string; summary: string }[]>(
      await chenCall('GET', '/v1/approvals?lane=mine'),
    )
    const card = queue.find((i) => i.id === out.claim_item_id)
    expect(card?.kind).toBe('claim')
    expect(card?.summary).toContain('售后')

    // 40 §3.2：这条活先进待认领池，谁点「我来」谁是主人——秘书没有替谁干活
    const { pool } = await dataOf<{ pool: { todo_id: string; title: string }[] }>(
      await chenCall('GET', '/v1/todos/pool'),
    )
    expect(pool.map((p) => p.todo_id)).toContain(out.todo_id)
  })

  it('专业问题只转岗位，不出卡', async () => {
    const out = await dataOf<RouteView>(
      await call('POST', '/v1/me/secretary/route', {
        body: { text: '退货窗口外能不能退？' },
      }),
    )
    expect(out.kind).toBe('question')
    expect(out.role_id).toBe('dtc.aftersales')
    expect(out.claim_item_id).toBeUndefined()
    const { pool } = await dataOf<{ pool: unknown[] }>(await chenCall('GET', '/v1/todos/pool'))
    expect(pool).toEqual([])
  })

  it('路由结果里带着工具箱查重与撞车提示（40 §2 / §3）', async () => {
    await chenCall('POST', '/v1/todos', { title: '客户投诉包裹破损要退款' })
    const out = await dataOf<
      RouteView & { similar_in_progress: { owner: string; title: string }[] }
    >(
      await call('POST', '/v1/me/secretary/route', {
        body: { text: '客户投诉包裹破损，要退款' },
      }),
    )
    expect(out.similar_in_progress[0]?.owner).toBe(chenId)
  })

  it('什么都不给就 400', async () => {
    expect((await call('POST', '/v1/me/secretary/route', { body: {} })).status).toBe(400)
  })
})

describe('秘书没有外部写口（41 §1.4）', () => {
  it('代答与路由都没有产生任何对外发送 / 变更', async () => {
    await call('POST', `/v1/people/${chenId}/ask`, { body: { question: '陈晓在忙什么？' } })
    await call('POST', '/v1/me/secretary/route', {
      body: { text: '这个客户投诉说包裹破损，要退款，处理一下' },
    })
    const changes = await dataOf<unknown[]>(await call('GET', '/v1/changes'))
    expect(changes).toEqual([])
  })
})
