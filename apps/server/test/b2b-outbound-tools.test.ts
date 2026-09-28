/**
 * WP176（Fable 09-28）：Run 里的开发信工具——列序列与漏斗、开一轮（出卡不发）、分一封回信。
 *
 * 钉住的事：
 *
 * 1. 执行器只认 `b2b.outbound`，别的职责点名调也是 `blocked`；
 * 2. 回来的数据是白名单（名字 / 公司 / 走到哪），没有邮箱；
 * 3. 端到端（stub）：快捷提示「起草开发信」进 Run → 先列序列、再开一轮 → 出「用哪只邮箱发」的选择卡，
 *    **一封信都没发**；别的职责的工具面里没有这三个工具。
 */
import type { B2bOutboundPort } from '@agentsws/api'
import type { Assignment, RunEvent, RunRequest } from '@agentsws/contracts'
import { B2B_OUTBOUND_TOOL_NAMES, toolWordZh } from '@agentsws/stand-ins'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createB2bOutboundToolExecutor } from '../src/b2b-outbound-tools.js'
import { createServer, type Server } from '../src/index.js'

const T0 = '2026-09-28T01:00:00.000Z'
const SECRETS_KEY = 'e'.repeat(64)

const request = (role_id: string): RunRequest =>
  ({ actor: { person_id: 'per_1', assignment_id: 'asg_1', role_id } }) as unknown as RunRequest

const seen: unknown[] = []
const fakePort = {
  view: async () => ({
    settings: { de_at_confirmed: false },
    needs: ['sender_choice'],
    funnel: [{ stage: 'queued', label: '排着', count: 2 }],
    queued: { sender_choice: 2 },
    eligible: 0,
    excluded: [],
    cooling: [
      {
        contact_id: 'ctc_1',
        name: 'Mia',
        company: 'Peak',
        masked: 'm***@peak.example',
        until: '2026-12-27T00:00:00.000Z',
        count: 1,
      },
    ],
  }),
  sequences: async () => ({
    rows: [
      {
        enrollment_id: 'enr_1',
        contact_id: 'ctc_2',
        name: 'Anna',
        company: 'Volthaus',
        status: 'queued',
        queued_reason: 'sender_choice',
      },
    ],
  }),
  start: async (_a: unknown, input: unknown) => {
    seen.push(input)
    return {
      status: 'queued',
      message: '先在卡上选用哪只邮箱发',
      picked: 0,
      queued_tomorrow: 0,
      approval_item_id: 'apv_1',
      excluded: [],
    }
  },
  classifyReply: async () => ({
    class: 'asks_price',
    label: '问价',
    action: 'hand_to_sales',
    action_label: '停序列，交给业务',
    signals: ['price'],
  }),
  saveSettings: async () => {
    throw new Error('不该调')
  },
  checkSender: async () => {
    throw new Error('不该调')
  },
} as unknown as B2bOutboundPort

describe('开发信工具（执行器）', () => {
  const exec = createB2bOutboundToolExecutor({ workspace_id: 'ws_1', port: () => fakePort })

  it('主动开发能调：列序列（白名单、冷却写到哪天）、开一轮（带产品与人）、分回信', async () => {
    const list = await exec({
      name: 'list_outreach_sequences',
      input: {},
      request: request('b2b.outbound'),
    })
    expect(list.status).toBe('ok')
    expect(list.data).toEqual({
      funnel: [{ label: '排着', count: 2 }],
      needs: ['还没选发信邮箱'],
      rows: [{ name: 'Anna', company: 'Volthaus', status: '排着' }],
      cooling: [{ name: 'Peak（Mia）', until: '2026-12-27T00:00:00.000Z', count: 1 }],
    })
    expect(JSON.stringify(list.data)).not.toContain('@')
    const start = await exec({
      name: 'start_outreach_round',
      input: { product: ' GaN chargers ', contact_ids: ['ctc_2', 3] },
      request: request('b2b.outbound'),
    })
    expect(seen.at(-1)).toEqual({ contact_ids: ['ctc_2'], product: 'GaN chargers' })
    expect(start.data).toMatchObject({
      status: 'queued',
      approval_item_id: 'apv_1',
      kind: 'b2b_outreach',
    })
    const cls = await exec({
      name: 'classify_outreach_reply',
      input: { text: 'price list please' },
      request: request('b2b.outbound'),
    })
    expect(cls.data).toMatchObject({ class: 'asks_price', action: 'hand_to_sales' })
  })

  it('别的职责点名调也是 blocked；工具名有人话', async () => {
    for (const role of ['b2b.sales', 'dtc.support', 'common.owner']) {
      const res = await exec({ name: 'start_outreach_round', input: {}, request: request(role) })
      expect(res.status).toBe('blocked')
    }
    for (const n of B2B_OUTBOUND_TOOL_NAMES) expect(toolWordZh(n)).not.toBe('一个工具')
  })
})

// ── 端到端：真进程、真装配线，模型那一跳是 stub ─────────────────────────────

let server: Server
let outbound: Assignment
const sent: string[] = []

