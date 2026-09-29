/**
 * WP195：运营后台登录页左上那枚标记改成**待机**那一张（自己会动，系统「少一点动效」时自己停）。
 * 标记取 `@agentsws/brand` 的常量，不在这里另画一版。
 */
import { BRAND_MARK_SVG_DARK, BRAND_MARK_SVG_IDLE_DARK } from '@agentsws/brand'
import { describe, expect, it } from 'vitest'
import { adminLoginPage } from '../src/admin/pages.js'

describe('后台登录页的标记', () => {
  it('两种状态都嵌着品牌包那张待机 SVG，不是静态那张', () => {
    for (const state of ['idle', 'sent'] as const) {
      const html = adminLoginPage(state)
      expect(html).toContain(BRAND_MARK_SVG_IDLE_DARK)
      expect(html).not.toContain(BRAND_MARK_SVG_DARK)
      expect(html).toContain('prefers-reduced-motion: reduce')
    }
  })
})
