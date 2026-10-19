/**
 * WP425：自己的 AI 优先，不够 / 连不上再用工坊积分。
 *
 * 装配那一层：登录了工坊账号就有「备用」（没加积分那张卡时是一条虚的），开关默认开；
 * 设置那一处（`ai_source`）与 AI 钮同一份；开关关掉 → 照实停下、错误带「关着」那一格。
 * 不联网：自己的 AI 与云端都是假 fetch。
 */
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Clock } from '@agentsws/contracts'
import {
  createModelGateway,
  type FetchLike,
  sourceFallbackOffOf,
  stubProvider,
} from '@agentsws/model-gateway'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CLOUD_FALLBACK_PROVIDER_ID,
  CLOUD_TOKEN_SECRET_ID,
  createModels,
  MODEL_KEY_PREFIX,
} from '../src/models.js'
import { runFailureText } from '../src/run-failure.js'
import { createSecretStore, SECRETS_KEY_ENV, type SecretStore } from '../src/secret-store.js'
import { MODEL_FALLBACK_CLOUD_TARGET, modelFallbackCloudTarget } from '../src/setup-targets.js'

const clock: Clock = { now: () => '2026-10-19T10:00:00.000Z' }
const dirs: string[] = []
const stores: SecretStore[] = []
afterEach(() => {
  for (const s of stores.splice(0)) s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const OWN_URL = 'https://own.example.invalid/v1'

function setup(opts: { linked: boolean; cloudRow?: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), 'agentsws-wp425-'))
  dirs.push(dir)
  writeFileSync(
    join(dir, 'models.json'),
    JSON.stringify({
      version: 1,
      providers: [
        {
          id: 'own',
          kind: 'openai_compatible',
          label: 'Kimi',
          base_url: OWN_URL,
          model: 'kimi-k3',
          region: 'cn',
        },
        ...(opts.cloudRow === true
          ? [
              {
                id: 'agentsws',
                kind: 'agentsws_cloud',
                label: 'Agents 工坊（用积分）',
                base_url: 'https://cloud.example.invalid/v1/ai',
                model: 'deepseek-pro',
                region: 'global',
              },
            ]
          : []),
      ],
      defaults: { default: 'own/kimi-k3' },
      tests: {},
    }),
  )
  const secrets = createSecretStore({
    dbPath: ':memory:',
    clock,
    env: { [SECRETS_KEY_ENV]: randomBytes(32).toString('hex') },
  })
  stores.push(secrets)
  secrets.put(`${MODEL_KEY_PREFIX}own`, { api_key: 'sk-own-for-test' })
  if (opts.linked) secrets.put(CLOUD_TOKEN_SECRET_ID, { token: 'ws-token-for-test' })
  /** 自己的 AI 接下来回什么（429 / 401 / 200）。 */
  const own = { status: 200 }
  const hits: string[] = []
  const fetch: FetchLike = async (url) => {
    const toOwn = String(url).startsWith(OWN_URL)
    hits.push(toOwn ? 'own' : 'cloud')
    const status = toOwn ? own.status : 200
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
      ok: status < 400,
      status,
      json: async () => json,
      text: async () => (status < 400 ? sse : '{"error":{"message":"nope"}}'),
    }
  }
  const gateway = createModelGateway({
    providers: [stubProvider({ seed: 7 })],
    policy: { default: { provider: 'stub', model: 'stub' }, prices: {} },
    clock,
    eventSink: () => undefined,
    env: {},
  })
  const models = createModels({ clock, gateway, secrets, env: {}, dbDir: dir, fetch })
  return { models, gateway, own, hits }
}

const actor = {
  workspace_id: 'ws_1',
  person_id: 'p_1',
  assignment_id: 'asg_1',
  role_id: 'common.member',
}
const ask = (run_id: string) => ({
  messages: [{ role: 'user' as const, content: '你好' }],
  meta: {
    workspace_id: 'ws_1',
    assignment_id: 'asg_1',
    role_id: 'common.member',
    run_id,
    purpose: 'run' as const,
  },
})

