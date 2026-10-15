/**
 * WP348（决策 892）：对话里点了 `setup:目标` 的 genui 按钮——事项 / 线程里就地出同一张方案卡（走 `genui-setup`，
 * 不再把按钮那句话发给 AI 让它去要卡）；没有事项的对话（随便聊）照旧把那句话发进对话。
 */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from './helpers'

const SLOW = { timeout: 30_000 }
const runGenuiSetup = vi.fn(async (_id: string, _input: { target: string; label: string }) => ({
  status: 'card' as const,
  message: 'Reddit 巡查的方案在下面这张卡上。',
  approval_item_id: 'ap_plan',
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    runGenuiSetup: (id: string, input: { target: string; label: string }) =>
      runGenuiSetup(id, input),
    getImageHosts: async () => ({ hosts: [], shop_hosts: [] }),
  }
})

beforeEach(() => {
  runGenuiSetup.mockClear()
})

const { GenuiHostProvider } = await import('@/components/answer/genui/genui-host')
const { SafeMarkdown } = await import('@/components/ui/safe-markdown')

const reply = [
  '要先把巡查设好。',
  '',
  '```dsh-ui',
  JSON.stringify({
    items: [{ type: 'button', label: '设好 Reddit 巡查', action: 'setup:reddit.watch' }],
  }),
  '```',
].join('\n')

function renderReply(host: Parameters<typeof GenuiHostProvider>[0]['value']) {
  return renderWithProviders(
    <GenuiHostProvider value={host}>
      <SafeMarkdown text={reply} variant="chat" />
    </GenuiHostProvider>,
  )
}

describe('WP348 对话里的「设好 X」按钮', () => {
  it('事项里：就地出同一张方案卡（genui-setup），不替人说话；刷新时间线', async () => {
    const say = vi.fn()
    const onToolDone = vi.fn()
    renderReply({ say, matterId: 'mat_1', runId: 'run_1', onToolDone })
    fireEvent.click(await screen.findByRole('button', { name: /设好 Reddit 巡查/u }, SLOW))
    await waitFor(() => expect(onToolDone).toHaveBeenCalledTimes(1))
    expect(runGenuiSetup).toHaveBeenCalledWith('mat_1', {
      target: 'reddit.watch',
      label: '设好 Reddit 巡查',
    })
    expect(say).not.toHaveBeenCalled()
  })

  it('随便聊（没有事项）：把那句话发进对话，让 AI 去要', async () => {
    const say = vi.fn()
    renderReply({ say })
    fireEvent.click(await screen.findByRole('button', { name: /设好 Reddit 巡查/u }, SLOW))
    expect(say).toHaveBeenCalledWith('设好 Reddit 巡查')
    expect(runGenuiSetup).not.toHaveBeenCalled()
  })
})
