/**
 * WP117 / 66 断点 #1：**红人岗位不许回客服的话。**
 *
 * 这个文件钉住的就是那一条现象：「按这个品类在 YouTube 上找 20 个粉丝 1 万到 10 万的
 * 频道」交给 `kol.youtube`，stub 必须去调 `search_creators`，而不是去问退货窗口、
 * 也不能出一张「退款窗口」策略卡。
 */
import { describe, expect, it } from 'vitest'
import { createStubRuntime } from '../src/index.js'
import { makeRequest, runAndCollect } from './helpers.js'

const clock = { now: () => '2026-09-19T04:00:00.000Z' }

const FIND = '按这个品类在 YouTube 上找 20 个粉丝 1 万到 10 万的频道，按匹配度排给我'

/** 记下每次工具调用；回的 data 形状与服务端那一侧的 `KolPort` 对得上。 */
function recorder(replies: Record<string, unknown> = {}) {
  const calls: { name: string; input: Record<string, unknown> }[] = []
  return {
    calls,
    executeTool: async (call: { name: string; input: Record<string, unknown> }) => {
      calls.push({ name: call.name, input: call.input })
      const hit = replies[call.name]
      return hit === undefined
        ? { status: 'error' as const, reason: `unsupported_tool：这个进程没接「${call.name}」。` }
        : { status: 'ok' as const, data: hit }
    },
  }
}

describe('stub 的红人剧本', () => {
  it('找人：调 search_creators，不碰订单、不问退货窗口、不出策略卡', async () => {
    const rec = recorder({
      search_creators: {
        rows: [
          { id: 'cr_1', handle: 'gadgetjonas' },
          { id: 'cr_2', handle: 'techlisa' },
        ],
      },
    })
    let policyAsked = 0
    const runtime = createStubRuntime({
      clock,
      executeTool: rec.executeTool,
      createPolicyQuestion: async () => {
        policyAsked += 1
        return { approval_item_id: 'ap_should_not_happen' }
      },
      createDraft: async () => ({ approval_item_id: 'ap_should_not_happen_either' }),
    })
    const { events, result } = await runAndCollect(
      runtime,
      makeRequest({
        roleId: 'kol.youtube',
        threadSubject: '找一批 YouTube 红人',
        threadBody: FIND,
        allow: ['search_creators'],
        outputs: ['answer'],
      }),
    )

    expect(rec.calls.map((c) => c.name)).toEqual(['search_creators'])
    expect(rec.calls[0]?.input).toMatchObject({ channel: 'youtube', limit: 20 })
    // 客服那一半一步都没走
    expect(policyAsked).toBe(0)
    expect(events.some((e) => e.type === 'proposal.created')).toBe(false)
    expect(result.outputs.some((o) => o.kind === 'draft')).toBe(false)
    const answer = result.outputs.find((o) => o.kind === 'answer')
    expect(answer?.kind === 'answer' ? answer.text : '').toContain('找人')
    // 66 断点 #1 的反面：摘要里不许出现退货 / 退款那套词
    expect(result.summary).not.toMatch(/退货|退款|window/)
    expect(result.summary).toContain('找到 2 个候选')
    // 粉丝区间写进了给人看的那段话
    expect(answer?.kind === 'answer' ? answer.text : '').toContain('10,000–100,000')
  })

  it('起草开发信：先读人、再查政策、最后起草；卡的回执翻成 draft 输出', async () => {
    const rec = recorder({
      get_creator: { id: 'cr_1', handle: 'gadgetjonas' },
      search_policies: { rows: [] },
      draft_outreach: { approval_item_id: 'ap_out_1', kind: 'outbound_draft', creator_id: 'cr_1' },
    })
    const runtime = createStubRuntime({ clock, executeTool: rec.executeTool })
    const { events, result } = await runAndCollect(
      runtime,
      makeRequest({
        roleId: 'kol.youtube',
        threadSubject: '给这个频道起草一封开发信',
        threadBody: '给这个频道起草一封开发信：说清合作形式和寄样安排，不提具体报价',
        allow: ['get_creator', 'search_policies', 'draft_outreach'],
        outputs: ['draft', 'answer'],
        extraContext: [
          {
            id: 'pin_creator_cr_1',
            kind: 'summary',
            source_ref: { type: 'creator', id: 'cr_1' },
            sensitivity: 'internal',
            content: { id: 'cr_1', handle: 'gadgetjonas' },
            bytes: 64,
          },
        ],
      }),
    )

    expect(rec.calls.map((c) => c.name)).toEqual([
      'get_creator',
      'search_policies',
      'draft_outreach',
    ])
    expect(rec.calls[2]?.input).toMatchObject({ creator_id: 'cr_1', step: 'first' })
    const proposal = events.find((e) => e.type === 'proposal.created')
    expect(proposal).toMatchObject({ approval_item_id: 'ap_out_1', kind: 'outbound_draft' })
    expect(result.outputs).toContainEqual({ kind: 'draft', approval_item_id: 'ap_out_1' })
    expect(result.summary).toContain('起草了一封开发信（待批）')
  })

  it('工具没接上：照实说没成，不掩成成功（66 断点 #6、#7 的反面）', async () => {
    const runtime = createStubRuntime({ clock, executeTool: recorder({}).executeTool })
    const { result } = await runAndCollect(
      runtime,
      makeRequest({
        roleId: 'kol.instagram',
        threadSubject: '合作到哪一步了',
        threadBody: '几个合作分别到哪一步了',
        allow: ['list_collaborations'],
        outputs: ['answer'],
      }),
    )
    const answer = result.outputs.find((o) => o.kind === 'answer')
    const text = answer?.kind === 'answer' ? answer.text : ''
    expect(text).toContain('没成')
    expect(text).toContain('unsupported_tool')
    expect(result.status).toBe('completed')
  })

  it('一个工具执行器都没给：也不假装干了事', async () => {
    const runtime = createStubRuntime({ clock })
    const { result } = await runAndCollect(
      runtime,
      makeRequest({
        roleId: 'kol.tiktok',
        threadBody: '在 tiktok 上找 5 个人',
        allow: ['search_creators'],
        outputs: ['answer'],
      }),
    )
    const answer = result.outputs.find((o) => o.kind === 'answer')
    expect(answer?.kind === 'answer' ? answer.text : '').toContain('这个进程没接工具执行器')
  })

  it('客服那条职责一点没变（红人的岔口不许改客服的行为）', async () => {
    let drafted = 0
    const runtime = createStubRuntime({
      clock,
      createDraft: async () => {
        drafted += 1
        return { approval_item_id: 'ap_support' }
      },
    })
    const { result } = await runAndCollect(runtime, makeRequest({ outputs: ['draft'] }))
    expect(drafted).toBe(1)
    expect(result.outputs).toContainEqual({ kind: 'draft', approval_item_id: 'ap_support' })
  })
})