describe('WP425 AI 来源顺序（装配）', () => {
  it('登录了工坊账号：设置那一处列出主用 / 备用，开关默认开', async () => {
    const { models } = setup({ linked: true })
    const view = await models.port.defaults(actor)
    expect(view.ai_source).toEqual({
      // WP430：多了 `ready`（没测过的 key 不会被自动接上）与 `model`
      own: [{ provider_id: 'own', label: 'Kimi', group: 'own', ready: false, model: 'kimi-k3' }],
      backup: { available: true, label: 'Agents 工坊（用积分）', model: 'deepseek-flash' },
      fallback_to_cloud: true,
    })
    expect(models.fallbackCloud()).toEqual({ available: true, on: true })
  })

  it('没登录工坊账号：没有备用，开关画成关着且点不了', async () => {
    const { models } = setup({ linked: false })
    const view = await models.port.defaults(actor)
    expect(view.ai_source?.backup.available).toBe(false)
    expect(view.ai_source?.fallback_to_cloud).toBe(false)
  })

  it('自己的额度用完（429）→ 这一轮用工坊积分；同一轮不来回切；下一轮回到自己的', async () => {
    const { gateway, own, hits } = setup({ linked: true })
    own.status = 429
    const first = await gateway.complete(ask('run_a'))
    expect(first.model.provider).toBe(CLOUD_FALLBACK_PROVIDER_ID)
    expect(first.source_switch?.message).toBe('你的 Kimi 额度用完了，这一轮用工坊积分')
    own.status = 200
    const again = await gateway.complete(ask('run_a'))
    expect(again.model.provider).toBe(CLOUD_FALLBACK_PROVIDER_ID)
    expect(again.source_switch).toBeUndefined()
    const next = await gateway.complete(ask('run_b'))
    expect(next.model.provider).toBe('own')
    expect(hits).toEqual(['own', 'cloud', 'cloud', 'own'])
  })

  it('加了积分那张卡：备用就是那一条（同一个模型）', async () => {
    const { gateway, own } = setup({ linked: true, cloudRow: true })
    own.status = 401
    const out = await gateway.complete(ask('run_a'))
    expect(out.model).toMatchObject({ provider: 'agentsws', model: 'deepseek-pro' })
    expect(out.source_switch?.reason).toBe('auth')
  })

  it('开关关掉：照实停下，那一句在运行失败处原样给人看；配置卡点一下打开开关', async () => {
    const { models, gateway, own, hits } = setup({ linked: true })
    await models.port.setDefaults(actor, { fallback_to_cloud: false })
    expect(models.fallbackCloud()).toEqual({ available: true, on: false })
    own.status = 429
    const err = await gateway.complete(ask('run_a')).catch((e: unknown) => e)
    expect(sourceFallbackOffOf(err)).toMatchObject({ state: 'off', reason: 'quota' })
    const message = (err as Error).message
    expect(runFailureText({ code: 'provider_unavailable', message })).toBe(message)
    expect(hits).toEqual(['own'])

    const target = modelFallbackCloudTarget(async () => models)
    expect(target.id).toBe(MODEL_FALLBACK_CLOUD_TARGET)
    expect(await target.satisfied()).toBe(false)
    const [field] = await target.fields()
    expect(field).toMatchObject({ kind: 'toggle', suggested: 'true' })
    await target.apply({ fallback_to_cloud: 'true' })
    expect(await target.satisfied()).toBe(true)
    const after = await gateway.complete(ask('run_b'))
    expect(after.model.provider).toBe(CLOUD_FALLBACK_PROVIDER_ID)
  })

  it('没登录工坊账号：老样子原样报错（不出「关着」那一格）', async () => {
    const { gateway, own } = setup({ linked: false })
    own.status = 429
    const err = await gateway.complete(ask('run_a')).catch((e: unknown) => e)
    expect((err as { code?: string }).code).toBe('provider_unavailable')
    expect(sourceFallbackOffOf(err)).toBeUndefined()
  })
})
