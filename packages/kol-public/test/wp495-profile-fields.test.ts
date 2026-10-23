/**
 * WP495（1707b）：白名单放开了名字 / 主页链接两格（只加）；形状不对照旧整批拒；
 * 生意数据（报价 / 备注 / 合作状态 / 日期 / 负责人）的键一个都过不去。
 */
import { PUBLIC_LIBRARY_BUSINESS_KEYS } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { parseObservation } from '../src/index.js'

const AT = '2026-10-23T00:00:00.000Z'
const row = (extra: Record<string, unknown> = {}) => ({
  channel: 'youtube',
  handle: 'kaisetuplab',
  followers: 48_000,
  observed_at: '2026-10-22T00:00:00.000Z',
  ...extra,
})

describe('WP495 资料两格', () => {
  it('规整过的名字 / 主页链接能过', () => {
    expect(() =>
      parseObservation(
        row({ display_name: 'Kai Setup', profile_url: 'https://youtube.com/@kaisetuplab' }),
        AT,
        { metricsOptional: true },
      ),
    ).not.toThrow()
  })

  it('没规整 / 带凭据 / 私信页：拒而不改', () => {
    for (const bad of [
      { display_name: '  Kai  ' },
      { display_name: 42 },
      { profile_url: 'https://youtube.com/@kai?session=abc' },
      { profile_url: 'https://www.instagram.com/direct/inbox/' },
      { profile_url: 'javascript:alert(1)' },
    ])
      expect(() => parseObservation(row(bad), AT, { metricsOptional: true })).toThrow()
  })

  it('生意数据的键：每一个都整批拒', () => {
    for (const key of PUBLIC_LIBRARY_BUSINESS_KEYS)
      expect(() => parseObservation(row({ [key]: 'x' }), AT, { metricsOptional: true })).toThrow(
        new RegExp(key),
      )
  })
})
