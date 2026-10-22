/**
 * WP472（docs/116 §4 / §6 A）：dsh 那一档实际送进网关的请求，缓存前缀稳不稳。
 *
 * 1. **跨运行**：同一条职责两次运行只换了每次都变的那几条（事项摘要、岗位状态、时间）——它们之前的每一条消息、
 *    工具定义逐字一样；变的那几条走 user 层（不进系统提示，DeepSeek 账号口不会把它们并进开头那段）。
 * 2. **同一运行里**：第 k 步的消息原样是第 k+1 步的开头（只往后加）。
 */
import type { ChatMessage, Completion, ContextItem, RunRequest, ToolDef } from '@agentsws/contracts'
import { describe, expect, it, vi } from 'vitest'
import { createDshRuntime, type ModelGatewayLike } from '../src/index.js'
import { baseOptions, brainGateway, collect, makeRequest } from './helpers.js'

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

interface Sent {
  messages: ChatMessage[]
  tools: ToolDef[]
}

const item = (
  id: string,
  kind: ContextItem['kind'],
  content: string,
  source_ref: ContextItem['source_ref'] = `src:${id}`,
): ContextItem => ({
  id,
  kind,
  source_ref,
  sensitivity: 'internal',
  content,
  bytes: Buffer.byteLength(content, 'utf8'),
})

/** 一次运行，记下每一步真正送进网关的消息与工具。 */
async function sentOf(req: RunRequest): Promise<Sent[]> {
  const sent: Sent[] = []
  const inner = brainGateway()
  const gateway: ModelGatewayLike = {
    async complete(r): Promise<Completion> {
      sent.push({ messages: structuredClone(r.messages), tools: structuredClone(r.tools ?? []) })
      return inner.complete(r)
    },
  }
  const runtime = createDshRuntime(baseOptions({ gateway }))
  const { sink } = collect()
  await runtime.run(req, sink, new AbortController().signal)
  return sent
}

function withVolatile(summary: string, cards: string, hour: string): RunRequest {
  const req = makeRequest()
  req.context.push(
    item('matter_m1', 'matter_summary', `这件事到哪了：${summary}`, { type: 'matter', id: 'm1' }),
    item('position_aftersales', 'summary', `待你定的卡：${cards}`, {
      type: 'position',
      id: 'aftersales',
    }),
    item('now', 'time', `现在是 2026-09-07 ${hour}:00 前后`),
  )
  return req
}

const text = (m: ChatMessage | undefined): string =>
  typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content)

describe('WP472 dsh：跨运行前缀逐字一致', () => {
  it('只换事项摘要 / 岗位状态 / 时间：它们之前的消息与工具逐字一样，变的那几条都在 user 层', async () => {
    const a = (await sentOf(withVolatile('查完了退货窗口', '1', '09')))[0]
    const b = (await sentOf(withVolatile('已经起草了回信', '4', '15')))[0]
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    if (a === undefined || b === undefined) return
    expect(JSON.stringify(b.tools)).toBe(JSON.stringify(a.tools))
    const firstDiff = a.messages.findIndex((m, i) => text(m) !== text(b.messages[i]))
    expect(firstDiff).toBeGreaterThan(0)
    // 第一处不同就是事项摘要那条；它之前的每一条逐字一样
    expect(text(a.messages[firstDiff])).toMatch(/^\[matter_summary:matter_m1\]/)
    expect(JSON.stringify(b.messages.slice(0, firstDiff))).toBe(
      JSON.stringify(a.messages.slice(0, firstDiff)),
    )
    // 变的那几条（摘要、岗位状态、时间）都不在系统提示那一层
    for (const tag of ['[matter_summary:', '[summary:position_', '[time:']) {
      const hit = a.messages.find((m) => text(m).startsWith(tag))
      expect(hit?.role, tag).toBe('user')
    }
    // 政策仍是系统提示（不变的规矩）
    expect(a.messages.find((m) => text(m).startsWith('[policy:'))?.role).toBe('system')
  })
})

describe('WP472 dsh：同一运行里只往后加', () => {
  it('第 k 步送出去的消息原样是第 k+1 步的开头', async () => {
    const sent = await sentOf(withVolatile('查完了退货窗口', '1', '09'))
    expect(sent.length).toBeGreaterThan(2)
    for (let k = 1; k < sent.length; k += 1) {
      const prev = sent[k - 1]?.messages ?? []
      const next = sent[k]?.messages ?? []
      expect(JSON.stringify(next.slice(0, prev.length)), `step ${k}`).toBe(JSON.stringify(prev))
      expect(JSON.stringify(sent[k]?.tools)).toBe(JSON.stringify(sent[0]?.tools))
    }
  })
})
