/**
 * WP362（Luoye 10-16，决策 938）：**ChatGPT 订阅能被选来干活**。
 *
 * | 组 | 用什么 | 钉什么 |
 * |---|---|---|
 * | (a) 模型面 | 真 `createModels` + 真网关 + 订阅替身 | 登录后订阅进默认模型下拉与 AI 钮清单（标「ChatGPT 订阅」）、能设成默认；不进 models.json；没登录就没有；花费 0；按人取订阅 |
 * | (b) 报错 | 同上 | 没登录 / 过期 → `unauthenticated`，限流 → `rate_limited`（网关不悄悄换一家） |
 * | (c) 订阅装配 | 真 `createSubscription` + 登录树替身 | 「有没有人登录过」只看本机库；点名的人没登录、只有一个人登录过 → 用那个人的；公司档一律没有 |
 * | (d) 三个运行时 | 真 `createRuntime`（stub / direct / dsh 进程内）+ (a) 那一套 | 运行记录里来源是订阅；direct / dsh 真经订阅那一跳、带上人；过期 / 限流 → 「ChatGPT 订阅」连接卡；事件里没有令牌 |
 * | (e) WP355 收尾 | `webBrief` | 订阅的运行说实话：搜索先走 ChatGPT 自带 |
 *
 * 全程替身，不联网。
 */
import { randomBytes } from 'node:crypto'
import type { ModelsActor } from '@agentsws/api'
import type {
  ChatMessage,
  Clock,
  EventEnvelope,
  Matter,
  RunEvent,
  RunRequest,
} from '@agentsws/contracts'
import type { SubscriptionLoginHandle } from '@agentsws/dsh-adapter'
import { webBrief } from '@agentsws/dsh-adapter'
import { createModelGateway, stubProvider } from '@agentsws/model-gateway'
import type { RoleStore } from '@agentsws/roles'
import type { Work } from '@agentsws/work'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chatModelRefOf, createModels } from '../src/models.js'
import { createRuntime, type RuntimeOptions } from '../src/runtime.js'
import { createSecretStore, SECRETS_KEY_ENV, type SecretStore } from '../src/secret-store.js'
import { createSubscription, subscriptionSecretId } from '../src/subscription.js'
import type { SubscriptionModelPort } from '../src/subscription-model.js'

vi.setConfig({ testTimeout: 120_000 })

const clock: Clock = { now: () => '2026-10-16T10:00:00.000Z' }
const TOKEN = 'ACCESS-TOKEN-NEVER-LEAVES-PI-AI'
const CATALOG = [
  { id: 'gpt-5.3-codex-spark', name: 'GPT-5.3 Codex Spark', vision: false },
  { id: 'gpt-5.5', name: 'GPT-5.5', vision: true },
  { id: 'gpt-6-sol', name: 'GPT-6 Sol', vision: true },
]

const stores: SecretStore[] = []
afterEach(() => {
  for (const s of stores.splice(0)) s.close()
})
function secretStore(): SecretStore {
  const s = createSecretStore({
    dbPath: ':memory:',
    clock,
    env: { [SECRETS_KEY_ENV]: randomBytes(32).toString('hex') },
  })
  stores.push(s)
  return s
}

interface FakePort extends SubscriptionModelPort {
  signed: boolean
  fail: 'sign_in' | 'expired' | 'rate_limited' | undefined
  calls: {
    person: string | undefined
    model: string
    messages: ChatMessage[]
    effort?: string | undefined
  }[]
}

function fakePort(): FakePort {
  const port: FakePort = {
    signed: true,
    fail: undefined,
    calls: [],
    signedIn: () => port.signed,
    catalog: () => (port.signed ? CATALOG : []),
    async complete(person, _provider, request) {
      port.calls.push({
        person,
        model: request.model,
        messages: request.messages,
        effort: request.reasoning_effort,
      })
      if (port.fail !== undefined)
        throw Object.assign(new Error(`upstream said 401 (${port.fail})`), {
          name: 'SubscriptionChatError',
          kind: port.fail,
        })
      request.on_delta?.('好的，')
      return {
        text: '好的，我先看看这单的物流。',
        usage: { input_tokens: 30, output_tokens: 12, cached_tokens: 0 },
        model: request.model,
      }
    },
  }
  return port
}

