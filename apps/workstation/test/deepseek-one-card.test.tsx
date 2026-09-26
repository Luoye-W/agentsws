/**
 * WP152（Luoye 09-26）：DeepSeek 两种连法合成一张卡「DeepSeek 官方」，用户自己选：
 * 「官方账户登录」（排第一、默认选中）或「官方 API 接口连接」。
 *
 * 四组：
 * 1. **设置页「加一个」**：DeepSeek 只剩一张卡、两个方案；默认账户登录（就是原账号卡的内容）；
 *    切到 API 那种是原 key 卡的步骤与「填 API key」；已经配过 key 的人打开时默认 API 那种；
 *    设置页下面不再单独挂一张账号卡。
 * 2. **「已配的」**：老数据里两条都在——两条都显示（名字是服务端给的新叫法），账号那条没有「改」。
 * 3. **向导第 ① 步**：第三张大卡叫「DeepSeek 官方」、内部二选一；API 那种存完当场三步验证；
 *    「自己的接口」里不再出现 DeepSeek。
 * 4. **余额金额格式**：平台回的长串只在界面上格式化成两位小数；赠送为 0 不说「另有赠送」。
 *
 * 全是替身，不联网。
 */
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DeepSeekAccountLogin,
  formatAmount,
  formatWallet,
  isZeroAmount,
} from '@/components/models/deepseek-account-login'
import { defaultPlanIndex, groupTemplates, ModelsPanel } from '@/components/models/models-panel'
import { AiStep, defaultDeepSeekMode, isDeepSeekTemplate } from '@/components/onboarding/ai-step'
import type {
  DeepSeekAccountData,
  ModelProviderTemplate,
  ModelProviderView,
  ModelTestResult,
} from '@/lib/api'
import { renderWithProviders } from './helpers'

const T0 = '2026-09-26T09:00:00.000Z'

const SIGNED_OUT: DeepSeekAccountData = {
  available: true,
  enabled: false,
  signed_in: false,
  default_model: 'deepseek-flash',
  region: 'cn',
}

const OK_TEST: ModelTestResult = {
  ok: true,
  reason: 'ok',
  checked_at: T0,
  steps: [
    { step: 'connect', ok: true },
    { step: 'text', ok: true },
    { step: 'vision', ok: true },
  ],
}

const VENDOR = {
  vendor: 'deepseek',
  vendor_label: 'DeepSeek 官方',
  vendor_summary: '国内直连、便宜、够用。两种连法。',
} as const

/** 与服务端 `MODEL_TEMPLATES` 同形：两条挂同一个 vendor，账户登录排第一。 */
const ACCOUNT_TEMPLATE = {
  kind: 'deepseek_account',
  label: 'DeepSeek 官方 · 官方账户登录',
  summary: '不用建 key。',
  ...VENDOR,
  plan_label: '官方账户登录',
  plan_order: 1,
  auth: 'account',
  default_base_url: 'https://api.deepseek.com/anthropic',
  default_model: 'deepseek-flash',
  region: 'cn',
  steps: ['点"用 DeepSeek 账号登录"'],
  links: [{ label: 'DeepSeek 开放平台', url: 'https://platform.deepseek.com' }],
} as unknown as ModelProviderTemplate

const API_TEMPLATE: ModelProviderTemplate = {
  kind: 'deepseek',
  label: 'DeepSeek 官方 · 官方 API 接口连接',
  summary: '去开放平台建 key。',
  ...VENDOR,
  plan_label: '官方 API 接口连接',
  plan_order: 2,
  auth: 'api_key',
  default_base_url: 'https://api.deepseek.com',
  default_model: 'deepseek-flash',
  region: 'cn',
  steps: ['打开 platform.deepseek.com', '创建 API key'],
  links: [{ label: 'DeepSeek 开放平台', url: 'https://platform.deepseek.com/api_keys' }],
}

const COMPAT_TEMPLATE: ModelProviderTemplate = {
  kind: 'openai_compatible',
  label: 'OpenAI 兼容（自定义）',
  summary: '任何 OpenAI 格式的服务。',
  vendor: 'openai-compatible',
  vendor_label: 'OpenAI 兼容（自定义）',
  plan_order: 1,
  auth: 'api_key',
  default_base_url: 'https://api.moonshot.cn/v1',
  default_model: 'kimi-latest',
  region: 'cn',
  steps: ['填地址与 key'],
  links: [{ label: 'Moonshot', url: 'https://platform.moonshot.cn' }],
}

/** 老用户升级上来：两条都在（显示名是服务端 `providerDisplayLabel` 给的新叫法）。 */
const API_ROW: ModelProviderView = {
  id: 'deepseek',
  kind: 'deepseek',
  label: 'DeepSeek 官方 · 官方 API 接口连接',
  base_url: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  region: 'cn',
  has_key: true,
  active: true,
}

