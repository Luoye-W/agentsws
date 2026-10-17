/**
 * WP377（决策 1026 → 1051）：工坊积分的模型按**云端价目**那一行的 `reasoning` 出思考小钮（WP373 那个），
 * 没写就不出；选了档，打云端的请求体里原样带 `reasoning_effort`（决策 1032「显示什么就发什么」）。
 *
 * 不联网：云端是假 fetch，价目是替身样本加两行 `reasoning`。
 */
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Clock, PricingCatalog, PricingModelEntry } from '@agentsws/contracts'
import { createModelGateway, type FetchLike, stubProvider } from '@agentsws/model-gateway'
import { SAMPLE_PRICING_CATALOG } from '@agentsws/stand-ins'
import { afterEach, describe, expect, it } from 'vitest'
import { CLOUD_TOKEN_SECRET_ID, createModels } from '../src/models.js'
import { createSecretStore, SECRETS_KEY_ENV, type SecretStore } from '../src/secret-store.js'

const clock: Clock = { now: () => '2026-10-17T10:00:00.000Z' }
const dirs: string[] = []
const stores: SecretStore[] = []
afterEach(() => {
  for (const s of stores.splice(0)) s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const DECLARED: Record<string, PricingModelEntry['reasoning']> = {
  'deepseek-v4-pro': {
    efforts: ['off', 'high', 'max'],
    default: 'high',
    levels: { fast: 'off', standard: 'high', deep: 'max' },
  },
  'deepseek-flash': { efforts: ['off', 'low', 'high', 'max'], default: 'high' },
}

/** 替身价目：DeepSeek 两个模型写上思考档，别的照旧（没写）。 */
function catalogWithReasoning(): PricingCatalog {
  const base = SAMPLE_PRICING_CATALOG
  return {
    ...base,
    pricing: {
      ...base.pricing,
      entries: base.pricing.entries.map((e) =>
        e.capability !== 'ai.chat' || e.models === undefined
          ? e
          : {
              ...e,
              models: e.models.map((m) => {
                const reasoning = DECLARED[m.model]
                return reasoning === undefined ? m : { ...m, reasoning }
              }),
            },
      ),
    },
  }
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'agentsws-wp377-'))
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
          base_url: 'https://cloud.example.invalid/v1/ai',
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
  const bodies: Record<string, unknown>[] = []
  const fetch: FetchLike = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    const sse = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: '好' } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } })}`,
      'data: [DONE]',
      '',
    ].join('\n\n')
    const json = {
      choices: [{ message: { role: 'assistant', content: '好' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 1 },
    }
    return {
      ok: true,
      status: 200,
      json: async () => json,
      text: async () => sse,
    }
  }
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
    fetch,
    pricing: { creditsFor: () => undefined, current: () => catalogWithReasoning() },
  })
  return { models, gateway, bodies }
}

describe('WP377 工坊积分的思考小钮', () => {
  it('价目写了档的出：v4 Pro 照云端写明的三档（快 = 关掉思考，决策 1054），Flash 按老规矩三档；没写的不出', () => {
    const { models } = setup()
    const choices = models.chatChoices()
    expect(choices.find((c) => c.id === 'agentsws/deepseek-v4-pro')?.thinking).toEqual({
      options: [
        { level: 'fast', effort: 'off' },
        { level: 'standard', effort: 'high' },
        { level: 'deep', effort: 'max' },
      ],
      default: 'high',
    })
    expect(choices.find((c) => c.id === 'agentsws/deepseek-flash')?.thinking).toEqual({
      options: [
        { level: 'fast', effort: 'low' },
        { level: 'standard', effort: 'high' },
        { level: 'deep', effort: 'max' },
      ],
      default: 'high',
    })
    expect(choices.find((c) => c.id === 'agentsws/glm-5.3')?.thinking).toBeUndefined()
  })

  it('选了「深度」：打云端的请求体里带 reasoning_effort = max；没选一格不多', async () => {
    const { gateway, bodies } = setup()
    const meta = {
      workspace_id: 'ws_1',
      assignment_id: 'asg_1',
      role_id: 'role_1',
      run_id: 'run_1',
      purpose: 'run' as const,
    }
    const model = { provider: 'agentsws', model: 'deepseek-v4-pro' }
    await gateway.complete({
      messages: [{ role: 'user', content: '在吗' }],
      meta,
      model,
      reasoning_effort: 'max',
    })
    await gateway.complete({ messages: [{ role: 'user', content: '在吗' }], meta, model })
    // 决策 1054：v4 Pro 的「快」= off，原样发 off（云端翻成 thinking disabled）
    await gateway.complete({
      messages: [{ role: 'user', content: '在吗' }],
      meta,
      model,
      reasoning_effort: 'off',
    })
    expect(bodies).toHaveLength(3)
    expect(bodies[0]?.model).toBe('deepseek-v4-pro')
    expect(bodies[0]?.reasoning_effort).toBe('max')
    expect(bodies[1]).not.toHaveProperty('reasoning_effort')
    expect(bodies[2]?.reasoning_effort).toBe('off')
  })
})

describe('WP377 写明三档（决策 1054）', () => {
  it('照写明的出、缺的那档不出、不到两档不出、默认 = 写明的标准', async () => {
    const { thinkingOptionsFromLevels } = await import('../src/model-thinking.js')
    expect(thinkingOptionsFromLevels({ standard: 'high', deep: 'max' }, 'high')).toEqual({
      options: [
        { level: 'standard', effort: 'high' },
        { level: 'deep', effort: 'max' },
      ],
      default: 'high',
    })
    expect(thinkingOptionsFromLevels({ standard: 'high' })).toBeUndefined()
    expect(thinkingOptionsFromLevels({ fast: 'off', deep: 'max' }, 'max')).toEqual({
      options: [
        { level: 'fast', effort: 'off' },
        { level: 'deep', effort: 'max' },
      ],
      default: 'max',
    })
  })
})
