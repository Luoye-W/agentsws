/**
 * WP479（决策 1625）：真 `createModels` + 订阅替身——勾选启用接到模型面上。
 *
 * | 钉什么 | |
 * |---|---|
 * | 首次（升级后第一次）| 每条线只勾最新；默认模型 / 事项选着的旧模型照样勾；AI 钮与默认模型下拉只列勾上的 |
 * | 改勾选 | 保存即生效；默认那个取消不了；一个都不勾留主模型；落盘、重启还在 |
 * | 新模型 | 目录多了 → 铃铛一条（同一批合成）、设置里标「新」、不自动勾；看过就收 |
 * | 积分组 | 不在设置清单里 |
 */

import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ModelsActor } from '@agentsws/api'
import type { Clock } from '@agentsws/contracts'
import { createModelGateway, stubProvider } from '@agentsws/model-gateway'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createModels } from '../src/models.js'
import { newModelNoticeCard, newModelsTitle } from '../src/new-models.js'
import { createSecretStore, SECRETS_KEY_ENV, type SecretStore } from '../src/secret-store.js'
import type { SubscriptionModelPort } from '../src/subscription-model.js'

vi.setConfig({ testTimeout: 120_000 })

const clock: Clock = { now: () => '2026-10-23T10:00:00.000Z' }
const CHATGPT = [
  { id: 'gpt-5.3-codex-spark', name: 'GPT-5.3 Codex Spark', vision: false },
  { id: 'gpt-5.5', name: 'GPT-5.5', vision: true },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', vision: true },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', vision: true },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', vision: true },
  { id: 'gpt-6-astra', name: 'GPT-6 Astra', vision: true },
  { id: 'gpt-6-luna', name: 'GPT-6 Luna', vision: true },
  { id: 'gpt-6-sol', name: 'GPT-6 Sol', vision: true },
  { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', vision: true },
]

const stores: SecretStore[] = []
const dirs: string[] = []
afterEach(() => {
  for (const s of stores.splice(0)) s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const owner: ModelsActor = {
  workspace_id: 'ws_1',
  person_id: 'per_1',
  assignment_id: 'asg_1',
  role_id: 'owner',
}

function setup(opts: { dir?: string; matters?: string[] } = {}) {
  const catalog = { list: [...CHATGPT] }
  const port: SubscriptionModelPort = {
    signedIn: () => true,
    catalog: () => catalog.list,
    complete: async () => ({
      text: 'ok',
      usage: { input_tokens: 1, output_tokens: 1, cached_tokens: 0 },
      model: 'x',
    }),
  }
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
    env: {},
  })
  const models = createModels({
    clock,
    gateway,
    secrets,
    env: {},
    subscription: port,
    ...(opts.dir === undefined ? {} : { dbDir: opts.dir }),
    inUseModels: () => opts.matters ?? [],
  })
  return { models, catalog }
}

const subIds = (ids: string[]): string[] =>
  ids.filter((id) => id.startsWith('openai-codex/')).map((id) => id.slice('openai-codex/'.length))

