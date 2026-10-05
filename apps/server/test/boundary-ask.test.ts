/**
 * WP232（10-05 Fable 本机 dev-real）：每跑一次就冒一张「订阅费的退款口径是什么？」
 * （`policy_change`，dedupe `ws_…:policy_change:policy.subscription_refund`，revision 1 → 2 → 3），
 * 还被当成这次运行的产出挂上——和红人回信毫不相关。
 *
 * 根因：工作区是虚拟产品（`digital`），它管退款的那条边界就是「订阅退款口径」；三个运行时收尾时
 * 只看「这条边界答没答过」（`missing` 非空就问），不看这件事跟退款有没有关系；服务端再交给审批
 * 总线，总线按去重键「更新原项」——revision +1、改挂到这一次的事项上。
 *
 * 钉三件事（真 `createRuntime`，stub / direct / dsh 三档，替身模型不联网）：
 * 1. 不相关的事（红人回信）**不出卡**；
 * 2. 真在要退款的事照旧问（第一次遇到问一次）；
 * 3. 同一缺口已经有一张在等人答：指给它，**不再交给总线**（不 bump、不改挂）。
 */
import type { ChatMessage, Clock, Completion, Matter, ModelRef } from '@agentsws/contracts'
import { DEFAULT_WEB_LIMITS } from '@agentsws/contracts'
import type { ModelGatewayApi } from '@agentsws/model-gateway'
import type { RoleStore } from '@agentsws/roles'
import { describe, expect, it, vi } from 'vitest'
import { createRuntime, type RuntimeOptions } from '../src/runtime.js'

vi.setConfig({ testTimeout: 120_000 })

const clock: Clock = { now: () => '2026-10-05T10:00:00.000Z' }
const MODEL: ModelRef = { provider: 'stub', model: 'stub-v1', region: 'cn' }

const KOL_BRIEF =
  '一位 YouTube 红人用英文回信：「Happy to try the earbuds. What compensation do you offer for a ' +
  'dedicated video, and do you ship to Canada?」帮我起草一封回复，先别发，给我看稿。'
const HOWTO_BRIEF = 'A customer wrote: "Can I export my reports to CSV from the app? Where is that setting?"'
const REFUND_BRIEF =
  'A customer wrote: "I was charged twice for my subscription this month, please refund the extra charge."'

