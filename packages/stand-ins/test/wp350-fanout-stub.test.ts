/**
 * WP350：替身的拆法（demo 云替身与模拟世界用）——一行一条，按岗位名认，确定性。
 */
import { describe, expect, it } from 'vitest'
import { ASSISTANT_FANOUT_TOOL, ASSISTANT_TOOL_NAMES, stubFanoutDraft } from '../src/index.js'

const notes = [
  '# 10-16 周会',
  '- 网站运营：把 A 商品的详情页卖点更新一下，周五前',
  '- Reddit 运营：回复昨天那条差评帖',
  '- 客服：整理一版退货话术',
  '- 客服记住：退货期统一 30 天',
  '- 网站运营记住：运费一律满 50 包邮',
  '- 品牌语气统一偏轻松',
  '- 我喜欢周报用表格',
  '- 大家辛苦了',
].join('\n')

describe('stubFanoutDraft', () => {
  it('拆出要做的事 / 要记的口径 / 个人偏好，按岗位名认', () => {
    const out = stubFanoutDraft(notes, ['网站运营', 'Reddit 运营', '客服'])
    expect(out.title).toBe('10-16 周会')
    expect(out.items.map((i) => [i.kind, i.position ?? '-'])).toEqual([
      ['task', '网站运营'],
      ['task', 'Reddit 运营'],
      ['task', '客服'],
      ['note', '客服'],
      ['note', '网站运营'],
      ['note', '品牌'],
      ['memory', '-'],
    ])
    expect(out.items[0]?.due).toBe('周五前')
    expect(out.items[0]?.text).toBe('把 A 商品的详情页卖点更新一下，周五前')
    expect(out.items[3]?.quote).toBe('客服记住：退货期统一 30 天')
  })

  it('同输入同输出；工具名在助理工具里', () => {
    expect(stubFanoutDraft(notes, ['客服'])).toEqual(stubFanoutDraft(notes, ['客服']))
    expect(ASSISTANT_TOOL_NAMES).toContain(ASSISTANT_FANOUT_TOOL)
  })
})
