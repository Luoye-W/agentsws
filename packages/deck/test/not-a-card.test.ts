/**
 * WP96（09-18 / 36 §2）：**只有要人决定的才是卡**。
 *
 * 日报（WP63）与上线检查单（WP77）在账本上照旧在（14 的老规矩：Agent 主动做的
 * 每件事都进同一条账），但投影到界面时不进队列——它们落进岗位面板的报表块。
 * 纯告警进通知与告警块。这条题钉的就是这个分流。
 */
import type { ApprovalItem } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { assembleHome } from '../src/home.js'
import type { HomePosition, QueryContext } from '../src/index.js'
import { item, NOW } from './fixtures.js'

const query = { now: NOW, sources: [], orders: [] } as unknown as QueryContext

function position(items: ApprovalItem[]): HomePosition {
  return {
    position_id: 'asg_1',
    role_id: 'dtc.store',
    role_name: '网站运营',
    items,
    tile_ids: [],
    range: 'yesterday',
    query,
  }
}

describe('日报与上线检查单不进队列', () => {
  it('日报落进报表块', () => {
    const home = assembleHome({
      now: NOW,
      positions: [position([item({ id: 'ap_r', kind: 'daily_report' })])],
    })
    expect(home.queue).toHaveLength(0)
    expect(home.reports.map((c) => c.id)).toEqual(['ap_r'])
  })

  it('上线检查单（staged_change · launch_check）也落进报表块', () => {
    const home = assembleHome({
      now: NOW,
      positions: [
        position([item({ id: 'ap_c', kind: 'staged_change', payload: { kind: 'launch_check' } })]),
      ],
    })
    expect(home.queue).toHaveLength(0)
    expect(home.reports.map((c) => c.id)).toEqual(['ap_c'])
  })

  it('别的 staged_change 照旧进队列——补货、改价都是要人点头的', () => {
    const home = assembleHome({
      now: NOW,
      positions: [
        position([
          item({ id: 'ap_p', kind: 'staged_change', payload: { kind: 'inventory_adjust' } }),
        ]),
      ],
    })
    expect(home.queue.map((c) => c.id)).toEqual(['ap_p'])
    expect(home.reports).toHaveLength(0)
  })

  it('「今天队列预计 X 分钟」不把报表算进去（看一眼就过的东西不占人的时间）', () => {
    const withReport = assembleHome({
      now: NOW,
      positions: [position([item({ id: 'ap_r', kind: 'daily_report' })])],
    })
    const empty = assembleHome({ now: NOW, positions: [position([])] })
    expect(withReport.estimated_minutes).toBe(empty.estimated_minutes)
  })
})
