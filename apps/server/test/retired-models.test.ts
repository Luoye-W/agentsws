/**
 * WP294（决策 375）：ChatGPT 订阅存着的退役模型（pi-ai 1.1.0 删了的 gpt-5.4 / gpt-5.4-mini）
 * 启动时自动换成 gpt-5.5，落盘，首页告警区留一行。
 *
 * 钉住：两处存档（每人的订阅选择 `subscription.json`、模型设置里那条订阅 `models.json`）都换；
 * 已经是 gpt-5.5 的不动、不提醒；别家（哪怕也叫 gpt-5.4）与用户自己填的别的名字不动；
 * 人自己再选一次 / 过了 7 天提醒就退场；真服务进程里首页告警区出这一行、点开到设置页模型那一块。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ModelsActor } from '@agentsws/api'
import type { SubscriptionLoginHandle } from '@agentsws/dsh-adapter'
import type { ModelGatewayApi } from '@agentsws/model-gateway'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import { createModels } from '../src/models.js'
import {
  MODELS_SETTINGS_PATH,
  RETIRED_MODEL_NOTICE_DAYS,
  retiredModelNoticeCard,
} from '../src/retired-models.js'
import { createSecretStore, SECRETS_KEY_ENV, type SecretStore } from '../src/secret-store.js'
import { createSubscription } from '../src/subscription.js'

const AT = '2026-10-10T09:00:00.000Z'
const DAY = 86_400_000
const SECRETS_KEY = 'b'.repeat(64)

const dirs: string[] = []
const stores: SecretStore[] = []
let server: Server | undefined
afterEach(async () => {
  await server?.close()
  server = undefined
  for (const s of stores.splice(0)) s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentsws-wp294-'))
  dirs.push(dir)
  return dir
}

function clockAt(start = AT) {
  let t = Date.parse(start)
  return {
    now: () => new Date(t).toISOString(),
    advance: (ms: number) => {
      t += ms
    },
  }
}

function secretStore(): SecretStore {
  const s = createSecretStore({
    dbPath: ':memory:',
    clock: { now: () => AT },
    env: { [SECRETS_KEY_ENV]: SECRETS_KEY },
  })
  stores.push(s)
  return s
}

/** 选模型时会顺手出一份卡上的样子——这里只要一个「没登录」的替身。 */
const idleLogin = async (): Promise<SubscriptionLoginHandle> =>
  ({
    status: async (provider: string) => ({ provider, signed_in: false }),
    models: async () => [],
    begin: async () => 'cancelled' as const,
    cancel() {},
    signOut: async () => {},
    dispose: async () => {},
  }) as unknown as SubscriptionLoginHandle

const actor = (person_id: string): ModelsActor => ({
  workspace_id: 'ws_local',
  person_id,
  assignment_id: 'asg_1',
  role_id: 'owner',
})

const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8'))

