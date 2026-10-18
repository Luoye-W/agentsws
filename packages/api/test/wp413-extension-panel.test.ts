/**
 * WP413：插件侧边栏在网关这一层的形状。
 * 1. 与 `/v1/extension/*` 同一道闸（插件令牌 + Origin），复用现有 scope：看要 `reddit.read` / `reddit.write`，处理要 `reddit.write`；
 * 2. 只列令牌绑定的那个人收得到、有权批的「发出去」卡；别人的卡看不到、批不了（404，不泄漏存在性）；
 * 3. 插件里批 = 工坊里批：走同一个审批总线，决定记 `via: 'extension'`，改过的草稿按 `approve_edited` 批；
 *    批完马上交给插件（端口 `deliverNow`）；已经在别处处理过 → 409；
 * 4. 批过的写、发出记录也只给这个人看他的，并标出在插件里批的。
 */
import type { PanelWrite } from '@agentsws/browser-action'
import type { ApprovalItem } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import type { ExtensionPanelPort, ExtensionPort } from '../src/index.js'
import { createGateway, createMemoryExtensionStore, panelCardOf } from '../src/index.js'
import { approvalItem, harness, makeClock, seeded } from './helpers.js'

const EXT_ORIGIN = 'chrome-extension://abcdefghijklmnop'

const redditPayload = (text: string) => ({
  form: 'reddit_write',
  channel: 'reddit',
  channel_label: 'Reddit · r/ivraxr',
  reddit: {
    kind: 'reply',
    subreddit: 'ivraxr',
    parent_fullname: 't1_c1',
    permalink: '/r/ivraxr/comments/abc/s/c1/',
    post_title: 'Does the Air3 work with glasses?',
    parent_author: 'alice',
    parent_text: 'Mine fogs up a bit.',
  },
  body: { text },
  reason: '用户在问兼容性',
  facts: [{ id: 'fc_1', text: 'Q: glasses? A: yes, with inserts' }],
})

