/**
 * WP316：广告改动进首页告警区——等你确认的一直挂着；退回 / 交给你 / 读回对不上只挂 24 小时；
 * 本人没有那条职责就不提醒；点「去处理」到职责页那一块。
 */
import type { AdsLedgerEntryView } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { adsNoticeCards } from '../src/ads-wiring/notices.js'

const NOW = '2026-10-15T09:00:00.000Z'
const row = (patch: Partial<AdsLedgerEntryView>): AdsLedgerEntryView => ({
  change_id: 'chg_1',
  kind: 'ads_sheet',
  platform: 'google',
  account_id: 'aa_g',
  title: '改广告',
  state: 'done',
  jobs: [],
  evidence: [],
  evidence_missing: [],
  files: [],
  undo: { available: true },
  created_at: NOW,
  updated_at: NOW,
  kept_until: NOW,
  ...patch,
})
const hrefOf = (p: string) =>
  p === 'google'
    ? { href: '/positions/asg_g/duties/ads.google', position_id: 'asg_g', role_id: 'ads.google' }
    : undefined

describe('广告改动的提醒', () => {
  it('等你确认 → 一条 P1 提醒，点了去职责页', () => {
    const [card] = adsNoticeCards({ rows: [row({ state: 'waiting_confirm' })], now: NOW, hrefOf })
    expect(card).toMatchObject({ kind: 'system_alert', priority_band: 'P1' })
    expect(card?.title).toContain('等你确认')
    expect((card?.detail.payload as { open_path?: string } | undefined)?.open_path).toBe(
      '/positions/asg_g/duties/ads.google',
    )
  })

  it('读回对不上 / 退回：24 小时内提醒，过了就不挂；做完对上的不提醒', () => {
    const bad = row({ readback: { ok: false, sentence: '1 条对不上' } })
    expect(adsNoticeCards({ rows: [bad], now: NOW, hrefOf })[0]?.summary).toBe('1 条对不上')
    const old = row({ state: 'rejected', updated_at: '2026-10-13T09:00:00.000Z' })
    expect(adsNoticeCards({ rows: [old], now: NOW, hrefOf })).toEqual([])
    expect(
      adsNoticeCards({ rows: [row({ readback: { ok: true, sentence: '' } })], now: NOW, hrefOf }),
    ).toEqual([])
  })

  it('本人没有那条职责（Meta 那条）就不提醒；只读的导出不提醒', () => {
    expect(
      adsNoticeCards({
        rows: [row({ platform: 'meta', state: 'waiting_confirm' })],
        now: NOW,
        hrefOf,
      }),
    ).toEqual([])
    expect(
      adsNoticeCards({
        rows: [row({ kind: 'export_snapshot', state: 'failed' })],
        now: NOW,
        hrefOf,
      }),
    ).toEqual([])
  })
})
