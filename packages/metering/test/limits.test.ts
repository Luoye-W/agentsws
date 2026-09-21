import { describe, expect, it } from 'vitest'
import { LIMITS_FILE, limitsConsistent, serviceLimitById } from '../src/limits.js'

describe('官方托管的服务额度（limits.json）', () => {
  it('免费档官方转发每月 200 个对话（Luoye 09-19 定）', () => {
    expect(serviceLimitById('chat.conversations.monthly')?.value).toBe(200)
  })

  it('80% 提醒比例在表里', () => {
    expect(serviceLimitById('chat.quota.warn_ratio')?.value).toBeCloseTo(0.8)
  })

  it('自检：表里的数值全部对得上口径', () => {
    expect(limitsConsistent()).toEqual([])
  })

  it('认不出的 id 回 undefined（语义是「没有这条限制」，不是 0）', () => {
    expect(serviceLimitById('chat.conversations.daily')).toBeUndefined()
  })

  it('额度是数据不是代码：版本号与 as_of 在', () => {
    expect(LIMITS_FILE.version).toBe(1)
    expect(LIMITS_FILE.as_of).toBe('2026-09-21')
  })
})
