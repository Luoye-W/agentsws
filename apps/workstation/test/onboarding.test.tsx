/**
 * 首次设置向导（WP51 交付 ⑥，46 §1 四步表 + §2 I3）。
 *
 * 五组断言：
 * 1. 四步走得通：填公司 → 带出自己 → 勾岗位 → 出清单；
 * 2. 勾一个岗位 = 它的职责全勾（前后端同一套算法，这里断言前端那一半）；
 *    展开可以只勾其中几条，那几条会合成一个自定义岗位；
 * 3. 每条职责旁边那句"它会干什么"在 tooltip 里（36 §7），不铺成灰字；
 * 4. 清单每一条的"去连 / 去装"直达对应的卡（`/connections?service=…` / `/skills`），
 *    模型没接时它排第一条；
 * 5. 第 ① 步的开关、邀请码输入与"发现 N 位同事"都在，申请加入发的是真请求；
 *    界面上一个内部 id 都不出。
 */
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  DiscoveryStateView,
  OnboardingPlanInput,
  OnboardingPlanView,
  OnboardingPositionView,
  OnboardingStateView,
} from '@/lib/api'
import { OnboardingPage } from '@/pages/onboarding'
import { renderWithProviders } from './helpers'

const POSITIONS: OnboardingPositionView[] = [
  {
    id: 'pos_cs',
    name: '独立站售后客服',
    roles: [
      {
        id: 'dtc.aftersales',
        name: '售后处理',
        default: true,
        what_it_does: '看退款与投诉邮件，拟一份回复给你定。',
      },
      {
        id: 'dtc.refund',
        name: '退款审核',
        default: true,
        what_it_does: '按店铺规则算该退多少，超出额度的交给你。',
      },
    ],
  },
  {
    id: 'pos_ads',
    name: '投放',
    roles: [
      {
        id: 'dtc.ads',
        name: '广告投放',
        default: true,
        what_it_does: '盯每天的花费与转化，出预算调整建议。',
      },
    ],
  },
]

const PLAN: OnboardingPlanView = {
  connectors: [
    {
      service: 'shopify',
      label: 'Shopify',
      required: true,
      connected: false,
      needed_by: ['售后处理', '退款审核'],
    },
    {
      service: 'imap',
      label: '邮箱',
      required: true,
      connected: true,
      needed_by: ['售后处理'],
    },
  ],
  skills: [{ name: 'aftersales', installed: false, needed_by: ['售后处理'] }],
  positions: [
    {
      position_id: 'pos_cs',
      name: '独立站售后客服',
      role_ids: ['dtc.aftersales', 'dtc.refund'],
      already_held: false,
    },
  ],
  model_configured: false,
  model_first: true,
  role_ids: ['dtc.aftersales', 'dtc.refund'],
}

const STATE: OnboardingStateView = {
  needs_setup: true,
  workspace_name: '王岚的工作区',
  person: { name: '王岚', email: 'wang@nordvolt.cn' },
  other_assignments: 0,
  is_owner: true,
  discovery: { available: true, enabled: true },
}

const PEERS: DiscoveryStateView = {
  available: true,
  enabled: true,
  peers: [
    {
      peer_id: 'peer_abc',
      workspace_label: '李默的工作区 · 3 人',
      host: '10.0.0.2',
      port: 7777,
      first_seen_at: '2026-09-07T09:00:00.000Z',
      last_seen_at: '2026-09-07T09:00:00.000Z',
    },
  ],
}

const state = {
  profiles: [] as { legal_name: string; domain?: string; discoverable?: boolean }[],
  plans: [] as OnboardingPlanInput[],
  applies: [] as OnboardingPlanInput[],
  joins: [] as { code?: string; peer_id?: string; name: string; email: string }[],
  peers: PEERS as DiscoveryStateView,
}

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getOnboardingState: async () => STATE,
    listOnboardingPositions: async () => POSITIONS,
    listDiscoveryPeers: async () => state.peers,
    setWorkspaceProfile: async (input: { legal_name: string }) => {
      state.profiles.push(input)
      return { ...input, discoverable: true, set_at: '2026-09-07T09:00:00.000Z' }
    },
    planOnboarding: async (input: OnboardingPlanInput) => {
      state.plans.push(input)
      return PLAN
    },
    applyOnboarding: async (input: OnboardingPlanInput) => {
      state.applies.push(input)
      return { created_assignments: [], skipped: [], ranges: [], plan: PLAN }
    },
    requestMembership: async (input: {
      code?: string
      peer_id?: string
      name: string
      email: string
    }) => {
      state.joins.push(input)
      return {
        id: 'mrq_1',
        person: { name: input.name, email: input.email },
        via: input.code === undefined ? 'lan' : 'invite',
        status: 'pending',
        created_at: '2026-09-07T09:00:00.000Z',
      }
    },
  }
})

