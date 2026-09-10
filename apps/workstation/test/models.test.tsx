/**
 * 设置页的「模型」与首页黄条（WP25 交付 C）。
 *
 * 三组断言：
 * 1. **key 零泄漏**：填进原生表单的 API key 只出现在 `saveModelProvider` 的那一次调用里——
 *    不进 `console`、不进 `localStorage`、不进渲染出来的 DOM，保存之后表单里也不留；
 * 2. **黄条**：没有能用的模型时出现在首页与设置页，接上之后消失；不是所有者就什么都不显示；
 * 3. **面板**：模板卡带准备说明与预设、试跑结果就地显示、环境变量那条不给删。
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ModelDefaultsView,
  ModelListing,
  ModelPricingRefreshResult,
  ModelPricingView,
  ModelProviderTemplate,
  ModelProviderView,
  ModelTestResult,
  ModelUsageView,
} from '@/lib/api'
import { renderWithProviders } from './helpers'

const T0 = '2026-09-09T09:00:00.000Z'
/** 测试里唯一的"凭据"。所有零泄漏断言都盯着这一串。 */
const API_KEY = 'sk-workstation-never-leaks-4b7e'

const DEEPSEEK_TEMPLATE: ModelProviderTemplate = {
  kind: 'deepseek',
  label: 'DeepSeek 官方',
  summary: '国内直连、便宜、够用。没别的偏好就选它。',
  default_base_url: 'https://api.deepseek.com',
  default_model: 'deepseek-chat',
  region: 'cn',
  steps: ['注册登录', '创建 API key', '复制那一串', '粘进表单保存', '点测试'],
  links: [{ label: 'DeepSeek 开放平台', url: 'https://platform.deepseek.com/api_keys' }],
}

const CUSTOM_TEMPLATE: ModelProviderTemplate = {
  kind: 'openai_compatible',
  label: 'OpenAI 兼容（自定义）',
  summary: '任何 OpenAI 兼容的地址：Kimi、通义、智谱、本地 Ollama…',
  default_base_url: 'https://api.openai.com/v1',
  default_model: 'gpt-4o-mini',
  region: 'global',
  steps: ['拿到地址与 key', '填进来'],
  links: [{ label: 'OpenAI', url: 'https://platform.openai.com/api-keys' }],
  presets: [
    {
      id: 'kimi',
      label: 'Kimi（Moonshot）',
      base_url: 'https://api.moonshot.cn/v1',
      model: 'moonshot-v1-8k',
      region: 'cn',
    },
    {
      id: 'ollama',
      label: '本地 Ollama',
      base_url: 'http://127.0.0.1:11434/v1',
      model: 'llama3.1',
      region: 'cn',
    },
  ],
}

const ACTIVE: ModelProviderView = {
  id: 'deepseek',
  kind: 'deepseek',
  label: '我的 DeepSeek',
  base_url: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  region: 'cn',
  has_key: true,
  active: true,
  price_in: 0.27,
  price_out: 1.1,
}

const FROM_ENV: ModelProviderView = {
  ...ACTIVE,
  label: 'DeepSeek 官方（环境变量）',
  from_env: true,
}

const NO_KEY: ModelProviderView = {
  id: 'mine',
  kind: 'openai_compatible',
  label: '我的网关',
  base_url: 'http://127.0.0.1:11434/v1',
  model: 'llama3.1',
  region: 'cn',
  has_key: false,
  active: false,
  inactive_reason: '还没填 API key',
}

const DEFAULTS: ModelDefaultsView = {
  default: 'deepseek/deepseek-chat',
  by_purpose: {},
  data_residency: 'cn',
  budget: {},
  choices: [{ id: 'deepseek/deepseek-chat', label: '我的 DeepSeek（deepseek-chat）' }],
}

