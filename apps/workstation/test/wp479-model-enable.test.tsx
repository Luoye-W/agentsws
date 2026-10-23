/**
 * WP479（决策 1625）：设置 → 模型 里每个已连接来源「模型 N/M」那一行。
 *
 * - ChatGPT 订阅登上了：一行「模型 3/9」，点开是全部可用模型（勾选框 + 名字 + 「不能看图」+「新」）；
 * - 勾 / 取消一个 → 整份勾选发给服务端（默认那个取消不了）；「全选最新」把每条线最新那一版勾上；
 * - 铃铛点进来（`#models-openai-codex`）：那一个来源自己展开；打开这一页就告诉服务端「看过了」，
 *   这一次打开期间「新」照样标着。
 */
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toggled, withLatest } from '@/components/models/enabled-models'
import type {
  ModelDefaultsView,
  ModelEnableModelView,
  ModelEnableView,
  ModelProviderTemplate,
  SubscriptionData,
} from '@/lib/api'
import { renderWithProviders } from './helpers'

const SUB_TEMPLATE: ModelProviderTemplate = {
  kind: 'openai-codex',
  label: '用 ChatGPT 订阅登录（Plus / Pro）',
  summary: '登录一次，按订阅额度跑。',
  vendor: 'openai',
  vendor_label: 'OpenAI / ChatGPT',
  plan_label: '用 ChatGPT 订阅登录（Plus / Pro）',
  plan_order: 1,
  auth: 'subscription',
  subscription_provider: 'openai-codex',
  default_base_url: 'https://chatgpt.com',
  default_model: 'gpt-5.5',
  region: 'global',
  steps: [],
  links: [],
}

const SIGNED_IN: SubscriptionData = {
  provider: 'openai-codex',
  label: '用 ChatGPT 订阅登录（Plus / Pro）',
  summary: '',
  methods: ['device', 'browser'],
  risk_note: '风险',
  available: true,
  signed_in: true,
  in_flight: false,
  models: [],
  account: 'l***@example.com',
}

const row = (
  id: string,
  name: string,
  extra: Partial<ModelEnableModelView> = {},
): ModelEnableModelView => ({ id, name, enabled: false, vision: 'ok', ...extra })

const MODELS: ModelEnableModelView[] = [
  // 决策 1626 选 B：只有最新一代（6）每条线最新那一版算「最新」；停在 5.x 的线不算、首次也不勾
  row('gpt-5.3-codex-spark', 'GPT-5.3 Codex Spark', { vision: 'no' }),
  row('gpt-5.5', 'GPT-5.5', { enabled: true, locked: 'default' }),
  row('gpt-5.6-luna', 'GPT-5.6 Luna'),
  row('gpt-5.6-sol', 'GPT-5.6 Sol'),
  row('gpt-5.6-terra', 'GPT-5.6 Terra'),
  row('gpt-6-astra', 'GPT-6 Astra', { enabled: true, latest: true }),
  row('gpt-6-luna', 'GPT-6 Luna', { enabled: true, latest: true }),
  row('gpt-6-sol', 'GPT-6 Sol'),
  row('gpt-6.1-sol', 'GPT-6.1 Sol', { latest: true, fresh: true }),
]

const state = {
  enable: { sources: [] } as ModelEnableView,
  saved: [] as { provider_id: string; enabled: string[] }[],
  seen: 0,
}

const DEFAULTS: ModelDefaultsView = {
  default: 'openai-codex/gpt-5.5',
  by_purpose: {},
  budget: {},
  choices: [{ id: 'openai-codex/gpt-5.5', label: 'ChatGPT 订阅（GPT-5.5）' }],
}

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    listModelProviders: async () => ({ providers: [], templates: [SUB_TEMPLATE] }),
    getModelDefaults: async () => DEFAULTS,
    getModelUsage: async () => ({
      since: '2026-10-23T00:00:00.000Z',
      rows: [],
      budget: { used_base: 0, cap_base: 0, frozen: false },
    }),
    getModelPricing: async () => ({ vendors: [] }),
    getModelSubscription: async () => SIGNED_IN,
    getModelEnable: async () => state.enable,
    setModelEnable: async (input: { provider_id: string; enabled: string[] }) => {
      state.saved.push(input)
      const on = new Set(input.enabled)
      state.enable = {
        sources: state.enable.sources.map((s) =>
          s.provider_id !== input.provider_id
            ? s
            : { ...s, models: s.models.map((m) => ({ ...m, enabled: on.has(m.id) })) },
        ),
      }
      return state.enable
    },
    markModelsSeen: async () => {
      state.seen += 1
      state.enable = {
        sources: state.enable.sources.map((s) => ({
          ...s,
          models: s.models.map(({ fresh: _f, ...m }) => m),
        })),
      }
      return state.enable
    },
  }
})

