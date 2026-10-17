/**
 * WP378（决策 1055，Luoye 10-17）：用户自己的 DeepSeek API key 走 **Chat 口**那条来源，也出 WP373 的思考小钮；
 * 三档与工坊积分一致（v4 Pro 快 = 关掉思考 / 标准 = high / 深度 = max；Flash 快 = low / 标准 = high / 深度 = max），
 * 选了哪档请求体里就发哪档（决策 1032）。账号 / Messages 口那条同一张表（口径一致）。
 *
 * | 组 | 钉什么 |
 * |---|---|
 * | (a) AI 钮 | Chat 口：Pro / Flash 出三档；老名字（`deepseek-chat`）、代理地址不出；Messages 口 Pro 的「快」也是关掉思考 |
 * | (b) 请求体 | 打到 DeepSeek 官方 Chat 口的请求体：Pro off / high / max、Flash low；没选一格不多；代理地址不发 |
 * | (c) 运行时 | 真 `createRuntime`（stub / direct / dsh 进程内）+ 真网关：事项选的档每次补全都落进请求体 |
 *
 * 上游是假 fetch（不联网、不花钱），key 是测试假值。
 */
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Clock, Matter, ReasoningEffort } from '@agentsws/contracts'
import { createModelGateway, type FetchLike, stubProvider } from '@agentsws/model-gateway'
import type { RoleStore } from '@agentsws/roles'
import type { Work } from '@agentsws/work'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hasThinkingEffort } from '../src/model-thinking.js'
import {
  chatModelRefOf,
  createModels,
  DEEPSEEK_MESSAGES_ENV,
  MODEL_KEY_PREFIX,
} from '../src/models.js'
import { createRuntime, type RuntimeOptions } from '../src/runtime.js'
import { createSecretStore, SECRETS_KEY_ENV, type SecretStore } from '../src/secret-store.js'

vi.setConfig({ testTimeout: 120_000 })

