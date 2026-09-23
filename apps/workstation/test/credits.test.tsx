/**
 * 工作台三处（WP59 / 49 M5）：第三张模型卡、积分面板、连接页那个开关。
 *
 * 三组断言，各对应一句"如果做反了用户会怎样"：
 * 1. **没关联账号时不画 0**——按钮变"先关联账号"，而不是一张写着 0 的余额卡；
 * 2. **两类积分分开**——合成一个数字，用户在清零那天会觉得钱少了一截却说不清；
 * 3. **没有第二条路的卡不出开关**——一个灰着的开关等于在暗示"充钱就能用"。
 */
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CapabilitySourceSwitch } from '@/components/connections/capability-source-switch'
import { CreditsPanel } from '@/components/settings/credits-panel'
import { ModelCloudCard } from '@/components/settings/model-cloud-card'
import type {
  CapabilitySourceSettings,
  CloudCreditsView,
  ModelProviderTemplate,
  ModelProviderView,
  PricingView,
  TopupTiersView,
  UsageReportView,
} from '@/lib/api'
import { renderWithProviders } from './helpers'

const T0 = '2026-09-15T09:00:00.000Z'

const CLOUD_TEMPLATE: ModelProviderTemplate = {
  kind: 'agentsws_cloud',
  label: 'agentsws 云（用积分）',
  summary: '不填 key、不注册。关联一次账号就能用，按积分扣，随时切回自己的 key。',
  default_base_url: 'https://cloud.agentsws.com/v1/ai',
  default_model: 'deepseek-flash',
  region: 'cn',
  steps: ['在"设置 → 账号与积分"里关联 agentsws 账号', '回到这里点"启用"'],
  links: [],
}

const CLOUD_PROVIDER: ModelProviderView = {
  id: 'agentsws',
  kind: 'agentsws_cloud',
  label: 'agentsws 云（用积分）',
  base_url: 'https://cloud.agentsws.com/v1/ai',
  model: 'deepseek-flash',
  region: 'cn',
  has_key: true,
  active: true,
}

const LINKED: CloudCreditsView = {
  linked: true,
  month_credits: 37.5,
  fetched_at: T0,
  balance: {
    org_id: 'org_1',
    purchased: 800,
    granted: 120,
    available: 920,
    reserved: 0,
    expiring: [{ credits: 120, expires_at: '2026-10-15T00:00:00.000Z' }],
    low_balance_threshold: 50,
    low_balance: false,
    at: T0,
  },
}

const NOT_LINKED: CloudCreditsView = {
  linked: false,
  reason: '还没关联 agentsws 账号。去"设置 → 账号与积分"里关联一次。',
}

const PRICING: PricingView = {
  version: 1,
  as_of: '2026-09-15',
  credit_cny: 1,
  ai_multiplier: 3,
  fx: { CNY: 1, USD: 7.1 },
  entries: [
    {
      capability: 'ai.chat',
      unit: '1k_tokens',
      credits_per_unit: 0.1,
      label_zh: 'AI 对话（按 token）',
      label_en: 'AI chat (per token)',
    },
    {
      capability: 'crawl.page',
      unit: 'page',
      credits_per_unit: 0.02,
      label_zh: '网页抓取（按页）',
      label_en: 'Page crawl (per page)',
    },
    {
      capability: 'kol.service.monthly',
      unit: 'month',
      credits_per_unit: 30,
      block: 'service',
      label_zh: '红人营销增值服务（每月）',
      label_en: 'Influencer service (per month)',
    },
  ],
}

/** 充值四档（67 §2）。 */
const TIERS: TopupTiersView = {
  version: 1,
  as_of: '2026-09-19',
  credits_per_usd: 7,
  tiers: [
    { id: 'usd20', usd: 20, credits: 140, label_zh: '入门', label_en: 'Starter' },
    {
      id: 'usd50',
      usd: 50,
      credits: 350,
      label_zh: '常用',
      label_en: 'Standard',
      recommended: true,
    },
    { id: 'usd100', usd: 100, credits: 700, label_zh: '团队', label_en: 'Team' },
    { id: 'usd200', usd: 200, credits: 1400, label_zh: '年度', label_en: 'Annual' },
  ],
}

const USAGE: Record<string, UsageReportView> = {
  capability: {
    group: 'capability',
    from: '2026-09-01T00:00:00.000Z',
    to: T0,
    rows: [
      { key: 'ai.chat', credits: 30, quantity: 12.5, calls: 42 },
      { key: 'crawl.page', credits: 7.5, quantity: 375, calls: 5 },
      { key: 'kol.service.monthly', credits: 30, quantity: 1, calls: 1 },
    ],
    total_credits: 67.5,
  },
  workspace: {
    group: 'workspace',
    from: '2026-09-01T00:00:00.000Z',
    to: T0,
    rows: [{ key: 'ws_1', credits: 37.5, quantity: 387.5, calls: 47 }],
    total_credits: 37.5,
  },
  day: {
    group: 'day',
    from: '2026-09-01T00:00:00.000Z',
    to: T0,
    rows: [
      { key: '2026-09-14', credits: 12, quantity: 100, calls: 20 },
      { key: '2026-09-15', credits: 25.5, quantity: 287.5, calls: 27 },
    ],
    total_credits: 37.5,
  },
}

