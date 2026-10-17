/**
 * WP374（决策 980）：**Anthropic 兼容口**（Claude 中转站等）从设置到干活。
 *
 * | 组 | 用什么 | 钉什么 |
 * |---|---|---|
 * | (a) 设置 | 真 `createModels` + 真网关 + 本机假中转站 | 有这张卡；存地址 + key 顺手拉清单；草稿按 Anthropic 口拉；勾的模型进 AI 钮（「自己接的」一组）；名字 / 上下文 / 思考档 / 看图只照官方目录；三步测试走得通；key 不进配置与清单 |
 * | (b) 报错人话 | 同上 | key 不对 →「API key 不对」；Anthropic 余额不足、中转站额度不足 →「余额不足」 |
 * | (c) 思考 | 同上 | AI 钮选的档经网关落到 `thinking`；没选不发 |
 * | (d) 三个运行时 | 真 `createRuntime`（stub / direct / dsh 进程内）+ (a) 那一套 | 运行记录里来源是这条中转站；direct / dsh 真打到假中转站 |
 *
 * 上游是 127.0.0.1 上的假服务，不联网、不花钱。
 */
import { randomBytes } from 'node:crypto'
import type { ModelsActor } from '@agentsws/api'
import type { Clock, EventEnvelope, Matter, RunEvent } from '@agentsws/contracts'
import { createModelGateway, loadAnthropicCatalog, stubProvider } from '@agentsws/model-gateway'
import type { RoleStore } from '@agentsws/roles'
import type { Work } from '@agentsws/work'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  BAD_KEY,
  BROKE_KEY,
  type FakeAnthropic,
  GOOD_KEY,
  RELAY_QUOTA_KEY,
  startFakeAnthropic,
} from '../../../packages/model-gateway/test/fixtures/fake-anthropic.js'
import { chatModelRefOf, createModels, MODEL_TEMPLATES } from '../src/models.js'
import { createRuntime, type RuntimeOptions } from '../src/runtime.js'
import { createSecretStore, SECRETS_KEY_ENV, type SecretStore } from '../src/secret-store.js'
import { type SubscriptionModelPort, subscriptionModelProvider } from '../src/subscription-model.js'

vi.setConfig({ testTimeout: 120_000 })

const clock: Clock = { now: () => '2026-10-17T10:00:00.000Z' }
const owner: ModelsActor = {
  workspace_id: 'ws_1',
  person_id: 'per_1',
  assignment_id: 'asg_1',
  role_id: 'owner',
}

let fake: FakeAnthropic
beforeAll(async () => {
  fake = await startFakeAnthropic()
  await loadAnthropicCatalog()
})
afterAll(async () => {
  await fake.close()
})

const stores: SecretStore[] = []
afterEach(() => {
  for (const s of stores.splice(0)) s.close()
})

function modelsWith() {
  const secrets = createSecretStore({
    dbPath: ':memory:',
    clock,
    env: { [SECRETS_KEY_ENV]: randomBytes(32).toString('hex') },
  })
  stores.push(secrets)
  const gateway = createModelGateway({
    providers: [stubProvider({ seed: 7 })],
    policy: { default: { provider: 'stub', model: 'stub' }, prices: {} },
    clock,
    eventSink: () => undefined,
    env: {},
  })
  const models = createModels({ clock, gateway, secrets, env: {} })
  return { gateway, models }
}

/** 存一条中转站（地址故意带 `/v1`：中转站文档常这么写）。 */
async function saveRelay(models: ReturnType<typeof modelsWith>['models'], key = GOOD_KEY) {
  return models.port.save(owner, 'my-relay', {
    kind: 'anthropic_compatible',
    label: '我的 Claude 中转站',
    base_url: `${fake.url}/v1`,
    model: 'claude-sonnet-4-5',
    api_key: key,
    picker_models: ['relay-claude-special'],
  })
}

