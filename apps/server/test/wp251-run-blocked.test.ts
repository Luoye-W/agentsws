/**
 * WP251（决策 91）：「卡住了」看结构化标记，不再认 AI 末句。
 *
 * WP244 的分组部分靠认 AI 最后那句话（「没接上 / 交不出来」）——AI 说「Shopify 还没连上，所以先用
 * 公开数据查了一版」也被算成卡住；AI 没明说的反倒漏掉。现在：工具真回了 `not_connected` / 缺凭据，
 * 运行时在这一轮上记一个结构化标记（缺哪个连接），工作视图按它分「卡住了」；末句兜底只给老数据。
 *
 * 端到端那一条用真 `createRuntime` + 替身模型（direct 档，不联网）。
 */
import type {
  ChatMessage,
  Clock,
  Completion,
  Matter,
  MatterEvent,
  ModelRef,
} from '@agentsws/contracts'
import type { ModelGatewayApi } from '@agentsws/model-gateway'
import type { RoleStore } from '@agentsws/roles'
import type { Work } from '@agentsws/work'
import { describe, expect, it } from 'vitest'
import { attachBootBrandToCompany } from '../src/boot-brand-org.js'
import { matterRunStateOf, openMatterPhase } from '../src/position-work.js'
import { blockedByTool, blockReasonOf, RunBlockLog } from '../src/run-blocked.js'
import { createRuntime, type RuntimeOptions } from '../src/runtime.js'

describe('WP251 认机器码', () => {
  it('not_connected（带人话的也认开头那个码）/ 缺凭据那几种', () => {
    expect(blockReasonOf('not_connected')).toBe('not_connected')
    expect(blockReasonOf('not_connected：这个工作区还没有连上店铺后台（Shopify）')).toBe(
      'not_connected',
    )
    expect(blockReasonOf('no_key')).toBe('missing_credential')
    expect(blockReasonOf('missing cloud workspace token (this brand has no link)')).toBe(
      'missing_credential',
    )
    expect(blockReasonOf('bad_credentials')).toBe('missing_credential')
    // 人话、别的失败都不算
    expect(blockReasonOf('这个渠道还没连上')).toBeUndefined()
    expect(blockReasonOf('upstream_error：店铺后台这次没答上来')).toBeUndefined()
    expect(blockReasonOf('unsupported_tool：这个进程没接')).toBeUndefined()
    expect(blockReasonOf(undefined)).toBeUndefined()
  })

  it('跑成了但数据里说做不了才算；降级成功的（回了本地库）不算', () => {
    expect(blockedByTool({ status: 'error', reason: 'not_connected：没连' })).toBe('not_connected')
    expect(blockedByTool({ status: 'ok', data: { ok: false, reason: 'not_connected' } })).toBe(
      'not_connected',
    )
    expect(
      blockedByTool({
        status: 'ok',
        data: { rows: [], source: 'local_library', note: '还没连上' },
      }),
    ).toBeUndefined()
    expect(blockedByTool({ status: 'ok', data: 'fine' })).toBeUndefined()
  })

  it('一轮里撞几次只记一次；两样都撞上时说「没连上」', () => {
    const log = new RunBlockLog()
    expect(log.block()).toBeUndefined()
    log.note('list_orders', 'missing_credential', ['Shopify 店铺后台'])
    log.note('list_orders', 'not_connected', ['Shopify 店铺后台', ''])
    expect(log.block()).toEqual({
      reason: 'not_connected',
      connections: ['Shopify 店铺后台'],
      tools: ['list_orders'],
    })
  })
})

type Ev = Pick<MatterEvent, 'kind' | 'text' | 'run_id' | 'stopped' | 'at' | 'blocked'>
const SINCE = '2026-10-07T00:00:00.000Z'
const ev = (e: Partial<Ev> & Pick<Ev, 'kind' | 'text'>): Ev => ({
  at: '2026-10-07T10:00:00.000Z',
  ...e,
})