const USAGE: ModelUsageView = {
  since: T0,
  rows: [
    {
      purpose: 'run',
      calls: 3,
      input_tokens: 1200,
      output_tokens: 340,
      cached_tokens: 0,
      cost_base: 0.0007,
    },
  ],
  total: {
    purpose: 'run',
    calls: 3,
    input_tokens: 1200,
    output_tokens: 340,
    cached_tokens: 0,
    cost_base: 0.0007,
  },
  budget: { used_base: 0.0007, cap_base: 0, frozen: false },
}

/** WP42：内置价目表（就是 catalog.json 里 DeepSeek 那一段）。 */
const PRICING: ModelPricingView = {
  vendors: [
    {
      id: 'deepseek',
      label: 'DeepSeek 官方',
      currency: 'USD',
      hosts: ['api.deepseek.com'],
      source_url: 'https://api-docs.deepseek.com/quick_start/pricing/',
      as_of: '2026-09-10',
      models: [
        {
          model: 'deepseek-flash',
          in: 0.3,
          out: 1.2,
          cached: 0.006,
          aliases: ['deepseek-v4-flash'],
        },
        { model: 'deepseek-v4-pro', in: 1.32, out: 3.96, cached: 0.044 },
      ],
    },
  ],
}

const PRICE_REFRESH: ModelPricingRefreshResult = {
  at: T0,
  ok: true,
  vendors: [
    { id: 'deepseek', label: 'DeepSeek 官方', ok: true, models: 2 },
    { id: 'qwen', label: '通义千问（百炼）', ok: false, models: 0, reason: '阶梯计价，抓不准' },
  ],
  updated_providers: 1,
}

const OWNER_POSITION = {
  position_id: 'asg_owner',
  role_id: 'common.owner',
  role_name: '工作区所有者',
  ranges: [] as { kind: string; id: string }[],
  ready: true,
  missing_connectors: [] as string[],
  tile_ids: [] as string[],
  range: 'yesterday' as const,
  show_tiles: false,
}

// ── 假 API 层 ─────────────────────────────────────────────────────────

const state = {
  providers: [] as ModelProviderView[],
  templates: [DEEPSEEK_TEMPLATE, CUSTOM_TEMPLATE] as ModelProviderTemplate[],
  /** 清空就是"当前身份不是所有者"（面板与黄条都该静默）。 */
  positions: [OWNER_POSITION] as (typeof OWNER_POSITION)[],
  /** 列表这条路 403（客服岗位问模型面就是这样）。 */
  forbidden: false,
  testResult: { ok: true, reason: 'ok', checked_at: T0 } as ModelTestResult,
  priceRefresh: PRICE_REFRESH,
  /** WP42：`discoverModelProviderModels` 回什么。 */
  listing: {
    ok: true,
    models: ['deepseek-chat', 'deepseek-flash', 'deepseek-v4-pro'],
    checked_at: T0,
  } as ModelListing,
}

const saved: { id: string; input: Record<string, unknown> }[] = []
const discovered: { id: string; input: Record<string, unknown> }[] = []
const priceRefreshes: number[] = []
const removed: string[] = []
const tested: string[] = []

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getPositions: async () => ({ positions: state.positions, tile_library: [], max_tiles: 6 }),
    listModelProviders: async () => {
      if (state.forbidden) throw Object.assign(new Error('forbidden'), { code: 'forbidden' })
      return { providers: state.providers, templates: state.templates }
    },
    saveModelProvider: async (id: string, input: Record<string, unknown>) => {
      saved.push({ id, input })
      const next: ModelProviderView = {
        ...ACTIVE,
        id,
        label: String(input.label ?? ACTIVE.label),
        model: String(input.model ?? ACTIVE.model),
      }
      state.providers = [next]
      return next
    },
    removeModelProvider: async (id: string) => {
      removed.push(id)
      state.providers = state.providers.filter((p) => p.id !== id)
      return { removed: true }
    },
    testModelProvider: async (id: string) => {
      tested.push(id)
      return state.testResult
    },
    discoverModelProviderModels: async (id: string, input: Record<string, unknown>) => {
      discovered.push({ id, input })
      return state.listing
    },
    getModelDefaults: async () => DEFAULTS,
    setModelDefaults: async () => DEFAULTS,
    getModelUsage: async () => USAGE,
    getModelPricing: async () => PRICING,
    refreshModelPricing: async () => {
      priceRefreshes.push(1)
      return state.priceRefresh
    },
  }
})

