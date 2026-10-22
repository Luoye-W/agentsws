/**
 * WP459（决策 1497–1505）：收件箱 `GET /v1/inbox` 与改判 `POST /v1/messages/:id/rehand`。
 *
 * 钉住的是：
 * - 所有岗位等你批的卡 + 要你判断的信一条队列，带急不急、类型、行尾按钮、件数；
 * - 卡就是岗位里那一张：在收件箱批了，岗位牌堆里也没了（反之亦然——同一个决定口子）；
 * - 「AI 猜着交给岗位」那封信来的卡挂上「AI 猜的」，改判走消息面的 `rehand`；
 * - 没装消息面时只有卡；改判的入参校验与 501。
 */
import type {
  MessageGuessRow,
  MessageOverview,
  MessageRehandInput,
  MessageThreadSummary,
} from '@agentsws/contracts'
import type { InboxView } from '@agentsws/deck'
import { describe, expect, it } from 'vitest'
import type { GatewayDeps, MessagesPort } from '../src/index.js'
import { createGateway } from '../src/index.js'
import { approvalItem, type Harness, harness } from './helpers.js'

const json = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data

const thread = (over: Partial<MessageThreadSummary> = {}): MessageThreadSummary => ({
  thread_id: '<t9@x>',
  subject: 'Sample request',
  participants: [{ email: 'sam@shop.example', name: 'Sam Lee' }],
  last_at: '2026-09-07T08:00:00.000Z',
  count: 1,
  unread: 1,
  starred: false,
  labels: [],
  route: 'inbox',
  folders: ['INBOX'],
  accounts: ['hello@shop.example'],
  needs_reply: true,
  snippet: 'Can we get samples?',
  last_message_id: 'msg_9',
  claim: 'unclaimed',
  claim_message_id: 'msg_9',
  kind: 'inquiry',
  kind_confidence: 0.35,
  summary: '三家门店问能不能寄样品',
  suggest: { action: 'hand', position: 'b2b' },
  ...over,
})

const overview: MessageOverview = {
  unclaimed: 2,
  notice: 5,
  handed: 3,
  handed_by_position: [],
  cards_waiting: 1,
  notice_groups: [],
  positions: [{ id: 'b2b', name_zh: 'B2B', name_en: 'B2B', open: true, route: 'b2b' }],
  taught: { rules: 2, saved: 0, recent: [] },
}

