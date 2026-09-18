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
 *
 * WP79（09-17 Luoye 看真机截图）再加一组：这一页**精简过**——顶上只有「初始化设置」
 * 一个标题、步骤条是图形化进度条、「加入一家公司」默认折叠成一行、第 ① 步的
 * 「保存并继续」存完自己进第 ② 步。断言的是这些**去掉了什么**，不只是还剩什么。
 */
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ProfileForm } from '@/components/onboarding/profile-form'
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
        id: 'dtc.support',
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
      role_ids: ['dtc.support', 'dtc.refund'],
      already_held: false,
    },
  ],
  model_configured: false,
  model_first: true,
  role_ids: ['dtc.support', 'dtc.refund'],
}

const STATE: OnboardingStateView = {
  needs_setup: true,
  workspace_name: '王岚的工作区',
  brand_name: '王岚的工作区',
  person: { name: '王岚', email: 'wang@nordvolt.cn' },
  other_assignments: 0,
  is_owner: true,
  discovery: { available: true, enabled: true },
  // 48 v2 L2：选项与那一句人话都从服务端来（真源是客服共享包的垂直包）
  verticals: [
    { key: 'goods', label: '实物商品', hint: '要发货的东西，客户会问"到哪了""能不能退"。' },
    {
      key: 'digital',
      label: '虚拟产品与服务',
      hint: '不用发货的东西，客户会问"怎么用""为什么扣费"。',
    },
  ],
  // WP62（51 §1 N0）+ WP79：全发下来，Shopify 与「还没开始搭建」可选
  storefront_platforms: [
    { key: 'shopify', label: 'Shopify', supported: true },
    {
      key: 'none',
      label: '还没开始搭建',
      supported: true,
      hint: '选它就先不连店铺；网站搭好了回设置页改。',
    },
    {
      key: 'woocommerce',
      label: 'WooCommerce',
      supported: false,
      hint: '待增加：现在只支持 Shopify',
    },
    { key: 'magento', label: 'Magento', supported: false, hint: '待增加：现在只支持 Shopify' },
    {
      key: 'other',
      label: '其它 / 自己搭的',
      supported: false,
      hint: '待增加：现在只支持 Shopify',
    },
  ],
}

/** 公司档案已经存下来了的那一档（找同事这件事从这里才开始）。 */
const SAVED: OnboardingStateView = {
  ...STATE,
  profile: {
    legal_name: '深圳诺伏特科技',
    domain: 'nordvolt.cn',
    discoverable: true,
    brand_name: '王岚的工作区',
    vertical: 'goods',
    storefront_platform: 'shopify',
    set_at: '2026-09-07T09:00:00.000Z',
  },
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
  profiles: [] as {
    legal_name: string
    domain?: string
    discoverable?: boolean
    vertical?: 'goods' | 'digital'
    storefront_platform?: 'shopify' | 'none' | 'woocommerce' | 'magento' | 'other'
  }[],
  renames: [] as string[],
  plans: [] as OnboardingPlanInput[],
  applies: [] as OnboardingPlanInput[],
  joins: [] as { code?: string; peer_id?: string; name: string; email: string }[],
  peers: PEERS as DiscoveryStateView,
  /** 这一次渲染时服务端那边的档案设过没有。 */
  state: STATE as OnboardingStateView,
}

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getOnboardingState: async () => state.state,
    listOnboardingPositions: async () => POSITIONS,
    listDiscoveryPeers: async () => state.peers,
    renameMe: async (name: string) => {
      state.renames.push(name)
      state.state = { ...state.state, person: { ...state.state.person, name } }
      return { person: { ...state.state.person, name } }
    },
    setWorkspaceProfile: async (input: {
      legal_name: string
      vertical?: 'goods' | 'digital'
      storefront_platform?: 'shopify' | 'none' | 'woocommerce' | 'magento' | 'other'
    }) => {
      state.profiles.push(input)
      return {
        ...input,
        discoverable: true,
        vertical: input.vertical ?? ('goods' as const),
        storefront_platform: input.storefront_platform ?? ('shopify' as const),
        set_at: '2026-09-07T09:00:00.000Z',
      }
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
  state.renames = []
  state.plans = []
  state.applies = []
  state.joins = []
  state.peers = PEERS
  state.state = STATE
})

/**
 * 走到第 n 步（0 开始）。
 *
 * WP79 ⑥：第 ① 步底下没有「下一步」——那一步往前走的按钮是表单里的
 * 「保存并继续」，存完它自己进第 ② 步。之后几步才是底下那个。
 */
