/**
 * WP417（自查客服）：查询类工具（A8 / A43 / B7 / C23 / D3 / D4）、运行起草的回复回原渠道（C2 / D9）。
 */
import type {
  ChatMessage,
  Clock,
  Completion,
  Matter,
  MessageRecord,
  ModelRef,
  RunRequest,
  ToolDef,
} from '@agentsws/contracts'
import type { ModelGatewayApi } from '@agentsws/model-gateway'
import { loadBundledRoles, type RoleStore } from '@agentsws/roles'
import { createWork } from '@agentsws/work'
import { describe, expect, it } from 'vitest'
import type { ConnectLike } from '../src/connections.js'
import { createConnectRecordSource, type RecordSocialThread } from '../src/records.js'
import { createRuntime, type RuntimeOptions } from '../src/runtime.js'
import { createSupportInbox, waitingOf } from '../src/support-inbox.js'

const NOW = '2026-10-19T12:00:00.000Z'
const clock: Clock = { now: () => NOW }
const ME = 'support@shop.test'

const mail = (over: Partial<MessageRecord> & { id: string; thread_id: string }): MessageRecord =>
  ({
    workspace_id: 'ws_1',
    source: 'imap',
    account: ME,
    folder: 'INBOX',
    folder_kind: 'inbox',
    references: [],
    headers: {},
    to: [{ email: ME }],
    cc: [],
    bcc: [],
    subject: 'Where is my order',
    snippet: 'Still not here',
    text: 'Still not here',
    labels: [],
    flags: { read: false, starred: false, answered: false },
    route: 'support',
    attachments: [],
    from: { email: 'ann@customer.test', name: 'Ann' },
    date: '2026-10-19T00:00:00.000Z',
    ...over,
  }) as unknown as MessageRecord

const hoursAgo = (h: number): string => new Date(Date.parse(NOW) - h * 3_600_000).toISOString()

const MAILS: MessageRecord[] = [
  // 等了 12 小时（中间我们回过一次，从回信之后客户第一封算）
  mail({ id: 'm1', thread_id: 't1', date: hoursAgo(30) }),
  mail({
    id: 'm2',
    thread_id: 't1',
    date: hoursAgo(20),
    folder_kind: 'sent',
    from: { email: ME },
    to: [{ email: 'ann@customer.test' }],
  }),
  mail({ id: 'm3', thread_id: 't1', date: hoursAgo(12) }),
  mail({ id: 'm4', thread_id: 't1', date: hoursAgo(2) }),
  // 回过了：不算等着
  mail({ id: 'm5', thread_id: 't2', date: hoursAgo(5), from: { email: 'bob@x.test' } }),
  mail({ id: 'm6', thread_id: 't2', date: hoursAgo(1), folder_kind: 'sent', from: { email: ME } }),
  // Amazon 买家消息，等了 21 小时 → 离 24 小时还剩 3
  mail({
    id: 'm7',
    thread_id: 't3',
    date: hoursAgo(21),
    subject: 'Question from buyer',
    from: { email: 'abcd1234efgh@marketplace.amazon.com', name: 'Amazon buyer' },
  }),
]

const THREADS: RecordSocialThread[] = [
  {
    id: 'ct_open',
    account_id: 'a',
    channel: 'discord',
    surface: 'thread',
    author_handle: 'u1',
    text: 'how do I pair it?',
    created_at: hoursAgo(5),
    status: 'open',
  },
  {
    id: 'ct_routed',
    account_id: 'a',
    channel: 'reddit',
    surface: 'comment',
    author_handle: 'u2',
    text: 'my order never arrived',
    created_at: hoursAgo(50),
    status: 'routed_to_support',
  },
  {
    id: 'ct_done',
    account_id: 'a',
    channel: 'discord',
    surface: 'thread',
    author_handle: 'u3',
    text: 'thanks!',
    created_at: hoursAgo(800),
    status: 'replied',
  },
]

