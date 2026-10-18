import { describe, expect, it } from 'vitest'
import {
  BROWSER_WRITE_GUARDS,
  browserWriteGuardOf,
  GOOGLE_ALERT_CHANGE_FORM,
  GOOGLE_ALERTS_PAGE_URL,
  type RunRequest,
} from '../src/index.js'

describe('WP387 你的浏览器替你建 Google 提醒：契约', () => {
  it('Google 提醒页落在门禁里（带不带 www、子路径都算），别的 Google 页面不算', () => {
    expect(browserWriteGuardOf(GOOGLE_ALERTS_PAGE_URL)?.change_kind).toBe('google_alert_change')
    expect(browserWriteGuardOf('https://google.com/alerts?hl=en')).toBeDefined()
    expect(browserWriteGuardOf('https://www.google.com/alerts/manage?x=1')).toBeDefined()
    expect(browserWriteGuardOf('https://www.google.com/alertsfoo')).toBeUndefined()
    expect(browserWriteGuardOf('https://www.google.com/search?q=alerts')).toBeUndefined()
    expect(browserWriteGuardOf('https://news.google.com/alerts')).toBeUndefined()
    expect(browserWriteGuardOf('不是地址')).toBeUndefined()
    for (const g of BROWSER_WRITE_GUARDS) expect(g.reason).not.toBe('')
  })

  it('运行请求上的凭据是可选字段（老的运行记录没有它 = 一律拦）', () => {
    const grants: RunRequest['browser_grants'] = [
      { change_kind: 'google_alert_change', change_id: 'chg_1' },
    ]
    expect(grants?.[0]?.change_kind).toBe('google_alert_change')
    expect(GOOGLE_ALERT_CHANGE_FORM).toBe('google_alert_change')
  })
})
