/**
 * WP510（决策 1515）：同事 / 公司模式的收件箱——网关这一层。
 *
 * 钉住的是：
 * - ① 个人（或没装团队那一面）：收件箱和以前一模一样（没有 `team`、行上没有 `owners` / `mine`）；
 * - ② / ③：「给我的」/「全部」——别人的卡只在「全部」里、按钮不给；信按邮箱负责人分（没指定的谁都看得到）；
 *   负责人不在转给兜底的人时写上原来是谁；
 * - 「刚处理」：谁批了 / 不要了哪一张；
 * - 心跳与分工那几条路的校验。
 */
import type {
  InboxPresenceView,
  MessageThreadSummary,
  OwnerRoute,
  TeamInboxPatch,
  TeamInboxView,
  TeamMember,
} from '@agentsws/contracts'
import type { InboxView } from '@agentsws/deck'
import { describe, expect, it } from 'vitest'
import type { GatewayDeps, MessagesPort, TeamInboxPort } from '../src/index.js'
import { createGateway } from '../src/index.js'
import { approvalItem, type Harness, harness } from './helpers.js'

const json = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data

const thread = (over: Partial<MessageThreadSummary>): MessageThreadSummary => ({
  thread_id: '<t1@x>',
  subject: 'Sample request',
  participants: [{ email: 'sam@shop.example', name: 'Sam Lee' }],
  last_at: '2026-09-07T08:00:00.000Z',
  count: 1,
  unread: 1,
  starred: false,
  labels: [],
  route: 'inbox',
  folders: ['INBOX'],
  accounts: ['sales@brand.example'],
  needs_reply: true,
  snippet: '',
  last_message_id: 'msg_1',
  claim: 'unclaimed',
  claim_message_id: 'msg_1',
  kind: 'inquiry',
  kind_confidence: 0.35,
  suggest: { action: 'hand', position: 'b2b' },
  ...over,
})

function messagesPort(): MessagesPort {
  const unsupported = (): never => {
    throw new Error('not used')
  }
  return {
    accounts: () => ({ accounts: [] }),
    threads: (_a, q) => ({
      threads:
        q.claim === 'unclaimed'
          ? [
              thread({}),
              thread({
                thread_id: '<t2@x>',
                claim_message_id: 'msg_2',
                last_message_id: 'msg_2',
                accounts: ['hello@brand.example'],
              }),
              thread({
                thread_id: '<t3@x>',
                claim_message_id: 'msg_3',
                last_message_id: 'msg_3',
                accounts: ['ops@brand.example'],
              }),
            ]
          : [],
    }),
    thread: unsupported,
    message: unsupported,
    setFlags: unsupported,
    move: unsupported,
    setLabels: unsupported,
    showImages: unsupported,
    labels: () => ({ labels: [] }),
    putLabel: unsupported,
    deleteLabel: unsupported,
    mergeLabels: unsupported,
    senderRules: () => ({ rules: [] }),
    deleteSenderRule: unsupported,
    drafts: () => ({ drafts: [] }),
    saveDraft: unsupported,
    discardDraft: unsupported,
    send: unsupported,
    assistant: unsupported,
    toTodo: unsupported,
    sync: unsupported,
    backfill: unsupported,
  }
}

/** 团队那一面的替身：sales@ 归我，hello@ 归同事（他不在、转给我），ops@ 没指定。 */
function teamPort(
  h: Harness,
  mode: 'solo' | 'peers' | 'company',
  log: { presence: (string | null)[]; patches: TeamInboxPatch[]; swept: number },
): TeamInboxPort {
  const members: TeamMember[] = [
    { person_id: h.person_id, name: '王芳', admin: true },
    { person_id: h.other_id, name: '林峰', admin: false },
  ]
  const none: OwnerRoute = { to: [], owners: [], fallback: false, away: [] }
  return {
    team: () => ({ mode, members }),
    ownersOf: (_a, account) =>
      account === 'sales@brand.example'
        ? { to: [h.person_id], owners: [h.person_id], fallback: false, away: [] }
        : account === 'hello@brand.example'
          ? { to: [h.person_id], owners: [h.other_id], fallback: true, away: [h.other_id] }
          : none,
    view: () =>
      ({
        mode,
        me: h.person_id,
        can_edit: true,
        settings: { away_days: 3, fallback: 'admins' },
        mailboxes: [],
        members: members.map((m) => ({ ...m, away: false })),
      }) satisfies TeamInboxView,
    update: (_a, patch) => {
      log.patches.push(patch)
      return {
        mode,
        me: h.person_id,
        can_edit: true,
        settings: { away_days: patch.away_days ?? 3, fallback: patch.fallback ?? 'admins' },
        mailboxes: [],
        members: [],
      }
    },
    presence: (_a, item) => {
      log.presence.push(item)
      return { viewers: { 'card:ap_1': [{ person_id: h.other_id, name: '林峰' }] } }
    },
    sweep: () => {
      log.swept += 1
    },
  }
}

