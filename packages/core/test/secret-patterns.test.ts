import { describe, expect, it } from 'vitest'
import {
  createLogRedactor,
  defaultLogRedactor,
  hasSecret,
  LOG_SECRET_PATTERNS,
  REDACTED,
  SECRET_PATTERNS,
  scanSecrets,
  scrub,
  secretPatterns,
} from '../src/secret-patterns.js'

/**
 * 秘密模式表的**那一份**测试（WP31 §4：三处重复上移 core）。
 * 各包只 import，不再各自维护样本——这张表是唯一的判定出处。
 */

/** 一条样本：文本 + 该命中的规则名。 */
const SAMPLES: readonly { text: string; rules: string[] }[] = [
  { text: 'key sk-abcdefghijklmnopqrst', rules: ['api_key'] },
  { text: 'pk_abcdefghijklmnopqrst', rules: ['api_key'] },
  { text: 'AKIAABCDEFGHIJKLMNOP', rules: ['aws_key'] },
  { text: 'password: hunter2000', rules: ['bearer'] },
  { text: 'api_key = abcdefghij', rules: ['bearer'] },
  { text: 'card 4111 1111 1111 1111', rules: ['card_number'] },
  { text: 'token oct_abcdefghijkl', rules: ['connect_token'] },
  { text: 'shpat_0123456789abcdef0123', rules: ['shopify_token'] },
  { text: '授权码：abcdefghijklmnop', rules: ['mail_app_password'] },
  { text: 'app password abcdefghijklmnop', rules: ['mail_app_password'] },
  { text: 'order 1001 is late', rules: [] },
  { text: '退货窗口 14 天', rules: [] },
]

describe('SECRET_PATTERNS（内容脱敏表）', () => {
  it.each(SAMPLES)('样本判定：$text', ({ text, rules }) => {
    const result = scrub(text)
    for (const rule of rules) expect(result.rules).toContain(rule)
    if (rules.length === 0) {
      expect(result).toEqual({ text, rules: [] })
      expect(hasSecret(text)).toBe(false)
    } else {
      expect(hasSecret(text)).toBe(true)
      expect(result.text).not.toBe(text)
    }
    expect(scanSecrets(text).length > 0).toBe(rules.length > 0)
  })

  it('四类原表模式都命中、各只报一次、按表内顺序', () => {
    const r = scrub('key sk-abcdefghijklmnop AKIAABCDEFGHIJKLMNOP card 4111111111111111')
    expect(r.rules).toEqual(['api_key', 'aws_key', 'card_number'])
    expect(r.text).not.toContain('sk-abcdefghijklmnop')
    expect(r.text).not.toContain('AKIAABCDEFGHIJKLMNOP')
    expect(r.text).toContain('[redacted:card_number]')
  })

  it('每次调用现造正则：同一条文本连跑两次结果一致（lastIndex 不串味）', () => {
    const text = 'sk-aaaaaaaaaaaaaaaaaa 与 sk-bbbbbbbbbbbbbbbbbb'
    expect(scrub(text)).toEqual(scrub(text))
    expect(scrub(text).text).not.toContain('sk-a')
    expect(scrub(text).text).not.toContain('sk-b')
  })

  it('secretPatterns() 每次给新实例，规则名与表一致', () => {
    const a = secretPatterns()
    const b = secretPatterns()
    expect(a.map((x) => x.rule)).toEqual(SECRET_PATTERNS.map((x) => x.rule))
    expect(a[0]?.re).not.toBe(b[0]?.re)
  })

  it('规则名唯一', () => {
    const names = SECRET_PATTERNS.map((x) => x.rule)
    expect(new Set(names).size).toBe(names.length)
  })
})

describe('createLogRedactor（日志脱敏表）', () => {
  it('已知密钥逐字遮罩', () => {
    const key = 'a'.repeat(64)
    const redact = createLogRedactor([key])
    expect(redact(`OOMOL_CONNECT_ADMIN_TOKEN=${key}`)).not.toContain(key)
    expect(redact(`前面 ${key} 后面`)).toBe(`前面 ${REDACTED} 后面`)
  })

  it('太短的「密钥」不进字面量表', () => {
    expect(createLogRedactor(['ab', ''])('abc def')).toBe('abc def')
  })

  it('长的先替换，短的不会把长的切碎', () => {
    const short = 'b'.repeat(20)
    const long = `${short}TAIL`
    expect(createLogRedactor([short, long])(long)).toBe(REDACTED)
  })

  it('apps/server 启动打印的 internal token 进不了日志', () => {
    const out = defaultLogRedactor('internal token: itk_9f3c2b1a4d5e6f708192a3b4c5d6e7f8')
    expect(out).not.toContain('itk_9f3c2b1a4d5e6f708192a3b4c5d6e7f8')
    expect(out).toContain('internal token')
  })

  it('按形态兜底：标签、引号、Bearer、oct_、shpat_、长不透明串', () => {
    expect(defaultLogRedactor('api_key = "sk-abcdefgh"')).toBe(`api_key = "${REDACTED}"`)
    expect(defaultLogRedactor("password: 'hunter2'")).toBe(`password: '${REDACTED}'`)
    expect(defaultLogRedactor('Authorization: Bearer abc123xyz')).toContain(REDACTED)
    expect(defaultLogRedactor('alias oct_abc123')).toBe(`alias ${REDACTED}`)
    expect(defaultLogRedactor('shpat_0123456789abcdef')).toBe(REDACTED)
    expect(defaultLogRedactor(`blob ${'f'.repeat(40)}`)).toBe(`blob ${REDACTED}`)
  })

  it('普通日志行原样保留', () => {
    const line = '2026-09-09T00:00:00.000Z INFO  [desktop/server] 子进程稳定运行'
    expect(defaultLogRedactor(line)).toBe(line)
  })

  it('正则元字符的密钥不会把正则搞炸', () => {
    const key = 'a.b*c+d?e[f]g(h)i|j^k$l{m}n\\o'
    const redact = createLogRedactor([key])
    expect(redact(`x ${key} y`)).toBe(`x ${REDACTED} y`)
    expect(redact('aXbYcZd')).toBe('aXbYcZd')
  })

  it('日志表规则名唯一', () => {
    const names = LOG_SECRET_PATTERNS.map((x) => x.rule)
    expect(new Set(names).size).toBe(names.length)
  })
})
