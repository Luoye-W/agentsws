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
 * 6. 第 ③ 步（WP234）：分析结果与 AI 只是**推荐**，一条不预勾；选上的职责按建议分成岗位，
 *    用户改完以他为准，交给服务端的是岗位清单；
 * 7. 第 ④ 步那张清单与完成屏（WP51 / WP112 原有的那几条，一条没删）；
 * 8. 「加入一家公司」跟着"公司"这件事挪到第 ② 步——挪了位置不等于换了行为。
 *
 * 末尾那一组是**从旧文件整组搬过来的** `ProfileForm`：它不在向导里了（问的东西
 * 并进了第 ② 步那一轮分析），但设置页还在用它，那一页的行为一条都没变。
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { modelTestKey } from '@/components/onboarding/ai-step'
import { PositionPlanner } from '@/components/onboarding/position-planner'
import { mergeRecommendations, recommendFromIntake } from '@/components/onboarding/preset-roles'
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
  OnboardingSuggestView,
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
      // WP191（docs/86 §5）：Meta 拆成 FB 主页 + IG，IG 那条单独勾
      { id: 'social.instagram', name: 'Instagram', default: true, what_it_does: '发帖与回评论。' },
      { id: 'social.tiktok', name: 'TikTok', default: true, what_it_does: '发短视频。' },
      { id: 'social.reddit', name: 'Reddit', default: false, what_it_does: '看版聊。' },
    ],
  },
  // WP142：红人营销（排在最后，前面几个的下标不动）
  {
    id: 'kol-marketing',
    name: '红人营销',
    roles: [
      { id: 'kol.youtube', name: 'YouTube 红人', default: true, what_it_does: '找频道。' },
      { id: 'kol.instagram', name: 'Instagram 红人', default: true, what_it_does: '找博主。' },
      { id: 'kol.tiktok', name: 'TikTok 红人', default: false, what_it_does: '找达人。' },
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

/**
 * WP152：DeepSeek 两种连法都收进第三张「DeepSeek 官方」卡，"自己的接口"里不再有 DeepSeek——
 * 这张卡的表单改用 OpenAI 兼容那条来测（形态一样：地址 + key + 模型名）。
 */
const COMPAT_TEMPLATE: ModelProviderTemplate = {
  kind: 'openai_compatible',
  label: 'OpenAI 兼容（自定义）',
  summary: '任何 OpenAI 格式的服务。',
  default_base_url: 'https://api.moonshot.cn/v1',
  default_model: 'kimi-latest',
  region: 'cn',
  steps: ['填地址与 key'],
  links: [{ label: 'Moonshot', url: 'https://platform.moonshot.cn' }],
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
  /** WP142：发登录信那一跳——连不上云 / 先挂着不回（看「正在连」那一句）。 */
  linkFail: false,
  linkHold: undefined as Promise<void> | undefined,
  /** WP142：第 ① 步「自己的接口」那一排模板（默认两张：云 + DeepSeek）。 */
  templates: undefined as ModelProviderTemplate[] | undefined,
  /** WP142：第 ④ 步那张清单（不给就是 PLAN）。 */
  plan: undefined as OnboardingPlanView | undefined,
  /** WP216：「完成」回执里带的那份清单（不给就是 PLAN）。 */
  applyPlan: undefined as OnboardingPlanView | undefined,
  /** WP142：「完成」那一发服务端回的（完成屏按它说数）。 */
  applyResult: { created_assignments: [], skipped: [] } as {
    created_assignments: { id: string; role_id: string; role_name: string }[]
    skipped: string[]
  },
  /** WP234：「帮我推荐」发出去的原话与回的那一份。 */
  suggests: [] as string[],
  suggestion: { source: 'unavailable', roles: [], positions: [] } as OnboardingSuggestView,
}

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getOnboardingState: async () => state.state,
    listOnboardingPositions: async () => POSITIONS,
    suggestOnboarding: async (text: string) => {
      state.suggests.push(text)
      return state.suggestion
    },
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
      return state.plan ?? PLAN
    },
    applyOnboarding: async (input: OnboardingPlanInput) => {
      state.applies.push(input)
      return { ...state.applyResult, ranges: [], plan: state.applyPlan ?? PLAN }
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
      templates: state.templates ?? [CLOUD_TEMPLATE, DEEPSEEK_TEMPLATE, COMPAT_TEMPLATE],
    }),
    getCloudAccount: async () => state.account,
    getCloudCredits: async () => state.credits,
    linkCloudAccount: async (email: string) => {
      state.links.push(email)
      if (state.linkHold !== undefined) await state.linkHold
      if (state.linkFail)
        throw new actual.ApiClientError(503, {
          code: 'provider_unavailable',
          message: '网络不通，这一下没连上 Agents 工坊云。检查一下网络再试一次。',
        })
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
  state.linkFail = false
  state.linkHold = undefined
  state.templates = undefined
  state.applyResult = { created_assignments: [], skipped: [] }
  state.suggests = []
  state.suggestion = {
    source: 'unavailable',
    note: '这次没能让 AI 帮你推荐。',
    roles: [],
    positions: [],
  }
  state.plan = undefined
  state.applyPlan = undefined
})

