/**
 * WP429 站内通知：表（合并 / 已读 / 保留期 / 设置开关）+ 从事件里认出「该告诉谁一声」+ 装配处直接发的几类文字。
 * 最后一段走真装配线：路由、事件日志 → 通知、模型订阅要重新登录（WP430 的事件，自己 append 一条）。
 */
import type { ApprovalItem, EventEnvelope, PersonId, WorkspaceId } from '@agentsws/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import {
  connectionBrokenNotification,
  createNotifications,
  creditsLowNotification,
  type NotificationResolver,
  notificationsOfEvent,
  RELOGIN_NEEDED_EVENT,
  runEndedNotification,
} from '../src/notifications.js'

const WS = 'ws_a' as WorkspaceId
const ME = 'p_me' as PersonId
const PEER = 'p_peer' as PersonId
const me = { workspace_id: WS, person_id: ME }

function clockAt(start = '2026-10-19T02:00:00.000Z') {
  let t = Date.parse(start)
  return {
    now: () => new Date(t).toISOString(),
    advance: (ms: number) => {
      t += ms
    },
  }
}

function make() {
  const clock = clockAt()
  let r = 0.1
  const svc = createNotifications({
    clock,
    random: () => {
      r = (r * 7.3) % 1
      return r
    },
  })
  return { clock, svc }
}

describe('表：合并 / 已读 / 保留期', () => {
  it('同一件事还没读时合并成一条、顶上来、计数加一；读过了再来重新算一条未读', () => {
    const { clock, svc } = make()
    svc.notify({ ...me, category: 'connection', text: 'Shopify 连接断了', key: 'conn:1' })
    clock.advance(1000)
    svc.notify({ ...me, category: 'task', text: '「选品」跑完了', key: 'run:m1' })
    clock.advance(1000)
    svc.notify({ ...me, category: 'connection', text: 'Shopify 连接断了', key: 'conn:1' })
    let list = svc.list(me, { view: 'unread', limit: 50 })
    expect(list.unread).toBe(2)
    expect(list.items.map((n) => n.key)).toEqual(['conn:1', 'run:m1'])
    expect(list.items[0]?.count).toBe(2)

    const first = list.items[0]?.id ?? ''
    expect(svc.markRead(me, [first]).unread).toBe(1)
    expect(svc.list(me, { view: 'all', limit: 50 }).items).toHaveLength(2)
    svc.notify({ ...me, category: 'connection', text: 'Shopify 连接断了', key: 'conn:1' })
    list = svc.list(me, { view: 'unread', limit: 50 })
    expect(list.unread).toBe(2)
    expect(list.items[0]).toMatchObject({ key: 'conn:1', count: 1, id: first })
    expect(list.items[0]?.read_at).toBeUndefined()
  })

  it('全部已读；不给键的每次都是新的一条；别人的看不到', () => {
    const { svc } = make()
    svc.notify({ ...me, category: 'team', text: '一' })
    svc.notify({ ...me, category: 'team', text: '一' })
    svc.notify({ workspace_id: WS, person_id: PEER, category: 'team', text: '给同事的' })
    expect(svc.list(me, { view: 'unread', limit: 50 }).unread).toBe(2)
    expect(svc.markAllRead(me).unread).toBe(0)
    expect(svc.list(me, { view: 'unread', limit: 50 }).items).toEqual([])
    expect(
      svc.list({ workspace_id: WS, person_id: PEER }, { view: 'unread', limit: 5 }).unread,
    ).toBe(1)
  })

  it('那件事办完了（settle）：同键还没读的收成已读', () => {
    const { svc } = make()
    svc.notify({ ...me, category: 'connection', text: '断了', key: 'conn:9' })
    svc.notify({
      workspace_id: WS,
      person_id: PEER,
      category: 'connection',
      text: '断了',
      key: 'conn:9',
    })
    svc.settle(WS, 'conn:9')
    expect(svc.list(me, { view: 'unread', limit: 5 }).unread).toBe(0)
    expect(
      svc.list({ workspace_id: WS, person_id: PEER }, { view: 'unread', limit: 5 }).unread,
    ).toBe(0)
  })

  it('过了 30 天的删掉（发新的时顺手清）', () => {
    const { clock, svc } = make()
    svc.notify({ ...me, category: 'task', text: '老的' })
    clock.advance(31 * 86_400_000)
    svc.notify({ ...me, category: 'task', text: '新的' })
    // 发 / 读的时候顺手清（一小时最多一次），也可以直接叫
    expect(svc.prune()).toBe(0)
    expect(svc.list(me, { view: 'all', limit: 50 }).items.map((n) => n.text)).toEqual(['新的'])
  })
})

