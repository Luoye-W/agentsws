/**
 * WP156（36 §7，Luoye 09-26）：**界面减字守卫**——设置页各分区与初始化向导，每张卡片：
 *
 * 1. 可见说明文字 ≤ {@link CARD_TEXT_LIMIT}（量法见 `less-text-guard.ts`：不含问号、按钮、状态、
 *    错误、安全承诺、表单）；
 * 2. 没有 `<ol>` 步骤清单（步骤进教程文章，卡上一个「看教程」）；
 * 3. 参考外链最多一个（操作按钮式的链接不算，例如"去 Chrome 商店装"）；
 * 4. 安全承诺 / 风险提示压到一句（≤ `SAFETY_LIMIT`）。
 *
 * 超了就红——红了先想"这句话是步骤（→ 教程）、是解释（→ 问号）、还是状态（→ 标 `data-slot=status`）"，
 * 不要调大上限。
 *
 * 模板夹具照服务端 `MODEL_TEMPLATES` 的真文案（介绍、步骤、外链都是长的那一份）：
 * 守的就是"服务端给了步骤，卡上也不铺"。
 */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ImageModelSection } from '@/components/models/image-model-section'
import { ModelsPanel } from '@/components/models/models-panel'
import { AiStep } from '@/components/onboarding/ai-step'
import { PlanList } from '@/components/onboarding/plan-list'
import { RolePicker } from '@/components/onboarding/role-picker'
import { BrowserCard } from '@/components/settings/browser-card'
import { CloudAccountCard } from '@/components/settings/cloud-account'
import { ComputerUseCard } from '@/components/settings/computer-use-card'
import { CreditsPanel } from '@/components/settings/credits-panel'
import { ModelCloudCard } from '@/components/settings/model-cloud-card'
import type {
  BrowserSettingsView,
  ComputerUseSettingsView,
  ModelProviderTemplate,
  OnboardingPlanView,
  OnboardingPositionView,
} from '@/lib/api'
import { SettingsPage } from '@/pages/settings'
import { renderWithProviders } from './helpers'
import { CARD_TEXT_LIMIT, type CardReport, reportCard } from './less-text-guard'

// ── 夹具：服务端模板的真文案 ─────────────────────────────────────────

const STEPS = [
  '打开控制台，用手机号注册登录',
  '左边找到"API keys"，点"创建 API key"',
  '复制那一串（只显示一次，关掉就看不到了）',
  '粘进下面的表单，点保存',
  '点"测试"——回了模型名和延迟就是通了',
]

function tpl(
  over: Partial<ModelProviderTemplate> & Pick<ModelProviderTemplate, 'kind' | 'label'>,
): ModelProviderTemplate {
  return {
    summary: '',
    default_base_url: `https://${over.label.length}.example/v1`,
    default_model: 'm',
    region: 'cn',
    steps: STEPS,
    links: [
      { label: '控制台', url: 'https://console.example' },
      { label: '文档', url: 'https://docs.example' },
    ],
    ...over,
  } as ModelProviderTemplate
}

const DEEPSEEK = {
  vendor: 'deepseek',
  vendor_label: 'DeepSeek 官方',
  vendor_summary:
    '国内直连、便宜、够用，没别的偏好就选它。两种连法：用 DeepSeek 账号登录（不用建 key），或者去开放平台建一把 API key。',
}
const BAILIAN = {
  vendor: 'bailian',
  vendor_label: '阿里云百炼',
  vendor_summary:
    '一把 key 同时调通义千问与 DeepSeek，账单也在一处。先选你买的是哪个方案——三个方案的地址与 key 互不通用，选错要么打不通要么乱扣钱。',
}
const OPENAI = {
  vendor: 'openai',
  vendor_label: 'OpenAI / ChatGPT',
  vendor_summary:
    '两条路：用你已经在付的 ChatGPT 订阅登录，或者去 platform.openai.com 建一把 API key 按量付费。',
}
const ANTHROPIC = {
  vendor: 'anthropic',
  vendor_label: 'Anthropic / Claude',
  vendor_summary:
    '两条路：用你已经在付的 Claude 订阅登录，或者去 console.anthropic.com 建一把 API key 按量付费。',
}