/** 消息面替身：只实现收件箱要的几样（其余照接口要求给空壳）。 */
function messagesPort(
  over: { guessed?: MessageGuessRow[]; rehand?: MessageRehandInput[] } = {},
): MessagesPort {
  const unsupported = (): never => {
    throw new Error('not used')
  }
  return {
    accounts: () => ({ accounts: [] }),
    threads: (_a, q) => ({
      threads:
        q.claim === 'unclaimed'
          ? [
              thread(),
              thread({
                thread_id: '<t10@x>',
                claim_message_id: 'msg_10',
                last_message_id: 'msg_10',
                participants: [{ email: 'ops@shopify.example', name: 'Shopify' }],
                kind: 'billing_system',
                priority: 'high',
                suggest: { action: 'self' },
                summary: '结算被暂停，要补营业执照',
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
    overview: () => overview,
    guessed: () => ({ rows: over.guessed ?? [] }),
    rehand: (_a, id, input) => {
      over.rehand?.push(input)
      return {
        message: { id } as never,
        withdrawn: 1,
        handed_off: true,
        ...(input.position_id === undefined ? {} : { position_id: input.position_id }),
      }
    },
  }
}

function withMessages(h: Harness, port: MessagesPort | undefined): Harness {
  const deps: GatewayDeps = { ...h.deps, ...(port === undefined ? {} : { messages: port }) }
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
  }
}

describe('GET /v1/inbox（WP459，决策 1497）', () => {
  it('岗位的卡 + 要你判断的信一条队列；急不急三组、类型、行尾按钮、件数', async () => {
    const h = withMessages(await harness(), messagesPort())
    const view = await json<InboxView>(await h.get('/v1/inbox'))
    const card = view.items.find((i) => i.type === 'card')
    expect(card?.id).toBe(`card:${h.item.id}`)
    expect(card?.card?.id).toBe(h.item.id)
    expect(card?.primary).toBe('approve')
    const mails = view.items.filter((i) => i.type === 'mail')
    expect(mails.map((m) => m.tag).sort()).toEqual(['only_you', 'unsure'])
    const sam = mails.find((m) => m.mail?.thread_id === '<t9@x>')
    expect(sam?.primary).toBe('hand')
    expect(sam?.position).toBeUndefined()
    const shopify = mails.find((m) => m.mail?.thread_id === '<t10@x>')
    expect(shopify?.urgency).toBe('urgent')
    expect(shopify?.primary).toBe('self')
    // 要紧的排最前
    expect(view.items[0]?.urgency).toBe('urgent')
    expect(view.counts).toMatchObject({ all: 3, cards: 1, mail: 2 })
    expect(view.unassigned).toBe(2)
    expect(view.brief.notices).toBe(5)
  })

  it('在收件箱批了，岗位牌堆里也没了（同一张卡、同一个决定口子）', async () => {
    const h = withMessages(await harness(), messagesPort())
    const before = await json<InboxView>(await h.get('/v1/inbox'))
    expect(before.items.some((i) => i.card?.id === h.item.id)).toBe(true)
    const cards = await json<{ cards: { id: string }[] }>(
      await h.get(`/v1/positions/${h.assignment.id}/cards`),
    )
    expect(cards.cards.map((c) => c.id)).toContain(h.item.id)
    const card = before.items.find((i) => i.card?.id === h.item.id)?.card
    const res = await h.post(`/v1/approvals/${h.item.id}/decide`, {
      action: 'approve',
      version: card?.version,
    })
    expect(res.status).toBe(200)
    const after = await json<InboxView>(await h.get('/v1/inbox'))
    expect(after.items.some((i) => i.card?.id === h.item.id)).toBe(false)
    // 岗位牌堆读的是同一个账本：这张已经不是「等你定」了（真服务进程的岗位队列只取待定的，替身全给，所以看状态）
    expect(h.approvals.items.get(h.item.id)?.state).toBe('approved')
    const cardsAfter = await json<{ cards: { id: string; status: string }[] }>(
      await h.get(`/v1/positions/${h.assignment.id}/cards`),
    )
    expect(cardsAfter.cards.find((c) => c.id === h.item.id)?.status ?? 'approved').not.toBe(
      'pending',
    )
  })

  it('岗位里批了，收件箱里也没了（反过来同一回事）', async () => {
    const h = withMessages(await harness(), messagesPort())
    h.approvals.seed(
      approvalItem({
        id: 'ap_second',
        dedupe_key: 'dk_second',
        subject: { object: { type: 'thread', id: 'thr_2' } },
        workspace_id: h.workspace_id,
        title: '第二张',
        routing: h.item.routing,
        deliveries: h.item.deliveries,
      }),
    )
    const deck = await json<{ cards: { id: string; version: number }[] }>(
      await h.get(`/v1/positions/${h.assignment.id}/cards`),
    )
    const second = deck.cards.find((c) => c.id === 'ap_second')
    expect(second).toBeDefined()
    await h.post('/v1/approvals/ap_second/decide', { action: 'reject', version: second?.version })
    const view = await json<InboxView>(await h.get('/v1/inbox'))
    expect(view.items.some((i) => i.card?.id === 'ap_second')).toBe(false)
  })

  it('「AI 猜着交给岗位」那封信来的卡挂「AI 猜的」；简报里数今天猜着交的', async () => {
    const h = await harness()
    const thread_id = (h.item.subject.object as { id: string }).id
    const port = messagesPort({
      guessed: [
        {
          message_id: 'msg_g',
          thread_id,
          subject: 'Gift box',
          from: { email: 'jw@buyer.example', name: 'Jordan Wells' },
          position_id: 'customer-care',
          confidence: 0.72,
          at: h.clock.now(),
        },
      ],
    })
    const hh = withMessages(h, port)
    const view = await json<InboxView>(await hh.get('/v1/inbox'))
    const card = view.items.find((i) => i.card?.id === h.item.id)
    expect(card?.guessed).toEqual({
      message_id: 'msg_g',
      position: 'customer-care',
      confidence: 0.72,
    })
    expect(view.guessed).toHaveLength(1)
    expect(view.brief.guessed).toBe(1)
  })

  it('没装消息面：只有卡', async () => {
    const h = await harness()
    const view = await json<InboxView>(await h.get('/v1/inbox'))
    expect(view.items.every((i) => i.type === 'card')).toBe(true)
    expect(view.counts.mail).toBe(0)
  })
})

describe('POST /v1/messages/:id/rehand（决策 1498 / 1504）', () => {
  it('交给别的岗位 / 我自己处理：原样转给消息面，回撤了几张卡', async () => {
    const calls: MessageRehandInput[] = []
    const h = withMessages(await harness(), messagesPort({ rehand: calls }))
    const res = await h.post('/v1/messages/msg_g/rehand', { to: 'position', position_id: 'b2b' })
    expect(res.status).toBe(200)
    expect(await json(res)).toMatchObject({ withdrawn: 1, handed_off: true, position_id: 'b2b' })
    await h.post('/v1/messages/msg_g/rehand', { to: 'me' })
    expect(calls).toEqual([{ to: 'position', position_id: 'b2b' }, { to: 'me' }])
  })

  it('交给岗位没给岗位 → 400；没装改判 → 501', async () => {
    const h = withMessages(await harness(), messagesPort())
    expect((await h.post('/v1/messages/msg_g/rehand', { to: 'position' })).status).toBe(400)
    const bare = { ...messagesPort() }
    delete bare.rehand
    const h2 = withMessages(await harness(), bare)
    expect((await h2.post('/v1/messages/msg_g/rehand', { to: 'me' })).status).toBe(501)
  })
})