function modelsWith(port: FakePort) {
  const events: unknown[] = []
  const gateway = createModelGateway({
    providers: [stubProvider({ seed: 7 })],
    policy: { default: { provider: 'stub', model: 'stub' }, prices: {} },
    clock,
    eventSink: (e) => events.push(e),
    env: {},
  })
  const models = createModels({
    clock,
    gateway,
    secrets: secretStore(),
    env: {},
    subscription: port,
  })
  return { gateway, models, events }
}

const owner: ModelsActor = {
  workspace_id: 'ws_1',
  person_id: 'per_1',
  assignment_id: 'asg_1',
  role_id: 'owner',
}

describe('WP362 (a) 模型面：订阅进下拉、能设默认、花费 0', () => {
  it('没登录：两处清单里都没有订阅', async () => {
    const port = fakePort()
    port.signed = false
    const { models } = modelsWith(port)
    const view = await models.port.defaults(owner)
    expect(view.choices.some((c) => c.id.startsWith('openai-codex/'))).toBe(false)
    expect(models.chatChoices().some((c) => c.id.startsWith('openai-codex/'))).toBe(false)
    expect(models.configured()).toBe(false)
  })

  it('登录后：默认模型下拉与 AI 钮清单里都有，标「ChatGPT 订阅」，订阅目录里每个都能选', async () => {
    const { models } = modelsWith(fakePort())
    const view = await models.port.defaults(owner)
    expect(view.choices).toContainEqual({
      id: 'openai-codex/gpt-5.5',
      // WP370：设置里的下拉与 AI 钮同一份数据，显示目录里的名字
      label: 'ChatGPT 订阅（GPT-5.5）',
    })
    // WP479 + 决策 1626（B）：选择器只列勾上的；停在 5.x 的 Codex Spark 首次不勾（默认的 5.5 照勾）
    expect(view.choices.filter((c) => c.id.startsWith('openai-codex/'))).toHaveLength(2)
    const chat = models.chatChoices().filter((c) => c.id.startsWith('openai-codex/'))
    expect(chat.map((c) => c.id)).toEqual(['openai-codex/gpt-5.5', 'openai-codex/gpt-6-sol'])
    expect(chat[0]).toMatchObject({ label: 'ChatGPT 订阅', official: false, vision: 'ok' })
    expect(chat[1]).toMatchObject({ vision: 'ok' })
    // 没勾的照样在设置的勾选清单里，能勾上
    const enable = await models.port.enabledModels?.(owner)
    const sub = enable?.sources.find((x) => x.provider_id === 'openai-codex')
    expect(sub?.models.map((m) => m.id)).toEqual(CATALOG.map((m) => m.id))
    expect(sub?.models.find((m) => m.id === 'gpt-5.3-codex-spark')).toMatchObject({
      enabled: false,
      vision: 'no',
    })
    expect(models.configured()).toBe(true)
    // 不是存下来的来源：「已配的」列表与设置快照里都没有（复制品牌不带走别人的订阅）
    expect((await models.port.providers(owner)).some((p) => p.id === 'openai-codex')).toBe(false)
    expect(JSON.stringify(models.exportSettings())).not.toContain('openai-codex')
  })

  it('设成默认 → 运行用的就是它；网关那一跳交给订阅、带上人、花费记 0', async () => {
    const port = fakePort()
    const { models, gateway, events } = modelsWith(port)
    await models.port.setDefaults(owner, { default: 'openai-codex/gpt-5.5' })
    expect(models.defaultRef()).toEqual({
      provider: 'openai-codex',
      model: 'gpt-5.5',
      region: 'global',
    })
    const done = await gateway.complete({
      messages: [{ role: 'user', content: '你好' }],
      meta: {
        workspace_id: 'ws_1',
        assignment_id: 'asg_1',
        role_id: 'owner',
        run_id: 'run_1',
        purpose: 'run',
        person_id: 'per_1',
      },
    })
    expect(done.text).toBe('好的，我先看看这单的物流。')
    expect(done.model).toMatchObject({ provider: 'openai-codex', model: 'gpt-5.5' })
    expect(done.usage.cost_base).toBe(0)
    expect(port.calls[0]).toMatchObject({ person: 'per_1', model: 'gpt-5.5' })
    // 选同一家的另一个模型也真用它（订阅目录全挂上了）
    await gateway.complete({
      model: { provider: 'openai-codex', model: 'gpt-6-sol' },
      messages: [{ role: 'user', content: '你好' }],
      meta: {
        workspace_id: 'ws_1',
        assignment_id: 'a',
        role_id: 'r',
        run_id: 'run_2',
        purpose: 'run',
      },
    })
    expect(port.calls[1]?.model).toBe('gpt-6-sol')
    expect(JSON.stringify(events)).not.toContain(TOKEN)
  })
})