describe('设置 → 通知：每类「站内 / 系统」', () => {
  it('默认：站内全开；系统只开同事、连接、积分', () => {
    const { svc } = make()
    const p = svc.prefs(me)
    expect(p.team).toEqual({ inbox: true, system: true })
    expect(p.task).toEqual({ inbox: true, system: false })
    expect(p.connection.system).toBe(true)
    expect(p.credits.system).toBe(true)
    expect(p.update.system).toBe(false)
  })

  it('站内关了：这一类不记（系统也跟着关）；系统开着的那一类来的标 system', () => {
    const { svc } = make()
    svc.setPrefs(me, { update: { inbox: false } })
    expect(svc.prefs(me).update).toEqual({ inbox: false, system: false })
    expect(svc.notify({ ...me, category: 'update', text: '岗位更新到了' })).toBeUndefined()
    svc.setPrefs(me, { task: { system: true } })
    expect(svc.notify({ ...me, category: 'task', text: '跑完了' })?.system).toBe(true)
    expect(svc.notify({ ...me, category: 'connection', text: '断了' })?.system).toBe(true)
    svc.setPrefs(me, { connection: { system: false } })
    expect(svc.notify({ ...me, category: 'connection', text: '又断了' })?.system).toBe(false)
  })
})

const card = (over: Partial<ApprovalItem> & { payload?: unknown }): ApprovalItem =>
  ({
    id: 'apv_1',
    kind: 'claim',
    title: '把「退款单」交给你',
    payload: {},
    proposer: { kind: 'agent', id: 'x' },
    routing: {
      recipients: [],
      rule: 'role_holder',
      escalation: { after_hours: 24, business_hours: true, chain: [], escalated_at: [] },
      separation_of_duties: false,
    },
    ...over,
  }) as unknown as ApprovalItem

function resolver(items: Record<string, ApprovalItem> = {}): NotificationResolver {
  return {
    personName: (id) => ({ p_me: '我', p_peer: '陈晓' })[id as string],
    owners: () => [ME],
    approval: (id) => items[id],
    handoff: (ref) => ({ title: '核对退款单', href: `/matters/${ref.id}` }),
  }
}

const ev = (
  type: string,
  payload: Record<string, unknown>,
  subject?: { type: string; id: string },
): Pick<EventEnvelope, 'type' | 'workspace_id' | 'actor' | 'subject' | 'payload'> => ({
  type,
  workspace_id: WS,
  actor: { kind: 'system', id: 't' },
  ...(subject === undefined ? {} : { subject }),
  payload,
})