const TEMPLATES: ModelProviderTemplate[] = [
  tpl({
    kind: 'deepseek_account' as ModelProviderTemplate['kind'],
    label: 'DeepSeek 官方 · 官方账户登录',
    summary: '不用建 key：用 DeepSeek 账号在浏览器里登录一次，按你账号里的余额扣。',
    ...DEEPSEEK,
    plan_label: '官方账户登录',
    plan_order: 1,
    auth: 'account',
    default_base_url: 'https://api.deepseek.com/anthropic',
  } as Partial<ModelProviderTemplate> & Pick<ModelProviderTemplate, 'kind' | 'label'>),
  tpl({
    kind: 'deepseek',
    label: 'DeepSeek 官方 · 官方 API 接口连接',
    summary: '去 DeepSeek 开放平台建一把 API key 填进来，按量计费。',
    ...DEEPSEEK,
    plan_label: '官方 API 接口连接',
    plan_order: 2,
    auth: 'api_key',
    default_base_url: 'https://api.deepseek.com',
  }),
  tpl({
    kind: 'openai_compatible',
    label: 'OpenAI 兼容（自定义）',
    summary: '任何"OpenAI 格式"的服务都能接：Moonshot、通义千问、智谱，以及这台电脑上跑的 Ollama。',
    vendor: 'openai-compatible',
    vendor_label: 'OpenAI 兼容（自定义）',
    vendor_summary:
      '任何"OpenAI 格式"的服务都能接：Moonshot、通义千问、智谱，以及这台电脑上跑的 Ollama。',
    plan_label: '自己填地址与 key',
    plan_order: 1,
    auth: 'api_key',
    default_base_url: 'https://api.moonshot.cn/v1',
    links: [
      { label: 'Moonshot（Kimi）', url: 'https://platform.moonshot.cn' },
      { label: '通义千问（DashScope）', url: 'https://help.aliyun.com/zh/model-studio/' },
      { label: '智谱 GLM', url: 'https://open.bigmodel.cn' },
      { label: 'Ollama（本地跑）', url: 'https://ollama.com' },
    ],
  }),
  tpl({
    kind: 'openai_compatible',
    label: '阿里云百炼 Token Plan（订阅）',
    summary:
      '买了 Token Plan 订阅的走这张：按 Credits 扣，不按 token 花钱。专属 key（sk-sp- 开头）配专属地址，和按量那张完全不通用。',
    ...BAILIAN,
    plan_label: 'Token Plan（订阅）',
    plan_order: 1,
    auth: 'api_key',
    default_base_url: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
  }),
  tpl({
    kind: 'openai_compatible',
    label: '阿里云百炼（标准，按量计费）',
    summary: '一把 key 同时调通义千问与 DeepSeek，账单也在一处，用多少算多少。',
    ...BAILIAN,
    plan_label: '按量计费（标准）',
    plan_order: 2,
    auth: 'api_key',
    default_base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  }),
  tpl({
    kind: 'openai_compatible',
    label: '阿里云百炼 Coding Plan（订阅）',
    summary:
      '买了 Coding Plan 订阅的走这张：按次数配额，不按 token 花钱。key 与地址同样和别的档不通用。',
    ...BAILIAN,
    plan_label: 'Coding Plan（订阅）',
    plan_order: 3,
    auth: 'api_key',
    default_base_url: 'https://coding.dashscope.aliyuncs.com/v1',
  }),
  tpl({
    kind: 'openai-codex' as ModelProviderTemplate['kind'],
    label: '用 ChatGPT 订阅登录（Plus / Pro）',
    summary: '已经在付 ChatGPT 的钱就不用再买 API 额度：登录一次，按订阅额度跑。',
    ...OPENAI,
    plan_label: '用 ChatGPT 订阅登录（Plus / Pro）',
    plan_order: 1,
    auth: 'subscription',
    subscription_provider: 'openai-codex',
    default_base_url: 'https://chatgpt.com',
  } as Partial<ModelProviderTemplate> & Pick<ModelProviderTemplate, 'kind' | 'label'>),
  tpl({
    kind: 'openai_compatible',
    label: 'OpenAI（API key，按量计费）',
    summary: '在 platform.openai.com 建一把 key，按 token 付费。与 ChatGPT 的订阅是两笔钱。',
    ...OPENAI,
    plan_label: 'API key（按量计费）',
    plan_order: 2,
    auth: 'api_key',
    default_base_url: 'https://api.openai.com/v1',
  }),
  tpl({
    kind: 'anthropic' as ModelProviderTemplate['kind'],
    label: '用 Claude 订阅登录（Pro / Max）',
    summary: '已经在付 Claude 的钱就不用再买 API 额度：登录一次，按订阅额度跑。',
    ...ANTHROPIC,
    plan_label: '用 Claude 订阅登录（Pro / Max）',
    plan_order: 1,
    auth: 'subscription',
    subscription_provider: 'anthropic',
    default_base_url: 'https://claude.ai',
  } as Partial<ModelProviderTemplate> & Pick<ModelProviderTemplate, 'kind' | 'label'>),
  tpl({
    kind: 'agentsws_cloud',
    label: 'agentsws 云（用积分）',
    summary: '不填 key、不注册。关联一次账号就能用，按积分扣，随时切回自己的 key。',
    vendor: 'agentsws-cloud',
    vendor_label: 'agentsws 云（用积分）',
    vendor_summary: '不填 key、不注册。关联一次账号就能用，按积分扣，随时切回自己的 key。',
    plan_label: '按积分',
    plan_order: 1,
    auth: 'api_key',
    links: [{ label: '价目表与余额', url: '/settings' }],
  }),
]