const ACCOUNT_ROW = {
  id: 'deepseek-account',
  kind: 'deepseek_account',
  label: 'DeepSeek 官方 · 官方账户登录',
  base_url: 'https://api.deepseek.com/anthropic',
  model: 'deepseek-flash',
  region: 'cn',
  has_key: true,
  active: true,
} as unknown as ModelProviderView

const state = {
  view: SIGNED_OUT as DeepSeekAccountData,
  providers: [] as ModelProviderView[],
  saved: [] as { id: string; kind: string }[],
  tested: [] as string[],
}

vi.mock('@/components/connections/bridge', () => ({ openExternal: () => undefined }))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getDeepSeekAccount: async () => state.view,
    listModelProviders: async () => ({
      providers: state.providers,
      templates: [API_TEMPLATE, COMPAT_TEMPLATE, ACCOUNT_TEMPLATE],
    }),
    saveModelProvider: async (id: string, input: { kind: string; model: string }) => {
      state.saved.push({ id, kind: input.kind })
      return { ...API_ROW, id }
    },
    testModelProvider: async (id: string) => {
      state.tested.push(id)
      return OK_TEST
    },
    getModelDefaults: async () => ({
      default: '',
      by_purpose: {},
      data_residency: 'cn',
      budget: {},
      choices: [],
    }),
    getModelUsage: async () => ({
      since: T0,
      rows: [],
      total: undefined,
      budget: { used_base: 0, cap_base: 0, frozen: false },
    }),
    getModelPricing: async () => ({ vendors: [] }),
    getModelImage: async () => ({ configured: false, official: false, choices: [] }),
    getCloudAccount: async () => ({ linked: false, cloud_base_url: 'https://cloud.agentsws.dev' }),
    getCloudCredits: async () => ({ linked: false }),
  }
})

beforeEach(() => {
  state.view = SIGNED_OUT
  state.providers = []
  state.saved = []
  state.tested = []
})

/** 设置页里 DeepSeek 那张卡。 */
const deepseekCard = async (): Promise<HTMLElement> => {
  await screen.findByTestId('models-panel')
  const cards = screen
    .getAllByTestId('model-template')
    .filter((el) => el.getAttribute('data-vendor') === 'deepseek')
  expect(cards).toHaveLength(1)
  return cards[0] as HTMLElement
}

describe('WP152 设置页「加一个」：DeepSeek 一张卡，二选一', () => {
  it('只剩一张「DeepSeek 官方」：官方账户登录排第一且默认选中，卡里就是原账号卡的内容', async () => {
    renderWithProviders(<ModelsPanel />)
    const card = await deepseekCard()
    expect(card.textContent).toContain('DeepSeek 官方')
    const plans = within(card).getAllByTestId('model-plan')
    expect(plans.map((p) => p.textContent)).toEqual(['官方账户登录', '官方 API 接口连接'])
    expect(plans.map((p) => p.getAttribute('data-selected'))).toEqual(['true', 'false'])
    expect(card.getAttribute('data-kind')).toBe('deepseek_account')
    // 原账号卡的登录按钮在卡里；没有「填 API key」
    expect(await within(card).findByTestId('dsa-login')).toBeTruthy()
    expect(within(card).queryByText('填 API key')).toBeNull()
    // 不再有单独那张账号卡
    expect(screen.queryByTestId('model-deepseek-account-card')).toBeNull()
  })

  it('切到「官方 API 接口连接」：原 key 卡的步骤与「填 API key」表单', async () => {
    const user = userEvent.setup()
    renderWithProviders(<ModelsPanel />)
    const card = await deepseekCard()
    await user.click(within(card).getByText('官方 API 接口连接'))
    expect(card.getAttribute('data-kind')).toBe('deepseek')
    expect(card.textContent).toContain('创建 API key')
    expect(within(card).queryByTestId('dsa')).toBeNull()
    await user.click(within(card).getByText('填 API key'))
    expect(within(card).getByTestId('model-form')).toBeTruthy()
  })

  it('已经配过 key（没登过账号）的人：打开时默认显示他已有的 API 那种', async () => {
    state.providers = [API_ROW]
    renderWithProviders(<ModelsPanel />)
    const card = await deepseekCard()
    expect(
      within(card)
        .getAllByTestId('model-plan')
        .map((p) => p.getAttribute('data-selected')),
    ).toEqual(['false', 'true'])
    expect(card.getAttribute('data-kind')).toBe('deepseek')
  })

  it('分组与默认方案的规则（纯函数）', () => {
    const cards = groupTemplates([API_TEMPLATE, COMPAT_TEMPLATE, ACCOUNT_TEMPLATE])
    expect(cards.map((c) => c.id)).toEqual(['deepseek', 'openai-compatible'])
    const ds = cards[0]
    expect(ds?.plans.map((p) => p.kind)).toEqual(['deepseek_account', 'deepseek'])
    const plans = ds?.plans ?? []
    expect(defaultPlanIndex(plans, [])).toBe(0)
    expect(defaultPlanIndex(plans, [API_ROW])).toBe(1)
    // 两种都配了：排前面的（官方账户登录）
    expect(defaultPlanIndex(plans, [API_ROW, ACCOUNT_ROW])).toBe(0)
    // 09-26：账号登录过期被摘掉（只剩 API 那条）：仍默认账户登录，过期提示一打开就看得到
    expect(defaultPlanIndex(plans, [API_ROW], { available: true, session_expired: {} })).toBe(0)
    // 09-26：这台部署用不了账号登录、什么都没配：默认 API 那种
    expect(defaultPlanIndex(plans, [], { available: false })).toBe(1)
    // 用得了、没配过、没过期：照旧默认账户登录
    expect(defaultPlanIndex(plans, [], { available: true })).toBe(0)
    // 向导同一条规则
    expect(
      defaultDeepSeekMode([{ kind: 'deepseek' }], { available: true, session_expired: {} }),
    ).toBe('account')
    expect(defaultDeepSeekMode([], { available: false })).toBe('api')
    expect(defaultDeepSeekMode([], { available: true })).toBe('account')
  })
})

