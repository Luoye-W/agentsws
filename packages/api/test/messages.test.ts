/**
 * WP113（63 §8）：消息面路由的一致性用例。
 *
 * 与其他端口一样，这里用一个内存替身实现 `MessagesPort`——测的是**网关本身**：
 * 路径次序（定值段不许被 `:id` 遮住）、信封、鉴权、参数校验、没装配时的 501，
 * 以及三条写在路由表上的纪律：
 * ① 一条 `DELETE /v1/messages/:id` 都没有（删除 = 移到垃圾箱）；
 * ② 只有 `send` 是 outbound（急停出站档拦它，其余照常读）；
 * ③ 全部要 `X-Assignment`。
 */
import type {
  MessageBackfillInput,
  MessageDraft,
  MessageDraftInput,
  MessageFlagsInput,
  MessageLabel,
  MessageListQuery,
  MessageMoveInput,
  MessageRecord,
  MessageSendInput,
  MessageSendResult,
  MessageSyncReport,
  MessageThreadSummary,
  SenderRule,
  Todo,
} from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import type {
  GatewayDeps,
  MailAssistantView,
  MessageAccountView,
  MessageActor,
  MessagesPort,
  MessageThreadView,
} from '../src/index.js'
import { createGateway } from '../src/index.js'
import { harness, T0 } from './helpers.js'

type Call = { method: string; args: unknown[] }

const ME = 'hello@shop.example'

const message = (over: Partial<MessageRecord> = {}): MessageRecord => ({
  id: 'msg_1',
  workspace_id: 'ws_test',
  source: 'email',
  account: ME,
  folder: 'INBOX',
  folder_kind: 'inbox',
  thread_id: '<t1@x>',
  message_id: '<m1@x>',
  references: [],
  from: { email: 'ann@customer.example', name: 'Ann' },
  to: [{ email: ME }],
  cc: [],
  bcc: [],
  subject: '包裹破了',
  snippet: 'The box arrived damaged',
  text: 'The box arrived damaged',
  has_remote_images: true,
  attachments: [],
  date: T0,
  received_at: T0,
  flags: { read: false, starred: false, answered: false, draft: false },
  labels: [],
  route: 'inbox',
  ...over,
})

const summary: MessageThreadSummary = {
  thread_id: '<t1@x>',
  subject: '包裹破了',
  participants: [{ email: 'ann@customer.example' }],
  last_at: T0,
  count: 2,
  unread: 1,
  starred: false,
  labels: ['orders'],
  route: 'inbox',
  folders: ['INBOX'],
  accounts: [ME],
  needs_reply: true,
  snippet: 'The box arrived damaged',
  last_message_id: 'msg_1',
}

const draft: MessageDraft = {
  id: 'dft_1',
  workspace_id: 'ws_test',
  account: ME,
  to: [{ email: 'ann@customer.example' }],
  cc: [],
  bcc: [],
  subject: 'Re: 包裹破了',
  text: '这就给你补发',
  attachments: [],
  updated_at: T0,
}

const todo: Todo = {
  id: 'td_1',
  schema_version: 1,
  workspace_id: 'ws_test',
  title: '给 Ann 补发',
  owner: 'per_me',
  horizon: 'today',
  source: 'manual',
  status: 'open',
  cards: [],
  runs: [],
  created_at: T0,
  updated_at: T0,
}

class FakeMessages implements MessagesPort {
  readonly calls: Call[] = []
  readonly actors: MessageActor[] = []

  private record(method: string, actor: MessageActor, ...args: unknown[]): void {
    this.calls.push({ method, args })
    this.actors.push(actor)
  }
  last(method: string): unknown[] | undefined {
    return [...this.calls].reverse().find((c) => c.method === method)?.args
  }

