/**
 * WP430（决策 1288–1290）：AI 来源顺序补齐（装配那一层）。
 *
 * 这次选的 → 自己配的其它（按「AI 来源」里排的顺序，只算真能跑活的）→ 工坊积分（开关开着才有）。
 * 排序存在品牌模型设置里（`source_order`），设置那一处（`ai_source.own`）按同一个顺序列、标出哪条会被自动接上。
 * 不联网：几家 AI 与云端都是假 fetch。
 */
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Clock } from '@agentsws/contracts'
import { createModelGateway, type FetchLike, stubProvider } from '@agentsws/model-gateway'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CLOUD_FALLBACK_PROVIDER_ID,
  CLOUD_TOKEN_SECRET_ID,
  createModels,
  MODEL_KEY_PREFIX,
} from '../src/models.js'
import { createSecretStore, SECRETS_KEY_ENV, type SecretStore } from '../src/secret-store.js'

const clock: Clock = { now: () => '2026-10-19T10:00:00.000Z' }
const dirs: string[] = []
const stores: SecretStore[] = []
afterEach(() => {
  for (const s of stores.splice(0)) s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const URLS = {
  kimi: 'https://kimi.example.invalid/v1',
  ds: 'https://ds.example.invalid/v1',
  glm: 'https://glm.example.invalid/v1',
} as const
type Who = keyof typeof URLS

const passed = { ok: true, checked_at: '2026-10-19T09:00:00.000Z' }

function setup(opts: { linked: boolean; tested?: Who[]; tests?: Record<string, unknown> }) {
  const dir = mkdtempSync(join(tmpdir(), 'agentsws-wp430-'))
  dirs.push(dir)
  const tested = opts.tested ?? ['ds', 'glm']
  writeFileSync(
    join(dir, 'models.json'),
    JSON.stringify({
      version: 1,
      providers: [
        {
          id: 'kimi',
          kind: 'openai_compatible',
          label: 'Kimi',
          base_url: URLS.kimi,
          model: 'kimi-k3',
          region: 'cn',
        },
        {
          id: 'ds',
          kind: 'openai_compatible',
          label: 'DeepSeek',
          base_url: URLS.ds,
          model: 'deepseek-chat',
          region: 'cn',
        },
        {
          id: 'glm',
          kind: 'openai_compatible',
          label: 'GLM',
          base_url: URLS.glm,
          model: 'glm-5',
          region: 'cn',
        },
      ],
      defaults: { default: 'kimi/kimi-k3' },
      tests: { ...Object.fromEntries(tested.map((id) => [id, passed])), ...opts.tests },
    }),
  )
  const secrets = createSecretStore({
    dbPath: ':memory:',
    clock,
    env: { [SECRETS_KEY_ENV]: randomBytes(32).toString('hex') },
  })
  stores.push(secrets)
  for (const id of Object.keys(URLS))
    secrets.put(`${MODEL_KEY_PREFIX}${id}`, { api_key: `sk-${id}-for-test` })
  if (opts.linked) secrets.put(CLOUD_TOKEN_SECRET_ID, { token: 'ws-token-for-test' })
  /** 每一家接下来回什么。 */
  const status: Record<Who | 'cloud', number> = { kimi: 200, ds: 200, glm: 200, cloud: 200 }
  const hits: string[] = []
  const fetch: FetchLike = async (url) => {
    const who = (Object.keys(URLS) as Who[]).find((k) => String(url).startsWith(URLS[k])) ?? 'cloud'
    hits.push(who)
    const code = status[who]
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
      ok: code < 400,
      status: code,
      json: async () => json,
      text: async () => (code < 400 ? sse : '{"error":{"message":"nope"}}'),
    }
  }
  const events: { type: string; payload: unknown }[] = []
  const gateway = createModelGateway({
    providers: [stubProvider({ seed: 7 })],
    policy: { default: { provider: 'stub', model: 'stub' }, prices: {} },
    clock,
    eventSink: (e) => {
      events.push({ type: e.type, payload: e.payload })
    },
    env: {},
  })
  const models = createModels({ clock, gateway, secrets, env: {}, dbDir: dir, fetch })
  return { models, gateway, status, hits, events }
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

describe('WP430 AI 来源顺序（装配）', () => {
  it('原选额度用完 → 按顺序用自己的下一条（测试通过的），照实说，不花积分', async () => {
    const { gateway, status, hits } = setup({ linked: true })
    status.kimi = 429
    const out = await gateway.complete(ask('run_a'))
    expect(out.model.provider).toBe('ds')
    expect(out.source_switch?.message).toBe('你的 Kimi 额度用完了，这一轮用了你的 DeepSeek')
    expect(out.source_switch?.target).toBe('own')
    expect(hits).toEqual(['kimi', 'ds'])
  })

  it('自己的都不行 → 工坊积分', async () => {
    const { gateway, status, hits } = setup({ linked: true })
    status.kimi = 429
    status.ds = 503
    status.glm = 401
    const out = await gateway.complete(ask('run_a'))
    expect(out.model.provider).toBe(CLOUD_FALLBACK_PROVIDER_ID)
    expect(out.source_switch?.message).toBe(
      '你的 Kimi 额度用完了，你的 DeepSeek 连不上，你的 GLM 登录或 key 失效了，这一轮用工坊积分',
    )
    expect(hits.filter((h) => h === 'cloud')).toHaveLength(1)
  })

  it('没测过 / 测没过的 key 不会被自动接上', async () => {
    const { gateway, status, hits } = setup({ linked: true, tested: ['glm'] })
    status.kimi = 429
    const out = await gateway.complete(ask('run_a'))
    expect(out.model.provider).toBe('glm')
    expect(hits).not.toContain('ds')
  })

  it('只是看不了图（纯文字的 key，测试停在第 ③ 步）也算能接；连不上的不算', async () => {
    const { models, gateway, status } = setup({
      linked: true,
      tested: [],
      tests: {
        ds: {
          ok: false,
          reason: 'no_vision',
          checked_at: '2026-10-19T09:00:00.000Z',
          steps: [
            { step: 'connect', ok: true },
            { step: 'text', ok: true },
            { step: 'vision', ok: false },
          ],
        },
        glm: {
          ok: false,
          reason: 'provider_unavailable',
          checked_at: '2026-10-19T09:00:00.000Z',
          steps: [{ step: 'connect', ok: false }],
        },
      },
    })
    const view = await models.port.defaults(actor)
    expect(view.ai_source?.own.map((o) => [o.provider_id, o.ready])).toEqual([
      ['kimi', false],
      ['ds', true],
      ['glm', false],
    ])
    status.kimi = 429
    const out = await gateway.complete(ask('run_a'))
    expect(out.model.provider).toBe('ds')
  })

  it('拖动排序：存进品牌模型设置，设置那一处按同一个顺序列，切的时候也按这个顺序', async () => {
    const { models, gateway, status, hits } = setup({ linked: true })
    const before = await models.port.defaults(actor)
    expect(before.ai_source?.own.map((o) => [o.provider_id, o.ready])).toEqual([
      ['kimi', false],
      ['ds', true],
      ['glm', true],
    ])
    const after = await models.port.setDefaults(actor, { source_order: ['glm', 'kimi', 'ds'] })
    expect(after.ai_source?.own.map((o) => o.provider_id)).toEqual(['glm', 'kimi', 'ds'])
    status.kimi = 429
    const out = await gateway.complete(ask('run_a'))
    expect(out.model.provider).toBe('glm')
    expect(hits).toEqual(['kimi', 'glm'])
    // 空数组 = 回到默认次序
    const reset = await models.port.setDefaults(actor, { source_order: [] })
    expect(reset.ai_source?.own.map((o) => o.provider_id)).toEqual(['kimi', 'ds', 'glm'])
  })

  it('没登录工坊账号：自己的几条照样互相接', async () => {
    const { gateway, status } = setup({ linked: false })
    status.kimi = 503
    const out = await gateway.complete(ask('run_a'))
    expect(out.model.provider).toBe('ds')
  })

  it('开关关着：自己的几条照样互相接；都不行才照实停下', async () => {
    const { models, gateway, status, hits } = setup({ linked: true })
    await models.port.setDefaults(actor, { fallback_to_cloud: false })
    status.kimi = 429
    expect((await gateway.complete(ask('run_a'))).model.provider).toBe('ds')
    status.ds = 429
    status.glm = 429
    const err = await gateway.complete(ask('run_b')).catch((e: unknown) => e)
    expect((err as Error).message).toContain('「自己的用不了时用工坊积分接着做」关着')
    expect(hits).not.toContain('cloud')
  })

  it('还有没有下一个能接（DeepSeek 账号登录失效时据此决定正在跑的事停不停）', async () => {
    const linked = setup({ linked: true })
    expect(linked.models.canSwitchFrom('kimi')).toBe(true)
    const alone = setup({ linked: false, tested: [] })
    expect(alone.models.canSwitchFrom('kimi')).toBe(false)
    const one = setup({ linked: false, tested: ['ds'] })
    expect(one.models.canSwitchFrom('kimi')).toBe(true)
    expect(one.models.canSwitchFrom('ds')).toBe(false)
  })
})

describe('WP436（决策 1316）：自带 API key 被拒 → 站内通知那条事件（装配）', () => {
  it('有得切：照样切到下一条，并发一次 key_rejected（来源名，不带 key）', async () => {
    const { gateway, status, events } = setup({ linked: false })
    status.kimi = 401
    const out = await gateway.complete(ask('run_a'))
    expect(out.model.provider).toBe('ds')
    const rejected = events.filter((e) => e.type === 'model_source.key_rejected')
    expect(rejected).toEqual([
      { type: 'model_source.key_rejected', payload: { provider: 'kimi', label: 'Kimi' } },
    ])
    expect(JSON.stringify(rejected)).not.toContain('sk-')
  })

  it('只有这一条能用（没得切）：照实报错，也发 key_rejected', async () => {
    const { gateway, status, events } = setup({ linked: false, tested: [] })
    status.kimi = 403
    await expect(gateway.complete(ask('run_a'))).rejects.toBeDefined()
    expect(events.filter((e) => e.type === 'model_source.key_rejected')).toHaveLength(1)
  })
})
