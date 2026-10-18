/**
 * WP413：侧边栏那几样事实的换形状（纯函数）：下次几点读、批过的写留哪几条、发出记录带各去处写没写进去、
 * 发出记录记「在哪儿批的」。
 */
import type { OutboundRecord, RecordSinkView, RedditWriteView } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { nextRunAt, panelRecordOf, recentWrites, withApprovalVia } from '../src/extension-panel.js'

const daily = { enabled: true, every_hours: 24, day_start_hour: 9 }

describe('下次大约几点读', () => {
  it('一天一次：上次那天往后一天、到本地 9 点；北京时间（+480）', () => {
    expect(
      nextRunAt({
        now: '2026-10-18T03:00:00.000Z',
        tz_offset_minutes: 480,
        settings: daily,
        configured: true,
        last_started_at: '2026-10-18T01:30:00.000Z', // 北京 09:30
      }),
    ).toBe('2026-10-19T01:00:00.000Z') // 北京 10-19 09:00
  })
  it('从没读过：今天到点；已过点 = 现在。关了 / 没设好 = 没有', () => {
    const now = '2026-10-18T03:00:00.000Z'
    expect(nextRunAt({ now, tz_offset_minutes: 480, settings: daily, configured: true })).toBe(now)
    expect(
      nextRunAt({
        now,
        tz_offset_minutes: 480,
        settings: { ...daily, enabled: false },
        configured: true,
      }),
    ).toBeUndefined()
    expect(
      nextRunAt({ now, tz_offset_minutes: 480, settings: daily, configured: false }),
    ).toBeUndefined()
  })
  it('隔 6 小时：上次 + 6 小时', () => {
    expect(
      nextRunAt({
        now: '2026-10-18T03:00:00.000Z',
        tz_offset_minutes: 0,
        settings: { ...daily, every_hours: 6 },
        configured: true,
        last_started_at: '2026-10-18T02:00:00.000Z',
      }),
    ).toBe('2026-10-18T08:00:00.000Z')
  })
})

const w = (over: Partial<RedditWriteView>): RedditWriteView => ({
  approval_item_id: 'ap_1',
  job_id: 'aj_1',
  kind: 'reply',
  subreddit: 'ivraxr',
  state: 'queued',
  queued_at: '2026-10-18T00:00:00.000Z',
  ...over,
})

describe('批过的写留哪几条', () => {
  it('同一张卡只留最新那一件；已发的留一天、没发出去的留 7 天；收起的不留', () => {
    const now = '2026-10-20T00:00:00.000Z'
    const out = recentWrites(
      [
        w({ job_id: 'aj_old', state: 'failed', queued_at: '2026-10-17T00:00:00.000Z' }),
        w({ job_id: 'aj_new', state: 'filling', queued_at: '2026-10-19T23:00:00.000Z' }),
        w({
          approval_item_id: 'ap_2',
          job_id: 'aj_sent',
          state: 'sent',
          finished_at: '2026-10-18T00:00:00.000Z',
        }),
        w({
          approval_item_id: 'ap_3',
          job_id: 'aj_fail',
          state: 'failed',
          finished_at: '2026-10-15T00:00:00.000Z',
        }),
        w({ approval_item_id: 'ap_4', job_id: 'aj_hid', state: 'failed', dismissed: true }),
      ],
      now,
    )
    expect(out.map((x) => x.job_id)).toEqual(['aj_new', 'aj_fail'])
  })
})

describe('发出记录 → 侧边栏一行', () => {
  const record: OutboundRecord = {
    id: 'ob_1',
    workspace_id: 'ws_1' as never,
    source_key: 'approval:ap_1',
    sent_at: '2026-10-18T00:00:00.000Z',
    channel: 'reddit',
    action: 'reply',
    kind: 'reddit_write',
    content: 'hi',
    status: 'sent',
    follow_ups: [],
    approval_item_id: 'ap_1',
    approved_by: 'Luoye',
    approved_via: 'extension',
  }
  const sink = (id: string, name: string): RecordSinkView =>
    ({ id, name, state: 'active', written: 0, pending: 0 }) as unknown as RecordSinkView
  it('带各去处写没写进去（退避重试中带错 = 没写进去）、标在插件里批的、留 approval_item_id 给路由筛', () => {
    const row = panelRecordOf(record, [sink('s1', '飞书回复表'), sink('s2', '备份表')], () => [
      { sink_id: 's1', record_id: 'ob_1', status: 'written', attempts: 1 },
      {
        sink_id: 's2',
        record_id: 'ob_1',
        status: 'pending',
        attempts: 2,
        last_error: { code: 'auth', message: '飞书授权过期了' } as never,
      },
    ])
    expect(row).toMatchObject({
      via_extension: true,
      approved_by: 'Luoye',
      approval_item_id: 'ap_1',
      sinks: [
        { name: '飞书回复表', status: 'written' },
        { name: '备份表', status: 'failed', message: '飞书授权过期了' },
      ],
    })
  })
  it('withApprovalVia：按卡上的决定补「在哪儿批的」；已有 / 找不到卡就原样', () => {
    const input = { ...record } as never as Parameters<typeof withApprovalVia>[0]
    const { approved_via: _drop, ...bare } = input
    expect(
      withApprovalVia(bare, () => ({ decision: { via: 'extension' } as never })).approved_via,
    ).toBe('extension')
    expect(withApprovalVia(bare, () => undefined)).toBe(bare)
    expect(
      withApprovalVia(input, () => ({ decision: { via: 'workstation' } as never })).approved_via,
    ).toBe('extension')
  })
})