describe('WP370 订阅那一组：目录名、自带联网、每个模型的思考程度', () => {
  it('AI 钮清单：订阅每个模型带目录名、自带联网；声明了档的带三档白话；选的档经网关交到订阅', async () => {
    const port = fakePort()
    const withEfforts = CATALOG.map((m) =>
      m.id === 'gpt-5.5'
        ? {
            ...m,
            efforts: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const,
            context_window: 272_000,
          }
        : m,
    )
    port.catalog = () =>
      withEfforts.map((m) => ({ ...m, ...('efforts' in m ? { efforts: [...m.efforts] } : {}) }))
    const { models, gateway } = modelsWith(port)
    const chat = models.chatChoices().filter((c) => c.id.startsWith('openai-codex/'))
    // WP479 + 决策 1626（B）：只列勾上的（Codex Spark 停在 5.x，首次不勾）
    expect(chat.map((c) => c.name)).toEqual(['GPT-5.5', 'GPT-6 Sol'])
    expect(chat.every((c) => c.native_search === true)).toBe(true)
    const gpt55 = chat.find((c) => c.id === 'openai-codex/gpt-5.5')
    expect(gpt55?.context_window).toBe(272_000)
    expect(gpt55?.thinking?.options.map((o) => `${o.level}:${o.effort}`)).toEqual([
      'fast:low',
      'standard:medium',
      'deep:high',
    ])
    // 目录里没声明档的不出思考那一行
    expect(chat.find((c) => c.id === 'openai-codex/gpt-6-sol')?.thinking).toBeUndefined()
    await gateway.complete({
      model: { provider: 'openai-codex', model: 'gpt-5.5' },
      reasoning_effort: 'high',
      messages: [{ role: 'user', content: '你好' }],
      meta: {
        workspace_id: 'ws_1',
        assignment_id: 'a',
        role_id: 'r',
        run_id: 'run_3',
        purpose: 'run',
      },
    })
    expect(port.calls.at(-1)).toMatchObject({ model: 'gpt-5.5', effort: 'high' })
  })
})

describe('WP362 (b) 没跑成说人话，不悄悄换一家', () => {
  for (const [kind, code] of [
    ['sign_in', 'unauthenticated'],
    ['expired', 'unauthenticated'],
    ['rate_limited', 'rate_limited'],
  ] as const) {
    it(`${kind} → ${code}`, async () => {
      const port = fakePort()
      const { models, gateway } = modelsWith(port)
      await models.port.setDefaults(owner, { default: 'openai-codex/gpt-5.5' })
      port.fail = kind
      const err = await gateway
        .complete({
          messages: [{ role: 'user', content: 'x' }],
          meta: {
            workspace_id: 'ws_1',
            assignment_id: 'a',
            role_id: 'r',
            run_id: 'r1',
            purpose: 'run',
          },
        })
        .catch((e: unknown) => e)
      expect(err).toMatchObject({ code })
      expect(String((err as Error).message)).toContain('ChatGPT 订阅')
      expect(port.calls).toHaveLength(1)
    })
  }
})