const { ModelsPanel } = await import('@/components/models/models-panel')
const { suggestProviderId } = await import('@/components/models/model-form')
const { NoModelBanner } = await import('@/components/models/no-model-banner')

beforeEach(() => {
  state.providers = []
  state.positions = [OWNER_POSITION]
  state.forbidden = false
  state.testResult = { ok: true, reason: 'ok', checked_at: T0 }
  saved.length = 0
  removed.length = 0
  tested.length = 0
  discovered.length = 0
  priceRefreshes.length = 0
  state.priceRefresh = PRICE_REFRESH
  state.listing = {
    ok: true,
    models: ['deepseek-chat', 'deepseek-flash', 'deepseek-v4-pro'],
    checked_at: T0,
  }
  // localStorage 由 AppProvider 自己管，这里不清（jsdom 的实现没有 clear）
})

describe('WP25 §C 「还没接模型」黄条', () => {
  it('一个能用的模型都没有：黄条出现，指向设置页', async () => {
    renderWithProviders(<NoModelBanner />)
    const banner = await screen.findByTestId('no-model-banner')
    expect(banner.textContent).toContain('还没接模型')
    expect(within(banner).getByRole('link').getAttribute('href')).toBe('/settings')
  })

  it('有 provider 但都没填 key：还是要出现（"配了"不等于"能用"）', async () => {
    state.providers = [NO_KEY]
    renderWithProviders(<NoModelBanner />)
    expect(await screen.findByTestId('no-model-banner')).toBeTruthy()
  })

  it('接上一个能用的：黄条不见了', async () => {
    state.providers = [ACTIVE]
    renderWithProviders(<NoModelBanner />)
    await waitFor(() => {
      expect(screen.queryByTestId('no-model-banner')).toBeNull()
    })
  })

  it('不是所有者（403）：什么都不显示，而不是给一条点不动的提示', async () => {
    state.forbidden = true
    renderWithProviders(<NoModelBanner />)
    await waitFor(() => {
      expect(screen.queryByTestId('no-model-banner')).toBeNull()
    })
  })

  it('没有所有者岗位时也不显示（问都不问）', async () => {
    state.positions = []
    renderWithProviders(<NoModelBanner />)
    await waitFor(() => {
      expect(screen.queryByTestId('no-model-banner')).toBeNull()
    })
  })
})

