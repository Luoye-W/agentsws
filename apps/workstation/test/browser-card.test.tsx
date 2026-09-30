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
import type { BrowserSettings, BrowserSettingsView, BrowserSkillStatus } from '@/lib/api'
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
  }
})

beforeEach(() => {
  state.view = LOCAL
  state.saved = []
  state.installs = 0
  state.checks = 0
  state.status = NOT_INSTALLED
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
