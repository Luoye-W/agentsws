/** WP298：主窗口的页面报错 / 渲染进程崩溃 / 加载失败落进 desktop.log。 */
import { describe, expect, it } from 'vitest'
import { createLogger } from '../src/logging.js'
import { memoryFileStore } from '../src/node-files.js'
import {
  attachRendererLogging,
  readConsoleMessage,
  scrubRendererText,
} from '../src/renderer-log.js'
import { fakeClock } from './fakes.js'

function fakeContents() {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>()
  return {
    on(event: string, listener: (...args: unknown[]) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      return this
    },
    emit(event: string, ...args: unknown[]) {
      for (const l of listeners.get(event) ?? []) l(...args)
    },
  }
}

const setup = () => {
  const files = memoryFileStore()
  const logger = createLogger({ files, path: '/logs/desktop.log', clock: fakeClock() })
  const contents = fakeContents()
  let now = 0
  attachRendererLogging(contents, logger, () => now)
  return {
    contents,
    advance: (ms: number) => {
      now += ms
    },
    lines: () => (files.readText('/logs/desktop.log') ?? '').split('\n').filter((l) => l !== ''),
  }
}

describe('渲染进程日志', () => {
  it('console-message 只记 error；新旧两种事件形状都认；查询串与邮箱洗掉', () => {
    const s = setup()
    s.contents.emit('console-message', {
      level: 'error',
      message: 'TypeError: x of undefined at http://127.0.0.1:4317/assets/index.js?v=2:3:9 a@b.com',
      lineNumber: 3,
      sourceId: 'http://127.0.0.1:4317/assets/index.js?v=2',
    })
    s.contents.emit('console-message', { level: 'warning', message: 'just a warning' })
    s.contents.emit('console-message', {}, 3, 'old style error', 7, 'app.js')
    s.contents.emit('console-message', {}, 1, 'old info', 7, 'app.js')
    const lines = s.lines()
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('ERROR [desktop/renderer] 页面报错')
    expect(lines[0]).toContain('/assets/index.js:3:9')
    expect(lines[0]).not.toContain('?v=2')
    expect(lines[0]).toContain('<email>')
    expect(lines[1]).toContain('old style error')
    expect(lines[1]).toContain('at=app.js:7')
  })

  it('render-process-gone / did-fail-load（-3 不记）/ unresponsive', () => {
    const s = setup()
    s.contents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 5 })
    s.contents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'http://127.0.0.1/', true)
    s.contents.emit(
      'did-fail-load',
      {},
      -102,
      'ERR_CONNECTION_REFUSED',
      'http://127.0.0.1/?t=1',
      true,
    )
    s.contents.emit('unresponsive')
    const lines = s.lines()
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain('渲染进程没了 reason=crashed exitCode=5')
    expect(lines[1]).toContain('页面没加载出来 code=-102')
    expect(lines[1]).not.toContain('?t=1')
    expect(lines[2]).toContain('WARN  [desktop/renderer] 页面没有响应')
  })

  it('一分钟最多 30 行，下一分钟说一句丢了几条', () => {
    const s = setup()
    for (let i = 0; i < 50; i += 1)
      s.contents.emit('console-message', { level: 'error', message: `e${String(i)}` })
    expect(s.lines()).toHaveLength(30)
    s.advance(60_000)
    s.contents.emit('console-message', { level: 'error', message: 'later' })
    const lines = s.lines()
    expect(lines).toHaveLength(32)
    expect(lines[30]).toContain('dropped=20')
    expect(lines[31]).toContain('later')
  })

  it('洗字：截到 500、一条一行；认不出的事件形状不记', () => {
    expect(scrubRendererText(`a\nb${'x'.repeat(1000)}`).length).toBe(500)
    expect(scrubRendererText('a\nb')).toBe('a b')
    expect(readConsoleMessage([{}, 'x'])).toBeUndefined()
    // 不给时钟：用系统时钟
    const files = memoryFileStore()
    const contents = fakeContents()
    attachRendererLogging(contents, createLogger({ files, path: '/l.log', clock: fakeClock() }))
    contents.emit('console-message', { level: 'error', message: 'sys clock' })
    expect(files.readText('/l.log')).toContain('sys clock')
  })
})