describe('WP362 (c) 订阅装配：只看本机库、按人取、公司档没有', () => {
  const loginWith = (complete: SubscriptionLoginHandle['complete']) => async () =>
    ({
      status: async (provider: string) => ({ provider, signed_in: true }),
      models: async () => [],
      begin: async () => 'authorized' as const,
      cancel() {},
      signOut: async () => {},
      complete,
      dispose: async () => {},
    }) as unknown as SubscriptionLoginHandle

  it('点了名只认那个人自己的（别人的不借）；没点名且只有一个人登录过 → 用那个人的；没人登录 → sign_in', async () => {
    const secrets = secretStore()
    const used: string[] = []
    const sub = createSubscription({
      clock,
      secrets,
      runtimeMode: () => 'local',
      catalog: async () => CATALOG,
      createLogin: loginWith(async (_p, r) => ({
        text: 'ok',
        usage: { input_tokens: 1, output_tokens: 1, cached_tokens: 0 },
        model: r.model,
      })),
    })
    expect(sub.signedIn('openai-codex')).toBe(false)
    await expect(
      sub.complete('per_1', 'openai-codex', { model: 'gpt-5.5', messages: [] }),
    ).rejects.toMatchObject({ kind: 'sign_in' })
    secrets.put(subscriptionSecretId('per_owner', 'openai-codex'), { record: '{"type":"oauth"}' })
    expect(sub.signedIn('openai-codex')).toBe(true)
    expect(sub.signedIn('anthropic')).toBe(false)
    await expect(
      sub.complete('per_other', 'openai-codex', { model: 'gpt-5.5', messages: [] }),
    ).rejects.toMatchObject({ kind: 'sign_in' })
    used.push(
      (await sub.complete('per_owner', 'openai-codex', { model: 'gpt-5.5', messages: [] })).model,
    )
    const got = await sub.complete(undefined, 'openai-codex', { model: 'gpt-5.5', messages: [] })
    used.push(got.model)
    expect(used).toEqual(['gpt-5.5', 'gpt-5.5'])
    // 目录：第一次问时还没读进来（空），读进来之后就有
    sub.catalog('openai-codex')
    await new Promise((r) => setTimeout(r, 10))
    expect(sub.catalog('openai-codex').map((m) => m.id)).toContain('gpt-5.5')
    await sub.close()
  })

  it('公司档 / 托管档：有记录也当没有', async () => {
    const secrets = secretStore()
    secrets.put(subscriptionSecretId('per_owner', 'openai-codex'), { record: '{"type":"oauth"}' })
    const sub = createSubscription({
      clock,
      secrets,
      runtimeMode: () => 'docker',
      catalog: async () => CATALOG,
    })
    expect(sub.signedIn('openai-codex')).toBe(false)
    expect(sub.catalog('openai-codex')).toEqual([])
    await expect(
      sub.complete('per_owner', 'openai-codex', { model: 'gpt-5.5', messages: [] }),
    ).rejects.toMatchObject({ kind: 'sign_in' })
    await sub.close()
  })
})

// ── (d) 三个运行时 ─────────────────────────────────────────────────────

const roles = {
  effectiveConfig: () => ({ role_id: 'dtc.support', grounding: [], skills: [], browser_scope: [] }),
  assignments: { get: () => undefined },
} as unknown as RoleStore

const matter = (id: string, model?: string): Matter =>
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

