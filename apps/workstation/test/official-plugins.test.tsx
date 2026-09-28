/**
 * WP180：设置 →「官方插件」。
 *
 * - 列审过的那几个：名字 + 状态 + 一个按钮；说明 / 许可证 / 工具进问号，"会出网"一眼看得见；
 * - 点装 = 只发一次"出卡"请求（不直接装），行变成"等你批"、按钮没了；
 * - 已装的按钮是"卸载"，同样只出卡；服务端拒了把原话说出来。
 */
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OfficialPluginsPanel } from '@/components/settings/official-plugins'
import type { OfficialPluginsView, OfficialPluginView } from '@/lib/api'
import { renderWithProviders } from './helpers'

const SCHEDULE = '@deepseek-ai/dsh-experimental-schedule-bundle'
const VOICE = '@deepseek-ai/dsh-experimental-voice-input-bundle'

function plugin(over: Partial<OfficialPluginView>): OfficialPluginView {
  return {
    name: SCHEDULE,
    version: '0.2.0-rc.1',
    source: 'shipped',
    license: 'MIT',
    title: '自动化任务',
    summary: '让 AI 能建定时任务和提醒',
    tools: ['schedule_create'],
    network: false,
    rows: ['schedule'],
    state: 'available',
    ...over,
  }
}

const state: { view: OfficialPluginsView; fail?: string | undefined } = { view: { plugins: [] } }
const requests: { action: string; name: string }[] = []

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getOfficialPlugins: async () => state.view,
    requestOfficialPluginChange: async (input: { action: string; name: string }) => {
      requests.push(input)
      if (state.fail !== undefined)
        throw new actual.ApiClientError(403, { code: 'forbidden', message: state.fail } as never)
      state.view = {
        plugins: state.view.plugins.map((p) =>
          p.name === input.name
            ? {
                ...p,
                state: 'pending',
                pending: { action: input.action as 'install', approval_item_id: 'apv_1' },
              }
            : p,
        ),
      }
      return state.view
    },
  }
})

beforeEach(() => {
  requests.length = 0
  state.fail = undefined
  state.view = {
    plugins: [
      plugin({}),
      plugin({
        name: VOICE,
        title: '语音输入',
        tools: [],
        network: true,
        network_note: '第一次准备时下载语音识别模型',
        state: 'installed',
        installed_version: '0.2.0-rc.1',
      }),
    ],
  }
})

describe('WP180 官方插件', () => {
  it('列审过的那几个：状态 + 按钮；说明进问号；会出网的一眼看得见', async () => {
    renderWithProviders(<OfficialPluginsPanel assignment="asg_owner" />)
    const row = await screen.findByTestId(`plugin-${SCHEDULE}`)
    expect(within(row).getByTestId('plugin-state').textContent).toBe('没装')
    expect(within(row).getByTestId('plugin-action').textContent).toBe('装')
    expect(within(row).queryByTestId('plugin-network')).toBeNull()
    const hint = row.querySelector('[data-slot="hint"]')?.getAttribute('data-hint') ?? ''
    expect(hint).toContain('许可证 MIT')
    expect(hint).toContain('schedule_create')
    const voice = screen.getByTestId(`plugin-${VOICE}`)
    expect(within(voice).getByTestId('plugin-network').textContent).toContain('会出网')
    expect(within(voice).getByTestId('plugin-action').textContent).toBe('卸载')
  })

  it('点装只出卡：发一次请求，行变成"等你批"、按钮没了', async () => {
    renderWithProviders(<OfficialPluginsPanel assignment="asg_owner" />)
    const row = await screen.findByTestId(`plugin-${SCHEDULE}`)
    await userEvent.click(within(row).getByTestId('plugin-action'))
    await waitFor(() => expect(requests).toEqual([{ action: 'install', name: SCHEDULE }]))
    await waitFor(() =>
      expect(
        within(screen.getByTestId(`plugin-${SCHEDULE}`)).getByTestId('plugin-state').textContent,
      ).toBe('等你批'),
    )
    expect(
      within(screen.getByTestId(`plugin-${SCHEDULE}`)).queryByTestId('plugin-action'),
    ).toBeNull()
  })

  it('服务端拒了：把原话说出来', async () => {
    state.fail = '不在审过的清单里，不能装'
    renderWithProviders(<OfficialPluginsPanel assignment="asg_owner" />)
    const row = await screen.findByTestId(`plugin-${SCHEDULE}`)
    await userEvent.click(within(row).getByTestId('plugin-action'))
    expect((await screen.findByRole('alert')).textContent).toContain('不在审过的清单里')
  })
})
