/**
 * WP441：stub 运行时的**一句话写消息规则**剧本——「Shopify 结算通知打标签记到表里别烦我」「推销的都告诉我」
 * → 调一次 propose_message_rule（出「要建吗」卡，不直接生效），回话说一行白话与试跑几封；别的问法照旧。
 */
import { describe, expect, it } from 'vitest'
import {
  createStubRuntime,
  MESSAGE_RULE_TOOL_NAMES,
  messageRuleBranch,
  RECORD_SINK_TOOL_NAMES,
} from '../src/index.js'
import { makeRequest, runAndCollect } from './helpers.js'

const clock = { now: () => '2026-10-22T04:00:00.000Z' }

const req = (text: string, allow: readonly string[] = MESSAGE_RULE_TOOL_NAMES) =>
  makeRequest({
    roleId: 'common.owner',
    threadSubject: text,
    threadBody: text,
    allow: [...allow],
    outputs: ['answer'],
  })

describe('stub 的消息规则剧本', () => {
  it('一句话 → 调 propose_message_rule、递原话；回话说试跑几封、去卡上点「建」，不露工具名', async () => {
    const calls: { name: string; input: unknown }[] = []
    const runtime = createStubRuntime({
      clock,
      executeTool: async (call) => {
        calls.push({ name: call.name, input: call.input })
        return {
          status: 'ok',
          data: {
            ok: true,
            name: 'Shopify 结算通知',
            plain:
              'shopify.com 发来、主题含「payout」 → 只是通知、不烦你、打标签「账单与发票」、记到「财务表」',
            matched: 14,
            sample: ['Your payout of $120 is on its way'],
            changed: 3,
            card: true,
          },
        }
      },
    })
    const said = 'Shopify 结算通知打标签记到表里别烦我'
    const { result } = await runAndCollect(runtime, req(said))
    expect(calls).toEqual([{ name: 'propose_message_rule', input: { instruction: said } }])
    const answer = result.outputs.find((o) => o.kind === 'answer')
    const text = answer?.kind === 'answer' ? answer.text : ''
    expect(text).toContain('过去 30 天会命中 14 封，其中 3 封会改掉去向')
    expect(text).toContain('点「建」才生效')
    expect(text).not.toMatch(/propose_message_rule/)
  })

  it('岔口：像在给一类来信定规矩才走；工具面没有、贴了表格链接、闲聊都不走', () => {
    expect(messageRuleBranch(req('推销的都告诉我'), '推销的都告诉我')?.tool).toBe(
      'propose_message_rule',
    )
    expect(messageRuleBranch(req('推销的都告诉我', []), '推销的都告诉我')).toBeUndefined()
    const link = '以后每封回复记到这张表 https://x.feishu.cn/base/abc 别烦我'
    expect(
      messageRuleBranch(req(link, [...MESSAGE_RULE_TOOL_NAMES, ...RECORD_SINK_TOOL_NAMES]), link),
    ).toBeUndefined()
    expect(messageRuleBranch(req('今天的广告花了多少'), '今天的广告花了多少')).toBeUndefined()
  })
})