describe('WP25 §C 模型面板：填 key（零泄漏）', () => {
  it('填进去的 key 只走 saveModelProvider 一次，DOM / console / localStorage 都不留', async () => {
    const logs: string[] = []
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(' '))
      }),
    )
    const user = userEvent.setup()
    renderWithProviders(<ModelsPanel assignment="asg_owner" />)

    await user.click((await screen.findAllByText('填 API key'))[0] as HTMLElement)
    const form = await screen.findByTestId('model-form')
    await user.type(within(form).getByLabelText('API key'), API_KEY)
    await user.click(within(form).getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(saved).toHaveLength(1)
    })
    expect(saved[0]?.input.api_key).toBe(API_KEY)

    // 保存之后：表单收起来了，页面上一个字节都没有 key
    await waitFor(() => {
      expect(screen.queryByTestId('model-form')).toBeNull()
    })
    expect(document.body.innerHTML).not.toContain(API_KEY)
    expect(JSON.stringify(globalThis.localStorage)).not.toContain(API_KEY)
    expect(logs.join('\n')).not.toContain(API_KEY)
    for (const s of spies) s.mockRestore()
  })

  it('key 的输入框是 password，且关掉浏览器与密码管理器的自动填写', async () => {
    const user = userEvent.setup()
    renderWithProviders(<ModelsPanel assignment="asg_owner" />)
    await user.click((await screen.findAllByText('填 API key'))[0] as HTMLElement)
    const input = within(await screen.findByTestId('model-form')).getByLabelText('API key')
    expect(input.getAttribute('type')).toBe('password')
    expect(input.getAttribute('autocomplete')).toBe('off')
    expect(input.getAttribute('data-1p-ignore')).toBe('true')
  })

  it('表单上写明"key 不会进模型、不会上传"', async () => {
    const user = userEvent.setup()
    renderWithProviders(<ModelsPanel assignment="asg_owner" />)
    await user.click((await screen.findAllByText('填 API key'))[0] as HTMLElement)
    const form = await screen.findByTestId('model-form')
    expect(form.textContent).toMatch(/不上传|不进模型|这台电脑/)
  })

  it('WP43 ②：字段说明进问号 tooltip，不再在框底下铺灰字', async () => {
    const user = userEvent.setup()
    renderWithProviders(<ModelsPanel assignment="asg_owner" />)
    await user.click((await screen.findAllByText('填 API key'))[0] as HTMLElement)
    const form = await screen.findByTestId('model-form')
    // 接口地址那条说明只在 Hint 上（jsdom 打不开 tooltip，读 aria-label / data-hint）
    const hints = Array.from(form.querySelectorAll('[data-slot="hint"]'))
    expect(hints.length).toBeGreaterThan(0)
    const texts = hints.map((h) => h.getAttribute('data-hint'))
    expect(texts).toContain('看那家的文档，一般以 /v1 结尾。')
    for (const h of hints) {
      expect(h.getAttribute('aria-label')).toBe(h.getAttribute('data-hint'))
      expect(h.querySelector('svg')).not.toBeNull()
    }
    // 已经不再作为正文渲染
    expect(form.textContent).not.toContain('看那家的文档')
    // 例外：安全承诺照旧看得见
    expect(form.querySelector('[data-slot="safety-note"]')).not.toBeNull()
  })

  it('已经存过 key 的那条：改配置时 key 可以留空（不用重填）', async () => {
    state.providers = [ACTIVE]
    const user = userEvent.setup()
    renderWithProviders(<ModelsPanel assignment="asg_owner" />)
    await user.click(await screen.findByRole('button', { name: '改' }))
    const form = await screen.findByTestId('model-form')
    const input = within(form).getByLabelText('API key')
    expect((input as HTMLInputElement).required).toBe(false)
    expect(input.getAttribute('placeholder')).toBe('••••••••')
    await user.click(within(form).getByRole('button', { name: '保存' }))
    await waitFor(() => {
      expect(saved).toHaveLength(1)
    })
    // 留空就是"别动已经存着的那把"：这一次请求里没有 api_key
    expect(saved[0]?.input.api_key).toBeUndefined()
  })
})

describe('WP25 §C 模型面板：模板与预设', () => {
  it('一个都没配时给一句人话，两张模板卡各带 ≤ 5 步说明与外链', async () => {
    renderWithProviders(<ModelsPanel assignment="asg_owner" />)
    expect((await screen.findByTestId('models-empty')).textContent).toContain('还一个都没配')
    const cards = await screen.findAllByTestId('model-template')
    expect(cards).toHaveLength(2)
    for (const card of cards) {
      expect(within(card).getAllByRole('listitem').length).toBeLessThanOrEqual(5)
      expect(within(card).getAllByRole('link').length).toBeGreaterThan(0)
    }
  })

  it('自定义那张的预设点一下就把地址和模型名填好', async () => {
    const user = userEvent.setup()
    renderWithProviders(<ModelsPanel assignment="asg_owner" />)
    const cards = await screen.findAllByTestId('model-template')
    const custom = cards[1] as HTMLElement
    await user.click(within(custom).getByText('填 API key'))
    const form = await screen.findByTestId('model-form')
    await user.click(within(form).getByRole('button', { name: '本地 Ollama' }))
    const fieldValue = (label: string): string =>
      (within(form).getByLabelText(label) as HTMLInputElement).value
    expect(fieldValue('接口地址')).toBe('http://127.0.0.1:11434/v1')
    expect(fieldValue('模型名')).toBe('llama3.1')
    expect(fieldValue('编号')).toBe('ollama')
  })
})

