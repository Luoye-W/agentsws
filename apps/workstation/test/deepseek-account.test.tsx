/**
 * WP134：第三种模型来源「用我的 DeepSeek 账号登录」的界面。
 *
 * 四组：
 * 1. **那一个件**（向导与设置页共用）：点登录 → 授权页交给系统浏览器（复用 `openExternal`）→
 *    等浏览器 → 登上后显示账号与余额 → 自动存这一条并跑三步验证 → 过了才算接上；
 * 2. **说人话**：余额查不到不显示成 0；登录失败 / 取消 / 本机档之外各一句话；验证没过按档说
 *    （登录失效、余额不足、看不了图）；
 * 3. **向导第 ① 步的第三张大卡**：点开才展开；三步都过才亮「下一步」；
 * 4. **设置页**：这一张不混进"加一个"那一排（那一排是填 key 的）。
 *
 * 全是替身，令牌这个概念在界面里根本不存在——测试也就不需要为它设任何值。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  accountTestKey,
  DeepSeekAccountLogin,
  formatWallet,
} from '@/components/models/deepseek-account-login'
import { NoModelBanner } from '@/components/models/no-model-banner'
import { AiStep } from '@/components/onboarding/ai-step'
import type {
  DeepSeekAccountData,
  ModelProviderTemplate,
  ModelProviderView,
  ModelTestResult,
} from '@/lib/api'
import { AppProvider } from '@/lib/app-context'
import { keysFor } from '@/lib/realtime'
import { renderWithProviders } from './helpers'

const T0 = '2026-09-24T09:00:00.000Z'
const AUTHORIZE = 'https://platform.deepseek.com/dsh/authorize?authorize_id=az_1'

const SIGNED_OUT: DeepSeekAccountData = {
  available: true,
  enabled: false,
  signed_in: false,
  default_model: 'deepseek-flash',
  region: 'cn',
}

const WAITING: DeepSeekAccountData = {
  ...SIGNED_OUT,
  enabled: true,
  attempt: { id: 'att_1', phase: 'waiting-browser', authorize_url: AUTHORIZE },
}

const SIGNED_IN: DeepSeekAccountData = {
  ...SIGNED_OUT,
  enabled: true,
  signed_in: true,
  attempt: { id: 'att_1', phase: 'succeeded' },
  account: '替身账号',
  balance: {
    status: 'ready',
    wallets: [{ currency: 'CNY', balance: '42.50' }],
    bonus: [{ currency: 'CNY', balance: '10.00' }],
  },
  top_up_url: 'https://platform.deepseek.com/top_up',
}

const OK_TEST: ModelTestResult = {
  ok: true,
  reason: 'ok',
  checked_at: T0,
  steps: [
    { step: 'connect', ok: true },
    { step: 'text', ok: true },
    { step: 'vision', ok: true },
  ],
}

const ACCOUNT_TEMPLATE = {
  kind: 'deepseek_account',
  label: '用我的 DeepSeek 账号登录',
  summary: '不用建 key。',
  auth: 'account',
  default_base_url: 'https://api.deepseek.com/anthropic',
  default_model: 'deepseek-flash',
  region: 'cn',
  steps: ['点登录'],
  links: [{ label: 'DeepSeek 开放平台', url: 'https://platform.deepseek.com' }],
} as unknown as ModelProviderTemplate

const DEEPSEEK_TEMPLATE: ModelProviderTemplate = {
  kind: 'deepseek',
  label: 'DeepSeek 官方',
  summary: '国内直连。',
  vendor: 'deepseek',
  default_base_url: 'https://api.deepseek.com',
  default_model: 'deepseek-flash',
  region: 'cn',
  steps: ['创建 API key'],
  links: [{ label: 'DeepSeek 开放平台', url: 'https://platform.deepseek.com/api_keys' }],
}

const ACCOUNT_ROW = {
  id: 'deepseek-account',
  kind: 'deepseek_account',
  label: '用我的 DeepSeek 账号登录',
  base_url: 'https://api.deepseek.com/anthropic',
  model: 'deepseek-flash',
  region: 'cn',
  has_key: true,
  active: true,
} as unknown as ModelProviderView

const state = {
  view: SIGNED_OUT as DeepSeekAccountData,
  /** 起登录之后回什么。 */
  afterLogin: WAITING as DeepSeekAccountData,
  providers: [] as ModelProviderView[],
  test: OK_TEST as ModelTestResult,
  logins: 0,
  cancels: [] as string[],
  saves: [] as string[],
  tests: 0,
  signOuts: 0,
}
const opened: string[] = []

