#!/usr/bin/env node
/**
 * 假的 dsh SDK runtime：只说 `@deepseek-ai/dsh-sdk-protocol` 的线协议，不跑模型。
 *
 * 契约测试用它钉住 SDK 的 `run()` / `subscribe()` 事件形状（17 §4 的第六个 seam）：
 * 真 runtime 需要模型 key 才能起，而我们要钉的是**协议**，不是模型。
 * 升级 dsh 后若线协议变了（方法名、通知名、`agent/inbox/spliced` 收据、idle 结束条件），
 * 这个假 runtime 立刻对不上，测试红。
 */
import { createInterface } from 'node:readline'

const send = (obj) => {
  process.stdout.write(`${JSON.stringify(obj)}\n`)
}
const notify = (method, params) => send({ jsonrpc: '2.0', method, params })

let seq = 0

createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim() === '') return
  let frame
  try {
    frame = JSON.parse(line)
  } catch {
    return
  }
  if (frame.method === undefined || frame.id === undefined) return
  if (frame.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: frame.id,
      result: { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.1.3-alpha.2' } },
    })
    return
  }
  if (frame.method === 'session/prompt') {
    seq += 1
    const messageId = `msg_${seq}`
    const sessionId = frame.params.sessionId
    send({ jsonrpc: '2.0', id: frame.id, result: { messageId } })
    // 收据：SDK 的 run() 从这条开始计入本次 activity interval
    notify('session.event', {
      sessionId,
      event: { type: 'agent/inbox/spliced', data: { inserted: [{ id: messageId }] } },
    })
    notify('session.status', { sessionId, status: 'running' })
    notify('session.event', {
      sessionId,
      event: {
        type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text: 'fake runtime reply' }] } },
      },
    })
    notify('session.status', { sessionId, status: 'idle' })
    return
  }
  if (frame.method === 'shutdown') {
    send({ jsonrpc: '2.0', id: frame.id, result: {} })
    return
  }
  send({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'method not found' } })
})
