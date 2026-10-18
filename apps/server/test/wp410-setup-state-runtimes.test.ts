/**
 * WP410（真机 #9）：「当前设置快照」在三个运行时（stub / direct / dsh）里是**同一份字节**：
 * 服务端每次运行现取（插件交回的连接 + 设置原值 + 最近一轮 + 开着的卡），注进官方版块 / 外部版块的上下文；
 * stub 问「连上了吗 / 关键词是哪些」照它原样说，direct / dsh 的模型看得到同一段字。别的职责上下文一个字节不变。
 * 上游模型是替身，不联网、不花钱。
 */
import type { Clock, Completion, ContextItem, Matter, ModelRef } from '@agentsws/contracts'
import type { ModelGatewayApi } from '@agentsws/model-gateway'
import type { RoleStore } from '@agentsws/roles'
import type { Work } from '@agentsws/work'
import { describe, expect, it, vi } from 'vitest'
import { createRedditWatch } from '../src/reddit-watch/service.js'
import { createRedditWatchStore } from '../src/reddit-watch/store.js'
import { createRuntime, type RuntimeOptions } from '../src/runtime.js'
import { createSetupCards } from '../src/setup-cards.js'

vi.setConfig({ testTimeout: 120_000 })

const clock: Clock = { now: () => '2026-10-18T11:55:00.000Z' }
const DEFAULT: ModelRef = { provider: 'deepseek', model: 'deepseek-flash', region: 'cn' }
const ASK = 'Reddit 连上了吗？现在关键词是哪些？'

/** 10-18 19:52 的库：插件交回 IVRA_Official、关键词 5 个、巡查已经跑完一轮。 */
async function snapshotFor(role_id: string): Promise<ContextItem | undefined> {
  const store = createRedditWatchStore()
  const ws = 'ws_1' as never
  store.setKv(ws, 'ext', { seen_at: clock.now(), reddit_connected: true, user: 'IVRA_Official' })
  const watch = createRedditWatch({
    workspace_id: ws,
    store,
    now: clock.now,
    newId: (p) => `${p}_1`,
    tzOffsetMinutes: () => 480,
  })
  watch.updateSettings({
    own_subreddits: ['ivraxr'],
    keywords: [
      'IVRA',
      'translation glasses',
      'teleprompter glasses',
      'captions glasses',
      'AI glasses',
    ],
    brand_username: 'IVRA_Official',
  })
  store.putRun({
    id: 'rwr_1',
    workspace_id: ws,
    started_at: '2026-10-18T11:49:00.000Z',
    finished_at: '2026-10-18T11:52:00.000Z',
    final: false,
    trigger: 'manual',
    pending: 20,
    parts: [
      { part: 'inbox', status: 'ok', fetched: 7, fresh: 7 },
      { part: 'own_sub', status: 'ok', fetched: 26, fresh: 26 },
      { part: 'external', status: 'ok', fetched: 29, fresh: 28 },
    ],
  })
  const cards = createSetupCards({
    workspace_id: 'ws_1',
    clock,
    approvals: () => undefined,
    isConnected: async () => true,
    resume: async () => undefined,
  })
  cards.registerTarget(watch.setupTarget())
  return cards.stateFor?.(role_id)
}

type Mode = 'stub' | 'direct' | 'dsh'

async function runOnce(mode: Mode, role_id: string) {
  const prompts: string[] = []
  const gateway = {
    async complete(req: { messages: unknown[] }) {
      prompts.push(JSON.stringify(req))
      return {
        text: '照快照说：连上了。',
        usage: { input_tokens: 10, output_tokens: 5, cached_tokens: 0, cost_base: 0 },
        model: DEFAULT,
        static_prefix_hash: 'p',
      } satisfies Completion
    },
    async embed() {
      return { vectors: [], usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0 } }
    },
    usage: () => ({}),
    budget: () => ({}),
  } as unknown as ModelGatewayApi
  const roles = {
    effectiveConfig: () => ({ role_id, grounding: [], skills: [], browser_scope: [] }),
    assignments: { get: () => undefined },
  } as unknown as RoleStore
  const injected: ContextItem[] = []
  const runtime = createRuntime({
    workspace_id: 'ws_1',
    clock,
    random: () => 0.5,
    seed: 42,
    env: {},
    models: gateway,
    approvals: { create: vi.fn() } as unknown as RuntimeOptions['approvals'],
    roles,
    appendEvent: () => undefined,
    prefer: mode === 'stub' ? 'stub' : 'direct',
    modelRef: () => DEFAULT,
    hasModel: () => mode !== 'stub',
    setupState: async ({ role_id: r }) => {
      const item = await snapshotFor(r)
      if (item !== undefined) injected.push(item)
      return item
    },
    ...(mode === 'dsh' ? { dshAllRuns: true, dshMode: 'in-process' as const } : {}),
  } as RuntimeOptions)
  const said: string[] = []
  runtime.bind({
    appendEvent: (_m: string, e: { kind: string; text: string }) => {
      if (e.kind === 'agent_message') said.push(e.text)
    },
    onRunCompleted: () => undefined,
    onCard: () => undefined,
  } as unknown as Work)
  const matter = {
    id: 'mat_s',
    schema_version: 1,
    workspace_id: 'ws_1',
    kind: 'adhoc',
    title: ASK,
    status: 'open',
    role_id,
    context: { summary: ASK, pinned: [], participants: [], last_activity: clock.now() },
    created_at: clock.now(),
    updated_at: clock.now(),
  } as unknown as Matter
  await runtime.startRun({
    matter,
    brief: ASK,
    actor: { person_id: 'per_1', assignment_id: 'asg_1' },
  } as Parameters<typeof runtime.startRun>[0])
  return { prompts, said, injected }
}

describe('WP410 当前设置快照：三个运行时', () => {
  it('stub：问「连上了吗 / 关键词是哪些」→ 照快照原样说（插件交回的号、5 个关键词、最近一轮）', async () => {
    const { prompts, said, injected } = await runOnce('stub', 'social.reddit')
    expect(prompts).toEqual([])
    expect(injected).toHaveLength(1)
    const text = said.join('\n')
    expect(text).toContain('我刚从库里读的')
    expect(text).toContain('已连好：插件里连了 Reddit，Chrome 里登着 u/IVRA_Official')
    expect(text).toContain(
      '关键词：IVRA, translation glasses, teleprompter glasses, captions glasses, AI glasses',
    )
    expect(text).toContain('Reddit 官方 API：可选的另一条路')
    expect(text).toContain('外部关键词读成了 29 条（新 28）')
    expect(text).not.toContain('还没连上')
  })

  for (const mode of ['direct', 'dsh'] as const)
    it(`${mode}：模型看到的上下文里有同一段快照`, async () => {
      const { prompts, injected } = await runOnce(mode, 'pr.reddit')
      const content = String(injected[0]?.content)
      expect(prompts[0]).toContain('[summary:setup_state]')
      // JSON 里再套一层 JSON：拿快照里的几个值逐个对
      for (const v of ['u/IVRA_Official', 'captions glasses', '不需要它', '不要凭之前的对话'])
        expect(content.includes(v) && prompts[0]?.includes(v)).toBe(true)
    })

  it('别的职责（客服）：没有快照，上下文不变', async () => {
    const { prompts, injected } = await runOnce('direct', 'support.inbox')
    expect(injected).toEqual([])
    expect(prompts[0]).not.toContain('setup_state')
  })
})