vi.mock('@/components/connections/bridge', () => ({
  openExternal: (url: string) => {
    opened.push(url)
  },
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getDeepSeekAccount: async () => state.view,
    startDeepSeekAccountLogin: async () => {
      state.logins += 1
      state.view = state.afterLogin
      return state.view
    },
    cancelDeepSeekAccountLogin: async (id: string) => {
      state.cancels.push(id)
      state.view = { ...SIGNED_OUT, enabled: true, attempt: { id, phase: 'cancelled' } }
      return state.view
    },
    saveDeepSeekAccountProvider: async (model: string) => {
      state.saves.push(model)
      state.providers = [ACCOUNT_ROW]
      return ACCOUNT_ROW
    },
    testModelProvider: async () => {
      state.tests += 1
      state.providers = [{ ...ACCOUNT_ROW, last_test: state.test }]
      return state.test
    },
    signOutDeepSeekAccount: async () => {
      state.signOuts += 1
      state.view = SIGNED_OUT
      state.providers = []
      return { signed_out: true as const }
    },
    listModelProviders: async () => ({
      providers: state.providers,
      templates: [DEEPSEEK_TEMPLATE, ACCOUNT_TEMPLATE],
    }),
    // 设置页那块面板要的其余几条
    getModelDefaults: async () => ({
      default: '',
      by_purpose: {},
      data_residency: 'cn',
      budget: {},
      choices: [],
    }),
    getModelUsage: async () => ({
      since: T0,
      rows: [],
      total: undefined,
      budget: { used_base: 0, cap_base: 0, frozen: false },
    }),
    getModelPricing: async () => ({ vendors: [] }),
    getModelImage: async () => ({ configured: false, official: false, choices: [] }),
    // 向导那两张大卡要的
    getCloudAccount: async () => ({ linked: false, cloud_base_url: 'https://cloud.agentsws.dev' }),
    getCloudCredits: async () => ({ linked: false }),
    // WP150：顶栏"还没接模型"那个胶囊要知道谁是所有者
    getPositions: async () => ({
      positions: [{ position_id: 'pos_owner', role_id: 'common.owner' }],
      tile_library: [],
      max_tiles: 6,
    }),
  }
})

beforeEach(() => {
  state.view = SIGNED_OUT
  state.afterLogin = WAITING
  state.providers = []
  state.test = OK_TEST
  state.logins = 0
  state.cancels = []
  state.saves = []
  state.tests = 0
  state.signOuts = 0
  opened.length = 0
  vi.spyOn(globalThis, 'confirm').mockReturnValue(true)
})

