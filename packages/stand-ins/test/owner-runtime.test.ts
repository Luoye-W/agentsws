/**
 * WP153（09-26 真账号冒烟 §3）：stub 运行时的**店主剧本**。
 *
 * 店主问「有哪些岗位和连接、先处理哪三件事」：去调两个只读工具、说人话（粗体 / 列表 / 编号）、
 * 排出最该先处理的三件事；摘要是回话的第一句。别的职责、别的问法照旧。
 */
import { describe, expect, it } from 'vitest'
import {
  assemblePrompt,
  createStubRuntime,
  OWNER_TOOL_NAMES,
  ownerPriorities,
  renderOwnerAnswer,
} from '../src/index.js'
import { makeRequest, runAndCollect } from './helpers.js'

const clock = { now: () => '2026-09-26T04:00:00.000Z' }
const ASK = '帮我看看有哪些岗位和连接，最该先处理哪三件事'

const POSITIONS = {
  positions: [
    {
      name: '客服',
      duties: ['网站客服'],
      holders: [{ name: '小林', range: '1 个店铺', has_range: true }],
      staffed: true,
    },
    { name: '红人营销', duties: ['YouTube 红人'], holders: [], staffed: false },
  ],
}
const CONNECTIONS = {
  connected: [
    { name: 'Shopify 店铺', state: 'connected' },
    { name: '邮箱', state: 'error', note: '要重新授权' },
  ],
  missing: [{ name: 'GA4', required: true, needed_by: ['网站运营'] }],
}

function recorder() {
  const calls: string[] = []
  return {
    calls,
    executeTool: async (call: { name: string }) => {
      calls.push(call.name)
      if (call.name === 'list_positions') return { status: 'ok' as const, data: POSITIONS }
      if (call.name === 'list_connections') return { status: 'ok' as const, data: CONNECTIONS }
      return { status: 'error' as const, reason: 'unsupported_tool' }
    },
  }
}

describe('stub 的店主剧本', () => {
  it('调两个只读工具；回话有真岗位 / 连接名、有粗体与编号、没有工具名；摘要是这件事本身', async () => {
    const rec = recorder()
    const runtime = createStubRuntime({ clock, executeTool: rec.executeTool })
    const { result } = await runAndCollect(
      runtime,
      makeRequest({
        roleId: 'common.owner',
        threadSubject: ASK,
        threadBody: ASK,
        allow: [...OWNER_TOOL_NAMES],
        outputs: ['answer'],
      }),
    )
    expect(rec.calls).toEqual(['list_positions', 'list_connections'])
    const answer = result.outputs.find((o) => o.kind === 'answer')
    const text = answer?.kind === 'answer' ? answer.text : ''
    for (const name of ['客服', '红人营销', 'Shopify 店铺', 'GA4', '小林'])
      expect(text).toContain(name)
    expect(text).toContain('**')
    expect(text).toMatch(/\n1\. .+\n2\. .+\n3\. /)
    expect(text).not.toMatch(/list_positions|list_connections/)
    expect(result.summary).toBe('这个工作区现在有 2 个岗位，1 条连接已接上，还差 1 条必需的连接。')
    expect(result.outputs.some((o) => o.kind === 'draft')).toBe(false)
  })

  it('三件事的先后：出错的连接 → 缺的必需连接 → 没人在岗的岗位', () => {
    expect(ownerPriorities(POSITIONS, CONNECTIONS as never)).toEqual([
      '把「邮箱」重新接一次——要重新授权，用它的活现在都停着。',
      '把「GA4」连上——网站运营职责要它才能开工。',
      '给没人在岗的岗位安排人：「红人营销」——这些岗位的活现在没人接。',
    ])
  })

  it('缺的必需连接最多占两件，第三件留给别的挡路的事；长名单只列三个', () => {
    const many = {
      connected: [],
      missing: ['店铺后台', 'Shopify 店铺', '邮箱'].map((name) => ({
        name,
        required: true,
        needed_by: ['网站客服', '订单履约', '店铺管理', '邮件营销'],
      })),
    }
    const out = ownerPriorities(POSITIONS, many)
    expect(out).toHaveLength(3)
    expect(out[0]).toBe('把「店铺后台」连上——网站客服、订单履约、店铺管理等 4 条职责要它才能开工。')
    expect(out[2]).toContain('没人在岗')
  })

  it('读不到的一半照实说，不编', () => {
    const text = renderOwnerAnswer({
      positions: POSITIONS,
      failed: { list_connections: '这一步没走通' },
    })
    expect(text).toContain('连接清单没读到：这一步没走通')
    expect(text).not.toContain('已接上')
  })

  it('别的职责问同一句，不走这一边（不调这两个工具）', async () => {
    const rec = recorder()
    const runtime = createStubRuntime({ clock, executeTool: rec.executeTool })
    await runAndCollect(
      runtime,
      makeRequest({ roleId: 'dtc.support', threadBody: ASK, allow: ['search_policies'] }),
    )
    expect(rec.calls).not.toContain('list_positions')
    expect(rec.calls).not.toContain('list_connections')
  })

  it('两个工具在提示词里的描述是人话，不是占位描述', () => {
    const { tools } = assemblePrompt(
      makeRequest({ roleId: 'common.owner', allow: [...OWNER_TOOL_NAMES] }),
    )
    const positions = tools.find((t) => t.name === 'list_positions')
    expect(positions?.description).toContain('岗位')
    expect(positions?.description).not.toContain('stand-in tool')
  })
})
