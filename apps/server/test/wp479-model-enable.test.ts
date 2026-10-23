/**
 * WP479（决策 1625）：模型勾选启用的规则——系列怎么认、每条线哪一版最新、首次默认勾哪些、新模型怎么记。
 *
 * 夹具 = Luoye 10-23 截图里 ChatGPT 订阅那一串（也是 pi-ai 现在的 openai-codex 目录）。
 */
import { describe, expect, it } from 'vitest'
import {
  defaultEnabledModels,
  freshModels,
  latestPerSeries,
  type ModelEnableEntry,
  noteNewModels,
  pendingNotice,
  seriesOf,
} from '../src/model-enable.js'

const CHATGPT = [
  'gpt-5.3-codex-spark',
  'gpt-5.5',
  'gpt-5.6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-6-astra',
  'gpt-6-luna',
  'gpt-6-sol',
  'gpt-6.1-sol',
]

describe('系列', () => {
  it('GPT：Astra / Luna / Sol / Terra 各一条，Codex Spark 一条，不带后缀的一条', () => {
    expect(seriesOf('gpt-5.6-luna')).toMatchObject({ key: 'gpt-luna', version: [5, 6] })
    expect(seriesOf('gpt-6-luna')).toMatchObject({ key: 'gpt-luna', version: [6] })
    expect(seriesOf('gpt-6.1-sol')).toMatchObject({ key: 'gpt-sol', version: [6, 1] })
    expect(seriesOf('gpt-5.3-codex-spark')).toMatchObject({
      key: 'gpt-codex-spark',
      version: [5, 3],
    })
    expect(seriesOf('gpt-5.5')).toMatchObject({ key: 'gpt', version: [5, 5] })
  })

  it('Claude：Opus / Sonnet / Haiku 各一条，新老两种写法、日期快照都认', () => {
    expect(seriesOf('claude-opus-4-5-20251101')).toEqual({
      key: 'claude-opus',
      version: [4, 5],
      date: 20251101,
    })
    expect(seriesOf('claude-3-opus-20240229')).toMatchObject({ key: 'claude-opus', version: [3] })
    expect(seriesOf('claude-sonnet-4-6')).toMatchObject({ key: 'claude-sonnet', version: [4, 6] })
    expect(seriesOf('claude-haiku-4-5')).toMatchObject({ key: 'claude-haiku' })
  })

  it('别的几家：DeepSeek、Qwen、Gemini、o 系列、带日期的 GPT 快照', () => {
    expect(seriesOf('deepseek-v4-flash')).toMatchObject({ key: 'deepseek-flash', version: [4] })
    expect(seriesOf('deepseek-v4.1-pro')).toMatchObject({ key: 'deepseek-pro', version: [4, 1] })
    expect(seriesOf('qwen3.7-plus')).toMatchObject({ key: 'qwen-plus', version: [3, 7] })
    expect(seriesOf('gemini-3.8-flash')).toMatchObject({ key: 'gemini-flash', version: [3, 8] })
    expect(seriesOf('o4-mini')).toMatchObject({ key: 'o-mini', version: [4] })
    expect(seriesOf('gpt-4o-2024-08-06')).toMatchObject({ key: 'gpt-4o', date: 20240806 })
    expect(seriesOf('deepseek-chat')).toMatchObject({ key: 'deepseek-chat', version: [] })
  })
})

describe('每条线最新那一版', () => {
  it('截图那一串：勾 Codex Spark、5.5、5.6 Terra、6 Astra、6 Luna、6.1 Sol', () => {
    expect(latestPerSeries(CHATGPT)).toEqual([
      'gpt-5.3-codex-spark',
      'gpt-5.5',
      'gpt-5.6-terra',
      'gpt-6-astra',
      'gpt-6-luna',
      'gpt-6.1-sol',
    ])
  })

  it('版本一样时不带日期的别名优先；都带日期取近的', () => {
    expect(latestPerSeries(['claude-opus-4-5-20251101', 'claude-opus-4-5'])).toEqual([
      'claude-opus-4-5',
    ])
    expect(latestPerSeries(['gpt-4o-2024-05-13', 'gpt-4o-2024-08-06'])).toEqual([
      'gpt-4o-2024-08-06',
    ])
    expect(
      latestPerSeries(['claude-3-opus-20240229', 'claude-opus-4-5', 'claude-sonnet-4-6']),
    ).toEqual(['claude-opus-4-5', 'claude-sonnet-4-6'])
  })
})

describe('首次默认勾', () => {
  it('正在用的旧模型照样勾上（升级后跑着的不断）', () => {
    expect(defaultEnabledModels(CHATGPT, new Set(['gpt-5.6-sol']))).toEqual([
      'gpt-5.3-codex-spark',
      'gpt-5.5',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-6-astra',
      'gpt-6-luna',
      'gpt-6.1-sol',
    ])
  })
})

describe('新模型', () => {
  const entry = (): ModelEnableEntry => ({
    enabled: ['gpt-6-sol'],
    seen: ['gpt-5.5', 'gpt-6-sol'],
    notified: ['gpt-5.5', 'gpt-6-sol'],
  })

  it('多出来的记进提醒（同一批合成一条），不自动勾；标「新」直到看过', () => {
    const e = entry()
    expect(noteNewModels(e, ['gpt-5.5', 'gpt-6-sol', 'gpt-6.1-sol'], 'T1')).toBe(true)
    expect(e.enabled).toEqual(['gpt-6-sol'])
    expect(e.notice).toEqual({ models: ['gpt-6.1-sol'], at: 'T1' })
    // 再来一个：合进同一条（还没看过的那个留着）
    expect(noteNewModels(e, ['gpt-5.5', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-6.1-luna'], 'T2')).toBe(
      true,
    )
    expect(e.notice).toEqual({ models: ['gpt-6.1-sol', 'gpt-6.1-luna'], at: 'T2' })
    // 同一份目录再对一遍：没有变化，不再提醒
    expect(noteNewModels(e, ['gpt-6.1-sol', 'gpt-6.1-luna'], 'T3')).toBe(false)
    expect(freshModels(['gpt-6-sol', 'gpt-6.1-sol', 'gpt-6.1-luna'], e)).toEqual([
      'gpt-6.1-sol',
      'gpt-6.1-luna',
    ])
    expect(pendingNotice(e, ['gpt-6.1-sol'])).toEqual(['gpt-6.1-sol'])
  })

  it('人自己点的拉取：标「新」，但不进铃铛', () => {
    const e = entry()
    expect(noteNewModels(e, ['gpt-6-sol', 'gpt-7'], 'T1', true)).toBe(true)
    expect(e.notice).toBeUndefined()
    expect(freshModels(['gpt-6-sol', 'gpt-7'], e)).toEqual(['gpt-7'])
  })

  it('看过了：提醒里就没有了', () => {
    const e = entry()
    noteNewModels(e, ['gpt-6-sol', 'gpt-7'], 'T1')
    e.seen = [...e.seen, 'gpt-7']
    expect(pendingNotice(e, ['gpt-6-sol', 'gpt-7'])).toEqual([])
  })
})