describe('WP134 那一个件：登录 → 浏览器 → 账号与余额 → 三步验证', () => {
  it('点登录：授权页交给系统浏览器（只开一次），界面说"在浏览器里登录并点同意"', async () => {
    const user = userEvent.setup()
    renderWithProviders(<DeepSeekAccountLogin framed />)
    const card = await screen.findByTestId('model-deepseek-account-card')
    expect(within(card).getByText('数据在境内')).toBeTruthy()
    await user.click(screen.getByTestId('dsa-login'))
    expect(await screen.findByTestId('dsa-waiting')).toBeTruthy()
    expect(opened).toEqual([AUTHORIZE])
    expect(screen.getByTestId('dsa-waiting').textContent).toContain('这一页会自己接上')
    // 用户手动再开一次
    await user.click(screen.getByTestId('dsa-open-again'))
    expect(opened).toEqual([AUTHORIZE, AUTHORIZE])
  })

  it('取消：只取消这一次，说"已取消"，登录按钮回来', async () => {
    const user = userEvent.setup()
    state.view = WAITING
    renderWithProviders(<DeepSeekAccountLogin />)
    await user.click(await screen.findByTestId('dsa-cancel'))
    expect(state.cancels).toEqual(['att_1'])
    expect(await screen.findByTestId('dsa-cancelled')).toBeTruthy()
    expect(screen.getByTestId('dsa-login')).toBeTruthy()
  })

  it('登上了：账号名与余额（赠送另列），自动存这一条并跑三步，过了才算接上', async () => {
    state.view = SIGNED_IN
    const connected = vi.fn()
    renderWithProviders(<DeepSeekAccountLogin onConnected={connected} />)
    expect((await screen.findByTestId('dsa-signed-in')).textContent).toContain('替身账号')
    expect(screen.getByTestId('dsa-balance').textContent).toContain('¥42.50')
    expect(screen.getByTestId('dsa-balance').textContent).toContain('另有赠送 ¥10.00')
    await screen.findByTestId('dsa-ok')
    expect(state.saves).toEqual(['deepseek-flash'])
    expect(state.tests).toBe(1)
    expect(screen.getByTestId('model-check-steps')).toBeTruthy()
    expect(connected).toHaveBeenCalledTimes(1)
  })

  it('余额查不到：说人话，不显示成 0；不影响接上', async () => {
    state.view = {
      ...SIGNED_IN,
      balance: { status: 'failed', message: '余额暂时查不到——DeepSeek 那边这会儿没回话。' },
    }
    renderWithProviders(<DeepSeekAccountLogin />)
    expect((await screen.findByTestId('dsa-balance-failed')).textContent).toContain(
      '余额暂时查不到',
    )
    expect(screen.queryByTestId('dsa-balance')).toBeNull()
    expect(screen.queryByText(/¥0/)).toBeNull()
    await screen.findByTestId('dsa-ok')
  })

  it('验证没过（看不了图）：不算接上，说人话，给"再测一次"', async () => {
    state.view = SIGNED_IN
    state.test = {
      ok: false,
      reason: 'no_vision',
      checked_at: T0,
      steps: [
        { step: 'connect', ok: true },
        { step: 'text', ok: true },
        { step: 'vision', ok: false },
      ],
    }
    const connected = vi.fn()
    renderWithProviders(<DeepSeekAccountLogin onConnected={connected} />)
    const failed = await screen.findByTestId('dsa-test-failed')
    expect(failed.getAttribute('data-kind')).toBe('vision')
    expect(connected).not.toHaveBeenCalled()
    expect(screen.getByTestId('dsa-retest')).toBeTruthy()
  })

  it('登录失败：服务端那句人话原样显示，可以再点一次', async () => {
    state.view = {
      ...SIGNED_OUT,
      enabled: true,
      attempt: {
        id: 'att_2',
        phase: 'expired',
        error_code: 'expired',
        error: '浏览器里一直没点完，这次登录过期了。再点一次登录。',
      },
    }
    renderWithProviders(<DeepSeekAccountLogin />)
    expect((await screen.findByTestId('dsa-error')).textContent).toContain('过期了')
    expect(screen.getByTestId('dsa-login')).toBeTruthy()
  })

  it('本机档之外：只有一句为什么不能用，没有登录按钮', async () => {
    state.view = { ...SIGNED_OUT, available: false, unavailable_reason: '这台机器不是本机档。' }
    renderWithProviders(<DeepSeekAccountLogin />)
    expect((await screen.findByTestId('dsa-unavailable')).textContent).toContain('不是本机档')
    expect(screen.queryByTestId('dsa-login')).toBeNull()
  })

  it('登出：先确认，再调登出；卡片回到"没登录"', async () => {
    const user = userEvent.setup()
    state.view = SIGNED_IN
    state.providers = [{ ...ACCOUNT_ROW, last_test: OK_TEST }]
    renderWithProviders(<DeepSeekAccountLogin />)
    await user.click(await screen.findByTestId('dsa-sign-out'))
    await waitFor(() => {
      expect(state.signOuts).toBe(1)
    })
    expect(await screen.findByTestId('dsa-login')).toBeTruthy()
    // 已经验证过的那一条不会被重复存 / 重复测
    expect(state.saves).toEqual([])
  })

  it('验证没过的那几档：登录失效 / 余额不足 说的是 DeepSeek 账号，别的沿用向导那几句', () => {
    const base = { ok: false, checked_at: T0 }
    expect(accountTestKey({ ...base, reason: 'provider_error', detail: 'HTTP 401' })).toBe(
      'dsa.err.key',
    )
    expect(accountTestKey({ ...base, reason: 'provider_error', detail: 'HTTP 402' })).toBe(
      'dsa.err.balance',
    )
    expect(accountTestKey({ ...base, reason: 'no_vision' })).toBe('onboarding.ai.own.err.vision')
    expect(formatWallet({ currency: 'USD', balance: '1.20' })).toBe('$1.20')
  })
})