describe('WP294 · 订阅那块：每人选的模型', () => {
  const seed = (dir: string, chosen: Record<string, string>) =>
    writeFileSync(join(dir, 'subscription.json'), JSON.stringify({ version: 1, chosen }), 'utf8')
  const open = (dir: string, clock = clockAt()) =>
    createSubscription({
      clock,
      secrets: secretStore(),
      runtimeMode: () => 'local',
      dbDir: dir,
      createLogin: idleLogin,
    })

  it('存着 gpt-5.4 / gpt-5.4-mini → 启动时换成 gpt-5.5、落盘、留提醒', () => {
    const dir = tempDir()
    seed(dir, { 'p_a/openai-codex': 'gpt-5.4', 'p_b/openai-codex': 'gpt-5.4-mini' })
    const a = open(dir)
    const saved = readJson(join(dir, 'subscription.json'))
    expect(saved.chosen).toEqual({ 'p_a/openai-codex': 'gpt-5.5', 'p_b/openai-codex': 'gpt-5.5' })
    expect(a.retiredSwaps('p_a')).toEqual([
      { provider: 'openai-codex', from: 'gpt-5.4', to: 'gpt-5.5', at: AT },
    ])
    expect(a.retiredSwaps('p_b')).toEqual([
      { provider: 'openai-codex', from: 'gpt-5.4-mini', to: 'gpt-5.5', at: AT },
    ])
    // 按人分开：别人的那一条不出在我这儿
    expect(a.retiredSwaps('p_c')).toEqual([])
    // 再启动一次：不再换（已经是 gpt-5.5），提醒照旧（还没过期、人没改）
    const again = open(dir)
    expect(again.retiredSwaps('p_a')).toHaveLength(1)
    expect(readJson(join(dir, 'subscription.json')).swapped['p_a/openai-codex'].at).toBe(AT)
  })

  it('已经是 gpt-5.5 的不动、不提醒；Claude 那家与自己填的别的名字也不动', () => {
    const dir = tempDir()
    const chosen = {
      'p_a/openai-codex': 'gpt-5.5',
      'p_a/anthropic': 'gpt-5.4',
      'p_b/openai-codex': 'my-own-model',
    }
    seed(dir, chosen)
    const before = readFileSync(join(dir, 'subscription.json'), 'utf8')
    const a = open(dir)
    expect(readFileSync(join(dir, 'subscription.json'), 'utf8')).toBe(before)
    expect(a.retiredSwaps('p_a')).toEqual([])
    expect(a.retiredSwaps('p_b')).toEqual([])
  })

  it('人自己再选一次就不再提醒；没人动的过了 7 天自己退场', async () => {
    const dir = tempDir()
    seed(dir, { 'p_a/openai-codex': 'gpt-5.4', 'p_b/openai-codex': 'gpt-5.4' })
    const clock = clockAt()
    const a = open(dir, clock)
    await a.port.selectModel(actor('p_a'), 'openai-codex', 'gpt-5.6-sol')
    expect(a.retiredSwaps('p_a')).toEqual([])
    expect(readJson(join(dir, 'subscription.json')).swapped).toEqual({
      'p_b/openai-codex': { from: 'gpt-5.4', to: 'gpt-5.5', at: AT },
    })
    expect(a.retiredSwaps('p_b')).toHaveLength(1)
    clock.advance(RETIRED_MODEL_NOTICE_DAYS * DAY)
    expect(a.retiredSwaps('p_b')).toEqual([])
  })
})

describe('WP294 · 模型设置那块：models.json 里那条订阅', () => {
  const gateway = { reconfigure() {} } as unknown as ModelGatewayApi
  const open = (dir: string, clock = clockAt()) =>
    createModels({ clock, gateway, secrets: secretStore(), env: {}, dbDir: dir })
  const provider = (id: string, kind: string, model: string) => ({
    id,
    kind,
    label: id,
    base_url: 'https://example.invalid',
    model,
    region: 'global',
  })

  it('订阅那条存着 gpt-5.4 → 换成 gpt-5.5，默认与按用途的选择一起换，留提醒', () => {
    const dir = tempDir()
    writeFileSync(
      join(dir, 'models.json'),
      JSON.stringify({
        version: 1,
        providers: [provider('chatgpt', 'openai-codex', 'gpt-5.4')],
        defaults: {
          default: 'chatgpt/gpt-5.4',
          by_purpose: { summarize: 'chatgpt/gpt-5.4-mini' },
        },
        tests: {},
      }),
      'utf8',
    )
    const m = open(dir)
    const saved = readJson(join(dir, 'models.json'))
    expect(saved.providers[0].model).toBe('gpt-5.5')
    expect(saved.defaults.default).toBe('chatgpt/gpt-5.5')
    expect(saved.defaults.by_purpose.summarize).toBe('chatgpt/gpt-5.5')
    expect(
      m.retiredSwaps().map(({ provider_id, from, to }) => ({ provider_id, from, to })),
    ).toEqual([
      { provider_id: 'chatgpt', from: 'gpt-5.4', to: 'gpt-5.5' },
      { provider_id: 'chatgpt', from: 'gpt-5.4-mini', to: 'gpt-5.5' },
    ])
    // 设置快照（复制到别的品牌）不带提醒
    expect(JSON.stringify(m.exportSettings())).not.toContain('retired_swaps')
  })

  it('已经是 gpt-5.5 的不动；别家的 gpt-5.4（OpenAI 兼容口、Claude 订阅）一个字节都不动', () => {
    const dir = tempDir()
    const raw = `${JSON.stringify(
      {
        version: 1,
        providers: [
          provider('chatgpt', 'openai-codex', 'gpt-5.5'),
          provider('relay', 'openai_compatible', 'gpt-5.4'),
          provider('claude', 'anthropic', 'gpt-5.4'),
        ],
        defaults: { default: 'relay/gpt-5.4', by_purpose: { summarize: 'claude/gpt-5.4' } },
        tests: {},
      },
      null,
      2,
    )}\n`
    writeFileSync(join(dir, 'models.json'), raw, 'utf8')
    const m = open(dir)
    expect(readFileSync(join(dir, 'models.json'), 'utf8')).toBe(raw)
    expect(m.retiredSwaps()).toEqual([])
  })

  it('过了 7 天自己退场', () => {
    const dir = tempDir()
    writeFileSync(
      join(dir, 'models.json'),
      JSON.stringify({
        version: 1,
        providers: [provider('chatgpt', 'openai-codex', 'gpt-5.4')],
        defaults: {},
        tests: {},
      }),
      'utf8',
    )
    const clock = clockAt()
    const m = open(dir, clock)
    expect(m.retiredSwaps()).toHaveLength(1)
    clock.advance(RETIRED_MODEL_NOTICE_DAYS * DAY)
    expect(m.retiredSwaps()).toEqual([])
  })
})