describe('WP251 工作视图按标记分组', () => {
  it('有标记 = 卡住了，缺哪个以标记为准', () => {
    const state = matterRunStateOf(
      [
        ev({ kind: 'run', text: '开始跑了', run_id: 'run_1' }),
        ev({ kind: 'agent_message', text: '查完了，先用公开数据给了一版。', run_id: 'run_1' }),
        ev({
          kind: 'status',
          text: '这次卡在缺连接上（Shopify 店铺后台）',
          run_id: 'run_1',
          blocked: {
            reason: 'not_connected',
            connections: ['Shopify 店铺后台'],
            tools: ['list_orders'],
          },
        }),
      ],
      false,
      undefined,
      SINCE,
    )
    expect(openMatterPhase(state, 0)).toEqual({
      group: 'stuck',
      stuck_reason: '缺Shopify 店铺后台连接',
    })
  })

  it('标记没认出缺哪个：退回这条职责现在还缺的必需连接；缺凭据另一种说法', () => {
    const state = matterRunStateOf(
      [
        ev({ kind: 'run', text: '开始跑了', run_id: 'run_1' }),
        ev({
          kind: 'status',
          text: '这次卡在缺凭据上',
          run_id: 'run_1',
          blocked: { reason: 'missing_credential', connections: [], tools: ['send_mail'] },
        }),
      ],
      false,
      ['品牌邮箱'],
      SINCE,
    )
    expect(openMatterPhase(state, 0)).toEqual({ group: 'stuck', stuck_reason: '品牌邮箱缺凭据' })
  })

  it('新数据没有标记：AI 末句说「没连上」也不算卡住（WP244 那条误判）', () => {
    const state = matterRunStateOf(
      [
        ev({ kind: 'run', text: '开始跑了', run_id: 'run_2' }),
        ev({
          kind: 'agent_message',
          text: 'Shopify 还没连上，所以先用公开数据查了一版。',
          run_id: 'run_2',
        }),
      ],
      false,
      undefined,
      SINCE,
    )
    expect(state.legacy).toBe(false)
    expect(openMatterPhase(state, 0)).toEqual({ group: 'done', result_ready: true })
  })

  it('老数据（标记上线之前跑的）照旧认末句兜底；没给上线时刻也当老数据', () => {
    const old = [
      ev({ kind: 'run', text: '开始跑了', run_id: 'run_0', at: '2026-10-06T10:00:00.000Z' }),
      ev({
        kind: 'agent_message',
        text: '这份活现在交不出来——是没接上。',
        run_id: 'run_0',
        at: '2026-10-06T10:00:01.000Z',
      }),
    ]
    const before = matterRunStateOf(old, false, ['品牌 Reddit 号'], SINCE)
    expect(before.legacy).toBe(true)
    expect(openMatterPhase(before, 0)).toEqual({
      group: 'stuck',
      stuck_reason: '缺品牌 Reddit 号连接',
    })
    expect(openMatterPhase(matterRunStateOf(old, false), 0).group).toBe('stuck')
  })

  it('没跑成 / 被停了照旧算卡住（那是确定的信号）', () => {
    const state = matterRunStateOf(
      [
        ev({ kind: 'run', text: '开始跑了', run_id: 'run_3' }),
        ev({ kind: 'status', text: '这次运行没跑成：模型没回', run_id: 'run_3' }),
      ],
      false,
      undefined,
      SINCE,
    )
    expect(openMatterPhase(state, 0).group).toBe('stuck')
  })
})

/* ── 端到端：真运行时，工具回 not_connected → 时间线上记一条带 `blocked` 的 ── */

const clock: Clock = { now: () => '2026-10-07T10:00:00.000Z' }
const MODEL: ModelRef = { provider: 'stub', model: 'stub-v1', region: 'cn' }