/** 走完第 ① 步（走演示旁路——四条路里最短的那条，而且不落任何东西）。 */
async function passAi(): Promise<void> {
  const user = userEvent.setup()
  await user.click(await screen.findByTestId('ai-demo'))
  await screen.findByTestId('onboarding-business')
}

/** WP234：第 ③ 步交上去的「客服」那一行（从类别「客服」里点上两条）。 */
const CARE_ROW = {
  name: '客服',
  role_ids: ['dtc.support', 'amz.support'],
  template_id: 'customer-care',
}

/** WP234：第 ③ 步从「按类别浏览」里把客服那两条点上。 */
async function pickCare(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const toggles = await screen.findAllByTestId('onboarding-category-toggle')
  await user.click(
    toggles.find((t) => t.getAttribute('data-category') === 'customer-care') as HTMLElement,
  )
  for (const id of ['dtc.support', 'amz.support'])
    await user.click(
      screen
        .getAllByTestId('onboarding-role')
        .find((b) => b.getAttribute('data-role') === id) as HTMLElement,
    )
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
    // 名字直接带出来，不用再填一遍；账号是一行只读字（WP233：不再是一格输入框）
    expect((within(person).getByTestId('person-name') as HTMLInputElement).value).toBe('王岚')
    expect(within(person).getByTestId('person-account').textContent).toBe(
      '你的账号：wang@nordvolt.cn',
    )
    expect(within(person).queryByTestId('person-email')).toBeNull()
    // 名字是展示名，能改
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

describe('WP234 第 ③ 步：说说你要做什么 → 推荐（不预勾）→ 你的岗位', () => {
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
  /** 「还没有网站」旁路 → 进第 ③ 步。 */
  async function noSiteAndGo(): Promise<void> {
    const user = userEvent.setup()
    await passAi()
    await user.click(screen.getByTestId('intake-no-site'))
    await user.click(screen.getByTestId('onboarding-next'))
    await screen.findByTestId('onboarding-roles')
  }
  const rows = () =>
    screen.getAllByTestId('onboarding-board-row').map((row) => ({
      key: row.getAttribute('data-row') ?? '',
      name: (within(row).getByTestId('onboarding-board-name') as HTMLInputElement).value,
      duties: within(row)
        .queryAllByTestId('onboarding-board-duty')
        .map((d) => d.getAttribute('data-role')),
    }))

  it('Shopify 官网分析：只出「推荐」，一条都不预勾；一条没选不让往下走', async () => {
    state.run = websiteRun()
    renderWithProviders(<OnboardingPage />)
    await confirmAndGo()
    const recs = await screen.findAllByTestId('onboarding-rec-duty')
    // 网站运营 2 条 + 网站客服 + 官网上挂着的 Instagram 与 TikTok = 5；Reddit 不推
    expect(recs.map((r) => r.getAttribute('data-role'))).toEqual([
      'dtc.store',
      'dtc.content',
      'dtc.support',
      'social.instagram',
      'social.tiktok',
    ])
    expect(recs.every((r) => r.getAttribute('aria-pressed') === 'false')).toBe(true)
    expect(screen.getAllByTestId('onboarding-rec-reason')[0]?.textContent).toContain('Shopify')
    expect(screen.getByTestId('onboarding-board-empty')).toBeTruthy()
    expect(screen.getByTestId('onboarding-role-count').textContent).toContain('至少勾一条')
    expect((screen.getByTestId('onboarding-next') as HTMLButtonElement).disabled).toBe(true)
  })

  it('点一条推荐才算选上；它进「你的岗位」，按类别成一个岗位', async () => {
    const user = userEvent.setup()
    state.run = websiteRun()
    renderWithProviders(<OnboardingPage />)
    await confirmAndGo()
    const store = (await screen.findAllByTestId('onboarding-rec-duty')).find(
      (r) => r.getAttribute('data-role') === 'dtc.store',
    ) as HTMLElement
    await user.click(store)
    expect(store.getAttribute('aria-pressed')).toBe('true')
    expect(rows()).toEqual([{ key: expect.any(String), name: '网站运营', duties: ['dtc.store'] }])
    expect(screen.getByTestId('onboarding-role-count').textContent).toBe('1 个岗位 · 1 条职责')
    expect((screen.getByTestId('onboarding-next') as HTMLButtonElement).disabled).toBe(false)
  })

  it('说说你要做什么 → 推荐带理由与原话、给划分建议；「按推荐来」才选上并按建议分', async () => {
    const user = userEvent.setup()
    state.suggestion = {
      source: 'ai',
      roles: [
        { role_id: 'social.reddit', reason: '要自己发帖', quote: '自己发帖' },
        { role_id: 'kol.youtube', reason: '要找红人', quote: '找 YouTube 红人' },
      ],
      positions: [{ name: 'Reddit 与红人', role_ids: ['social.reddit', 'kol.youtube'] }],
    }
    renderWithProviders(<OnboardingPage />)
    await noSiteAndGo()
    await user.type(
      screen.getByTestId('onboarding-intent-text'),
      '在 Reddit 上自己发帖，再找 YouTube 红人',
    )
    await user.click(screen.getByTestId('onboarding-intent-go'))
    await screen.findByTestId('onboarding-recs')
    expect(state.suggests).toEqual(['在 Reddit 上自己发帖，再找 YouTube 红人'])
    const reasons = screen.getAllByTestId('onboarding-rec-reason').map((r) => r.textContent)
    expect(reasons[0]).toBe('要自己发帖「自己发帖」')
    expect(screen.getByTestId('onboarding-recs-split').textContent).toContain('「Reddit 与红人」2')
    // 推荐不是选中
    expect(
      screen.getAllByTestId('onboarding-rec-duty').map((r) => r.getAttribute('aria-pressed')),
    ).toEqual(['false', 'false'])
    expect(screen.getByTestId('onboarding-board-empty')).toBeTruthy()
    // 类别目录里也带「推荐」小标签
    await user.click(
      screen
        .getAllByTestId('onboarding-category-toggle')
        .find((t) => t.getAttribute('data-category') === 'social-media') as HTMLElement,
    )
    const reddit = screen
      .getAllByTestId('onboarding-role')
      .find((b) => b.getAttribute('data-role') === 'social.reddit') as HTMLElement
    expect(reddit.getAttribute('data-recommended')).toBe('true')
    expect(reddit.getAttribute('aria-pressed')).toBe('false')

    await user.click(screen.getByTestId('onboarding-recs-adopt'))
    expect(rows().map(({ name, duties }) => ({ name, duties }))).toEqual([
      { name: 'Reddit 与红人', duties: ['social.reddit', 'kol.youtube'] },
    ])
  })

  it('AI 这次推荐不了：照实说一句，下面照样能手选', async () => {
    const user = userEvent.setup()
    renderWithProviders(<OnboardingPage />)
    await noSiteAndGo()
    await user.type(screen.getByTestId('onboarding-intent-text'), '做客服')
    await user.click(screen.getByTestId('onboarding-intent-go'))
    expect((await screen.findByTestId('onboarding-intent-note')).textContent).toContain('没能让 AI')
    expect(screen.queryByTestId('onboarding-recs')).toBeNull()
    await pickCare(user)
    expect(rows().map(({ name, duties }) => ({ name, duties }))).toEqual([
      { name: '客服', duties: ['dtc.support', 'amz.support'] },
    ])
  })

  it('改岗位：「移到…」、拖动、改名、新建、删空——交上去的是改完的样子', async () => {
    const user = userEvent.setup()
    renderWithProviders(<OnboardingPage />)
    await noSiteAndGo()
    await pickCare(user)
    await user.click(
      screen
        .getAllByTestId('onboarding-category-toggle')
        .find((t) => t.getAttribute('data-category') === 'web-ops') as HTMLElement,
    )
    await user.click(
      screen
        .getAllByTestId('onboarding-role')
        .find((b) => b.getAttribute('data-role') === 'dtc.store') as HTMLElement,
    )
    const webKey = rows().find((r) => r.name === '网站运营')?.key ?? ''
    // 「移到…」：Amazon 客服挪进网站运营那一行
    const amz = screen
      .getAllByTestId('onboarding-board-duty')
      .find((d) => d.getAttribute('data-role') === 'amz.support') as HTMLElement
    await user.selectOptions(within(amz).getByTestId('onboarding-board-move'), webKey)
    // 改名
    const webName = within(
      screen
        .getAllByTestId('onboarding-board-row')
        .find((r) => r.getAttribute('data-row') === webKey) as HTMLElement,
    ).getByTestId('onboarding-board-name')
    await user.clear(webName)
    await user.type(webName, '店长')
    // 新建一个空岗位，把网站客服拖进去，再把变空的「客服」删掉
    await user.click(screen.getByTestId('onboarding-board-add'))
    const fresh = rows().at(-1)
    expect(fresh?.name).toBe('新岗位')
    const support = screen
      .getAllByTestId('onboarding-board-duty')
      .find((d) => d.getAttribute('data-role') === 'dtc.support') as HTMLElement
    const target = screen
      .getAllByTestId('onboarding-board-row')
      .find((r) => r.getAttribute('data-row') === fresh?.key) as HTMLElement
    const data = {
      types: ['application/x-agentsws-duty'],
      getData: () => 'dtc.support',
      setData: () => {},
    }
    fireEvent.dragStart(support, { dataTransfer: data })
    fireEvent.dragOver(target, { dataTransfer: data })
    fireEvent.drop(target, { dataTransfer: data })
    const careRow = screen
      .getAllByTestId('onboarding-board-row')
      .find(
        (r) =>
          (within(r).getByTestId('onboarding-board-name') as HTMLInputElement).value === '客服',
      ) as HTMLElement
    await user.click(within(careRow).getByTestId('onboarding-board-remove'))
    expect(rows().map(({ name, duties }) => ({ name, duties }))).toEqual([
      { name: '店长', duties: ['dtc.store', 'amz.support'] },
      { name: '新岗位', duties: ['dtc.support'] },
    ])
    await user.click(screen.getByTestId('onboarding-next'))
    await screen.findByTestId('onboarding-plan')
    expect(state.plans.at(-1)?.positions).toEqual([
      { name: '店长', role_ids: ['dtc.store', 'amz.support'], template_id: 'web-ops' },
      { name: '新岗位', role_ids: ['dtc.support'] },
    ])
  })

  it('每条职责的解释进 tooltip，不铺成灰字', async () => {
    const user = userEvent.setup()
    renderWithProviders(<OnboardingPage />)
    await noSiteAndGo()
    await pickCare(user)
    const hints = screen.getAllByTestId('onboarding-role-hint')
    expect(hints.some((h) => (h.getAttribute('data-hint') ?? '').includes('退款与投诉邮件'))).toBe(
      true,
    )
    expect(screen.queryByText('看退款与投诉邮件，拟一份回复给你定。')).toBeNull()
  })

  it('第二批的职责在目录里标「第二批」，说明进问号；照样能点上', async () => {
    const user = userEvent.setup()
    const WITH_B2B: OnboardingPositionView[] = [
      {
        id: 'b2b',
        name: 'B2B',
        roles: [
          { id: 'b2b.sales', name: '业务', default: true, what_it_does: '回询盘。' },
          {
            id: 'b2b.marketplace',
            name: 'B2B 平台运营',
            default: false,
            what_it_does: '管平台店铺。',
            planned: true,
          },
        ],
      },
    ]
    const onToggle = vi.fn()
    renderWithProviders(
      <PositionPlanner
        catalog={WITH_B2B}
        text=""
        onText={() => {}}
        onSuggest={() => {}}
        suggesting={false}
        recommendations={[]}
        board={{ selected: [], rows: [], customized: false, seq: 0 }}
        onToggleDuty={onToggle}
        onAdopt={() => {}}
        onRegroup={() => {}}
        onBoard={() => {}}
      />,
    )
    await user.click(screen.getByTestId('onboarding-category-toggle'))
    const tags = screen.getAllByTestId('onboarding-role-planned')
    expect(tags).toHaveLength(1)
    expect(tags[0]?.textContent).toContain('第二批')
    const planned = screen
      .getAllByTestId('onboarding-role')
      .find((b) => b.getAttribute('data-role') === 'b2b.marketplace') as HTMLElement
    expect(planned.getAttribute('aria-pressed')).toBe('false')
    await user.click(planned)
    expect(onToggle).toHaveBeenLastCalledWith('b2b.marketplace')
  })

  // 纯函数那一层：这张对照表值得单独钉（70 §5，WP234 起产出推荐 + 理由）
  it('对照表：Amazon 链接 → 只推 Amazon 客服；没有官网就不推网站运营', () => {
    const amazon = recommendFromIntake({
      run: {
        ...websiteRun(),
        inputs: [{ url: 'https://www.amazon.com/dp/B0TEST', kind: 'amazon_listing' }],
        profile: {},
      },
      positions: POSITIONS,
    })
    expect(amazon).toEqual([{ role_id: 'amz.support', reason: '分析到你在 Amazon 上卖' }])
  })

  it('对照表：认不出来的平台一条都不推；没有结果就一条不推；AI 的排前面', () => {
    const unknown = recommendFromIntake({
      run: {
        ...websiteRun(),
        inputs: [],
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
    expect(unknown).toEqual([])
    expect(recommendFromIntake({ positions: POSITIONS })).toEqual([])
    expect(
      mergeRecommendations(
        [{ role_id: 'dtc.store', reason: 'AI', quote: '开店' }],
        [
          { role_id: 'dtc.store', reason: '官网' },
          { role_id: 'dtc.support', reason: '官网' },
        ],
      ).map((r) => r.reason),
    ).toEqual(['AI', '官网'])
  })
})

describe('第 ④ 步与完成屏', () => {
  /** 走到第 ④ 步：旁路过 ①②，第 ③ 步勾一个客服岗。 */
  async function toPlan(): Promise<void> {
    const user = userEvent.setup()
    await passAi()
    await user.click(screen.getByTestId('intake-no-site'))
    await user.click(screen.getByTestId('onboarding-next'))
    await pickCare(user)
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

    // 清单是按同一份岗位清单算的：发给服务端的就是界面上分好的那个岗位
    expect(state.plans.at(-1)).toMatchObject({ positions: [CARE_ROW] })
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
    expect(state.applies[0]).toMatchObject({
      position_ids: [],
      role_ids: [],
      positions: [CARE_ROW],
    })
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

/* ── WP142：红人为主的朋友第一步（docs/78 §1 #6 #7、§2「向导」） ───────────────── */

describe('WP142 第 ① 步：官方云那一跳有反馈；模板不重名', () => {
  it('发送中说「正在连 Agents 工坊云…」，不只是按钮变灰', async () => {
    const user = userEvent.setup()
    let release: () => void = () => {}
    state.linkHold = new Promise<void>((r) => {
      release = r
    })
    renderWithProviders(<OnboardingPage />)
    await user.click(await screen.findByTestId('ai-pick-official'))
    await user.type(screen.getByTestId('ai-official-email'), 'wang@nordvolt.cn')
    await user.click(screen.getByTestId('ai-official-send'))
    expect((await screen.findByTestId('ai-official-pending')).textContent).toContain(
      '正在连 Agents 工坊云',
    )
    release()
    expect(await screen.findByTestId('ai-official-sent')).toBeTruthy()
    expect(screen.queryByTestId('ai-official-pending')).toBeNull()
  })

  it('连不上：一句人话 +「再试一次」+「先逛逛演示数据」，不报网址', async () => {
    const user = userEvent.setup()
    state.linkFail = true
    renderWithProviders(<OnboardingPage />)
    await user.click(await screen.findByTestId('ai-pick-official'))
    await user.type(screen.getByTestId('ai-official-email'), 'wang@nordvolt.cn')
    await user.click(screen.getByTestId('ai-official-send'))

    const failed = await screen.findByTestId('ai-official-failed')
    expect(within(failed).getByTestId('ai-error').textContent).toContain('网络不通')
    expect(failed.textContent).not.toMatch(/https?:\/\//)

    // 再试一次：同一个邮箱再发一遍，这回通了
    state.linkFail = false
    await user.click(within(failed).getByTestId('ai-official-retry'))
    expect(await screen.findByTestId('ai-official-sent')).toBeTruthy()
    expect(state.links).toEqual(['wang@nordvolt.cn', 'wang@nordvolt.cn'])
  })

  it('连不上时「先逛逛演示数据」直接往下走（不接模型也到得了第 ② 步）', async () => {
    const user = userEvent.setup()
    state.linkFail = true
    renderWithProviders(<OnboardingPage />)
    await user.click(await screen.findByTestId('ai-pick-official'))
    await user.type(screen.getByTestId('ai-official-email'), 'wang@nordvolt.cn')
    await user.click(screen.getByTestId('ai-official-send'))
    await user.click(await screen.findByTestId('ai-official-demo'))
    expect(await screen.findByTestId('onboarding-business')).toBeTruthy()
  })

  it('同一家厂商的几个方案收成一个钮，选中后再挑方案（百炼不再出三个同名）', async () => {
    const user = userEvent.setup()
    const bailian = (plan: string, url: string, order: number): ModelProviderTemplate => ({
      kind: 'openai_compatible',
      label: `阿里云百炼 ${plan}`,
      summary: '一把 key。',
      vendor: 'bailian',
      vendor_label: '阿里云百炼',
      plan_label: plan,
      plan_order: order,
      default_base_url: url,
      default_model: 'qwen-plus',
      region: 'cn',
      steps: [],
      links: [],
    })
    state.templates = [
      CLOUD_TEMPLATE,
      DEEPSEEK_TEMPLATE,
      COMPAT_TEMPLATE,
      bailian('Token Plan（订阅）', 'https://tp.example/v1', 2),
      bailian('按量计费（标准）', 'https://payg.example/v1', 1),
      bailian('Coding Plan（订阅）', 'https://cp.example/v1', 3),
    ]
    renderWithProviders(<OnboardingPage />)
    await user.click(await screen.findByTestId('ai-pick-own'))
    const row = await screen.findByTestId('ai-own-templates')
    const labels = within(row)
      .getAllByRole('button')
      .map((b) => b.textContent)
    // WP152：DeepSeek 在第三张「DeepSeek 官方」卡里，这一排不再有它
    expect(labels).toEqual(['OpenAI 兼容（自定义）', '阿里云百炼'])
    // 选中百炼才出第二排：三个方案，按 plan_order 排
    expect(screen.queryByTestId('ai-own-plans')).toBeNull()
    await user.click(within(row).getByText('阿里云百炼'))
    const plans = await screen.findByTestId('ai-own-plans')
    expect(
      within(plans)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['按量计费（标准）', 'Token Plan（订阅）', 'Coding Plan（订阅）'])
    expect(within(plans).getAllByRole('button')[0]?.getAttribute('data-picked')).toBe('true')
  })
})

describe('WP142 第 ② 步：档案卡说人话、公司全称只有一个来源、确认有回执', () => {
  const richRun = (): BrandIntakeRun =>
    websiteRun({
      pages: [
        { url: 'https://nordvolt.cn/', kind: 'home', ok: true },
        {
          url: 'https://nordvolt.cn/policies/refund',
          kind: 'policy',
          ok: false,
          reason: '这个页面不存在（404）',
        },
      ],
      profile: {
        ...websiteRun().profile,
        legal_name: {
          value: '深圳诺伏特科技有限公司',
          confidence: 'high',
          evidence: [{ url: 'https://nordvolt.cn/', locator: 'jsonld:Organization.legalName' }],
        },
        currency: {
          value: 'USD',
          confidence: 'high',
          evidence: [{ url: 'https://nordvolt.cn/', locator: 'jsonld:Offer.priceCurrency' }],
        },
        languages: {
          value: ['zh-CN'],
          confidence: 'medium',
          evidence: [{ url: 'https://nordvolt.cn/', locator: 'og:locale' }],
        },
        products: {
          value: [{ title: '65W 充电器', price_snapshot: '1299.00' }],
          confidence: 'medium',
          evidence: [{ url: 'https://nordvolt.cn/', locator: 'jsonld:Product' }],
        },
      },
    })

  it('标签是中文 / 品牌名，价格带币种，没读着的页面不括号套括号', async () => {
    state.run = richRun()
    renderWithProviders(<OnboardingPage />)
    await passAi()
    const card = await screen.findByTestId('brand-profile-card')
    const tags = within(card)
      .getAllByTestId('intake-tag')
      .map((t) => t.textContent)
    expect(tags).toEqual(['中文（中国）', 'Instagram', 'TikTok'])
    expect(card.textContent).not.toMatch(/zh-CN|instagram|tiktok/)
    expect(within(card).getByTestId('intake-price').textContent).toContain('US$')
    const missed = screen.getByTestId('intake-missed').textContent ?? ''
    expect(missed).toContain('这个页面不存在（404）')
    expect(missed).not.toMatch(/（[^）]*（/)
  })

  it('「公司全称」只出一次：卡上不再有，下面那一格预填分析出来的全称', async () => {
    state.run = richRun()
    renderWithProviders(<OnboardingPage />)
    await passAi()
    const card = await screen.findByTestId('brand-profile-card')
    expect(within(card).queryByTestId('intake-row-legal_name')).toBeNull()
    expect((screen.getByTestId('company-legal-name') as HTMLInputElement).value).toBe(
      '深圳诺伏特科技有限公司',
    )
    expect(screen.getAllByText('公司全称')).toHaveLength(1)
  })

  it('点「看着没问题」有一句回执，按钮换成「已确认」', async () => {
    const user = userEvent.setup()
    state.run = richRun()
    renderWithProviders(<OnboardingPage />)
    await passAi()
    await user.click(await screen.findByTestId('intake-confirm'))
    expect((await screen.findByTestId('intake-confirmed')).textContent).toContain('已存好')
    const button = screen.getByTestId('intake-confirm') as HTMLButtonElement
    expect(button.textContent).toContain('已确认')
    expect(button.disabled).toBe(true)
  })
})

describe('WP142 完成屏：数字与第 ④ 步同口径，已有的被跳过要说', () => {
  async function finish(): Promise<void> {
    const user = userEvent.setup()
    await passAi()
    await user.click(screen.getByTestId('intake-no-site'))
    await user.click(screen.getByTestId('onboarding-next'))
    await pickCare(user)
    await user.click(screen.getByTestId('onboarding-next'))
    await screen.findByTestId('onboarding-plan')
    await user.click(screen.getByTestId('onboarding-finish'))
  }

  it('建了 1 条、跳过 1 条：两个数都说出来', async () => {
    state.applyResult = {
      created_assignments: [{ id: 'asg_1', role_id: 'amz.support', role_name: 'Amazon 客服' }],
      skipped: ['dtc.support'],
    }
    renderWithProviders(<OnboardingPage />)
    await finish()
    const line = (await screen.findByTestId('onboarding-done-line')).textContent ?? ''
    expect(line).toContain('1 条职责已经配好')
    expect(line).toContain('另外 1 条你本来就有')
  })

  it('一条都没新建（都已经有了）：不说「0 条配好」，说清为什么', async () => {
    state.applyResult = { created_assignments: [], skipped: ['dtc.support', 'amz.support'] }
    renderWithProviders(<OnboardingPage />)
    await finish()
    const line = (await screen.findByTestId('onboarding-done-line')).textContent ?? ''
    expect(line).not.toContain('0 条')
    expect(line).toContain('2 条职责本来就都有了')
  })
})

describe('WP216 完成屏：品牌是 Shopify、勾了建站，问一句「要现在装 Shopify CLI 吗」', () => {
  async function finish(): Promise<void> {
    const user = userEvent.setup()
    await passAi()
    await user.click(screen.getByTestId('intake-no-site'))
    await user.click(screen.getByTestId('onboarding-next'))
    await pickCare(user)
    await user.click(screen.getByTestId('onboarding-next'))
    await screen.findByTestId('onboarding-plan')
    await user.click(screen.getByTestId('onboarding-finish'))
  }

  it('服务端清单带 platform_cli：完成屏有提示与「现在装」，能跳过（进工作台照样在）', async () => {
    state.applyPlan = {
      ...PLAN,
      positions: [
        {
          position_id: 'site',
          name: '建站',
          role_ids: ['site.shopify-theme'],
          already_held: false,
        },
      ],
      platform_cli: {
        id: 'shopify-cli',
        label: 'Shopify CLI',
        position_id: 'site',
        tutorial: 'shopify-cli',
      },
    }
    state.applyResult = {
      created_assignments: [
        { id: 'asg_site', role_id: 'site.shopify-theme', role_name: 'Shopify 网页模板' },
      ],
      skipped: [],
    }
    renderWithProviders(<OnboardingPage />)
    await finish()
    const box = await screen.findByTestId('onboarding-platform-cli')
    expect(box.textContent).toContain('建站岗位会用到 Shopify CLI，要现在装吗？')
    expect(box.textContent).toContain('之后在建站岗位页也能装')
    expect(screen.getByTestId('onboarding-platform-cli-go').textContent).toBe('现在装')
    expect(screen.getByTestId('onboarding-enter')).toBeTruthy()
  })

  it('没有 platform_cli（不是 Shopify / 没勾建站）：完成屏一个字都不提', async () => {
    renderWithProviders(<OnboardingPage />)
    await finish()
    await screen.findByTestId('onboarding-done')
    expect(screen.queryByTestId('onboarding-platform-cli')).toBeNull()
  })
})

describe('WP142 第 ④ 步：只列必需的，可选的折起来；技能包说中文名', () => {
  const optional = (service: string, label: string) => ({
    service,
    label,
    required: false,
    connected: false,
    needed_by: ['YouTube 红人'],
  })

  async function toPlan(): Promise<void> {
    const user = userEvent.setup()
    await passAi()
    await user.click(screen.getByTestId('intake-no-site'))
    await user.click(screen.getByTestId('onboarding-next'))
    await pickCare(user)
    await user.click(screen.getByTestId('onboarding-next'))
    await screen.findByTestId('onboarding-plan')
  }

  it('必需的平铺；可选的折成「还有 N 个可选」，点开才出', async () => {
    const user = userEvent.setup()
    state.plan = {
      ...PLAN,
      connectors: [
        ...PLAN.connectors,
        optional('youtube_data', 'YouTube Data API'),
        optional('instagram_graph', 'Instagram'),
        optional('gmail', 'Gmail'),
      ],
    }
    renderWithProviders(<OnboardingPage />)
    await toPlan()
    const rows = screen.getAllByTestId('onboarding-plan-connector')
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.getAttribute('data-required') === 'true')).toBe(true)
    const toggle = screen.getByTestId('onboarding-plan-optional-toggle')
    expect(toggle.textContent).toBe('还有 3 个可选')
    await user.click(toggle)
    expect(screen.getAllByTestId('onboarding-plan-connector')).toHaveLength(5)
  })

  it('一个必需的都没有：说一句「现在就能开工」，可选的照样折着', async () => {
    state.plan = {
      ...PLAN,
      connectors: [optional('youtube_data', 'YouTube Data API')],
    }
    renderWithProviders(<OnboardingPage />)
    await toPlan()
    expect(screen.getByTestId('onboarding-plan-none-required').textContent).toContain(
      '现在就能开工',
    )
    expect(screen.queryAllByTestId('onboarding-plan-connector')).toHaveLength(0)
  })

  it('技能包显示中文名，包名一个都不露', async () => {
    state.plan = {
      ...PLAN,
      skills: [
        { name: 'brand-voice', installed: false, needed_by: ['YouTube 红人'] },
        { name: 'workspace-basics', installed: true, needed_by: ['网站客服'] },
        { name: 'some-third-party', installed: false, needed_by: ['网站客服'] },
      ],
    }
    renderWithProviders(<OnboardingPage />)
    await toPlan()
    const names = screen
      .getAllByTestId('onboarding-plan-skill')
      .map((el) => el.querySelector('p')?.textContent)
    expect(names).toEqual(['品牌话术', '工作台基础', '一个专用技能包'])
    expect(screen.getByTestId('onboarding-plan').textContent).not.toMatch(/[a-z]+-[a-z]+/)
  })
})

describe('WP233 第 ② 步「你的账号」与「公司邮箱后缀」', () => {
  it('关联了云账号：显示「你的账号：<云账号邮箱>」，不出 owner@localhost', async () => {
    state.state = { ...STATE, person: { name: 'owner', email: 'owner@localhost' } }
    // 局域网上没人：「加入一家公司」折成那一行「已有邀请码？」
    state.peers = { ...PEERS, peers: [] }
    state.account = {
      linked: true,
      email: 'boss@inmoxr.com',
      org_name: 'inmoxr',
      expires_at: T0,
      scopes: ['ai'],
      linked_at: T0,
      cloud_base_url: 'https://cloud.agentsws.dev',
    }
    const user = userEvent.setup()
    renderWithProviders(<OnboardingPage />)
    await passAi()
    await user.click(screen.getByTestId('intake-no-site'))
    const person = await screen.findByTestId('onboarding-person')
    await waitFor(() => {
      expect(within(person).getByTestId('person-account').textContent).toBe(
        '你的账号：boss@inmoxr.com',
      )
    })
    expect(person.textContent).not.toContain('owner@localhost')
    // 「已有邀请码？」那一行还在
    expect(screen.getByTestId('join-toggle').textContent).toContain('已有邀请码？')
  })

  it('没有云账号、本机还是占位邮箱：整行不出', async () => {
    state.state = { ...STATE, person: { name: 'owner', email: 'owner@localhost' } }
    const user = userEvent.setup()
    renderWithProviders(<OnboardingPage />)
    await passAi()
    await user.click(screen.getByTestId('intake-no-site'))
    const person = await screen.findByTestId('onboarding-person')
    expect(within(person).queryByTestId('person-account')).toBeNull()
    expect(document.body.textContent).not.toContain('owner@localhost')
  })

  it('后缀：叫「公司邮箱后缀」、占位与问号说清楚；从云账号 / 客服邮箱带出，公共邮箱不带', async () => {
    renderWithProviders(
      <ProfileForm
        emailHint="owner@localhost"
        suggestFrom={['me@gmail.com', 'support@inmoxr.com']}
        busy={false}
        saved={false}
        onSave={() => undefined}
      />,
    )
    const input = (await screen.findByTestId('company-domain')) as HTMLInputElement
    expect(screen.getByText('公司邮箱后缀')).toBeTruthy()
    expect(input.placeholder).toBe('例如 inmoxr.com')
    expect(screen.getByTestId('company-domain-hint').getAttribute('data-hint')).toBe(
      '同事用这个后缀的邮箱申请加入时，更容易认出是同一家公司；进来仍要你同意。可不填',
    )
    expect(input.value).toBe('inmoxr.com')
  })

  it('后缀：只有公共邮箱 / 占位时那一格空着', async () => {
    renderWithProviders(
      <ProfileForm
        emailHint="owner@localhost"
        suggestFrom={['me@qq.com', 'x@163.com', 'y@outlook.com']}
        busy={false}
        saved={false}
        onSave={() => undefined}
      />,
    )
    expect(((await screen.findByTestId('company-domain')) as HTMLInputElement).value).toBe('')
  })

  it('后缀：误填整个邮箱时只留 @ 后面那段，存的也是后缀', async () => {
    const user = userEvent.setup()
    const saved: { domain: string }[] = []
    renderWithProviders(<ProfileForm busy={false} saved={false} onSave={(d) => saved.push(d)} />)
    const input = (await screen.findByTestId('company-domain')) as HTMLInputElement
    await user.type(input, 'wang@InmoXR.com')
    expect(input.value).toBe('inmoxr.com')
    await user.type(screen.getByTestId('company-legal-name'), '深圳映墨科技')
    await user.click(screen.getByTestId('company-save'))
    expect(saved.at(-1)?.domain).toBe('inmoxr.com')
  })
})
