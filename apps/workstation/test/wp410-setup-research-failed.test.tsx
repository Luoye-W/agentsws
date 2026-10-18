/**
 * WP410（真机 #6）：出卡前没查成——卡上照实说原因、直接摊开表单问人要不要填；
 * 「就这样」点不了（没有方案可点头），不装成方案、也不静默退回一张没说明的空表单。
 */
import type { SetupRequestPayload } from '@agentsws/contracts'
import type { DeckCard } from '@agentsws/deck'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DeckCardView } from '@/components/deck/deck-card'
import { draftCard } from './fixtures'
import { renderWithProviders } from './helpers'

const noop = (): void => {}
const decide = vi.fn(async (_id: string, _input: unknown, _asg: string) => ({}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, decide: (id: string, input: unknown, asg: string) => decide(id, input, asg) }
})

beforeEach(() => {
  decide.mockClear()
})

const failed: SetupRequestPayload = {
  form: 'setup_request',
  target: 'reddit.watch',
  why: '没查成：联网搜索没开；没接 AI 模型。要不要你来填下面几格？也可以补好品牌档案后跟我说「再查一次」。',
  mode: 'plan',
  research_failed: '联网搜索没开；没接 AI 模型',
  fields: [
    { key: 'keywords', label: '关键词', kind: 'text', required: false },
    {
      key: 'brand_username',
      label: '品牌号',
      kind: 'text',
      suggested: 'IVRA_Official',
      sources: [{ kind: 'connected', label: '插件里登着的 Reddit 号' }],
      required: false,
    },
  ],
}

function card(payload: SetupRequestPayload): DeckCard {
  const base = draftCard()
  return draftCard({
    id: 'ap_failed',
    kind: 'setup_request',
    layout: 'policy',
    title: 'Reddit 巡查：没查成，要你来填吗',
    available_actions: ['approve', 'reject', 'snooze', 'open'],
    action_labels: { approve: '就这样', reject: '先不设', snooze: '稍后' },
    detail: { ...base.detail, payload: payload as never },
  })
}

describe('WP410 没查成照实说', () => {
  it('卡上写原因、表单直接摊开（已知的品牌号预填），填好保存 = 人填的值', async () => {
    renderWithProviders(
      <DeckCardView card={card(failed)} mode="zh_summary" onDecide={noop} onOpen={noop} />,
    )
    expect(screen.getByTestId('setup-plan-research-failed').textContent).toContain(
      '没查成：联网搜索没开；没接 AI 模型',
    )
    expect(screen.queryByTestId('setup-plan-accept')).toBeNull()
    const inputs = screen.getAllByRole('textbox') as HTMLInputElement[]
    expect(inputs.map((i) => i.value)).toEqual(['', 'IVRA_Official'])
    await userEvent.type(inputs[0] as HTMLInputElement, 'IVRA, AI glasses')
    await userEvent.click(screen.getByTestId('setup-fields-save'))
    await waitFor(() => expect(decide).toHaveBeenCalledTimes(1))
    const input = decide.mock.calls[0]?.[1] as {
      edited_payload: { values: Record<string, string> }
    }
    expect(input.edited_payload.values).toEqual({
      keywords: 'IVRA, AI glasses',
      brand_username: 'IVRA_Official',
    })
  })

  it('收起后「就这样」点不了（没有方案可点头）', async () => {
    renderWithProviders(
      <DeckCardView card={card(failed)} mode="zh_summary" onDecide={noop} onOpen={noop} />,
    )
    await userEvent.click(screen.getByTestId('setup-plan-fold'))
    expect((screen.getByTestId('setup-plan-accept') as HTMLButtonElement).disabled).toBe(true)
  })
})
