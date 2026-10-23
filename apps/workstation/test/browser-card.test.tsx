/**
 * 设置 → 浏览器：两种方式并列（WP82 的「Chrome」两项 + WP92 的「我正在用的浏览器」）。
 *
 * 四组断言：
 * 1. 两种方式都摆在那儿，而且**白话说清了区别**（不是两个术语并排）；
 * 2. 选了第三种才出那三步向导（装扩展 → 装 bsk → 检查）；
 * 3. 三步各自按下去会发生什么：商店链接是官方的、装 bsk 走一键、检查把
 *    `bsk doctor` 那几条**原样**列出来（含"怎么修"）；
 * 4. 非个人档：这一项是灰的，而且下面写清楚为什么。
 */
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserCard } from '@/components/settings/browser-card'
import type {
  BrowserSettings,
  BrowserSettingsView,
  BrowserSkillStatus,
  EgoBrowserStatus,
} from '@/lib/api'
import { renderWithProviders } from './helpers'

const LOCAL: BrowserSettingsView = {
  mode: 'off',
  attach_allowed: true,
  browserskill_allowed: true,
}

const DOCKER: BrowserSettingsView = {
  mode: 'off',
  attach_allowed: false,
  attach_blocked_reason: '这台服务不在你自己的电脑上（Docker / 托管档）。',
  browserskill_allowed: false,
  browserskill_blocked_reason: '这台服务不在你自己的电脑上（Docker / 托管档）：bsk 连不过来。',
}

const NOT_INSTALLED: BrowserSkillStatus = {
  installed: false,
  checks: [],
  ok: false,
  detail: '还没装 bsk（设置页第 ② 步）',
}

const INSTALLED: BrowserSkillStatus = {
  installed: true,
  bsk_path: '/data/bin/bsk',
  version: '0.3.0',
  pinned_version: '0.3.0',
  checks: [],
  ok: false,
  detail: '还有检查没通过',
}

const CHECKED_BAD: BrowserSkillStatus = {
  ...INSTALLED,
  checks: [
    { name: 'daemon running', ok: true, status: 'ok', detail: 'pid 1234' },
    {
      name: 'browser extension connected',
      ok: false,
      status: 'fail',
      detail: '没有扩展连上来',
      hint: '在 Chrome 里装扩展，然后打开一个标签',
    },
  ],
  ok: false,
  detail: '没有扩展连上来',
}

const state = {
  view: LOCAL as BrowserSettingsView,
  saved: [] as BrowserSettings[],
  installs: 0,
  checks: 0,
  status: NOT_INSTALLED as BrowserSkillStatus,
  /** WP463：组织现在是哪种用法（`useMode()` 读 `listOrganizations`）。 */
  orgMode: 'solo' as 'solo' | 'peers' | 'company',
  ego: { allowed: true, installed: false, detail: '没找到' } as EgoBrowserStatus,
  egoChecks: 0,
  probe: { ok: false, endpoint: '', detail: '连不上' } as {
    ok: boolean
    endpoint: string
    browser?: string
    detail?: string
  },
}

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getBrowserSettings: async () => state.view,
    setBrowserSettings: async (input: BrowserSettings) => {
      state.saved.push(input)
      state.view = { ...state.view, ...input }
      return state.view
    },
    probeBrowser: async () => state.probe,
    installBrowserSkill: async () => {
      state.installs += 1
      state.status = INSTALLED
      return state.status
    },
    getBrowserSkillStatus: async () => {
      state.checks += 1
      return state.status
    },
    getEgoBrowserStatus: async () => {
      state.egoChecks += 1
      return state.ego
    },
    listOrganizations: async () => [
      { id: 'org_1', name: '测试', solo: state.orgMode === 'solo', mode: state.orgMode },
    ],
  }
})

beforeEach(() => {
  state.view = LOCAL
  state.saved = []
  state.installs = 0
  state.checks = 0
  state.status = NOT_INSTALLED
  state.orgMode = 'solo'
  state.ego = { allowed: true, installed: false, detail: '没找到' }
  state.egoChecks = 0
  state.probe = { ok: false, endpoint: '', detail: '连不上' }
})

