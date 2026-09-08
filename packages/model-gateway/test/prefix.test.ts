import type { ChatMessage, ToolDef } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  createModelGateway,
  GatewayError,
  staticPrefixHash,
  staticPrefixLength,
  stubProvider,
  truncateToHour,
} from '../src/index.js'
import { fixedClock, meta, policy, recorder, systemPrompt, userPrompt } from './helpers.js'

const tools: ToolDef[] = [
  { name: 'orders.get', description: 'read one order', input_schema: { type: 'object' } },
]

/** 17 §1 装配顺序：静态前缀（persona + skills 索引 + 工具定义）→ 策略层 → 工作项上下文 → 用户消息。 */
const assemble = (personaText: string, userText: string): ChatMessage[] => [
  systemPrompt(personaText),
  systemPrompt('skills: refund_policy@1.2, tone@0.4'),
  systemPrompt(`policy snapshot at ${truncateToHour('2026-09-09T10:41:37.123Z')}`),
  userPrompt(userText),
]

describe('22 §5.2 静态前缀稳定', () => {
  it('同一 RunRequest 两次装配，静态前缀哈希相同', () => {
    const a = assemble('company.md + persona', 'where is my order')
    const b = assemble('company.md + persona', 'a different question entirely')
    expect(staticPrefixHash(a, tools)).toBe(staticPrefixHash(b, tools))
  })

  it('改一条 system 消息后哈希不同', () => {
    const a = assemble('company.md + persona', 'q')
    const b = assemble('company.md + persona (edited)', 'q')
    expect(staticPrefixHash(a, tools)).not.toBe(staticPrefixHash(b, tools))
  })

  it('工具定义属于静态前缀', () => {
    const a = assemble('p', 'q')
    expect(staticPrefixHash(a, tools)).not.toBe(staticPrefixHash(a, []))
  })

  it('默认断点 = 开头连续的 system 消息数；显式断点可覆盖', () => {
    const a = assemble('p', 'q')
    expect(staticPrefixLength(a)).toBe(3)
    expect(staticPrefixLength(a, [1])).toBe(1)
    expect(staticPrefixHash(a, tools, [1])).not.toBe(staticPrefixHash(a, tools))
    expect(() => staticPrefixLength(a, [9])).toThrow(GatewayError)
  })

  it('truncateToHour 把时间戳截到小时，让前缀在一小时内字节稳定', () => {
    expect(truncateToHour('2026-09-09T10:41:37.123Z')).toBe('2026-09-09T10:00:00Z')
    expect(truncateToHour('2026-09-09T10:00:00Z')).toBe('2026-09-09T10:00:00Z')
    expect(() => truncateToHour('not-a-time')).toThrow(GatewayError)
  })

  it('网关返回 static_prefix_hash，同一前缀第二次调用 cached_tokens > 0', async () => {
    const rec = recorder()
    const gw = createModelGateway({
      providers: [stubProvider({ seed: 7 })],
      policy: policy(),
      clock: fixedClock(),
      eventSink: rec.sink,
      env: {},
    })
    const first = await gw.complete({ messages: assemble('p', 'q1'), tools, meta: meta() })
    const second = await gw.complete({ messages: assemble('p', 'q2'), tools, meta: meta() })
    expect(second.static_prefix_hash).toBe(first.static_prefix_hash)
    expect(first.usage.cached_tokens).toBe(0)
    expect(second.usage.cached_tokens).toBeGreaterThan(0)
    expect(rec.ofType('model.usage')).toHaveLength(2)
  })

  it('stub 输出对同一输入 + seed 可重复', async () => {
    const p = stubProvider({ seed: 7 })
    const q = stubProvider({ seed: 7 })
    const r = stubProvider({ seed: 8 })
    const messages = assemble('p', 'q')
    const a = await p.complete({ messages })
    const b = await q.complete({ messages })
    const c = await r.complete({ messages })
    expect(a.text).toBe(b.text)
    expect(a.text).not.toBe(c.text)
  })
})
