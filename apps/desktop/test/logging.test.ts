import { describe, expect, it } from 'vitest'
import { createLogger, formatLine, silentLogger } from '../src/logging.js'
import { memoryFileStore } from '../src/node-files.js'
import { createRedactor } from '../src/redact.js'
import { fakeClock } from './fakes.js'

const setup = (maxBytes?: number) => {
  const files = memoryFileStore()
  const mirrored: string[] = []
  const logger = createLogger({
    files,
    path: '/logs/desktop.log',
    clock: fakeClock(),
    mirror: (line) => mirrored.push(line),
    ...(maxBytes === undefined ? {} : { maxBytes }),
  })
  return { files, logger, mirrored, read: () => files.readText('/logs/desktop.log') ?? '' }
}

describe('formatLine', () => {
  it('无字段 / 空字段只写正文', () => {
    expect(formatLine('T', 'info', 'desktop', 'hi')).toBe('T INFO  [desktop] hi')
    expect(formatLine('T', 'warn', 'desktop', 'hi', {})).toBe('T WARN  [desktop] hi')
  })

  it('字段拼在后面；非字符串走 JSON', () => {
    expect(formatLine('T', 'error', 's', 'm', { a: 'x', b: 2, c: undefined })).toBe(
      'T ERROR [s] m a=x b=2 c=undefined',
    )
  })

  it('循环引用不炸', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(formatLine('T', 'info', 's', 'm', { cyclic })).toContain('cyclic=')
  })
})

describe('createLogger', () => {
  it('三档写盘并镜像', () => {
    const { logger, read, mirrored } = setup()
    logger.info('一')
    logger.warn('二', { k: 'v' })
    logger.error('三')
    logger.raw('原样一行')
    expect(read().split('\n').filter(Boolean)).toHaveLength(4)
    expect(mirrored).toHaveLength(4)
    expect(read()).toContain('[desktop] 一')
    expect(read()).toContain('k=v')
    expect(read()).toContain('原样一行')
  })

  it('child 给 scope 加前缀', () => {
    const { logger, read } = setup()
    logger.child('server').child('inner').info('m')
    expect(read()).toContain('[desktop/server/inner] m')
  })

  it('setRedactor 之后密钥再也进不来', () => {
    const key = 'c'.repeat(48)
    const { logger, read } = setup()
    logger.setRedactor(createRedactor([key]))
    logger.raw(`env OOMOL_CONNECT_ADMIN_TOKEN=${key}`)
    expect(read()).not.toContain(key)
  })

  it('超过 maxBytes 就轮转成 .1', () => {
    const files = memoryFileStore()
    const logger = createLogger({
      files,
      path: '/logs/desktop.log',
      clock: fakeClock(),
      maxBytes: 80,
    })
    logger.info('第一行第一行第一行第一行')
    logger.info('第二行第二行第二行第二行')
    logger.info('第三行第三行第三行第三行')
    expect(files.exists('/logs/desktop.log.1')).toBe(true)
    expect((files.readText('/logs/desktop.log') ?? '').split('\n').filter(Boolean).length).toBe(1)
  })

  it('轮转两次时旧的 .1 被丢掉', () => {
    const files = memoryFileStore()
    const logger = createLogger({ files, path: '/l.log', clock: fakeClock(), maxBytes: 60 })
    logger.info('aaaaaaaaaaaaaaaaaaaaaa')
    logger.info('bbbbbbbbbbbbbbbbbbbbbb')
    logger.info('cccccccccccccccccccccc')
    expect(files.readText('/l.log.1')).toContain('bbbb')
  })
})

describe('silentLogger', () => {
  it('什么都不做，也不炸', () => {
    const logger = silentLogger()
    logger.info('a')
    logger.warn('b')
    logger.error('c')
    logger.raw('d')
    logger.setRedactor((s) => s)
    expect(logger.child('x')).toBe(logger)
  })
})
