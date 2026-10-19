/**
 * WP426（Luoye 10-19 beta.3 截图）：AI 钮清单收短、能力小标只标例外（纯函数）。
 */
import { describe, expect, it } from 'vitest'
import type { FreeChatModelChoice } from '@/lib/free-chat'
import {
  aliasKey,
  capabilityMarks,
  compactChoices,
  isExperimentalModel,
} from '@/lib/model-picker-compact'

const c = (id: string, extra: Partial<FreeChatModelChoice> = {}): FreeChatModelChoice => ({
  id,
  label: 'x',
  official: id.startsWith('agentsws/'),
  vision: 'ok',
  ...extra,
})

describe('WP426 清单收短', () => {
  const workshop = [
    c('agentsws/deepseek-flash'),
    c('agentsws/deepseek-v4-flash'),
    c('agentsws/deepseek-v4-pro'),
    c('agentsws/deepseek-v4-flash-vision-exp'),
  ]

  it('实验 / 预览型号不进；别名与带版本号的同一个只留一个（留默认那个）', () => {
    const out = compactChoices(workshop, new Set(['agentsws/deepseek-flash']))
    expect(out.map((x) => x.id)).toEqual(['agentsws/deepseek-flash', 'agentsws/deepseek-v4-pro'])
  })

  it('当前选着的是带版本号那个：留它，别名收掉；实验型号选着也留着', () => {
    const out = compactChoices(
      workshop,
      new Set(['agentsws/deepseek-v4-flash', 'agentsws/deepseek-v4-flash-vision-exp']),
    )
    expect(out.map((x) => x.id)).toEqual([
      'agentsws/deepseek-v4-flash',
      'agentsws/deepseek-v4-pro',
      'agentsws/deepseek-v4-flash-vision-exp',
    ])
  })

  it('两个都带版本号（v4 与 v4.1）不合并；不同来源的同名不合并', () => {
    const out = compactChoices(
      [c('a/deepseek-v4-flash'), c('a/deepseek-v4.1-flash'), c('b/deepseek-flash')],
      new Set(),
    )
    expect(out).toHaveLength(3)
    expect(aliasKey('a/deepseek-v4.1-flash')).toBe('a/deepseek-flash')
  })

  it('认得出的实验 / 预览段', () => {
    for (const id of ['x/gpt-5-preview', 'x/m-exp', 'x/m-experimental-2', 'x/m-beta'])
      expect(isExperimentalModel(id), id).toBe(true)
    for (const id of ['x/gpt-5.5', 'x/deepseek-v4-pro', 'x/expert-1'])
      expect(isExperimentalModel(id), id).toBe(false)
  })
})

describe('WP426 能力小标只标例外', () => {
  it('人人都能看图：不逐行写「看图」；只有一个看不了：只标它', () => {
    expect(capabilityMarks([c('a/1'), c('a/2'), c('a/3')], 200_000).noVision).toBe(false)
    const marks = capabilityMarks([c('a/1'), c('a/2'), c('a/3', { vision: 'no' })], 200_000)
    expect(marks.noVision).toBe(true)
  })

  it('自带联网 / 长上下文：多数都有就不标，少数有才标', () => {
    const all = [1, 2, 3].map((i) => c(`a/${i}`, { native_search: true, context_window: 300_000 }))
    expect(capabilityMarks(all, 200_000)).toMatchObject({ web: false, long: false })
    const one = [c('a/1', { native_search: true, context_window: 300_000 }), c('a/2'), c('a/3')]
    expect(capabilityMarks(one, 200_000)).toMatchObject({ web: true, long: true })
  })
})
