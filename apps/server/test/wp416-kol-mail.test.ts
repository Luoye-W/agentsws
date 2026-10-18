/**
 * WP416（自查 kol 组）：红人这一路的真执行器。
 *
 * 钉住：① 真红人的开发信批了**经已连的邮箱真发**（替身 SMTP）、读回后才记往来、合作才进「已建联」；
 * ② 没连邮箱：卡照样出但照实说、要人点，批了回「没发」，往来与阶段一个都不动；③ 真红人回信按
 * In-Reply-To 对上合作、分类、推阶段，回我们信的线程认得出来；④ 跟进只跟真发出去的、回过信不跟；
 * ⑤ 建合作卡点「不要」那一行删掉、点「同意」标记清掉；⑥ 验收结论卡批了才生效；
 * ⑦ 「一句话介绍我们」从品牌档案补（决策 531），英文信不署中文名；⑧ 挑人清单卡在「要你处理」里批了也会建合作。
 */
import type { Assignment } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DirectMailInput } from '../src/channels.js'
import { createServer, type Server } from '../src/index.js'

const T0 = '2026-10-19T09:00:00.000Z'
const SECRETS_KEY = 'a'.repeat(64)
const DAY = 86_400_000

let server: Server
let url: string
let t = Date.parse(T0)
let youtube: Assignment
let sent: DirectMailInput[] = []

