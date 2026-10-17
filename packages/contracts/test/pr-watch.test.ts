import { describe, expect, it } from 'vitest'
import {
  GOOGLE_ALERTS_REQUIRED_SETTINGS,
  MONITOR_GROUP_LABELS,
  MONITOR_GROUPS,
  MONITOR_SETTINGS_DEFAULTS,
  maskFeedUrl,
} from '../src/index.js'

describe('WP386 信息监控契约', () => {
  it('四组都有中英文名', () => {
    expect(MONITOR_GROUPS).toEqual(['own', 'competitor', 'industry', 'site'])
    for (const g of MONITOR_GROUPS) {
      expect(MONITOR_GROUP_LABELS[g].zh).not.toBe('')
      expect(MONITOR_GROUP_LABELS[g].en).not.toBe('')
    }
    expect(MONITOR_GROUP_LABELS.competitor.zh).toBe('竞品')
  })

  it('默认一天一次、本地 9 点后；Reddit 那一路默认不跑', () => {
    expect(MONITOR_SETTINGS_DEFAULTS.default_every_hours).toBe(24)
    expect(MONITOR_SETTINGS_DEFAULTS.day_start_hour).toBe(9)
    expect(MONITOR_SETTINGS_DEFAULTS.reddit_queries).toEqual([])
  })

  it('建提醒必须是「所有结果」+ 投递 RSS', () => {
    expect(GOOGLE_ALERTS_REQUIRED_SETTINGS.how_many).toBe('all_results')
    expect(GOOGLE_ALERTS_REQUIRED_SETTINGS.deliver_to).toBe('rss')
  })

  it('feed 地址给人看时只露末尾几位', () => {
    const masked = maskFeedUrl('https://www.google.com/alerts/feeds/1234567890/9876543210')
    expect(masked).toBe('www.google.com/…3210')
    expect(masked).not.toContain('1234567890')
    expect(maskFeedUrl('not a url at all')).toBe('… all')
  })
})