describe('WP152「已配的」：老数据里两条都在', () => {
  it('两条都显示新叫法；账号那条不给「改」，API 那条照旧能改', async () => {
    state.providers = [
      { ...API_ROW, last_test: OK_TEST },
      { ...ACCOUNT_ROW, last_test: OK_TEST },
    ]
    renderWithProviders(<ModelsPanel />)
    await screen.findByTestId('models-panel')
    const rows = screen.getAllByTestId('model-row')
    expect(rows.map((r) => r.getAttribute('data-id'))).toEqual(['deepseek', 'deepseek-account'])
    expect(rows[0]?.textContent).toContain('DeepSeek 官方 · 官方 API 接口连接')
    expect(rows[1]?.textContent).toContain('DeepSeek 官方 · 官方账户登录')
    expect(within(rows[0] as HTMLElement).queryByText('改')).toBeTruthy()
    expect(within(rows[1] as HTMLElement).queryByText('改')).toBeNull()
    // 两种都配了：卡上默认显示排第一的「官方账户登录」
    const card = await deepseekCard()
    expect(card.getAttribute('data-kind')).toBe('deepseek_account')
  })
})

describe('WP152 向导第 ① 步：「DeepSeek 官方」一张大卡，内部二选一', () => {
  it('第三张大卡叫「DeepSeek 官方」；默认「官方账户登录」（原账号卡的内容）', async () => {
    const user = userEvent.setup()
    renderWithProviders(<AiStep onConnected={() => undefined} onDemo={() => undefined} />)
    const card = await screen.findByTestId('ai-card-account')
    expect(within(card).getByTestId('ai-pick-account').textContent).toContain('DeepSeek 官方')
    await user.click(within(card).getByTestId('ai-pick-account'))
    const modes = within(card).getByTestId('ai-ds-modes')
    expect(
      within(modes)
        .getAllByRole('button')
        .map((b) => [b.textContent, b.getAttribute('data-picked')]),
    ).toEqual([
      ['官方账户登录', 'true'],
      ['官方 API 接口连接', 'false'],
    ])
    expect(await within(card).findByTestId('dsa-login')).toBeTruthy()
    expect(within(card).queryByTestId('model-form')).toBeNull()
  })

  it('选「官方 API 接口连接」：填 key 存完当场三步验证，通了才算接上（算"自己的接口"）', async () => {
    const user = userEvent.setup()
    const connected = vi.fn()
    renderWithProviders(<AiStep onConnected={connected} onDemo={() => undefined} />)
    await user.click(await screen.findByTestId('ai-pick-account'))
    await user.click(screen.getByTestId('ai-ds-mode-api'))
    const card = screen.getByTestId('ai-card-account')
    expect(within(card).queryByTestId('dsa')).toBeNull()
    expect(within(card).getByTestId('ai-ds-api-hint')).toBeTruthy()
    expect(card.textContent).toContain('创建 API key')
    const form = within(card).getByTestId('model-form')
    await user.type(within(form).getByLabelText('API key'), 'sk-wp152-test-only')
    await user.click(within(form).getByRole('button', { name: '保存' }))
    expect(await within(card).findByTestId('ai-own-ok')).toBeTruthy()
    expect(state.saved.map((s) => s.kind)).toEqual(['deepseek'])
    expect(state.tested).toEqual([state.saved[0]?.id])
    expect(document.body.innerHTML).not.toContain('sk-wp152-test-only')
    await waitFor(() => {
      expect(connected).toHaveBeenCalledWith('own')
    })
  })

  it('已经配过 DeepSeek key 的：打开时默认 API 那种', async () => {
    const user = userEvent.setup()
    state.providers = [API_ROW]
    renderWithProviders(<AiStep onConnected={() => undefined} onDemo={() => undefined} />)
    await user.click(await screen.findByTestId('ai-pick-account'))
    expect(screen.getByTestId('ai-ds-mode-api').getAttribute('data-picked')).toBe('true')
    expect(screen.getByTestId('model-form')).toBeTruthy()
  })

  it('「自己的接口」里不再出现 DeepSeek（两种都在「DeepSeek 官方」卡里）', async () => {
    const user = userEvent.setup()
    renderWithProviders(<AiStep onConnected={() => undefined} onDemo={() => undefined} />)
    await user.click(await screen.findByTestId('ai-pick-own'))
    const own = screen.getByTestId('ai-card-own')
    const form = await within(own).findByTestId('model-form')
    // 只剩 OpenAI 兼容这一家 → 表单是它的，不是 DeepSeek 的
    expect((within(form).getByDisplayValue('OpenAI 兼容（自定义）') as HTMLInputElement).name).toBe(
      'label',
    )
    expect(own.textContent).not.toContain('DeepSeek')
  })

  it('规则（纯函数）：哪些模板算 DeepSeek；默认哪种', () => {
    expect(isDeepSeekTemplate(API_TEMPLATE)).toBe(true)
    expect(isDeepSeekTemplate(ACCOUNT_TEMPLATE)).toBe(true)
    expect(isDeepSeekTemplate(COMPAT_TEMPLATE)).toBe(false)
    expect(defaultDeepSeekMode([])).toBe('account')
    expect(defaultDeepSeekMode([API_ROW])).toBe('api')
    expect(defaultDeepSeekMode([API_ROW, ACCOUNT_ROW])).toBe('account')
    expect(defaultDeepSeekMode([ACCOUNT_ROW])).toBe('account')
  })
})

