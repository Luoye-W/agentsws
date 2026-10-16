/**
 * WP363（决策 954）：价目条目加一格可选 `discount`（0.1 = 一折）。
 *
 * - 只认 `0 < d < 1`（`pricingDiscountOf`），别的一律当没有；
 * - AI 钮那一格：倍率照旧（原价口径），旁边多带 `discount`；限免不带；没有就不给这一格；
 * - 本机估价（`chatCredits`）按折后估，与云上结算一个判法；
 * - 模型面：云替身样例价目里 `kimi-k3` 带的示意一折传到 AI 钮的清单里。
 */

import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type Clock,
  type PricingCatalog,
  type PricingEntry,
  pricingDiscountOf,
} from '@agentsws/contracts'
import { createModelGateway, stubProvider } from '@agentsws/model-gateway'
import { SAMPLE_PRICING_CATALOG } from '@agentsws/stand-ins'
import { afterEach, describe, expect, it } from 'vitest'
import { chatCredits } from '../src/free-chat.js'
import { cloudRates } from '../src/model-rates.js'
import { CLOUD_TOKEN_SECRET_ID, createModels } from '../src/models.js'
import { createSecretStore, SECRETS_KEY_ENV, type SecretStore } from '../src/secret-store.js'

const clock: Clock = { now: () => '2026-10-16T10:00:00.000Z' }
const dirs: string[] = []
const stores: SecretStore[] = []
afterEach(() => {
  for (const s of stores.splice(0)) s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('折扣怎么认', () => {
  it('只认 0 < d < 1；不给 / 0 / 1 / 越界 / 不是数都当没有', () => {
    expect(pricingDiscountOf({ discount: 0.1 })).toBe(0.1)
    expect(pricingDiscountOf({ discount: 0.85 })).toBe(0.85)
    expect(pricingDiscountOf({})).toBeUndefined()
    for (const bad of [0, 1, 1.2, -0.5, Number.NaN, Number.POSITIVE_INFINITY])
      expect(pricingDiscountOf({ discount: bad })).toBeUndefined()
  })

  it('AI 钮那一格：倍率照旧（原价口径）、旁边带折扣；按原价折算的也带；限免不带；没有就不给', () => {
    const rates = cloudRates(
      [
        { model: 'deepseek-v4-pro', in: 0.04, out: 0.08 },
        {
          model: 'kimi-k3',
          in: 0.06,
          out: 0.3,
          consumption_rate: 1.3,
          rate_source: 'stats',
          discount: 0.1,
        },
        { model: 'glm-5', in: 0.08, out: 0.16, discount: 0.5 },
        { model: 'deepseek-v4-flash-0731', in: 0, out: 0, discount: 0.1 },
        { model: 'qwen-max', in: 0.04, out: 0.08, discount: 1 },
      ],
      undefined,
    )
    expect(rates.price('kimi-k3')).toEqual({
      kind: 'rate',
      rate: 1.3,
      source: 'stats',
      discount: 0.1,
    })
    expect(rates.price('glm-5')).toEqual({
      kind: 'rate',
      rate: 2,
      source: 'list_price',
      discount: 0.5,
    })
    expect(rates.price('deepseek-v4-flash-0731')).toEqual({ kind: 'free' })
    // 1 不是折扣：不给这一格
    expect(rates.price('qwen-max')).toEqual({ kind: 'rate', rate: 1, source: 'list_price' })
    expect(rates.price('deepseek-v4-pro')).toEqual({ kind: 'rate', rate: 1, source: 'list_price' })
  })

  it('本机估价按折后估（与云上结算同一个判法）；没有折扣照原价', () => {
    const pricing = (discount?: number): { entries: PricingEntry[] } => ({
      entries: [
        {
          capability: 'ai.chat',
          unit: '1k_tokens',
          credits_per_unit: 0.05,
          label_zh: '对话',
          label_en: 'Chat',
          models: [
            {
              model: 'kimi-k3',
              in: 0.06,
              out: 0.3,
              ...(discount === undefined ? {} : { discount }),
            },
          ],
        },
      ],
    })
    const usage = { input_tokens: 10_000, output_tokens: 1_000 }
    expect(chatCredits(pricing(), 'kimi-k3', usage)).toBe(0.9)
    expect(chatCredits(pricing(0.1), 'kimi-k3', usage)).toBe(0.09)
    expect(chatCredits(pricing(1.5), 'kimi-k3', usage)).toBe(0.9)
  })
})

describe('模型面：折扣传到 AI 钮的清单', () => {
  it('样例价目里 kimi-k3 的示意一折带到工坊积分那一组；别的没有', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentsws-wp363-'))
    dirs.push(dir)
    writeFileSync(
      join(dir, 'models.json'),
      JSON.stringify({
        version: 1,
        providers: [
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
    const secrets = createSecretStore({
      dbPath: ':memory:',
      clock,
      env: { [SECRETS_KEY_ENV]: randomBytes(32).toString('hex') },
    })
    stores.push(secrets)
    secrets.put(CLOUD_TOKEN_SECRET_ID, { token: 'ws-token-for-test' })
    const models = createModels({
      clock,
      gateway: createModelGateway({
        providers: [stubProvider({ seed: 7 })],
        policy: { default: { provider: 'stub', model: 'stub' }, prices: {} },
        clock,
        eventSink: () => undefined,
        env: {},
      }),
      secrets,
      env: {},
      dbDir: dir,
      pricing: {
        creditsFor: () => undefined,
        current: () => SAMPLE_PRICING_CATALOG as PricingCatalog,
      },
    })
    const choices = models.chatChoices()
    expect(choices.find((c) => c.id === 'agentsws/kimi-k3')?.price).toEqual({
      kind: 'rate',
      rate: 1.3,
      source: 'stats',
      discount: 0.1,
    })
    const discounted = choices.filter((c) => c.price?.kind === 'rate' && 'discount' in c.price)
    expect(discounted.map((c) => c.id)).toEqual(['agentsws/kimi-k3'])
  })
})