function source() {
  const inbox = createSupportInbox({
    clock,
    mail: () => ({ list: () => MAILS }),
    chat: () => ({
      sessions: async (f) =>
        [
          {
            id: 's1',
            visitor_display: '访客 A',
            status: 'assist_requested',
            updated_at: hoursAgo(0.1),
            assist_requested_at: hoursAgo(0.2),
          },
          { id: 's2', status: 'open', updated_at: hoursAgo(1) },
        ].filter((x) => f?.status === undefined || f.status.includes(x.status)),
      messages: async () => [{ role: 'visitor', text: 'is anyone there?' }],
    }),
  })
  return createConnectRecordSource({
    connections: { liveConnections: () => [] },
    connect: {} as ConnectLike,
    clock,
    workspace_id: 'ws_1',
    appendEvent: () => undefined,
    social: () => ({
      account: () => undefined,
      thread: (id) => THREADS.find((t) => t.id === id),
      threads: (f?: { channel?: string }) =>
        THREADS.filter((t) => f?.channel === undefined || t.channel === f.channel),
    }),
    support: () => inbox,
  })
}

const call = (name: string, input: Record<string, unknown>, role_id = 'dtc.support') =>
  source().executeTool?.({
    name,
    input,
    request: {
      tools: { allow: [name] },
      actor: { role_id, person_id: 'p', assignment_id: 'a' },
    } as unknown as RunRequest,
  })

describe('WP417 客服查询类工具', () => {
  it('等着回的来信：最后一封是客户的才算；从回信之后客户第一封算起', () => {
    const row = waitingOf(
      MAILS.filter((m) => m.thread_id === 't1'),
      NOW,
    )
    expect(row?.waiting_hours).toBe(12)
    expect(
      waitingOf(
        MAILS.filter((m) => m.thread_id === 't2'),
        NOW,
      ),
    ).toBeUndefined()
  })

  it('A8 / A43：「超过 8 小时没回的」查得到，等得久的在前', async () => {
    const res = await call('list_support_threads', { min_waiting_hours: 8 })
    expect(res?.status).toBe('ok')
    const rows = (res?.data as { threads: { thread_id: string; waiting_hours: number }[] }).threads
    expect(rows.map((r) => r.thread_id)).toEqual(['t3', 't1'])
  })

  it('B7：「快超 24 小时的」只看 Amazon，带离回复线还剩几小时', async () => {
    const res = await call('list_support_threads', { due_within_hours: 4 }, 'amz.support')
    const rows = (res?.data as { threads: { thread_id: string; due_in_hours?: number }[] }).threads
    expect(rows).toEqual([expect.objectContaining({ thread_id: 't3', due_in_hours: 3 })])
  })

  it('C23：聊天里等人工的会话', async () => {
    const res = await call('list_chat_sessions', {}, 'dtc.live-chat')
    const rows = (res?.data as { sessions: { session_id: string; waiting_minutes?: number }[] })
      .sessions
    expect(rows).toEqual([expect.objectContaining({ session_id: 's1', waiting_minutes: 12 })])
  })

  it('D3：社群管理缺省看得到社媒运营转过来的；handed_over 只看转过来的；since_days 数近期', async () => {
    const all = await call('list_community_threads', {}, 'dtc.community-support')
    const ids = (all?.data as { threads: { id: string }[] }).threads.map((t) => t.id)
    expect(ids).toEqual(['ct_open', 'ct_routed'])
    const handed = await call(
      'list_community_threads',
      { handed_over: true },
      'dtc.community-support',
    )
    expect((handed?.data as { threads: { id: string }[] }).threads.map((t) => t.id)).toEqual([
      'ct_routed',
    ])
    const recent = await call(
      'list_community_threads',
      { open: false, since_days: 1 },
      'dtc.community-support',
    )
    expect((recent?.data as { threads: { id: string }[] }).threads.map((t) => t.id)).toEqual([
      'ct_open',
    ])
  })

  it('没接消息库 / 聊天库：两个工具不摆（executes 说没有）', () => {
    const bare = createConnectRecordSource({
      connections: { liveConnections: () => [] },
      connect: {} as ConnectLike,
      clock,
      workspace_id: 'ws_1',
      appendEvent: () => undefined,
    })
    expect(bare.executes?.('list_support_threads')).toBe(false)
    expect(source().executes?.('list_support_threads')).toBe(true)
    expect(source().executes?.('list_chat_sessions')).toBe(true)
  })

  it('职责 yml：网站客服 / Amazon 客服 / 在线客服的工具面里有对应查询工具', () => {
    const roles = loadBundledRoles()
    const tools = (id: string) =>
      (roles.find((r) => r.id === id)?.grounding ?? []).map((g) => g.tool)
    expect(tools('dtc.support')).toContain('list_support_threads')
    expect(tools('amz.support')).toContain('list_support_threads')
    expect(tools('dtc.live-chat')).toContain('list_chat_sessions')
  })
})