const RISK =
  '第三方工具用订阅登录没有得到 OpenAI / Anthropic 的明文授权，可能被限流或封禁；账号只属于你本人，不要在公司共用的机器上登录。'

const BROWSER: BrowserSettingsView = {
  mode: 'off',
  attach_allowed: true,
  browserskill_allowed: true,
}

const CU: ComputerUseSettingsView = {
  enabled: true,
  roles: ['site.builder'],
  minutes: 10,
  allowed: true,
  platform: 'darwin',
  driver: { installed: false, pinned_version: '0.28.0', platform_key: 'darwin-arm64' },
}

const POSITIONS: OnboardingPositionView[] = [
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
    id: 'kol-marketing',
    name: '红人营销',
    roles: [
      { id: 'kol.youtube', name: 'YouTube 红人', default: true, what_it_does: '找频道。' },
      { id: 'kol.instagram', name: 'Instagram 红人', default: true, what_it_does: '找博主。' },
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

vi.mock('@/components/connections/bridge', () => ({ openExternal: () => undefined }))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  const credits = {
    linked: true,
    month_credits: 12,
    fetched_at: '2026-09-26T09:00:00.000Z',
    balance: {
      org_id: 'org_1',
      purchased: 80,
      granted: 10,
      available: 90,
      reserved: 0,
      expiring: [],
      low_balance_threshold: 5,
      low_balance: false,
      at: '2026-09-26T09:00:00.000Z',
    },
  }
  return {
    ...actual,
    // 模型
    listModelProviders: async () => ({ providers: [], templates: TEMPLATES }),
    getModelDefaults: async () => ({
      default: '',
      by_purpose: {},
      choices: [],
      data_residency: 'any',
      budget: {},
    }),
    getModelUsage: async () => ({ rows: [], budget: { frozen: false } }),
    getModelPricing: async () => ({ vendors: [], models: [] }),
    getModelImage: async () => ({
      choices: [
        { provider_id: 'agentsws', label: 'Agents 工坊', official: true, default_model: 'img-1' },
      ],
      credits_per_image: 2,
    }),
    // 设置页「通用」「公司档案」：不给所有者岗位，于是下面那几张（浏览器 / 模型…）各自单独量
    getPositions: async () => ({ positions: [] }),
    listOrganizations: async () => [],
    getOnboardingState: async () => ({
      needs_setup: false,
      workspace_name: '王岚的工作区',
      brand_name: 'Nordvolt',
      person: { name: '王岚', email: 'wang@nordvolt.example' },
      other_assignments: 0,
      is_owner: true,
      discovery: { available: true, enabled: true },
      verticals: [
        { key: 'goods', label: '实物商品', hint: '要发货的东西，客户会问"到哪了""能不能退"。' },
        { key: 'digital', label: '虚拟产品与服务', hint: '不用发货的东西。' },
      ],
      storefront_platforms: [
        { key: 'shopify', label: 'Shopify', supported: true },
        { key: 'none', label: '还没开始搭建', supported: true, hint: '选它就先不连店铺。' },
      ],
    }),
    getDeepSeekAccount: async () => ({
      available: true,
      enabled: false,
      signed_in: false,
      default_model: 'deepseek-flash',
      region: 'cn',
    }),
    getModelSubscription: async (provider: string) => ({
      provider,
      label: provider,
      summary: '登录一次，按订阅额度跑。',
      methods: ['device', 'browser'],
      risk_note: RISK,
      available: true,
      signed_in: false,
      in_flight: false,
      models: [],
    }),
    // 浏览器 / 电脑操控
    getBrowserSettings: async () => BROWSER,
    getComputerUseSettings: async () => CU,
    listRoleDefinitions: async () => [
      { id: 'site.builder', name: '建站', holders: 1 },
      { id: 'support.refund', name: '退款', holders: 1 },
    ],
    // 账号与积分
    getCloudAccount: async () => ({
      linked: false,
      cloud_base_url: 'https://cloud.agentsws.example',
    }),
    getCloudCredits: async () => credits,
    getCloudPricing: async () => ({
      version: 1,
      as_of: '2026-09-15',
      credit_cny: 1,
      ai_multiplier: 3,
      fx: { CNY: 1, USD: 7.1 },
      entries: [],
    }),
    getCloudUsage: async () => null,
    getTopupTiers: async () => ({
      version: 1,
      as_of: '2026-09-19',
      credits_per_usd: 7,
      tiers: [{ id: 'usd20', usd: 20, credits: 140, label_zh: '入门', label_en: 'Starter' }],
    }),
    getKolCloudStatus: async () => ({
      linked: true,
      cloud_reachable: true,
      pending: 0,
      conflicts: [],
      device_id: 'dev_1',
      at: '2026-09-26T09:00:00.000Z',
      subscription: { state: 'none' },
    }),
    getCapabilitySources: async () => ({ workspace_id: 'ws_1', capability_sources: {} }),
  }
})

