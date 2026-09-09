import { describe, expect, it, vi } from 'vitest'
import { backoffDelay, DEFAULT_BACKOFF } from '../src/backoff.js'
import { silentLogger } from '../src/logging.js'
import type { SpawnRequest } from '../src/ports.js'
import { createLineSplitter, createSidecar, type SidecarSnapshot } from '../src/sidecar.js'
import { fakeClock, fakeSpawner, fakeTimers } from './fakes.js'

describe('backoffDelay', () => {
  it('指数增长并封顶', () => {
    expect(backoffDelay(1)).toBe(500)
    expect(backoffDelay(2)).toBe(1000)
    expect(backoffDelay(3)).toBe(2000)
    expect(backoffDelay(20)).toBe(DEFAULT_BACKOFF.maxMs)
  })

  it('attempt < 1 按 1 算', () => {
    expect(backoffDelay(0)).toBe(500)
    expect(backoffDelay(-3)).toBe(500)
  })

  it('抖动经注入的 random，确定性可测', () => {
    expect(backoffDelay(1, { jitter: 0.5 }, () => 0)).toBe(375)
    expect(backoffDelay(1, { jitter: 0.5 }, () => 1)).toBe(625)
    expect(backoffDelay(1, { jitter: 0.5 }, () => 0.5)).toBe(500)
  })

  it('不传 random 时用内置的（等价于取抖动区间下沿）', () => {
    expect(backoffDelay(1, { jitter: 0.5 })).toBe(375)
  })

  it('抖动也不越过上限', () => {
    expect(backoffDelay(50, { jitter: 1 }, () => 1)).toBe(DEFAULT_BACKOFF.maxMs)
  })
})

describe('createLineSplitter', () => {
  it('攒到换行才吐一整行，忽略空行与 \\r', () => {
    const lines: string[] = []
    const feed = createLineSplitter((line) => lines.push(line))
    feed('ab')
    feed('c\r\nde')
    feed('f\n\ng\n')
    expect(lines).toEqual(['abc', 'def', 'g'])
  })
})

const request: SpawnRequest = { command: '/bin/node', args: ['server.js'], env: {} }

function setup(options: Partial<Parameters<typeof createSidecar>[0]> = {}) {
  const spawner = fakeSpawner()
  const timers = fakeTimers()
  const clock = fakeClock()
  const snapshots: SidecarSnapshot[] = []
  const output: [string, string][] = []
  const sidecar = createSidecar({
    name: 'server',
    request: () => request,
    spawner,
    timers,
    clock,
    logger: silentLogger(),
    stableAfterMs: 1000,
    onOutput: (stream, line) => output.push([stream, line]),
    ...options,
  })
  sidecar.subscribe((s) => snapshots.push(s))
  return { spawner, timers, clock, sidecar, snapshots, output }
}