describe('设置页浏览器：两种方式并列', () => {
  it('两种方式都在，而且用白话说了区别', async () => {
    renderWithProviders(<BrowserCard assignment="asg_1" />)
    await screen.findByTestId('settings-browser')
    expect(screen.getByTestId('browser-mode-attach')).toBeTruthy()
    expect(screen.getByTestId('browser-mode-launch')).toBeTruthy()
    const bsk = screen.getByTestId('browser-mode-browserskill')
    expect(bsk.textContent).toContain('我正在用的浏览器')
    // 选中之前不出向导
    expect(screen.queryByTestId('browserskill-wizard')).toBeNull()

    // WP156：白话那一句进了这一项旁边的问号；「两种的区别」整段在教程「让 AI 用浏览器」里
    expect(bsk.querySelector('[data-slot="hint"]')?.getAttribute('data-hint')).toContain(
      '要用你已经开着的标签会先问你',
    )
    expect(screen.getByTestId('tutorial-link').getAttribute('data-slug')).toBe('browser')
    await userEvent.click(bsk.querySelector('input') as HTMLInputElement)
    expect(await screen.findByTestId('browserskill-wizard')).toBeTruthy()
  })

  it('三步向导：官方商店链接 → 一键装 bsk → 检查把 doctor 那几条原样列出来', async () => {
    renderWithProviders(<BrowserCard assignment="asg_1" />)
    await screen.findByTestId('settings-browser')
    await userEvent.click(
      screen.getByTestId('browser-mode-browserskill').querySelector('input') as HTMLInputElement,
    )
    await screen.findByTestId('browserskill-wizard')

    // ① 扩展只能用户自己装：给的是两个官方商店
    expect(screen.getByTestId('browserskill-store-chrome').getAttribute('href')).toContain(
      'chromewebstore.google.com',
    )
    expect(screen.getByTestId('browserskill-store-edge').getAttribute('href')).toContain(
      'microsoftedge.microsoft.com',
    )

    // ② 一键装
    await userEvent.click(screen.getByTestId('browserskill-install'))
    expect(state.installs).toBe(1)
    expect((await screen.findByTestId('browserskill-installed')).textContent).toContain('0.3.0')

    // ③ 检查：失败的那条要看得见，"怎么修"也要
    state.status = CHECKED_BAD
    await userEvent.click(screen.getByTestId('browserskill-check'))
    const result = await screen.findByTestId('browserskill-result')
    expect(result.getAttribute('data-ok')).toBe('false')
    expect(result.textContent).toContain('没有扩展连上来')
    const checks = screen.getByTestId('browserskill-checks')
    expect(checks.textContent).toContain('browser extension connected')
    expect(checks.textContent).toContain('在 Chrome 里装扩展')

    // 保存写回去的是这一种方式
    await userEvent.click(screen.getByTestId('browser-save'))
    expect(state.saved.at(-1)).toEqual({ mode: 'browserskill' })
  })

  it('WP214：找到浏览器之后只说连上了哪个，地址（已经在输入框里）进 tooltip', async () => {
    state.probe = { ok: true, endpoint: 'http://127.0.0.1:9222', browser: 'Chrome 140' }
    renderWithProviders(<BrowserCard assignment="asg_1" />)
    const attach = await screen.findByTestId('browser-mode-attach')
    await userEvent.click(attach.querySelector('input') as HTMLInputElement)
    await userEvent.click(await screen.findByTestId('browser-find'))
    const result = await screen.findByTestId('browser-probe-result')
    expect(result.textContent).toContain('连上了：Chrome 140')
    expect(screen.getByTestId('browser-probe-endpoint').getAttribute('data-hint')).toBe(
      'http://127.0.0.1:9222',
    )
    // 卡面上人要读的字里没有地址（读屏专用那份不算）
    const clone = result.cloneNode(true) as Element
    for (const el of [...clone.querySelectorAll('.sr-only')]) el.remove()
    expect(clone.textContent).not.toContain('9222')
  })

  it('打开设置页不会自己去戳一下用户的浏览器（按了才查）', async () => {
    renderWithProviders(<BrowserCard assignment="asg_1" />)
    await screen.findByTestId('settings-browser')
    await userEvent.click(
      screen.getByTestId('browser-mode-browserskill').querySelector('input') as HTMLInputElement,
    )
    await screen.findByTestId('browserskill-wizard')
    expect(state.checks).toBe(0)
  })

  it('非个人档：这一项是灰的，而且写清楚了为什么', async () => {
    state.view = DOCKER
    renderWithProviders(<BrowserCard assignment="asg_1" />)
    await screen.findByTestId('settings-browser')
    const bsk = screen.getByTestId('browser-mode-browserskill')
    expect((bsk.querySelector('input') as HTMLInputElement).disabled).toBe(true)
    expect(bsk.textContent).toContain('bsk 连不过来')
  })
})