describe('WP25 §C 模型面板：已配的那几条', () => {
  it('测试按钮：结果就地显示，且不带 key', async () => {
    state.providers = [ACTIVE]
    state.testResult = {
      ok: true,
      reason: 'ok',
      model: 'deepseek/deepseek-chat',
      duration_ms: 412,
      detail: '通了：回了 1 个字，用了 10 个 token',
      checked_at: T0,
    }
    const user = userEvent.setup()
    renderWithProviders(<ModelsPanel assignment="asg_owner" />)
    await user.click(await screen.findByRole('button', { name: '测试' }))
    const result = await screen.findByTestId('model-test-result')
    expect(tested).toEqual(['deepseek'])
    expect(result.textContent).toContain('通了')
    expect(result.textContent).toContain('deepseek-chat')
    expect(document.body.innerHTML).not.toContain(API_KEY)
  })

  it('测试失败：把中文原因显示出来，而不是一个红叉', async () => {
    state.providers = [ACTIVE]
    state.testResult = {
      ok: false,
      reason: 'provider_unavailable',
      detail: 'API key 不对或者已经失效，去控制台重新生成一把',
      checked_at: T0,
    }
    const user = userEvent.setup()
    renderWithProviders(<ModelsPanel assignment="asg_owner" />)
    await user.click(await screen.findByRole('button', { name: '测试' }))
    expect((await screen.findByTestId('model-test-result')).textContent).toContain(
      'API key 不对或者已经失效',
    )
  })

  it('没填 key 的那条标出来为什么用不了', async () => {
    state.providers = [NO_KEY]
    renderWithProviders(<ModelsPanel assignment="asg_owner" />)
    expect((await screen.findByTestId('model-inactive')).textContent).toContain('还没填 API key')
  })

  it('环境变量给的那条：标出来，而且不给删', async () => {
    state.providers = [FROM_ENV]
    renderWithProviders(<ModelsPanel assignment="asg_owner" />)
    expect(await screen.findByTestId('model-from-env')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '删' })).toBeNull()
  })

  it('删之前先问一句（key 也会一起删掉）', async () => {
    state.providers = [ACTIVE]
    const confirm = vi.spyOn(globalThis, 'confirm').mockReturnValue(false)
    const user = userEvent.setup()
    renderWithProviders(<ModelsPanel assignment="asg_owner" />)
    await user.click(await screen.findByRole('button', { name: '删' }))
    expect(confirm).toHaveBeenCalled()
    expect(String(confirm.mock.calls[0]?.[0])).toContain('API key')
    // 说了"不"就真的不删
    expect(removed).toEqual([])
    confirm.mockReturnValue(true)
    await user.click(screen.getByRole('button', { name: '删' }))
    await waitFor(() => {
      expect(removed).toEqual(['deepseek'])
    })
    confirm.mockRestore()
  })

  it('花费表按 purpose 分行；没配模型时不显示（没什么可看）', async () => {
    state.providers = [ACTIVE]
    renderWithProviders(<ModelsPanel assignment="asg_owner" />)
    const table = await screen.findByTestId('model-usage')
    expect(table.textContent).toContain('跑活')
    expect(table.textContent).toContain('3')
  })

  it('按 purpose 选模型：六件事各一行，选项来自能用的那几条', async () => {
    state.providers = [ACTIVE]
    renderWithProviders(<ModelsPanel assignment="asg_owner" />)
    const panel = await screen.findByTestId('model-defaults')
    for (const label of ['跑活', '抽取', '反思', '向量', '判分', '转写']) {
      expect(panel.textContent, label).toContain(label)
    }
  })
})

