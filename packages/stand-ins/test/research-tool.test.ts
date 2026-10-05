/**
 * WP220：只读 Reddit（`read_reddit`）的工具定义——挂了它的运行，工具面里的描述是人话（不是占位），
 * 而且写清两路取数、只读、没取到不是 0 条；没挂的运行里根本没有这个名字。
 */
import { describe, expect, it } from 'vitest'
import { assemblePrompt, READ_REDDIT_TOOL, RESEARCH_TOOL_NAMES } from '../src/index.js'
import { makeRequest } from './helpers.js'

describe('WP220 read_reddit 的工具定义', () => {
  it('挂了才有；描述是人话：两路、只读、没取到不是 0 条', () => {
    const req = makeRequest({
      roleId: 'pr.monitoring',
      allow: [READ_REDDIT_TOOL],
      outputs: ['answer'],
    })
    const def = assemblePrompt(req).tools.find((t) => t.name === READ_REDDIT_TOOL)
    expect(def?.description).toContain('接口中台 → 浏览器只读')
    expect(def?.description).toContain('不发帖、不回帖')
    expect(def?.description).toContain('不是「0 条」')
    expect(def?.input_schema).toMatchObject({ required: ['action'] })
    const none = makeRequest({ roleId: 'dtc.support', allow: [], outputs: ['answer'] })
    expect(assemblePrompt(none).tools.find((t) => t.name === READ_REDDIT_TOOL)).toBeUndefined()
    expect(RESEARCH_TOOL_NAMES).toEqual(['read_reddit'])
  })
})