const api = (path: string, init: RequestInit & { assignment?: string } = {}): Promise<Response> => {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${server.bootstrap.internalToken}`)
  headers.set('X-Assignment', init.assignment ?? youtube.id)
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  return fetch(`${url}${path}`, { ...init, headers })
}
const post = (path: string, body: unknown, method = 'POST'): Promise<Response> =>
  api(path, { method, body: JSON.stringify(body) })
const data = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data

async function boot(mailbox: boolean): Promise<void> {
  t = Date.parse(T0)
  sent = []
  server = await createServer({
    quiet: true,
    clock: { now: () => new Date(t).toISOString() },
    scheduleIntervalMs: 0,
    startRun: false,
    env: { AGENTSWS_OWNER_EMAIL: 'owner@example.com', AGENTSWS_SECRETS_KEY: SECRETS_KEY },
    ...(mailbox
      ? {
          b2bStandIns: {
            mailboxes: ['hello@brand.example'],
            sendMail: async (input: DirectMailInput) => {
              sent.push(input)
              return {
                ok: true,
                outbox_id: `ob_${sent.length}`,
                message_id: `<kol-${sent.length}@brand.example>`,
                account: 'hello@brand.example',
              }
            },
          },
        }
      : {}),
  })
  ;({ url } = await server.listen(0))
  youtube = server.roles.assignments.create({
    person_id: server.bootstrap.person.id,
    workspace_id: server.bootstrap.workspace.id,
    role_id: 'kol.youtube',
    granted_by: server.bootstrap.person.id,
    ranges: [{ kind: 'store', id: 'store_1' }],
  })
}

/** 经 HTTP 决定（走包了钩子的那条总线），再过取消窗口让执行器施行。 */
async function decide(id: string | undefined, action: 'approve' | 'reject'): Promise<void> {
  const res = await post(`/v1/approvals/${id}/decide`, {
    action,
    ...(action === 'reject' ? { reason: '不要' } : {}),
  })
  expect(res.status).toBe(200)
  t += 130_000
  await server.drainApprovals()
}

const brand = async () => server.brands.forWorkspace(server.bootstrap.workspace.id)

async function creatorWithEmail(name: string, over: Record<string, unknown> = {}): Promise<string> {
  const detail = await data<{ creator: { id: string } }>(
    await post('/v1/kol/creators', {
      display_name: name,
      channel: 'youtube',
      handle: name.toLowerCase().replace(/\s/g, ''),
      followers: 48_000,
      ...over,
    }),
  )
  await post(`/v1/kol/creators/${detail.creator.id}/contacts`, {
    kind: 'email',
    value: `${name.toLowerCase().replace(/\s/g, '')}@creator.example`,
  })
  return detail.creator.id
}

/** 建一条合作并批掉（批了才落库）。 */
async function agreedCollab(creator_id: string): Promise<string> {
  const out = await data<{ approval_item_id: string; collaboration?: { id: string } }>(
    await post('/v1/kol/collaborations', { creator_id, channel: 'youtube' }),
  )
  await decide(out.approval_item_id, 'approve')
  return out.collaboration?.id as string
}

const outreach = (creator_id: string, extra: Record<string, unknown> = {}) =>
  post('/v1/kol/outreach', {
    creator_id,
    channel: 'youtube',
    product: '65W 充电器',
    brand_pitch: '我们做桌面快充。',
    ...extra,
  })

afterEach(async () => {
  await server.close()
})

describe('WP416 开发信真发（已连邮箱）', () => {
  beforeEach(async () => {
    await boot(true)
  })

  it('批了经邮箱发出去：收件人是加密库里的真地址；读回后记往来、合作进「已建联」、发出记录有一行', async () => {
    const id = await creatorWithEmail('Gadget Jonas')
    const collab = await agreedCollab(id)
    const out = await data<{ staged: boolean; approval_item_id: string; needs_mailbox?: boolean }>(
      await outreach(id),
    )
    expect(out.staged).toBe(true)
    expect(out.needs_mailbox).toBeUndefined()
    // 提卡不改阶段（以前一提卡就「已建联」）
    const store = (await brand()).kol
    expect(store.collaboration(collab)?.stage).toBe('sourced')
    await decide(out.approval_item_id, 'approve')
    expect(sent).toHaveLength(1)
    expect(sent[0]?.to).toEqual(['gadgetjonas@creator.example'])
    const xs = store.exchanges({ creator_id: id })
    expect(xs).toHaveLength(1)
    expect(xs[0]?.direction).toBe('out')
    expect(xs[0]?.mail_message_id).toBe('<kol-1@brand.example>')
    expect(store.collaboration(collab)?.stage).toBe('contacted')
    const records = await data<{ kind: string }[]>(await api('/v1/outbound/records'))
    expect(records.filter((r) => r.kind === 'kol_outreach')).toHaveLength(1)
  })

  it('回信按 In-Reply-To 对上合作：记入站往来、分类、合作进「有回音」；回我们信的线程认得出来', async () => {
    const id = await creatorWithEmail('Gadget Jonas')
    const collab = await agreedCollab(id)
    const out = await data<{ approval_item_id: string }>(await outreach(id))
    await decide(out.approval_item_id, 'approve')
    const b = await brand()
    expect(b.kolMail?.isOurThread('<kol-1@brand.example>', [])).toBe(true)
    expect(b.kolMail?.isOurThread('<other@x.example>', [])).toBe(false)
    const res = b.kolMail?.intake({
      from_email: 'GadgetJonas@creator.example',
      subject: 'Re: hello',
      text: 'Sounds interesting, happy to learn more.',
      message_id: '<r1@creator.example>',
      in_reply_to: '<kol-1@brand.example>',
    })
    expect(res?.matched).toBe(true)
    expect(res?.collaboration_id).toBe(collab)
    expect(b.kol.collaboration(collab)?.stage).toBe('replied')
    const inbound = b.kol.exchanges({ creator_id: id }).filter((x) => x.direction === 'in')
    expect(inbound).toHaveLength(1)
    // 同一封再递一次不重复记
    b.kolMail?.intake({
      from_email: 'gadgetjonas@creator.example',
      subject: 'Re: hello',
      text: 'Sounds interesting',
      message_id: '<r1@creator.example>',
    })
    expect(b.kol.exchanges({ creator_id: id }).filter((x) => x.direction === 'in')).toHaveLength(1)
    // 陌生人对不上
    expect(
      b.kolMail?.intake({ from_email: 'nobody@else.example', subject: 'hi', text: 'hi' }).matched,
    ).toBe(false)
  })

  it('跟进只跟真发出去的：首封发出第 3 天提跟进；对方回过信就不再跟', async () => {
    const id = await creatorWithEmail('Gadget Jonas')
    await agreedCollab(id)
    const first = await data<{ approval_item_id: string }>(await outreach(id))
    await decide(first.approval_item_id, 'approve')
    const b = await brand()
    t += 3 * DAY
    const due = await b.kolService.sweepSequences()
    expect(due.staged).toBe(1)
    // 上一封跟进还在等批：同一天再扫不重复提
    expect((await b.kolService.sweepSequences()).staged).toBe(0)

    // 另一个人：回过信 → 不跟
    const id2 = await creatorWithEmail('Desk Rosa')
    await agreedCollab(id2)
    const f2 = await data<{ approval_item_id: string }>(await outreach(id2))
    await decide(f2.approval_item_id, 'approve')
    const msg = b.kol.exchanges({ creator_id: id2 }).find((x) => x.direction === 'out')
    b.kolMail?.intake({
      from_email: 'deskrosa@creator.example',
      subject: 'Re',
      text: 'What is your budget? Send me a quote.',
      in_reply_to: msg?.mail_message_id as string,
    })
    // 有回音之后不在「已建联」里，扫都不扫
    t += 4 * DAY
    const after = await b.kolService.sweepSequences()
    expect(
      after.skipped.some((s) => s.collaboration_id.length > 0 && s.reason.includes('首封')),
    ).toBe(false)
    const changes = await server.txn.ledger.list({
      workspace_id: server.bootstrap.workspace.id,
      kind: 'kol_outreach',
    })
    const forRosa = changes.filter((c) => (c.after as { creator_id?: string }).creator_id === id2)
    expect(forRosa).toHaveLength(1)
  })

  it('首封被拒（没发出去）就不排跟进', async () => {
    const id = await creatorWithEmail('Gadget Jonas')
    await agreedCollab(id)
    const first = await data<{ approval_item_id: string }>(await outreach(id))
    await decide(first.approval_item_id, 'reject')
    expect(sent).toHaveLength(0)
    t += 3 * DAY
    const out = await (await brand()).kolService.sweepSequences()
    expect(out.staged).toBe(0)
  })
})

describe('WP416 没连邮箱', () => {
  beforeEach(async () => {
    await boot(false)
  })

  it('卡照样出但照实说、要人点；批了回「没发」，往来与阶段不动', async () => {
    const id = await creatorWithEmail('Gadget Jonas')
    const collab = await agreedCollab(id)
    const out = await data<{
      staged: boolean
      auto_approved?: boolean
      approval_item_id: string
      needs_mailbox?: boolean
    }>(await outreach(id))
    expect(out.staged).toBe(true)
    expect(out.needs_mailbox).toBe(true)
    expect(out.auto_approved).toBe(false)
    const change = (
      await server.txn.ledger.list({
        workspace_id: server.bootstrap.workspace.id,
        kind: 'kol_outreach',
      })
    )[0]
    expect(change?.notes.join('\n')).toContain('还没连发信邮箱')
    await decide(out.approval_item_id, 'approve')
    const item = await server.txn.approvals.get(out.approval_item_id)
    expect(item?.state).not.toBe('applied')
    const store = (await brand()).kol
    expect(store.exchanges({ creator_id: id })).toHaveLength(0)
    expect(store.collaboration(collab)?.stage).toBe('sourced')
    const records = await data<{ kind: string }[]>(await api('/v1/outbound/records'))
    expect(records.filter((r) => r.kind === 'kol_outreach')).toHaveLength(0)
  })
})

describe('WP416 建合作 / 验收卡批了才生效', () => {
  beforeEach(async () => {
    await boot(true)
  })

  it('建合作卡：出卡时标「等你点头」；点「不要」这一行删掉；点「同意」标记清掉', async () => {
    const id = await creatorWithEmail('Gadget Jonas')
    const store = (await brand()).kol
    const a = await data<{ approval_item_id: string; collaboration?: { id: string } }>(
      await post('/v1/kol/collaborations', { creator_id: id, channel: 'youtube' }),
    )
    expect(store.collaboration(a.collaboration?.id as string)?.awaiting_approval).toBe(true)
    await decide(a.approval_item_id, 'reject')
    expect(store.collaboration(a.collaboration?.id as string)).toBeUndefined()

    const b = await data<{ approval_item_id: string; collaboration?: { id: string } }>(
      await post('/v1/kol/collaborations', { creator_id: id, channel: 'youtube' }),
    )
    await decide(b.approval_item_id, 'approve')
    const row = store.collaboration(b.collaboration?.id as string)
    expect(row).toBeDefined()
    expect(row?.awaiting_approval).toBeUndefined()
  })

  it('验收结论卡批了，交付物才变成「通过」', async () => {
    const id = await creatorWithEmail('Gadget Jonas')
    const collab = await agreedCollab(id)
    const store = (await brand()).kol
    store.saveCollaboration({ ...(store.collaboration(collab) as never), stage: 'delivering' })
    const d = await data<{ id: string }>(
      await post('/v1/kol/deliverables', {
        collaboration_id: collab,
        kind: 'video',
        due_at: new Date(t + 7 * DAY).toISOString(),
      }),
    )
    const r = await data<{ approval_item_id?: string; auto_approved?: boolean }>(
      await post(`/v1/kol/deliverables/${d.id}/review`, { review: 'approved' }),
    )
    if (r.auto_approved !== true) {
      expect(store.deliverables().find((x) => x.id === d.id)?.review).toBe('pending')
      await decide(r.approval_item_id, 'approve')
    }
    expect(store.deliverables().find((x) => x.id === d.id)?.review).toBe('approved')
  })
})

describe('WP416 起草默认值（决策 531）', () => {
  beforeEach(async () => {
    await boot(true)
  })

  it('「一句话介绍我们」不给就从品牌档案补，卡上说一句；存过的优先；英文信不署中文名', async () => {
    const res = await fetch(`${url}/v1/workspace/profile`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${server.bootstrap.internalToken}`,
        'X-Assignment': server.bootstrap.ownerAssignment.id,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ legal_name: 'NordVolt GmbH', one_liner: 'We make desk chargers.' }),
    })
    expect(res.status).toBe(200)
    const d0 = await data<{ brand_pitch: string; source: string; mailbox_connected: boolean }>(
      await api('/v1/kol/outreach/defaults'),
    )
    expect(d0).toMatchObject({
      brand_pitch: 'We make desk chargers.',
      source: 'brand_profile',
      mailbox_connected: true,
    })
    const id = await creatorWithEmail('Gadget Jonas', { language: 'en' })
    const out = await data<{ staged: boolean; body: string }>(
      await post('/v1/kol/outreach', {
        creator_id: id,
        channel: 'youtube',
        product: 'the charger',
      }),
    )
    expect(out.staged).toBe(true)
    expect(out.body).toContain('We make desk chargers.')
    // 署名人是中文名（演示里的「王岚」这类）→ 英文信不署中文，用「品牌 team」，开头也顺
    if (out.body.includes(' team')) expect(out.body).not.toMatch(/I'm The .* team from/)
    const change = (
      await server.txn.ledger.list({
        workspace_id: server.bootstrap.workspace.id,
        kind: 'kol_outreach',
      })
    )[0]
    expect(change?.notes.join('\n')).toContain('取自品牌档案')

    const saved = await data<{ brand_pitch: string; product: string; source: string }>(
      await post(
        '/v1/kol/outreach/defaults',
        { brand_pitch: 'Desk chargers, done right.', product: 'the 65W charger' },
        'PUT',
      ),
    )
    expect(saved).toMatchObject({
      brand_pitch: 'Desk chargers, done right.',
      product: 'the 65W charger',
      source: 'saved',
    })
  })
})

