/**
 * WP420（自查 ads-amazon）投放这边的界面：
 * - 改预算卡一行「日预算 $300 → $330」，不露字段名，总闸那句不再重复（U2）；插件没连卡底一行（U4）；
 * - 连接卡插件那几行：没配对 / 后台没在插件里连上 → 要处理（A5 / U1）；
 * - 投放看板四个数 + 日报数据那一行 + 广告系列表（A6 / A8）。
 */
import { screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AdsChangeBody, money, reasonWithoutGate } from '@/components/ads/ads-change-body'
import { AdsOverview, dataLineKey } from '@/components/ads/ads-overview'
import { extensionRowsOf } from '@/components/rail/cards/extension-rows'
import type { AdsOverviewView } from '@/lib/ads-changes-api'
import { renderWithProviders } from './helpers'

const OVERVIEW: AdsOverviewView = {
  platform: 'meta',
  currency: 'USD',
  spend_today: 700,
  spend_gate: { spent: 700, cap: 1000, remaining: 300, note: '还剩 300' },
  roas_today: 1.8,
  stop_losses_today: 1,
  campaigns: [
    { id: 'c1', name: '老客再营销', status: 'active', daily_budget: 300, spend: 500, roas: 2.1 },
    { id: 'c2', name: '新品冷启动', status: 'paused', daily_budget: 200, spend: 200 },
  ],
  data: { plugin: 'ready', account: '999888777', last_import_at: new Date().toISOString() },
}

const getAdsOverview = vi.fn(async (_a: string) => OVERVIEW)
vi.mock('@/lib/ads-changes-api', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/ads-changes-api')>('@/lib/ads-changes-api')
  return { ...actual, getAdsOverview: (a: string) => getAdsOverview(a) }
})

describe('改预算卡（U2 / U4）', () => {
  it('金额带币种；摘要里去掉总闸那一段', () => {
    expect(money(300, 'USD')).toBe('$300')
    expect(money(12.5, 'EUR')).toBe('€12.50')
    expect(money(undefined, 'USD')).toBe('—')
    expect(reasonWithoutGate('300 → 330｜今天花了 700，总闸 1000', '今天花了 700，总闸 1000')).toBe(
      '300 → 330',
    )
  })

  it('一行前后对比、不露 value / platform 字段名；插件没连卡底一行', () => {
    renderWithProviders(
      <AdsChangeBody
        payload={{
          kind: 'budget_change',
          before: { value: 300 },
          after: {
            value: 330,
            platform: 'meta',
            platform_label: 'Meta',
            currency: 'USD',
            spend_gate_note: '今天花了 700，总闸 1000，还剩 300',
            queue_note: '插件没连：批了先排队，连上就做。',
            queued_ahead: '改日预算 → 320',
          },
        }}
        reason="老客回购好｜今天花了 700，总闸 1000，还剩 300"
        title="改预算：老客再营销"
      />,
    )
    expect(screen.getByTestId('ads-change-main').textContent).toBe('日预算 $300 → $330')
    expect(screen.getByTestId('deck-reason').textContent).toBe('老客回购好')
    expect(screen.getByTestId('ads-change-queue-note').textContent).toContain('批了先排队')
    expect(screen.getByTestId('ads-change-ahead').textContent).toContain('320')
    expect(document.body.textContent).not.toMatch(/value|platform|spend gate/u)
  })
})

describe('连接卡插件那几行（A5 / U1）', () => {
  it('不要插件 → 不出；没配对 → 两行都要处理；配上了、后台没连 → 一行要处理', () => {
    expect(extensionRowsOf({ needed: false, paired: false, steps: [] })).toBeUndefined()
    expect(
      extensionRowsOf({ needed: true, paired: false, steps: [{ step: 'meta_ads', done: false }] }),
    ).toEqual([
      { key: 'paired', ok: false },
      { key: 'meta_ads', ok: false },
    ])
    expect(
      extensionRowsOf({
        needed: true,
        paired: true,
        steps: [{ step: 'meta_ads', done: false }, { step: 'google_ads' }],
      }),
    ).toEqual([
      { key: 'paired', ok: true },
      { key: 'meta_ads', ok: false },
    ])
  })
})

describe('投放看板（A6 / A8）', () => {
  it('日报数据那一行：没设账户 / 插件没连 / 一天没来 / 导进来了', () => {
    expect(dataLineKey(undefined).key).toBe('adsov.data.unavailable')
    expect(dataLineKey({ plugin: 'ready' }).key).toBe('adsov.data.no_account')
    expect(dataLineKey({ plugin: 'not_connected', account: '1' })).toMatchObject({
      key: 'adsov.data.not_connected',
      bad: true,
    })
    expect(dataLineKey({ plugin: 'away', account: '1' }).key).toBe('adsov.data.away')
    expect(dataLineKey({ plugin: 'ready', account: '1', last_import_at: 'x' }).key).toBe(
      'adsov.data.ready',
    )
  })

  it('四个数 + 广告系列表（花得最多的在上）', async () => {
    renderWithProviders(<AdsOverview assignment="as_meta" />)
    await waitFor(() => {
      expect(screen.getByTestId('ads-overview')).toBeTruthy()
    })
    expect(screen.getByTestId('ads-overview-spend').textContent).toContain('$700')
    expect(screen.getByTestId('ads-overview-gate').textContent).toContain('$300')
    expect(screen.getByTestId('ads-overview-roas').textContent).toContain('1.8')
    expect(screen.getByTestId('ads-overview-stops').textContent).toContain('1')
    expect(screen.getAllByTestId('ads-overview-row')).toHaveLength(2)
    expect(screen.getByTestId('ads-overview-data').textContent).toContain('导进来了')
  })
})