describe('WP374 (a) 设置：卡、存、拉清单、勾进 AI 钮', () => {
  it('有「Anthropic 兼容（自定义）」这张卡：填 key、默认地址是 Anthropic 本家', () => {
    const tpl = MODEL_TEMPLATES.find((t) => t.kind === 'anthropic_compatible')
    expect(tpl).toMatchObject({
      vendor: 'anthropic-compatible',
      auth: 'api_key',
      default_base_url: 'https://api.anthropic.com',
    })
  })

  it('存的时候顺手拉清单（地址带 /v1 也对）；key 不进配置、不进清单', async () => {
    const { models } = modelsWith()
    const view = await saveRelay(models)
    expect(view).toMatchObject({ kind: 'anthropic_compatible', has_key: true, active: true })
    expect(view.last_listing?.ok).toBe(true)
    expect(view.models).toEqual([
      'claude-sonnet-4-5',
      'claude-haiku-4-5-20251001',
      'relay-claude-special',
    ])
    const listing = fake.requests.find((r) => r.path.startsWith('/v1/models'))
    expect(listing).toMatchObject({ key: 'good', version: '2023-06-01' })
    expect(JSON.stringify(models.exportSettings())).not.toContain(GOOD_KEY)
    expect(JSON.stringify(await models.port.providers(owner))).not.toContain(GOOD_KEY)
  })

  it('还没存的草稿：说了是 Anthropic 兼容就按 Anthropic 口拉；key 不对说人话', async () => {
    const { models } = modelsWith()
    const ok = await models.port.discover(owner, 'draft', {
      kind: 'anthropic_compatible',
      base_url: fake.url,
      api_key: GOOD_KEY,
    })
    expect(ok.ok).toBe(true)
    expect(ok.models).toContain('relay-claude-special')
    const bad = await models.port.discover(owner, 'draft', {
      kind: 'anthropic_compatible',
      base_url: fake.url,
      api_key: BAD_KEY,
    })
    expect(bad.ok).toBe(false)
    expect(bad.reason).toContain('API key 不对')
  })

  it('勾的模型进 AI 钮「自己接的」那组；名字 / 上下文 / 思考档 / 看图只照官方目录', async () => {
    const { models } = modelsWith()
    await saveRelay(models)
    const rows = models.chatChoices().filter((c) => c.id.startsWith('my-relay/'))
    expect(rows.map((r) => r.id)).toEqual([
      'my-relay/claude-sonnet-4-5',
      'my-relay/relay-claude-special',
    ])
    const [sonnet, special] = rows
    expect(sonnet).toMatchObject({
      label: '我的 Claude 中转站',
      group: 'own',
      vendor: 'anthropic',
      vision: 'ok',
      context_window: 1_000_000,
      price: { kind: 'own_key' },
    })
    expect(sonnet?.name).toContain('Sonnet 4.5')
    expect(sonnet?.native_search).toBeUndefined()
    expect(sonnet?.thinking).toEqual({
      options: [
        { level: 'fast', effort: 'low' },
        { level: 'standard', effort: 'medium' },
        { level: 'deep', effort: 'high' },
      ],
      default: 'medium',
    })
    // 中转站自己起名的：一样都不编（看图没验证过、没有思考程度）
    expect(special).toMatchObject({ group: 'own', vision: 'unchecked' })
    expect(special?.thinking).toBeUndefined()
    expect(special?.name).toBeUndefined()
    // 设置页「默认模型」下拉先列同一份
    const defaults = await models.port.defaults(owner)
    expect(defaults.choices.map((c) => c.id).slice(0, 2)).toEqual(rows.map((r) => r.id))
  })

  it('三步测试：连得上、文字能回、图也看得懂', async () => {
    const { models } = modelsWith()
    await saveRelay(models)
    const result = await models.port.test(owner, 'my-relay')
    expect(result).toMatchObject({ ok: true, vision: true, model: 'my-relay/claude-sonnet-4-5' })
  })
})

describe('WP374 (b) 报错人话', () => {
  for (const [key, words] of [
    [BAD_KEY, 'API key 不对'],
    [BROKE_KEY, '余额不足'],
    [RELAY_QUOTA_KEY, '余额不足'],
  ] as const) {
    it(`${words}（${key === BAD_KEY ? 'key 错' : key === BROKE_KEY ? 'Anthropic 余额' : '中转站额度'}）`, async () => {
      const { models } = modelsWith()
      await saveRelay(models, key)
      const result = await models.port.test(owner, 'my-relay')
      expect(result.ok).toBe(false)
      expect(result.detail).toContain(words)
      expect(JSON.stringify(result)).not.toContain(key)
    })
  }
})

describe('WP374 (c) 思考程度经网关落到 thinking', () => {
  it('选了「深想」(high) 就开思考；没选按「标准」发（决策 1032）；硬要别想不开；中转站自己起名的不发', async () => {
    const { models, gateway } = modelsWith()
    await saveRelay(models)
    const meta = {
      workspace_id: 'ws_1',
      assignment_id: 'asg_1',
      role_id: 'owner',
      run_id: 'run_wp374',
      purpose: 'run' as const,
    }
    const ask = async (model: string, effort?: 'high', off = false) => {
      await gateway.complete({
        model: { provider: 'my-relay', model, region: 'global' },
        messages: [{ role: 'user', content: '在吗' }],
        meta,
        ...(effort === undefined ? {} : { reasoning_effort: effort }),
        ...(off ? { thinking: 'off' as const } : {}),
      })
      return fake.requests.at(-1)?.body?.thinking as { type?: string; budget_tokens?: number }
    }
    const deep = await ask('claude-sonnet-4-5', 'high')
    expect(deep).toMatchObject({ type: 'enabled' })
    // 显示什么就发什么：AI 钮上默认亮「标准」（Sonnet 4.5 = medium），没选也按它发
    const standard = await ask('claude-sonnet-4-5')
    expect(standard).toMatchObject({ type: 'enabled' })
    expect(standard.budget_tokens).toBeLessThan(deep.budget_tokens ?? 0)
    expect(await ask('claude-sonnet-4-5', undefined, true)).toEqual({ type: 'disabled' })
    expect(await ask('relay-claude-special', 'high')).toBeUndefined()
    expect(await ask('relay-claude-special')).toBeUndefined()
  })
})

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