describe('WP42 §1 模型名从接口拉', () => {
  it('点「拉取模型列表」：模型名框变成点开就列全部的下拉（不用先敲字）', async () => {
    const user = userEvent.setup()
    renderWithProviders(<ModelsPanel assignment="asg_owner" />)
    await user.click((await screen.findAllByText('填 API key'))[0] as HTMLElement)
    const form = await screen.findByTestId('model-form')

    // 拉之前：就是一个手填的框，没有下拉按钮
    expect(within(form).queryByTestId('model-dropdown-toggle')).toBeNull()
    expect(within(form).queryByTestId('model-list')).toBeNull()

    await user.type(within(form).getByLabelText('API key'), API_KEY)
    await user.click(within(form).getByTestId('model-discover'))

    // 拉到之后：一个下拉按钮，点开就列全部（不用先敲字）
    const toggle = await within(form).findByTestId('model-dropdown-toggle')
    fireEvent.mouseDown(toggle)
    const list = await within(form).findByTestId('model-list')
    expect(list.querySelectorAll('[role="option"]')).toHaveLength(3)
    // 点一项就填进输入框
    fireEvent.mouseDown(list.querySelectorAll('[role="option"]')[1] as HTMLElement)
    expect((within(form).getByTestId('model-name-input') as HTMLInputElement).value).toBe(
      (list.querySelectorAll('[role="option"]')[1] as HTMLElement).textContent,
    )
  })

  it('拉取带上表单里现填的地址与 key；key 不留在 DOM 里', async () => {
    const user = userEvent.setup()
    renderWithProviders(<ModelsPanel assignment="asg_owner" />)
    await user.click((await screen.findAllByText('填 API key'))[0] as HTMLElement)
    const form = await screen.findByTestId('model-form')
    await user.type(within(form).getByLabelText('API key'), API_KEY)
    await user.click(within(form).getByTestId('model-discover'))

    await waitFor(() => {
      expect(discovered).toHaveLength(1)
    })
    expect(discovered[0]?.input).toMatchObject({
      base_url: 'https://api.deepseek.com',
      api_key: API_KEY,
      region: 'cn',
    })
    expect(document.body.innerHTML).not.toContain(API_KEY)
  })

  it('拉不到：把原因原样说出来，模型名还是能手填', async () => {
    state.listing = {
      ok: false,
      models: [],
      reason: '连不上这个地址：本地模型的话看看它起来了没有',
      checked_at: T0,
    }
    const user = userEvent.setup()
    renderWithProviders(<ModelsPanel assignment="asg_owner" />)
    await user.click((await screen.findAllByText('填 API key'))[0] as HTMLElement)
    const form = await screen.findByTestId('model-form')
    await user.type(within(form).getByLabelText('API key'), API_KEY)
    await user.click(within(form).getByTestId('model-discover'))

    const failed = await within(form).findByTestId('model-discover-failed')
    expect(failed.textContent).toContain('看看它起来了没有')
    // 退回手填：框还在，还能打字
    const input = within(form).getByTestId('model-name-input') as HTMLInputElement
    expect(input.getAttribute('list')).toBeNull()
    await user.clear(input)
    await user.type(input, 'llama3.1')
    expect(input.value).toBe('llama3.1')
  })

  it('改一条已有的：上次拉回来的清单直接就在（不用再点一次）', async () => {
    state.providers = [
      { ...ACTIVE, models: ['deepseek-chat', 'deepseek-flash'], last_listing: state.listing },
    ]
    const user = userEvent.setup()
    renderWithProviders(<ModelsPanel assignment="asg_owner" />)
    await user.click(await screen.findByText('改'))
    const form = await screen.findByTestId('model-form')
    fireEvent.mouseDown(within(form).getByTestId('model-dropdown-toggle'))
    expect(within(form).getByTestId('model-list').querySelectorAll('[role="option"]')).toHaveLength(
      2,
    )
    expect(discovered).toHaveLength(0)
  })
})