async function goTo(n: number): Promise<void> {
  if (n === 0) return
  const user = userEvent.setup()
  await user.type(await screen.findByTestId('company-legal-name'), '深圳诺伏特科技')
  await user.click(screen.getByTestId('company-save'))
  await screen.findByTestId('onboarding-person')
  for (let i = 1; i < n; i += 1) {
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

  // WP54（48 v2 L2 / 46 §1）
  it('① 公司：「你卖的是」默认实物，改成虚拟产品会跟着公司档案一起存上去', async () => {
    const user = userEvent.setup()
    renderWithProviders(<OnboardingPage />)

    await user.type(await screen.findByTestId('company-legal-name'), '一家 SaaS')
    const goods = screen.getByTestId('company-vertical-goods') as HTMLInputElement
    const digital = screen.getByTestId('company-vertical-digital') as HTMLInputElement
    expect(goods.checked).toBe(true)
    expect(digital.checked).toBe(false)
    // 那句人话来自服务端（真源是垂直包），不是界面自己写的。
    // WP79 ⑤：同一时刻只出**选中那一条**的——另一条由本文件末尾那组用例钉住
    expect(screen.getByText(/要发货的东西/)).toBeTruthy()
    // "选错了 AI 会说外行话"这种解释进 tooltip（36 §7）
    expect(screen.getByTestId('company-vertical-hint').getAttribute('data-hint')).toContain(
      '外行话',
    )

    await user.click(digital)
    await user.click(screen.getByTestId('company-save'))
    await waitFor(() => {
      expect(state.profiles).toHaveLength(1)
    })
    expect(state.profiles[0]?.vertical).toBe('digital')
  })

  // WP62（51 §1 N0 / 46 §1 ①）
  it('① 公司：「网站是用什么搭的」默认 Shopify，接不上的那三个灰显且点不动，带"待增加" tooltip', async () => {
    const user = userEvent.setup()
    renderWithProviders(<OnboardingPage />)

    await user.type(await screen.findByTestId('company-legal-name'), '一家店')
    const shopify = screen.getByTestId('company-platform-shopify') as HTMLInputElement
    const woo = screen.getByTestId('company-platform-woocommerce') as HTMLInputElement
    const magento = screen.getByTestId('company-platform-magento') as HTMLInputElement
    const other = screen.getByTestId('company-platform-other') as HTMLInputElement

    expect(shopify.checked).toBe(true)
    expect(shopify.disabled).toBe(false)
    // 51 §1：接得上的只有 Shopify，那三个灰显——**画出来但点不动**，不是藏起来
    for (const el of [woo, magento, other]) {
      expect(el.disabled).toBe(true)
      expect(el.checked).toBe(false)
    }
    expect(
      screen.getByTestId('company-platform-woocommerce-hint').getAttribute('data-hint'),
    ).toContain('待增加')
    // "选了会怎样"这种解释进 tooltip（36 §7）
    expect(screen.getByTestId('company-platform-hint').getAttribute('data-hint')).toContain(
      'Shopify',
    )

    // 点一下点不动的那个：档案里的平台一个字都不许变
    await user.click(woo)
    expect((screen.getByTestId('company-platform-woocommerce') as HTMLInputElement).checked).toBe(
      false,
    )

    await user.click(screen.getByTestId('company-save'))
    await waitFor(() => {
      expect(state.profiles).toHaveLength(1)
    })
    expect(state.profiles[0]?.storefront_platform).toBe('shopify')
  })

  // WP79 ④（51 §1 N0 第三档）
  it('① 公司：「还没开始搭建」点得动，它那一句说的是"选了会怎样"，不是"待增加"', async () => {
    const user = userEvent.setup()
    renderWithProviders(<OnboardingPage />)

    await user.type(await screen.findByTestId('company-legal-name'), '一家还没建站的公司')
    const none = screen.getByTestId('company-platform-none') as HTMLInputElement
    // 还没有网站的人也得能往下走：它与 Shopify 一样点得动
    expect(none.disabled).toBe(false)
    expect(screen.getByText('还没开始搭建')).toBeTruthy()
    // "我还没有网站"不是"我们还没接这个平台"——那一句不许说成"待增加"
    const hint = screen.getByTestId('company-platform-none-hint').getAttribute('data-hint')
    expect(hint).toContain('先不连店铺')
    expect(hint).not.toContain('待增加')
    // 点得动的那一条不该走"改平台要先问一次"那条路
    const confirm = vi.spyOn(globalThis, 'confirm').mockReturnValue(false)
    await user.click(none)
    expect(confirm).not.toHaveBeenCalled()
    confirm.mockRestore()

    await user.click(screen.getByTestId('company-save'))
    await waitFor(() => {
      expect(state.profiles).toHaveLength(1)
    })
    expect(state.profiles[0]?.storefront_platform).toBe('none')
  })

  it('① 公司全称还没存下来时，说的是"存完就开始找"，而不是"开关关着"（开关明明开着）', async () => {
    renderWithProviders(<OnboardingPage />)
    const peers = await screen.findByTestId('join-peers')
    await waitFor(() => {
      expect(within(peers).getByText(/存完就开始找/)).toBeTruthy()
    })
  })

  it('① 局域网："发现 N 位同事"与邀请码输入都在；申请加入带的是我的名字与邮箱', async () => {
    const user = userEvent.setup()
    state.state = SAVED
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
    const user = userEvent.setup()
    state.peers = { available: true, enabled: false, peers: [] }
    state.state = SAVED
    renderWithProviders(<OnboardingPage />)
    // WP79 ⑤：一个同伴都没看见时这一块是折叠的，展开它再看那一句
    await user.click(await screen.findByTestId('join-toggle'))
    const peers = await screen.findByTestId('join-peers')
    await waitFor(() => {
      expect(within(peers).getByText(/不广播也不监听/)).toBeTruthy()
    })
  })

  it('① 局域网发现起不来：一句人话，不是报错', async () => {
    const user = userEvent.setup()
    state.peers = {
      available: false,
      enabled: true,
      reason: '这台机器没有可用网卡',
      peers: [],
    }
    state.state = SAVED
    renderWithProviders(<OnboardingPage />)
    await user.click(await screen.findByTestId('join-toggle'))
    const peers = await screen.findByTestId('join-peers')
    await waitFor(() => {
      expect(within(peers).getByText(/这台机器没有可用网卡/)).toBeTruthy()
    })
  })

  it('② 名字能改：清掉默认值打自己的，「保存并继续」真存下来再进第 ③ 步', async () => {
    const user = userEvent.setup()
    renderWithProviders(<OnboardingPage />)
    await goTo(1)
    const person = await screen.findByTestId('onboarding-person')
    const name = within(person).getByTestId('person-name') as HTMLInputElement
    expect(name.readOnly).toBe(false)
    await user.clear(name)
    expect(name.value).toBe('')
    await user.type(name, '罗野')
    expect(name.value).toBe('罗野')
    // 登录邮箱仍是身份，只读
    expect((within(person).getByTestId('person-email') as HTMLInputElement).readOnly).toBe(true)
    await user.click(screen.getByTestId('onboarding-next'))
    await waitFor(() => {
      expect(state.renames).toEqual(['罗野'])
    })
    await waitFor(() => {
      expect(screen.queryByTestId('onboarding-person')).toBeNull()
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

  it('④ 「完成」才真建分配；"先跳过"什么都不建', async () => {
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

/**
 * WP79（09-17 Luoye 看真机截图后的意见）：这一页**精简过**。
 *
 * 这一组断言的重点是**去掉了什么**——多写一句话的代价看不见，所以只有把
 * "它不该在那儿"钉成用例，下一次才不会又悄悄长回来。
 */
describe('46 §1 WP79 首次设置精简', () => {
  it('顶上只有「初始化设置」一个标题，导语整段不在了；「先跳过」还在右上角', async () => {
    renderWithProviders(<OnboardingPage />)
    expect(await screen.findByText('初始化设置')).toBeTruthy()
    // 原来那段导语：一个字都不该再出现
    expect(screen.queryByText('先把这三件事说清楚')).toBeNull()
    expect(screen.queryByText(/你们公司叫什么、你是谁、你做什么/)).toBeNull()
    // 退路还在
    expect(screen.getByTestId('onboarding-skip').textContent).toBe('先跳过')
    // 底下那行"第 1 步 / 共 4 步"也去掉了——进度条已经把它画出来了
    expect(screen.queryByText(/共 4 步/)).toBeNull()
  })

  it('步骤条是进度条：四步新名字、当前步高亮、走过的打勾', async () => {
    renderWithProviders(<OnboardingPage />)
    const steps = await screen.findByTestId('onboarding-steps')
    expect(within(steps).getAllByTestId('onboarding-step')).toHaveLength(4)
    expect(steps.textContent).toContain('公司设置')
    expect(steps.textContent).toContain('个人设置')
    expect(steps.textContent).toContain('岗位设置')
    expect(steps.textContent).toContain('初始配置')
    // 一开始：第 ① 步是当前，后面三步都还没轮到，一个勾都没有
    expect(
      within(steps)
        .getAllByTestId('onboarding-step')
        .map((el) => el.getAttribute('data-state')),
    ).toEqual(['current', 'todo', 'todo', 'todo'])
    expect(within(steps).queryByText('已完成')).toBeNull()

    // 走到第 ③ 步：走过的两步打勾，"做完了"与"还没轮到"分得开
    await goTo(2)
    await waitFor(() => {
      expect(
        within(screen.getByTestId('onboarding-steps'))
          .getAllByTestId('onboarding-step')
          .map((el) => el.getAttribute('data-state')),
      ).toEqual(['done', 'done', 'current', 'todo'])
    })
    expect(within(screen.getByTestId('onboarding-steps')).getAllByText('已完成')).toHaveLength(2)
  })

  it('第 ① 步「保存并继续」存完自己进第 ② 步；那一步底下不再摆一个「下一步」', async () => {
    const user = userEvent.setup()
    renderWithProviders(<OnboardingPage />)

    expect((await screen.findByTestId('company-save')).textContent).toBe('保存并继续')
    // 同一句话不摆两遍：第 ① 步底下那一整条不在了
    // （「下一步」是重复的，「上一步」在第 ① 步本来就点不动）
    expect(screen.queryByTestId('onboarding-next')).toBeNull()
    expect(screen.queryByTestId('onboarding-back')).toBeNull()

    await user.type(screen.getByTestId('company-legal-name'), '深圳诺伏特科技')
    await user.click(screen.getByTestId('company-save'))
    // 存完不用再点一下，自己进第 ② 步
    expect(await screen.findByTestId('onboarding-person')).toBeTruthy()
    expect(screen.getByTestId('onboarding-next').textContent).toBe('保存并继续')
    expect(screen.getByTestId('onboarding-back').textContent).toBe('上一步')
  })

  it('最后一步那个按钮说「完成」', async () => {
    const user = userEvent.setup()
    renderWithProviders(<OnboardingPage />)
    await goTo(2)
    await user.click((await screen.findAllByTestId('onboarding-position'))[0] as HTMLElement)
    await user.click(screen.getByTestId('onboarding-next'))
    await screen.findByTestId('onboarding-plan')
    expect(screen.getByTestId('onboarding-finish').textContent).toBe('完成')
  })

  it('灰色小标题「公司」「第一个品牌」在向导里不出；设置页里还在', async () => {
    renderWithProviders(<OnboardingPage />)
    await screen.findByTestId('onboarding-profile')
    expect(screen.queryByText('第一个品牌')).toBeNull()
    // "公司全称""公司邮箱域名"照旧，但单独一个"公司"的分组标题不该有
    const company = screen.getByTestId('profile-company-block')
    expect(within(company).queryByText('公司')).toBeNull()

    // 设置页（不给 `firstBrand`）那一页上下文多，分组是有用的
    renderWithProviders(
      <ProfileForm
        storefrontPlatforms={STATE.storefront_platforms}
        busy={false}
        saved={false}
        onSave={() => undefined}
      />,
    )
    await waitFor(() => {
      expect(screen.getAllByText('公司').length).toBeGreaterThan(0)
    })
    expect(screen.getByText('这个品牌')).toBeTruthy()
    expect(screen.getAllByText('保存公司档案').length).toBeGreaterThan(0)
  })

  it('「加入一家公司」默认折叠成一行「已有邀请码？」；局域网上看见同伴了自己展开', async () => {
    const user = userEvent.setup()
    state.peers = { available: true, enabled: true, peers: [] }
    renderWithProviders(<OnboardingPage />)

    // 折叠着：整块就这一行，输入框与那段说明都不在
    expect((await screen.findByTestId('join-toggle')).textContent).toBe('已有邀请码？')
    expect(screen.queryByTestId('join-code')).toBeNull()
    expect(screen.queryByText('加入一家公司')).toBeNull()
    expect(screen.queryByText(/贴一个同事发的邀请码/)).toBeNull()
    // 那一行"王岚（wang@nordvolt.cn）"也去掉了：他不需要被告知自己是谁
    expect(screen.queryByText(/wang@nordvolt\.cn/)).toBeNull()

    await user.click(screen.getByTestId('join-toggle'))
    expect(await screen.findByTestId('join-code')).toBeTruthy()
  })

  it('局域网上真看见同伴时它自己展开：不用先点那一行', async () => {
    state.state = SAVED
    renderWithProviders(<OnboardingPage />)
    // 有同伴 = 这不再是一个可能性，是一件正在发生的事
    expect(await screen.findByTestId('join-code')).toBeTruthy()
    expect(screen.queryByTestId('join-toggle')).toBeNull()
  })

  it('「你卖的是」只出选中那一条的解释，不是两条都铺出来', async () => {
    const user = userEvent.setup()
    renderWithProviders(<OnboardingPage />)
    await screen.findByTestId('onboarding-profile')

    expect(screen.getByTestId('company-vertical-note').textContent).toContain('要发货的东西')
    expect(screen.queryByText(/不用发货的东西/)).toBeNull()

    await user.click(screen.getByTestId('company-vertical-digital'))
    await waitFor(() => {
      expect(screen.getByTestId('company-vertical-note').textContent).toContain('不用发货的东西')
    })
    expect(screen.queryByText(/要发货的东西/)).toBeNull()
  })

  it('第 ③ 步铺在外面的只有一行说明', async () => {
    renderWithProviders(<OnboardingPage />)
    await goTo(2)
    const roles = await screen.findByTestId('onboarding-roles')
    expect(within(roles).getByText('勾一个岗位 = 它包含的职责全勾上')).toBeTruthy()
    // 每条职责那句"它会干什么"仍然只在 tooltip 里（36 §7）
    expect(within(roles).queryByText('看退款与投诉邮件，拟一份回复给你定。')).toBeNull()
  })
})

/**
 * WP62（51 §1 N0 / 46 §1 末段）：设置页用的是向导里同一个件，只多一个
 * `allowUnsupported`——已经在用别的平台的人要改得动，但改之前要先说清代价。
 */
describe('设置页的公司档案：改成还接不上的平台', () => {
  const platforms = STATE.storefront_platforms

  it('点一个"待增加"的平台会先问一次；点"取消"就一个字不变', async () => {
    const user = userEvent.setup()
    const confirm = vi.spyOn(globalThis, 'confirm').mockReturnValue(false)
    const saved: unknown[] = []
    renderWithProviders(
      <ProfileForm
        profile={{
          legal_name: '一家店',
          discoverable: true,
          brand_name: '一家店',
          vertical: 'goods',
          storefront_platform: 'shopify',
          set_at: '2026-09-07T09:00:00.000Z',
        }}
        storefrontPlatforms={platforms}
        allowUnsupported
        busy={false}
        saved={false}
        onSave={(d) => saved.push(d)}
      />,
    )

    const woo = screen.getByTestId('company-platform-woocommerce') as HTMLInputElement
    // 设置页里点得动（向导里点不动）
    expect(woo.disabled).toBe(false)
    await user.click(woo)
    expect(confirm).toHaveBeenCalledTimes(1)
    // 那一句要把代价说明白：店铺连接会失效
    expect(String(confirm.mock.calls[0]?.[0])).toContain('失效')
    expect((screen.getByTestId('company-platform-woocommerce') as HTMLInputElement).checked).toBe(
      false,
    )
    confirm.mockRestore()
  })

  it('点"确定"才真的改，存下去的是新平台', async () => {
    const user = userEvent.setup()
    const confirm = vi.spyOn(globalThis, 'confirm').mockReturnValue(true)
    const saved: { storefront_platform: string }[] = []
    renderWithProviders(
      <ProfileForm
        profile={{
          legal_name: '一家店',
          discoverable: true,
          brand_name: '一家店',
          vertical: 'goods',
          storefront_platform: 'shopify',
          set_at: '2026-09-07T09:00:00.000Z',
        }}
        storefrontPlatforms={platforms}
        allowUnsupported
        busy={false}
        saved={false}
        onSave={(d) => saved.push(d)}
      />,
    )

    await user.click(screen.getByTestId('company-platform-woocommerce'))
    await user.click(screen.getByTestId('company-save'))
    expect(saved).toHaveLength(1)
    expect(saved[0]?.storefront_platform).toBe('woocommerce')
    confirm.mockRestore()
  })
})