const state = {
  credits: LINKED as CloudCreditsView,
  providers: [] as ModelProviderView[],
  sources: { workspace_id: 'ws_1', capability_sources: {} } as CapabilitySourceSettings,
}

const orders: string[] = []
const saved: { id: string; input: Record<string, unknown> }[] = []
const sourceWrites: Record<string, string>[] = []

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getCloudCredits: async () => state.credits,
    getCloudPricing: async () => PRICING,
    getCloudUsage: async (group: 'capability' | 'workspace' | 'day') => USAGE[group] ?? null,
    getTopupTiers: async () => TIERS,
    createTopup: async (tier_id: string) => {
      orders.push(tier_id)
      return {
        id: 'cs_1',
        credits: 350,
        amount_cny: 350,
        tier_id,
        checkout_url: 'https://pay.invalid/cs_1',
        status: 'created',
      }
    },
    getCapabilitySources: async () => state.sources,
    setCapabilitySources: async (next: Record<string, 'mine' | 'agentsws'>) => {
      sourceWrites.push(next)
      const kept: Record<string, 'mine' | 'agentsws'> = {}
      for (const [k, v] of Object.entries(next)) if (v === 'agentsws') kept[k] = v
      state.sources = { workspace_id: 'ws_1', capability_sources: kept, updated_at: T0 }
      return state.sources
    },
    listModelProviders: async () => ({
      providers: state.providers,
      templates: [CLOUD_TEMPLATE],
    }),
    saveModelProvider: async (id: string, input: Record<string, unknown>) => {
      saved.push({ id, input })
      state.providers = [CLOUD_PROVIDER]
      return CLOUD_PROVIDER
    },
    removeModelProvider: async () => {
      state.providers = []
      return { removed: true }
    },
  }
})

beforeEach(() => {
  state.credits = LINKED
  state.providers = []
  state.sources = { workspace_id: 'ws_1', capability_sources: {} }
  saved.length = 0
  sourceWrites.length = 0
})

describe('第三张模型卡（49 M5）', () => {
  it('没关联账号：按钮是"先关联账号"，一个数字都不画', async () => {
    state.credits = NOT_LINKED
    renderWithProviders(<ModelCloudCard assignment="asg_owner" />)
    const card = await screen.findByTestId('model-cloud-card')
    expect(card.dataset.linked).toBe('false')
    expect(within(card).getByTestId('model-cloud-link-account').textContent).toContain('先关联账号')
    expect(screen.queryByTestId('model-cloud-numbers')).toBeNull()
    expect(screen.queryByTestId('model-cloud-enable')).toBeNull()
  })

  it('关联了但还没启用：一个"启用"按钮，点下去不带任何 key', async () => {
    renderWithProviders(<ModelCloudCard assignment="asg_owner" />)
    const enable = await screen.findByTestId('model-cloud-enable')
    await userEvent.click(enable)
    await waitFor(() => {
      expect(saved).toHaveLength(1)
    })
    expect(saved[0]?.input).toEqual({ kind: 'agentsws_cloud', model: 'deepseek-flash' })
    // **没有 api_key 这个键**——这一条的凭据是工作区令牌，不是用户填的东西
    expect(Object.keys(saved[0]?.input ?? {})).not.toContain('api_key')
  })

  it('已经在用：显示本月用了多少、余额多少', async () => {
    state.providers = [CLOUD_PROVIDER]
    renderWithProviders(<ModelCloudCard assignment="asg_owner" />)
    const numbers = await screen.findByTestId('model-cloud-numbers')
    expect(numbers.textContent).toContain('37.5')
    expect(numbers.textContent).toContain('920')
  })
})

