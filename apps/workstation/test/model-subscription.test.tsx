/**
 * WP90：设置页模型一节的两件事。
 *
 * 1. **一家一张卡、点进去选方案**（Luoye 定）：同一个 `vendor` 的几条模板收成一张卡，
 *    方案按 `plan_order` 排、默认选第一个；切方案只换卡里那一半，不会把别的卡带开。
 *    以前是一个方案一张卡——百炼三张并排，第一眼的问题变成"这三张有什么区别"。
 * 2. **订阅登录是卡里的一个方案**：没有表单（没有 key 可填），只有风险提示 + 登录按钮；
 *    登录途中把"去这个网址、输这串码"原样画出来；登上之后是脱敏账号 + 模型下拉 + 登出。
 *    公司档上整块灰掉，按钮一个都不出现。
 *
 * 零泄漏照旧：整页 HTML 里搜不到任何 token 形状的东西——因为服务端压根不给。
 */
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ModelDefaultsView,
  ModelPricingView,
  ModelProviderTemplate,
  ModelUsageView,
  SubscriptionData,
} from '@/lib/api'
import { renderWithProviders } from './helpers'

const T0 = '2026-09-17T09:00:00.000Z'

/** 百炼三个方案：同一个 `vendor`，Token Plan 排第一。 */
const BAILIAN_VENDOR = {
  vendor: 'bailian',
  vendor_label: '阿里云百炼',
  vendor_summary: '一把 key 同时调通义千问与 DeepSeek。先选你买的是哪个方案。',
} as const

const bailian = (
  plan: string,
  order: number,
  base_url: string,
  model: string,
): ModelProviderTemplate => ({
  kind: 'openai_compatible',
  label: `阿里云百炼（${plan}）`,
  summary: plan,
  ...BAILIAN_VENDOR,
  plan_label: plan,
  plan_order: order,
  auth: 'api_key',
  default_base_url: base_url,
  default_model: model,
  region: 'cn',
  steps: ['开通', '拿 key', '填进来'],
  links: [{ label: '百炼控制台', url: 'https://bailian.console.aliyun.com/' }],
})

const TEMPLATES: ModelProviderTemplate[] = [
  bailian(
    'Token Plan（订阅）',
    1,
    'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    'qwen3.7-plus',
  ),
  bailian('按量计费（标准）', 2, 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen-plus'),
  bailian('Coding Plan（订阅）', 3, 'https://coding.dashscope.aliyuncs.com/v1', 'qwen3.7-plus'),
  {
    kind: 'openai-codex',
    label: '用 ChatGPT 订阅登录（Plus / Pro）',
    summary: '登录一次，按订阅额度跑。',
    vendor: 'openai',
    vendor_label: 'OpenAI / ChatGPT',
    vendor_summary: '两条路：订阅登录，或者填一把 API key。',
    plan_label: '用 ChatGPT 订阅登录（Plus / Pro）',
    plan_order: 1,
    auth: 'subscription',
    subscription_provider: 'openai-codex',
    default_base_url: 'https://chatgpt.com',
    default_model: 'gpt-5.4',
    region: 'global',
    steps: ['确认是 Plus 或 Pro', '点登录', '输码'],
    links: [{ label: 'ChatGPT 订阅档位', url: 'https://openai.com/chatgpt/pricing' }],
  },
  {
    kind: 'openai_compatible',
    label: 'OpenAI（API key，按量计费）',
    summary: '按 token 付费。',
    vendor: 'openai',
    vendor_label: 'OpenAI / ChatGPT',
    vendor_summary: '两条路：订阅登录，或者填一把 API key。',
    plan_label: 'API key（按量计费）',
    plan_order: 2,
    auth: 'api_key',
    default_base_url: 'https://api.openai.com/v1',
    default_model: 'gpt-4o-mini',
    region: 'global',
    steps: ['建 key', '填进来'],
    links: [{ label: 'OpenAI API keys', url: 'https://platform.openai.com/api-keys' }],
  },
]

const DEFAULTS: ModelDefaultsView = {
  default: 'stub/stub-v1',
  by_purpose: {},
  data_residency: 'cn',
  budget: {},
  choices: [],
}
const USAGE: ModelUsageView = {
  since: T0,
  rows: [],
  budget: { used_base: 0, cap_base: 0, frozen: false },
}
const PRICING: ModelPricingView = { vendors: [] }

const OWNER_POSITION = {
  id: 'asg_owner',
  role_id: 'owner',
  title: '老板',
  person_id: 'p_luoye',
  tiles: [],
  range: 'yesterday' as const,
  show_tiles: false,
}

/** 服务端给的那份订阅状态。用例逐个改它。 */
const SIGNED_OUT: SubscriptionData = {
  provider: 'openai-codex',
  label: '用 ChatGPT 订阅登录（Plus / Pro）',
  summary: '登录一次，按订阅额度跑。',
  methods: ['device', 'browser'],
  risk_note:
    '第三方工具用订阅登录没有得到 OpenAI / Anthropic 的明文授权，可能被限流或封禁；账号只属于你本人，不要在公司共用的机器上登录。',
  available: true,
  signed_in: false,
  in_flight: false,
  models: [],
}

const state = {
  subscription: { ...SIGNED_OUT } as SubscriptionData,
}
const logins: { provider: string; method: string }[] = []
const signedOut: string[] = []

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getPositions: async () => ({ positions: [OWNER_POSITION], tile_library: [], max_tiles: 6 }),
    listModelProviders: async () => ({ providers: [], templates: TEMPLATES }),
    getModelDefaults: async () => DEFAULTS,
    getModelUsage: async () => USAGE,
    getModelPricing: async () => PRICING,
    getModelSubscription: async () => state.subscription,
    startModelSubscriptionLogin: async (input: { provider: string; method: string }) => {
      logins.push(input)
      state.subscription = {
        ...state.subscription,
        in_flight: true,
        notice: {
          message: '在这一页上输入这串码',
          url: 'https://auth.openai.com/codex/device',
          code: 'ABCD-1234',
        },
      }
      return state.subscription
    },
    signOutModelSubscription: async (provider: string) => {
      signedOut.push(provider)
      state.subscription = { ...SIGNED_OUT }
      return { signed_out: true as const }
    },
    selectModelSubscriptionModel: async (_p: string, model: string) => {
      state.subscription = { ...state.subscription, selected_model: model }
      return state.subscription
    },
  }
})