describe('WP134 向导第 ① 步：第三张大卡', () => {
  it('三张大卡摆着；点开"用我的 DeepSeek 账号登录"才展开；三步过了才算接上', async () => {
    const user = userEvent.setup()
    state.afterLogin = SIGNED_IN
    const connected = vi.fn()
    renderWithProviders(<AiStep onConnected={connected} onDemo={() => undefined} />)
    expect(await screen.findByTestId('ai-card-official')).toBeTruthy()
    expect(screen.getByTestId('ai-card-own')).toBeTruthy()
    const card = screen.getByTestId('ai-card-account')
    expect(within(card).queryByTestId('dsa')).toBeNull()
    await user.click(screen.getByTestId('ai-pick-account'))
    await user.click(await screen.findByTestId('dsa-login'))
    await waitFor(() => {
      expect(connected).toHaveBeenCalledWith('account')
    })
  })

  // WP152：「自己的接口」里不再出现 DeepSeek、设置页「加一个」合成一张「DeepSeek 官方」卡——
  // 这两条原来的断言（账号登录单独一张卡、不进那一排）改到 `deepseek-one-card.test.tsx`。
})

// ── WP150 ─────────────────────────────────────────────────────────────

const EXPIRED: DeepSeekAccountData = {
  ...SIGNED_OUT,
  enabled: true,
  session_expired: {
    at: T0,
    message: 'DeepSeek 账号的登录过期了（DeepSeek 那边不认这次的登录了），点一下重新登录。',
  },
}

const TASKS = [
  { run_id: 'run_1', matter_id: 'mat_1', title: '回复客户 Anna 的退货' },
  { run_id: 'run_2', matter_id: 'mat_2', title: '给 12 位达人发合作邀约' },
]

/** 自己拿着 QueryClient 渲染（要模拟"服务端推来一条事件 → 这几条查询失效"）。 */
function renderWithClient(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  render(
    <QueryClientProvider client={client}>
      <AppProvider initialTheme="light" initialLang="zh" initialPosition="asg_1">
        <MemoryRouter>{ui}</MemoryRouter>
      </AppProvider>
    </QueryClientProvider>,
  )
  /** 照工作台的实时刷新：推来一条事件 → 它对应的那几条查询失效重取。 */
  const push = async (name: string) => {
    for (const key of keysFor(name)) await client.invalidateQueries({ queryKey: key })
  }
  return { client, push }
}

describe('WP150 登录失效：卡片说人话、按钮变「重新登录」，"还没接模型"与三步验证跟着变', () => {
  it('服务端说是失效登出的：登录按钮上面一句"登录过期了，点一下重新登录"，按钮叫「重新登录」', async () => {
    state.view = EXPIRED
    renderWithProviders(<DeepSeekAccountLogin />)
    const said = await screen.findByTestId('dsa-expired')
    expect(said.textContent).toBe('DeepSeek 账号的登录过期了，点一下重新登录。')
    expect(said.getAttribute('role')).toBe('alert')
    expect(screen.getByTestId('dsa-login').textContent).toContain('重新登录')
    expect(screen.queryByTestId('dsa-signed-in')).toBeNull()
  })

  it('用着用着失效了：推来 model.account_signed_out → 卡片变"过期了"、顶栏出"还没接模型"、三步验证结果不再显示；重新登录后再自动存 + 测一遍', async () => {
    const user = userEvent.setup()
    state.view = SIGNED_IN
    state.providers = [{ ...ACCOUNT_ROW, last_test: OK_TEST }]
    const { push } = renderWithClient(
      <>
        <NoModelBanner variant="chip" />
        <DeepSeekAccountLogin />
      </>,
    )
    await screen.findByTestId('dsa-signed-in')
    expect(screen.getByTestId('model-check-steps')).toBeTruthy()
    expect(screen.queryByTestId('no-model-chip')).toBeNull()
    expect(state.saves).toEqual([]) // 已经验证过的不重复存

    // 服务端：官方说登录失效 → 本机登录清掉、这条来源摘掉 → 推一条事件
    state.view = EXPIRED
    state.providers = []
    await push('model.account_signed_out')
    expect(await screen.findByTestId('dsa-expired')).toBeTruthy()
    expect(await screen.findByTestId('no-model-chip')).toBeTruthy()
    expect(screen.queryByTestId('model-check-steps')).toBeNull()

    // 点「重新登录」→ 登上 → 自己再存一次、再测一次（上一次的"存 + 测"已作废）
    state.afterLogin = SIGNED_IN
    await user.click(screen.getByTestId('dsa-login'))
    await screen.findByTestId('dsa-ok')
    expect(state.saves).toEqual(['deepseek-flash'])
    expect(state.tests).toBe(1)
    await push('model.account_signed_out') // 随便哪次刷新：接上之后胶囊消失
    await waitFor(() => {
      expect(screen.queryByTestId('no-model-chip')).toBeNull()
    })
    expect(screen.queryByTestId('dsa-expired')).toBeNull()
  })

  it('验证时撞上失效（unauthenticated）：说"登录失效了，点一下重新登录"', () => {
    expect(
      accountTestKey({
        ok: false,
        checked_at: T0,
        reason: 'unauthenticated',
        detail: 'DeepSeek 账号的登录过期了',
      }),
    ).toBe('dsa.err.key')
  })
})