/** 先调一次 search_policies，再回一句话。 */
function scripted(reply: string) {
  let n = 0
  const done = (text: string, tool_calls?: Completion['tool_calls']): Completion => ({
    text,
    ...(tool_calls === undefined ? {} : { tool_calls }),
    usage: { input_tokens: 10, output_tokens: 5, cached_tokens: 0, cost_base: 0 },
    model: { provider: 'stub', model: 'stub-v1' },
    static_prefix_hash: 'p',
  })
  return {
    async complete(_req: { messages: ChatMessage[] }) {
      n += 1
      return n === 1
        ? done('', [{ id: 'call_1', name: 'search_policies', input: { query: '退货' } }])
        : done(reply)
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

const roles: RoleStore = {
  effectiveConfig: () => ({
    role_id: 'dtc.support',
    grounding: [],
    skills: [],
    browser_scope: [],
  }),
  assignments: { get: () => undefined },
} as unknown as RoleStore

const matter = {
  id: 'mat_1',
  schema_version: 1,
  workspace_id: 'ws_1',
  kind: 'adhoc',
  title: '查一下这单退货',
  status: 'open',
  context: { summary: '', pinned: [] },
  created_at: '2026-10-07T09:00:00.000Z',
  updated_at: '2026-10-07T09:00:00.000Z',
} as unknown as Matter

async function runWith(reason: string | undefined) {
  const timeline: { kind: string; text: string; blocked?: MatterEvent['blocked'] }[] = []
  const runtime = createRuntime({
    workspace_id: 'ws_1',
    clock,
    random: () => 0.5,
    seed: 42,
    env: {},
    models: scripted('先用知识库里的口径回了一版。'),
    // 工具没回东西时 direct 档会问一道边界选择题（WP232）——替身卡给最小的形状
    approvals: {
      create: async (input: {
        kind: string
        title?: string
        subject?: Record<string, unknown>
      }) => ({
        id: 'apv_1',
        kind: input.kind,
        state: 'pending',
        title: input.title ?? '',
        subject: input.subject ?? {},
        evidence: {},
      }),
      queue: async () => [],
    } as unknown as RuntimeOptions['approvals'],
    roles,
    appendEvent: () => undefined,
    prefer: 'direct',
    modelRef: () => MODEL,
    source: {
      executeTool: async () =>
        reason === undefined ? { status: 'ok', data: { hits: [] } } : { status: 'error', reason },
    },
    missingConnections: () => ['Shopify 店铺后台'],
  })
  runtime.bind({
    appendEvent: (_id: string, e: { kind: string; text: string }) => {
      timeline.push(e)
    },
    onRunCompleted: () => undefined,
    onCard: () => undefined,
  } as unknown as Work)
  await runtime.startRun({
    matter,
    brief: '查一下这单退货',
    actor: { person_id: 'per_1', assignment_id: 'asg_1' },
  } as Parameters<typeof runtime.startRun>[0])
  return timeline
}

describe('WP251 运行时记标记（端到端）', () => {
  it('工具回 not_connected：这一轮收尾时记一条带 blocked 的，说清缺哪个', async () => {
    const timeline = await runWith('not_connected：这个工作区还没有连上店铺后台（Shopify）')
    const marked = timeline.filter((e) => e.blocked !== undefined)
    expect(marked).toHaveLength(1)
    expect(marked[0]?.blocked).toEqual({
      reason: 'not_connected',
      connections: ['Shopify 店铺后台'],
      tools: ['search_policies'],
    })
    expect(marked[0]?.text).toContain('Shopify 店铺后台')
    // 运行本身好好收了尾（标记是额外记的一条，不是「没跑成」）
    expect(timeline.filter((e) => e.text.startsWith('这次运行没跑成'))).toEqual([])
  })

  it('工具好好的：不记标记', async () => {
    const timeline = await runWith(undefined)
    expect(timeline.some((e) => e.blocked !== undefined)).toBe(false)
  })

  it('别的失败（上游没答上来）不算缺连接', async () => {
    const timeline = await runWith('upstream_error：店铺后台这次没答上来')
    expect(timeline.some((e) => e.blocked !== undefined)).toBe(false)
  })
})

/* ── 启动品牌挂公司的装配逻辑（假身份层） ── */

interface FakeWs {
  id: string
  owner_id: string
  kind: 'personal' | 'shared'
  org_id?: string
}

function fakeIdentity(
  workspaces: FakeWs[],
  orgs: { id: string; owner_id: string; created_at: string }[],
) {
  const ws = new Map(workspaces.map((w) => [w.id, { ...w }]))
  return {
    ws,
    identity: {
      getWorkspace: async (id: string) => ws.get(id) as never,
      listOrganizations: () =>
        orgs.map((o) => ({
          ...o,
          legal_name: 'X',
          discoverable: true,
          members: [{ person_id: o.owner_id, role: 'owner' as const, joined_at: o.created_at }],
        })) as never,
      brandsOf: (org_id: string) => [...ws.values()].filter((w) => w.org_id === org_id) as never,
      attachWorkspaceToOrg: async (input: {
        workspace_id: string
        org_id: string
        kind?: 'personal' | 'shared'
      }) => {
        const w = ws.get(input.workspace_id)
        if (w === undefined) throw new Error('no ws')
        if (w.org_id !== undefined && w.org_id !== input.org_id) throw new Error('conflict')
        w.org_id = input.org_id
        if (input.kind !== undefined) w.kind = input.kind
        return w as never
      },
    },
  }
}

describe('WP251 启动品牌挂到公司（装配）', () => {
  it('挂到负责人名下品牌最多的那家；原来的公司默认品牌自己接了模型就记下「用自己那一套」', async () => {
    const { ws, identity } = fakeIdentity(
      [
        { id: 'ws_inmo', owner_id: 'per_1', kind: 'personal' },
        { id: 'ws_rollout', owner_id: 'per_1', kind: 'shared', org_id: 'org_a' },
        { id: 'ws_lone', owner_id: 'per_1', kind: 'shared', org_id: 'org_b' },
        { id: 'ws_third', owner_id: 'per_1', kind: 'shared', org_id: 'org_a' },
      ],
      [
        { id: 'org_b', owner_id: 'per_1', created_at: '2026-10-01T00:00:00.000Z' },
        { id: 'org_a', owner_id: 'per_1', created_at: '2026-10-02T00:00:00.000Z' },
      ],
    )
    const kept: string[] = []
    const out = await attachBootBrandToCompany({
      identity: identity as never,
      workspace_id: 'ws_inmo' as never,
      ownModelsConfigured: async (id) => id === 'ws_rollout',
      keepOwnModels: async (id) => {
        kept.push(id)
      },
    })
    expect(out.attached).toBe('org_a')
    expect(ws.get('ws_inmo')).toMatchObject({ org_id: 'org_a', kind: 'shared' })
    expect(kept).toEqual(['ws_rollout'])
    // 再跑一次：什么都不变
    const again = await attachBootBrandToCompany({
      identity: identity as never,
      workspace_id: 'ws_inmo' as never,
      ownModelsConfigured: async () => true,
      keepOwnModels: async (id) => {
        kept.push(id)
      },
    })
    expect(again).toEqual({ shared: [], kept_own_models: [] })
    expect(kept).toEqual(['ws_rollout'])
  })

  it('原来的公司默认品牌自己没接模型：不记（挂进来之后跟随公司）', async () => {
    const { identity } = fakeIdentity(
      [
        { id: 'ws_inmo', owner_id: 'per_1', kind: 'personal' },
        { id: 'ws_rollout', owner_id: 'per_1', kind: 'shared', org_id: 'org_a' },
      ],
      [{ id: 'org_a', owner_id: 'per_1', created_at: '2026-10-02T00:00:00.000Z' }],
    )
    const kept: string[] = []
    const out = await attachBootBrandToCompany({
      identity: identity as never,
      workspace_id: 'ws_inmo' as never,
      ownModelsConfigured: async () => false,
      keepOwnModels: async (id) => {
        kept.push(id)
      },
    })
    expect(out.attached).toBe('org_a')
    expect(kept).toEqual([])
  })

  it('负责人名下没有公司：不动（交给原来那条迁移建一家）；已经挂着但还是 personal、公司有两个品牌：改 shared', async () => {
    const none = fakeIdentity([{ id: 'ws_solo', owner_id: 'per_1', kind: 'personal' }], [])
    expect(
      await attachBootBrandToCompany({
        identity: none.identity as never,
        workspace_id: 'ws_solo' as never,
        ownModelsConfigured: async () => false,
        keepOwnModels: async () => undefined,
      }),
    ).toEqual({ shared: [], kept_own_models: [] })
    expect(none.ws.get('ws_solo')?.org_id).toBeUndefined()

    const solo = fakeIdentity(
      [{ id: 'ws_one', owner_id: 'per_1', kind: 'personal', org_id: 'org_a' }],
      [{ id: 'org_a', owner_id: 'per_1', created_at: '2026-10-02T00:00:00.000Z' }],
    )
    await attachBootBrandToCompany({
      identity: solo.identity as never,
      workspace_id: 'ws_one' as never,
      ownModelsConfigured: async () => false,
      keepOwnModels: async () => undefined,
    })
    // 一个人一个品牌：照旧 personal
    expect(solo.ws.get('ws_one')?.kind).toBe('personal')

    const two = fakeIdentity(
      [
        { id: 'ws_inmo', owner_id: 'per_1', kind: 'personal', org_id: 'org_a' },
        { id: 'ws_rollout', owner_id: 'per_1', kind: 'shared', org_id: 'org_a' },
      ],
      [{ id: 'org_a', owner_id: 'per_1', created_at: '2026-10-02T00:00:00.000Z' }],
    )
    const out = await attachBootBrandToCompany({
      identity: two.identity as never,
      workspace_id: 'ws_inmo' as never,
      ownModelsConfigured: async () => false,
      keepOwnModels: async () => undefined,
    })
    expect(out.shared).toEqual(['ws_inmo'])
    expect(two.ws.get('ws_inmo')?.kind).toBe('shared')
  })
})
