/**
 * 47 J3 在运行时落地的两件事（三个运行时共用 `assemblePrompt`，所以断言只做一遍）：
 *
 * 1. **工具面按三组排**：查对象 → 查知识 → 提议动作。只换顺序，名字一个字不改。
 * 2. **"你能查什么、能做什么"从登记表生成**，不手写；那段固定话也在里面。
 *
 * 还有一条是纪律：它必须是纯函数——回放事件日志重组 prompt 要逐字节一致（17 §6.1）。
 */
import { ORDER_RULE } from '@agentsws/ontology'
import { describe, expect, it } from 'vitest'
import {
  assemblePrompt,
  assemblePromptHash,
  ontologyBriefOf,
  outputToolNames,
} from '../src/index.js'
import { makeRequest } from './helpers.js'

const ALLOW = ['shopify_admin.get_order', 'shopify_admin.list_orders', 'search_policies']

describe('47 J3 工具面按三组排列', () => {
  it('查对象在前、查知识在中、提议动作在后', () => {
    const { tools } = assemblePrompt(makeRequest({ allow: ALLOW }))
    const names = tools.map((t) => t.name)
    expect(names.indexOf('shopify_admin.get_order')).toBeLessThan(names.indexOf('search_policies'))
  })

  it('只换顺序，不换名字（工具集与 allowlist 逐个对得上）', () => {
    const req = makeRequest({ allow: ALLOW })
    const { tools } = assemblePrompt(req)
    expect([...tools.map((t) => t.name)].sort()).toEqual([...req.tools.allow].sort())
  })

  it('同一份请求两次装配，工具顺序逐字节相同（17 §6.2）', () => {
    const req = makeRequest({ allow: ALLOW })
    expect(assemblePrompt(req).tools).toEqual(assemblePrompt(req).tools)
  })
})

describe('47 J3 提示词里的"你能查什么、能做什么"', () => {
  const req = makeRequest({ allow: ALLOW, outputs: ['draft', 'staged_change'] })

  it('进了静态前缀，而且是从登记表生成的', () => {
    const { messages } = assemblePrompt(req)
    const brief = messages.map((m) => m.content).join('\n')
    expect(brief).toContain('能查')
    expect(brief).toContain('订单')
    expect(brief).toContain('事实卡')
  })

  it('那段固定话在里面：先查状态、再查政策、矛盾以状态为准并报出来', () => {
    expect(ontologyBriefOf(req)).toContain(ORDER_RULE)
  })

  it('产出工具算进"你能做什么"（它们不在 allowlist 里，但模型调得到）', () => {
    expect(outputToolNames(req)).toEqual(['draft_reply', 'stage_refund'])
    const brief = ontologyBriefOf(req)
    expect(brief).toContain('stage_refund')
    expect(brief).toContain('draft_reply')
  })

  it('纯函数：两次一样，且 prompt 哈希稳定（17 §6.1 回放铁律）', () => {
    expect(ontologyBriefOf(req)).toBe(ontologyBriefOf(req))
    expect(assemblePromptHash(req)).toBe(assemblePromptHash(req))
  })

  it('这次运行没摆出来的口，提示词里不许出现', () => {
    const narrow = makeRequest({ allow: ['shopify_admin.get_order'], outputs: ['answer'] })
    const brief = ontologyBriefOf(narrow)
    expect(brief).toContain('订单')
    expect(brief).not.toContain('事实卡')
    expect(brief).not.toContain('stage_refund')
  })

  it('persona 仍然是第一段（16 §2 complete 段没被挤走）', () => {
    const { messages } = assemblePrompt(req)
    expect(messages[0]?.role).toBe('system')
    expect(messages[0]?.content).toContain('##')
  })
})