const { ModelsPanel } = await import('@/components/models/models-panel')

beforeEach(() => {
  state.subscription = { ...SIGNED_OUT }
  logins.length = 0
  signedOut.length = 0
})

const cardOf = async (vendor: string): Promise<HTMLElement> => {
  const cards = await screen.findAllByTestId('model-template')
  const hit = cards.find((c) => c.getAttribute('data-vendor') === vendor)
  if (hit === undefined) throw new Error(`没有这张卡：${vendor}`)
  return hit
}

describe('一家一张卡，点进去选方案', () => {
  it('百炼三个方案收成一张卡，默认选 Token Plan（订阅）', async () => {
    renderWithProviders(<ModelsPanel assignment="asg_owner" />)
    const cards = await screen.findAllByTestId('model-template')
    // 五条模板 → 两张卡（bailian ×3、openai ×2）
    expect(cards).toHaveLength(2)

    const card = await cardOf('bailian')
    expect(card.textContent).toContain('阿里云百炼')
    const plans = within(card).getAllByTestId('model-plan')
    expect(plans.map((p) => p.textContent)).toEqual([
      'Token Plan（订阅）',
      '按量计费（标准）',
      'Coding Plan（订阅）',
    ])
    // 默认选第一个（`plan_order` 最小的那个）
    expect(plans[0]?.getAttribute('data-selected')).toBe('true')
    expect(card.getAttribute('data-template')).toBe('openai_compatible:bailian-token-plan')
  })

  it('换个方案只换这张卡里那一半：地址跟着变，别的卡不动', async () => {
    const user = userEvent.setup()
    renderWithProviders(<ModelsPanel assignment="asg_owner" />)
    const card = await cardOf('bailian')
    await user.click(within(card).getAllByTestId('model-plan')[1] as HTMLElement)

    expect(card.getAttribute('data-template')).toBe('openai_compatible:qwen')
    await user.click(within(card).getByText('填 API key'))
    const form = await screen.findByTestId('model-form')
    // 全页只展开一张表单
    expect(screen.getAllByTestId('model-form')).toHaveLength(1)
    expect((within(form).getByLabelText('接口地址') as HTMLInputElement).value).toBe(
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
    )
  })
})

