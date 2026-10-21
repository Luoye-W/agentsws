/**
 * WP424（Luoye 10-19 真机）：首次设置与 Mac 窗口外观。
 *
 * 1. 第 ③ 步：类别展开后标题行「全选 / 全不选」，计数照旧 `n/m`；
 * 2. 第 ④ 步：要连的那几条不挂「必须」（这一块本身就叫「要连的平台」），可选的照旧挂「可选」；
 * 3. 第 ①　步：换一家预设，表单的显示名 / 接口地址 / 模型名跟着换（以前停在上一家）；
 *    「ChatGPT 订阅」与「DeepSeek 官方」同一级；「Claude 订阅」留了位置、没接通不显示；
 *    这台机器用不了订阅登录就整张不出；
 * 4. 桌面壳藏了标题栏：顶栏可拖动、Mac 左栏顶部给红绿灯留位置；浏览器里打开不留那块空。
 *
 * 全是替身，不联网。
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppShell } from '@/components/app-shell'
import { AI_SUBSCRIPTION_CARDS, AiStep } from '@/components/onboarding/ai-step'
import { PlanList } from '@/components/onboarding/plan-list'
import { PositionPlanner } from '@/components/onboarding/position-planner'
import type {
  ModelProviderTemplate,
  OnboardingPlanView,
  OnboardingPositionView,
  SubscriptionData,
} from '@/lib/api'
import { DesktopDragStrip, desktopChrome } from '@/lib/desktop-chrome'
import { EMPTY_BOARD } from '@/lib/position-board'
import { renderWithProviders } from './helpers'

const COMPAT: ModelProviderTemplate = {
  kind: 'openai_compatible',
  label: 'OpenAI 兼容（自定义）',
  summary: '任何 OpenAI 格式的服务。',
  vendor: 'openai-compatible',
  vendor_label: 'OpenAI 兼容（自定义）',
  plan_order: 1,
  auth: 'api_key',
  default_base_url: 'https://api.moonshot.cn/v1',
  default_model: 'moonshot-v1-8k-vision-preview',
  region: 'cn',
  steps: [],
  links: [],
}

const OPENAI_KEY: ModelProviderTemplate = {
  kind: 'openai_compatible',
  label: 'OpenAI（API key，按量计费）',
  summary: '按 token 付费。',
  vendor: 'openai',
  vendor_label: 'OpenAI / ChatGPT',
  plan_label: 'API key（按量计费）',
  plan_order: 2,
  auth: 'api_key',
  default_base_url: 'https://api.openai.com/v1',
  default_model: 'gpt-4o-mini',
  region: 'global',
  steps: [],
  links: [],
}

const CHATGPT_SUB = {
  ...OPENAI_KEY,
  kind: 'openai-codex',
  label: '用 ChatGPT 订阅登录（Plus / Pro）',
  plan_label: '用 ChatGPT 订阅登录（Plus / Pro）',
  plan_order: 1,
  auth: 'subscription',
  subscription_provider: 'openai-codex',
  default_base_url: 'https://chatgpt.com/backend-api',
  default_model: 'gpt-5.5',
} as unknown as ModelProviderTemplate

const CLAUDE_SUB = {
  ...CHATGPT_SUB,
  kind: 'anthropic',
  label: '用 Claude 订阅登录（Pro / Max）',
  vendor: 'anthropic',
  vendor_label: 'Anthropic / Claude',
  subscription_provider: 'anthropic',
  default_base_url: 'https://api.anthropic.com',
} as unknown as ModelProviderTemplate

function sub(over: Partial<SubscriptionData> = {}): SubscriptionData {
  return {
    provider: 'openai-codex',
    label: 'ChatGPT 订阅',
    summary: '',
    methods: ['device'],
    risk_note: '第三方工具用订阅登录没有得到明文授权。',
    available: true,
    signed_in: false,
    in_flight: false,
    models: [],
    ...over,
  }
}

const state = vi.hoisted(() => ({
  sub: undefined as unknown,
  subCalls: [] as string[],
}))

vi.mock('@/components/connections/bridge', () => ({ openExternal: () => undefined }))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    listModelProviders: async () => ({
      providers: [],
      templates: [COMPAT, OPENAI_KEY, CHATGPT_SUB, CLAUDE_SUB],
    }),
    getDeepSeekAccount: async () => ({
      available: true,
      enabled: false,
      signed_in: false,
      default_model: 'deepseek-flash',
      region: 'cn',
    }),
    getCloudAccount: async () => ({ linked: false, cloud_base_url: 'https://cloud.example' }),
    getCloudCredits: async () => ({ linked: false }),
    getModelSubscription: async (provider: string) => {
      state.subCalls.push(provider)
      return state.sub
    },
    getConnectionDirectory: async () => ({ entries: [] }),
    listOrganizations: async () => [],
    getPositions: async () => ({ positions: [] }),
  }
})

beforeEach(() => {
  state.sub = sub()
  state.subCalls = []
})

afterEach(() => {
  delete (globalThis.window as unknown as { agentsws?: unknown }).agentsws
  document.documentElement.removeAttribute('data-shell')
})

// ── ① 接上 AI ────────────────────────────────────────────────────────

describe('WP424 第 ① 步：换预设 / 订阅登录', () => {
  it('「用我自己的模型接口」换一家预设：显示名 / 接口地址 / 模型名换成那一家的', async () => {
    const user = userEvent.setup()
    const { container } = renderWithProviders(<AiStep onConnected={() => {}} />)
    await user.click(await screen.findByTestId('ai-pick-own'))
    const field = (name: string): string =>
      (container.querySelector(`input[name="${name}"]`) as HTMLInputElement).value
    await waitFor(() => {
      expect(field('base_url')).toBe('https://api.moonshot.cn/v1')
    })
    expect(field('label')).toBe('OpenAI 兼容（自定义）')
    expect(field('model')).toBe('moonshot-v1-8k-vision-preview')

    // 订阅那张不在「自己的接口」里（只放 API key 这一类）
    const presets = screen.getByTestId('ai-own-templates')
    expect(presets.textContent).toContain('OpenAI / ChatGPT')
    await user.click(within(presets).getByText('OpenAI / ChatGPT'))
    await waitFor(() => {
      expect(field('base_url')).toBe('https://api.openai.com/v1')
    })
    expect(field('label')).toBe('OpenAI（API key，按量计费）')
    expect(field('model')).toBe('gpt-4o-mini')
  })

  it('「ChatGPT 订阅」与「DeepSeek 官方」同一级；「Claude 订阅」留了位置但没接通不显示', async () => {
    expect(AI_SUBSCRIPTION_CARDS.map((c) => [c.provider, c.enabled])).toEqual([
      ['openai-codex', true],
      ['anthropic', false],
    ])
    renderWithProviders(<AiStep onConnected={() => {}} />)
    const card = await screen.findByTestId('ai-card-sub-openai-codex')
    expect(card.textContent).toContain('ChatGPT 订阅')
    expect(screen.queryByTestId('ai-card-sub-anthropic')).toBeNull()
    // 与 DeepSeek 官方卡是兄弟（同一级），排在它后面
    const account = screen.getByTestId('ai-card-account')
    expect(account.parentElement).toBe(card.parentElement)
    expect(account.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('点开是设置页那条订阅登录；登上了就算接上 AI', async () => {
    const user = userEvent.setup()
    const connected: string[] = []
    renderWithProviders(<AiStep onConnected={(how) => connected.push(how)} />)
    await user.click(await screen.findByTestId('ai-pick-sub-openai-codex'))
    expect(await screen.findByTestId('subscription-plan')).toBeTruthy()
    expect(connected).toEqual([])
  })

  it('已经登过 ChatGPT 订阅：卡上打勾，点开就算接上', async () => {
    state.sub = sub({
      signed_in: true,
      account: 'acct…x1',
      models: [{ id: 'gpt-5.5', name: 'GPT-5.5' }],
    })
    const user = userEvent.setup()
    const connected: string[] = []
    renderWithProviders(<AiStep onConnected={(how) => connected.push(how)} />)
    expect(await screen.findByTestId('ai-sub-openai-codex-ok')).toBeTruthy()
    await user.click(screen.getByTestId('ai-pick-sub-openai-codex'))
    await waitFor(() => {
      expect(connected).toContain('subscription')
    })
  })

  it('这台机器用不了订阅登录（公司档 / 托管档）：整张不出', async () => {
    state.sub = sub({ available: false, unavailable_reason: '公司档不能用订阅登录' })
    renderWithProviders(<AiStep onConnected={() => {}} />)
    await screen.findByTestId('ai-card-account')
    await waitFor(() => {
      expect(state.subCalls).toContain('openai-codex')
    })
    expect(screen.queryByTestId('ai-card-sub-openai-codex')).toBeNull()
  })
})

// ── ③ 选岗位 ─────────────────────────────────────────────────────────

const CATALOG: OnboardingPositionView[] = [
  {
    id: 'customer-care',
    name: '客服',
    roles: [
      { id: 'dtc.support', name: '售后客服', default: true, what_it_does: '回客人的邮件' },
      { id: 'dtc.chat', name: '在线客服', default: true, what_it_does: '回网站聊天' },
      { id: 'dtc.review', name: '评价回复', default: false, what_it_does: '回评价' },
    ],
  },
]

describe('WP424 第 ③ 步：类别整组全选 / 全不选', () => {
  const planner = (selected: string[], onSetDuties: (ids: string[], on: boolean) => void) =>
    renderWithProviders(
      <PositionPlanner
        catalog={CATALOG}
        text=""
        onText={() => {}}
        onSuggest={() => {}}
        suggesting={false}
        recommendations={[]}
        board={{ ...EMPTY_BOARD, selected }}
        onToggleDuty={() => {}}
        onSetDuties={onSetDuties}
        onAdopt={() => {}}
        onRegroup={() => {}}
        onBoard={() => {}}
      />,
    )

  it('展开后标题行有「全选」，一次选上这一类全部；计数照旧 n/m', () => {
    const calls: [string[], boolean][] = []
    planner(['dtc.support'], (ids, on) => calls.push([ids, on]))
    // 没展开不出
    expect(screen.queryByTestId('onboarding-category-all')).toBeNull()
    const toggle = screen.getByTestId('onboarding-category-toggle')
    expect(toggle.textContent).toContain('1/3')
    fireEvent.click(toggle)
    const all = screen.getByTestId('onboarding-category-all')
    expect(all.textContent).toBe('全选')
    fireEvent.click(all)
    expect(calls).toEqual([[['dtc.support', 'dtc.chat', 'dtc.review'], true]])
  })

  it('全选上了换成「全不选」，一次去掉这一类全部', () => {
    const calls: [string[], boolean][] = []
    planner(['dtc.support', 'dtc.chat', 'dtc.review'], (ids, on) => calls.push([ids, on]))
    fireEvent.click(screen.getByTestId('onboarding-category-toggle'))
    expect(screen.getByTestId('onboarding-category-toggle').textContent).toContain('3/3')
    const none = screen.getByTestId('onboarding-category-all')
    expect(none.textContent).toBe('全不选')
    fireEvent.click(none)
    expect(calls).toEqual([[['dtc.support', 'dtc.chat', 'dtc.review'], false]])
  })
})

// ── ④ 要连的平台 ─────────────────────────────────────────────────────

describe('WP424 第 ④ 步：要连的平台不挂「必须」', () => {
  const PLAN: OnboardingPlanView = {
    connectors: [
      {
        service: 'shopify_admin',
        label: 'Shopify',
        required: true,
        connected: false,
        needed_by: ['店铺管理'],
      },
      {
        service: 'klaviyo',
        label: 'Klaviyo（邮件营销）',
        required: false,
        connected: false,
        needed_by: ['邮件营销'],
      },
    ],
    skills: [],
    positions: [],
    model_configured: true,
    model_first: false,
    role_ids: ['dtc.store', 'dtc.email-marketing'],
  }

  it('要连的那几条没有「必须」两个字；可选的收在「还有 N 个可选」里、展开挂「可选」', () => {
    renderWithProviders(<PlanList plan={PLAN} />)
    const plan = screen.getByTestId('onboarding-plan')
    expect(plan.textContent).not.toContain('必须')
    const rows = screen.getAllByTestId('onboarding-plan-connector')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.textContent).toContain('Shopify')
    expect(plan.textContent).not.toContain('Klaviyo')
    fireEvent.click(screen.getByTestId('onboarding-plan-optional-toggle'))
    const klaviyo = screen
      .getAllByTestId('onboarding-plan-connector')
      .find((r) => r.textContent?.includes('Klaviyo'))
    expect(klaviyo?.textContent).toContain('可选')
  })
})

// ── 桌面壳的顶栏 ─────────────────────────────────────────────────────

function asDesktop(style: 'inset' | 'overlay'): string[] {
  const themes: string[] = []
  ;(globalThis.window as unknown as { agentsws?: unknown }).agentsws = {
    platform: style === 'inset' ? 'darwin' : 'win32',
    version: '0.2.1',
    titleBar: {
      style,
      setTheme: async (theme: string) => {
        themes.push(theme)
        return true
      },
    },
  }
  return themes
}

function renderShell(): void {
  renderWithProviders(
    <AppShell positions={[]} cards={[]} tileLibrary={[]} onAddTile={() => {}}>
      <div>主区</div>
    </AppShell>,
  )
}

describe('WP424 桌面壳藏了标题栏：顶栏学 Claude', () => {
  it('浏览器里（没有桥 / 老壳没有 titleBar）：不留红绿灯那块空、顶栏不设拖动区', () => {
    expect(desktopChrome()).toBeUndefined()
    ;(globalThis.window as unknown as { agentsws?: unknown }).agentsws = { platform: 'darwin' }
    expect(desktopChrome()).toBeUndefined()
    renderShell()
    const bar = screen.getByTestId('top-bar')
    expect(bar.className).not.toContain('ws-drag')
    expect(bar.getAttribute('data-chrome')).toBeNull()
    expect(screen.getByTestId('rail-brand-row').className).not.toContain('pl-[84px]')
    expect(document.documentElement.hasAttribute('data-shell')).toBe(false)
  })

  it('Mac：顶栏能拖；左栏顶部给红绿灯留位置（与顶栏同高）；主题告诉壳', async () => {
    const themes = asDesktop('inset')
    expect(desktopChrome()).toBe('inset')
    renderShell()
    const bar = screen.getByTestId('top-bar')
    expect(bar.className).toContain('ws-drag')
    expect(bar.getAttribute('data-chrome')).toBe('inset')
    const brand = screen.getByTestId('rail-brand-row')
    expect(brand.className).toContain('pl-[84px]')
    expect(brand.className).toContain('h-11')
    expect(brand.className).toContain('ws-drag')
    // 外壳在：根上那条「没有外壳时的拖动条」收起来
    expect(document.documentElement.getAttribute('data-shell')).toBe('1')
    await waitFor(() => {
      expect(themes).toEqual(['light'])
    })
  })

  it('Windows：右边给三个系统按钮让出（壳没给 env 时按 140px）；左栏顶部不变', () => {
    asDesktop('overlay')
    renderShell()
    const bar = screen.getByTestId('top-bar')
    expect(bar.className).toContain('ws-drag')
    expect(bar.style.paddingRight).toContain('140px')
    expect(screen.getByTestId('rail-brand-row').className).not.toContain('pl-[84px]')
    // WP433（Luoye 10-20 问题 8 后半）：我们那排图标与系统按钮之间留一截空、立一条细竖线
    expect(screen.getByTestId('caption-gap').className).toContain('ml-3')
  })

  it('WP433：Mac 与浏览器里没有那条隔开系统按钮的竖线', () => {
    asDesktop('inset')
    renderShell()
    expect(screen.queryByTestId('caption-gap')).toBeNull()
  })

  it('没有外壳的那几屏顶上有一条拖动区；浏览器里没有', () => {
    const { unmount } = render(<DesktopDragStrip />)
    expect(screen.queryByTestId('desktop-drag-strip')).toBeNull()
    unmount()
    asDesktop('inset')
    render(<DesktopDragStrip />)
    expect(screen.getByTestId('desktop-drag-strip').className).toContain('ws-drag')
  })
})