// ── C2 / D9：运行起草的回复回原渠道 ─────────────────────────────────────

const MODEL: ModelRef = { provider: 'stub', model: 'stub-v1', region: 'cn' }
const done = (text: string, tool_calls?: Completion['tool_calls']): Completion => ({
  text,
  ...(tool_calls === undefined ? {} : { tool_calls }),
  usage: { input_tokens: 10, output_tokens: 5, cached_tokens: 0, cost_base: 0 },
  model: { provider: 'stub', model: 'stub-v1' },
  static_prefix_hash: 'p',
})

function drafter() {
  let n = 0
  return {
    async complete(_req: { messages: ChatMessage[]; tools?: ToolDef[] }) {
      n += 1
      if (n === 1)
        return done('', [
          {
            id: 'c1',
            name: 'draft_reply',
            input: { subject: 'Re: pairing', body: 'Hold the button for 3 seconds.' },
          },
        ])
      return done('好了。')
    },
    async embed() {
      return []
    },
    usage() {
      return {}
    },
    budget() {
      return {}
    },
  } as unknown as ModelGatewayApi
}

async function runWithPins(pinned: { type: string; id: string }[]) {
  const role = loadBundledRoles().find((r) => r.id === 'dtc.community-support')
  if (role === undefined) throw new Error('no role')
  const created: unknown[] = []
  const routed: { body: string; pins: string[] }[] = []
  const work = createWork({ workspace_id: 'ws_1', clock, random: () => 0.5 })
  const matter = work.createMatter({ kind: 'conversation', title: '群里一条问题', pinned })
  const roles = {
    effectiveConfig: () => ({
      role_id: role.id,
      grounding: [],
      skills: [],
      browser_scope: [],
    }),
    roles: { get: () => role },
    assignments: { get: () => ({ id: 'asg_cs', role_id: role.id }) },
  } as unknown as RoleStore
  const runtime = createRuntime({
    workspace_id: 'ws_1',
    clock,
    random: () => 0.5,
    seed: 42,
    env: {},
    models: drafter(),
    approvals: {
      create: async (x: unknown) => {
        created.push(x)
        return { id: 'apv_email', state: 'pending' }
      },
    } as unknown as RuntimeOptions['approvals'],
    roles,
    appendEvent: () => undefined,
    prefer: 'direct',
    modelRef: () => MODEL,
    source: source(),
    routeDraft: async ({ matter: m, body }) => {
      routed.push({ body, pins: m.context.pinned.map((p) => p.type) })
      return m.context.pinned.some((p) => p.type === 'community_thread')
        ? { approval_item_id: 'apv_social' }
        : undefined
    },
  })
  runtime.bind(work)
  await runtime.startRun({
    matter: matter as Matter,
    brief: '回一下',
    actor: { person_id: 'per_1', assignment_id: 'asg_cs' },
  } as Parameters<typeof runtime.startRun>[0])
  return { created, routed }
}

describe('WP417 C2 / D9：起草的回复回原渠道', () => {
  it('事项钉着社群线程 → 回帖卡（由装配方出），不出「收件人待定」的邮件卡', async () => {
    const out = await runWithPins([{ type: 'community_thread', id: 'ct_open' }])
    expect(out.routed).toEqual([
      { body: 'Hold the button for 3 seconds.', pins: ['community_thread'] },
    ])
    expect(out.created).toHaveLength(0)
  })

  it('普通事项（没钉聊天 / 社群）→ 照旧出邮件卡', async () => {
    const out = await runWithPins([])
    expect(out.routed).toHaveLength(1)
    expect(out.created).toHaveLength(1)
  })
})