describe('WP479 首次默认勾 + 选择器只列勾上的', () => {
  it('只勾最新一代（6）每条线最新那一版（决策 1626 选 B）；默认的 5.5、事项选着的 5.6 Sol 照样勾上', async () => {
    const { models } = setup({ matters: ['openai-codex/gpt-5.6-sol'] })
    expect(subIds(models.chatChoices().map((c) => c.id))).toEqual([
      'gpt-5.5',
      'gpt-5.6-sol',
      'gpt-6-astra',
      'gpt-6-luna',
      'gpt-6.1-sol',
    ])
    // 默认模型下拉与 AI 钮同一份
    const defaults = await models.port.defaults(owner)
    expect(subIds(defaults.choices.map((c) => c.id))).toHaveLength(5)
    const view = await models.port.enabledModels?.(owner)
    const sub = view?.sources.find((s) => s.provider_id === 'openai-codex')
    expect(sub?.group).toBe('subscription')
    expect(sub?.models).toHaveLength(9)
    expect(sub?.models.find((m) => m.id === 'gpt-5.6-sol')).toMatchObject({
      enabled: true,
      in_use: true,
    })
    expect(sub?.models.find((m) => m.id === 'gpt-6-sol')).toMatchObject({ enabled: false })
    expect(sub?.models.find((m) => m.id === 'gpt-6.1-sol')).toMatchObject({
      enabled: true,
      latest: true,
      name: 'GPT-6.1 Sol',
      vision: 'ok',
    })
    expect(sub?.models.find((m) => m.id === 'gpt-5.3-codex-spark')).toMatchObject({
      enabled: false,
      vision: 'no',
    })
    expect(sub?.models.find((m) => m.id === 'gpt-5.6-terra')?.latest).toBeUndefined()
    // 第一次建的那份不算新
    expect(sub?.models.some((m) => m.fresh === true)).toBe(false)
  })

  it('改勾选：保存即生效；默认那个取消不了；一个都不勾留主模型；落盘重启还在', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp479-'))
    dirs.push(dir)
    const { models } = setup({ dir })
    await models.port.setDefaults(owner, { default: 'openai-codex/gpt-6-luna' })
    const view = await models.port.setEnabledModels?.(owner, {
      provider_id: 'openai-codex',
      enabled: ['gpt-6-sol'],
    })
    const sub = view?.sources.find((s) => s.provider_id === 'openai-codex')
    expect(sub?.models.filter((m) => m.enabled).map((m) => m.id)).toEqual([
      'gpt-6-luna',
      'gpt-6-sol',
    ])
    expect(sub?.models.find((m) => m.id === 'gpt-6-luna')?.locked).toBe('default')
    expect(subIds(models.chatChoices().map((c) => c.id))).toEqual(['gpt-6-luna', 'gpt-6-sol'])

    // 重启：勾选还在
    const again = setup({ dir })
    expect(subIds(again.models.chatChoices().map((c) => c.id))).toEqual(['gpt-6-luna', 'gpt-6-sol'])
  })

  it('不认识的来源回 not_found', async () => {
    const { models } = setup()
    expect(() =>
      models.port.setEnabledModels?.(owner, { provider_id: 'nope', enabled: [] }),
    ).toThrow(/没有这个已连接的来源/)
  })
})

describe('WP479 新模型提醒', () => {
  it('目录多了 → 铃铛一条（同一批合成）、标「新」、不自动勾；看过就收', async () => {
    const { models, catalog } = setup()
    models.chatChoices()
    expect(models.newModelNotices()).toEqual([])

    catalog.list = [
      ...CHATGPT,
      { id: 'gpt-6.2-sol', name: 'GPT-6.2 Sol', vision: true },
      { id: 'gpt-6.2-luna', name: 'GPT-6.2 Luna', vision: true },
    ]
    // 不自动勾
    expect(subIds(models.chatChoices().map((c) => c.id))).not.toContain('gpt-6.2-sol')
    const notices = models.newModelNotices()
    expect(notices).toEqual([
      {
        provider_id: 'openai-codex',
        label: 'ChatGPT 订阅',
        models: [
          { id: 'gpt-6.2-sol', name: 'GPT-6.2 Sol' },
          { id: 'gpt-6.2-luna', name: 'GPT-6.2 Luna' },
        ],
        at: '2026-10-23T10:00:00.000Z',
      },
    ])
    const notice = notices[0]
    if (notice === undefined) throw new Error('no notice')
    expect(newModelsTitle(notice)).toBe('ChatGPT 订阅有新模型：GPT-6.2 Sol、GPT-6.2 Luna')
    const card = newModelNoticeCard({ notice, position_id: 'asg_1' })
    expect(card.kind).toBe('system_alert')
    expect((card.detail.payload as { open_path: string }).open_path).toBe(
      '/settings/models#models-openai-codex',
    )

    const view = await models.port.enabledModels?.(owner)
    const fresh = view?.sources[0]?.models.filter((m) => m.fresh === true).map((m) => m.id)
    expect(fresh).toEqual(['gpt-6.2-sol', 'gpt-6.2-luna'])

    const seen = await models.port.markModelsSeen?.(owner)
    expect(seen?.sources[0]?.models.some((m) => m.fresh === true)).toBe(false)
    expect(models.newModelNotices()).toEqual([])
  })

  it('积分那一组不在设置清单里', async () => {
    const { models } = setup()
    const view = await models.port.enabledModels?.(owner)
    expect(view?.sources.some((s) => s.kind === 'agentsws_cloud')).toBe(false)
  })
})
