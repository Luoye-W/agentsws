/**
 * WP317（docs/101 §5.1④）：投放职责页上的素材流水线。
 *
 * 钉的是：传表 → 「N 条 · 差 M 条」→ 出新文案（字数写成 18/30、挡下的进问号）→
 * 下载上传表 / 交设计岗出图；实验记录前两格填了才能记。
 */
import type { AdCreativeRound, AdExperimentEntry } from '@agentsws/contracts'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdCreativeDesignData, AdCreativeImportData } from '@/lib/api'
import { renderWithProviders } from './helpers'

const IMPORT: AdCreativeImportData = {
  id: 'adimp_1',
  platform: 'google',
  metric: 'ctr',
  rows: 3,
  weak: [
    {
      ad_id: '102',
      campaign: 'PB',
      ad_group: 'Commute',
      metric: 'ctr',
      value: 0.01,
      baseline: 0.028,
      verdict: 'weak',
      reason: '点击率 1.00%，这张表的中位数是 2.78%。',
    },
    {
      ad_id: '104',
      campaign: 'PB',
      ad_group: 'Gift',
      metric: 'ctr',
      verdict: 'thin',
      reason: '展示 300 次，不到 1000，先不判。',
    },
  ],
  notes: [],
}

const ROUND: AdCreativeRound = {
  id: 'adround_1',
  platform: 'google',
  import_id: 'adimp_1',
  rewrites: [
    {
      ad_id: '102',
      campaign: 'PB',
      ad_group: 'Commute',
      headlines: [{ field: 'headline', text: '出门一整天不找插座', chars: 18, limit: 30 }],
      descriptions: [{ field: 'description', text: 'Fits any pocket.', chars: 16, limit: 90 }],
      rejected: [
        {
          field: 'headline',
          text: '全 网 最 低',
          rule: 'evasion',
          reason: '「全网最低」被拆开或换了写法。',
        },
      ],
      notes: [],
    },
  ],
  experiments_used: 1,
  notes: [],
  created_at: '2026-10-14T09:00:00Z',
}

const importAdCreativeExport = vi.fn<(input: unknown) => Promise<AdCreativeImportData>>()
const rewriteAdCreative = vi.fn<(input: unknown) => Promise<AdCreativeRound>>()
const requestAdCreativeDesign = vi.fn<() => Promise<AdCreativeDesignData>>()
const listAdExperiments = vi.fn<() => Promise<{ rows: AdExperimentEntry[] }>>()
const addAdExperiment = vi.fn<(input: unknown) => Promise<AdExperimentEntry>>()

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    importAdCreativeExport: (input: unknown) => importAdCreativeExport(input),
    rewriteAdCreative: (input: unknown) => rewriteAdCreative(input),
    requestAdCreativeDesign: () => requestAdCreativeDesign(),
    listAdExperiments: () => listAdExperiments(),
    addAdExperiment: (input: unknown) => addAdExperiment(input),
  }
})

const { AdCreativePanel, adCreativePlatformOf } = await import('@/components/ads/ad-creative-panel')

describe('素材流水线面板', () => {
  beforeEach(() => {
    importAdCreativeExport.mockReset()
    rewriteAdCreative.mockReset()
    requestAdCreativeDesign.mockReset()
    listAdExperiments.mockReset()
    addAdExperiment.mockReset()
    listAdExperiments.mockResolvedValue({ rows: [] })
  })

  it('只有 Google / Meta 两条投放职责有这一块', () => {
    expect(adCreativePlatformOf('ads.google')).toBe('google')
    expect(adCreativePlatformOf('ads.meta')).toBe('meta')
    expect(adCreativePlatformOf('ads.tiktok')).toBeUndefined()
  })

  it('传表 → 差几条；出新文案：字数 18/30，挡下的进问号；交设计岗', async () => {
    importAdCreativeExport.mockResolvedValue(IMPORT)
    rewriteAdCreative.mockResolvedValue(ROUND)
    requestAdCreativeDesign.mockResolvedValue({
      requested: true,
      request_id: 'dreq_1',
      title: 't',
      variants: 1,
      spec_ids: [],
      notes: [],
    })
    renderWithProviders(<AdCreativePanel assignment="asg_g" platform="google" />)
    const input = screen.getByTestId('ad-creative-file') as HTMLInputElement
    const f = new File(['Campaign,Ad group\nPB,Commute'], 'export.csv', { type: 'text/csv' })
    fireEvent.change(input, { target: { files: [f] } })
    expect((await screen.findByTestId('ad-creative-summary')).textContent).toBe(
      '3 条 · 差 1 条 · 1 条样本不够',
    )
    expect(importAdCreativeExport).toHaveBeenCalledWith({
      platform: 'google',
      text: 'Campaign,Ad group\nPB,Commute',
    })
    fireEvent.click(screen.getByTestId('ad-creative-rewrite'))
    const round = await screen.findByTestId('ad-creative-round')
    expect(round.textContent).toContain('出门一整天不找插座')
    expect(round.textContent).toContain('18/30')
    expect(round.textContent).toContain('挡下 1 条')
    fireEvent.click(screen.getByRole('button', { name: /交设计岗出图/ }))
    expect((await screen.findByTestId('ad-creative-design')).textContent).toBe('已下单 · 1 版')
  })

  it('实验记录：假设与改了什么都填了才能记', async () => {
    addAdExperiment.mockResolvedValue({
      id: 'adexp_1',
      round: 1,
      hypothesis: '带价格更好',
      change: '6 条带价格',
      at: '2026-10-14T09:00:00Z',
    })
    renderWithProviders(<AdCreativePanel assignment="asg_g" platform="google" />)
    const add = (await screen.findByTestId('ad-exp-add')) as HTMLButtonElement
    expect(add.disabled).toBe(true)
    fireEvent.change(screen.getByPlaceholderText('假设'), { target: { value: '带价格更好' } })
    expect(add.disabled).toBe(true)
    fireEvent.change(screen.getByPlaceholderText('改了什么'), { target: { value: '6 条带价格' } })
    fireEvent.click(add)
    await waitFor(() =>
      expect(addAdExperiment).toHaveBeenCalledWith({
        hypothesis: '带价格更好',
        change: '6 条带价格',
      }),
    )
  })
})
