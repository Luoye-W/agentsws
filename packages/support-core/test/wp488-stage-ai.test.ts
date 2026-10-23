/**
 * WP488（决策 1700 / 1704）：售前 / 售后由 AI 判——提示词与认回话。
 */
import { describe, expect, it } from 'vitest'
import {
  parseStageAnswer,
  parseStageBatch,
  stageBatchPrompt,
  stageQuestionPrompt,
} from '../src/index.js'

describe('一封信售前还是售后', () => {
  it('提示词短、来信过围栏、截长', () => {
    const p = stageQuestionPrompt(`Where is my order?${' x'.repeat(5000)}`)
    expect(p.length).toBeLessThan(1700)
    expect(p).toContain('ONE word')
  })
  it('认一个词（容忍大小写、标点、废话）；拿不准 / 两个都说 = 判不出', () => {
    expect(parseStageAnswer('Postsales.')).toBe('postsales')
    expect(parseStageAnswer(' presales ')).toBe('presales')
    expect(parseStageAnswer('pre-sales')).toBe('presales')
    expect(parseStageAnswer('unclear')).toBeUndefined()
    expect(parseStageAnswer('presales or postsales')).toBeUndefined()
  })
})

describe('一批条目各归哪一份', () => {
  it('同序、认不得的给公共；长度对不上整批不认', () => {
    expect(stageBatchPrompt(['a', 'b'])).toContain('数组长度 = 条数（2）')
    expect(parseStageBatch('{"stages":["presales","x","postsales"]}', 3)).toEqual([
      'presales',
      'both',
      'postsales',
    ])
    expect(parseStageBatch('{"stages":["presales"]}', 2)).toBeUndefined()
    expect(parseStageBatch('不是 JSON', 1)).toBeUndefined()
  })
})
