/**
 * WP362（Luoye 10-16）：输入框 AI 钮——按来源分组、每行的消耗速率。
 *
 * - 价目带了 `consumption_rate` 就照它；没带按官方原价相对 DeepSeek v4 Pro 折算；价为 0 是限免；
 * - 价目里没有 DeepSeek v4 Pro → 退回默认模型 = 1x，并标 `fallback`；
 * - 模型面：工坊积分那一组列出云端价目里的每个模型（都挂上网关、都能选），订阅那组「订阅额度」，自己接的「用你自己的 key」。
 */

import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Clock, PricingCatalog, PricingModelEntry } from '@agentsws/contracts'
import { createModelGateway, stubProvider } from '@agentsws/model-gateway'
import { SAMPLE_PRICING_CATALOG } from '@agentsws/stand-ins'
import { afterEach, describe, expect, it } from 'vitest'
import { cloudRates, formatRate, vendorOfModel } from '../src/model-rates.js'
import { CLOUD_TOKEN_SECRET_ID, chatModelRefOf, createModels } from '../src/models.js'
import { createSecretStore, SECRETS_KEY_ENV, type SecretStore } from '../src/secret-store.js'

const clock: Clock = { now: () => '2026-10-16T10:00:00.000Z' }
const dirs: string[] = []
const stores: SecretStore[] = []
afterEach(() => {
  for (const s of stores.splice(0)) s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const row = (
  model: string,
  input: number,
  out: number,
  extra: Partial<PricingModelEntry> = {},
) => ({
  model,
  in: input,
  out,
  ...extra,
})

describe('消耗速率怎么算', () => {
  it('带了 consumption_rate 照它；没带按官方原价相对 DeepSeek v4 Pro 折算；价为 0 是限免；同名取第一条非 0', () => {
    const rates = cloudRates(
      [
        row('deepseek-v4-pro', 0, 0),
        row('deepseek-v4-pro', 0.04, 0.08),
        row('glm-5', 0.08, 0.16),
        row('kimi-k3', 0.01, 0.01, { consumption_rate: 2.3, rate_source: 'stats' }),
        row('deepseek-v4-flash-0731', 0, 0),
      ],
      'glm-5',
    )
    expect(rates.base).toEqual({ model: 'deepseek-v4-pro', fallback: false })
    expect(rates.models).toEqual(['deepseek-v4-pro', 'glm-5', 'kimi-k3', 'deepseek-v4-flash-0731'])
    expect(rates.price('deepseek-v4-pro')).toEqual({ kind: 'rate', rate: 1, source: 'list_price' })
    expect(rates.price('glm-5')).toEqual({ kind: 'rate', rate: 2, source: 'list_price' })
    expect(rates.price('kimi-k3')).toEqual({ kind: 'rate', rate: 2.3, source: 'stats' })
    expect(rates.price('deepseek-v4-flash-0731')).toEqual({ kind: 'free' })
    expect(rates.price('no-such')).toBeUndefined()
  })

  it('价目里没有 DeepSeek v4 Pro（名字对不上）→ 退回默认模型 = 1x，标 fallback；都没有就不给倍率', () => {
    const rates = cloudRates(
      [row('deepseek-v4-pro-0813', 0.04, 0.08), row('qwen-max', 0.02, 0.06)],
      'qwen-max',
    )
    expect(rates.base).toEqual({ model: 'qwen-max', fallback: true })
    expect(rates.price('qwen-max')).toMatchObject({ rate: 1 })
    const none = cloudRates([row('qwen-max', 0.02, 0.06)], undefined)
    expect(none.base).toBeUndefined()
    expect(none.price('qwen-max')).toBeUndefined()
  })

  it('显示：1.0x / 2.3x / 0.27x / 12x；厂商认得出常见那几家', () => {
    expect(formatRate(1)).toBe('1.0x')
    expect(formatRate(2.34)).toBe('2.3x')
    expect(formatRate(0.0712)).toBe('0.07x')
    expect(formatRate(12.4)).toBe('12x')
    expect(vendorOfModel('gpt-5.5')).toBe('openai')
    expect(vendorOfModel('deepseek-flash')).toBe('deepseek')
    expect(vendorOfModel('qwen3.8-max')).toBe('qwen')
    expect(vendorOfModel('glm-5.3')).toBe('zhipu')
    expect(vendorOfModel('kimi-k3')).toBe('moonshot')
    expect(vendorOfModel('MiniMax-M2.5')).toBe('minimax')
    expect(vendorOfModel('mystery')).toBeUndefined()
  })
})

describe('模型面：AI 钮按来源分组', () => {
  function secretStore(): SecretStore {
    const s = createSecretStore({
      dbPath: ':memory:',
      clock,
      env: { [SECRETS_KEY_ENV]: randomBytes(32).toString('hex') },
    })
    stores.push(s)
    return s
  }

  it('工坊积分那组列出价目里每个模型（都能选、都挂上）；订阅「订阅额度」；自己接的「用你自己的 key」；组的顺序固定', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentsws-wp362-'))
    dirs.push(dir)
    writeFileSync(
      join(dir, 'models.json'),
      JSON.stringify({
        version: 1,
        providers: [
          {
            id: 'mine',
            kind: 'openai_compatible',
            label: 'OpenAI（我的 key）',
            base_url: 'https://api.openai.com/v1',
            model: 'gpt-4o-mini',
            region: 'global',
          },
          {
            id: 'agentsws',
            kind: 'agentsws_cloud',
            label: 'Agents 工坊（用积分）',
            base_url: 'https://cloud.example.invalid/v1',
            model: 'deepseek-flash',
            region: 'global',
          },
        ],
        defaults: { default: 'agentsws/deepseek-flash' },
        tests: {},
      }),
    )
    const secrets = secretStore()
    secrets.put(CLOUD_TOKEN_SECRET_ID, { token: 'ws-token-for-test' })
    secrets.put('model_provider:mine', { api_key: 'sk-test-not-real' })
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
      env: {},
      dbDir: dir,
      pricing: {
        creditsFor: () => undefined,
        current: () => SAMPLE_PRICING_CATALOG as PricingCatalog,
      },
      subscription: {
        signedIn: () => true,
        catalog: () => [{ id: 'gpt-5.5', name: 'GPT-5.5', vision: true }],
        complete: async () => {
          throw new Error('not used')
        },
      },
    })
    const choices = models.chatChoices()
    expect([...new Set(choices.map((c) => c.group))]).toEqual(['workshop', 'subscription', 'own'])
    const workshop = choices.filter((c) => c.group === 'workshop')
    expect(workshop.length).toBeGreaterThan(30)
    expect(workshop.find((c) => c.id === 'agentsws/deepseek-v4-pro')?.price).toEqual({
      kind: 'rate',
      rate: 1,
      source: 'stats',
    })
    expect(workshop.find((c) => c.id === 'agentsws/gpt-4o')?.price).toMatchObject({
      kind: 'rate',
      source: 'list_price',
    })
    expect(workshop.find((c) => c.id === 'agentsws/qwen3.8-max')?.vendor).toBe('qwen')
    expect(choices.find((c) => c.id === 'openai-codex/gpt-5.5')?.price).toEqual({
      kind: 'subscription',
    })
    expect(choices.find((c) => c.id === 'mine/gpt-4o-mini')?.price).toEqual({ kind: 'own_key' })
    expect(models.rateBase?.()).toEqual({ model: 'deepseek-v4-pro', fallback: false })
    // 价目里的任何一个都能选成这件事的 AI（WP342 的 `chatModelRefOf` 认它）
    expect(chatModelRefOf(models, 'agentsws/gpt-4o')).toEqual({
      provider: 'agentsws',
      model: 'gpt-4o',
    })
    // 没有一个 key 进了清单
    expect(JSON.stringify(choices)).not.toContain('sk-test-not-real')
  })
})