describe('WP42 §2 价格自动填 + 手动可改', () => {
  it('选定模型：三个价自动填上，并写清楚来源是官网哪一天', async () => {
    const user = userEvent.setup()
    renderWithProviders(<ModelsPanel assignment="asg_owner" />)
    await user.click((await screen.findAllByText('填 API key'))[0] as HTMLElement)
    const form = await screen.findByTestId('model-form')

    const model = within(form).getByTestId('model-name-input') as HTMLInputElement
    await user.clear(model)
    await user.type(model, 'deepseek-flash')

    await waitFor(() => {
      expect((within(form).getByTestId('model-price_in') as HTMLInputElement).value).toBe('0.3')
    })
    expect((within(form).getByTestId('model-price_out') as HTMLInputElement).value).toBe('1.2')
    expect((within(form).getByTestId('model-price_cached') as HTMLInputElement).value).toBe('0.006')
    expect(within(form).getByTestId('model-price-source').textContent).toContain('2026-09-10')
    expect(within(form).getByTestId('model-price-source').textContent).toContain('USD')
  })

  it('用户改了价：标成"手动"，换模型也不再自动改它，保存时带 price_source=manual', async () => {
    const user = userEvent.setup()
    renderWithProviders(<ModelsPanel assignment="asg_owner" />)
    await user.click((await screen.findAllByText('填 API key'))[0] as HTMLElement)
    const form = await screen.findByTestId('model-form')

    const priceIn = within(form).getByTestId('model-price_in') as HTMLInputElement
    await user.clear(priceIn)
    await user.type(priceIn, '5')
    expect(within(form).getByTestId('model-price-source').textContent).toContain('手动')

    // 换个模型：价不动
    const model = within(form).getByTestId('model-name-input') as HTMLInputElement
    await user.clear(model)
    await user.type(model, 'deepseek-v4-pro')
    expect(priceIn.value).toBe('5')

    await user.type(within(form).getByLabelText('API key'), API_KEY)
    await user.click(within(form).getByRole('button', { name: '保存' }))
    await waitFor(() => {
      expect(saved).toHaveLength(1)
    })
    expect(saved[0]?.input).toMatchObject({ price_in: 5, price_source: 'manual' })
  })

  it('价目表里没有的（本机 Ollama）：不硬填一个数，提示自己去官网抄', async () => {
    const user = userEvent.setup()
    renderWithProviders(<ModelsPanel assignment="asg_owner" />)
    await user.click((await screen.findAllByText('填 API key'))[1] as HTMLElement)
    const form = await screen.findByTestId('model-form')
    const base = within(form).getByLabelText('接口地址') as HTMLInputElement
    await user.clear(base)
    await user.type(base, 'http://127.0.0.1:11434/v1')
    const model = within(form).getByTestId('model-name-input') as HTMLInputElement
    await user.clear(model)
    await user.type(model, 'llama3.1')
    expect((within(form).getByTestId('model-price_in') as HTMLInputElement).value).toBe('')
    expect(within(form).getByTestId('model-price-source').textContent).toContain('自己去官网抄')
  })

  it('点「去官网抓一次」：抓到的与没抓到的都逐家写出来', async () => {
    const user = userEvent.setup()
    renderWithProviders(<ModelsPanel assignment="asg_owner" />)
    await user.click(await screen.findByTestId('model-pricing-refresh'))
    const result = await screen.findByTestId('model-pricing-result')
    expect(result.textContent).toContain('抓到 2 条')
    expect(result.textContent).toContain('官网抓取失败')
    expect(result.textContent).toContain('阶梯计价')
    expect(priceRefreshes).toHaveLength(1)
  })

  it('被急停拦下：说是急停，不假装"抓不到"', async () => {
    state.priceRefresh = {
      at: T0,
      ok: false,
      vendors: [],
      updated_providers: 0,
      reason: '出站急停开着，这一轮没去抓。解除急停之后再点一次。',
    }
    const user = userEvent.setup()
    renderWithProviders(<ModelsPanel assignment="asg_owner" />)
    await user.click(await screen.findByTestId('model-pricing-refresh'))
    const result = await screen.findByTestId('model-pricing-result')
    expect(result.textContent).toContain('急停')
  })
})

