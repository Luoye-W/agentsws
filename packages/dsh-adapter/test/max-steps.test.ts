import { describe, expect, it } from 'vitest'
import { DEFAULT_MAX_STEPS, maxStepsFor } from '../src/index.js'

/** 09-24：挂了浏览器 / 电脑操控的运行，模型步数跟着工具调用上限走；普通运行仍是 8。 */
describe('maxStepsFor', () => {
  it('普通运行：8 步，与 direct-llm 同一个数', () => {
    expect(maxStepsFor({ budget: { max_tool_calls: 12 } })).toBe(DEFAULT_MAX_STEPS)
    expect(DEFAULT_MAX_STEPS).toBe(8)
  })
  it('挂了浏览器：工具上限 30 → 31 步', () => {
    expect(maxStepsFor({ browser: {}, budget: { max_tool_calls: 30 } })).toBe(31)
  })
  it('批过授权的电脑操控：工具上限 40 → 41 步', () => {
    expect(maxStepsFor({ computer_use: {}, budget: { max_tool_calls: 40 } })).toBe(41)
  })
  it('工具上限比 8 还小时不往下压', () => {
    expect(maxStepsFor({ browser: {}, budget: { max_tool_calls: 3 } })).toBe(DEFAULT_MAX_STEPS)
  })
})