const { ModelsPanel } = await import('@/components/models/models-panel')

beforeEach(() => {
  state.enable = {
    sources: [
      {
        provider_id: 'openai-codex',
        label: 'ChatGPT 订阅',
        kind: 'openai-codex',
        group: 'subscription',
        models: MODELS.map((m) => ({ ...m })),
      },
    ],
  }
  state.saved = []
  state.seen = 0
})

describe('WP479 纯函数', () => {
  it('勾 / 取消一个：锁着的总在', () => {
    expect(toggled(MODELS, 'gpt-5.5')).toContain('gpt-5.5')
    expect(toggled(MODELS, 'gpt-6-sol')).toContain('gpt-6-sol')
    expect(toggled(MODELS, 'gpt-6-astra')).not.toContain('gpt-6-astra')
  })
  it('全选最新：最新一代每条线最新那一版加上，已经勾的不动', () => {
    expect(withLatest(MODELS)).toEqual(['gpt-5.5', 'gpt-6-astra', 'gpt-6-luna', 'gpt-6.1-sol'])
  })
})

describe('WP479 设置 → 模型：订阅那一行的勾选清单', () => {
  it('「模型 3/9」带「新」；点开：名字、不能看图、新；默认那个取消不了', async () => {
    const user = userEvent.setup()
    renderWithProviders(<ModelsPanel assignment="asg_owner" />, '/settings/models')
    const toggle = await screen.findByTestId('model-enable-toggle')
    expect(toggle.textContent).toContain('模型 3/9')
    expect(within(toggle).getByTestId('model-enable-toggle-new')).toBeTruthy()
    // 打开这一页 = 看过了（这一次照样标着）
    await waitFor(() => expect(state.seen).toBe(1))

    await user.click(toggle)
    const rows = await screen.findAllByTestId('model-enable-row')
    expect(rows).toHaveLength(9)
    // 新的排最前
    expect(rows[0]?.getAttribute('data-model')).toBe('gpt-6.1-sol')
    expect(within(rows[0] as HTMLElement).getByTestId('model-enable-new')).toBeTruthy()
    const spark = rows.find((r) => r.getAttribute('data-model') === 'gpt-5.3-codex-spark')
    expect(within(spark as HTMLElement).getByTestId('model-enable-no-vision').textContent).toBe(
      '不能看图',
    )
    const def = rows.find((r) => r.getAttribute('data-model') === 'gpt-5.5') as HTMLElement
    expect((within(def).getByTestId('model-enable-check') as HTMLInputElement).disabled).toBe(true)
  })

  it('勾一个 → 整份发给服务端；全选最新', async () => {
    const user = userEvent.setup()
    renderWithProviders(<ModelsPanel assignment="asg_owner" />, '/settings/models')
    await user.click(await screen.findByTestId('model-enable-toggle'))
    const rows = await screen.findAllByTestId('model-enable-row')
    const sol6 = rows.find((r) => r.getAttribute('data-model') === 'gpt-6-sol') as HTMLElement
    await user.click(within(sol6).getByTestId('model-enable-check'))
    await waitFor(() => expect(state.saved).toHaveLength(1))
    expect(state.saved[0]).toEqual({
      provider_id: 'openai-codex',
      enabled: ['gpt-5.5', 'gpt-6-astra', 'gpt-6-luna', 'gpt-6-sol'],
    })
    await user.click(await screen.findByTestId('model-enable-latest'))
    await waitFor(() => expect(state.saved).toHaveLength(2))
    expect(state.saved[1]?.enabled).toContain('gpt-6.1-sol')
    await waitFor(() =>
      expect(screen.getByTestId('model-enable-toggle').textContent).toContain('模型 5/9'),
    )
  })

  it('铃铛点进来（#models-openai-codex）：那个来源自己展开', async () => {
    renderWithProviders(
      <ModelsPanel assignment="asg_owner" />,
      '/settings/models#models-openai-codex',
    )
    expect(await screen.findByTestId('model-enable-list')).toBeTruthy()
    expect(screen.getByTestId('model-enable').getAttribute('data-provider')).toBe('openai-codex')
  })
})