describe('WP294 · 提醒那一行', () => {
  it('一句话说清换了什么，点开去设置页模型那一块', () => {
    const card = retiredModelNoticeCard({
      id: 'retired_model_1',
      swap: { from: 'gpt-5.4', to: 'gpt-5.5', at: AT },
      position_id: 'asg_owner',
    })
    expect(card.kind).toBe('system_alert')
    expect(card.title).toBe('ChatGPT 订阅的 gpt-5.4 停用了，已换成 gpt-5.5')
    expect((card.detail.payload as { open_path: string }).open_path).toBe(MODELS_SETTINGS_PATH)
    expect(MODELS_SETTINGS_PATH).toBe('/settings?tab=models')
  })
})

describe('WP294 · 真服务进程：重启后首页告警区出这一行', () => {
  it('老用户存着 gpt-5.4 → 重启 → 首页一行；自己改了模型就退场', async () => {
    const dir = tempDir()
    const boot = () =>
      createServer({
        dbDir: dir,
        clock: { now: () => AT },
        random: () => 0.42,
        quiet: true,
        startRun: false,
        scheduleIntervalMs: 0,
        tokenRefreshIntervalMs: 0,
        liveDataIntervalMs: 0,
        env: { [SECRETS_KEY_ENV]: SECRETS_KEY, AGENTSWS_OWNER_EMAIL: 'owner@localhost' },
        subscriptionLogin: idleLogin,
        mdns: () => ({ mdns: { publish() {}, browse() {}, stop() {} } }),
      })
    const first = await boot()
    const person = first.bootstrap.ownerAssignment.person_id
    await first.close()
    // 升级前那一版存下的选择
    writeFileSync(
      join(dir, 'subscription.json'),
      JSON.stringify({ version: 1, chosen: { [`${person}/openai-codex`]: 'gpt-5.4' } }),
      'utf8',
    )

    const s = await boot()
    server = s
    const owner = s.bootstrap.ownerAssignment.id
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await s.gateway.fetch(
        new Request(`http://127.0.0.1${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${s.bootstrap.internalToken}`,
            'X-Assignment': owner,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      )
      return { status: res.status, json: (await res.json()) as { data: Record<string, unknown> } }
    }
    const alerts = async () =>
      ((await call('GET', '/v1/home')).json.data.alerts ?? []) as {
        title: string
        detail: { payload: { open_path?: string } }
      }[]

    expect(readJson(join(dir, 'subscription.json')).chosen[`${person}/openai-codex`]).toBe(
      'gpt-5.5',
    )
    const got = await alerts()
    expect(got.map((a) => a.title)).toEqual(['ChatGPT 订阅的 gpt-5.4 停用了，已换成 gpt-5.5'])
    expect(got[0]?.detail.payload.open_path).toBe('/settings?tab=models')

    const picked = await call('PUT', '/v1/settings/models/subscription/openai-codex/model', {
      model: 'gpt-5.6-sol',
    })
    expect(picked.status).toBe(200)
    expect(await alerts()).toEqual([])
  })
})