describe('WP463：ego 那一项', () => {
  const EGO_LOCAL: BrowserSettingsView = { ...LOCAL, ego_allowed: true }

  it('个人用法、探到了：显示版本号，选了保存的是 ego', async () => {
    state.view = EGO_LOCAL
    state.ego = { allowed: true, installed: true, version: '2.1.0', ego_path: '/x/ego-browser' }
    renderWithProviders(<BrowserCard assignment="asg_1" />)
    const row = await screen.findByTestId('browser-mode-ego')
    expect((await screen.findByTestId('browser-ego-status')).textContent).toContain('2.1.0')
    // 悬停那一句（界面少字：不写步骤清单）
    expect(row.querySelector('[data-slot="hint"]')?.getAttribute('data-hint')).toContain(
      '不动你开着的标签',
    )
    await userEvent.click(row.querySelector('input') as HTMLInputElement)
    await userEvent.click(screen.getByTestId('browser-save'))
    expect(state.saved.at(-1)).toEqual({ mode: 'ego' })
  })

  it('没探到：显示「没装」+ 官网链接（不给安装包直链），这一项选不了', async () => {
    state.view = EGO_LOCAL
    renderWithProviders(<BrowserCard assignment="asg_1" />)
    const row = await screen.findByTestId('browser-mode-ego')
    expect((await screen.findByTestId('browser-ego-status')).textContent).toContain('没装')
    // WP483：官网下载页（自己认 Mac / Windows），仍不给安装包直链
    expect(screen.getByTestId('browser-ego-site').getAttribute('href')).toBe(
      'https://lite.ego.app/download',
    )
    expect((row.querySelector('input') as HTMLInputElement).disabled).toBe(true)
    // WP483（决策 1658）：「推荐装 ego」卡：去下载 + 装好了再看一次
    expect(screen.getByTestId('ego-recommend')).toBeTruthy()
    expect(screen.getByTestId('ego-download').getAttribute('href')).toBe(
      'https://lite.ego.app/download',
    )
    expect(screen.getByTestId('ego-recheck')).toBeTruthy()
    expect(screen.getByTestId('browser-mode-ego-recommended').textContent).toBe('推荐')
  })

  it('WP483（决策 1659 改 1477）：同事互联、公司集体也出现、也推荐（服务在你电脑上就行）', async () => {
    for (const mode of ['peers', 'company'] as const) {
      state.view = EGO_LOCAL
      state.orgMode = mode
      state.egoChecks = 0
      const { unmount } = renderWithProviders(<BrowserCard assignment="asg_1" />)
      await screen.findByTestId('browser-mode-ego')
      expect(await screen.findByTestId('ego-recommend'), mode).toBeTruthy()
      expect(state.egoChecks, mode).toBeGreaterThan(0)
      unmount()
    }
  })

  it('WP483：装了但连不上（工坊以管理员身份运行）——说下一步、给「再看一次」；就绪时一行', async () => {
    state.view = EGO_LOCAL
    state.ego = {
      allowed: true,
      installed: true,
      version: '2.1.0',
      ego_path: '/x/ego-browser',
      connected: false,
      admin: true,
      connect_detail: '工坊现在是「以管理员身份运行」的',
    } as never
    const a = renderWithProviders(<BrowserCard assignment="asg_1" />)
    expect((await screen.findByTestId('ego-connect-detail')).textContent).toContain('管理员')
    a.unmount()
    state.ego = {
      allowed: true,
      installed: true,
      version: '2.1.0',
      ego_path: '/x/ego-browser',
      connected: true,
    } as never
    renderWithProviders(<BrowserCard assignment="asg_1" />)
    expect((await screen.findByTestId('ego-ready')).textContent).toContain('2.1.0')
  })

  it('WP468：选 ego 时顶上那句换成「ego 不按网站名单拦，只留记录」；已存成 ego 的打开就是这一句', async () => {
    state.view = EGO_LOCAL
    state.ego = { allowed: true, installed: true, version: '2.1.0', ego_path: '/x/ego-browser' }
    const { unmount } = renderWithProviders(<BrowserCard assignment="asg_1" />)
    const summary = await screen.findByTestId('settings-browser-summary')
    expect(summary.textContent).toContain('只能打开它职责里写的那几个网站')
    const row = await screen.findByTestId('browser-mode-ego')
    await screen.findByTestId('browser-ego-status')
    await userEvent.click(row.querySelector('input') as HTMLInputElement)
    expect(screen.getByTestId('settings-browser-summary').textContent).toContain(
      'ego 不按网站名单拦，只留记录',
    )
    expect(screen.getByTestId('settings-browser-scope').getAttribute('data-hint') ?? '').toContain(
      '运行记录',
    )
    // 换回别的方式，那句也换回来
    await userEvent.click(
      screen.getByTestId('browser-mode-off').querySelector('input') as HTMLInputElement,
    )
    expect(screen.getByTestId('settings-browser-summary').textContent).toContain(
      '只能打开它职责里写的那几个网站',
    )
    unmount()
    state.view = { ...EGO_LOCAL, mode: 'ego' }
    renderWithProviders(<BrowserCard assignment="asg_1" />)
    expect((await screen.findByTestId('settings-browser-summary')).textContent).toContain(
      'ego 不按网站名单拦',
    )
  })

  it('老服务进程（没有 ego_allowed 这一格）：不出现', async () => {
    renderWithProviders(<BrowserCard assignment="asg_1" />)
    await screen.findByTestId('browser-mode-browserskill')
    expect(screen.queryByTestId('browser-mode-ego')).toBeNull()
  })
})
