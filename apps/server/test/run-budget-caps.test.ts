import { describe, expect, it } from 'vitest'
import { runBudgetCaps } from '../src/runtime.js'

describe('runBudgetCaps', () => {
  it('缺省 6 万 token、12 次', () => {
    expect(runBudgetCaps({ themeRun: false, granted: false, browsing: false })).toEqual({
      max_tokens: 60_000,
      max_tool_calls: 12,
    })
  })
  it('浏览器 / 网页工具 30 次，电脑操控授权 40 次', () => {
    expect(runBudgetCaps({ themeRun: false, granted: false, browsing: true }).max_tool_calls).toBe(
      30,
    )
    expect(runBudgetCaps({ themeRun: false, granted: true, browsing: true }).max_tool_calls).toBe(
      40,
    )
  })
  it('10-07 真机：网页模板（主题工具）40 万 token、60 次', () => {
    expect(runBudgetCaps({ themeRun: true, granted: false, browsing: false })).toEqual({
      max_tokens: 400_000,
      max_tool_calls: 60,
    })
  })
})
