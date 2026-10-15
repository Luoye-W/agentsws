/**
 * WP316：上传表卡的卡身（一句话 + 预览 + 原表 + 「批准上传」），职责页「广告改动」那一块
 * （等你确认：预览截图 + 确认提交 / 不提交；做完：读回、没截到、撤销）。
 */
import type { AdsLedgerEntryView } from '@agentsws/contracts'
import type { DeckCard } from '@agentsws/deck'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AdChangesPanel } from '@/components/ads/ad-changes-panel'
import { DeckCardView } from '@/components/deck/deck-card'
import { draftCard } from './fixtures'
import { renderWithProviders } from './helpers'

const confirm = vi.fn(async () => ({ ok: true, message: '已确认，插件这就提交。' }))
const undo = vi.fn(async () => ({ views: [{ staged: true }] }))
let rows: AdsLedgerEntryView[] = []
vi.mock('@/lib/ads-changes-api', async (orig) => ({
  ...(await orig<typeof import('@/lib/ads-changes-api')>()),
  listAdsLedger: async () => ({ rows }),
  confirmAdChange: (...args: unknown[]) => confirm(...(args as [])),
  undoAdChange: (...args: unknown[]) => undo(...(args as [])),
  getAdsEvidence: async () => ({ png_base64: 'iVBORw0KGgo=' }),
}))

const noop = (): void => {}

function sheetCard(): DeckCard {
  const base = draftCard()
  return draftCard({
    id: 'ap_sheet',
    kind: 'staged_change',
    layout: 'change',
    change_kind: 'ads_sheet',
    available_actions: ['approve', 'reject', 'instruct', 'snooze', 'open'],
    detail: {
      ...base.detail,
      payload: {
        change_id: 'chg_1',
        kind: 'ads_sheet',
        before: {},
        after: {
          form: 'ads_sheet',
          platform: 'google',
          account_id: 'aa_g',
          sentence: '新建 1 个广告系列、1 个广告组，都先暂停',
          rows: Array.from({ length: 8 }, (_, i) => ({
            action: '新建',
            level: '广告组',
            name: `G${i}`,
          })),
          warnings: ['落地页没写 utm'],
          fingerprint: 'f'.repeat(64),
          _files: [
            {
              name: 'agentsws-campaigns.csv',
              mime: 'text/csv',
              sheet: 'campaigns',
              base64: btoa('Campaign,Campaign status\nSpring,Paused\n'),
              fingerprint: 'sha256:x',
              bytes: 37,
            },
          ],
        },
      },
    },
  } as Partial<DeckCard>)
}

const row = (patch: Partial<AdsLedgerEntryView>): AdsLedgerEntryView => ({
  change_id: 'chg_1',
  kind: 'ads_sheet',
  platform: 'google',
  account_id: 'aa_g',
  title: '改广告（Google Ads）',
  sentence: '新建 1 个广告系列，都先暂停',
  state: 'done',
  jobs: [{ job_id: 'j1', status: 'done' }],
  evidence: [],
  evidence_missing: [],
  files: [],
  undo: { available: true },
  created_at: '2026-10-15T09:00:00.000Z',
  updated_at: '2026-10-15T09:10:00.000Z',
  kept_until: '2027-04-13T09:00:00.000Z',
  ...patch,
})

describe('WP316 上传表卡', () => {
  it('卡身：一句话、预览最多 6 行（多的写还有几条）、原表一个下载、提醒进问号；主按钮写「批准上传」', () => {
    renderWithProviders(
      <DeckCardView card={sheetCard()} mode="zh_summary" onDecide={noop} onOpen={noop} />,
    )
    expect(screen.getByTestId('ads-sheet-sentence').textContent).toContain('都先暂停')
    expect(within(screen.getByTestId('ads-sheet-rows')).getAllByRole('row')).toHaveLength(6)
    expect(screen.getByText('还有 2 条')).toBeTruthy()
    expect(screen.getAllByTestId('ads-sheet-download')).toHaveLength(1)
    expect(screen.getByTestId('ads-sheet-warnings').getAttribute('data-hint')).toContain('utm')
    expect(within(screen.getByTestId('deck-action-bar')).getByText('批准上传')).toBeTruthy()
  })
})

describe('WP316 职责页「广告改动」', () => {
  it('等你确认：预览截图 + 确认提交（走卡上那条路由）', async () => {
    rows = [
      row({
        state: 'waiting_confirm',
        jobs: [{ job_id: 'j1', status: 'queued' }],
        evidence: [{ id: 'ev_1', tag: 'preview', job_id: 'j1' }],
        undo: { available: false, why: '还没做成' },
      }),
    ]
    renderWithProviders(<AdChangesPanel assignment="asg_g" />)
    await waitFor(() => expect(screen.getByTestId('ads-change-confirm')).toBeTruthy())
    await waitFor(() => expect(screen.getAllByTestId('ads-change-shot')).toHaveLength(1))
    fireEvent.click(screen.getByTestId('ads-change-submit'))
    await waitFor(() => expect(confirm).toHaveBeenCalledWith('asg_g', 'chg_1', true))
    expect(screen.queryByTestId('ads-change-undo')).toBeNull()
  })

  it('做完的：读回结果、没截到、前后截图、撤销出一张卡', async () => {
    rows = [
      row({
        stop_loss: true,
        readback: { ok: false, sentence: '读回核对：1 条里 1 条对不上，照实报给人。' },
        evidence_missing: ['before'],
        evidence: [{ id: 'ev_a', tag: 'after', job_id: 'j1' }],
      }),
    ]
    renderWithProviders(<AdChangesPanel assignment="asg_g" />)
    await waitFor(() => expect(screen.getByTestId('ads-change-readback')).toBeTruthy())
    expect(screen.getByTestId('ads-change-readback').textContent).toContain('读回对不上')
    expect(screen.getByTestId('ads-change-missing').textContent).toContain('没截到')
    expect(screen.getByText('止损')).toBeTruthy()
    fireEvent.click(screen.getByTestId('ads-change-undo'))
    await waitFor(() => expect(undo).toHaveBeenCalledWith('asg_g', 'chg_1'))
    await waitFor(() => expect(screen.getByText('撤销卡出好了，去卡片流里批。')).toBeTruthy())
  })

  it('什么都没有：一句「还没有」', async () => {
    rows = []
    renderWithProviders(<AdChangesPanel assignment="asg_g" />)
    await waitFor(() => expect(screen.getByText('还没有')).toBeTruthy())
  })
})
