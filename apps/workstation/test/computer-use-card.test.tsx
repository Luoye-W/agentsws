/**
 * WP144（docs/80）：设置 → 电脑操控，与第三栏那一行。
 *
 * 四组断言：
 * 1. 默认关；打开前就把风险用白话说清（能看屏幕、点、输入；密码支付验证码会停下；截图不发给模型）；
 * 2. 打开后才出：分钟数、勾职责（默认一条都不勾）、三步向导；
 * 3. 三步各自按下去会发生什么：一键下载、打开系统设置那一页（macOS）、自检结果原样列出 + 怎么修；
 * 4. 非本机档：总开关是灰的，写清楚为什么；正在操作时出「停止」，第三栏那一行也在。
 */
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ComputerUseStrip } from '@/components/rail/computer-use-strip'
import { ComputerUseCard } from '@/components/settings/computer-use-card'
import type { ComputerUseSelfCheck, ComputerUseSettingsView } from '@/lib/api'
import { renderWithProviders } from './helpers'

const LOCAL: ComputerUseSettingsView = {
  enabled: false,
  roles: [],
  minutes: 10,
  allowed: true,
  platform: 'darwin',
  driver: { installed: false, pinned_version: '0.28.0', platform_key: 'darwin-arm64' },
}

const CHECK: ComputerUseSelfCheck = {
  ran: true,
  ok: false,
  checks: [
    { name: 'accessibility', ok: true, detail: '✅ Accessibility: granted.' },
    {
      name: 'screen_recording',
      ok: false,
      detail: '❌ Screen Recording: NOT granted.',
      fix: '打开「系统设置 → 隐私与安全性 → 录屏与系统录音」，把「Agents 工坊」打开',
    },
  ],
  raw: '✅ Accessibility: granted.\n❌ Screen Recording: NOT granted.',
  detail: '还有权限没给',
}

const state = {
  view: LOCAL as ComputerUseSettingsView,
  saved: [] as unknown[],
  installs: 0,
  opened: [] as string[],
  stops: 0,
}

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getComputerUseSettings: async () => state.view,
    setComputerUseSettings: async (input: Partial<ComputerUseSettingsView>) => {
      state.saved.push(input)
      state.view = { ...state.view, ...input }
      return state.view
    },
    listRoleDefinitions: async () => [
      { id: 'site.builder', name: '建站' },
      { id: 'support.refund', name: '退款' },
    ],
    installComputerUseDriver: async () => {
      state.installs += 1
      state.view = { ...state.view, driver: { ...state.view.driver, installed: true } }
      return state.view
    },
    openComputerUseSystemSettings: async (pane: string) => {
      state.opened.push(pane)
      return { opened: true, url: pane }
    },
    checkComputerUse: async () => CHECK,
    stopComputerUse: async () => {
      state.stops += 1
      state.view = { ...state.view, active: undefined } as ComputerUseSettingsView
      return { stopped: 1 }
    },
    getPositions: async () => ({
      positions: [{ position_id: 'asg_owner', role_id: 'common.owner' }],
    }),
    getComputerUseActive: async () =>
      state.view.active === undefined ? {} : { active: state.view.active },
  }
})

beforeEach(() => {
  state.view = LOCAL
  state.saved = []
  state.installs = 0
  state.opened = []
  state.stops = 0
})

describe('设置页电脑操控', () => {
  it('默认关；打开前就把风险说清；关着时不出向导', async () => {
    renderWithProviders(<ComputerUseCard assignment="asg_1" />)
    const card = await screen.findByTestId('settings-computer-use')
    expect(card.getAttribute('data-enabled')).toBe('off')
    expect(card.textContent).toContain('看你的屏幕、点、输入')
    expect(card.textContent).toContain('密码')
    expect(card.textContent).toContain('截图不会发给模型')
    expect(screen.queryByTestId('computer-use-wizard')).toBeNull()
  })

  it('打开 → 勾职责（默认一条都不勾）→ 一键下载 → 打开系统设置 → 自检原样列出 + 怎么修', async () => {
    renderWithProviders(<ComputerUseCard assignment="asg_1" />)
    await screen.findByTestId('settings-computer-use')
    await userEvent.click(screen.getByTestId('computer-use-enable'))
    expect(state.saved).toEqual([{ enabled: true }])
    await screen.findByTestId('computer-use-wizard')

    const role = (await screen.findByTestId('computer-use-role-site.builder')) as HTMLInputElement
    expect(role.checked).toBe(false)
    await userEvent.click(role)
    expect(state.saved.at(-1)).toEqual({ roles: ['site.builder'] })

    await userEvent.click(screen.getByTestId('computer-use-install'))
    expect(state.installs).toBe(1)
    expect((await screen.findByTestId('computer-use-driver')).textContent).toContain('0.28.0')

    await userEvent.click(screen.getByTestId('computer-use-open-ax'))
    await userEvent.click(screen.getByTestId('computer-use-open-sr'))
    expect(state.opened).toEqual(['accessibility', 'screen_recording'])

    await userEvent.click(screen.getByTestId('computer-use-check'))
    const checks = await screen.findByTestId('computer-use-checks')
    expect(checks.textContent).toContain('Screen Recording: NOT granted')
    expect(checks.textContent).toContain('录屏与系统录音')
  })

  it('非本机档：总开关是灰的，写清楚为什么', async () => {
    state.view = { ...LOCAL, allowed: false, blocked_reason: '这台服务不在你自己的电脑上。' }
    renderWithProviders(<ComputerUseCard assignment="asg_1" />)
    const box = (await screen.findByTestId('computer-use-enable')) as HTMLInputElement
    expect(box.disabled).toBe(true)
    expect(screen.getByTestId('settings-computer-use').textContent).toContain(
      '这台服务不在你自己的电脑上',
    )
  })

  it('正在操作：设置页与第三栏都有「停止」，按下去就停', async () => {
    const until = new Date(2026, 8, 24, 10, 30).toISOString()
    state.view = {
      ...LOCAL,
      enabled: true,
      active: { run_id: 'run_1', role_id: 'site.builder', until },
    }
    renderWithProviders(
      <>
        <ComputerUseCard assignment="asg_1" />
        <ComputerUseStrip />
      </>,
    )
    expect((await screen.findByTestId('computer-use-active')).textContent).toContain('10:30')
    const strip = await screen.findByTestId('computer-use-strip')
    expect(strip.textContent).toContain('AI 正在操作电脑（到 10:30）')
    await userEvent.click(screen.getByTestId('computer-use-strip-stop'))
    expect(state.stops).toBe(1)
  })
})
