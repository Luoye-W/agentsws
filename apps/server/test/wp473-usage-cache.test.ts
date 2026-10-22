/**
 * WP473（docs/116 §6 D / §3）：用量页看得见命中率、「运行」按功能拆开；订阅带会话标识；
 * 助理那一条官方积分的估数按命中价算。
 *
 * 真 `createModels` + 真网关，上游是 stub（不联网、不花钱）。
 */
import { randomBytes } from 'node:crypto'
import type { ModelsActor } from '@agentsws/api'
import type { Clock, ModelMeta, PricingEntry } from '@agentsws/contracts'
import { createModelGateway, promptCacheKeyOf, stubProvider } from '@agentsws/model-gateway'
import { afterEach, describe, expect, it } from 'vitest'
import { chatCredits } from '../src/free-chat.js'
import { createModels } from '../src/models.js'
import { createSecretStore, SECRETS_KEY_ENV, type SecretStore } from '../src/secret-store.js'
import { type SubscriptionModelPort, subscriptionModelProvider } from '../src/subscription-model.js'

const clock: Clock = { now: () => '2026-10-22T10:00:00.000Z' }
const owner: ModelsActor = {
  workspace_id: 'ws_1',
  person_id: 'per_1',
  assignment_id: 'asg_1',
  role_id: 'owner',
}

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

const call = (
  run_id: string,
  over: Partial<ModelMeta> = {},
): Parameters<ReturnType<typeof modelsWith>['gateway']['complete']>[0] => ({
  messages: [{ role: 'user', content: 'q' }],
  meta: {
    workspace_id: 'ws_1',
    assignment_id: 'asg_1' as never,
    role_id: 'support.aftersales' as never,
    run_id: run_id as never,
    purpose: 'run',
    ...over,
  },
})

describe('WP473 用量页：「运行」按功能拆开，带命中数', () => {
  it('岗位运行 / 客服聊天窗 / 邮件自动回 / SEO 各一行；别的 purpose 不拆', async () => {
    const { gateway, models } = modelsWith()
    await gateway.complete(call('run_k3x9'))
    await gateway.complete(call('run_k3xa'))
    await gateway.complete(call('run_chat_ses_1_1'))
    await gateway.complete(call('run_email_auto_m1_1'))
    await gateway.complete(call('run_seo_c1'))
    await gateway.complete(call('fchat_x', { purpose: 'free_chat' }))
    await gateway.complete(call('run_k3xb', { purpose: 'extraction' }))
    const view = await models.port.usage(owner)
    const byKey = new Map(view.rows.map((r) => [`${r.purpose}:${r.feature ?? ''}`, r]))
    // 装配会把网关换成自己的来源（这里是 stub），数以网关的流水为准
    const records = gateway.records()
    const sumOf = (pick: (r: (typeof records)[number]) => boolean) =>
      records.filter(pick).reduce(
        (a, r) => ({
          calls: a.calls + 1,
          input_tokens: a.input_tokens + r.input_tokens,
          cached_tokens: a.cached_tokens + r.cached_tokens,
        }),
        { calls: 0, input_tokens: 0, cached_tokens: 0 },
      )
    expect(byKey.get('run:position_run')).toMatchObject({
      calls: 2,
      ...sumOf((r) => r.purpose === 'run' && r.feature === 'position_run'),
    })
    expect(byKey.get('run:support_chat')).toMatchObject({ calls: 1 })
    expect(byKey.get('run:email_auto_reply')).toMatchObject({ calls: 1 })
    expect(byKey.get('run:seo')).toMatchObject({ calls: 1 })
    // 助理与抽取各自一行，不带功能
    expect(byKey.get('free_chat:')).toMatchObject({ calls: 1 })
    expect(byKey.get('extraction:')).toMatchObject({ calls: 1 })
    expect(view.rows.filter((r) => r.purpose !== 'run').every((r) => r.feature === undefined)).toBe(
      true,
    )
    // 合计照旧（不带功能）
    expect(view.total).toMatchObject({ calls: 7, ...sumOf(() => true) })
    expect(view.total?.feature).toBeUndefined()
  })
})

describe('WP473 订阅带会话标识（缓存分组键的哈希）', () => {
  it('有 meta 就带 session_id = promptCacheKeyOf(meta)；不含个人信息；没 meta 不带', async () => {
    const sent: (string | undefined)[] = []
    const port: SubscriptionModelPort = {
      signedIn: () => true,
      catalog: () => [{ id: 'gpt-5.5', name: 'GPT-5.5', vision: true }],
      async complete(_person, _provider, request) {
        sent.push(request.session_id)
        return {
          text: '好',
          usage: { input_tokens: 1, output_tokens: 1, cached_tokens: 0 },
          model: request.model,
        } as never
      },
    }
    const provider = subscriptionModelProvider({ port, model: 'gpt-5.5', vision: true })
    const meta: ModelMeta = {
      workspace_id: 'ws_1',
      assignment_id: 'asg_1' as never,
      role_id: 'support.aftersales' as never,
      run_id: 'run_1' as never,
      purpose: 'run',
      person_id: 'per_zhangsan' as never,
      cache_scope: 'assistant_segment:seg_9',
    }
    const messages = [{ role: 'user' as const, content: '在吗' }]
    await provider.complete({ messages, meta })
    await provider.complete({ messages })
    expect(sent[0]).toBe(promptCacheKeyOf(meta))
    expect(sent[0]).toMatch(/^aw_[0-9a-f]{32}$/)
    expect(sent[0]).not.toContain('zhangsan')
    expect(sent[0]).not.toContain('seg_9')
    expect(sent[1]).toBeUndefined()
  })
})

describe('WP473 助理官方积分估数按命中价', () => {
  const pricing: { entries: PricingEntry[] } = {
    entries: [
      {
        capability: 'ai.chat',
        unit: '1k_tokens',
        credits_per_unit: 1,
        models: [{ model: 'deepseek-flash', in: 0.5, out: 2, cached: 0.01 }],
      } as PricingEntry,
    ],
  }

  it('命中部分按 cached 价；没给命中数与以前一样', () => {
    const hit = chatCredits(pricing, 'deepseek-flash', {
      input_tokens: 10_000,
      output_tokens: 1_000,
      cached_tokens: 8_000,
    })
    expect(hit).toBeCloseTo((2_000 * 0.5 + 8_000 * 0.01 + 1_000 * 2) / 1000, 4)
    const none = chatCredits(pricing, 'deepseek-flash', {
      input_tokens: 10_000,
      output_tokens: 1_000,
    })
    expect(none).toBeCloseTo((10_000 * 0.5 + 1_000 * 2) / 1000, 4)
    expect(hit ?? 0).toBeLessThan(none ?? 0)
  })
})
