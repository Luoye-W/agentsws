/**
 * WP127：文字模型必须能看图；生图单独一档（设置页「模型」那一侧）。
 *
 * 三组断言：
 * 1. **三步小清单**：测试结果带三步时就地画出三个勾叉，卡在"看得懂图"那一格的一眼看得出；
 * 2. **老用户提示**：默认模型看不了图 / 还没验证过能不能看图时，顶部一条提示（不挡路）；
 * 3. **生图一档**：单价常显、可以不配、选一条保存即生效。
 */
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ModelDefaultsView,
  ModelImageView,
  ModelProviderView,
  ModelTestResult,
} from '@/lib/api'
import { renderWithProviders } from './helpers'

const T0 = '2026-09-23T09:00:00.000Z'

const ACTIVE: ModelProviderView = {
  id: 'deepseek',
  kind: 'deepseek',
  label: '我的 DeepSeek',
  base_url: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  region: 'cn',
  has_key: true,
  active: true,
}

const DEFAULTS: ModelDefaultsView = {
  default: 'deepseek/deepseek-chat',
  by_purpose: {},
  data_residency: 'cn',
  budget: {},
  choices: [{ id: 'deepseek/deepseek-chat', label: '我的 DeepSeek（deepseek-chat）' }],
}

const IMAGE_NONE: ModelImageView = {
  configured: false,
  official: false,
  credits_per_image: 0.5,
  choices: [
    { provider_id: 'agentsws', label: 'agentsws 云', official: true, default_model: 'gpt-image-1' },
  ],
  unavailable_reason: '生图还没配：去设置 → 模型 →「生图」那一块选一个。',
}

const state = {
  providers: [ACTIVE] as ModelProviderView[],
  test: { ok: true, reason: 'ok', checked_at: T0 } as ModelTestResult,
  image: IMAGE_NONE as ModelImageView,
}
const imageSaves: { provider_id: string; model?: string }[] = []

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    listModelProviders: async () => ({ providers: state.providers, templates: [] }),
    testModelProvider: async () => state.test,
    getModelDefaults: async () => DEFAULTS,
    setModelDefaults: async () => DEFAULTS,
    getModelUsage: async () => ({
      since: T0,
      rows: [],
      total: undefined,
      budget: { used_base: 0, cap_base: 0, frozen: false },
    }),
    getModelPricing: async () => ({ vendors: [] }),
    getModelImage: async () => state.image,
    setModelImage: async (input: { provider_id: string; model?: string }) => {
      imageSaves.push(input)
      state.image = {
        ...state.image,
        configured: input.provider_id !== '',
        provider_id: input.provider_id,
        model: input.model ?? 'gpt-image-1',
        official: input.provider_id === 'agentsws',
      }
      return state.image
    },
  }
})

const { ModelsPanel } = await import('@/components/models/models-panel')

beforeEach(() => {
  state.providers = [ACTIVE]
  state.test = { ok: true, reason: 'ok', checked_at: T0 }
  state.image = IMAGE_NONE
  imageSaves.length = 0
})

describe('WP127 验证三步：设置页那一行', () => {
  it('看不了图：三步小清单卡在"看得懂图"，原因是人话', async () => {
    state.test = {
      ok: false,
      reason: 'no_vision',
      detail: '这个模型看不了图，Agents 工坊要求模型能看图。',
      checked_at: T0,
      vision: false,
      steps: [
        { step: 'connect', ok: true },
        { step: 'text', ok: true },
        { step: 'vision', ok: false },
      ],
    }
    const user = userEvent.setup()
    renderWithProviders(<ModelsPanel assignment="asg_owner" />)
    await user.click(await screen.findByRole('button', { name: '测试' }))
    const steps = await screen.findByTestId('model-check-steps')
    const items = within(steps).getAllByRole('listitem')
    expect(items.map((li) => [li.dataset.step, li.dataset.ok])).toEqual([
      ['connect', 'true'],
      ['text', 'true'],
      ['vision', 'false'],
    ])
    expect(steps.textContent).toContain('看得懂图')
    expect((await screen.findByTestId('model-test-result')).textContent).toContain('看不了图')
  })
})

describe('WP127 老用户：顶部一条提示（不挡路）', () => {
  it('还没验证过能不能看图：提示去点一次测试', async () => {
    state.providers = [{ ...ACTIVE, vision_status: 'unchecked' }]
    renderWithProviders(<ModelsPanel assignment="asg_owner" />)
    const banner = await screen.findByTestId('models-vision-banner')
    expect(banner.dataset.status).toBe('unchecked')
    expect(banner.textContent).toContain('deepseek-chat')
    expect(banner.textContent).toContain('测试')
  })

  it('验证过、看不了：明说，并列几个常见能看图的型号', async () => {
    state.providers = [{ ...ACTIVE, vision_status: 'no' }]
    renderWithProviders(<ModelsPanel assignment="asg_owner" />)
    const banner = await screen.findByTestId('models-vision-banner')
    expect(banner.textContent).toContain('看不了图')
    expect(banner.textContent).toContain('gpt-4o')
  })

  it('能看图：不打扰', async () => {
    state.providers = [{ ...ACTIVE, vision_status: 'ok' }]
    renderWithProviders(<ModelsPanel assignment="asg_owner" />)
    await screen.findByTestId('models-text-title')
    expect(screen.queryByTestId('models-vision-banner')).toBeNull()
  })
})

describe('WP127 生图单独一档', () => {
  it('分两块：「文字与看图」在上，「生图」在下；单价常显', async () => {
    renderWithProviders(<ModelsPanel assignment="asg_owner" />)
    expect((await screen.findByTestId('models-text-title')).textContent).toContain('文字与看图')
    const block = await screen.findByTestId('models-image')
    expect(block.textContent).toContain('生图')
    expect((await screen.findByTestId('models-image-price')).textContent).toContain('0.5')
    // 没配：说人话
    expect((await screen.findByTestId('models-image-reason')).textContent).toContain('生图还没配')
  })

  it('选官方接口 → 保存：模型名自动填上默认那个，存下来', async () => {
    const user = userEvent.setup()
    renderWithProviders(<ModelsPanel assignment="asg_owner" />)
    await user.selectOptions(await screen.findByTestId('models-image-select'), 'agentsws')
    expect((screen.getByTestId('models-image-model') as HTMLInputElement).value).toBe('gpt-image-1')
    await user.click(screen.getByTestId('models-image-save'))
    await waitFor(() => {
      expect(imageSaves).toEqual([{ provider_id: 'agentsws', model: 'gpt-image-1' }])
    })
  })

  it('一条能出图的都没有：指路，而不是给一个空下拉', async () => {
    state.image = { ...IMAGE_NONE, choices: [] }
    renderWithProviders(<ModelsPanel assignment="asg_owner" />)
    expect((await screen.findByTestId('models-image-empty')).textContent).toContain(
      'Agents 工坊官方接口',
    )
  })
})
