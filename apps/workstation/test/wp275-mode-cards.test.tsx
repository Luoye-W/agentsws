/**
 * WP275（docs/95 §5，决策 222）：卡片与「自己改」按模式。
 *
 * - 超了你设的上限的卡（`reconfirm`，只有 ① ② 会出）：「通过」要点两下，键盘 → 也一样；
 * - ① / ② 的卡片词是「要你确认」系：策略卡不说「只有 owner 能批」、指导不说「进策略变更审批」、
 *   B2B 报价「等你确认」不写「上级批 / 老板批」；③ 照旧；
 * - ① 里改额度：保存前问一句，回执「当场生效」；③ 照旧「提交审批」。
 */
import type { DeckCard } from '@agentsws/deck'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DeckCardView } from '@/components/deck/deck-card'
import type { B2bSalesData, OrganizationView } from '@/lib/api'
import { draftCard } from './fixtures'
import { renderWithProviders } from './helpers'
import { COMPANY_ORG, companyWordsIn, SOLO_ORG } from './mode-words'

const PEERS_ORG: OrganizationView = { ...SOLO_ORG, members: 2, solo: false, mode: 'peers' }

const state: { orgs: OrganizationView[] } = { orgs: [] }

const SALES: B2bSalesData = {
  facts: { industry: '3C', recommended_certifications: [], ready: 0, categories: [] },
  quotes: [
    {
      id: 'quo_1',
      number: 'Q-01',
      account: 'Volthaus',
      version: 2,
      amount_usd: 18414,
      status: 'pending_approval',
      pending: { version: 2, approver: 'role_holder', breaches: ['quote_amount_over_mandate'] },
    },
  ],
  samples: [],
  handovers: [],
}

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    listOrganizations: async () => state.orgs,
    getB2bSales: async () => SALES,
  }
})

const { B2bSalesPanel } = await import('@/components/b2b/sales-panel')

beforeEach(() => {
  state.orgs = []
})

const noop = (): void => {}

/** 一张 ① ② 里超了上限、落回本人的改价卡。 */
function overLimitCard(over: Partial<DeckCard> = {}): DeckCard {
  return draftCard({
    id: 'ap_over',
    kind: 'staged_change',
    routed_note: '超了你设的上限（金额），要你再确认一次',
    reconfirm: true,
    ...over,
  })
}

describe('WP275：超了上限，再确认一次', () => {
  it('第一下只把按钮换成「再点一次确认」，第二下才通过', () => {
    const onDecide = vi.fn()
    renderWithProviders(
      <DeckCardView card={overLimitCard()} mode="zh_summary" onDecide={onDecide} onOpen={noop} />,
    )
    expect(screen.getByTestId('deck-reconfirm-hint').textContent).toContain('再点一次')
    expect(screen.getByTestId('deck-routed-note').textContent).not.toContain('转给')
    const approve = document.querySelector('button[data-action="approve"]') as HTMLButtonElement
    fireEvent.click(approve)
    expect(onDecide).not.toHaveBeenCalled()
    expect(approve.textContent).toBe('再点一次确认')
    fireEvent.click(approve)
    expect(onDecide).toHaveBeenCalledTimes(1)
    expect(onDecide.mock.calls[0]?.[0]).toMatchObject({ action: 'approve' })
  })

  it('没超上限的卡照旧一下就过、也不出那句提示', () => {
    const onDecide = vi.fn()
    renderWithProviders(
      <DeckCardView card={draftCard()} mode="zh_summary" onDecide={onDecide} onOpen={noop} />,
    )
    expect(screen.queryByTestId('deck-reconfirm-hint')).toBeNull()
    fireEvent.click(document.querySelector('button[data-action="approve"]') as HTMLButtonElement)
    expect(onDecide).toHaveBeenCalledTimes(1)
  })
})

describe('WP275：卡片词按模式', () => {
  const policyCard = (payload: Record<string, unknown> = {}): DeckCard => {
    const base = draftCard()
    return draftCard({
      id: 'ap_policy',
      kind: 'policy_change',
      layout: 'policy',
      detail: {
        ...base.detail,
        payload: { before: { 额度: '≤ 20%' }, after: { 额度: '≤ 25%' }, ...payload },
      },
    })
  }

  it('① 策略卡（AI 提的「以后都这样」）：不提 owner、不说「批」', async () => {
    state.orgs = [SOLO_ORG]
    renderWithProviders(
      <DeckCardView card={policyCard()} mode="zh_summary" onDecide={noop} onOpen={noop} />,
    )
    const body = screen.getByTestId('deck-layout-policy')
    await waitFor(() => {
      expect(body.textContent).toContain('点通过以后都这样做')
    })
    expect(body.textContent).not.toContain('owner')
    expect(companyWordsIn(body)).toEqual([])
  })

  it('② 同事改了共用的规矩：通知卡说「已经生效，可撤回」', () => {
    state.orgs = [PEERS_ORG]
    renderWithProviders(
      <DeckCardView
        card={policyCard({
          form: 'peer_change_notice',
          options: [
            { id: 'after', label: '知道了' },
            { id: 'before', label: '撤回' },
          ],
        })}
        mode="zh_summary"
        onDecide={noop}
        onOpen={noop}
      />,
    )
    const body = screen.getByTestId('deck-layout-policy')
    expect(body.textContent).toContain('已经生效')
    expect(body.textContent).not.toContain('owner')
  })

  it('③ 策略卡照旧：只有 owner 能批', () => {
    state.orgs = [COMPANY_ORG]
    renderWithProviders(
      <DeckCardView card={policyCard()} mode="zh_summary" onDecide={noop} onOpen={noop} />,
    )
    expect(screen.getByTestId('deck-layout-policy').textContent).toContain('owner')
  })

  it('① B2B 报价：「等你确认」，不写「上级批 / 老板批 / 在批」', async () => {
    state.orgs = [SOLO_ORG]
    renderWithProviders(<B2bSalesPanel assignment="asg_sales" />)
    const row = (await screen.findAllByTestId('b2b-quote-row'))[0] as HTMLElement
    await waitFor(() => {
      expect(row.textContent).toContain('等你确认')
    })
    expect(row.textContent).not.toMatch(/上级批|老板批|在批/)
  })

  it('② B2B 报价同 ①：谁也不批谁', async () => {
    state.orgs = [PEERS_ORG]
    renderWithProviders(<B2bSalesPanel assignment="asg_sales" />)
    const row = (await screen.findAllByTestId('b2b-quote-row'))[0] as HTMLElement
    await waitFor(() => {
      expect(row.textContent).toContain('等你确认')
    })
    expect(companyWordsIn(row)).toEqual([])
  })
})