function withPorts(h: Harness, extra: Partial<GatewayDeps>): Harness {
  const deps: GatewayDeps = { ...h.deps, messages: messagesPort(), ...extra }
  const gateway = createGateway(deps)
  const call = async (method: string, path: string, body?: unknown): Promise<Response> => {
    const headers = new Headers({
      Authorization: `Bearer ${h.token}`,
      'X-Assignment': h.assignment.id,
    })
    if (body !== undefined) headers.set('content-type', 'application/json')
    return gateway.fetch(
      new Request(`http://127.0.0.1${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  }
  return {
    ...h,
    gateway,
    deps,
    get: (path) => call('GET', path),
    post: (path, body) => call('POST', path, body),
    put: (path: string, body: unknown) => call('PUT', path, body),
  } as Harness & { put(path: string, body: unknown): Promise<Response> }
}

/** 一张只发给同事的卡（「全部」里看得到、按钮不给）。 */
function seedOthers(h: Harness): void {
  h.approvals.seed(
    approvalItem({
      id: 'ap_lin',
      dedupe_key: 'dk_lin',
      workspace_id: h.workspace_id,
      subject: { object: { type: 'thread', id: 'thr_lin' } },
      title: '林峰的回信卡',
      routing: { ...h.item.routing, recipients: [{ person: h.other_id, via: 'role_holder' }] },
      deliveries: [],
    }),
  )
}

describe('WP510 ① 个人：收件箱和以前一模一样', () => {
  it('没装团队那一面 / 装了但是 ①：没有 team、行上没有 owners / mine；scope=all 不起作用', async () => {
    for (const port of [undefined, 'solo'] as const) {
      const base = await harness()
      seedOthers(base)
      const log = { presence: [], patches: [], swept: 0 }
      const h = withPorts(
        base,
        port === undefined ? {} : { teamInbox: teamPort(base, 'solo', log) },
      )
      const view = await json<InboxView>(await h.get('/v1/inbox?scope=all'))
      expect(view.team).toBeUndefined()
      expect(view.items.some((i) => 'owners' in i || 'mine' in i || 'fallback_from' in i)).toBe(
        false,
      )
      // 卡照旧原样（替身的岗位队列不按收件人筛，这里只看没有多出来的字段与按钮照旧）
      expect(view.items.find((i) => i.card?.id === 'ap_lin')?.primary).toBe('approve')
      expect(view.counts.mail).toBe(3)
      expect(log.swept).toBe(0)
    }
  })
})

describe('WP510 ② / ③：给我的 / 全部、邮箱负责人、刚处理', () => {
  it('「给我的」只有给我的：别人的卡不在、别人邮箱的信不在、没指定负责人的信照旧在', async () => {
    const base = await harness()
    seedOthers(base)
    const log = { presence: [], patches: [], swept: 0 }
    const h = withPorts(base, { teamInbox: teamPort(base, 'peers', log) })
    const view = await json<InboxView>(await h.get('/v1/inbox'))
    expect(log.swept).toBe(1)
    expect(view.team).toMatchObject({ mode: 'peers', scope: 'mine' })
    expect(view.items.some((i) => i.card?.id === 'ap_lin')).toBe(false)
    const mine = view.items.find((i) => i.card?.id === base.item.id)
    expect(mine?.mine).toBe(true)
    expect(mine?.owners?.map((o) => o.name).sort()).toEqual(['林峰', '王芳'])
    const sales = view.items.find((i) => i.mail?.thread_id === '<t1@x>')
    expect(sales?.owners).toEqual([{ person_id: base.person_id, name: '王芳' }])
    // 同事不在：hello@ 的信转给我，写上原来是谁
    const hello = view.items.find((i) => i.mail?.thread_id === '<t2@x>')
    expect(hello?.mine).toBe(true)
    expect(hello?.fallback_from).toEqual([{ person_id: base.other_id, name: '林峰' }])
    // 没指定负责人：谁都看得到、没有 owners
    const ops = view.items.find((i) => i.mail?.thread_id === '<t3@x>')
    expect(ops?.mine).toBe(true)
    expect(ops?.owners).toBeUndefined()
    expect(view.team?.mine).toBe(view.items.length)
    expect(view.team?.all).toBe(view.items.length + 1)
    expect(view.counts.all).toBe(view.items.length)
  })

  it('「全部」：同事的卡也在，按钮不给、行尾只有「打开」，写着给谁', async () => {
    const base = await harness()
    seedOthers(base)
    const log = { presence: [], patches: [], swept: 0 }
    const h = withPorts(base, { teamInbox: teamPort(base, 'company', log) })
    const view = await json<InboxView>(await h.get('/v1/inbox?scope=all'))
    expect(view.team).toMatchObject({ mode: 'company', scope: 'all' })
    const lin = view.items.find((i) => i.card?.id === 'ap_lin')
    expect(lin?.mine).toBe(false)
    expect(lin?.primary).toBe('open')
    expect(lin?.card?.available_actions).toEqual([])
    expect(lin?.owners).toEqual([{ person_id: base.other_id, name: '林峰' }])
    expect(view.counts.all).toBe(view.team?.all)
  })

  it('「刚处理」：同事批了哪一张、写他的名字；自己的标 self', async () => {
    const base = await harness()
    seedOthers(base)
    const lin = base.approvals.items.get('ap_lin')
    if (lin === undefined) throw new Error('no seed')
    lin.state = 'approved'
    lin.decision = {
      action: 'approve',
      by: base.other_id,
      at: base.clock.now(),
      via: 'workstation',
    }
    const log = { presence: [], patches: [], swept: 0 }
    const h = withPorts(base, { teamInbox: teamPort(base, 'peers', log) })
    const view = await json<InboxView>(await h.get('/v1/inbox'))
    expect(view.team?.handled).toEqual([
      expect.objectContaining({
        card_id: 'ap_lin',
        title: '林峰的回信卡',
        by: { person_id: base.other_id, name: '林峰' },
        self: false,
        action: 'approve',
      }),
    ])
  })
})

describe('WP510 心跳与分工那几条路', () => {
  it('心跳：我开着哪一件交给端口、回别人开着哪几件；null = 没开着', async () => {
    const base = await harness()
    const log = { presence: [] as (string | null)[], patches: [], swept: 0 }
    const h = withPorts(base, { teamInbox: teamPort(base, 'peers', log) })
    const out = await json<InboxPresenceView>(
      await h.post('/v1/inbox/presence', { item: 'card:ap_1' }),
    )
    expect(out.viewers['card:ap_1']?.[0]?.name).toBe('林峰')
    await h.post('/v1/inbox/presence', { item: null })
    expect(log.presence).toEqual(['card:ap_1', null])
    expect((await h.post('/v1/inbox/presence', {})).status).toBe(400)
  })

  it('分工：读 / 改一项；天数越界、一项都不改回 400；没装配回 501', async () => {
    const base = await harness()
    const log = { presence: [], patches: [] as TeamInboxPatch[], swept: 0 }
    const h = withPorts(base, { teamInbox: teamPort(base, 'peers', log) }) as Harness & {
      put(path: string, body: unknown): Promise<Response>
    }
    const view = await json<TeamInboxView>(await h.get('/v1/inbox/team'))
    expect(view.mode).toBe('peers')
    const res = await h.put('/v1/inbox/team', {
      mailbox: { account: 'sales@brand.example', owners: [base.other_id] },
    })
    expect(res.status).toBe(200)
    expect((await h.put('/v1/inbox/team', { away_days: 5 })).status).toBe(200)
    expect(log.patches).toEqual([
      { mailbox: { account: 'sales@brand.example', owners: [base.other_id] } },
      { away_days: 5 },
    ])
    expect((await h.put('/v1/inbox/team', { away_days: 0 })).status).toBe(400)
    expect((await h.put('/v1/inbox/team', {})).status).toBe(400)
    const bare = withPorts(await harness(), {})
    expect((await bare.get('/v1/inbox/team')).status).toBe(501)
  })
})
