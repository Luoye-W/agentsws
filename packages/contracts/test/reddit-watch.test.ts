import { describe, expect, it } from 'vitest'
import { REDDIT_WATCH_VERDICT_ZH, redditWeekWindow } from '../src/index.js'

describe('Reddit 一周窗口（周日 00:00 本地 — 现在）', () => {
  it('东八区周五 17:00 → 本周日 00:00', () => {
    // 2026-10-16 是周五；东八区 17:00 = 09:00Z
    const w = redditWeekWindow('2026-10-16T09:00:00.000Z', 480)
    expect(w.since).toBe('2026-10-10T16:00:00.000Z') // 10-11 周日 00:00 +08:00
    expect(w.until).toBe('2026-10-16T09:00:00.000Z')
  })
  it('本地已是周日凌晨：从当天 00:00 起', () => {
    // 东八区 10-18 周日 01:00 = 10-17 17:00Z
    expect(redditWeekWindow('2026-10-17T17:00:00.000Z', 480).since).toBe('2026-10-17T16:00:00.000Z')
  })
  it('评估判断的中文与周报一致', () => {
    expect(REDDIT_WATCH_VERDICT_ZH.no_action).toBe('日常讨论无需处理')
  })
})
