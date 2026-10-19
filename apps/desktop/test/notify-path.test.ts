import { describe, expect, it } from 'vitest'
import { notificationPathOf } from '../src/notify-path.js'

describe('WP429 系统通知点了去哪', () => {
  it('只认工作台里的地址', () => {
    expect(notificationPathOf('/settings/connections')).toBe('/settings/connections')
    expect(notificationPathOf('/assistant?peers=1')).toBe('/assistant?peers=1')
    expect(notificationPathOf('/settings/account#credits')).toBe('/settings/account#credits')
  })
  it('外面的地址、协议、// 开头、控制字符、不是字符串的都不认', () => {
    for (const bad of [
      'https://evil.example',
      '//evil.example',
      'javascript:alert(1)',
      '',
      '/\\evil',
      '/a\nb',
      42,
      undefined,
    ])
      expect(notificationPathOf(bad)).toBeUndefined()
  })
})
