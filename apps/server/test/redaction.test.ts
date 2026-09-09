/**
 * 39 待办 E：「问 AI」的 answer 也是一个输出通道，出口要过脱敏的统一入口。
 *
 * 「只回给本人」不等于「可以带着凭据回」——模型是从围栏里的客户原文抄出来的，
 * 那段原文里就可能有客户自己贴进来的授权码。
 */
import type { EventEnvelope } from '@agentsws/contracts'
import type { ModelGatewayApi } from '@agentsws/model-gateway'
import type { RoleStore } from '@agentsws/roles'
import { describe, expect, it } from 'vitest'
import { createAskPort } from '../src/ask.js'

const KEY = 'sk-4f9ab2c7d1e08356zq'
const MAIL = '授权码：abcdefghijklmnop'

/** 只实现 `complete`：ask 只用这一个方法。 */
function gatewayReturning(text: string): ModelGatewayApi {
  return {
    complete: async () => ({
      text,
      usage: { in_tokens: 1, out_tokens: 1, cached_tokens: 0, cost_base: 0 },
      ref: { provider: 'stub', model: 'stub-v1', region: 'cn' },
    }),
  } as unknown as ModelGatewayApi
}

/** ask 只问一句「这条 Assignment 是什么职责」。 */
const roles = { assignments: { get: () => undefined } } as unknown as RoleStore

describe('问 AI 的 answer 过出站脱敏（31 §3.3 / 39 待办 E）', () => {
  it('模型抄出来的 sk-… 与邮箱授权码都不回给人，哈希按脱敏后的正文算', async () => {
    const events: EventEnvelope[] = []
    const port = createAskPort({
      models: gatewayReturning(`他给的是 ${KEY}，还有${MAIL}`),
      roles,
      card: () => undefined,
      label: () => undefined,
      appendEvent: (e) => {
        events.push(e as EventEnvelope)
      },
    })
    const out = await port.ask(
      { workspace_id: 'ws_1', person_id: 'p_1', assignment_id: 'asg_1' },
      { scope: {}, question: '他的登录信息是什么' },
    )
    expect(out.answer).not.toContain(KEY)
    expect(out.answer).not.toContain('abcdefghijklmnop')
    expect(out.answer).toContain('[redacted:api_key]')
    expect(out.answer).toContain('[redacted:mail_app_password]')

    // 21 §5：日志里只有哈希；而且是**脱敏后**那一份的哈希，否则审计对不上人看到的东西
    const logged = events.find((e) => e.type === 'ask.answered')
    expect(logged).toBeDefined()
    const payload = logged?.payload as { answer_hash: string }
    expect(payload.answer_hash).toBe(out.answer_hash)
    expect(JSON.stringify(logged)).not.toContain(KEY)
  })

  it('干净的答案一个字节都不改', async () => {
    const port = createAskPort({
      models: gatewayReturning('订单 #1042 已经在 9 月 2 日签收。'),
      roles,
      card: () => undefined,
      label: () => undefined,
      appendEvent: () => {},
    })
    const out = await port.ask(
      { workspace_id: 'ws_1', person_id: 'p_1', assignment_id: 'asg_1' },
      { scope: {}, question: '签收了吗' },
    )
    expect(out.answer).toBe('订单 #1042 已经在 9 月 2 日签收。')
  })
})