describe('积分面板（49 M5）', () => {
  it('没关联账号：一句人话，不是一张写着 0 的余额卡', async () => {
    state.credits = NOT_LINKED
    renderWithProviders(<CreditsPanel assignment="asg_owner" />)
    expect((await screen.findByTestId('credits-not-linked')).textContent).toContain('关联')
    expect(screen.queryByTestId('credits-balance')).toBeNull()
  })

  it('余额两类分开，即将过期的列出来', async () => {
    renderWithProviders(<CreditsPanel assignment="asg_owner" />)
    const balance = await screen.findByTestId('credits-balance')
    expect(balance.textContent).toContain('920')
    expect(balance.textContent).toContain('800')
    expect(balance.textContent).toContain('120')
    expect((await screen.findByTestId('credits-expiring')).textContent).toContain('2026-10-15')
  })

  it('用量三个切换各拉各的一份', async () => {
    renderWithProviders(<CreditsPanel assignment="asg_owner" />)
    const table = await screen.findByTestId('credits-usage-table')
    expect(table.textContent).toContain('ai.chat')

    const byDay = screen
      .getAllByTestId('credits-usage-group')
      .find((b) => b.dataset.group === 'day') as HTMLElement
    await userEvent.click(byDay)
    await waitFor(() => {
      expect(screen.getByTestId('credits-usage-table').textContent).toContain('2026-09-14')
    })
    expect(byDay.dataset.active).toBe('true')
  })

  it('价目表折叠着，展开之后每条是最终积分价', async () => {
    renderWithProviders(<CreditsPanel assignment="asg_owner" />)
    const section = await screen.findByTestId('credits-pricing')
    expect(section.textContent).not.toContain('网页抓取')
    await userEvent.click(within(section).getByRole('button'))
    await waitFor(() => {
      expect(section.textContent).toContain('网页抓取（按页）')
    })
    expect(section.textContent).toContain('每页')
    // 倍率与汇率是中间量，一个都不进界面
    expect(section.textContent).not.toContain('倍率')
    expect(section.textContent).not.toContain('7.1')
  })

  it('充值是四张档位卡，不是一个输入框（67 §2）', async () => {
    renderWithProviders(<CreditsPanel assignment="asg_owner" />)
    const cards = await screen.findAllByTestId('credits-tier')
    expect(cards.map((c) => c.getAttribute('data-tier'))).toEqual([
      'usd20',
      'usd50',
      'usd100',
      'usd200',
    ])
    // 卡面上同时有美元与积分——用户不用自己做那道除法
    expect(cards[1]?.textContent).toContain('US$50')
    expect(cards[1]?.textContent).toContain('350')
    expect(cards[1]?.getAttribute('data-recommended')).toBe('true')
    // 界面上一个填金额的输入框都没有
    expect(screen.queryByTestId('credits-topup')).toBeNull()
  })

  it('点一张卡：去云上建单，然后开新窗口付款——本地不碰卡号', async () => {
    const opened: string[] = []
    vi.spyOn(window, 'open').mockImplementation((url) => {
      opened.push(String(url))
      return null
    })
    renderWithProviders(<CreditsPanel assignment="asg_owner" />)
    const cards = await screen.findAllByTestId('credits-tier')
    const card = cards[1]
    if (card === undefined) throw new Error('该有第二张卡')
    await userEvent.click(card)
    await waitFor(() => {
      expect(orders).toContain('usd50')
    })
    await waitFor(() => {
      expect(opened).toContain('https://pay.invalid/cs_1')
    })
  })

  it('这个月钱花在哪：三张小卡，按付费三块分（67 §1）', async () => {
    renderWithProviders(<CreditsPanel assignment="asg_owner" />)
    const blocks = await screen.findAllByTestId('credits-block')
    expect(blocks.map((b) => b.getAttribute('data-block'))).toEqual(['data', 'ai', 'service'])
    const byBlock = (name: string): string =>
      blocks.find((b) => b.getAttribute('data-block') === name)?.textContent ?? ''
    // 价目表里 ai.chat 没写 block，按能力名前缀兜底也要归对
    await waitFor(() => {
      expect(byBlock('ai')).toContain('30')
    })
    expect(byBlock('data')).toContain('7.5')
    expect(byBlock('service')).toContain('30')
  })
})

describe('连接页那个开关（49 M2）', () => {
  it('默认"用我的"；没连自己的 token 时多说一句"可以用 agentsws 的"', async () => {
    renderWithProviders(
      <CapabilitySourceSwitch service="meta_ads" connected={false} assignment="asg_owner" />,
    )
    const box = await screen.findByTestId('capability-source')
    expect(within(box).getByTestId('capability-source-switch').getAttribute('data-state')).toBe(
      'unchecked',
    )
    expect(within(box).getByTestId('capability-source-nudge').textContent).toContain('没有 key')
  })

  it('已经连上自己的就不再劝人花钱', async () => {
    renderWithProviders(
      <CapabilitySourceSwitch service="meta_ads" connected assignment="asg_owner" />,
    )
    await screen.findByTestId('capability-source')
    expect(screen.queryByTestId('capability-source-nudge')).toBeNull()
  })

  it('拨过去就把这一项改成 agentsws，并说明开始计费', async () => {
    renderWithProviders(
      <CapabilitySourceSwitch service="meta_ads" connected={false} assignment="asg_owner" />,
    )
    await userEvent.click(await screen.findByTestId('capability-source-switch'))
    await waitFor(() => {
      expect(sourceWrites).toHaveLength(1)
    })
    expect(sourceWrites[0]).toEqual({ 'social.fetch': 'agentsws' })
    expect((await screen.findByTestId('capability-source-billing')).textContent).toContain('积分')
  })

  it('没有第二条路的卡一个开关都不出——灰着的开关等于在暗示"充钱就能用"', () => {
    for (const service of ['shopify_admin', 'ga4', 'gsc', 'gmail', 'imap_smtp']) {
      const { unmount } = renderWithProviders(
        <CapabilitySourceSwitch service={service} connected={false} assignment="asg_owner" />,
      )
      expect(screen.queryByTestId('capability-source'), `${service} 不该有开关`).toBeNull()
      unmount()
    }
  })
})
