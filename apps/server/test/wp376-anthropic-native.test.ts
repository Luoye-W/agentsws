/**
 * WP376（决策 1031 + 1027）：「Anthropic / Claude」卡的 API key 改走原生 Messages 口（存量自动迁、可回退），
 * 自己接的 OpenAI 兼容口地址是官方目录认识的那家时走官方 pi-ai、思考档自动出现。
 *
 * | 组 | 用什么 | 钉什么 |
 * |---|---|---|
 * | (a) 迁移 | 真 `createModels` + 落盘的 `models.json` + 加密库 | 老配置启动时换成原生口（id / key / 模型 / 勾的模型 / 默认不动）；跑几遍一样；回退开关改回去；迁前迁后同一配置都能用 |
 * | (b) 迁过去以后 | 同上 + 本机假 Anthropic | AI 钮里出思考档、选的档落到 `thinking`；报错说人话 |
 * | (c) OpenAI 兼容口 | 同上 + 本机假 OpenAI 兼容口 | 官方目录认得的出档、选的档照那家的写法发；中转站不出、照旧发 |
 * | (d) 三个运行时 | 真 `createRuntime`（stub / direct / dsh 进程内） | 迁过去的那一条 direct / dsh 真打到原生口 |
 *
 * 官方地址的请求都原样改投到 127.0.0.1 上的假服务，不联网、不花钱。
 */

import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ModelsActor } from '@agentsws/api'
import type { Clock, EventEnvelope, Matter, RunEvent } from '@agentsws/contracts'
import {
  createModelGateway,
  loadAnthropicCatalog,
  loadOfficialRoutes,
  stubProvider,
} from '@agentsws/model-gateway'
import type { RoleStore } from '@agentsws/roles'
import type { Work } from '@agentsws/work'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  BAD_KEY,
  type FakeAnthropic,
  GOOD_KEY,
  startFakeAnthropic,
} from '../../../packages/model-gateway/test/fixtures/fake-anthropic.js'
import {
  type FakeOpenAi,
  GOOD_KEY as OPENAI_KEY,
  redirectFetch,
  startFakeOpenAi,
} from '../../../packages/model-gateway/test/fixtures/fake-openai.js'
import {
  ANTHROPIC_NATIVE_ENV,
  chatModelRefOf,
  createModels,
  MODEL_KEY_PREFIX,
  migrateAnthropicNativeConfig,
} from '../src/models.js'
import { createRuntime, type RuntimeOptions } from '../src/runtime.js'
import { createSecretStore, SECRETS_KEY_ENV, type SecretStore } from '../src/secret-store.js'

vi.setConfig({ testTimeout: 120_000 })

const clock: Clock = { now: () => '2026-10-17T10:00:00.000Z' }
const owner: ModelsActor = {
  workspace_id: 'ws_1',
  person_id: 'per_1',
  assignment_id: 'asg_1',
  role_id: 'owner',
}
const meta = {
  workspace_id: 'ws_1',
  assignment_id: 'asg_1',
  role_id: 'owner',
  run_id: 'run_wp376',
  purpose: 'run' as const,
}

let anthropic: FakeAnthropic
let openai: FakeOpenAi
beforeAll(async () => {
  ;[anthropic, openai] = await Promise.all([startFakeAnthropic(), startFakeOpenAi()])
  await Promise.all([loadAnthropicCatalog(), loadOfficialRoutes()])
})
afterAll(async () => {
  await Promise.all([anthropic.close(), openai.close()])
})

const dirs: string[] = []
const stores: SecretStore[] = []
afterEach(() => {
  for (const s of stores.splice(0)) s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** 官方地址 → 假服务：原生口去假 Anthropic，OpenAI 兼容层与 OpenRouter 去假 OpenAI 兼容口。 */
const routed: typeof globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const to = url.startsWith('https://api.anthropic.com/v1/chat')
    ? redirectFetch('https://api.anthropic.com', openai.url)
    : url.startsWith('https://api.anthropic.com')
      ? redirectFetch('https://api.anthropic.com', anthropic.url)
      : redirectFetch('https://openrouter.ai/api', openai.url)
  return to(input, init)
}

/** 一台「升级前」的机器：models.json 里存着老写法（OpenAI 兼容层），key 在加密库里。 */
function oldMachine(key = GOOD_KEY) {
  const dir = mkdtempSync(join(tmpdir(), 'wp376-'))
  dirs.push(dir)
  const secretsKey = randomBytes(32).toString('hex')
  writeFileSync(
    join(dir, 'models.json'),
    JSON.stringify({
      version: 1,
      providers: [
        {
          id: 'anthropic',
          kind: 'openai_compatible',
          label: 'Anthropic（API key，按量计费）',
          base_url: 'https://api.anthropic.com/v1/',
          model: 'claude-sonnet-4-5',
          region: 'global',
          models: ['claude-sonnet-4-5', 'claude-haiku-4-5-20251001'],
          picker_models: ['claude-haiku-4-5-20251001'],
        },
      ],
      defaults: { default: 'anthropic/claude-sonnet-4-5' },
      tests: {},
    }),
  )
  const boot = (env: Record<string, string> = {}) => {
    const secrets = createSecretStore({
      dbPath: join(dir, 'secrets.db'),
      clock,
      env: { [SECRETS_KEY_ENV]: secretsKey },
    })
    stores.push(secrets)
    if (secrets.get(`${MODEL_KEY_PREFIX}anthropic`) === undefined)
      secrets.put(`${MODEL_KEY_PREFIX}anthropic`, { api_key: key })
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
      fetch: routed as never,
      piFetch: routed,
    })
    return { models, gateway }
  }
  const onDisk = () =>
    JSON.parse(readFileSync(join(dir, 'models.json'), 'utf8')) as {
      providers: Record<string, unknown>[]
      defaults: { default?: string }
    }
  return { boot, onDisk }
}

