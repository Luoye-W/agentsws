/**
 * 首次设置向导（70 §1 的新四步，WP121b；替掉 WP51 / WP79 那份按旧四步钉的）。
 *
 * **① 接上 AI → ② 你的生意 → ③ 选岗位 → ④ 连接与开工。**
 *
 * 八组断言：
 *
 * 1. 四步走得通，进度条说的是新的四件事；
 * 2. 第 ① 步**不能跳过**：没接上 AI 那个「下一步」按不动；「先逛逛演示数据」是唯一的旁路；
 * 3. 官方接口那条路：发登录信 → 轮询 → 关联上了自动启用云模型、把各能力开关切过去、
 *    显示到账的积分；
 * 4. 自有模型那条路：存完**当场试跑**，通了才放行；不通说的是 70 §2.2 那四句人话之一；
 * 5. 第 ② 步：贴网址 → 后台跑（呼吸标记）→ 可以先去第 ③ 步再回来 → 档案卡 →
 *    只把改过的那几格发上去；超预算停下来也照样给卡；「还没有网站」旁路；
 *    用官方接口时明说一句"内容会经过我们的云"；
 * 6. 第 ③ 步按分析结果**预勾**（70 §5），用户动过手之后不再覆盖；
 * 7. 第 ④ 步那张清单与完成屏（WP51 / WP112 原有的那几条，一条没删）；
 * 8. 「加入一家公司」跟着"公司"这件事挪到第 ② 步——挪了位置不等于换了行为。
 *
 * 末尾那一组是**从旧文件整组搬过来的** `ProfileForm`：它不在向导里了（问的东西
 * 并进了第 ② 步那一轮分析），但设置页还在用它，那一页的行为一条都没变。
 */
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { modelTestKey } from '@/components/onboarding/ai-step'
import { presetPick } from '@/components/onboarding/preset-roles'
import { ProfileForm } from '@/components/onboarding/profile-form'
import type {
  BrandIntakeRun,
  CapabilitySourceSettings,
  CloudAccountView,
  CloudCreditsView,
  DiscoveryStateView,
  ModelProviderTemplate,
  ModelProviderView,
  ModelTestResult,
  OnboardingPlanInput,
  OnboardingPlanView,
  OnboardingPositionView,
  OnboardingStateView,
} from '@/lib/api'
import { OnboardingPage } from '@/pages/onboarding'
import { renderWithProviders } from './helpers'

const T0 = '2026-09-19T09:00:00.000Z'

/** 三个岗位，id 与 `apps/server/src/org.ts` 的种子表一致（预勾按它认）。 */
const POSITIONS: OnboardingPositionView[] = [
  {
    id: 'web-ops',
    name: '网站运营',
    roles: [
      { id: 'dtc.store', name: '店铺管理', default: true, what_it_does: '盯商品与价格。' },
      { id: 'dtc.content', name: '内容与博客', default: true, what_it_does: '写站内文章。' },
    ],
  },
  {
    id: 'customer-care',
    name: '客服',
    roles: [
      {
        id: 'dtc.support',
        name: '网站客服',
        default: true,
        what_it_does: '看退款与投诉邮件，拟一份回复给你定。',
      },
      { id: 'amz.support', name: 'Amazon 客服', default: true, what_it_does: '答买家消息。' },
    ],
  },
  {
    id: 'social-media',
    name: '社媒运营',
    roles: [
      { id: 'social.meta', name: 'Meta', default: true, what_it_does: '发帖与回评论。' },
      { id: 'social.tiktok', name: 'TikTok', default: true, what_it_does: '发短视频。' },
      { id: 'social.reddit', name: 'Reddit', default: false, what_it_does: '看版聊。' },
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
      needed_by: ['店铺管理'],
    },
    { service: 'imap', label: '邮箱', required: true, connected: true, needed_by: ['网站客服'] },
  ],
  skills: [{ name: 'aftersales', installed: false, needed_by: ['网站客服'] }],
  positions: [
    {
      position_id: 'customer-care',
      name: '客服',
      role_ids: ['dtc.support', 'amz.support'],
      already_held: false,
    },
  ],
  model_configured: false,
  model_first: true,
  role_ids: ['dtc.support', 'amz.support'],
}

const STATE: OnboardingStateView = {
  needs_setup: true,
  workspace_name: '王岚的工作区',
  brand_name: '王岚的工作区',
  person: { name: '王岚', email: 'wang@nordvolt.cn' },
  other_assignments: 0,
  is_owner: true,
  discovery: { available: true, enabled: true },
  verticals: [
    { key: 'goods', label: '实物商品', hint: '要发货的东西，客户会问"到哪了""能不能退"。' },
    {
      key: 'digital',
      label: '虚拟产品与服务',
      hint: '不用发货的东西，客户会问"怎么用""为什么扣费"。',
    },
  ],
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
    set_at: '2026-09-19T09:00:00.000Z',
  },
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
      first_seen_at: T0,
      last_seen_at: T0,
    },
  ],
}

const CLOUD_TEMPLATE: ModelProviderTemplate = {
  kind: 'agentsws_cloud',
  label: 'Agents 工坊云（用积分）',
  summary: '什么都不用准备。',
  default_base_url: 'https://cloud.agentsws.dev',
  default_model: 'deepseek-flash',
  region: 'cn',
  steps: [],
  links: [],
}

const DEEPSEEK_TEMPLATE: ModelProviderTemplate = {
  kind: 'deepseek',
  label: 'DeepSeek 官方',
  summary: '国内直连、便宜、够用。',
  default_base_url: 'https://api.deepseek.com',
  default_model: 'deepseek-chat',
  region: 'cn',
  steps: ['注册登录', '创建 API key'],
  links: [{ label: 'DeepSeek 开放平台', url: 'https://platform.deepseek.com/api_keys' }],
}

const CLOUD_PROVIDER: ModelProviderView = {
  id: 'agentsws',
  kind: 'agentsws_cloud',
  label: 'Agents 工坊云',
  base_url: 'https://cloud.agentsws.dev',
  model: 'deepseek-flash',
  region: 'cn',
  has_key: false,
  active: true,
}