async function wired() {
  const h = await harness()
  const me = h.person_id
  const other = h.other_id
  const ws = h.workspace_id
  const card = (id: string, to: string, text: string): ApprovalItem =>
    h.approvals.seed(
      approvalItem({
        id,
        workspace_id: ws,
        dedupe_key: id,
        title: `回复 alice（Reddit · r/ivraxr）${id}`,
        payload: redditPayload(text),
        routing: { ...approvalItem().routing, recipients: [{ person: to, via: 'role_holder' }] },
        deliveries: [
          {
            channel: 'workstation',
            to,
            sent_at: '2026-09-07T09:00:00.000Z',
            view: 'full',
            decision_token: `tok_${id}`,
            status: 'sent',
          },
        ],
      }),
    )
  const mineCard = card('ap_mine', me, 'Yes — the Air3 fits over most frames.')
  card('ap_other', other, 'Not for you to see.')
  // 一张不是 Reddit 写的卡（不该出现在侧边栏）
  h.approvals.seed(approvalItem({ id: 'ap_email', workspace_id: ws, dedupe_key: 'ap_email' }))

  const decided: { id: string; by: string; input: Record<string, unknown> }[] = []
  const realDecide = h.approvals.decide.bind(h.approvals)
  h.approvals.decide = async (id, by, input) => {
    decided.push({ id, by, input: input as unknown as Record<string, unknown> })
    const out = await realDecide(id, by, input)
    if ((input as { action: string }).action === 'reject') out.state = 'rejected'
    return out
  }

  const write = (job: string, approval: string, state: PanelWrite['state']): PanelWrite => ({
    job_id: job,
    approval_item_id: approval,
    state,
    subreddit: 'ivraxr',
    queued_at: '2026-09-07T09:00:00.000Z',
  })
  const calls: string[] = []
  const port: ExtensionPanelPort = {
    facts: async (s) => {
      calls.push(`facts:${s.workspace_id}`)
      return {
        workspace_name: 'IVRA',
        progress: { configured: true, reading: false, drafting: 2, pending: 3 },
        writes: [write('aj_mine', 'ap_mine', 'filling'), write('aj_other', 'ap_other', 'sent')],
        records: [
          {
            id: 'ob_1',
            sent_at: '2026-09-07T09:00:00.000Z',
            channel: 'reddit',
            action: 'reply',
            content: 'mine',
            status: 'sent',
            sinks: [],
            approval_item_id: 'ap_mine',
          },
          {
            id: 'ob_2',
            sent_at: '2026-09-07T09:00:00.000Z',
            channel: 'reddit',
            action: 'reply',
            content: 'theirs',
            status: 'sent',
            sinks: [],
            approval_item_id: 'ap_other',
          },
        ],
        sinks: [],
      }
    },
    deliverNow: async (_s, id) => {
      calls.push(`deliver:${id}`)
      return { write: write('aj_new', id, 'queued') }
    },
    refill: (_s, job) => {
      calls.push(`refill:${job}`)
      return { ok: true, write: write(job, 'ap_mine', 'queued') }
    },
  }
  const store = createMemoryExtensionStore({ clock: makeClock(), random: seeded(5) })
  const gateway = createGateway({
    ...h.deps,
    extension: { store } as unknown as ExtensionPort,
    extensionPanel: port,
  })
  const req = (method: string, path: string, headers: Headers, body?: unknown) => {
    if (body !== undefined) headers.set('content-type', 'application/json')
    return gateway.fetch(
      new Request(`http://127.0.0.1${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  }
  const owner = (method: string, path: string, body?: unknown) =>
    req(
      method,
      path,
      new Headers({ Authorization: `Bearer ${h.token}`, 'X-Assignment': h.assignment.id }),
      body,
    )
  const made = await owner('POST', '/v1/extension/pairings', {})
  const code = ((await made.json()) as { data: { code: string } }).data.code
  const paired = await req('POST', '/v1/extension/pair', new Headers({ Origin: EXT_ORIGIN }), {
    code,
  })
  const token = ((await paired.json()) as { data: { token: string } }).data.token
  const plugin = (method: string, path: string, body?: unknown, tok: string | null = token) => {
    const headers = new Headers({ Origin: EXT_ORIGIN })
    if (tok !== null) headers.set('Authorization', `Bearer ${tok}`)
    return req(method, path, headers, body)
  }
  return { h, plugin, calls, decided, mineCard, store }
}

const json = async (res: Response) => ((await res.json()) as { data: Record<string, unknown> }).data

describe('WP413 侧边栏：看', () => {
  it('没令牌 401；快照只有本人的「发出去」卡、本人的写与记录，标出在插件里批的', async () => {
    const w = await wired()
    expect((await w.plugin('GET', '/v1/extension/panel', undefined, null)).status).toBe(401)
    const res = await w.plugin('GET', '/v1/extension/panel')
    expect(res.status).toBe(200)
    const snap = await json(res)
    expect(snap.workspace_name).toBe('IVRA')
    expect(snap.person_name).toBe('me')
    expect(snap.can_act).toBe(true)
    const cards = snap.cards as { id: string; draft: { text: string }; link?: string }[]
    expect(cards.map((c) => c.id)).toEqual(['ap_mine'])
    expect(cards[0]?.draft.text).toContain('Air3')
    expect(cards[0]?.link).toBe('https://www.reddit.com/r/ivraxr/comments/abc/s/c1/')
    expect((snap.writes as PanelWrite[]).map((x) => x.job_id)).toEqual(['aj_mine'])
    const records = snap.records as Record<string, unknown>[]
    expect(records.map((r) => r.id)).toEqual(['ob_1'])
    expect(records[0]).not.toHaveProperty('approval_item_id')
  })

  it('卡的投影：原帖、被回的人、理由、依据都在；不是 Reddit 写卡回 undefined', () => {
    const card = panelCardOf(approvalItem({ payload: redditPayload('hi') }))
    expect(card).toMatchObject({
      kind: 'reply',
      subreddit: 'ivraxr',
      post_title: 'Does the Air3 work with glasses?',
      parent_author: 'alice',
      reason: '用户在问兼容性',
      draft: { text: 'hi' },
    })
    expect(card?.facts?.[0]?.id).toBe('fc_1')
    expect(panelCardOf(approvalItem())).toBeUndefined()
  })
})

describe('WP413 侧边栏：处理（插件里批 = 工坊里批）', () => {
  it('填进页面：改过的按 approve_edited 批、via=extension、批的人是令牌绑定的那个人；马上交给插件', async () => {
    const w = await wired()
    const res = await w.plugin('POST', '/v1/extension/panel/cards/ap_mine/fill', {
      text: 'Yes — edited in the side panel.',
      version: 1,
    })
    expect(res.status).toBe(200)
    expect(await json(res)).toMatchObject({
      ok: true,
      write: { job_id: 'aj_new', state: 'queued' },
    })
    expect(w.decided).toHaveLength(1)
    expect(w.decided[0]).toMatchObject({
      id: 'ap_mine',
      by: w.h.person_id,
      input: { action: 'approve_edited', via: 'extension', decision_token: 'tok_ap_mine' },
    })
    const edited = w.decided[0]?.input.edited_payload as { body: { text: string }; form: string }
    expect(edited.body.text).toBe('Yes — edited in the side panel.')
    expect(edited.form).toBe('reddit_write')
    expect(w.calls).toContain('deliver:ap_mine')
    // 已经批了（工坊那边或这里先点的）：再点 409，不再交出去第二次
    const again = await w.plugin('POST', '/v1/extension/panel/cards/ap_mine/fill', {})
    expect(again.status).toBe(409)
    expect(w.calls.filter((c) => c === 'deliver:ap_mine')).toHaveLength(1)
  })

  it('没改就按原样 approve；版本对不上 409；空草稿 400', async () => {
    const w = await wired()
    expect(
      (await w.plugin('POST', '/v1/extension/panel/cards/ap_mine/fill', { version: 7 })).status,
    ).toBe(409)
    expect(
      (await w.plugin('POST', '/v1/extension/panel/cards/ap_mine/fill', { text: '  ' })).status,
    ).toBe(400)
    const ok = await w.plugin('POST', '/v1/extension/panel/cards/ap_mine/fill', {
      text: 'Yes — the Air3 fits over most frames.',
    })
    expect(ok.status).toBe(200)
    expect(w.decided[0]?.input).toMatchObject({ action: 'approve', via: 'extension' })
    expect(w.decided[0]?.input).not.toHaveProperty('edited_payload')
  })

  it('别人的卡：看不到、批不了、不发也点不了（一律 404）；不是 Reddit 写卡也 404', async () => {
    const w = await wired()
    for (const path of [
      '/v1/extension/panel/cards/ap_other/fill',
      '/v1/extension/panel/cards/ap_other/skip',
      '/v1/extension/panel/cards/ap_email/fill',
      '/v1/extension/panel/cards/nope/fill',
    ])
      expect((await w.plugin('POST', path, {})).status).toBe(404)
    expect(w.decided).toHaveLength(0)
    // 别人那条写也不能替他再填
    expect((await w.plugin('POST', '/v1/extension/panel/writes/aj_other/refill')).status).toBe(404)
    expect((await w.plugin('POST', '/v1/extension/panel/writes/aj_mine/refill')).status).toBe(200)
    expect(w.calls).toContain('refill:aj_mine')
  })

  it('不发：驳回这张卡（reason 默认「在插件里点了不发」）、via=extension', async () => {
    const w = await wired()
    const res = await w.plugin('POST', '/v1/extension/panel/cards/ap_mine/skip', {})
    expect(res.status).toBe(200)
    expect(w.decided[0]?.input).toMatchObject({
      action: 'reject',
      via: 'extension',
      reason: '在插件里点了不发',
    })
    expect((await w.plugin('POST', '/v1/extension/panel/cards/ap_mine/skip', {})).status).toBe(409)
  })

  it('只有 reddit.read 的老令牌：能看、不能处理', async () => {
    const w = await wired()
    expect(w.store.list(w.h.workspace_id)[0]?.scopes).toContain('reddit.write')
    // 模拟 WP329 之前配的老令牌：只有 reddit.read
    const inner = (w.store as unknown as { authenticate: typeof w.store.authenticate }).authenticate
    w.store.authenticate = (raw, origin, site) => {
      const s = inner.call(w.store, raw, origin, site)
      return s === undefined ? undefined : { ...s, scopes: ['reddit.read'] }
    }
    const snap = await json(await w.plugin('GET', '/v1/extension/panel'))
    expect(snap.can_act).toBe(false)
    expect((await w.plugin('POST', '/v1/extension/panel/cards/ap_mine/fill', {})).status).toBe(403)
  })
})
