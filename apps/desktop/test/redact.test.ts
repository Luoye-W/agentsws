import { describe, expect, it } from 'vitest'
import { createRedactor, defaultRedactor, REDACTED } from '../src/redact.js'

describe('createRedactor', () => {
  it('已知密钥逐字遮罩', () => {
    const key = 'a'.repeat(64)
    const redact = createRedactor([key])
    expect(redact(`OOMOL_CONNECT_ADMIN_TOKEN=${key}`)).not.toContain(key)
    expect(redact(`前面 ${key} 后面`)).toBe(`前面 ${REDACTED} 后面`)
  })

  it('太短的"密钥"不进字面量表，免得把正常文字打成马赛克', () => {
    const redact = createRedactor(['ab', ''])
    expect(redact('abc def')).toBe('abc def')
  })

  it('长的先替换，短的不会把长的切碎', () => {
    const long = `${'b'.repeat(20)}TAIL`
    const short = 'b'.repeat(20)
    const redact = createRedactor([short, long])
    expect(redact(long)).toBe(REDACTED)
  })

  it('apps/server 启动打印的 internal token 进不了日志', () => {
    const line = 'internal token: itk_9f3c2b1a4d5e6f708192a3b4c5d6e7f8'
    const out = defaultRedactor(line)
    expect(out).not.toContain('itk_9f3c2b1a4d5e6f708192a3b4c5d6e7f8')
    expect(out).toContain('internal token')
  })

  it('按形态兜底：标签、引号、Bearer、oct_、长不透明串', () => {
    expect(defaultRedactor('api_key = "sk-abcdefgh"')).toBe(`api_key = "${REDACTED}"`)
    expect(defaultRedactor("password: 'hunter2'")).toBe(`password: '${REDACTED}'`)
    expect(defaultRedactor('Authorization: Bearer abc123xyz')).toContain(REDACTED)
    expect(defaultRedactor('alias oct_abc123')).toBe(`alias ${REDACTED}`)
    expect(defaultRedactor(`blob ${'f'.repeat(40)}`)).toBe(`blob ${REDACTED}`)
  })

  it('普通日志行原样保留', () => {
    const line = '2026-09-09T00:00:00.000Z INFO  [desktop/server] 子进程稳定运行'
    expect(defaultRedactor(line)).toBe(line)
  })

  it('正则元字符的密钥不会把正则搞炸', () => {
    const key = 'a.b*c+d?e[f]g(h)i|j^k$l{m}n\\o'
    const redact = createRedactor([key])
    expect(redact(`x ${key} y`)).toBe(`x ${REDACTED} y`)
    expect(redact('aXbYcZd')).toBe('aXbYcZd')
  })
})