describe('从事件认出来的', () => {
  it('交出去的事：接下 / 没接 / 退回告诉交的人；③ 派下来的告诉接的人', async () => {
    const ctx = resolver()
    const subject = { type: 'matter', id: 'm1' }
    const acc = await notificationsOfEvent(
      ev('handoff.accepted', { from: ME, to: PEER }, subject),
      ctx,
    )
    expect(acc).toEqual([
      expect.objectContaining({
        person_id: ME,
        category: 'team',
        text: '陈晓 接下了「核对退款单」',
        href: '/matters/m1',
        key: 'handoff:matter:m1',
      }),
    ])
    const dec = await notificationsOfEvent(
      ev('handoff.declined', { from: ME, to: PEER }, subject),
      ctx,
    )
    expect(dec[0]?.text).toBe('陈晓 没接「核对退款单」')
    const ret = await notificationsOfEvent(
      ev('handoff.returned', { from: ME, to: PEER }, subject),
      ctx,
    )
    expect(ret[0]?.text).toContain('退回给你了')
    const dis = await notificationsOfEvent(
      ev('handoff.accepted', { from: ME, to: PEER, dispatched: true }, subject),
      ctx,
    )
    expect(dis[0]).toMatchObject({ person_id: PEER, text: '我 派给你「核对退款单」' })
  })

  it('卡到了你这儿：岗位更新 / 同事交给你的 / 审批到你的进通知；自己岗位 AI 出的卡不进', async () => {
    const items = {
      digest: card({
        id: 'digest',
        kind: 'content_update_digest' as never,
        title: '运营 · 本周更新 · 3 项',
      }),
      peer: card({ id: 'peer', proposer: { kind: 'person', id: PEER } }),
      boss: card({
        id: 'boss',
        title: '退款 300 元',
        routing: {
          recipients: [],
          rule: 'scope_manager',
          escalation: { after_hours: 24, business_hours: true, chain: [], escalated_at: [] },
          separation_of_duties: false,
        },
      }),
      ask: card({ id: 'ask', title: '陈晓问你：在忙什么', payload: { form: 'secretary_answer' } }),
      mine: card({ id: 'mine', title: '回复客户' }),
    }
    const ctx = resolver(items)
    const of = async (id: string) =>
      notificationsOfEvent(ev('approval.delivered', { to: ME }, { type: 'approval_item', id }), ctx)
    expect(await of('digest')).toEqual([
      expect.objectContaining({ category: 'update', href: '/cards/digest', key: 'card:digest' }),
    ])
    expect((await of('peer'))[0]?.text).toBe('陈晓：把「退款单」交给你')
    expect((await of('boss'))[0]?.text).toBe('等你批：退款 300 元')
    expect((await of('ask'))[0]?.category).toBe('team')
    expect(await of('mine')).toEqual([])
  })

  it('③ 降回 ②：除了改的人，同事们各一条「X 把这里改回了同事互联」（原来首页一行「知道了」）', async () => {
    const ctx = { ...resolver(), members: () => [ME, PEER] }
    const out = await notificationsOfEvent(
      {
        ...ev('organization.mode_changed', {
          organization_id: 'org_1',
          mode: 'peers',
          from: 'company',
        }),
        actor: { kind: 'person', id: PEER },
      },
      ctx,
    )
    expect(out).toEqual([
      expect.objectContaining({
        person_id: ME,
        text: '陈晓 把这里改回了同事互联',
        key: 'mode:org_1',
      }),
    ])
    expect(
      await notificationsOfEvent(
        ev('organization.mode_changed', { mode: 'company', from: 'peers' }),
        ctx,
      ),
    ).toEqual([])
  })

  it('WP430：模型订阅要重新登录 → 「你的 ChatGPT 订阅要重新登录」，到设置 → 模型；同一来源合并', async () => {
    const { svc } = make()
    svc.register(WS, resolver())
    const e = {
      ...ev(RELOGIN_NEEDED_EVENT, { source_name: 'ChatGPT 订阅' }),
      schema_version: 1,
      correlation: { trace_id: 't' },
    }
    svc.onEvent(e)
    svc.onEvent(e)
    await svc.flush()
    const list = svc.list(me, { view: 'unread', limit: 5 })
    expect(list.items).toHaveLength(1)
    expect(list.items[0]).toMatchObject({
      text: '你的ChatGPT 订阅要重新登录',
      href: '/settings/models',
      category: 'connection',
      count: 2,
      system: true,
    })
  })

  it('卡定了 / 撤了：它那条通知收成已读', async () => {
    const { svc } = make()
    svc.register(
      WS,
      resolver({ peer: card({ id: 'peer', proposer: { kind: 'person', id: PEER } }) }),
    )
    const base = { schema_version: 1, correlation: { trace_id: 't' } }
    svc.onEvent({
      ...ev('approval.delivered', { to: ME }, { type: 'approval_item', id: 'peer' }),
      ...base,
    })
    await svc.flush()
    expect(svc.list(me, { view: 'unread', limit: 5 }).unread).toBe(1)
    svc.onEvent({ ...ev('approval.decided', {}, { type: 'approval_item', id: 'peer' }), ...base })
    await svc.flush()
    expect(svc.list(me, { view: 'unread', limit: 5 }).unread).toBe(0)
  })
})

