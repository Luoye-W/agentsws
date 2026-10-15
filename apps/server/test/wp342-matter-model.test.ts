/**
 * WP342（决策 853）：输入框左下角那个 AI 钮——**这件事自己选的 AI** 三个运行时都认。
 *
 * | 组 | 用什么 | 钉什么 |
 * |---|---|---|
 * | (a) 运行时 | 真 `createRuntime`（stub / direct / dsh 进程内）+ 记账的替身网关 | 事项带 `model` → `run.started` 记的是它；direct / dsh 每次补全都把它显式交给网关；另一件没选的不受影响（网关照旧按默认选） |
 * | (b) 认不出 | 同上 | 选的那个后来删了（`modelOverride` 回 undefined）→ 退回品牌默认，不报错 |
 * | (c) 工作端口 | `createWorkPort` + 真 `Work` | 开事项时记下；换模型只改这一件；认不出的拒 |
 *
 * 全程替身，不联网。
 */
import type {
  ChatMessage,
  Clock,
  Completion,
  EventEnvelope,
  Matter,
  ModelRef,
  RunEvent,
} from '@agentsws/contracts'
import type { ModelGatewayApi } from '@agentsws/model-gateway'
import type { RoleStore } from '@agentsws/roles'
import type { Work } from '@agentsws/work'
import { describe, expect, it, vi } from 'vitest'
import { chatModelRefOf } from '../src/models.js'
import { createRuntime, type RuntimeOptions } from '../src/runtime.js'

vi.setConfig({ testTimeout: 120_000 })

const clock: Clock = { now: () => '2026-10-15T10:00:00.000Z' }
const DEFAULT: ModelRef = { provider: 'deepseek', model: 'deepseek-flash', region: 'cn' }
const CHOICES = [
  { id: 'deepseek/deepseek-flash', label: 'DeepSeek', official: false, vision: 'no' as const },
  { id: 'agentsws-cloud/qwen-max', label: 'Agents 工坊', official: true, vision: 'ok' as const },
]
const models = { chatChoices: () => CHOICES }

const roles = {
  effectiveConfig: () => ({ role_id: 'dtc.support', grounding: [], skills: [], browser_scope: [] }),
  assignments: { get: () => undefined },
} as unknown as RoleStore

const matterOf = (id: string, model?: string): Matter =>
  ({
    id,
    schema_version: 1,
    workspace_id: 'ws_1',
    kind: 'adhoc',
    title: '回复客户 Anna 的退货',
    status: 'open',
    context: { summary: '', pinned: [], participants: [], last_activity: clock.now() },
    created_at: clock.now(),
    updated_at: clock.now(),
    ...(model === undefined ? {} : { model }),
  }) as unknown as Matter

type Mode = 'stub' | 'direct' | 'dsh'

/** 跑一次：回 `run.started` 与网关收到的每一次 `model`（没显式给就是 `null`）。 */
async function runOnce(
  mode: Mode,
  matter: Matter,
  override: (id: string) => ModelRef | undefined = (id) => chatModelRefOf(models, id),
): Promise<{ started: RunEvent | undefined; asked: (ModelRef | null)[] }> {
  const asked: (ModelRef | null)[] = []
  const gateway = {
    async complete(req: { model?: ModelRef; messages: ChatMessage[] }) {
      asked.push(req.model ?? null)
      return {
        text: '好的，我先看看这单的物流。',
        usage: { input_tokens: 10, output_tokens: 5, cached_tokens: 0, cost_base: 0 },
        model: req.model ?? DEFAULT,
        static_prefix_hash: 'p',
      } satisfies Completion
    },
    async embed() {
      return { vectors: [], usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0 } }
    },
    usage: () => ({}),
    budget: () => ({}),
  } as unknown as ModelGatewayApi
  const events: Omit<EventEnvelope, 'id' | 'at'>[] = []
  const runtime = createRuntime({
    workspace_id: 'ws_1',
    clock,
    random: () => 0.5,
    seed: 42,
    env: {},
    models: gateway,
    approvals: {
      create: async () => ({ id: 'apr_1', state: 'pending' }),
    } as unknown as RuntimeOptions['approvals'],
    roles,
    appendEvent: (e) => events.push(e),
    prefer: mode === 'stub' ? 'stub' : 'direct',
    modelRef: () => DEFAULT,
    hasModel: () => mode !== 'stub',
    modelOverride: override,
    ...(mode === 'dsh' ? { dshAllRuns: true, dshMode: 'in-process' as const } : {}),
  } as RuntimeOptions)
  runtime.bind({
    appendEvent: () => undefined,
    onRunCompleted: () => undefined,
    onCard: () => undefined,
  } as unknown as Work)
  await runtime.startRun({
    matter,
    brief: '客户问退货进度',
    actor: { person_id: 'per_1', assignment_id: 'asg_1' },
  } as Parameters<typeof runtime.startRun>[0])
  const started = events
    .filter((e) => e.type === 'run.started')
    .map((e) => ({ type: e.type, ...(e.payload as object) }) as RunEvent)[0]
  return { started, asked }
}

const PICKED: ModelRef = { provider: 'agentsws-cloud', model: 'qwen-max' }

describe('WP342 (a) 这件事自己选的 AI：三个运行时都认', () => {
  for (const mode of ['stub', 'direct', 'dsh'] as const) {
    it(`${mode}：运行记录里是选的那个；另一件没选的不受影响`, async () => {
      const pinned = await runOnce(mode, matterOf('mat_a', 'agentsws-cloud/qwen-max'))
      expect(pinned.started?.type).toBe('run.started')
      // 真的走了那个运行时
      expect(pinned.started && 'runtime' in pinned.started ? pinned.started.runtime : '').toBe(
        { stub: 'stub', direct: 'direct-llm', dsh: 'dsh' }[mode],
      )
      expect(pinned.started && 'model' in pinned.started ? pinned.started.model : undefined).toEqual(
        PICKED,
      )
      if (mode !== 'stub') {
        expect(pinned.asked.length).toBeGreaterThan(0)
        // 每一次补全都显式交了选的那个（不按 purpose 选）
        for (const m of pinned.asked) expect(m).toEqual(PICKED)
      }

      const plain = await runOnce(mode, matterOf('mat_b'))
      const plainModel =
        plain.started && 'model' in plain.started ? plain.started.model : undefined
      expect(plainModel).not.toEqual(PICKED)
      // 没选：网关一次都没被点名（照旧按品牌默认 / purpose 选）
      for (const m of plain.asked) expect(m).toBeNull()
    })
  }
})

describe('WP342 (b) 选的那个后来用不了：退回品牌默认', () => {
  it('direct：事项上记着一个已经删掉的模型 → 照默认跑、不报错', async () => {
    const out = await runOnce('direct', matterOf('mat_c', 'gone/old-model'))
    expect(out.started && 'model' in out.started ? out.started.model : undefined).toEqual(DEFAULT)
    for (const m of out.asked) expect(m).toBeNull()
  })

  it('chatModelRefOf 只认已接的那几个', () => {
    expect(chatModelRefOf(models, 'agentsws-cloud/qwen-max')).toEqual(PICKED)
    expect(chatModelRefOf(models, 'gone/old-model')).toBeUndefined()
    expect(chatModelRefOf(models, 'nonsense')).toBeUndefined()
  })
})