const ask = (
  gateway: ReturnType<ReturnType<typeof oldMachine>['boot']>['gateway'],
  model: string,
  effort?: 'high',
) =>
  gateway.complete({
    model: { provider: 'anthropic', model, region: 'global' },
    messages: [{ role: 'user', content: '在吗' }],
    meta,
    ...(effort === undefined ? {} : { reasoning_effort: effort }),
  })

describe('WP376 (a) 存量配置自动迁到原生口', () => {
  it('启动时换成原生口：只换种类与地址，id / key / 模型 / 勾的模型 / 默认都不动；落盘记下迁之前的样子', async () => {
    const machine = oldMachine()
    const { models } = machine.boot()
    const [view] = await models.port.providers(owner)
    expect(view).toMatchObject({
      id: 'anthropic',
      kind: 'anthropic_compatible',
      base_url: 'https://api.anthropic.com',
      model: 'claude-sonnet-4-5',
      picker_models: ['claude-haiku-4-5-20251001'],
      has_key: true,
    })
    const disk = machine.onDisk()
    expect(disk.defaults.default).toBe('anthropic/claude-sonnet-4-5')
    expect(disk.providers[0]?.migrated_from).toEqual({
      kind: 'openai_compatible',
      base_url: 'https://api.anthropic.com/v1/',
      at: clock.now(),
    })
    expect(JSON.stringify(disk)).not.toContain(GOOD_KEY)
  })

  it('幂等：再启动一次、再迁一次，文件一个字节都不变；不该迁的不迁', async () => {
    const machine = oldMachine()
    machine.boot()
    const first = JSON.stringify(machine.onDisk())
    machine.boot()
    expect(JSON.stringify(machine.onDisk())).toBe(first)
    const migrated = machine.onDisk().providers[0] as never
    expect(migrateAnthropicNativeConfig(migrated, clock.now())).toBeUndefined()
    expect(
      migrateAnthropicNativeConfig(
        {
          id: 'relay',
          kind: 'openai_compatible',
          label: 'x',
          base_url: 'https://relay.example.com/v1',
          model: 'claude-sonnet-4-5',
          region: 'global',
        },
        clock.now(),
      ),
    ).toBeUndefined()
  })

  it('回退：开关设成 off 就原样改回 OpenAI 兼容层；去掉开关再迁回来', async () => {
    const machine = oldMachine()
    machine.boot()
    const { models } = machine.boot({ [ANTHROPIC_NATIVE_ENV]: 'off' })
    const [view] = await models.port.providers(owner)
    expect(view).toMatchObject({
      kind: 'openai_compatible',
      base_url: 'https://api.anthropic.com/v1/',
    })
    expect(machine.onDisk().providers[0]?.migrated_from).toBeUndefined()
    machine.boot()
    expect(machine.onDisk().providers[0]).toMatchObject({ kind: 'anthropic_compatible' })
  })

  it('迁前迁后同一配置都能用：迁前走 OpenAI 兼容层，迁后走原生 Messages 口', async () => {
    const machine = oldMachine()
    const before = machine.boot({ [ANTHROPIC_NATIVE_ENV]: 'off' })
    const old = await ask(before.gateway, 'claude-sonnet-4-5')
    expect(old.text).toBe('非流式的回答')
    expect(openai.requests.at(-1)?.path).toBe('/v1/chat/completions')
    const after = machine.boot()
    const now = await ask(after.gateway, 'claude-sonnet-4-5')
    expect(now.text.length).toBeGreaterThan(0)
    expect(anthropic.requests.at(-1)).toMatchObject({ key: 'good' })
    expect(anthropic.requests.at(-1)?.path).toContain('/v1/messages')
  })
})

