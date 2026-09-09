import { describe, expect, it } from 'vitest'
import { healthUrl, parseHealthBody, probeHealth, waitForHealth } from '../src/health.js'
import { fakeFetch, response } from './fakes.js'

const envelope = (data: unknown): string => JSON.stringify({ data, trace_id: 't' })

describe('healthUrl', () => {
  it('去掉尾斜杠再拼', () => {
    expect(healthUrl('http://127.0.0.1:4317')).toBe('http://127.0.0.1:4317/v1/health')
    expect(healthUrl('http://127.0.0.1:4317//')).toBe('http://127.0.0.1:4317/v1/health')
  })
})

describe('parseHealthBody', () => {
  it('认 API 网关的 { data } 信封（28 §1）', () => {
    const snapshot = parseHealthBody(
      envelope({
        status: 'ok',
        at: '2026-09-09T00:00:00.000Z',
        version: '0.1.0',
        halt: { all: { on: false }, model: { on: false } },
        modules: [],
      }),
    )
    expect(snapshot).toEqual({
      ok: true,
      status: 'ok',
      version: '0.1.0',
      halted: false,
      at: '2026-09-09T00:00:00.000Z',
      error: undefined,
    })
  })

  it('裸 body 也认', () => {
    expect(parseHealthBody(JSON.stringify({ status: 'ok' })).ok).toBe(true)
  })

  it('任一档位打开就算 halted', () => {
    expect(
      parseHealthBody(envelope({ status: 'halted', halt: { all: { on: true } } })).halted,
    ).toBe(true)
    expect(parseHealthBody(envelope({ status: 'ok', halt: 'nope' })).halted).toBe(false)
    expect(parseHealthBody(envelope({ status: 'ok', halt: { all: null } })).halted).toBe(false)
  })

  it('版本 / 时间不是字符串就当没有', () => {
    const s = parseHealthBody(envelope({ status: 'ok', version: 1, at: 2 }))
    expect(s.version).toBeUndefined()
    expect(s.at).toBeUndefined()
  })

  it('坏 JSON / 没有 status 一律不 ok', () => {
    expect(parseHealthBody('{ nope')).toMatchObject({ ok: false, error: '响应不是合法 JSON' })
    expect(parseHealthBody('{"data":{}}')).toMatchObject({ ok: false, error: '响应里没有 status' })
    expect(parseHealthBody('null')).toMatchObject({ ok: false })
  })
})

describe('probeHealth', () => {
  it('200 → ok', async () => {
    const fetchImpl = fakeFetch(() => response(200, envelope({ status: 'ok' })))
    const snapshot = await probeHealth('http://127.0.0.1:4317', { fetchImpl })
    expect(snapshot.ok).toBe(true)
    expect(fetchImpl.calls).toEqual(['http://127.0.0.1:4317/v1/health'])
  })

  it('非 2xx → 带状态码的错误', async () => {
    const snapshot = await probeHealth('http://x', {
      fetchImpl: fakeFetch(() => response(503, '')),
    })
    expect(snapshot).toMatchObject({ ok: false, error: 'HTTP 503' })
  })

  it('连不上 → 错误信息', async () => {
    const snapshot = await probeHealth('http://x', {
      fetchImpl: () => Promise.reject(new Error('ECONNREFUSED')),
    })
    expect(snapshot.ok).toBe(false)
    expect(snapshot.error).toContain('ECONNREFUSED')
  })

  it('用注入的中断源做超时，结束时一定收工', async () => {
    let released = false
    const controller = new AbortController()
    await probeHealth('http://x', {
      fetchImpl: fakeFetch(() => response(200, envelope({ status: 'ok' }))),
      timeoutMs: 10,
      abort: () => ({
        signal: controller.signal,
        done: () => {
          released = true
        },
      }),
    })
    expect(released).toBe(true)
  })
})

describe('waitForHealth', () => {
  it('轮询到 ok 就停', async () => {
    let n = 0
    const slept: number[] = []
    const snapshot = await waitForHealth('http://x', {
      fetchImpl: fakeFetch(() => {
        n += 1
        return n < 3 ? response(503, '') : response(200, envelope({ status: 'ok' }))
      }),
      delayMs: 5,
      sleep: async (ms) => {
        slept.push(ms)
      },
    })
    expect(snapshot.ok).toBe(true)
    expect(slept).toEqual([5, 5])
  })

  it('次数用完返回最后一次结果，且最后一次不再睡', async () => {
    const slept: number[] = []
    const snapshot = await waitForHealth('http://x', {
      fetchImpl: fakeFetch(() => response(503, '')),
      attempts: 2,
      sleep: async (ms) => {
        slept.push(ms)
      },
    })
    expect(snapshot.ok).toBe(false)
    expect(slept).toHaveLength(1)
  })

  it('attempts 为 0 时返回"未探测"', async () => {
    const snapshot = await waitForHealth('http://x', {
      fetchImpl: fakeFetch(() => response(200, '')),
      attempts: 0,
      sleep: async () => undefined,
    })
    expect(snapshot.error).toBe('未探测')
  })
})