describe('WP416 挑人清单卡在「要你处理」里批了也建合作', () => {
  beforeEach(async () => {
    await boot(true)
  })

  it('批了清单卡 = 面板上点「接受」', async () => {
    await creatorWithEmail('Gadget Jonas', { category: '数码' })
    await creatorWithEmail('Desk Rosa', { category: '数码' })
    const plan = await data<{ ready: boolean; approval_item_id?: string }>(
      await post('/v1/kol/campaigns', {
        goal: '新品建联',
        budget: 1000,
        channels: ['youtube'],
        headcount: 2,
      }),
    )
    expect(plan.ready).toBe(true)
    const before = (await brand()).kol.collaborations().length
    await decide(plan.approval_item_id, 'approve')
    expect((await brand()).kol.collaborations().length).toBeGreaterThan(before)
  })
})

describe('WP416 同一人合并卡：卡上选了就生效', () => {
  beforeEach(async () => {
    await boot(true)
  })

  const twins = async (): Promise<{ a: string; b: string; card: string }> => {
    const make = async (name: string, handle: string): Promise<string> => {
      const d = await data<{ creator: { id: string } }>(
        await post('/v1/kol/creators', { display_name: name, channel: 'youtube', handle }),
      )
      await post(`/v1/kol/creators/${d.creator.id}/contacts`, {
        kind: 'email',
        value: 'same@creator.example',
      })
      return d.creator.id
    }
    const a = await make('Gadget Jonas', 'gadgetjonas')
    const b = await make('Jonas G', 'jonasg')
    const rows = await data<{ rows: { approval_item_id?: string }[] }>(
      await api('/v1/kol/merge-suggestions'),
    )
    return { a, b, card: rows.rows[0]?.approval_item_id as string }
  }

  it('选「是同一个人，合」→ 真合成一个', async () => {
    const { card } = await twins()
    const res = await post(`/v1/approvals/${card}/decide`, {
      action: 'approve',
      selected_option_id: 'merge',
    })
    expect(res.status).toBe(200)
    expect((await brand()).kol.creators()).toHaveLength(1)
  })

  it('选「不是同一个人」→ 记下（落盘），建议不再冒出来', async () => {
    const { card } = await twins()
    const res = await post(`/v1/approvals/${card}/decide`, {
      action: 'approve',
      selected_option_id: 'keep_apart',
    })
    expect(res.status, await res.clone().text()).toBe(200)
    const store = (await brand()).kol
    expect(store.creators()).toHaveLength(2)
    expect(store.setting<string[]>('merge_rejected')).toHaveLength(1)
    const again = await data<{ rows: unknown[] }>(await api('/v1/kol/merge-suggestions'))
    expect(again.rows).toHaveLength(0)
  })
})