describe('WP376 (b) 迁过去以后：思考档、报错', () => {
  it('AI 钮里出「快 / 标准 / 深度」；选了深度就开思考，没选按标准发', async () => {
    const { models, gateway } = oldMachine().boot()
    const sonnet = models.chatChoices().find((c) => c.id === 'anthropic/claude-sonnet-4-5')
    expect(sonnet?.thinking?.default).toBe('medium')
    expect(sonnet?.thinking?.options.map((o) => o.level)).toEqual(['fast', 'standard', 'deep'])
    expect(sonnet?.name).toContain('Sonnet 4.5')
    await ask(gateway, 'claude-sonnet-4-5', 'high')
    const deep = anthropic.requests.at(-1)?.body?.thinking as {
      type?: string
      budget_tokens?: number
    }
    expect(deep).toMatchObject({ type: 'enabled' })
    await ask(gateway, 'claude-sonnet-4-5')
    const standard = anthropic.requests.at(-1)?.body?.thinking as { budget_tokens?: number }
    expect(standard.budget_tokens).toBeLessThan(deep.budget_tokens ?? 0)
  })

  it('key 不对：测试说人话，原文里没有 key', async () => {
    const { models } = oldMachine(BAD_KEY).boot()
    const result = await models.port.test(owner, 'anthropic')
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('API key 不对')
    expect(JSON.stringify(result)).not.toContain(BAD_KEY)
  })
})

describe('WP376 (c) 自己接的 OpenAI 兼容口：官方目录认得的出档', () => {
  async function saved() {
    const { models, gateway } = oldMachine().boot()
    await models.port.save(owner, 'openrouter', {
      kind: 'openai_compatible',
      label: 'OpenRouter',
      base_url: 'https://openrouter.ai/api/v1',
      model: 'openai/gpt-5',
      api_key: OPENAI_KEY,
      picker_models: ['relay-own-model'],
    })
    await models.port.save(owner, 'relay', {
      kind: 'openai_compatible',
      label: '中转站',
      base_url: `${openai.url}/v1`,
      model: 'openai/gpt-5',
      api_key: OPENAI_KEY,
    })
    return { models, gateway }
  }

  it('认得的：名字 / 思考档照目录；目录外的型号、中转站地址：不出', async () => {
    const { models } = await saved()
    const byId = (id: string) => models.chatChoices().find((c) => c.id === id)
    expect(byId('openrouter/openai/gpt-5')?.thinking).toEqual({
      options: [
        { level: 'fast', effort: 'low' },
        { level: 'standard', effort: 'medium' },
        { level: 'deep', effort: 'high' },
      ],
      default: 'medium',
    })
    expect(byId('openrouter/relay-own-model')?.thinking).toBeUndefined()
    expect(byId('relay/openai/gpt-5')?.thinking).toBeUndefined()
  })

  it('选的档照 OpenRouter 的写法发（reasoning.effort）；没选按标准；中转站照旧（非流式、不带档）', async () => {
    const { gateway } = await saved()
    const send = async (provider: string, effort?: 'high') => {
      await gateway.complete({
        model: { provider, model: 'openai/gpt-5', region: 'global' },
        messages: [{ role: 'user', content: '在吗' }],
        meta,
        ...(effort === undefined ? {} : { reasoning_effort: effort }),
      })
      return openai.requests.at(-1)?.body ?? {}
    }
    expect((await send('openrouter', 'high')).reasoning).toEqual({ effort: 'high' })
    expect((await send('openrouter')).reasoning).toEqual({ effort: 'medium' })
    const relay = await send('relay', 'high')
    expect(relay.stream).toBe(false)
    expect(relay.reasoning).toBeUndefined()
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

describe('WP376 (d) 三个运行时：迁过去的那一条照样跑', () => {
  for (const mode of ['stub', 'direct', 'dsh'] as const) {
    it(`${mode}：运行记录里来源是它；direct / dsh 真打到原生口；事件里没有 key`, async () => {
      const { models, gateway } = oldMachine().boot()
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
      const before = anthropic.requests.filter((r) => r.path.startsWith('/v1/messages')).length
      await runtime.startRun({
        matter: matterOf(
          `mat_${mode}`,
          mode === 'stub' ? 'anthropic/claude-sonnet-4-5' : undefined,
        ),
        brief: '客户问退货进度',
        actor: { person_id: 'per_1', assignment_id: 'asg_1' },
      } as Parameters<typeof runtime.startRun>[0])
      const sent = anthropic.requests.filter((r) => r.path.startsWith('/v1/messages')).slice(before)
      const started = events
        .filter((e) => e.type === 'run.started')
        .map((e) => ({ type: e.type, ...(e.payload as object) }) as RunEvent)[0]
      expect(started && 'model' in started ? started.model : undefined).toMatchObject({
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
      })
      if (mode === 'stub') expect(sent).toEqual([])
      else {
        expect(sent.length).toBeGreaterThan(0)
        for (const r of sent) expect(r).toMatchObject({ key: 'good' })
      }
      expect(JSON.stringify(events)).not.toContain(GOOD_KEY)
    })
  }
})