const clock: Clock = { now: () => '2026-10-17T10:00:00.000Z' }
const dirs: string[] = []
const stores: SecretStore[] = []
afterEach(() => {
  for (const s of stores.splice(0)) s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const FAKE_KEY = 'sk-wp378-fake-not-a-real-key'

interface Call {
  url: string
  body: Record<string, unknown>
}

/** 假上游：Chat 口与 Messages 口两种形状都回（流式 / 非流式都认），记下每次的地址与请求体。 */
function fakeUpstream(): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = []
  const fetch: FetchLike = async (url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    calls.push({ url, body })
    if (url.endsWith('/v1/messages')) {
      const json = {
        content: [{ type: 'text', text: '好的，我先看看这单的物流。' }],
        usage: { input_tokens: 3, output_tokens: 9 },
      }
      return { ok: true, status: 200, json: async () => json, text: async () => '' }
    }
    const text = '好的，我先看看这单的物流。'
    const usage = { prompt_tokens: 3, completion_tokens: 9 }
    const sse = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage })}`,
      'data: [DONE]',
      '',
    ].join('\n\n')
    const json = {
      choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage,
    }
    return { ok: true, status: 200, json: async () => json, text: async () => sse }
  }
  return { fetch, calls }
}

/** 一份 models.json：DeepSeek 官方 key（Flash 为主，AI 钮里另列 v4 Pro 与老名字）+ 一条代理地址。 */
function setup(env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'agentsws-wp378-'))
  dirs.push(dir)
  writeFileSync(
    join(dir, 'models.json'),
    JSON.stringify({
      version: 1,
      providers: [
        {
          id: 'deepseek',
          kind: 'deepseek',
          label: 'DeepSeek 官方',
          base_url: 'https://api.deepseek.com',
          model: 'deepseek-flash',
          picker_models: ['deepseek-v4-pro', 'deepseek-chat'],
          region: 'cn',
        },
        {
          id: 'ds-proxy',
          kind: 'deepseek',
          label: '某代理',
          base_url: 'https://proxy.example.invalid/v1',
          model: 'deepseek-v4-pro',
          region: 'cn',
        },
      ],
      defaults: { default: 'deepseek/deepseek-flash' },
      tests: {},
    }),
  )
  const secrets = createSecretStore({
    dbPath: ':memory:',
    clock,
    env: { [SECRETS_KEY_ENV]: randomBytes(32).toString('hex') },
  })
  stores.push(secrets)
  secrets.put(`${MODEL_KEY_PREFIX}deepseek`, { api_key: FAKE_KEY })
  secrets.put(`${MODEL_KEY_PREFIX}ds-proxy`, { api_key: FAKE_KEY })
  const upstream = fakeUpstream()
  const gateway = createModelGateway({
    providers: [stubProvider({ seed: 7 })],
    policy: { default: { provider: 'stub', model: 'stub' }, prices: {} },
    clock,
    eventSink: () => undefined,
    env: {},
  })
  const models = createModels({
    clock,
    gateway,
    secrets,
    env,
    dbDir: dir,
    fetch: upstream.fetch,
  })
  return { models, gateway, calls: upstream.calls }
}

const PRO = {
  options: [
    { level: 'fast', effort: 'off' },
    { level: 'standard', effort: 'high' },
    { level: 'deep', effort: 'max' },
  ],
  default: 'high',
}
const FLASH = {
  options: [
    { level: 'fast', effort: 'low' },
    { level: 'standard', effort: 'high' },
    { level: 'deep', effort: 'max' },
  ],
  default: 'high',
}

describe('WP378 (a) AI 钮：DeepSeek 自带 key 也出思考小钮', () => {
  it('Chat 口：v4 Pro 快 = 关掉思考、Flash 快 = low；老名字与代理地址不出', () => {
    const { models } = setup()
    const choices = models.chatChoices()
    const of = (id: string) => choices.find((c) => c.id === id)
    expect(of('deepseek/deepseek-v4-pro')?.thinking).toEqual(PRO)
    expect(of('deepseek/deepseek-flash')?.thinking).toEqual(FLASH)
    expect(of('deepseek/deepseek-chat')).toBeDefined()
    expect(of('deepseek/deepseek-chat')?.thinking).toBeUndefined()
    expect(of('ds-proxy/deepseek-v4-pro')).toBeDefined()
    expect(of('ds-proxy/deepseek-v4-pro')?.thinking).toBeUndefined()
  })

  it('Messages 口（WP143 开关）：同一张表，Pro 的「快」也是关掉思考（三条来源口径一致）', () => {
    const { models } = setup({ [DEEPSEEK_MESSAGES_ENV]: '1' })
    const of = (id: string) => models.chatChoices().find((c) => c.id === id)
    expect(of('deepseek/deepseek-v4-pro')?.thinking).toEqual(PRO)
    expect(of('deepseek/deepseek-flash')?.thinking).toEqual(FLASH)
  })
})

describe('WP378 (b) 请求体：选了哪档就发哪档（决策 1032）', () => {
  const meta = {
    workspace_id: 'ws_1',
    assignment_id: 'asg_1',
    role_id: 'role_1',
    run_id: 'run_1',
    purpose: 'run' as const,
  }
  const ask = (
    gateway: ReturnType<typeof setup>['gateway'],
    provider: string,
    model: string,
    effort?: ReasoningEffort,
  ) =>
    gateway.complete({
      messages: [{ role: 'user', content: '在吗' }],
      meta,
      model: { provider, model },
      ...(effort === undefined ? {} : { reasoning_effort: effort }),
    })

  it('官方 Chat 口：Pro 快 / 标准 / 深度、Flash 快、没选', async () => {
    const { gateway, calls } = setup()
    await ask(gateway, 'deepseek', 'deepseek-v4-pro', 'off')
    await ask(gateway, 'deepseek', 'deepseek-v4-pro', 'high')
    await ask(gateway, 'deepseek', 'deepseek-v4-pro', 'max')
    await ask(gateway, 'deepseek', 'deepseek-flash', 'low')
    await ask(gateway, 'deepseek', 'deepseek-flash')
    expect(calls.map((c) => c.url)).toEqual(
      Array(5).fill('https://api.deepseek.com/chat/completions'),
    )
    const two = calls.map((c) => [c.body.model, c.body.thinking, c.body.reasoning_effort])
    expect(two).toEqual([
      ['deepseek-v4-pro', { type: 'disabled' }, undefined],
      ['deepseek-v4-pro', { type: 'enabled' }, 'high'],
      ['deepseek-v4-pro', { type: 'enabled' }, 'max'],
      ['deepseek-flash', { type: 'enabled' }, 'low'],
      ['deepseek-flash', undefined, undefined],
    ])
    expect(calls[4]?.body).not.toHaveProperty('thinking')
    expect(calls[4]?.body).not.toHaveProperty('reasoning_effort')
  })

  it('代理地址：选了档也一格不发（老行为不变）', async () => {
    const { gateway, calls } = setup()
    await ask(gateway, 'ds-proxy', 'deepseek-v4-pro', 'max')
    expect(calls[0]?.url).toBe('https://proxy.example.invalid/v1/chat/completions')
    expect(calls[0]?.body).not.toHaveProperty('thinking')
    expect(calls[0]?.body).not.toHaveProperty('reasoning_effort')
  })

  it('Messages 口：Pro 的「快」（off）发 thinking disabled，深度发 output_config.effort = max', async () => {
    const { gateway, calls } = setup({ [DEEPSEEK_MESSAGES_ENV]: '1' })
    await ask(gateway, 'deepseek', 'deepseek-v4-pro', 'off')
    await ask(gateway, 'deepseek', 'deepseek-v4-pro', 'max')
    expect(calls[0]?.url).toMatch(/\/anthropic\/v1\/messages$/)
    expect(calls[0]?.body.thinking).toEqual({ type: 'disabled' })
    expect(calls[1]?.body).toMatchObject({
      thinking: { type: 'enabled' },
      output_config: { effort: 'max' },
    })
  })
})

const roles = {
  effectiveConfig: () => ({ role_id: 'dtc.support', grounding: [], skills: [], browser_scope: [] }),
  assignments: { get: () => undefined },
} as unknown as RoleStore

const matterOf = (id: string, model: string, effort?: ReasoningEffort): Matter =>
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
    model,
    ...(effort === undefined ? {} : { model_effort: effort }),
  }) as unknown as Matter

type Mode = 'stub' | 'direct' | 'dsh'

/** 跑一次事项：回打到 DeepSeek 官方 Chat 口的每一个请求体。 */
async function runOnce(mode: Mode, matter: Matter): Promise<Record<string, unknown>[]> {
  const { models, gateway, calls } = setup()
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
    appendEvent: () => undefined,
    prefer: mode === 'stub' ? 'stub' : 'direct',
    modelRef: () => ({ provider: 'deepseek', model: 'deepseek-flash', region: 'cn' }),
    hasModel: () => mode !== 'stub',
    modelOverride: (id: string) => chatModelRefOf(models, id),
    modelEffort: (id: string, effort: ReasoningEffort) =>
      models.chatChoices().some((c) => c.id === id && hasThinkingEffort(c.thinking, effort)),
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
  return calls
    .filter((c) => c.url === 'https://api.deepseek.com/chat/completions')
    .map((c) => c.body)
}

describe('WP378 (c) 三个运行时：事项选的档落进打到 DeepSeek 的请求体', () => {
  for (const mode of ['direct', 'dsh'] as const) {
    it(`${mode}：Pro 选「快」= 关掉思考、选「深度」= max；Flash 选「快」= low；没选一格不多`, async () => {
      const fast = await runOnce(mode, matterOf('mat_a', 'deepseek/deepseek-v4-pro', 'off'))
      expect(fast.length).toBeGreaterThan(0)
      for (const b of fast) {
        expect(b.model).toBe('deepseek-v4-pro')
        expect(b.thinking).toEqual({ type: 'disabled' })
        expect(b).not.toHaveProperty('reasoning_effort')
      }

      const deep = await runOnce(mode, matterOf('mat_b', 'deepseek/deepseek-v4-pro', 'max'))
      expect(deep.length).toBeGreaterThan(0)
      for (const b of deep)
        expect(b).toMatchObject({ thinking: { type: 'enabled' }, reasoning_effort: 'max' })

      const flash = await runOnce(mode, matterOf('mat_c', 'deepseek/deepseek-flash', 'low'))
      expect(flash.length).toBeGreaterThan(0)
      for (const b of flash)
        expect(b).toMatchObject({ thinking: { type: 'enabled' }, reasoning_effort: 'low' })

      // Pro 不在三档里的 low：事项不交出去，按模型默认（请求体一格不多）
      const stale = await runOnce(mode, matterOf('mat_d', 'deepseek/deepseek-v4-pro', 'low'))
      expect(stale.length).toBeGreaterThan(0)
      for (const b of stale) {
        expect(b).not.toHaveProperty('thinking')
        expect(b).not.toHaveProperty('reasoning_effort')
      }

      const plain = await runOnce(mode, matterOf('mat_e', 'deepseek/deepseek-v4-pro'))
      expect(plain.length).toBeGreaterThan(0)
      for (const b of plain) {
        expect(b).not.toHaveProperty('thinking')
        expect(b).not.toHaveProperty('reasoning_effort')
      }
    })
  }

  it('stub：不打上游，照样跑完', async () => {
    const bodies = await runOnce('stub', matterOf('mat_f', 'deepseek/deepseek-v4-pro', 'max'))
    expect(bodies).toEqual([])
  })
})
