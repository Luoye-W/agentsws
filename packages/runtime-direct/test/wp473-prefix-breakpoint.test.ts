/**
 * WP473（docs/116 §4）：岗位运行在静态前缀（岗位说明 + 技能索引 + 登记表）之后打断点，
 * 每次补全都交给网关——前缀指纹只算这几条，后面每次都变的上下文（事项摘要、岗位状态……）不混进来。
 */
import type { ModelGatewayApi } from '@agentsws/model-gateway'
import { staticPrefixHash } from '@agentsws/model-gateway'
import { runStaticPrefixCount } from '@agentsws/stand-ins'
import { describe, expect, it } from 'vitest'
import { assembleDirect } from '../src/index.js'
import { clock, contextItem, gatewayOf, harness, makeRequest } from './helpers.js'

const withSummary = (text: string) => {
  const req = makeRequest()
  return makeRequest({
    context: [
      ...req.context.slice(0, 1),
      // 事项摘要每轮重写；装配层级由 WP472 定，这里只要求它不进指纹
      contextItem({ id: 'matter_summary_m1', kind: 'policy', content: { summary: text } }),
      ...req.context.slice(1),
    ],
  })
}

describe('WP473 岗位运行的缓存断点', () => {
  it('断点 = 静态前缀条数；指纹只算断点之前', () => {
    const a = assembleDirect(withSummary('第一轮：客人要退货'))
    const b = assembleDirect(withSummary('第二轮：客人改成换货'))
    const n = runStaticPrefixCount(makeRequest())
    expect(a.cache_breakpoints).toEqual([n])
    expect(a.messages.slice(0, n).every((m) => m.role === 'system')).toBe(true)
    // 断点之后的系统消息变了，指纹不变
    expect(a.static_prefix_hash).toBe(b.static_prefix_hash)
    expect(a.static_prefix_hash).toBe(staticPrefixHash(a.messages, a.tools, [n]))
    // 不给断点（开头连续的系统消息）就会把这条每次都变的摘要算进去
    expect(staticPrefixHash(a.messages, a.tools)).not.toBe(staticPrefixHash(b.messages, b.tools))
  })

  it('每一次补全都把断点交给网关', async () => {
    const c = clock()
    const seen: (number[] | undefined)[] = []
    const base = gatewayOf(
      [
        { tool_calls: [{ name: 'get_order', input: { order_id: 'ord_1001' } }] },
        { text: 'The charger can go back within 14 days.' },
      ],
      c,
    )
    const gateway = new Proxy(base, {
      get(target, prop) {
        if (prop === 'complete')
          return (req: Parameters<ModelGatewayApi['complete']>[0]) => {
            seen.push(req.cache_breakpoints)
            return target.complete(req)
          }
        const v = Reflect.get(target, prop) as unknown
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v
      },
    })
    const h = harness({ script: [], clock: c, gateway, toolChoice: false })
    await h.run(makeRequest())
    const n = runStaticPrefixCount(makeRequest())
    expect(seen.length).toBeGreaterThanOrEqual(2)
    expect(seen.every((b) => JSON.stringify(b) === JSON.stringify([n]))).toBe(true)
  })
})