describe('WP152 余额金额格式：只在界面上格式化', () => {
  it('长串 → 两位小数（四舍五入、按字符串算）；认不出的原样', () => {
    expect(formatAmount('28.1146885000000000')).toBe('28.11')
    expect(formatAmount('28.115')).toBe('28.12')
    expect(formatAmount('0.995')).toBe('1.00')
    expect(formatAmount('42.5')).toBe('42.50')
    expect(formatAmount('10')).toBe('10.00')
    expect(formatAmount('0')).toBe('0.00')
    expect(formatAmount('.5')).toBe('0.50')
    expect(formatAmount('-1.234')).toBe('-1.23')
    expect(formatAmount('-0.001')).toBe('0.00')
    expect(formatAmount('abc')).toBe('abc')
    expect(isZeroAmount('0.0000000000')).toBe(true)
    expect(isZeroAmount('0.01')).toBe(false)
    expect(formatWallet({ currency: 'CNY', balance: '28.1146885000000000' })).toBe('¥28.11')
    expect(formatWallet({ currency: 'USD', balance: '3' })).toBe('$3.00')
  })

  it('卡片上：「余额 ¥28.11」；赠送为 0 不说「另有赠送」', async () => {
    state.view = {
      ...SIGNED_OUT,
      enabled: true,
      signed_in: true,
      account: '替身账号',
      balance: {
        status: 'ready',
        wallets: [{ currency: 'CNY', balance: '28.1146885000000000' }],
        bonus: [{ currency: 'CNY', balance: '0' }],
      },
    }
    state.providers = [{ ...ACCOUNT_ROW, last_test: OK_TEST }]
    renderWithProviders(<DeepSeekAccountLogin />)
    const balance = await screen.findByTestId('dsa-balance')
    expect(balance.textContent).toBe('余额 ¥28.11')
    expect(balance.textContent).not.toContain('赠送')
  })

  it('赠送不为 0：照常列出（也是两位小数），为 0 的那个币种不列', async () => {
    state.view = {
      ...SIGNED_OUT,
      enabled: true,
      signed_in: true,
      account: '替身账号',
      balance: {
        status: 'ready',
        wallets: [{ currency: 'CNY', balance: '5' }],
        bonus: [
          { currency: 'CNY', balance: '10.004' },
          { currency: 'USD', balance: '0.000' },
        ],
      },
    }
    state.providers = [{ ...ACCOUNT_ROW, last_test: OK_TEST }]
    renderWithProviders(<DeepSeekAccountLogin />)
    const balance = await screen.findByTestId('dsa-balance')
    expect(balance.textContent).toBe('余额 ¥5.00 · 另有赠送 ¥10.00')
  })
})