describe('createSidecar', () => {
  it('start → starting → running（稳定后失败计数清零）', () => {
    const { sidecar, timers, spawner } = setup()
    expect(sidecar.snapshot().state).toBe('stopped')
    sidecar.start()
    expect(sidecar.snapshot()).toMatchObject({ state: 'starting', pid: 1000, attempts: 0 })
    expect(spawner.requests).toHaveLength(1)
    timers.runAll()
    expect(sidecar.snapshot().state).toBe('running')
    expect(sidecar.snapshot().startedAt).toBe('2026-09-09T00:00:00.000Z')
  })

  it('已经在跑时 start 是空操作', () => {
    const { sidecar, spawner } = setup()
    sidecar.start()
    sidecar.start()
    expect(spawner.requests).toHaveLength(1)
  })

  it('崩溃后按退避重启，重试成功后计数清零', () => {
    const { sidecar, timers, spawner } = setup({ backoff: { baseMs: 100, factor: 2 } })
    sidecar.start()
    timers.runAll() // 稳定
    spawner.children[0]?.exit(1)
    expect(sidecar.snapshot()).toMatchObject({ state: 'backoff', attempts: 1, retryInMs: 100 })
    expect(sidecar.snapshot().lastExit).toMatchObject({ code: 1, signal: null })
    timers.runNext() // 触发重启
    expect(spawner.requests).toHaveLength(2)
    expect(sidecar.snapshot().state).toBe('starting')
    timers.runAll()
    expect(sidecar.snapshot()).toMatchObject({ state: 'running', attempts: 0 })
  })

  it('连续崩溃时退避越来越长', () => {
    const { sidecar, timers, spawner } = setup({ backoff: { baseMs: 100, factor: 3 } })
    sidecar.start()
    spawner.children[0]?.exit(1)
    expect(sidecar.snapshot().retryInMs).toBe(100)
    timers.runNext()
    spawner.children[1]?.exit(1)
    expect(sidecar.snapshot()).toMatchObject({ attempts: 2, retryInMs: 300 })
  })

  it('超过 maxAttempts 转 failed，之后的退出不再重启', () => {
    const { sidecar, timers, spawner } = setup({ maxAttempts: 1, backoff: { baseMs: 10 } })
    sidecar.start()
    spawner.children[0]?.exit(1)
    expect(sidecar.snapshot().state).toBe('backoff')
    timers.runNext()
    spawner.children[1]?.exit(1)
    expect(sidecar.snapshot()).toMatchObject({ state: 'failed', attempts: 2 })
    expect(timers.pending()).toBe(0)
  })

  it('spawn 本身抛错也走退避', () => {
    const { sidecar, spawner } = setup({ backoff: { baseMs: 50 } })
    spawner.failNext(new Error('ENOENT'))
    sidecar.start()
    expect(sidecar.snapshot()).toMatchObject({ state: 'backoff', attempts: 1, retryInMs: 50 })
    expect(sidecar.snapshot().lastExit).toMatchObject({ code: null })
  })

  it('failed 之后再收到退出事件只是通知，不重启', () => {
    const { sidecar, timers, spawner } = setup({ maxAttempts: 0, backoff: { baseMs: 10 } })
    sidecar.start()
    expect(sidecar.snapshot().state).toBe('starting')
    spawner.children[0]?.exit(1)
    expect(sidecar.snapshot().state).toBe('failed')
    // failed 之后又收到一次退出事件：只通知订阅者，不再排重启
    spawner.children[0]?.exit(1)
    expect(sidecar.snapshot().state).toBe('failed')
    timers.runAll()
    expect(spawner.requests).toHaveLength(1)
  })

  it('stop 是主动停：发 SIGTERM，退出后不重启', () => {
    const { sidecar, spawner, timers } = setup()
    sidecar.start()
    sidecar.stop()
    expect(spawner.children[0]?.killed).toEqual(['SIGTERM'])
    expect(sidecar.snapshot().state).toBe('stopped')
    spawner.children[0]?.exit(null, 'SIGTERM')
    expect(sidecar.snapshot().state).toBe('stopped')
    timers.runAll()
    expect(spawner.requests).toHaveLength(1)
  })

  it('没有子进程时 stop 只是把状态摆正', () => {
    const { sidecar } = setup()
    sidecar.stop()
    expect(sidecar.snapshot().state).toBe('stopped')
  })

  it('stop 会取消挂着的退避定时器', () => {
    const { sidecar, spawner, timers } = setup({ backoff: { baseMs: 10 } })
    sidecar.start()
    spawner.children[0]?.exit(1)
    expect(timers.pending()).toBe(1)
    sidecar.stop()
    expect(timers.pending()).toBe(0)
    expect(sidecar.snapshot().state).toBe('stopped')
  })

  it('restart 等旧进程真退出再拉新的——同一个端口不会有两个进程', () => {
    const { sidecar, spawner } = setup()
    sidecar.start()
    sidecar.restart()
    expect(spawner.requests).toHaveLength(1)
    expect(sidecar.snapshot().state).toBe('stopped')
    spawner.children[0]?.exit(0)
    expect(spawner.requests).toHaveLength(2)
    expect(sidecar.snapshot()).toMatchObject({ state: 'starting', pid: 1001 })
  })

  it('没在跑时 restart 直接拉起', () => {
    const { sidecar, spawner } = setup()
    sidecar.restart()
    expect(spawner.requests).toHaveLength(1)
    expect(sidecar.snapshot().state).toBe('starting')
  })

  it('旧进程迟到的退出事件不会打乱新进程', () => {
    const { sidecar, spawner } = setup()
    sidecar.start()
    const first = spawner.children[0]
    sidecar.restart()
    first?.exit(0) // 触发第二次 launch
    expect(sidecar.snapshot().pid).toBe(1001)
    first?.exit(0) // 迟到的重复事件
    expect(sidecar.snapshot()).toMatchObject({ state: 'starting', pid: 1001 })
  })

  it('稳定定时器在已经不是 starting 时不改状态', () => {
    const { sidecar, spawner, timers } = setup()
    sidecar.start()
    sidecar.stop()
    spawner.children[0]?.exit(0)
    timers.runAll()
    expect(sidecar.snapshot().state).toBe('stopped')
  })

  it('子进程输出按行转出', () => {
    const { sidecar, spawner, output } = setup()
    sidecar.start()
    spawner.children[0]?.emitStdout('listening\nhalf')
    spawner.children[0]?.emitStderr('boom\n')
    expect(output).toEqual([
      ['stdout', 'listening'],
      ['stderr', 'boom'],
    ])
  })

  it('没有 onOutput 也不炸', () => {
    const spawner = fakeSpawner()
    const sidecar = createSidecar({
      name: 's',
      request: () => request,
      spawner,
      timers: fakeTimers(),
      clock: fakeClock(),
      logger: silentLogger(),
    })
    sidecar.start()
    expect(() => spawner.children[0]?.emitStdout('x\n')).not.toThrow()
  })

  it('subscribe 立即回调一次，取消后不再收', () => {
    const { sidecar } = setup()
    const seen = vi.fn()
    const off = sidecar.subscribe(seen)
    expect(seen).toHaveBeenCalledTimes(1)
    sidecar.start()
    expect(seen).toHaveBeenCalledTimes(2)
    off()
    sidecar.stop()
    expect(seen).toHaveBeenCalledTimes(2)
  })

  it('每次启动重新求值 request（急停档位、端口可能变了）', () => {
    let port = 1
    const spawner = fakeSpawner()
    const timers = fakeTimers()
    const sidecar = createSidecar({
      name: 's',
      request: () => ({ command: 'n', args: [String(port)], env: {} }),
      spawner,
      timers,
      clock: fakeClock(),
      logger: silentLogger(),
      backoff: { baseMs: 1 },
    })
    sidecar.start()
    port = 2
    spawner.children[0]?.exit(1)
    timers.runNext()
    expect(spawner.requests.map((r) => r.args[0])).toEqual(['1', '2'])
  })

  it('默认 random 不抖动（jitter 为 0 时用不到）', () => {
    const spawner = fakeSpawner()
    const timers = fakeTimers()
    const sidecar = createSidecar({
      name: 's',
      request: () => request,
      spawner,
      timers,
      clock: fakeClock(),
      logger: silentLogger(),
      backoff: { baseMs: 20, jitter: 0.5 },
    })
    sidecar.start()
    spawner.children[0]?.exit(1)
    expect(sidecar.snapshot().retryInMs).toBe(15)
  })
})
