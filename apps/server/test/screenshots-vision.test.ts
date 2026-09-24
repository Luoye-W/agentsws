/**
 * WP147（截图给 AI 看）：服务进程这一侧只决定一件事——这次运行的模型要不要向 dsh 那条路由
 * **声明图片输入**。只认 WP127 三步验证的结论，而且验证的正是这次运行的这个模型。
 */
import type { ModelRef } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { declaresImageInput } from '../src/runtime.js'

const current: ModelRef = { provider: 'prov_1', model: 'deepseek-flash', region: 'cn' }

describe('declaresImageInput：三步验证没过的来源不声明图片输入', () => {
  it('验证过能看图、而且就是这个模型 → 声明', () => {
    expect(declaresImageInput('ok', current, { ...current })).toBe(true)
  })

  it('看不了（no）/ 没验证过（unchecked）/ 没接 → 不声明', () => {
    expect(declaresImageInput('no', current, current)).toBe(false)
    expect(declaresImageInput('unchecked', current, current)).toBe(false)
    expect(declaresImageInput(undefined, current, current)).toBe(false)
  })

  it('换了模型（验证的不是这一个）→ 不声明', () => {
    expect(declaresImageInput('ok', current, { ...current, model: 'deepseek-v4-pro' })).toBe(false)
    expect(declaresImageInput('ok', current, { ...current, provider: 'prov_2' })).toBe(false)
    expect(declaresImageInput('ok', undefined, current)).toBe(false)
  })
})
