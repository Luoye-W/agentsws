/**
 * WP323 端到端（真服务进程 + 替身飞书开放平台 + 假飞书长连接；不连真实飞书、不起端口）：
 *
 * | 钉的是什么 | 为什么 |
 * |---|---|
 * | 飞书应用照旧在「消息渠道」里接（加密库），记录去处现取同一份凭据 | 不另设飞书设置区 |
 * | 交代 → 一张通用的「定规矩」卡（policy_change、记下 / 不用、一行预览，卡上不出现表格种类） | 决定只在卡片流 |
 * | 点「记下」→ 去处在记；之后每发一条照写一行；`/v1/outbound/*` 查得到、导得出 | 固定能力 |
 * | 删去处 → 不再写 | 删除联动 |
 * | 写入点：批准的草稿卡 / 发出去类变更 / 社媒回帖 → 一行（演练与内存桩不记） | 每条都记 |
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FeishuConnState, FeishuTransport } from '@agentsws/channels'
import type {
  ApprovalItem,
  ChangeKind,
  CommunityThread,
  StagedChange,
  WorkspaceId,
} from '@agentsws/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import { recordFromApproval, recordsFromChange } from '../src/outbound/capture.js'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'
import { createSocialStore } from '../src/social.js'
import { createSocialExecutor, SOCIAL_REPLY_FORM } from '../src/social-executor.js'
import { createFakeFeishu } from './fake-feishu-api.js'

class QuietFeishu implements FeishuTransport {
  async start(input: Parameters<FeishuTransport['start']>[0]): Promise<void> {
    input.onState('connected' as FeishuConnState)
  }
  async stop(): Promise<void> {}
  async reply(): Promise<void> {}
  async botOpenId(): Promise<string | undefined> {
    return 'ou_bot'
  }
}

let server: Server | undefined
const dirs: string[] = []

afterEach(async () => {
  await server?.close()
  server = undefined
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function boot() {
  const dbDir = mkdtempSync(join(tmpdir(), 'wp323-outbound-'))
  dirs.push(dbDir)
  const api = createFakeFeishu()
  api.bitables.set(
    'bascnAAA111',
    new Map([
      [
        'tblX1',
        {
          name: '回复记录',
          fields: [
            { field_name: '日期', type: 1 },
            { field_name: '版块', type: 1 },
            { field_name: '我们回复的内容', type: 1 },
          ],
          records: [],
        },
      ],
    ]),
  )
  api.shared.add('bascnAAA111')
  server = await createServer({
    dbDir,
    quiet: true,
    env: { [SECRETS_KEY_ENV]: 'd'.repeat(64) },
    tokenRefreshIntervalMs: 0,
    scheduleIntervalMs: 0,
    liveDataIntervalMs: 0,
    startRun: false,
    imTransports: { feishu: () => new QuietFeishu() },
    outboundFetch: api.fetch,
  })
  const s = server
  const call = async (method: string, path: string, body?: unknown) =>
    s.gateway.fetch(
      new Request(`http://127.0.0.1${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${s.bootstrap.internalToken}`,
          'X-Assignment': s.bootstrap.ownerAssignment.id,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  const data = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data
  return { s, api, call, data, ws: s.bootstrap.workspace.id }
}

describe('发出记录 + 记录去处（服务进程）', () => {
  it('交代 → 通用「定规矩」卡 → 记下 → 照写；接口查得到、导得出；删了不再写', async () => {
    const { s, api, call, data, ws } = await boot()
    // 飞书应用照旧接在「消息渠道」（加密库）
    const put = await call('PUT', '/v1/im/feishu', {
      app_id: 'cli_0123456789abcdef',
      app_secret: 'test-secret',
    })
    expect(put.status).toBe(200)

    const p = await s.outbound.propose(ws, {
      url: 'https://x.feishu.cn/base/bascnAAA111?table=tblX1',
      instruction: '以后每发一条都记到这张表',
      name: 'IVRA 回复记录',
      actor: {
        person_id: s.bootstrap.person.id,
        assignment_id: s.bootstrap.ownerAssignment.id,
        role_id: 'common.owner',
      },
    })
    if (!p.ok) throw new Error(p.message)
    const card = (await s.txn.approvals.get(p.card_id as string)) as ApprovalItem
    expect(card.kind).toBe('policy_change')
    expect(card.title).toBe('记录去处：IVRA 回复记录')
    const payload = card.payload as Record<string, unknown>
    expect(payload.form).toBe('record_sink')
    expect(payload.options).toEqual([
      { id: 'after', label: '记下' },
      { id: 'before', label: '不用' },
    ])
    // 卡上不出现表格是哪一家
    expect(JSON.stringify({ t: card.title, s: card.summary, p: payload })).not.toMatch(
      /飞书|feishu/i,
    )

    const token = [...(card.deliveries ?? [])]
      .reverse()
      .find((d) => d.status === 'sent')?.decision_token
    await s.approvals.decide(card.id, s.bootstrap.person.id, {
      action: 'approve',
      decision_token: token as string,
      selected_option_id: 'after',
      via: 'workstation',
    } as never)
    const sinks = await data<{ state: string; name: string }[]>(
      await call('GET', '/v1/outbound/sinks'),
    )
    expect(sinks).toMatchObject([{ state: 'active', name: 'IVRA 回复记录' }])

    s.outbound.record(ws, {
      source_key: 'approval:apv_x1',
      channel: 'reddit',
      action: 'reply',
      kind: 'social_reply',
      destination: 'r/ivraxr',
      content: 'Thanks for asking!',
    })
    await s.outbound.flush()
    expect(api.bitables.get('bascnAAA111')?.get('tblX1')?.records).toHaveLength(1)

    const rows = await data<{ content: string }[]>(await call('GET', '/v1/outbound/records'))
    expect(rows.map((r) => r.content)).toEqual(['Thanks for asking!'])
    const exported = await data<{ filename: string; content: string }>(
      await call('GET', '/v1/outbound/records/export?format=csv'),
    )
    expect(exported.filename).toMatch(/^发出记录-.*\.csv$/)
    expect(exported.content).toContain('Thanks for asking!')

    const sinkId = p.sink_id
    expect((await call('DELETE', `/v1/outbound/sinks/${sinkId}`)).status).toBe(200)
    s.outbound.record(ws, {
      source_key: 'approval:apv_x2',
      channel: 'reddit',
      action: 'reply',
      kind: 'social_reply',
      content: 'second',
    })
    await s.outbound.flush()
    expect(api.bitables.get('bascnAAA111')?.get('tblX1')?.records).toHaveLength(1)
    expect((await call('DELETE', `/v1/outbound/sinks/${sinkId}`)).status).toBe(404)
  })
})

describe('写入点', () => {
  it('批准的草稿卡 → 一行（改过的正文、批的人）；不是草稿卡不记', () => {
    const item = {
      id: 'apv_1',
      kind: 'outbound_draft',
      role_id: 'dtc.support',
      subject: { object: { type: 'thread', id: 't1' }, matter_id: 'mat_1' },
      payload: {
        channel: 'email',
        to: 'alice@example.com',
        body: { subject: 'Re: order', text: 'v1' },
      },
      decision: {
        by: 'p_1',
        at: '2026-10-14T03:00:00.000Z',
        edited_payload: {
          channel: 'email',
          to: 'alice@example.com',
          body: { subject: 'Re: order', text: 'v2' },
        },
      },
      state: 'approved_edited',
    } as unknown as ApprovalItem
    const row = recordFromApproval(item, () => 'Luoye')
    expect(row).toMatchObject({
      source_key: 'approval:apv_1',
      channel: 'email',
      action: 'email',
      destination: 'alice@example.com',
      subject: 'Re: order',
      approved_by: 'Luoye',
      matter_id: 'mat_1',
    })
    expect(['v1', 'v2']).toContain(row?.content)
    expect(recordFromApproval({ ...item, kind: 'policy_change' } as ApprovalItem)).toBeUndefined()
  })

  it('一批开发信一封一行；不是发出去类的变更不记', () => {
    const change = {
      id: 'chg_1',
      kind: 'b2b_outreach',
      role_id: 'b2b.outbound',
      after: {
        emails: [
          { to: 'buyer1@example.com', subject: 'Hi 1', body: 'a' },
          { to: 'buyer2@example.com', subject: 'Hi 2', body: 'b' },
        ],
      },
      approval: { item_id: 'apv_9', by: 'mandate', at: '2026-10-14T03:00:00.000Z' },
    } as unknown as StagedChange
    const rows = recordsFromChange(change)
    expect(rows.map((r) => [r.source_key, r.destination, r.approved_by])).toEqual([
      ['change:chg_1:0', 'buyer1@example.com', '自动'],
      ['change:chg_1:1', 'buyer2@example.com', '自动'],
    ])
    expect(recordsFromChange({ ...change, kind: 'refund' as ChangeKind })).toEqual([])
  })

  // int/1024：WP445（决策 1324）起 Reddit 不走接口直发，这条改用 X 钉「发出去了 → 一行带平台 id」
  it('社媒回帖发出去了 → 一行带平台 id（之后挂后续用）', async () => {
    const WS = 'ws_1' as WorkspaceId
    const NOW = '2026-10-14T03:00:00.000Z'
    const store = createSocialStore({ workspace_id: WS })
    store.saveAccount({
      id: 'sa_r',
      workspace_id: WS,
      channel: 'x',
      handle: 'ivra_official',
      display_name: '@ivra_official',
      url: 'https://x.com/ivra_official',
      external_id: 'ivraxr',
      observed_at: NOW,
    } as never)
    const thread: CommunityThread = {
      id: 'ct_1',
      account_id: 'sa_r',
      channel: 'x',
      external_id: 't3_abc',
      surface: 'thread',
      author_external_id: 'u_1',
      author_handle: 'u/alice',
      text: 'How long does the battery last?',
      created_at: NOW,
      status: 'open',
    }
    store.saveThread(thread)
    const sent: unknown[] = []
    const executor = createSocialExecutor({
      workspace_id: WS,
      store,
      clock: { now: () => NOW },
      adapter: () =>
        ({ reply: async () => ({ ok: true, data: { external_id: 't1_reply' } }) }) as never,
      emit: () => undefined,
      ledger: { list: async () => [] },
      onSent: (input) => sent.push(input),
    })
    const res = await executor.deliverReply({
      id: 'ap_1',
      workspace_id: WS,
      kind: 'outbound_draft',
      state: 'approved',
      role_id: 'social.x',
      subject: { object: { type: 'community_thread', id: 'ct_1' } },
      payload: {
        form: SOCIAL_REPLY_FORM,
        thread_id: 'ct_1',
        channel: 'x',
        body: { text: 'About 3h.' },
      },
      decision: { by: 'mandate', at: NOW },
    } as unknown as ApprovalItem)
    expect(res?.status).toBe('ok')
    expect(sent).toEqual([
      expect.objectContaining({
        source_key: 'approval:ap_1',
        channel: 'x',
        action: 'reply',
        destination: '@ivra_official',
        counterpart: 'u/alice',
        content: 'About 3h.',
        external_id: 't1_reply',
        parent_external_id: 't3_abc',
      }),
    ])
    executor.close()
  })
})
