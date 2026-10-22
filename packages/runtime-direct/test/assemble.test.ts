import type { ContextItem, RunRequest } from '@agentsws/contracts'
import {
  assemblePromptHash,
  DRAFT_BODY_DESCRIPTION,
  DRAFT_TOOL_DESCRIPTION,
} from '@agentsws/stand-ins'
import { describe, expect, it } from 'vitest'
import {
  assembleDirect,
  DRAFT_REPLY_TOOL,
  outputToolDefs,
  STAGE_REFUND_TOOL,
} from '../src/index.js'
import { contextItem, makeRequest } from './helpers.js'

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

  it('换一条事项摘要 / 岗位状态不动静态前缀（缓存纪律，22 §2；WP472 换成真会变的那两条）', () => {
    const volatile = (summary: string, cards: string): RunRequest =>
      makeRequest({
        context: [
          ...makeRequest().context,
          contextItem({
            id: 'matter_m1',
            kind: 'matter_summary',
            source_ref: { type: 'matter', id: 'm1' },
            content: { summary },
          }),
          contextItem({
            id: 'position_kol',
            kind: 'summary',
            source_ref: { type: 'position', id: 'kol' },
            content: { panel: [{ label: '待你定的卡', value: cards }] },
          }),
        ],
      })
    const a = assembleDirect(volatile('查完了退货窗口', '1'))
    const b = assembleDirect(volatile('已经起草了回信', '3'))
    expect(b.static_prefix_hash).toBe(a.static_prefix_hash)
    // 不只是哈希：两次请求在变的那两条之前逐字一样，变的那两条走 user 层
    const firstDiff = a.messages.findIndex((m, i) => m.content !== b.messages[i]?.content)
    expect(a.messages[firstDiff]?.content).toMatch(/^\[matter_summary:/)
    expect(a.messages.slice(firstDiff).every((m) => m.role === 'user')).toBe(true)
    expect(JSON.stringify(a.tools)).toBe(JSON.stringify(b.tools))
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

  it('装配顺序（WP472）：静态前缀 + 政策（system）→ 历史 → 记录 → 事项摘要 → 岗位状态 → 设置 → app_events → 时间 → 这一次的话（user）', () => {
    const base = makeRequest().context
    const item = (id: string, kind: ContextItem['kind'], src?: ContextItem['source_ref']) =>
      contextItem({
        id,
        kind,
        content: `${id} body`,
        ...(src === undefined ? {} : { source_ref: src }),
      })
    // 故意按乱序给：装配只认那张表，不认请求里的先后
    const req = makeRequest({
      context: [
        item('now', 'time'),
        item('position_kol', 'summary', { type: 'position', id: 'kol' }),
        ...base,
        item('setup_state', 'summary'),
        item('app_events_1', 'app_events'),
        item('matter_m1', 'matter_summary'),
        item('history_m1', 'history'),
      ],
    })
    const { messages } = assembleDirect(req)
    const tags = messages.map(
      (m) => `${m.role}:${/^\[([a-z_]+:[^\]]+)\]/.exec(m.content)?.[1] ?? '-'}`,
    )
    expect(tags).toEqual([
      'system:-', // persona
      'system:-', // skills
      'system:-', // 登记表
      'system:policy:policy_workspace',
      'user:history:history_m1',
      'user:fact_card:fact_return_window',
      'user:customer:customer_cus_anna',
      'user:matter_summary:matter_m1',
      'user:summary:position_kol',
      'user:summary:setup_state',
      'user:app_events:app_events_1',
      'user:time:now',
      'user:thread:thr_1',
    ])
  })
})

describe('WP232：direct 的起草工具与 dsh 同一句', () => {
  it('描述同一份；收件人可不填；正文的参数说明写明跟来信语言、对用户的话不跟', () => {
    const draft = outputToolDefs(makeRequest()).find((d) => d.name === 'draft_reply')
    expect(draft?.description).toBe(DRAFT_TOOL_DESCRIPTION)
    const schema = draft?.input_schema as {
      required: string[]
      properties: Record<string, { description?: string }>
    }
    expect(schema.required).toEqual(['subject', 'body'])
    expect(schema.properties.body?.description).toBe(DRAFT_BODY_DESCRIPTION)
  })
})