const call = async (
  method: string,
  path: string,
  options: { body?: unknown; assignment: string },
): Promise<Response> => {
  const headers = new Headers()
  headers.set('Authorization', `Bearer ${server.bootstrap.internalToken}`)
  headers.set('X-Assignment', options.assignment)
  if (options.body !== undefined) headers.set('content-type', 'application/json')
  return server.gateway.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
  )
}

const dataOf = async <T>(res: Response): Promise<T> => {
  const parsed = (await res.json()) as { data?: unknown; code?: string; message?: string }
  if (parsed.data === undefined) throw new Error(`没有 data：${parsed.code} ${parsed.message}`)
  return parsed.data as T
}

const toolsCalled = (run_id: string): string[] =>
  server.kernel.eventLog
    .readSync({ workspace_id: server.bootstrap.workspace.id })
    .filter((e) => e.correlation?.run_id === run_id && e.type === 'tool.call')
    .map((e) => (e.payload as Extract<RunEvent, { type: 'tool.call' }>).tool)

describe('端到端（stub）：「起草开发信」进 Run 能走通', () => {
  beforeEach(async () => {
    sent.length = 0
    server = await createServer({
      quiet: true,
      clock: { now: () => T0 },
      random: () => 0.42,
      scheduleIntervalMs: 0,
      tokenRefreshIntervalMs: 0,
      env: { AGENTSWS_OWNER_EMAIL: 'owner@example.com', AGENTSWS_SECRETS_KEY: SECRETS_KEY },
      b2bStandIns: {
        mailboxes: ['leo@trybrand.example'],
        dns: { txt: async () => [] },
        sendMail: async (input) => {
          sent.push(input.subject)
          return { ok: true, outbox_id: 'ob_1', message_id: '<m1@x>', account: input.account ?? '' }
        },
      },
    })
    const ws = server.bootstrap.workspace.id
    outbound = server.roles.assignments.create({
      person_id: server.bootstrap.person.id,
      workspace_id: ws,
      role_id: 'b2b.outbound',
      granted_by: server.bootstrap.person.id,
      ranges: [{ kind: 'brand', id: ws }],
    })
    server.b2b.put('b2b_account', {
      id: 'acc_volt',
      name: 'Volthaus',
      country: 'US',
      product_lines: [],
      stage: 'contacted',
      source: { kind: 'import', observed_at: T0 },
      created_at: T0,
      updated_at: T0,
    })
    server.b2b.put('b2b_contact', {
      id: 'ctc_volt',
      account_id: 'acc_volt',
      name: 'Anna Lee',
      email_ref: 'b2b.contact.ctc_volt.email',
      source: { kind: 'website', url: 'https://volthaus.example/contact', observed_at: T0 },
      created_at: T0,
    })
  })

  afterEach(async () => {
    await server.close()
  })

  const ASK = '给这批名单起草三封开发信（第 0 / 3 / 7 天），不写价格与交期'

  it('先列序列、再开一轮：出「用哪只邮箱发」的选择卡，一封信都没发；回话里没有工具名', async () => {
    const out = await dataOf<{ matter: { id: string }; run_id?: string }>(
      await call('POST', `/v1/positions/${outbound.id}/matters`, {
        body: { title: ASK, role_id: 'b2b.outbound' },
        assignment: outbound.id,
      }),
    )
    const run_id = out.run_id ?? ''
    expect(toolsCalled(run_id)).toEqual(['list_outreach_sequences', 'start_outreach_round'])
    const card = await server.txn.approvals.get(server.b2b.outboundSettings().choice_card_id ?? '')
    expect(card?.kind).toBe('b2b_sender_choice')
    expect(card?.state).toBe('pending')
    expect(sent).toEqual([])
    expect(server.b2b.enrollments().map((e) => e.status)).toEqual(['queued'])
    const view = await dataOf<{ timeline: { kind: string; text: string }[] }>(
      await call('GET', `/v1/matters/${out.matter.id}`, { assignment: outbound.id }),
    )
    const reply = view.timeline.find((e) => e.kind === 'agent_message')?.text ?? ''
    expect(reply).toContain('开发信序列')
    expect(reply).not.toMatch(/list_outreach_sequences|start_outreach_round/)
  })

  it('别的职责的工具面里没有这三个工具', async () => {
    const sales = server.roles.assignments.create({
      person_id: server.bootstrap.person.id,
      workspace_id: server.bootstrap.workspace.id,
      role_id: 'b2b.sales',
      granted_by: server.bootstrap.person.id,
      ranges: [{ kind: 'brand', id: server.bootstrap.workspace.id }],
    })
    const out = await dataOf<{ run_id?: string }>(
      await call('POST', `/v1/positions/${sales.id}/matters`, {
        body: { title: ASK, role_id: 'b2b.sales' },
        assignment: sales.id,
      }),
    )
    for (const t of toolsCalled(out.run_id ?? '')) expect(B2B_OUTBOUND_TOOL_NAMES).not.toContain(t)
  })
})