beforeEach(() => {
  state.profiles = []
  state.plans = []
  state.applies = []
  state.joins = []
  state.peers = PEERS
  globalThis.sessionStorage?.clear()
})

/** 走到第 n 步（0 开始）。 */
async function goTo(n: number): Promise<void> {
  const user = userEvent.setup()
  for (let i = 0; i < n; i += 1) {
    await user.click(await screen.findByTestId('onboarding-next'))
  }
}

describe('46 §1 首次设置向导', () => {
  it('① 公司：全称 + 域名 + "让同事找到我"开关；那句安全承诺不藏在 tooltip 里', async () => {
    const user = userEvent.setup()
    renderWithProviders(<OnboardingPage />)

    await user.type(await screen.findByTestId('company-legal-name'), '深圳诺伏特科技有限公司')
    // 域名从登录邮箱带出来（46 §1 表 ①）
    expect((screen.getByTestId('company-domain') as HTMLInputElement).value).toBe('nordvolt.cn')
    expect(screen.getByTestId('company-discoverable')).toBeTruthy()
    // 安全承诺是 36 §7 的可见档：压成一行摆在外面，不许藏
    expect(screen.getByText(/只交换一串哈希/)).toBeTruthy()
    // "写营业执照上的全称"这种解释进 tooltip
    expect(screen.getByTestId('company-name-hint').getAttribute('data-hint')).toContain('营业执照')

    await user.click(screen.getByTestId('company-save'))
    await waitFor(() => {
      expect(state.profiles).toHaveLength(1)
    })
    expect(state.profiles[0]?.legal_name).toBe('深圳诺伏特科技有限公司')
  })

  it('① 局域网："发现 N 位同事"与邀请码输入都在；申请加入带的是我的名字与邮箱', async () => {
    const user = userEvent.setup()
    renderWithProviders(<OnboardingPage />)

    const peers = await screen.findByTestId('join-peers')
    expect(within(peers).getByText(/发现 1 位同事/)).toBeTruthy()
    // 展示名是对方自己报的一句话——没有工作区 id、没有 peer id
    expect(within(peers).getByText('李默的工作区 · 3 人')).toBeTruthy()
    expect(screen.queryByText(/peer_abc/)).toBeNull()

    await user.click(await screen.findByTestId('join-peer'))
    await user.click(screen.getByTestId('join-submit'))
    await waitFor(() => {
      expect(state.joins).toHaveLength(1)
    })
    expect(state.joins[0]).toMatchObject({
      peer_id: 'peer_abc',
      name: '王岚',
      email: 'wang@nordvolt.cn',
    })
    expect(await screen.findByTestId('join-sent')).toBeTruthy()

    // 贴码那条路走的是同一个按钮
    await user.type(screen.getByTestId('join-code'), 'abcd2345')
    await user.click(screen.getByTestId('join-submit'))
    await waitFor(() => {
      expect(state.joins).toHaveLength(2)
    })
    // 码自动大写（用户多半是照着念的抄下来的）
    expect(state.joins[1]?.code).toBe('ABCD2345')
  })

  it('① 开关关着时说清楚"不广播也不监听"，而不是显示一个空列表', async () => {
    state.peers = { available: true, enabled: false, peers: [] }
    renderWithProviders(<OnboardingPage />)
    const peers = await screen.findByTestId('join-peers')
    await waitFor(() => {
      expect(within(peers).getByText(/不广播也不监听/)).toBeTruthy()
    })
  })

  it('① 局域网发现起不来：一句人话，不是报错', async () => {
    state.peers = {
      available: false,
      enabled: true,
      reason: '这台机器没有可用网卡',
      peers: [],
    }
    renderWithProviders(<OnboardingPage />)
    const peers = await screen.findByTestId('join-peers')
    await waitFor(() => {
      expect(within(peers).getByText(/这台机器没有可用网卡/)).toBeTruthy()
    })
  })

  it('② 你：名字与登录邮箱直接带出来，不用再填一遍', async () => {
    renderWithProviders(<OnboardingPage />)
    await goTo(1)
    const person = await screen.findByTestId('onboarding-person')
    expect((within(person).getByTestId('person-name') as HTMLInputElement).value).toBe('王岚')
    expect((within(person).getByTestId('person-email') as HTMLInputElement).value).toBe(
      'wang@nordvolt.cn',
    )
  })

  it('③ 勾一个岗位 = 它的职责全勾上；没勾满一条不让往下走', async () => {
    const user = userEvent.setup()
    renderWithProviders(<OnboardingPage />)
    await goTo(2)

    // 一条都没勾 → "下一步"按不动
    expect(await screen.findByTestId('onboarding-role-count')).toHaveProperty(
      'textContent',
      expect.stringContaining('至少勾一条'),
    )
    expect((screen.getByTestId('onboarding-next') as HTMLButtonElement).disabled).toBe(true)

    const positions = await screen.findAllByTestId('onboarding-position')
    await user.click(positions[0] as HTMLElement)
    // 售后客服包含两条职责 → 勾岗位就是 2 条
    await waitFor(() => {
      expect(screen.getByTestId('onboarding-role-count').textContent).toContain('已勾 2 条')
    })
    expect((screen.getByTestId('onboarding-next') as HTMLButtonElement).disabled).toBe(false)
  })

  it('③ 展开只勾一条职责 → 问它叫什么，默认"我的岗位"；每条职责的解释进 tooltip', async () => {
    const user = userEvent.setup()
    renderWithProviders(<OnboardingPage />)
    await goTo(2)

    await user.click((await screen.findAllByTestId('onboarding-expand'))[0] as HTMLElement)
    const roles = await screen.findAllByTestId('onboarding-role')
    await user.click(roles[0] as HTMLElement)

    await waitFor(() => {
      expect(screen.getByTestId('onboarding-role-count').textContent).toContain('已勾 1 条')
    })
    // 46 §3 I6：只勾职责 → 一个自定义岗位，名字用户填
    const custom = screen.getByTestId('onboarding-custom') as HTMLInputElement
    expect(custom.placeholder).toBe('我的岗位')
    // 36 §7：那句"它会干什么"在 tooltip 里，不铺成灰字
    const hints = screen.getAllByTestId('onboarding-role-hint')
    expect(hints[0]?.getAttribute('data-hint')).toContain('退款与投诉邮件')
    expect(screen.queryByText('看退款与投诉邮件，拟一份回复给你定。')).toBeNull()
  })

  it('④ 清单：模型没接排第一条，每项"去连 / 去装"直达对应的卡；已连的不再给按钮', async () => {
    const user = userEvent.setup()
    renderWithProviders(<OnboardingPage />)
    await goTo(2)
    await user.click((await screen.findAllByTestId('onboarding-position'))[0] as HTMLElement)
    await user.click(screen.getByTestId('onboarding-next'))

    const plan = await screen.findByTestId('onboarding-plan')
    // 模型那一条排在最前面
    const model = within(plan).getByTestId('onboarding-plan-model')
    expect(plan.firstElementChild).toBe(model)
    expect(within(model).getByText('去接').closest('a')?.getAttribute('href')).toBe('/settings')

    const connectors = within(plan).getAllByTestId('onboarding-plan-connector')
    // 没连的给"去连"，链接直达连接页那张卡
    expect(
      within(connectors[0] as HTMLElement)
        .getByText('去连')
        .closest('a')
        ?.getAttribute('href'),
    ).toBe('/connections?service=shopify')
    // 已连的只说"已连"，不再给按钮
    expect(within(connectors[1] as HTMLElement).queryByText('去连')).toBeNull()
    expect(within(connectors[1] as HTMLElement).getByText('已连')).toBeTruthy()

    const skill = within(plan).getByTestId('onboarding-plan-skill')
    expect(within(skill).getByText('去装').closest('a')?.getAttribute('href')).toBe('/skills')

    // 清单是按同一份勾选算的：发给服务端的就是界面上勾的那个岗位
    expect(state.plans.at(-1)).toMatchObject({ position_ids: ['pos_cs'], role_ids: [] })
  })

  it('④ "就这样，开始用"才真建分配；"先跳过"什么都不建', async () => {
    const user = userEvent.setup()
    renderWithProviders(<OnboardingPage />)
    await goTo(2)
    await user.click((await screen.findAllByTestId('onboarding-position'))[0] as HTMLElement)
    await user.click(screen.getByTestId('onboarding-next'))
    await screen.findByTestId('onboarding-plan')

    expect(state.applies).toHaveLength(0)
    await user.click(screen.getByTestId('onboarding-finish'))
    await waitFor(() => {
      expect(state.applies).toHaveLength(1)
    })
    expect(state.applies[0]).toMatchObject({ position_ids: ['pos_cs'] })
  })

  it('随时可以"先跳过"：不落任何东西，这一次会话里不再拦', async () => {
    const user = userEvent.setup()
    renderWithProviders(<OnboardingPage />)
    await user.click(await screen.findByTestId('onboarding-skip'))
    expect(state.profiles).toHaveLength(0)
    expect(state.applies).toHaveLength(0)
    const { onboardingSkipped } = await import('@/pages/onboarding')
    expect(onboardingSkipped()).toBe(true)
  })
})