async function runOnce(mode: Mode, pinned?: string) {
  const { models, gateway } = modelsWith()
  await saveRelay(models)
  await models.port.setDefaults(owner, { default: 'my-relay/claude-sonnet-4-5' })
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
    modelRef: () => models.defaultRef(),
    modelOverride: (id: string) => chatModelRefOf(models, id),
    hasModel: () => true,
    ...(mode === 'dsh' ? { dshAllRuns: true, dshMode: 'in-process' as const } : {}),
  } as unknown as RuntimeOptions)
  runtime.bind({
    appendEvent: () => undefined,
    onRunCompleted: () => undefined,
    onCard: () => undefined,
  } as unknown as Work)
  const before = fake.requests.filter((r) => r.path.startsWith('/v1/messages')).length
  await runtime.startRun({
    matter: matterOf(`mat_${mode}`, pinned),
    brief: '客户问退货进度',
    actor: { person_id: 'per_1', assignment_id: 'asg_1' },
  } as Parameters<typeof runtime.startRun>[0])
  const sent = fake.requests.filter((r) => r.path.startsWith('/v1/messages')).slice(before)
  const started = events
    .filter((e) => e.type === 'run.started')
    .map((e) => ({ type: e.type, ...(e.payload as object) }) as RunEvent)[0]
  return { started, sent, events }
}

describe('WP374 (d) 三个运行时都能用 Anthropic 兼容口跑', () => {
  for (const mode of ['stub', 'direct', 'dsh'] as const) {
    it(`${mode}：运行记录里来源是这条中转站；direct / dsh 真打到中转站；事件里没有 key`, async () => {
      // stub 档本来就不问模型：只有在 AI 钮上选了它，运行记录里才记它（WP342 的规矩）
      const { started, sent, events } = await runOnce(
        mode,
        mode === 'stub' ? 'my-relay/claude-sonnet-4-5' : undefined,
      )
      expect(started && 'model' in started ? started.model : undefined).toMatchObject({
        provider: 'my-relay',
        model: 'claude-sonnet-4-5',
      })
      if (mode === 'stub') expect(sent).toEqual([])
      else {
        expect(sent.length).toBeGreaterThan(0)
        for (const r of sent) expect(r).toMatchObject({ key: 'good' })
        for (const r of sent) expect(r.body?.model).toBe('claude-sonnet-4-5')
        // 中转站回的那句话流回了运行（收尾那一步要的「工作」对象这里是替身，跑没跑完不在本单范围）
        const deltas = events
          .filter((e) => e.type === 'text.delta')
          .map((e) => JSON.stringify(e.payload))
        expect(deltas.join('')).toContain('退货')
      }
      expect(JSON.stringify(events)).not.toContain(GOOD_KEY)
    })
  }

  it('direct：AI 钮选了中转站里另一个模型 → 每次补全都用它', async () => {
    const { sent } = await runOnce('direct', 'my-relay/relay-claude-special')
    expect(sent.length).toBeGreaterThan(0)
    for (const r of sent) expect(r.body?.model).toBe('relay-claude-special')
  })
})

describe('WP374 (e) 决策 1032 同样的问题：ChatGPT 订阅没选档时也按「标准」发', () => {
  // 官方 pi-ai 对订阅「不给档」= 发 reasoning.effort none（不想），AI 钮上却默认亮「标准」（medium）
  it('没选 → medium；选了 → 照选的；硬要别想 → 不交档（订阅那一跳自己写 minimal）', async () => {
    const asked: (string | undefined)[] = []
    const port: SubscriptionModelPort = {
      signedIn: () => true,
      catalog: () => [
        {
          id: 'gpt-5.5',
          name: 'GPT-5.5',
          vision: true,
          efforts: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
        },
      ],
      async complete(_person, _provider, request) {
        asked.push(request.reasoning_effort)
        return {
          text: '好',
          usage: { input_tokens: 1, output_tokens: 1, cached_tokens: 0 },
          model: request.model,
        } as never
      },
    }
    const provider = subscriptionModelProvider({
      port,
      model: 'gpt-5.5',
      vision: true,
      defaultEffort: () => 'medium',
    })
    const messages = [{ role: 'user' as const, content: '在吗' }]
    await provider.complete({ messages })
    await provider.complete({ messages, reasoning_effort: 'high' })
    await provider.complete({ messages, thinking: 'off' })
    expect(asked).toEqual(['medium', 'high', undefined])
  })
})
