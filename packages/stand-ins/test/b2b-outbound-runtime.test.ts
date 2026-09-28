/**
 * WP176：stub 运行时的**主动开发剧本**——问起草 / 开一轮 → 先列序列再开一轮（出卡不发）；
 * 问进度 → 列序列；问回信 → 列序列并说清回信是收件时自动分的。别的职责、别的问法照旧。
 */
import { describe, expect, it } from 'vitest'
import {
  assemblePrompt,
  B2B_OUTBOUND_TOOL_NAMES,
  b2bOutboundBranch,
  createStubRuntime,
  renderB2bOutboundAnswer,
} from '../src/index.js'
import { makeRequest, runAndCollect } from './helpers.js'

const clock = { now: () => '2026-09-28T04:00:00.000Z' }
const DRAFT = '给这批名单起草三封开发信（第 0 / 3 / 7 天），不写价格与交期'

const SEQ = {
  funnel: [
    { label: '排着', count: 3 },
    { label: '待批', count: 0 },
  ],
  needs: ['还没选发信邮箱'],
  rows: [],
  cooling: [{ name: 'Peak（Mia）', until: '2026-12-27T00:00:00.000Z', count: 1 }],
}
const STARTED = {
  status: 'queued',
  message: '先在卡上选用哪只邮箱发（强烈建议单独的发信域名）。',
  picked: 0,
  queued_tomorrow: 0,
  approval_item_id: 'apv_1',
  excluded: [{ name: 'Jan', company: 'Nordlicht', label: '德国 / 奥地利默认不发' }],
}

const req = (text: string, role = 'b2b.outbound') =>
  makeRequest({
    roleId: role,
    threadSubject: text,
    threadBody: text,
    allow: [...B2B_OUTBOUND_TOOL_NAMES],
    outputs: ['answer'],
  })

describe('stub 的主动开发剧本', () => {
  it('起草开发信：先列序列、再开一轮；回话说清出了卡、谁没放进来、冷却到哪天，不露工具名', async () => {
    const calls: string[] = []
    const runtime = createStubRuntime({
      clock,
      executeTool: async (call) => {
        calls.push(call.name)
        if (call.name === 'list_outreach_sequences') return { status: 'ok', data: SEQ }
        if (call.name === 'start_outreach_round') return { status: 'ok', data: STARTED }
        return { status: 'error', reason: 'unsupported_tool' }
      },
    })
    const { result } = await runAndCollect(runtime, req(DRAFT))
    expect(calls).toEqual(['list_outreach_sequences', 'start_outreach_round'])
    const answer = result.outputs.find((o) => o.kind === 'answer')
    const text = answer?.kind === 'answer' ? answer.text : ''
    expect(text).toContain('先在卡上选用哪只邮箱发')
    expect(text).toContain('Nordlicht（Jan）')
    expect(text).toContain('2026-12-27')
    expect(text).not.toMatch(/list_outreach_sequences|start_outreach_round/)
    expect(result.outputs.some((o) => o.kind === 'draft')).toBe(false)
  })

  it('岔口：问进度只列、问回信只列并说明；别的职责 / 工具面里没有就不走', () => {
    expect(b2bOutboundBranch(req('开发信序列到哪了'), '开发信序列到哪了')).toEqual([
      'list_outreach_sequences',
    ])
    expect(b2bOutboundBranch(req('发一批开发信'), '发一批开发信')).toEqual([
      'list_outreach_sequences',
      'start_outreach_round',
    ])
    expect(b2bOutboundBranch(req('漏斗现在怎样'), '漏斗现在怎样')).toEqual([
      'list_outreach_sequences',
    ])
    expect(b2bOutboundBranch(req('分一下回信'), '分一下回信')).toEqual(['list_outreach_sequences'])
    expect(b2bOutboundBranch(req(DRAFT, 'b2b.sales'), DRAFT)).toBeUndefined()
    expect(b2bOutboundBranch(req('今天天气'), '今天天气')).toBeUndefined()
    const text = renderB2bOutboundAnswer({ sequences: SEQ as never, replies: true })
    expect(text).toContain('排着 3')
    expect(text).toContain('收件时自动分的')
  })

  it('工具定义是写给模型的人话（开一轮写明不直接发信）', () => {
    const { tools } = assemblePrompt(req(DRAFT))
    const start = tools.find((t) => t.name === 'start_outreach_round')
    expect(start?.description).toContain('不会直接发信')
    expect(tools.find((t) => t.name === 'classify_outreach_reply')?.description).toContain('只判')
  })
})