  accounts(actor: MessageActor): { accounts: MessageAccountView[] } {
    this.record('accounts', actor)
    return {
      accounts: [
        {
          address: ME,
          unread: 3,
          folders: [{ path: 'INBOX', kind: 'inbox', account: ME, unread: 3, total: 10 }],
          backfill_floor: T0,
        },
      ],
    }
  }
  threads(actor: MessageActor, query: MessageListQuery): { threads: MessageThreadSummary[] } {
    this.record('threads', actor, query)
    return { threads: [summary] }
  }
  thread(actor: MessageActor, thread_id: string): MessageThreadView {
    this.record('thread', actor, thread_id)
    return {
      thread_id,
      subject: '包裹破了',
      messages: [message()],
      agent_status: { route: 'support', state: 'working', takeover_matter_id: 'mat_1' },
    }
  }
  message(actor: MessageActor, id: string): { message: MessageRecord } {
    this.record('message', actor, id)
    return { message: message({ id }) }
  }
  setFlags(actor: MessageActor, id: string, input: MessageFlagsInput): { message: MessageRecord } {
    this.record('setFlags', actor, id, input)
    return {
      message: message({ flags: { read: true, starred: false, answered: false, draft: false } }),
    }
  }
  move(
    actor: MessageActor,
    id: string,
    input: MessageMoveInput,
  ): { message: MessageRecord; rule?: SenderRule } {
    this.record('move', actor, id, input)
    return {
      message: message({ folder: 'kefuagents', folder_kind: 'support', route: 'support' }),
      ...(input.remember_sender === true
        ? {
            rule: {
              id: 'rule_1',
              sender: 'ann@customer.example',
              route: 'support',
              labels: [],
              by: 'per_me',
              created_at: T0,
            },
          }
        : {}),
    }
  }
  setLabels(actor: MessageActor, id: string, labels: string[]): { message: MessageRecord } {
    this.record('setLabels', actor, id, labels)
    return { message: message({ labels }) }
  }
  showImages(actor: MessageActor, id: string, always: boolean): { message: MessageRecord } {
    this.record('showImages', actor, id, always)
    return { message: message({ has_remote_images: false }) }
  }
  labels(actor: MessageActor): { labels: MessageLabel[] } {
    this.record('labels', actor)
    return {
      labels: [
        { id: 'orders', name_zh: '订单与物流', name_en: 'Orders', color: 'blue', builtin: true },
      ],
    }
  }
  putLabel(actor: MessageActor, label: MessageLabel): { label: MessageLabel } {
    this.record('putLabel', actor, label)
    return { label }
  }
  deleteLabel(actor: MessageActor, id: string): { deleted: boolean } {
    this.record('deleteLabel', actor, id)
    return { deleted: id !== 'orders' }
  }
  mergeLabels(
    actor: MessageActor,
    from: string,
    into: string,
  ): { moved: number; labels: MessageLabel[] } {
    this.record('mergeLabels', actor, from, into)
    return { moved: 2, labels: [] }
  }
  senderRules(actor: MessageActor): { rules: SenderRule[] } {
    this.record('senderRules', actor)
    return { rules: [] }
  }
  deleteSenderRule(actor: MessageActor, id: string): { deleted: boolean } {
    this.record('deleteSenderRule', actor, id)
    return { deleted: true }
  }
  drafts(actor: MessageActor): { drafts: MessageDraft[] } {
    this.record('drafts', actor)
    return { drafts: [draft] }
  }
  saveDraft(actor: MessageActor, input: MessageDraftInput): { draft: MessageDraft } {
    this.record('saveDraft', actor, input)
    return { draft }
  }
  discardDraft(actor: MessageActor, id: string): { deleted: boolean } {
    this.record('discardDraft', actor, id)
    return { deleted: true }
  }
  send(actor: MessageActor, input: MessageSendInput): MessageSendResult {
    this.record('send', actor, input)
    return { outbox_id: 'obx_1', message_id: '<sent@x>' }
  }
  assistant(actor: MessageActor, id: string): MailAssistantView {
    this.record('assistant', actor, id)
    return {
      message_id: id,
      summary: '客户说包裹破损要退款',
      suggestions: [
        { id: 's1', kind: 'short', title: '简短回一句', text: '这就给你补发', citations: [] },
      ],
      sender: { address: 'ann@customer.example', history_count: 4, linked: [] },
      todos: [],
      model_available: true,
    }
  }
  toTodo(actor: MessageActor, id: string): { todo: Todo } {
    this.record('toTodo', actor, id)
    return { todo }
  }
  sync(actor: MessageActor): MessageSyncReport {
    this.record('sync', actor)
    return { accounts: 1, folders: 6, fetched: 4, triaged: 2, moved: 1, failed: [] }
  }
  backfill(actor: MessageActor, input: MessageBackfillInput): { floor: string } {
    this.record('backfill', actor, input)
    return { floor: T0 }
  }
}