// ── 量 ──────────────────────────────────────────────────────────────

const found: { name: string; report: CardReport }[] = []

function check(name: string, card: Element): void {
  const report = reportCard(card)
  found.push({ name, report })
  expect(
    report.weight,
    `「${name}」可见说明 ${report.weight} 字 > ${CARD_TEXT_LIMIT}：${report.text}`,
  ).toBeLessThanOrEqual(CARD_TEXT_LIMIT)
  expect(report.ordered, `「${name}」里还有步骤清单 <ol>`).toBe(0)
  expect(
    report.externalLinks.length,
    `「${name}」外链 ${report.externalLinks.join(' ')}`,
  ).toBeLessThanOrEqual(1)
  expect(report.longSafety, `「${name}」安全承诺没压到一句`).toEqual([])
}

describe('设置页', () => {
  it('通用与公司档案', async () => {
    renderWithProviders(<SettingsPage />, '/settings', '')
    check('通用', await screen.findByTestId('settings-general'))
    check('公司档案', await screen.findByTestId('settings-company'))
  })

  it('生图', async () => {
    renderWithProviders(<ImageModelSection assignment="asg_1" />)
    check('生图', await screen.findByTestId('models-image'))
  })

  it('浏览器：四种方式各选一次，卡上都不超', async () => {
    renderWithProviders(<BrowserCard assignment="asg_1" />)
    const card = await screen.findByTestId('settings-browser')
    for (const mode of ['off', 'attach', 'launch', 'browserskill']) {
      fireEvent.click(
        screen.getByTestId(`browser-mode-${mode}`).querySelector('input') as HTMLInputElement,
      )
      check(`浏览器 · ${mode}`, card)
    }
    expect(screen.getByTestId('tutorial-link').getAttribute('data-slug')).toBe('browser')
  })

  it('电脑操控：打开之后（三步都在）也不超', async () => {
    renderWithProviders(<ComputerUseCard assignment="asg_1" />)
    const card = await screen.findByTestId('settings-computer-use')
    await screen.findByTestId('computer-use-roles')
    check('电脑操控', card)
    expect(screen.getByTestId('tutorial-link').getAttribute('data-slug')).toBe('computer-use')
  })

  it('模型 → 加一个：每家每个方案都不超、不铺步骤与外链，每张都有「看教程」', async () => {
    renderWithProviders(<ModelsPanel assignment="asg_1" />)
    await screen.findByTestId('models-panel')
    const cards = await screen.findAllByTestId('model-template')
    expect(cards.map((c) => c.getAttribute('data-vendor'))).toEqual([
      'deepseek',
      'openai-compatible',
      'bailian',
      'openai',
      'anthropic',
      'agentsws-cloud',
    ])
    for (const card of cards) {
      const vendor = card.getAttribute('data-vendor') ?? ''
      const plans = [...card.querySelectorAll('[data-testid="model-plan"] input')]
      if (plans.length === 0) check(`模型 · ${vendor}`, card)
      for (const [i, radio] of plans.entries()) {
        fireEvent.click(radio)
        await waitFor(() => {
          expect(
            card.querySelectorAll('[data-testid="model-plan"]')[i]?.getAttribute('data-selected'),
          ).toBe('true')
        })
        check(`模型 · ${vendor} · 方案 ${String(i + 1)}`, card)
      }
      expect(card.querySelector('[data-testid="tutorial-link"]'), vendor).not.toBeNull()
      // 服务端给的步骤一条都不在卡面上
      for (const step of STEPS) expect(card.textContent).not.toContain(step)
    }
  })

  it('模型 → Agents 工坊云那张卡', async () => {
    renderWithProviders(<ModelCloudCard assignment="asg_1" />)
    check('模型 · Agents 工坊云', await screen.findByTestId('model-cloud-card'))
  })

  it('账号与积分：账号卡与积分面板里的每张卡', async () => {
    const { container } = renderWithProviders(
      <>
        <CloudAccountCard assignment="asg_1" />
        <CreditsPanel assignment="asg_1" />
      </>,
    )
    await screen.findByTestId('cloud-account-unlinked')
    await waitFor(() => {
      expect(container.querySelectorAll('[data-slot="card"]').length).toBeGreaterThan(1)
    })
    await screen.findByTestId('kol-cloud-card')
    for (const [i, card] of [...container.querySelectorAll('[data-slot="card"]')].entries())
      check(`账号与积分 · ${card.getAttribute('data-testid') ?? String(i + 1)}`, card)
  })
})

