/**
 * WP230：「把工具调用写成了文字」的判定（direct / dsh 两个运行时读同一份）。
 */
import { describe, expect, it } from 'vitest'
import { looksLikeToolCallText, TOOL_CALL_TEXT_NUDGE } from '../src/index.js'

describe('looksLikeToolCallText', () => {
  it('10-05 实测那三行（我们以前回放时写的形状）认得出', () => {
    const text = [
      '[calling search_policies {"query":"influencer payment terms"}]',
      '[calling search_creators {"query":"tech"}]',
      '[calling list_collaborations {}]',
    ].join('\n')
    expect(looksLikeToolCallText(text)).toBe(true)
    // 前面有一句话、后面才是假调用，同样认
    expect(looksLikeToolCallText('Let me check.\n[calling get_order {"order_id":"o1"}]')).toBe(true)
  })

  it('别家常见的伪格式也认', () => {
    for (const text of [
      '<tool_call>\n{"name":"get_order","arguments":{"order_id":"o1"}}\n</tool_call>',
      '<function_calls><invoke name="get_order"></invoke></function_calls>',
      '<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>get_order',
      '<|tool_call|>get_order',
      '{"function_call": {"name": "get_order", "arguments": "{}"}}',
      '{"tool_calls": [{"function": {"name": "get_order"}}]}',
    ]) {
      expect(looksLikeToolCallText(text), text).toBe(true)
    }
  })

  it('正常回复不误伤', () => {
    for (const text of [
      '',
      '   ',
      'Hi Anna, thanks for reaching out — your refund of $120 has been submitted for approval.',
      '我查了「规矩与政策库」，退货窗口是 14 天，可以退。',
      'Feel free to [call us] any time, or reply to this email.',
      'We are calling the courier today to arrange a pickup.',
      '- [x] 已查订单\n- [ ] 等你确认退款',
      '工具调用（tool call）这一步我已经做完了。',
    ]) {
      expect(looksLikeToolCallText(text), text).toBe(false)
    }
  })

  it('提示语本身不被判成假调用（重试那一轮不会自己绊自己）', () => {
    expect(looksLikeToolCallText(TOOL_CALL_TEXT_NUDGE)).toBe(false)
  })
})