describe('订阅登录：卡里的一个方案', () => {
  it('没登录：风险提示 + 两个登录按钮，没有表单', async () => {
    renderWithProviders(<ModelsPanel assignment="asg_owner" />)
    const card = await cardOf('openai')
    const plan = await within(card).findByTestId('subscription-plan')
    expect(within(plan).getByTestId('subscription-risk').textContent).toContain('可能被限流或封禁')
    expect(within(plan).getByTestId('subscription-risk').textContent).toContain('账号只属于你本人')
    const buttons = within(plan).getAllByTestId('subscription-login')
    expect(buttons.map((b) => b.getAttribute('data-method'))).toEqual(['device', 'browser'])
    // 订阅方案没有"填 API key"这条路
    expect(within(card).queryByText('填 API key')).toBeNull()
  })

  it('点设备码：把网址与那串码原样画出来', async () => {
    const user = userEvent.setup()
    renderWithProviders(<ModelsPanel assignment="asg_owner" />)
    const card = await cardOf('openai')
    const plan = await within(card).findByTestId('subscription-plan')
    await user.click(within(plan).getAllByTestId('subscription-login')[0] as HTMLElement)

    await waitFor(() => {
      expect(screen.getByTestId('subscription-code').textContent).toBe('ABCD-1234')
    })
    expect(logins).toEqual([{ provider: 'openai-codex', method: 'device' }])
    expect(screen.getByTestId('subscription-open').textContent).toContain(
      'auth.openai.com/codex/device',
    )
  })

  it('已登录：脱敏账号 + 模型下拉（价目写"订阅"）+ 登出', async () => {
    const user = userEvent.setup()
    state.subscription = {
      ...SIGNED_OUT,
      signed_in: true,
      account: 'acct…cdef',
      expires_at: '2026-09-17T10:00:00.000Z',
      models: [
        { id: 'gpt-5.4', name: 'GPT-5.4' },
        { id: 'gpt-5.5', name: 'GPT-5.5' },
      ],
    }
    vi.spyOn(globalThis, 'confirm').mockReturnValue(true)
    renderWithProviders(<ModelsPanel assignment="asg_owner" />)
    const card = await cardOf('openai')
    const plan = await within(card).findByTestId('subscription-plan')

    expect((await within(plan).findByTestId('subscription-account')).textContent).toContain(
      'acct…cdef',
    )
    // 价目一律"订阅"——不按 token 收钱
    expect(plan.textContent).toContain('订阅')
    const select = within(plan).getByTestId('subscription-model') as HTMLSelectElement
    expect([...select.options].map((o) => o.value)).toEqual(['', 'gpt-5.4', 'gpt-5.5'])

    await user.click(within(plan).getByTestId('subscription-signout'))
    await waitFor(() => {
      expect(signedOut).toEqual(['openai-codex'])
    })
    // 整页 HTML 里没有任何 token 形状的东西——服务端压根不给
    // （`refresh` 这个词不能拿来断言：价目表那个按钮的图标类名就叫 lucide-refresh-cw）
    expect(document.body.innerHTML).not.toContain('refresh_token')
    expect(document.body.innerHTML).not.toContain('access_token')
    expect(document.body.innerHTML).not.toContain('Bearer ')
    // 账号也只有脱敏那一版，完整 id 不在页面上
    expect(document.body.innerHTML).not.toContain('acct_')
  })

  it('公司档：整块灰掉，一个登录按钮都不出现，还说清楚为什么', async () => {
    state.subscription = {
      ...SIGNED_OUT,
      available: false,
      unavailable_reason: '这台机器是公司档 / 托管档，不支持用个人的 ChatGPT / Claude 订阅登录。',
    }
    renderWithProviders(<ModelsPanel assignment="asg_owner" />)
    const card = await cardOf('openai')
    const plan = await within(card).findByTestId('subscription-plan')
    expect(within(plan).getByTestId('subscription-unavailable').textContent).toContain('公司档')
    expect(within(plan).queryAllByTestId('subscription-login')).toHaveLength(0)
    // 风险提示照旧在（人得先知道这是什么东西，才看得懂为什么不给用）
    expect(within(plan).getByTestId('subscription-risk')).toBeTruthy()
  })
})