/** 一次跑完的分析：Shopify 官网 + 两条社媒。 */
function websiteRun(overrides: Partial<BrandIntakeRun> = {}): BrandIntakeRun {
  return {
    id: 'bi_1',
    schema_version: 1,
    workspace_id: 'ws_1',
    status: 'awaiting_confirm',
    inputs: [{ url: 'https://nordvolt.cn', kind: 'website' }],
    pages: [
      { url: 'https://nordvolt.cn/', kind: 'home', ok: true },
      { url: 'https://nordvolt.cn/pages/about', kind: 'about', ok: true },
    ],
    budget: { estimated_credits: 1.2, cap_credits: 2, spent_credits: 1.2 },
    profile: {
      brand_name: {
        value: '诺伏特户外',
        confidence: 'high',
        evidence: [{ url: 'https://nordvolt.cn/', locator: 'jsonld:Organization.name' }],
      },
      one_liner: {
        value: '给露营的人做电',
        confidence: 'low',
        evidence: [{ url: 'https://nordvolt.cn/', locator: 'og:description' }],
      },
      storefront_platform: {
        value: 'shopify',
        confidence: 'medium',
        evidence: [{ url: 'https://nordvolt.cn/', locator: 'page:cdn.shopify.com' }],
      },
      social_links: {
        value: [
          { platform: 'instagram', url: 'https://instagram.com/nordvolt' },
          { platform: 'tiktok', url: 'https://tiktok.com/@nordvolt' },
        ],
        confidence: 'medium',
        evidence: [{ url: 'https://nordvolt.cn/', locator: 'selector:a[href]' }],
      },
    },
    created_at: T0,
    updated_at: T0,
    ...overrides,
  }
}

const state = {
  renames: [] as string[],
  profiles: [] as { legal_name: string }[],
  plans: [] as OnboardingPlanInput[],
  applies: [] as OnboardingPlanInput[],
  joins: [] as { code?: string; peer_id?: string; name: string; email: string }[],
  peers: PEERS as DiscoveryStateView,
  state: STATE as OnboardingStateView,
  /** 云账号：测试里靠改它模拟"用户去邮箱点了那条链接"。 */
  account: { linked: false, cloud_base_url: 'https://cloud.agentsws.dev' } as CloudAccountView,
  links: [] as string[],
  credits: { linked: false } as CloudCreditsView,
  providers: [] as ModelProviderView[],
  savedProviders: [] as { id: string; input: { kind: string; model: string; api_key?: string } }[],
  capabilities: { ai: 'mine', storage: 'mine' } as Record<string, 'mine' | 'agentsws'>,
  capabilityWrites: [] as Record<string, string>[],
  test: { ok: true, reason: 'ok', checked_at: T0 } as ModelTestResult,
  /** 分析：起了几次、当前那一次长什么样、确认时带上来的 edits。 */
  starts: [] as { urls: string[] }[],
  reanalyzes: [] as { id: string; urls?: string[] }[],
  confirms: [] as { id: string; edits?: Record<string, unknown> }[],
  run: undefined as BrandIntakeRun | undefined,
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
    setWorkspaceProfile: async (input: { legal_name: string }) => {
      state.profiles.push(input)
      return { ...input, discoverable: true, set_at: T0 }
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
        created_at: T0,
      }
    },
    // ── 第 ① 步 ────────────────────────────────────────────────
    listModelProviders: async () => ({
      providers: state.providers,
      templates: [CLOUD_TEMPLATE, DEEPSEEK_TEMPLATE],
    }),
    getCloudAccount: async () => state.account,
    getCloudCredits: async () => state.credits,
    linkCloudAccount: async (email: string) => {
      state.links.push(email)
      return { expires_at: T0, delivered: 'email' as const }
    },
    saveModelProvider: async (
      id: string,
      input: { kind: string; model: string; api_key?: string },
    ) => {
      state.savedProviders.push({ id, input })
      if (input.kind === 'agentsws_cloud') state.providers = [CLOUD_PROVIDER]
      return { ...CLOUD_PROVIDER, id, kind: input.kind as ModelProviderView['kind'] }
    },
    testModelProvider: async () => state.test,
    getCapabilitySources: async (): Promise<CapabilitySourceSettings> => ({
      workspace_id: 'ws_1',
      capability_sources: state.capabilities,
    }),
    setCapabilitySources: async (next: Record<string, string>) => {
      state.capabilityWrites.push(next)
      return { workspace_id: 'ws_1', capability_sources: next }
    },
    // ── 第 ② 步 ────────────────────────────────────────────────
    latestBrandIntake: async () => state.run ?? null,
    getBrandIntake: async () => {
      if (state.run === undefined) throw new Error('没有这一次分析')
      return state.run
    },
    startBrandIntake: async (input: { urls: string[] }) => {
      state.starts.push(input)
      state.run = {
        ...websiteRun(),
        status: 'running',
        pages: [],
        inputs: input.urls.map((url) => ({
          url,
          kind: url.includes('amazon.') ? ('amazon_listing' as const) : ('website' as const),
        })),
      }
      return state.run
    },
    reanalyzeBrandIntake: async (id: string, urls?: string[]) => {
      state.reanalyzes.push({ id, ...(urls === undefined ? {} : { urls }) })
      state.run = { ...websiteRun(), status: 'running', pages: [] }
      return state.run
    },
    confirmBrandIntake: async (id: string, edits?: Record<string, unknown>) => {
      state.confirms.push({ id, ...(edits === undefined ? {} : { edits }) })
      state.run = { ...(state.run ?? websiteRun()), status: 'confirmed' }
      return state.run
    },
  }
})

beforeEach(() => {
  state.renames = []
  state.profiles = []
  state.plans = []
  state.applies = []
  state.joins = []
  state.peers = PEERS
  state.state = STATE
  state.account = { linked: false, cloud_base_url: 'https://cloud.agentsws.dev' }
  state.links = []
  state.credits = { linked: false }
  state.providers = []
  state.savedProviders = []
  state.capabilities = { ai: 'mine', storage: 'mine' }
  state.capabilityWrites = []
  state.test = { ok: true, reason: 'ok', checked_at: T0 }
  state.starts = []
  state.reanalyzes = []
  state.confirms = []
  state.run = undefined
})

/** 走完第 ① 步（走演示旁路——四条路里最短的那条，而且不落任何东西）。 */
async function passAi(): Promise<void> {
  const user = userEvent.setup()
  await user.click(await screen.findByTestId('ai-demo'))
  await screen.findByTestId('onboarding-business')
}

