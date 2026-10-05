/**
 * WP236：子进程档「没动静才停」——空闲超时 + 总时长上限，取消带原因。
 *
 * 真机（10-06 Windows）：Reddit 研究任务正干着活，60 秒固定总时长一到就被静默 `run.cancelled`。
 * 这里用真子进程替身，时间按比例缩小（真实口径见 contracts 的看门狗测试：每 10 秒一个事件、
 * 总长 2 分钟不被停；静默 3 分钟才停）。
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RunEvent } from '@agentsws/contracts'
import { describe, expect, it, vi } from 'vitest'
import { BRIDGE_PROTOCOL_VERSION, createSubprocessDshRuntime } from '../src/index.js'
import { baseOptions, collect, makeRequest } from './helpers.js'

vi.setConfig({ testTimeout: 60_000 })

const NO_ABORT = (): AbortSignal => new AbortController().signal

/**
 * 替身子进程：收到 run 后每 `tickMs` 推一条 progress 事件，跑满 `totalMs` 再答 run；
 * `tickMs = 0` = 一条都不推、也不答（卡死）。收到 cancel 就答空。
 */
function fakeChild(tickMs: number, totalMs: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentsws-wp236-'))
  const entry = join(dir, 'child.js')
  writeFileSync(
    entry,
    `
let buf = ''
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => {
  buf += c
  let i = buf.indexOf('\\n')
  while (i >= 0) {
    const msg = JSON.parse(buf.slice(0, i))
    buf = buf.slice(i + 1)
    if (msg.method === 'agentsws/hello') {
      send({ jsonrpc: '2.0', id: msg.id, result: { protocol: ${BRIDGE_PROTOCOL_VERSION}, runtime: 'dsh', capabilities: {} } })
    } else if (msg.method === 'agentsws/cancel' || msg.method === 'agentsws/shutdown') {
      send({ jsonrpc: '2.0', id: msg.id, result: {} })
      if (msg.method === 'agentsws/shutdown') setTimeout(() => process.exit(0), 5)
    } else if (msg.method === 'agentsws/run' && ${tickMs} > 0) {
      const token = msg.params.token
      const id = msg.id
      const req = msg.params.request
      let n = 0
      send({ jsonrpc: '2.0', method: 'agentsws/event', params: { token, event: { type: 'run.started', request_id: req.id, runtime: 'dsh', model: req.runtime.model } } })
      const t = setInterval(() => {
        n += 1
        send({ jsonrpc: '2.0', method: 'agentsws/event', params: { token, event: { type: 'progress', step: 'tick', note: String(n) } } })
      }, ${tickMs})
      setTimeout(() => {
        clearInterval(t)
        const usage = { input_tokens: 0, output_tokens: 0, cached_tokens: 0, tool_calls: 0, seconds: 0, cost_base: 0 }
        send({ jsonrpc: '2.0', method: 'agentsws/event', params: { token, event: { type: 'run.completed', usage, outputs: [], summary: '做完了' } } })
        send({ jsonrpc: '2.0', id, result: { ok: true, result: {
          request_id: req.id, status: 'completed', outputs: [],
          provenance: { run_id: req.id, seen: {}, read_full: [], recorded_at: msg.params.now },
          memory_candidates: [], lessons: [], usage,
          session_ref: { runtime: 'dsh', session_id: 'sub_' + req.id }, summary: '做完了',
        } } })
      }, ${totalMs})
    }
    i = buf.indexOf('\\n')
  }
})
`,
    'utf8',
  )
  return entry
}

const cancelled = (events: RunEvent[]) =>
  events.find((e): e is Extract<RunEvent, { type: 'run.cancelled' }> => e.type === 'run.cancelled')

describe('WP236 子进程档：没动静才停', () => {
  it('一直有事件就不停：每 100ms 一个事件、总长 1.5 秒，空闲线 500ms 也跑得完', async () => {
    const runtime = createSubprocessDshRuntime({
      ...baseOptions(),
      mode: 'subprocess',
      childEntry: fakeChild(100, 1_500),
      idleTimeoutMs: 500,
      maxDurationMs: 10_000,
    })
    const { sink, events } = collect()
    const result = await runtime.run(makeRequest(), sink, NO_ABORT())
    expect(result.status).toBe('completed')
    expect(cancelled(events)).toBeUndefined()
    expect(events.filter((e) => e.type === 'progress').length).toBeGreaterThan(5)
  })

  it('不再是固定 60 秒：缺省总时长 20 分钟、空闲 3 分钟（不给就照缺省，不会 1.5 秒内停）', async () => {
    const runtime = createSubprocessDshRuntime({
      ...baseOptions(),
      mode: 'subprocess',
      childEntry: fakeChild(200, 1_500),
    })
    const { sink, events } = collect()
    const result = await runtime.run(makeRequest(), sink, NO_ABORT())
    expect(result.status).toBe('completed')
    expect(cancelled(events)).toBeUndefined()
  })

  it('一个事件都没有、空闲线到了才停，run.cancelled 带 idle_timeout', async () => {
    const runtime = createSubprocessDshRuntime({
      ...baseOptions(),
      mode: 'subprocess',
      childEntry: fakeChild(0, 0),
      idleTimeoutMs: 400,
      maxDurationMs: 10_000,
    })
    const { sink, events } = collect()
    const started = Date.now()
    const result = await runtime.run(makeRequest(), sink, NO_ABORT())
    expect(Date.now() - started).toBeGreaterThanOrEqual(380)
    expect(result.status).toBe('cancelled')
    expect(cancelled(events)?.reason).toBe('idle_timeout')
    expect(result.summary).toContain('太久没有动静')
  })

  it('一直忙但跑满总时长 → max_duration', async () => {
    const runtime = createSubprocessDshRuntime({
      ...baseOptions(),
      mode: 'subprocess',
      childEntry: fakeChild(50, 5_000),
      idleTimeoutMs: 400,
      maxDurationMs: 800,
    })
    const { sink, events } = collect()
    const result = await runtime.run(makeRequest(), sink, NO_ABORT())
    expect(result.status).toBe('cancelled')
    expect(cancelled(events)?.reason).toBe('max_duration')
    expect(events.filter((e) => e.type === 'progress').length).toBeGreaterThan(3)
  })

  it('老名字 subprocessTimeoutMs 仍当总时长用（模拟 realistic 档）', async () => {
    const runtime = createSubprocessDshRuntime({
      ...baseOptions(),
      mode: 'subprocess',
      childEntry: fakeChild(50, 5_000),
      subprocessTimeoutMs: 600,
    })
    const { sink, events } = collect()
    const result = await runtime.run(makeRequest(), sink, NO_ABORT())
    expect(result.status).toBe('cancelled')
    expect(cancelled(events)?.reason).toBe('max_duration')
  })
})
