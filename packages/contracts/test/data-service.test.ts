/**
 * WP192：官方数据接口统一能力口的契约常量（只加不删）。
 */
import { describe, expect, it } from 'vitest'
import {
  DATA_CAPABILITY_ROUTE_LEVELS,
  DATA_SERVICE_CLOUD_PATHS,
  DATA_SERVICE_SCOPE,
  DATA_TASK_STATUSES,
  DATA_TASK_TERMINAL_STATUSES,
  DEFAULT_DATA_CAPABILITY_ORDER,
  dataCapabilityRouteKey,
  KOL_PUBLIC_SCOPE,
} from '../src/index.js'

describe('WP192 数据能力契约', () => {
  it('状态机六个状态，终态是后四个', () => {
    expect([...DATA_TASK_STATUSES]).toEqual([
      'queued',
      'running',
      'succeeded',
      'failed',
      'cancelled',
      'timed_out',
    ])
    expect([...DATA_TASK_TERMINAL_STATUSES]).toEqual([
      'succeeded',
      'failed',
      'cancelled',
      'timed_out',
    ])
  })

  it('与公共红人库、搜索数据同一个 data 动作集；路径都在 /v1/data 下', () => {
    expect(DATA_SERVICE_SCOPE).toBe(KOL_PUBLIC_SCOPE)
    for (const path of Object.values(DATA_SERVICE_CLOUD_PATHS))
      expect(path.startsWith('/v1/data/')).toBe(true)
  })

  it('本机路由键是 data.<能力>；默认只有「Agents 工坊（用积分）」一级', () => {
    expect(dataCapabilityRouteKey('maps.places')).toBe('data.maps.places')
    expect([...DEFAULT_DATA_CAPABILITY_ORDER]).toEqual(['workshop'])
    expect(DATA_CAPABILITY_ROUTE_LEVELS).toContain('workshop')
    expect(DATA_CAPABILITY_ROUTE_LEVELS).not.toContain('official_key')
  })
})