describe('装配处直接发的几类', () => {
  const run = {
    run_id: 'run_1',
    matter_id: 'm1',
    matter_title: '找 5 个 subreddit',
    person_id: ME,
    started_at: '2026-10-19T02:00:00.000Z',
  }
  it('任务：跑完的只有跑够一分钟才告诉；停下 / 没跑成都告诉；人点停的不告诉', () => {
    expect(
      runEndedNotification(WS, {
        ...run,
        outcome: 'completed',
        ended_at: '2026-10-19T02:00:20.000Z',
      }),
    ).toBeUndefined()
    expect(
      runEndedNotification(WS, {
        ...run,
        outcome: 'completed',
        ended_at: '2026-10-19T02:03:00.000Z',
      }),
    ).toMatchObject({ text: '「找 5 个 subreddit」跑完了', href: '/matters/m1', category: 'task' })
    expect(
      runEndedNotification(WS, {
        ...run,
        outcome: 'stopped',
        reason: 'budget',
        ended_at: '2026-10-19T02:00:20.000Z',
      })?.text,
    ).toBe('「找 5 个 subreddit」被停下了')
    expect(
      runEndedNotification(WS, {
        ...run,
        outcome: 'stopped',
        reason: 'user',
        ended_at: '2026-10-19T02:03:00.000Z',
      }),
    ).toBeUndefined()
    expect(
      runEndedNotification(WS, { ...run, outcome: 'failed', ended_at: '2026-10-19T02:00:05.000Z' })
        ?.text,
    ).toBe('「找 5 个 subreddit」没跑成')
  })

  it('连接断了、积分快用完的文字与去处', () => {
    expect(connectionBrokenNotification(WS, ME, { id: 'c1', label: 'Shopify' })).toMatchObject({
      text: 'Shopify 连接断了，要重新连一下',
      href: '/settings/connections',
      key: 'conn:c1',
    })
    expect(creditsLowNotification(WS, ME, 12.6)).toMatchObject({
      text: '工坊积分快用完了，还剩 12',
      href: '/settings/account#credits',
      category: 'credits',
    })
  })
})

describe('真装配线', () => {
  let server: Server | undefined
  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  const call = async (s: Server, method: string, path: string, body?: unknown) => {
    const headers = new Headers()
    headers.set('Authorization', `Bearer ${s.bootstrap.internalToken}`)
    headers.set('X-Assignment', s.bootstrap.ownerAssignment.id)
    if (body !== undefined) headers.set('content-type', 'application/json')
    const res = await s.gateway.fetch(
      new Request(`http://127.0.0.1${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
    return { status: res.status, data: ((await res.json()) as { data: unknown }).data }
  }

  it('路由：列表 / 已读 / 全部已读 / 设置；事件日志里的「要重新登录」进了所有者的铃铛', async () => {
    const clock = clockAt()
    server = await createServer({ quiet: true, clock, startRun: false })
    const s = server
    const ws = s.bootstrap.workspace.id
    const owner = s.bootstrap.person.id
    // WP430 的事件（还没合）：宿主 appendEvent 交给通知的就是这一下
    s.notifications.onEvent({
      schema_version: 1,
      workspace_id: ws,
      type: RELOGIN_NEEDED_EVENT,
      actor: { kind: 'system', id: 'model-gateway' },
      correlation: { trace_id: 't' },
      payload: { source_name: 'ChatGPT 订阅' },
    })
    await s.notifications.flush()
    s.notifications.notify({
      workspace_id: ws,
      person_id: owner,
      category: 'task',
      text: '「选品」跑完了',
      href: '/matters/m1',
    })
    const list = (await call(s, 'GET', '/v1/notifications')) as {
      status: number
      data: { items: { id: string; text: string }[]; unread: number }
    }
    expect(list.status).toBe(200)
    expect(list.data.unread).toBe(2)
    expect(list.data.items.map((n) => n.text)).toContain('你的ChatGPT 订阅要重新登录')
    const one = list.data.items[0]?.id ?? ''
    expect((await call(s, 'POST', '/v1/notifications/read', { ids: [one] })).data).toEqual({
      unread: 1,
    })
    expect((await call(s, 'POST', '/v1/notifications/read-all')).data).toEqual({ unread: 0 })
    const all = (await call(s, 'GET', '/v1/notifications?view=all&limit=1')) as {
      data: { items: unknown[]; unread: number }
    }
    expect(all.data).toMatchObject({ unread: 0 })
    expect(all.data.items).toHaveLength(1)

    const put = await call(s, 'PUT', '/v1/settings/notifications', { task: { system: true } })
    expect(put.status).toBe(200)
    expect((put.data as { task: unknown }).task).toEqual({ inbox: true, system: true })
    const got = (await call(s, 'GET', '/v1/settings/notifications')).data as {
      team: { system: boolean }
    }
    expect(got.team.system).toBe(true)
  })
})