/** 只说一句话就收尾的替身模型。 */
function quiet(): ModelGatewayApi {
  const done = (text: string): Completion => ({
    text,
    usage: { input_tokens: 10, output_tokens: 5, cached_tokens: 0, cost_base: 0 },
    model: { provider: 'stub', model: 'stub-v1' },
    static_prefix_hash: 'p',
  })
  return {
    async complete(_req: { messages: ChatMessage[] }) {
      return done('好的，我看过了。')
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

/** `web` 给了 = 职责挂了网页工具（服务端据此把这次运行分到 dsh）。 */
function fakeRoles(web: boolean, role_id: string): RoleStore {
  return {
    effectiveConfig: () => ({
      role_id,
      grounding: [],
      skills: [],
      browser_scope: [],
      ...(web ? { web: { tools: ['web_fetch'], ...DEFAULT_WEB_LIMITS } } : {}),
    }),
    assignments: { get: () => undefined },
  } as unknown as RoleStore
}

const matter = {
  id: 'mat_1',
  schema_version: 1,
  workspace_id: 'ws_1',
  kind: 'task',
  title: '一件事',
  status: 'open',
  context: { summary: '', pinned: [] },
  created_at: '2026-10-05T09:00:00.000Z',
  updated_at: '2026-10-05T09:00:00.000Z',
} as unknown as Matter

type Lane = 'stub' | 'direct' | 'dsh'

async function runOnce(
  lane: Lane,
  brief: string,
  role_id: string,
  extra: Partial<RuntimeOptions> = {},
) {
  const created: { kind: string; dedupe_key: string }[] = []
  const events: { type: string; payload: unknown }[] = []
  const runtime = createRuntime({
    workspace_id: 'ws_1',
    clock,
    random: () => 0.5,
    seed: 42,
    env: {},
    models: quiet(),
    approvals: {
      create: async (input: { kind: string; dedupe_key: string }) => {
        created.push({ kind: input.kind, dedupe_key: input.dedupe_key })
        return { id: `apr_${created.length}`, state: 'pending' }
      },
    } as unknown as RuntimeOptions['approvals'],
    roles: fakeRoles(lane === 'dsh', role_id),
    appendEvent: (e) => events.push({ type: e.type, payload: e.payload }),
    prefer: lane === 'stub' ? 'stub' : 'direct',
    ...(lane === 'stub' ? {} : { modelRef: () => MODEL, hasModel: () => true }),
    vertical: () => 'digital',
    dshMode: 'in-process',
    ...(lane === 'dsh'
      ? {
          web: {
            searchEnabled: () => false,
            credentialKind: () => 'deepseek_account',
            credential: async () => undefined,
            searchBaseUrl: 'http://127.0.0.1:9',
          },
        }
      : {}),
    ...extra,
  } as RuntimeOptions)
  await runtime.startRun({
    matter,
    brief,
    actor: { person_id: 'per_1', assignment_id: 'asg_1' },
  } as Parameters<typeof runtime.startRun>[0])
  const runtimeName = (events.find((e) => e.type === 'run.started')?.payload as { runtime: string })
    .runtime
  const proposals = events
    .filter((e) => e.type === 'proposal.created')
    .map((e) => e.payload as { kind: string; approval_item_id: string })
  return { created, proposals, runtimeName }
}

const LANES: { lane: Lane; name: string }[] = [
  { lane: 'stub', name: 'stub' },
  { lane: 'direct', name: 'direct-llm' },
  { lane: 'dsh', name: 'dsh' },
]

describe('WP232：边界选择题只在这件事真要变更时问', () => {
  for (const { lane, name } of LANES) {
    it(`${name}：红人回信（与退款无关）——不出「订阅退款口径」那张卡`, async () => {
      const { created, proposals, runtimeName } = await runOnce(lane, KOL_BRIEF, 'kol.youtube')
      expect(runtimeName).toBe(name)
      expect(created.filter((c) => c.kind === 'policy_change')).toEqual([])
      expect(proposals.filter((p) => p.kind === 'policy_change')).toEqual([])
    })

    it(`${name}：客服来信问怎么导出（与退款无关）——同样不出卡`, async () => {
      const { created, proposals } = await runOnce(lane, HOWTO_BRIEF, 'dtc.support')
      expect(created.filter((c) => c.kind === 'policy_change')).toEqual([])
      expect(proposals.filter((p) => p.kind === 'policy_change')).toEqual([])
    })

    it(`${name}：客户要退订阅费——第一次遇到照旧问一次`, async () => {
      const { created, proposals } = await runOnce(lane, REFUND_BRIEF, 'dtc.support')
      expect(created.filter((c) => c.kind === 'policy_change')).toEqual([
        { kind: 'policy_change', dedupe_key: 'ws_1:policy_change:policy.subscription_refund' },
      ])
      expect(proposals.filter((p) => p.kind === 'policy_change')).toHaveLength(1)
    })
  }

  it('同一缺口已经有一张在等人答：指给它，不交给审批总线（不 bump、不改挂）', async () => {
    const asked: string[] = []
    const { created, proposals } = await runOnce('stub', REFUND_BRIEF, 'dtc.support', {
      activeApproval: (dedupe_key, kind) => {
        asked.push(`${kind}|${dedupe_key}`)
        return { id: 'apr_waiting' }
      },
    })
    expect(asked).toEqual(['policy_change|ws_1:policy_change:policy.subscription_refund'])
    expect(created.filter((c) => c.kind === 'policy_change')).toEqual([])
    expect(proposals.filter((p) => p.kind === 'policy_change')).toEqual([
      { kind: 'policy_change', approval_item_id: 'apr_waiting' },
    ])
  })
})