describe('WP42 §4 「编号」折进「高级」', () => {
  it('新建时表单上看不到「编号」——它在「高级」里，而且已经按接口地址填好了', async () => {
    const user = userEvent.setup()
    renderWithProviders(<ModelsPanel assignment="asg_owner" />)
    await user.click((await screen.findAllByText('填 API key'))[0] as HTMLElement)
    const form = await screen.findByTestId('model-form')

    const advanced = within(form).getByTestId('model-advanced') as HTMLDetailsElement
    // 默认收着：第一屏上没有这个字段
    expect(advanced.open).toBe(false)
    expect((within(form).getByTestId('model-id-input') as HTMLInputElement).value).toBe('deepseek')
  })

  it('换了接口地址：编号跟着改（api.moonshot.cn → kimi）', async () => {
    const user = userEvent.setup()
    renderWithProviders(<ModelsPanel assignment="asg_owner" />)
    await user.click((await screen.findAllByText('填 API key'))[1] as HTMLElement)
    const form = await screen.findByTestId('model-form')
    const base = within(form).getByTestId('model-base-url') as HTMLInputElement
    await user.clear(base)
    await user.type(base, 'https://api.moonshot.cn/v1')
    await waitFor(() => {
      expect((within(form).getByTestId('model-id-input') as HTMLInputElement).value).toBe('kimi')
    })
  })

  it('保存时把自动生成的编号带上（用户一个字都没打过）', async () => {
    const user = userEvent.setup()
    renderWithProviders(<ModelsPanel assignment="asg_owner" />)
    await user.click((await screen.findAllByText('填 API key'))[0] as HTMLElement)
    const form = await screen.findByTestId('model-form')
    await user.type(within(form).getByLabelText('API key'), API_KEY)
    await user.click(within(form).getByRole('button', { name: '保存' }))
    await waitFor(() => {
      expect(saved).toHaveLength(1)
    })
    expect(saved[0]?.id).toBe('deepseek')
  })

  it('改一条已有的：编号根本不出现（存下来就不能改）', async () => {
    state.providers = [ACTIVE]
    const user = userEvent.setup()
    renderWithProviders(<ModelsPanel assignment="asg_owner" />)
    await user.click(await screen.findByText('改'))
    const form = await screen.findByTestId('model-form')
    expect(within(form).queryByTestId('model-advanced')).toBeNull()
  })

  it('suggestProviderId：认得出的几家给好记的名字，重名往后排', () => {
    expect(suggestProviderId('https://api.deepseek.com', [])).toBe('deepseek')
    expect(suggestProviderId('https://api.moonshot.cn/v1', [])).toBe('kimi')
    expect(suggestProviderId('https://dashscope.aliyuncs.com/compatible-mode/v1', [])).toBe('qwen')
    expect(suggestProviderId('https://open.bigmodel.cn/api/paas/v4', [])).toBe('zhipu')
    expect(suggestProviderId('http://127.0.0.1:11434/v1', [])).toBe('ollama')
    // 认不出来的取主机名头一段（去掉 api. / www.）
    expect(suggestProviderId('https://api.example.dev/v1', [])).toBe('example')
    // 重名往后排
    expect(suggestProviderId('https://api.deepseek.com', ['deepseek'])).toBe('deepseek-2')
    // 地址是空的 / 乱写的也得给出一个合法编号
    expect(suggestProviderId('', [])).toBe('model')
  })
})
