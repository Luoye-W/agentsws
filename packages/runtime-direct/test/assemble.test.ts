import { assemblePromptHash } from '@agentsws/stand-ins'
import { describe, expect, it } from 'vitest'
import {
  assembleDirect,
  DRAFT_REPLY_TOOL,
  outputToolDefs,
  STAGE_REFUND_TOOL,
} from '../src/index.js'
import { makeRequest } from './helpers.js'

describe('装配（17 §1）', () => {
  it('静态前缀两次装配逐字节相同（17 §6.2）', () => {
    const req = makeRequest()
    const a = assembleDirect(req)
    const b = assembleDirect(structuredClone(req))
    expect(a.static_prefix_hash).toBe(b.static_prefix_hash)
    expect(JSON.stringify(a.messages)).toBe(JSON.stringify(b.messages))
    expect(JSON.stringify(a.tools)).toBe(JSON.stringify(b.tools))
  })

  it('改一条 persona 段 → 静态前缀哈希变了', () => {
    const req = makeRequest()
    const before = assembleDirect(req).static_prefix_hash
    const changed = makeRequest({
      persona: {
        sections: [
          ...req.persona.sections.slice(0, 1),
          { id: 'role', name: 'aftersales', order: 20, text: '改了一个字。' },
        ],
      },
    })
    expect(assembleDirect(changed).static_prefix_hash).not.toBe(before)
  })

  it('换一条上下文项不动静态前缀（缓存纪律，22 §2）', () => {
    const req = makeRequest()
    const before = assembleDirect(req).static_prefix_hash
    const other = makeRequest({
      context: [
        ...req.context.slice(0, 3),
        {
          id: 'thr_1',
          kind: 'thread',
          source_ref: { type: 'thread', id: 'thr_1' },
          sensitivity: 'internal',
          content: { subject: '别的主题', text: '别的正文' },
          bytes: 40,
        },
      ],
    })
    expect(assembleDirect(other).static_prefix_hash).toBe(before)
  })

  it('prompt.assembled.hash 就是回放重组用的那个式子', () => {
    const req = makeRequest()
    expect(assembleDirect(req).hash).toBe(assemblePromptHash(req))
  })

  it('产出工具按 expectations 挂载，名字排序稳定', () => {
    const both = outputToolDefs(makeRequest())
    expect(both.map((t) => t.name)).toEqual([DRAFT_REPLY_TOOL, STAGE_REFUND_TOOL])

    const answerOnly = outputToolDefs(
      makeRequest({
        expectations: { outputs: ['answer'], must_stage_if_change_requested: false },
      }),
    )
    expect(answerOnly).toHaveLength(0)

    const draftOnly = outputToolDefs(
      makeRequest({
        expectations: { outputs: ['draft'], must_stage_if_change_requested: false },
      }),
    )
    expect(draftOnly.map((t) => t.name)).toEqual([DRAFT_REPLY_TOOL])
  })

  it('工具表 = allowlist 里的工具 + 产出工具', () => {
    const { tools } = assembleDirect(makeRequest())
    expect(tools.map((t) => t.name)).toEqual([
      'get_order',
      'list_orders',
      'search_policies',
      DRAFT_REPLY_TOOL,
      STAGE_REFUND_TOOL,
    ])
  })

  it('装配顺序：策略层 → 其他上下文 → app_events → 用户消息', () => {
    const req = makeRequest()
    const withEvents = makeRequest({
      context: [
        ...req.context.slice(0, 3),
        {
          id: 'app_events_1',
          kind: 'app_events',
          source_ref: 'app_events:thr_1',
          sensitivity: 'internal',
          content: '[App events since your last reply: refund applied]',
          bytes: 48,
        },
        ...req.context.slice(3),
      ],
    })
    const { messages } = assembleDirect(withEvents)
    const bodies = messages.map((m) => `${m.role}:${m.content.slice(0, 24)}`)
    const appIdx = bodies.findIndex((b) => b.includes('[app_events:'))
    const threadIdx = bodies.findIndex((b) => b.includes('[thread:'))
    const policyIdx = bodies.findIndex((b) => b.includes('[policy:'))
    expect(policyIdx).toBeGreaterThan(1) // 前两条是静态前缀（persona / skills）
    expect(policyIdx).toBeLessThan(appIdx)
    expect(appIdx).toBeLessThan(threadIdx)
    expect(messages[threadIdx]?.role).toBe('user')
  })
})
