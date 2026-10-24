/**
 * WP505（决策 1773 B）：人点过「淘汰」的红人，还没合作时卡片主按钮是「看看」（打开详情），不再催「起草开发信」；
 * 详情里起草按钮退成次要样式（还能用）。已经在谈的合作照旧按阶段走。
 */

import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { KolCreatorDetailData, KolCreatorRowData } from '@/lib/api'
import { renderWithProviders } from './helpers'

const NOW = '2026-10-24T10:00:00.000Z'

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getKolOutreachDefaults: async () => ({
      brand_pitch: '',
      product: '',
      source: 'none' as const,
      mailbox_connected: true,
    }),
    getKolCollaborations: async () => ({ rows: [] }),
  }
})

const { CreatorCard, nextStepOf } = await import('@/components/kol/creator-card')
const { CreatorInfoCard } = await import('@/components/kol/creator-info-card')

const ROW: KolCreatorRowData = {
  creator_id: 'cre_1',
  display_name: 'Desk Fixture',
  channel: 'youtube',
  handle: '@deskfixture',
  url: 'https://www.youtube.com/@deskfixture',
  followers: 123_000,
  observed_at: NOW,
  score: 84,
  has_contact: false,
}
const REJECTED = { decision: 'rejected' as const, reason: '受众不对', decided_at: NOW }

const DETAIL: KolCreatorDetailData = {
  creator: { id: 'cre_1', display_name: 'Desk Fixture', merged_from: [] },
  accounts: [
    {
      id: 'pa_yt',
      channel: 'youtube',
      handle: '@deskfixture',
      url: 'https://www.youtube.com/@deskfixture',
      followers: 123_000,
      observed_at: NOW,
    },
  ],
  contacts: [],
  collaborations: [],
  deliverables: [],
  tracked_links: [],
}

describe('1773 B：已淘汰的主按钮是「看看」', () => {
  it('nextStepOf：淘汰 + 还没合作 → view（也盖过「先人工看一眼」）；在谈的照旧；通过 / 待审照旧起草', () => {
    expect(nextStepOf({ ...ROW, review: REJECTED })).toBe('view')
    expect(nextStepOf({ ...ROW, blocked: '疑似刷粉', review: REJECTED })).toBe('view')
    expect(
      nextStepOf({
        ...ROW,
        review: REJECTED,
        collab: {
          id: 'col_1',
          stage: 'negotiating',
          with_sample: false,
          stalled: false,
          segments: [],
        },
      }),
    ).toBe('negotiate')
    expect(nextStepOf({ ...ROW, review: { ...REJECTED, decision: 'approved' } })).toBe('draft')
    expect(nextStepOf(ROW)).toBe('draft')
  })

  it('卡片：淘汰的写「看看」、点了打开详情；没审的照旧「起草开发信」', () => {
    const onNext = vi.fn()
    renderWithProviders(
      <ol>
        <CreatorCard
          row={{ ...ROW, review: REJECTED }}
          handle="@deskfixture"
          onOpen={() => undefined}
          onNext={onNext}
        />
        <CreatorCard
          row={{ ...ROW, creator_id: 'cre_2' }}
          handle="@other"
          onOpen={() => undefined}
          onNext={() => undefined}
        />
      </ol>,
    )
    const [rejected, fresh] = screen.getAllByTestId('kol-card-next')
    expect(rejected?.textContent).toBe('看看')
    expect(fresh?.textContent).toBe('起草开发信')
    fireEvent.click(rejected as HTMLElement)
    expect(onNext).toHaveBeenCalledWith('view')
  })

  it('详情：淘汰的起草按钮退成次要样式（还能点）；没审的照旧是主按钮', async () => {
    const { unmount } = renderWithProviders(
      <CreatorInfoCard
        view={{ ...DETAIL, review: REJECTED }}
        assignment="asg_yt"
        channel="youtube"
      />,
    )
    expect((await screen.findByTestId('kol-outreach-go')).getAttribute('data-variant')).toBe(
      'outline',
    )
    unmount()
    renderWithProviders(<CreatorInfoCard view={DETAIL} assignment="asg_yt" channel="youtube" />)
    expect((await screen.findByTestId('kol-outreach-go')).getAttribute('data-variant')).toBe(
      'default',
    )
  })
})
