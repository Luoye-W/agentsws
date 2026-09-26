/**
 * WP153（09-26 真账号冒烟）：给人看的话里不露工具名；事项摘要说的是「这件事」本身。
 *
 * 冒烟原话：回答里是「我用 `search_policies` 查了三轮」，事项顶部摘要是「查了退货政策。」
 * （问的是岗位和连接）。这里钉住三件事：统一的「工具名 → 人话」表、回复第一句当摘要、
 * `search_policies` 的人话名是「规矩与政策库」而不只是退货政策。
 */
import { describe, expect, it } from 'vitest'
import {
  describeRun,
  humanizeToolNames,
  replyHeadline,
  stripMarkdown,
  TOOL_WORDS_ZH,
  toolWordZh,
} from '../src/index.js'

describe('工具名 → 人话（统一的一张表）', () => {
  it('冒烟那句：反引号包着的工具名换成人话，反引号一起去掉', () => {
    expect(humanizeToolNames('我用 `search_policies` 查了三轮')).toBe('我用「规矩与政策库」查了三轮')
  })

  it('带服务前缀、带括号的也认；更长的词不动', () => {
    expect(humanizeToolNames('先调 shopify.get_order() 再说')).toBe('先调「订单查询」再说')
    expect(humanizeToolNames('list_orders_by_day 不是工具')).toBe('list_orders_by_day 不是工具')
  })

  it('这次运行摆出来的、表里没有的工具，也不露名字', () => {
    expect(humanizeToolNames('调了 fetch_weather', ['fetch_weather'])).toBe('调了「一个工具」')
    expect(toolWordZh('fetch_weather')).toBe('一个工具')
  })

  it('店主两个新工具、红人工具、Dev MCP 都在表里', () => {
    expect(TOOL_WORDS_ZH.list_positions).toBe('岗位清单')
    expect(TOOL_WORDS_ZH.list_connections).toBe('连接清单')
    expect(TOOL_WORDS_ZH.search_creators).toBe('红人库')
    expect(toolWordZh('shopify.docs.search')).toBe('Shopify 官方文档')
  })

  it('英文句子里的空格留着', () => {
    expect(humanizeToolNames('I ran list_positions first')).toBe('I ran 「岗位清单」 first')
  })

  it('一般的英文与数字不受影响', () => {
    const text = 'Shopify 店铺 #1001 已经连上，e.g. GA4 还没连'
    expect(humanizeToolNames(text)).toBe(text)
  })
})

describe('回复第一句 → 摘要', () => {
  it('去 markdown、取第一句', () => {
    expect(
      replyHeadline('这个工作区有 **3 个岗位**、**2 条连接**。\n\n1. 先连 GA4\n2. 给红人岗位派人'),
    ).toBe('这个工作区有 3 个岗位、2 条连接。')
  })

  it('工具名换成人话、太长就截到一行', () => {
    const long = `我用 \`search_policies\` 查了三轮，${'很长的话'.repeat(30)}`
    const out = replyHeadline(long) ?? ''
    expect(out).not.toContain('search_policies')
    expect([...out].length).toBeLessThanOrEqual(60)
    expect(out.endsWith('…')).toBe(true)
  })

  it('空回复回 undefined；引子结尾的冒号去掉', () => {
    expect(replyHeadline('   \n  ')).toBeUndefined()
    expect(replyHeadline('## 我看了这几件事：\n- 岗位')).toBe('我看了这几件事')
  })

  it('stripMarkdown 只去记号不吞字', () => {
    expect(stripMarkdown('- **粗体** 与 `代码` 与 [链接](https://x.example)')).toBe('粗体 与 代码 与 链接')
  })
})

describe('describeRun（三个运行时同一份拼法）', () => {
  it('有给人的回复：摘要就是回复第一句，不是「查了退货政策」', () => {
    const summary = describeRun({
      readTools: ['search_policies'],
      drafted: false,
      reply: '这个工作区现在有 **3 个岗位**，其中 1 个还没人在岗。接下来……',
      tools: ['search_policies'],
    })
    expect(summary).toBe('这个工作区现在有 3 个岗位，其中 1 个还没人在岗。')
  })

  it('没有回复才退回「做了什么」；search_policies 的人话名是规矩与政策库', () => {
    expect(describeRun({ readTools: ['search_policies'], drafted: true })).toBe(
      '查了规矩与政策库，起草了回复。',
    )
  })

  it('失败 / 中断 / 预算耗尽仍然优先', () => {
    expect(describeRun({ readTools: [], drafted: false, reply: '好的', failed: '模型不可用' })).toBe(
      '这次没跑完：模型不可用。',
    )
    expect(
      describeRun({ readTools: [], drafted: false, reply: '好的', exhausted: 'max_tool_calls' }),
    ).toContain('预算不够')
  })
})