describe('70 §1 新四步', () => {
  it('进度条说的是新的四件事：接上 AI / 你的生意 / 选岗位 / 连接与开工', async () => {
    renderWithProviders(<OnboardingPage />)
    const steps = await screen.findByTestId('onboarding-steps')
    expect(within(steps).getAllByTestId('onboarding-step')).toHaveLength(4)
    expect(steps.textContent).toContain('接上 AI')
    expect(steps.textContent).toContain('你的生意')
    expect(steps.textContent).toContain('选岗位')
    expect(steps.textContent).toContain('连接与开工')
    // 旧四步的名字一个都不该再出现
    expect(steps.textContent).not.toContain('公司设置')
    expect(steps.textContent).not.toContain('个人设置')
    expect(
      within(steps)
        .getAllByTestId('onboarding-step')
        .map((el) => el.getAttribute('data-state')),
    ).toEqual(['current', 'todo', 'todo', 'todo'])
  })

  it('走过的步骤打勾，"做完了"与"还没轮到"分得开', async () => {
    const user = userEvent.setup()
    renderWithProviders(<OnboardingPage />)
    await passAi()
    await user.click(screen.getByTestId('intake-no-site'))
    await user.click(screen.getByTestId('onboarding-next'))
    await screen.findByTestId('onboarding-roles')
    await waitFor(() => {
      expect(
        within(screen.getByTestId('onboarding-steps'))
          .getAllByTestId('onboarding-step')
          .map((el) => el.getAttribute('data-state')),
      ).toEqual(['done', 'done', 'current', 'todo'])
    })
    expect(within(screen.getByTestId('onboarding-steps')).getAllByText('已完成')).toHaveLength(2)
  })

  it('顶上只有「初始化设置」一个标题；「先跳过」在右上角，导语整段不在', async () => {
    renderWithProviders(<OnboardingPage />)
    expect(await screen.findByText('初始化设置')).toBeTruthy()
    expect(screen.queryByText('先把这三件事说清楚')).toBeNull()
    expect(screen.queryByText(/你们公司叫什么、你是谁、你做什么/)).toBeNull()
    expect(screen.getByTestId('onboarding-skip').textContent).toBe('先跳过')
    expect(screen.queryByText(/共 4 步/)).toBeNull()
  })

  it('第 ① 步页头带一段「集结」，往后几步不再播', async () => {
    renderWithProviders(<OnboardingPage />)
    const head = await screen.findByRole('heading', { level: 1 })
    expect(head.querySelector('svg[data-testid="brand-mark"]')?.getAttribute('data-motion')).toBe(
      'assemble',
    )
    await passAi()
    expect(
      (await screen.findByRole('heading', { level: 1 })).querySelector(
        'svg[data-testid="brand-mark"]',
      ),
    ).toBeNull()
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

describe('70 §2 第 ① 步：接上 AI', () => {
  it('两张大卡摆着；没接上就不往下走', async () => {
    renderWithProviders(<OnboardingPage />)
    expect(await screen.findByTestId('ai-card-official')).toBeTruthy()
    expect(screen.getByTestId('ai-card-own')).toBeTruthy()
    // 这一步不能跳过：接上之前那个按钮按不动
    expect((screen.getByTestId('onboarding-next') as HTMLButtonElement).disabled).toBe(true)
    // 第一步没有「上一步」——一个点不动的按钮比没有它更糟
    expect(screen.queryByTestId('onboarding-back')).toBeNull()
  })

  it('两张卡默认都收着：点中哪张才展开哪张的正文', async () => {
    const user = userEvent.setup()
    renderWithProviders(<OnboardingPage />)
    await screen.findByTestId('ai-card-official')
    expect(screen.queryByTestId('ai-official-email')).toBeNull()
    expect(screen.queryByTestId('model-form')).toBeNull()

    await user.click(screen.getByTestId('ai-pick-official'))
    expect(await screen.findByTestId('ai-official-email')).toBeTruthy()
    expect(screen.queryByTestId('model-form')).toBeNull()

    await user.click(screen.getByTestId('ai-pick-own'))
    expect(await screen.findByTestId('model-form')).toBeTruthy()
    expect(screen.queryByTestId('ai-official-email')).toBeNull()
  })

  it('官方接口：发登录信之后说"去邮箱点那条链接"，不跳转也不弹窗', async () => {
    const user = userEvent.setup()
    renderWithProviders(<OnboardingPage />)
    await user.click(await screen.findByTestId('ai-pick-official'))
    await user.type(screen.getByTestId('ai-official-email'), 'wang@nordvolt.cn')
    await user.click(screen.getByTestId('ai-official-send'))

    await waitFor(() => {
      expect(state.links).toEqual(['wang@nordvolt.cn'])
    })
    expect((await screen.findByTestId('ai-official-sent')).textContent).toContain(
      '去邮箱点那条链接',
    )
    // 真正的下一步在用户的邮箱里：这一页这时还没接上
    expect((screen.getByTestId('onboarding-next') as HTMLButtonElement).disabled).toBe(true)
  })

  it('官方接口：点开登录信回来 → 自动启用云模型、各能力开关切过去、显示到账 10 积分', async () => {
    const user = userEvent.setup()
    // 用户已经点过那条链接了：这一次渲染问到的就是"关联上了"
    state.account = {
      linked: true,
      email: 'wang@nordvolt.cn',
      cloud_base_url: 'https://cloud.agentsws.dev',
    }
    state.credits = {
      linked: true,
      balance: {
        org_id: 'org_1',
        purchased: 0,
        granted: 10,
        available: 10,
        reserved: 0,
        expiring: [],
        low_balance_threshold: 1,
        low_balance: false,
        at: T0,
      },
    }
    renderWithProviders(<OnboardingPage />)
    await user.click(await screen.findByTestId('ai-pick-official'))

    // 这几下是我们替他做的：他按的是「发登录信」，不是"启用云模型"
    await waitFor(() => {
      expect(state.savedProviders.map((p) => p.input.kind)).toContain('agentsws_cloud')
    })
    await waitFor(() => {
      expect(state.capabilityWrites.at(-1)).toEqual({ ai: 'agentsws', storage: 'agentsws' })
    })
    expect((await screen.findByTestId('ai-official-credits')).textContent).toContain('10')
    await waitFor(() => {
      expect((screen.getByTestId('onboarding-next') as HTMLButtonElement).disabled).toBe(false)
    })
  })

  it('自有模型：存完当场试跑，通了才放行；key 一个字节都不留在页面上', async () => {
    const user = userEvent.setup()
    renderWithProviders(<OnboardingPage />)
    await user.click(await screen.findByTestId('ai-pick-own'))
    const form = await screen.findByTestId('model-form')
    await user.type(within(form).getByLabelText('API key'), 'sk-never-leaks-0001')
    await user.click(within(form).getByRole('button', { name: '保存' }))

    expect(await screen.findByTestId('ai-own-ok')).toBeTruthy()
    expect(state.savedProviders.at(-1)?.input.api_key).toBe('sk-never-leaks-0001')
    expect(document.body.innerHTML).not.toContain('sk-never-leaks-0001')
    await waitFor(() => {
      expect((screen.getByTestId('onboarding-next') as HTMLButtonElement).disabled).toBe(false)
    })
  })

  it('自有模型：试跑不通说人话（密钥错），而且仍然不让往下走', async () => {
    const user = userEvent.setup()
    state.test = {
      ok: false,
      reason: 'provider_unavailable',
      detail: 'API key 不对或者已经失效（HTTP 401 unauthorized）',
      checked_at: T0,
    }
    renderWithProviders(<OnboardingPage />)
    await user.click(await screen.findByTestId('ai-pick-own'))
    const form = await screen.findByTestId('model-form')
    await user.type(within(form).getByLabelText('API key'), 'sk-wrong')
    await user.click(within(form).getByRole('button', { name: '保存' }))

    const failed = await screen.findByTestId('ai-own-failed')
    expect(failed.textContent).toContain('密钥不对')
    // 不通 = 没接上：这一步照样过不去
    expect((screen.getByTestId('onboarding-next') as HTMLButtonElement).disabled).toBe(true)
  })

  it('WP127 自有模型：文字通了但看不了图——不放行，说人话并列常见能看图的型号', async () => {
    const user = userEvent.setup()
    state.test = {
      ok: false,
      reason: 'no_vision',
      detail: '这个模型看不了图',
      checked_at: T0,
      vision: false,
      steps: [
        { step: 'connect', ok: true },
        { step: 'text', ok: true },
        { step: 'vision', ok: false },
      ],
    }
    renderWithProviders(<OnboardingPage />)
    await user.click(await screen.findByTestId('ai-pick-own'))
    const form = await screen.findByTestId('model-form')
    await user.type(within(form).getByLabelText('API key'), 'sk-text-only')
    await user.click(within(form).getByRole('button', { name: '保存' }))

    const failed = await screen.findByTestId('ai-own-failed')
    expect(failed.dataset.kind).toBe('vision')
    expect(failed.textContent).toContain('看不了图')
    expect(failed.textContent).toContain('gpt-4o')
    // 三步小清单：卡在第三格
    const steps = screen.getByTestId('model-check-steps')
    expect(steps.querySelector('[data-step="vision"]')?.getAttribute('data-ok')).toBe('false')
    expect((screen.getByTestId('onboarding-next') as HTMLButtonElement).disabled).toBe(true)
  })

  // 70 §2.2 那张表：四种实际情况各对一句人话
  it('试跑失败那四句：密钥 / 余额 / 地址 / 代理，各认各的', () => {
    const at = { checked_at: T0 }
    expect(modelTestKey({ ok: false, reason: 'no_key', ...at })).toBe('onboarding.ai.own.err.key')
    expect(
      modelTestKey({ ok: false, reason: 'provider_error', detail: 'HTTP 403 forbidden', ...at }),
    ).toBe('onboarding.ai.own.err.key')
    expect(
      modelTestKey({
        ok: false,
        reason: 'provider_error',
        detail: 'HTTP 402 insufficient balance',
        ...at,
      }),
    ).toBe('onboarding.ai.own.err.balance')
    expect(
      modelTestKey({
        ok: false,
        reason: 'provider_unavailable',
        detail: 'connect ENOTFOUND api.example.com',
        ...at,
      }),
    ).toBe('onboarding.ai.own.err.address')
    expect(
      modelTestKey({ ok: false, reason: 'provider_unavailable', detail: 'request timeout', ...at }),
    ).toBe('onboarding.ai.own.err.timeout')
    // 认不出来的不硬套一句：说"没通"，让人把三样再核一遍
    expect(modelTestKey({ ok: false, reason: 'provider_error', detail: '???', ...at })).toBe(
      'onboarding.ai.own.err.other',
    )
  })

  it('「先逛逛演示数据」是唯一的旁路：不接模型也走得到第 ② 步，且不落任何东西', async () => {
    renderWithProviders(<OnboardingPage />)
    await passAi()
    expect(screen.getByTestId('onboarding-business')).toBeTruthy()
    expect(state.savedProviders).toHaveLength(0)
    expect(state.links).toHaveLength(0)
  })
})

describe('70 §3 第 ② 步：贴一个网址', () => {
  it('开跑前把封顶说在按钮旁边；发起时带的是贴进去的那条链接', async () => {
    const user = userEvent.setup()
    renderWithProviders(<OnboardingPage />)
    await passAi()

    expect((await screen.findByTestId('intake-estimate')).textContent).toContain('2')
    await user.type(screen.getByTestId('intake-url'), 'https://nordvolt.cn')
    await user.click(screen.getByTestId('intake-start'))
    await waitFor(() => {
      expect(state.starts).toEqual([{ urls: ['https://nordvolt.cn'] }])
    })
  })

  it('用官方接口时明说一句"内容会经过我们的云"', async () => {
    const user = userEvent.setup()
    state.account = {
      linked: true,
      email: 'wang@nordvolt.cn',
      cloud_base_url: 'https://cloud.agentsws.dev',
    }
    state.credits = { linked: true }
    renderWithProviders(<OnboardingPage />)
    await user.click(await screen.findByTestId('ai-pick-official'))
    await waitFor(() => {
      expect((screen.getByTestId('onboarding-next') as HTMLButtonElement).disabled).toBe(false)
    })
    await user.click(screen.getByTestId('onboarding-next'))
    expect((await screen.findByTestId('intake-cloud-note')).textContent).toContain('经过我们的云')
  })

  it('用自己的模型接口时那一句不出现——那时它不经我们的云', async () => {
    renderWithProviders(<OnboardingPage />)
    await passAi()
    await screen.findByTestId('intake-url')
    expect(screen.queryByTestId('intake-cloud-note')).toBeNull()
  })

  it('跑着的时候是呼吸标记（Agent 在干活），可以先去第 ③ 步，回来结果还在', async () => {
    const user = userEvent.setup()
    renderWithProviders(<OnboardingPage />)
    await passAi()
    await user.type(screen.getByTestId('intake-url'), 'https://nordvolt.cn')
    await user.click(screen.getByTestId('intake-start'))

    const working = await screen.findByTestId('intake-working')
    expect(
      working.querySelector('svg[data-testid="brand-mark"]')?.getAttribute('data-motion'),
    ).toBe('breathe')
    // 分析在后台跑：这一步本来就可以先走开
    await user.click(screen.getByTestId('onboarding-next'))
    await screen.findByTestId('onboarding-roles')
    // 回来：现场按最近那一次恢复（这时它已经跑完了）
    state.run = { ...websiteRun(), status: 'awaiting_confirm' }
    await user.click(screen.getByTestId('onboarding-back'))
    expect(await screen.findByTestId('brand-profile-card')).toBeTruthy()
  })

  it('档案卡：改过的那一格确认时发上去，没改的一格都不发', async () => {
    const user = userEvent.setup()
    state.run = websiteRun()
    renderWithProviders(<OnboardingPage />)
    await passAi()

    const card = await screen.findByTestId('brand-profile-card')
    expect(within(card).getByTestId('intake-value-brand_name').textContent).toBe('诺伏特户外')
    // 低把握的那一格挂「请确认」，高把握的不挂
    expect(within(card).queryByTestId('intake-tag-brand_name')).toBeNull()
    expect(within(card).getByTestId('intake-tag-one_liner').textContent).toBe('请确认')

    await user.click(within(card).getByTestId('intake-edit-one_liner'))
    await user.type(screen.getByTestId('intake-input-one_liner'), '！')
    await user.click(screen.getByTestId('intake-confirm'))

    await waitFor(() => {
      expect(state.confirms).toHaveLength(1)
    })
    expect(state.confirms[0]?.edits).toEqual({ one_liner: '给露营的人做电！' })
    expect(Object.keys(state.confirms[0]?.edits ?? {})).toEqual(['one_liner'])
  })

  it('一格都没改时，确认那一发不带 edits', async () => {
    const user = userEvent.setup()
    state.run = websiteRun()
    renderWithProviders(<OnboardingPage />)
    await passAi()
    await user.click(await screen.findByTestId('intake-confirm'))
    await waitFor(() => {
      expect(state.confirms).toHaveLength(1)
    })
    expect(state.confirms[0]?.edits).toBeUndefined()
  })

  it('「重新分析」走的是另一条路（不是再发起一次）', async () => {
    const user = userEvent.setup()
    state.run = websiteRun()
    renderWithProviders(<OnboardingPage />)
    await passAi()
    await user.click(await screen.findByTestId('intake-reanalyze'))
    await waitFor(() => {
      expect(state.reanalyzes).toHaveLength(1)
    })
    expect(state.starts).toHaveLength(0)
  })

  it('花到封顶就停——但已经抓到的照样给', async () => {
    state.run = websiteRun({
      status: 'budget_exceeded',
      budget: { estimated_credits: 2.4, cap_credits: 2, spent_credits: 2 },
    })
    renderWithProviders(<OnboardingPage />)
    await passAi()
    expect((await screen.findByTestId('intake-capped')).textContent).toContain('2')
    // 两头落空是最糟的：停下来也得把读到的交出去
    expect(screen.getByTestId('brand-profile-card')).toBeTruthy()
    expect(screen.getByTestId('intake-value-brand_name').textContent).toBe('诺伏特户外')
  })

  it('抓不到的页面如实说，不编', async () => {
    state.run = websiteRun({
      pages: [
        { url: 'https://nordvolt.cn/', kind: 'home', ok: true },
        {
          url: 'https://nordvolt.cn/policies/refund',
          kind: 'policy',
          ok: false,
          reason: '这个页面不存在（404）',
        },
      ],
    })
    renderWithProviders(<OnboardingPage />)
    await passAi()
    expect((await screen.findByTestId('intake-missed')).textContent).toContain('404')
  })

  it('分析没跑成：那一句人话在，输入框还在（换个网址再试）', async () => {
    state.run = websiteRun({
      status: 'failed',
      pages: [],
      failure: '一个页面都没抓着，换个网址再试试',
    })
    renderWithProviders(<OnboardingPage />)
    await passAi()
    expect((await screen.findByTestId('intake-failed')).textContent).toContain('换个网址')
    expect(screen.getByTestId('intake-url')).toBeTruthy()
  })

  it('「还没有网站」旁路：一次分析都不起，照样走得到第 ③ 步', async () => {
    const user = userEvent.setup()
    renderWithProviders(<OnboardingPage />)
    await passAi()
    await user.click(screen.getByTestId('intake-no-site'))
    expect(state.starts).toHaveLength(0)
    await user.click(screen.getByTestId('onboarding-next'))
    expect(await screen.findByTestId('onboarding-roles')).toBeTruthy()
  })

  it('公司名与你的称呼并进这一步：改过的才发', async () => {
    const user = userEvent.setup()
    renderWithProviders(<OnboardingPage />)
    await passAi()
    await user.click(screen.getByTestId('intake-no-site'))

    const person = await screen.findByTestId('onboarding-person')
    // 名字与登录邮箱直接带出来，不用再填一遍
    expect((within(person).getByTestId('person-name') as HTMLInputElement).value).toBe('王岚')
    expect((within(person).getByTestId('person-email') as HTMLInputElement).value).toBe(
      'wang@nordvolt.cn',
    )
    // 登录邮箱是身份，只读；名字是展示名，能改
    expect((within(person).getByTestId('person-email') as HTMLInputElement).readOnly).toBe(true)
    expect((within(person).getByTestId('person-name') as HTMLInputElement).readOnly).toBe(false)

    const name = within(person).getByTestId('person-name')
    await user.clear(name)
    await user.type(name, '罗野')
    const company = within(person).getByTestId('company-legal-name')
    await user.clear(company)
    await user.type(company, '深圳诺伏特科技')
    await user.click(screen.getByTestId('onboarding-next'))

    await waitFor(() => {
      expect(state.renames).toEqual(['罗野'])
    })
    expect(state.profiles).toEqual([{ legal_name: '深圳诺伏特科技' }])
  })

  it('两格都没动过：往下走的时候一条更名、一条改档案都不发', async () => {
    const user = userEvent.setup()
    renderWithProviders(<OnboardingPage />)
    await passAi()
    await user.click(screen.getByTestId('intake-no-site'))
    await screen.findByTestId('onboarding-person')
    // 公司名那一格预填的是工作区名——它与"用户填了一个公司名"不是一回事
    await user.clear(screen.getByTestId('company-legal-name'))
    await user.click(screen.getByTestId('onboarding-next'))
    await screen.findByTestId('onboarding-roles')
    expect(state.renames).toHaveLength(0)
    expect(state.profiles).toHaveLength(0)
  })
})

describe('70 §5 第 ③ 步：按分析结果预勾', () => {
  /** 确认档案卡 → 进第 ③ 步。 */
  async function confirmAndGo(): Promise<void> {
    const user = userEvent.setup()
    await passAi()
    await user.click(await screen.findByTestId('intake-confirm'))
    await waitFor(() => {
      expect(state.confirms).toHaveLength(1)
    })
    await user.click(screen.getByTestId('onboarding-next'))
    await screen.findByTestId('onboarding-roles')
  }

  it('Shopify 官网 → 预勾网站运营与客服；社媒链接 → 只勾对应那几条渠道', async () => {
    state.run = websiteRun()
    renderWithProviders(<OnboardingPage />)
    await confirmAndGo()

    // 网站运营 2 条 + 客服 2 条 + Meta（instagram）+ TikTok = 6
    await waitFor(() => {
      expect(screen.getByTestId('onboarding-role-count').textContent).toContain('已勾 6 条')
    })
    // 社媒勾的是**渠道职责**，不是整个九条的岗位：Reddit 一条没勾上
    expect(screen.getByTestId('onboarding-role-count').textContent).not.toContain('已勾 7 条')
  })

  it('预勾都可改：去掉一个岗位，勾数跟着少', async () => {
    const user = userEvent.setup()
    state.run = websiteRun()
    renderWithProviders(<OnboardingPage />)
    await confirmAndGo()
    await waitFor(() => {
      expect(screen.getByTestId('onboarding-role-count').textContent).toContain('已勾 6 条')
    })

    const positions = await screen.findAllByTestId('onboarding-position')
    await user.click(positions[0] as HTMLElement)
    await waitFor(() => {
      expect(screen.getByTestId('onboarding-role-count').textContent).toContain('已勾 4 条')
    })
  })

  it('走了「还没有网站」旁路：一条都不预勾（凭空勾几个比不勾更糟）', async () => {
    const user = userEvent.setup()
    renderWithProviders(<OnboardingPage />)
    await passAi()
    await user.click(screen.getByTestId('intake-no-site'))
    await user.click(screen.getByTestId('onboarding-next'))
    await screen.findByTestId('onboarding-roles')
    expect(screen.getByTestId('onboarding-role-count').textContent).toContain('至少勾一条')
    expect((screen.getByTestId('onboarding-next') as HTMLButtonElement).disabled).toBe(true)
  })

  // 纯函数那一层：这张对照表值得单独钉（70 §5）
  it('对照表：Amazon 链接 → 客服；没有官网就不勾网站运营', () => {
    const amazon = presetPick({
      run: {
        ...websiteRun(),
        inputs: [{ url: 'https://www.amazon.com/dp/B0TEST', kind: 'amazon_listing' }],
        profile: {},
      },
      positions: POSITIONS,
    })
    expect(amazon.position_ids).toEqual(['customer-care'])
    expect(amazon.role_ids).toEqual([])
  })

  it('对照表：社媒勾到渠道，自定义岗位名预填成「社媒运营」', () => {
    const pick = presetPick({ run: websiteRun(), positions: POSITIONS })
    expect(pick.position_ids).toEqual(['web-ops', 'customer-care'])
    expect(pick.role_ids).toEqual(['social.meta', 'social.tiktok'])
    expect(pick.custom_position_name).toBe('社媒运营')
  })

  it('对照表：认不出来的平台一条都不勾；没有结果就整个空着', () => {
    const unknown = presetPick({
      run: {
        ...websiteRun(),
        profile: {
          social_links: {
            value: [{ platform: 'pinterest', url: 'https://pinterest.com/x' }],
            confidence: 'medium',
            evidence: [{ url: 'https://nordvolt.cn/', locator: 'selector:a[href]' }],
          },
        },
      },
      positions: POSITIONS,
    })
    expect(unknown.role_ids).toEqual([])
    expect(unknown.custom_position_name).toBe('')
    expect(presetPick({ positions: POSITIONS })).toEqual({
      position_ids: [],
      role_ids: [],
      custom_position_name: '',
    })
  })

  it('对照表：这台机器上没装的岗位一个都不勾（装了几条显示几条）', () => {
    const only = presetPick({ run: websiteRun(), positions: [POSITIONS[1] as never] })
    expect(only.position_ids).toEqual(['customer-care'])
    expect(only.role_ids).toEqual([])
  })

  it('勾一个岗位 = 它的职责全勾上；一条都没勾不让往下走', async () => {
    const user = userEvent.setup()
    renderWithProviders(<OnboardingPage />)
    await passAi()
    await user.click(screen.getByTestId('intake-no-site'))
    await user.click(screen.getByTestId('onboarding-next'))

    expect((await screen.findByTestId('onboarding-role-count')).textContent).toContain('至少勾一条')
    expect((screen.getByTestId('onboarding-next') as HTMLButtonElement).disabled).toBe(true)

    const positions = await screen.findAllByTestId('onboarding-position')
    await user.click(positions[1] as HTMLElement)
    await waitFor(() => {
      expect(screen.getByTestId('onboarding-role-count').textContent).toContain('已勾 2 条')
    })
    expect((screen.getByTestId('onboarding-next') as HTMLButtonElement).disabled).toBe(false)
  })

  it('展开只勾一条职责 → 问它叫什么，默认"我的岗位"；每条职责的解释进 tooltip', async () => {
    const user = userEvent.setup()
    renderWithProviders(<OnboardingPage />)
    await passAi()
    await user.click(screen.getByTestId('intake-no-site'))
    await user.click(screen.getByTestId('onboarding-next'))

    await user.click((await screen.findAllByTestId('onboarding-expand'))[1] as HTMLElement)
    const roles = await screen.findAllByTestId('onboarding-role')
    await user.click(roles[0] as HTMLElement)

    await waitFor(() => {
      expect(screen.getByTestId('onboarding-role-count').textContent).toContain('已勾 1 条')
    })
    const custom = screen.getByTestId('onboarding-custom') as HTMLInputElement
    expect(custom.placeholder).toBe('我的岗位')
    // 36 §7：那句"它会干什么"在 tooltip 里，不铺成灰字
    const hints = screen.getAllByTestId('onboarding-role-hint')
    expect(hints.some((h) => (h.getAttribute('data-hint') ?? '').includes('退款与投诉邮件'))).toBe(
      true,
    )
    expect(screen.queryByText('看退款与投诉邮件，拟一份回复给你定。')).toBeNull()
  })

  it('第 ③ 步铺在外面的只有一行说明', async () => {
    const user = userEvent.setup()
    renderWithProviders(<OnboardingPage />)
    await passAi()
    await user.click(screen.getByTestId('intake-no-site'))
    await user.click(screen.getByTestId('onboarding-next'))
    const roles = await screen.findByTestId('onboarding-roles')
    expect(within(roles).getByText('勾一个岗位 = 它包含的职责全勾上')).toBeTruthy()
  })
})

describe('第 ④ 步与完成屏', () => {
  /** 走到第 ④ 步：旁路过 ①②，第 ③ 步勾一个客服岗。 */
  async function toPlan(): Promise<void> {
    const user = userEvent.setup()
    await passAi()
    await user.click(screen.getByTestId('intake-no-site'))
    await user.click(screen.getByTestId('onboarding-next'))
    await user.click((await screen.findAllByTestId('onboarding-position'))[1] as HTMLElement)
    await user.click(screen.getByTestId('onboarding-next'))
    await screen.findByTestId('onboarding-plan')
  }

  it('清单：模型没接排第一条，每项"去连 / 去装"直达对应的卡；已连的不再给按钮', async () => {
    renderWithProviders(<OnboardingPage />)
    await toPlan()

    const plan = screen.getByTestId('onboarding-plan')
    const model = within(plan).getByTestId('onboarding-plan-model')
    expect(plan.firstElementChild).toBe(model)
    expect(within(model).getByText('去接').closest('a')?.getAttribute('href')).toBe('/settings')

    const connectors = within(plan).getAllByTestId('onboarding-plan-connector')
    expect(
      within(connectors[0] as HTMLElement)
        .getByText('去连')
        .closest('a')
        ?.getAttribute('href'),
    ).toBe('/connections?service=shopify')
    expect(within(connectors[1] as HTMLElement).queryByText('去连')).toBeNull()
    expect(within(connectors[1] as HTMLElement).getByText('已连')).toBeTruthy()

    const skill = within(plan).getByTestId('onboarding-plan-skill')
    expect(within(skill).getByText('去装').closest('a')?.getAttribute('href')).toBe('/skills')

    // 清单是按同一份勾选算的：发给服务端的就是界面上勾的那个岗位
    expect(state.plans.at(-1)).toMatchObject({ position_ids: ['customer-care'], role_ids: [] })
  })

  it('「完成」才真建分配；最后那个按钮说「完成」', async () => {
    const user = userEvent.setup()
    renderWithProviders(<OnboardingPage />)
    await toPlan()
    expect(screen.getByTestId('onboarding-finish').textContent).toBe('完成')
    expect(state.applies).toHaveLength(0)

    await user.click(screen.getByTestId('onboarding-finish'))
    await waitFor(() => {
      expect(state.applies).toHaveLength(1)
    })
    expect(state.applies[0]).toMatchObject({ position_ids: ['customer-care'] })
  })

  it('「完成」之后是一屏回执（「一变一队」），按了按钮才进工作台', async () => {
    const user = userEvent.setup()
    renderWithProviders(<OnboardingPage />)
    await toPlan()
    await user.click(screen.getByTestId('onboarding-finish'))

    const done = await screen.findByTestId('onboarding-done')
    expect(done.querySelector('svg[data-testid="brand-mark"]')?.getAttribute('data-motion')).toBe(
      'split',
    )
    expect(done.textContent).toContain('一队上岗了')
    expect(
      screen.getAllByTestId('onboarding-step').map((el) => el.getAttribute('data-state')),
    ).toEqual(['done', 'done', 'done', 'done'])
    expect(screen.queryByTestId('onboarding-skip')).toBeNull()
    expect(screen.queryByTestId('onboarding-next')).toBeNull()
    expect(screen.getByTestId('onboarding-enter')).toBeTruthy()
  })
})

/**
 * 「加入一家公司」跟着"公司"这件事挪到了第 ② 步。
 * 断言与 WP51 那一份一样——挪了位置不等于换了行为。
 */
describe('46 §2 局域网发现与加入（现在挂在第 ② 步）', () => {
  it('公司全称还没存下来时，说的是"存完就开始找"，而不是"开关关着"（开关明明开着）', async () => {
    renderWithProviders(<OnboardingPage />)
    await passAi()
    const peers = await screen.findByTestId('join-peers')
    await waitFor(() => {
      expect(within(peers).getByText(/存完就开始找/)).toBeTruthy()
    })
  })

  it('"发现 N 位同事"与邀请码输入都在；申请加入带的是我的名字与邮箱', async () => {
    const user = userEvent.setup()
    state.state = SAVED
    renderWithProviders(<OnboardingPage />)
    await passAi()

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

    // 贴码那条路走的是同一个按钮；码自动大写（用户多半是照着念的抄下来的）
    await user.type(screen.getByTestId('join-code'), 'abcd2345')
    await user.click(screen.getByTestId('join-submit'))
    await waitFor(() => {
      expect(state.joins).toHaveLength(2)
    })
    expect(state.joins[1]?.code).toBe('ABCD2345')
  })

  it('开关关着时说清楚"不广播也不监听"，而不是显示一个空列表', async () => {
    const user = userEvent.setup()
    state.peers = { available: true, enabled: false, peers: [] }
    state.state = SAVED
    renderWithProviders(<OnboardingPage />)
    await passAi()
    // 一个同伴都没看见时这一块是折叠的，展开它再看那一句
    await user.click(await screen.findByTestId('join-toggle'))
    const peers = await screen.findByTestId('join-peers')
    await waitFor(() => {
      expect(within(peers).getByText(/不广播也不监听/)).toBeTruthy()
    })
  })

  it('局域网发现起不来：一句人话，不是报错', async () => {
    const user = userEvent.setup()
    state.peers = { available: false, enabled: true, reason: '这台机器没有可用网卡', peers: [] }
    state.state = SAVED
    renderWithProviders(<OnboardingPage />)
    await passAi()
    await user.click(await screen.findByTestId('join-toggle'))
    const peers = await screen.findByTestId('join-peers')
    await waitFor(() => {
      expect(within(peers).getByText(/这台机器没有可用网卡/)).toBeTruthy()
    })
  })

  it('默认折叠成一行「已有邀请码？」；点开才出输入框', async () => {
    const user = userEvent.setup()
    state.peers = { available: true, enabled: true, peers: [] }
    state.state = SAVED
    renderWithProviders(<OnboardingPage />)
    await passAi()

    expect((await screen.findByTestId('join-toggle')).textContent).toBe('已有邀请码？')
    expect(screen.queryByTestId('join-code')).toBeNull()
    expect(screen.queryByText('加入一家公司')).toBeNull()
    await user.click(screen.getByTestId('join-toggle'))
    expect(await screen.findByTestId('join-code')).toBeTruthy()
  })
})

/**
 * `ProfileForm` 不在向导里了（它问的东西并进了第 ② 步的分析），但**设置页还在用它**。
 * 这一组是从旧文件整组搬过来的：那一页的行为一条都没变。
 */
describe('设置页的公司档案（ProfileForm）', () => {
  const platforms = STATE.storefront_platforms

  it('「你卖的是」默认实物；解释进 tooltip，只出选中那一条的那句话', async () => {
    const user = userEvent.setup()
    const saved: { vertical?: string }[] = []
    renderWithProviders(
      <ProfileForm
        verticals={STATE.verticals}
        storefrontPlatforms={platforms}
        busy={false}
        saved={false}
        onSave={(d) => saved.push(d)}
      />,
    )
    const goods = (await screen.findByTestId('company-vertical-goods')) as HTMLInputElement
    const digital = screen.getByTestId('company-vertical-digital') as HTMLInputElement
    expect(goods.checked).toBe(true)
    expect(digital.checked).toBe(false)
    expect(screen.getByTestId('company-vertical-note').textContent).toContain('要发货的东西')
    expect(screen.queryByText(/不用发货的东西/)).toBeNull()
    expect(screen.getByTestId('company-vertical-hint').getAttribute('data-hint')).toContain(
      '外行话',
    )

    await user.click(digital)
    await waitFor(() => {
      expect(screen.getByTestId('company-vertical-note').textContent).toContain('不用发货的东西')
    })
    await user.type(screen.getByTestId('company-legal-name'), '一家 SaaS')
    await user.click(screen.getByTestId('company-save'))
    expect(saved.at(-1)?.vertical).toBe('digital')
  })

  it('接不上的那三个平台灰显且点不动；「还没开始搭建」点得动', async () => {
    renderWithProviders(
      <ProfileForm
        verticals={STATE.verticals}
        storefrontPlatforms={platforms}
        busy={false}
        saved={false}
        onSave={() => undefined}
      />,
    )
    const shopify = (await screen.findByTestId('company-platform-shopify')) as HTMLInputElement
    expect(shopify.checked).toBe(true)
    for (const key of ['woocommerce', 'magento', 'other']) {
      const el = screen.getByTestId(`company-platform-${key}`) as HTMLInputElement
      expect(el.disabled).toBe(true)
      expect(el.checked).toBe(false)
    }
    expect(
      screen.getByTestId('company-platform-woocommerce-hint').getAttribute('data-hint'),
    ).toContain('待增加')
    // "我还没有网站"不是"我们还没接这个平台"
    const none = screen.getByTestId('company-platform-none') as HTMLInputElement
    expect(none.disabled).toBe(false)
    const hint = screen.getByTestId('company-platform-none-hint').getAttribute('data-hint')
    expect(hint).toContain('先不连店铺')
    expect(hint).not.toContain('待增加')
  })

  it('设置页里改成还接不上的平台：先问一次，点"取消"一个字不变', async () => {
    const user = userEvent.setup()
    const confirm = vi.spyOn(globalThis, 'confirm').mockReturnValue(false)
    renderWithProviders(
      <ProfileForm
        profile={{
          legal_name: '一家店',
          discoverable: true,
          brand_name: '一家店',
          vertical: 'goods',
          storefront_platform: 'shopify',
          set_at: T0,
        }}
        storefrontPlatforms={platforms}
        allowUnsupported
        busy={false}
        saved={false}
        onSave={() => undefined}
      />,
    )
    const woo = (await screen.findByTestId('company-platform-woocommerce')) as HTMLInputElement
    expect(woo.disabled).toBe(false)
    await user.click(woo)
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(String(confirm.mock.calls[0]?.[0])).toContain('失效')
    expect((screen.getByTestId('company-platform-woocommerce') as HTMLInputElement).checked).toBe(
      false,
    )
    confirm.mockRestore()
  })

  it('点"确定"才真的改，存下去的是新平台；分组小标题在设置页里还在', async () => {
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
          set_at: T0,
        }}
        storefrontPlatforms={platforms}
        allowUnsupported
        busy={false}
        saved={false}
        onSave={(d) => saved.push(d)}
      />,
    )
    await user.click(await screen.findByTestId('company-platform-woocommerce'))
    await user.click(screen.getByTestId('company-save'))
    expect(saved).toHaveLength(1)
    expect(saved[0]?.storefront_platform).toBe('woocommerce')
    // 那一页上下文多，分组是有用的（向导里才不出）
    expect(screen.getAllByText('公司').length).toBeGreaterThan(0)
    expect(screen.getByText('这个品牌')).toBeTruthy()
    expect(screen.getAllByText('保存公司档案').length).toBeGreaterThan(0)
    confirm.mockRestore()
  })

  it('安全承诺压成一行摆在外面，不许藏进 tooltip', async () => {
    renderWithProviders(
      <ProfileForm
        storefrontPlatforms={platforms}
        busy={false}
        saved={false}
        onSave={() => undefined}
      />,
    )
    expect(await screen.findByText(/只交换一串哈希/)).toBeTruthy()
    expect(screen.getByTestId('company-name-hint').getAttribute('data-hint')).toContain('营业执照')
  })
})