describe('WP150 登出前确认并停任务', () => {
  it('有在用这个账号跑的事：卡片里列出来（事项名），不弹原来那个确认框；「先不登出」收起、什么都不停', async () => {
    const user = userEvent.setup()
    state.view = { ...SIGNED_IN, running_tasks: TASKS }
    state.providers = [{ ...ACCOUNT_ROW, last_test: OK_TEST }]
    renderWithProviders(<DeepSeekAccountLogin />)
    await user.click(await screen.findByTestId('dsa-sign-out'))
    const box = await screen.findByTestId('dsa-sign-out-tasks')
    expect(box.getAttribute('role')).toBe('alertdialog')
    expect(box.textContent).toContain('下面这 2 件正在用这个账号跑的事会先停下')
    expect(screen.getAllByTestId('dsa-sign-out-task').map((li) => li.textContent)).toEqual([
      '回复客户 Anna 的退货',
      '给 12 位达人发合作邀约',
    ])
    expect(globalThis.confirm).not.toHaveBeenCalled()
    await user.click(screen.getByTestId('dsa-sign-out-keep'))
    expect(screen.queryByTestId('dsa-sign-out-tasks')).toBeNull()
    expect(state.signOuts).toBe(0)
    expect(screen.getByTestId('dsa-signed-in')).toBeTruthy()
  })

  it('确认「停掉并登出」：调一次登出（服务端先停这些、再登出），卡片回到"没登录"', async () => {
    const user = userEvent.setup()
    state.view = { ...SIGNED_IN, running_tasks: TASKS }
    state.providers = [{ ...ACCOUNT_ROW, last_test: OK_TEST }]
    renderWithProviders(<DeepSeekAccountLogin />)
    await user.click(await screen.findByTestId('dsa-sign-out'))
    await user.click(await screen.findByTestId('dsa-sign-out-stop'))
    await waitFor(() => {
      expect(state.signOuts).toBe(1)
    })
    expect(await screen.findByTestId('dsa-login')).toBeTruthy()
    expect(screen.queryByTestId('dsa-sign-out-tasks')).toBeNull()
    // 手动登出不是失效：没有"登录过期了"
    expect(screen.queryByTestId('dsa-expired')).toBeNull()
  })

  it('点登出那一下现问服务端：刚才还没在跑、现在有了，也照样列出来', async () => {
    const user = userEvent.setup()
    state.view = SIGNED_IN
    state.providers = [{ ...ACCOUNT_ROW, last_test: OK_TEST }]
    renderWithProviders(<DeepSeekAccountLogin />)
    await screen.findByTestId('dsa-signed-in')
    state.view = { ...SIGNED_IN, running_tasks: [TASKS[0] ?? TASKS[1]] } as DeepSeekAccountData
    await user.click(screen.getByTestId('dsa-sign-out'))
    expect((await screen.findAllByTestId('dsa-sign-out-task')).length).toBe(1)
  })

  it('没有在跑的：照原来的确认框', async () => {
    const user = userEvent.setup()
    state.view = SIGNED_IN
    state.providers = [{ ...ACCOUNT_ROW, last_test: OK_TEST }]
    renderWithProviders(<DeepSeekAccountLogin />)
    await user.click(await screen.findByTestId('dsa-sign-out'))
    await waitFor(() => {
      expect(state.signOuts).toBe(1)
    })
    expect(globalThis.confirm).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('dsa-sign-out-tasks')).toBeNull()
  })
})