/** `pinned` = 这件事在输入框的 AI 钮上选了哪个（WP342）；不给 = 跟品牌默认走。 */
async function runOnce(mode: Mode, port: FakePort, pinned?: string) {
  const { models, gateway } = modelsWith(port)
  await models.port.setDefaults(owner, { default: 'openai-codex/gpt-5.5' })
  const events: Omit<EventEnvelope, 'id' | 'at'>[] = []
  const needs: unknown[] = []
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
    setupCards: {
      onRunBlocked: async (x: { needs: unknown[] }) => {
        needs.push(...x.needs)
        return undefined
      },
    },
    ...(mode === 'dsh' ? { dshAllRuns: true, dshMode: 'in-process' as const } : {}),
  } as unknown as RuntimeOptions)
  runtime.bind({
    appendEvent: () => undefined,
    onRunCompleted: () => undefined,
    onCard: () => undefined,
  } as unknown as Work)
  await runtime.startRun({
    matter: matter(`mat_${mode}`, pinned),
    brief: '客户问退货进度',
    actor: { person_id: 'per_1', assignment_id: 'asg_1' },
  } as Parameters<typeof runtime.startRun>[0])
  const started = events
    .filter((e) => e.type === 'run.started')
    .map((e) => ({ type: e.type, ...(e.payload as object) }) as RunEvent)[0]
  return { started, events, needs }
}

describe('WP362 (d) 三个运行时都能用订阅跑', () => {
  for (const mode of ['stub', 'direct', 'dsh'] as const) {
    it(`${mode}：运行记录里来源是订阅；真的经订阅那一跳、带上人；事件里没有令牌`, async () => {
      const port = fakePort()
      // stub 档本来就不问模型：只有在 AI 钮上选了它，运行记录里才记它（WP342 的规矩）
      const { started, events } = await runOnce(
        mode,
        port,
        mode === 'stub' ? 'openai-codex/gpt-5.5' : undefined,
      )
      expect(started && 'model' in started ? started.model : undefined).toMatchObject({
        provider: 'openai-codex',
        model: 'gpt-5.5',
      })
      if (mode !== 'stub') {
        expect(port.calls.length).toBeGreaterThan(0)
        for (const c of port.calls) expect(c).toMatchObject({ person: 'per_1', model: 'gpt-5.5' })
      }
      expect(JSON.stringify(events)).not.toContain(TOKEN)
    })
  }

  it('direct：输入框 AI 钮选了订阅里另一个模型 → 每次补全都用它', async () => {
    const port = fakePort()
    const { started } = await runOnce('direct', port, 'openai-codex/gpt-6-sol')
    expect(started && 'model' in started ? started.model : undefined).toMatchObject({
      provider: 'openai-codex',
      model: 'gpt-6-sol',
    })
    for (const c of port.calls) expect(c.model).toBe('gpt-6-sol')
  })

  for (const mode of ['direct', 'dsh'] as const) {
    for (const kind of ['expired', 'rate_limited'] as const) {
      it(`${mode}：${kind} → 没跑成、出「ChatGPT 订阅」连接卡`, async () => {
        const port = fakePort()
        port.fail = kind
        const { needs, events } = await runOnce(mode, port)
        expect(events.some((e) => e.type === 'run.failed' || e.type === 'run.completed')).toBe(true)
        expect(needs).toContainEqual(
          expect.objectContaining({ service: 'chatgpt_subscription', name: 'ChatGPT 订阅' }),
        )
      })
    }
  }
})

describe('WP362 (e) WP355 收尾：系统提示「网页」那段对订阅的运行说实话', () => {
  const request = (provider: string) =>
    ({
      runtime: { model: { provider, model: 'm' } },
      tools: { allow: ['web_search', 'web_fetch'] },
      web: { search: true, fetch: true, max_searches: 5, max_fetches: 3 },
    }) as unknown as RunRequest
  it('订阅的运行：先用 ChatGPT 自带搜索；别的来源照旧是内置浏览器', () => {
    expect(webBrief(request('openai-codex'))).toContain('ChatGPT 订阅自带的联网搜索')
    expect(webBrief(request('deepseek'))).toContain('内置浏览器里打开一次搜索页')
    expect(webBrief(request('deepseek'))).not.toContain('ChatGPT')
  })
})
