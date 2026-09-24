/**
 * 09-24 首次真部署冒烟：Workers 形态缺安全头（自建形态由 Caddy 加）。
 */
import { describe, expect, it } from 'vitest'
import { withSecurityHeaders } from '../src/index.js'

describe('Workers 形态的安全头', () => {
  it('普通响应补上四条安全头，原有的头与状态码不变', async () => {
    const res = withSecurityHeaders(
      new Response('hi', { status: 201, headers: { 'content-type': 'text/plain' } }),
    )
    expect(res.status).toBe(201)
    expect(res.headers.get('content-type')).toBe('text/plain')
    expect(res.headers.get('strict-transport-security')).toContain('max-age=')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin')
    expect(await res.text()).toBe('hi')
  })

  it('已经带了同名头的不覆盖', () => {
    const res = withSecurityHeaders(
      new Response(null, { headers: { 'x-frame-options': 'SAMEORIGIN' } }),
    )
    expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN')
  })

  it('流式正文原样透传', async () => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: 1\n\n'))
        c.close()
      },
    })
    const res = withSecurityHeaders(
      new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
    )
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    expect(await res.text()).toBe('data: 1\n\n')
  })
})