async function messageHarness(): Promise<{
  h: Awaited<ReturnType<typeof harness>>
  messages: FakeMessages
  get(path: string): Promise<Response>
  post(path: string, body?: unknown): Promise<Response>
  del(path: string): Promise<Response>
}> {
  const h = await harness()
  const messages = new FakeMessages()
  const deps: GatewayDeps = { ...h.deps, messages }
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
    h,
    messages,
    get: (p) => call('GET', p),
    post: (p, b) => call('POST', p, b),
    del: (p) => call('DELETE', p),
  }
}

const data = async (res: Response): Promise<Record<string, unknown>> =>
  ((await res.json()) as { data: Record<string, unknown> }).data

describe('63 消息面路由', () => {
  it('全部在 /v1 之下、都要 Assignment、operationId 不重名', async () => {
    const { h } = await messageHarness()
    const specs = h.gateway.specs.filter((s) => s.tag === 'messages')
    expect(specs.length).toBeGreaterThanOrEqual(20)
    expect(specs.every((s) => s.path.startsWith('/v1/messages'))).toBe(true)
    expect(specs.every((s) => s.auth === 'bearer' && s.assignment === true)).toBe(true)
    const ids = h.gateway.specs.map((s) => s.operationId)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('没有任何一条硬删信的路由——删除是"移到垃圾箱"（63 §7）', async () => {
    const { h } = await messageHarness()
    const deletes = h.gateway.specs
      .filter((s) => s.tag === 'messages' && s.method === 'delete')
      .map((s) => s.path)
    // 只删得掉标签 / 规则 / 草稿，删不掉信
    expect(deletes.sort()).toEqual([
      '/v1/messages/drafts/:id',
      '/v1/messages/labels/:id',
      '/v1/messages/rules/:id',
    ])
  })

  it('只有发送是 outbound（急停出站档拦它，读照常）', async () => {
    const t = await messageHarness()
    const outbound = t.h.gateway.specs
      .filter((s) => s.tag === 'messages' && s.outbound === true)
      .map((s) => s.operationId)
    expect(outbound).toEqual(['sendMessage'])
  })

  it('没装配消息面时回 not_implemented（501）', async () => {
    const h = await harness()
    const res = await h.get('/v1/messages')
    expect(res.status).toBe(501)
    expect(((await res.json()) as { code: string }).code).toBe('not_implemented')
  })

  it('定值段不被 `:id` 遮住（labels / rules / drafts / accounts / threads）', async () => {
    const t = await messageHarness()
    await t.get('/v1/messages/labels')
    expect(t.messages.last('labels')).toBeDefined()
    await t.get('/v1/messages/rules')
    expect(t.messages.last('senderRules')).toBeDefined()
    await t.get('/v1/messages/drafts')
    expect(t.messages.last('drafts')).toBeDefined()
    await t.get('/v1/messages/accounts')
    expect(t.messages.last('accounts')).toBeDefined()
    await t.get('/v1/messages/threads/%3Ct1%40x%3E')
    expect(t.messages.last('thread')?.[0]).toBe('<t1@x>')
    // `:id` 那条仍然进得去
    await t.get('/v1/messages/msg_1')
    expect(t.messages.last('message')?.[0]).toBe('msg_1')
  })

  it('会话列表：筛选与搜索原样传给端口', async () => {
    const t = await messageHarness()
    const res = await t.get(
      '/v1/messages?folder=INBOX&account=hello%40shop.example&label=orders&unread=true&q=%E5%8C%85%E8%A3%B9&limit=20',
    )
    expect(res.status).toBe(200)
    expect((await data(res)).threads).toHaveLength(1)
    expect(t.messages.last('threads')?.[0]).toEqual({
      folder: 'INBOX',
      account: 'hello@shop.example',
      label: 'orders',
      unread: true,
      q: '包裹',
      limit: 20,
    })
  })

  it('空的查询参数按不传读（浏览器留空串太常见）', async () => {
    const t = await messageHarness()
    await t.get('/v1/messages?folder=&q=')
    expect(t.messages.last('threads')?.[0]).toEqual({})
  })

  it('旗标、挪信、标签、显示图片', async () => {
    const t = await messageHarness()
    expect((await t.post('/v1/messages/msg_1/flags', { read: true })).status).toBe(200)
    expect(t.messages.last('setFlags')?.[1]).toEqual({ read: true })

    const moved = await t.post('/v1/messages/msg_1/move', { to: 'support', remember_sender: true })
    expect((await data(moved)).rule).toMatchObject({ sender: 'ann@customer.example' })

    // 删除是移到垃圾箱，不是别的动词
    expect((await t.post('/v1/messages/msg_1/move', { to: 'trash' })).status).toBe(200)
    // 认不出来的去处是错，不是悄悄忽略
    expect((await t.post('/v1/messages/msg_1/move', { to: 'shred' })).status).toBe(400)

    await t.post('/v1/messages/msg_1/labels', { labels: ['orders', 'suspicious'] })
    expect(t.messages.last('setLabels')?.[1]).toEqual(['orders', 'suspicious'])

    await t.post('/v1/messages/msg_1/images', { always: true })
    expect(t.messages.last('showImages')?.[1]).toBe(true)
    await t.post('/v1/messages/msg_1/images', {})
    expect(t.messages.last('showImages')?.[1]).toBe(false)
  })

  it('标签 CRUD 与合并；新建的一律不是内置', async () => {
    const t = await messageHarness()
    const created = await t.post('/v1/messages/labels', {
      id: 'mine',
      name_zh: '我的',
      name_en: 'Mine',
      color: 'blue',
    })
    expect(created.status).toBe(201)
    expect(t.messages.last('putLabel')?.[0]).toMatchObject({ id: 'mine', builtin: false })
    expect((await data(await t.del('/v1/messages/labels/mine'))).deleted).toBe(true)
    const merged = await t.post('/v1/messages/labels/merge', { from: 'a', into: 'b' })
    expect((await data(merged)).moved).toBe(2)
  })

  it('草稿：存、列、丢；发送走的是另一条路', async () => {
    const t = await messageHarness()
    const saved = await t.post('/v1/messages/drafts', {
      subject: 'Re: 包裹破了',
      text: '这就给你补发',
      to: [{ email: 'ann@customer.example' }],
    })
    expect(saved.status).toBe(201)
    expect((await data(await t.get('/v1/messages/drafts'))).drafts).toHaveLength(1)
    expect((await data(await t.del('/v1/messages/drafts/dft_1'))).deleted).toBe(true)

    const sent = await t.post('/v1/messages/send', { draft_id: 'dft_1' })
    expect(sent.status).toBe(201)
    expect((await data(sent)).outbox_id).toBe('obx_1')
  })

  it('右栏那一格、转待办、立刻收一次、再往前取', async () => {
    const t = await messageHarness()
    const assistant = await data(await t.get('/v1/messages/msg_1/assistant'))
    expect(assistant.suggestions).toHaveLength(1)
    expect(assistant.model_available).toBe(true)

    expect((await t.post('/v1/messages/msg_1/todo', {})).status).toBe(201)
    expect((await data(await t.post('/v1/messages/sync', {}))).fetched).toBe(4)
    await t.post('/v1/messages/backfill', { days: 60 })
    expect(t.messages.last('backfill')?.[0]).toEqual({ days: 60 })
    // 荒唐的天数拦在网关
    expect((await t.post('/v1/messages/backfill', { days: 99999 })).status).toBe(400)
  })

  it('会话视图带得出"客服 Agent 在处理"那条状态带（63 §9）', async () => {
    const t = await messageHarness()
    const view = await data(await t.get('/v1/messages/threads/t1'))
    expect(view.agent_status).toMatchObject({ route: 'support', state: 'working' })
  })

  it('每条请求都带上本次绑定的岗位（31 §3.1）', async () => {
    const t = await messageHarness()
    await t.get('/v1/messages')
    expect(t.messages.actors[0]).toEqual({
      workspace_id: t.h.workspace_id,
      person_id: t.h.person_id,
      assignment_id: t.h.assignment.id,
    })
  })
})
