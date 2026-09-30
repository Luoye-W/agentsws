/**
 * 消息渠道页上的飞书 / 钉钉两张卡（WP211）。
 *
 * 钉四件事：
 * 1. 图标是各自官网抓回来的 favicon（`<img data-icon="official">`），不是字母占位；
 * 2. 凭据走原生表单：提交的值原样交给 API，提交完输入框清空，Secret 不回显；
 * 3. 配好之后只剩 App ID / Client ID（不是秘密）+ 重填 / 断开；连不上给的是那句人话；
 * 4. 「绑定我的账号」：点一下出绑定码，照着私聊发；绑上了只剩解绑。
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImStatusView } from '@/lib/api'
import { ImChannelsPage } from '@/pages/im-channels'
import { renderWithProviders } from './helpers'

const calls = vi.hoisted(() => ({
  feishu: [] as unknown[],
  dingtalk: [] as unknown[],
  bind: 0,
  unbind: [] as string[],
  status: undefined as unknown,
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getImStatus: async () => calls.status,
    saveFeishuBot: async (v: unknown) => {
      calls.feishu.push(v)
      return { configured: true, app_id: 'cli_x' }
    },
    saveDingtalkBot: async (v: unknown) => {
      calls.dingtalk.push(v)
      return { configured: true, client_id: 'ding_x' }
    },
    issueImBindCode: async () => {
      calls.bind += 1
      return { code: '246810', expires_at: '2026-09-30T10:00:00.000Z' }
    },
    unbindImAccount: async (c: string) => {
      calls.unbind.push(c)
      return { removed: 1 }
    },
  }
})

const base: ImStatusView = {
  wechat: { bound: false, live: false, allowed: true },
  wecom: { configured: false, connected: false },
  feishu: { configured: false, connected: false, state: 'idle', me_bound: false },
  dingtalk: { configured: false, connected: false, state: 'idle', me_bound: false },
  can_manage: true,
}

beforeEach(() => {
  calls.feishu = []
  calls.dingtalk = []
  calls.bind = 0
  calls.unbind = []
  calls.status = base
})

describe('飞书 / 钉钉两张卡', () => {
  it('图标是官网 favicon，不是占位', async () => {
    renderWithProviders(<ImChannelsPage />)
    for (const [id, provider] of [
      ['im-feishu', 'feishu_bot'],
      ['im-dingtalk', 'dingtalk_bot'],
    ] as const) {
      const card = await screen.findByTestId(id)
      const icon = within(card).getByTestId('brand-icon')
      expect(icon.getAttribute('data-provider')).toBe(provider)
      expect(icon.getAttribute('data-icon')).toBe('official')
    }
  })

  it('飞书：原生表单提交，值原样交出去，提交完输入框清空', async () => {
    renderWithProviders(<ImChannelsPage />)
    const card = await screen.findByTestId('im-feishu')
    // 没配时卡上只有一个主按钮，点开才出表单
    expect(within(card).queryByRole('button', { name: '保存并连接' })).toBeNull()
    fireEvent.click(within(card).getByRole('button', { name: '填应用凭据' }))
    const [appId, secret] = within(card).getAllByDisplayValue('') as HTMLInputElement[]
    fireEvent.change(appId as HTMLInputElement, { target: { value: 'cli_a1b2c3d4e5f60718' } })
    fireEvent.change(secret as HTMLInputElement, { target: { value: 'TOP-SECRET' } })
    expect((secret as HTMLInputElement).type).toBe('password')
    fireEvent.click(within(card).getByLabelText('国际版 Lark'))
    fireEvent.click(within(card).getByRole('button', { name: '保存并连接' }))
    await waitFor(() => expect(calls.feishu).toHaveLength(1))
    expect(calls.feishu[0]).toEqual({
      app_id: 'cli_a1b2c3d4e5f60718',
      app_secret: 'TOP-SECRET',
      domain: 'lark',
    })
    await waitFor(() => expect((secret as HTMLInputElement).value).toBe(''))
    expect(document.body.textContent).not.toContain('TOP-SECRET')
  })

  it('钉钉：配好之后只显示 Client ID；连不上给人话；重填 / 断开都在', async () => {
    calls.status = {
      ...base,
      dingtalk: {
        configured: true,
        connected: false,
        state: 'failed',
        error: 'Client ID 或 Client Secret 不对，或者应用还没开「Stream 模式」。',
        client_id: 'dingabc',
        me_bound: false,
      },
    }
    renderWithProviders(<ImChannelsPage />)
    const card = await screen.findByTestId('im-dingtalk')
    // WP214：状态是一个小图标，「连不上」与 Client ID 在它的 tooltip 里；连不上的原因常显
    const icon = within(await within(card).findByTestId('im-dingtalk-state')).getByTestId(
      'status-icon',
    )
    expect(icon.dataset.state).toBe('fail')
    expect(icon.getAttribute('data-hint')).toContain('连不上')
    expect(icon.getAttribute('data-hint')).toContain('已配好（Client ID dingabc）。')
    expect(card.textContent).not.toContain('已配好（Client ID dingabc）。')
    expect(within(card).getByRole('alert').textContent).toContain('Stream 模式')
    expect(within(card).queryByRole('button', { name: '保存并连接' })).toBeNull()
    expect(within(card).getByRole('button', { name: '断开' })).toBeTruthy()
    fireEvent.click(within(card).getByRole('button', { name: '重填凭据' }))
    expect(within(card).getByRole('button', { name: '保存并连接' })).toBeTruthy()
  })

  it('绑定我的账号：出码照着发；绑上了只剩解绑', async () => {
    calls.status = {
      ...base,
      feishu: {
        configured: true,
        connected: true,
        state: 'connected',
        app_id: 'cli_x',
        me_bound: false,
      },
      dingtalk: {
        configured: true,
        connected: true,
        state: 'connected',
        client_id: 'd',
        me_bound: true,
      },
    }
    renderWithProviders(<ImChannelsPage />)
    const feishu = await screen.findByTestId('im-feishu-bind')
    fireEvent.click(within(feishu).getByRole('button', { name: '绑定我的账号' }))
    await within(feishu).findByText('绑定 246810')
    expect(calls.bind).toBe(1)

    const ding = await screen.findByTestId('im-dingtalk-bound')
    // WP214：「我的账号已绑上」是一个账号小图标
    expect(within(ding).getByTestId('status-icon').getAttribute('data-hint')).toContain(
      '我的账号已绑上',
    )
    fireEvent.click(within(ding).getByRole('button', { name: '解绑' }))
    await waitFor(() => expect(calls.unbind).toEqual(['dingtalk']))
  })

  it('不是负责人 / 公司管理员：三张团队卡只看状态，没有填 / 改 / 断开；自己的绑定照旧能点', async () => {
    calls.status = {
      ...base,
      can_manage: false,
      wecom: { configured: true, connected: true, bot_id: 'B1', me_bound: false },
      feishu: {
        configured: true,
        connected: true,
        state: 'connected',
        app_id: 'cli_x',
        me_bound: false,
      },
      dingtalk: { configured: false, connected: false, state: 'idle', me_bound: false },
    }
    renderWithProviders(<ImChannelsPage />)
    const feishu = await screen.findByTestId('im-feishu')
    await waitFor(() =>
      expect(
        within(within(feishu).getByTestId('im-feishu-state'))
          .getByTestId('status-icon')
          .getAttribute('data-hint'),
      ).toContain('在收信'),
    )
    for (const name of ['填应用凭据', '重填凭据', '断开', '保存并连接'])
      expect(screen.queryByRole('button', { name }), name).toBeNull()
    expect(document.querySelector('input[type="password"]')).toBeNull()
    expect(
      within(screen.getByTestId('im-dingtalk-state')).getByTestId('status-icon').dataset.state,
    ).toBe('unknown')
    // 每人自己的「绑定我的账号」不受这条管
    const bind = await screen.findByTestId('im-feishu-bind')
    fireEvent.click(within(bind).getByRole('button', { name: '绑定我的账号' }))
    await within(bind).findByText('绑定 246810')
    expect(screen.getByTestId('im-wecom-bind')).toBeTruthy()
  })
})