describe('初始化向导', () => {
  it('第 ① 步：三张大卡各展开一次', async () => {
    renderWithProviders(<AiStep assignment="asg_1" onConnected={() => {}} onDemo={() => {}} />)
    await screen.findByTestId('onboarding-ai')
    for (const [card, pick] of [
      ['ai-card-official', 'ai-pick-official'],
      ['ai-card-own', 'ai-pick-own'],
      ['ai-card-account', 'ai-pick-account'],
    ] as const) {
      fireEvent.click(screen.getByTestId(pick))
      await waitFor(() => {
        expect(screen.getByTestId(card).getAttribute('data-open')).toBe('true')
      })
      check(`向导 ① · ${card}`, screen.getByTestId(card))
    }
    // DeepSeek 卡切到 API 那种：原来这里铺着开放平台的几步与外链
    fireEvent.click(await screen.findByTestId('ai-ds-mode-api'))
    await screen.findByTestId('ai-ds-api-hint')
    check('向导 ① · DeepSeek · API', screen.getByTestId('ai-card-account'))
  })

  it('三步小勾叉是结果不是步骤清单：卡里出现它不算违规', async () => {
    const { ModelCheckSteps } = await import('@/components/models/model-check-steps')
    const { container } = renderWithProviders(
      <section>
        <p>已配好</p>
        <ModelCheckSteps
          steps={[
            { step: 'connect', ok: true },
            { step: 'text', ok: true },
            { step: 'vision', ok: false },
          ]}
        />
      </section>,
    )
    check('三步小勾叉', container)
  })

  it('第 ③ 步：挑岗位', () => {
    const { container } = renderWithProviders(
      <RolePicker
        positions={POSITIONS}
        value={{ position_ids: ['customer-care'], role_ids: [], custom_position_name: '' }}
        onChange={() => {}}
      />,
    )
    check('向导 ③ · 挑岗位', container)
  })

  it('第 ④ 步：连接与开工（每一行各量一次）', () => {
    renderWithProviders(<PlanList plan={PLAN} />)
    for (const id of [
      'onboarding-plan-model',
      'onboarding-plan-connector',
      'onboarding-plan-skill',
      'onboarding-plan-position',
    ])
      for (const [i, row] of screen.getAllByTestId(id).entries())
        check(`向导 ④ · ${id} ${String(i + 1)}`, row)
  })
})

describe('量出来的数（给下一轮看的）', () => {
  it('打一张表到控制台（不断言）', () => {
    // 前面几组跑完才有数；单独跑这一条时是空的
    for (const { name, report } of found)
      console.info(`[less-text] ${String(report.weight).padStart(3)} 字  ${name}`)
    expect(true).toBe(true)
  })
})
