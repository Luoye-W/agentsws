import { describe, expect, it } from 'vitest'
import { CONTENT_SECURITY_POLICY, withCsp } from '../src/csp.js'
import {
  decideNavigation,
  decideWindowOpen,
  isLocalOrigin,
  isSafeExternal,
  originOf,
  parseUrl,
} from '../src/navigation.js'

const LOCAL = ['http://127.0.0.1:4317']

describe('parseUrl / originOf', () => {
  it('坏 URL 返回 undefined', () => {
    expect(parseUrl('not a url')).toBeUndefined()
    expect(originOf('////')).toBeUndefined()
  })

  it('取规范化的源', () => {
    expect(originOf('http://127.0.0.1:4317/v1/health?x=1')).toBe('http://127.0.0.1:4317')
  })
})

describe('isLocalOrigin', () => {
  it('同源才算本地；换端口、换主机、换协议都不算', () => {
    expect(isLocalOrigin('http://127.0.0.1:4317/a', LOCAL)).toBe(true)
    expect(isLocalOrigin('http://127.0.0.1:4318/a', LOCAL)).toBe(false)
    expect(isLocalOrigin('http://localhost:4317/a', LOCAL)).toBe(false)
    expect(isLocalOrigin('https://127.0.0.1:4317/a', LOCAL)).toBe(false)
    expect(isLocalOrigin('garbage', LOCAL)).toBe(false)
  })
})

describe('isSafeExternal', () => {
  it('只有 http / https / mailto 能交给系统浏览器', () => {
    expect(isSafeExternal('https://example.com')).toBe(true)
    expect(isSafeExternal('http://example.com')).toBe(true)
    expect(isSafeExternal('mailto:a@b.c')).toBe(true)
  })

  it('能被拿来执行本机命令的协议一律不给', () => {
    for (const url of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,<script>1</script>',
      'ms-msdt:/id',
      'smb://host/share',
      'vscode://x',
      '不是 URL',
    ])
      expect(isSafeExternal(url)).toBe(false)
  })
})

describe('decideNavigation', () => {
  it('本地放行', () => {
    expect(decideNavigation('http://127.0.0.1:4317/approvals', LOCAL)).toEqual({ action: 'allow' })
  })

  it('外站走系统浏览器', () => {
    expect(decideNavigation('https://example.com/x', LOCAL)).toEqual({
      action: 'external',
      url: 'https://example.com/x',
    })
  })

  it('其它协议一律拒绝', () => {
    expect(decideNavigation('file:///etc/passwd', LOCAL)).toMatchObject({ action: 'deny' })
    expect(decideNavigation('javascript:alert(1)', LOCAL)).toMatchObject({ action: 'deny' })
  })

  it('不是 URL 也拒绝', () => {
    const decision = decideNavigation('///', LOCAL)
    expect(decision).toMatchObject({ action: 'deny' })
    if (decision.action === 'deny') expect(decision.reason).toContain('不是合法 URL')
  })
})

describe('decideWindowOpen', () => {
  it('与导航同一套判定（永远不新开 BrowserWindow）', () => {
    expect(decideWindowOpen('http://127.0.0.1:4317/x', LOCAL)).toEqual({ action: 'allow' })
    expect(decideWindowOpen('https://example.com', LOCAL)).toMatchObject({ action: 'external' })
    expect(decideWindowOpen('data:text/html,x', LOCAL)).toMatchObject({ action: 'deny' })
  })
})

describe('withCsp', () => {
  it('只允许 self，并封掉 object / frame-ancestors', () => {
    expect(CONTENT_SECURITY_POLICY).toContain("default-src 'self'")
    expect(CONTENT_SECURITY_POLICY).toContain("object-src 'none'")
    expect(CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'")
  })

  it('覆盖服务端自己发的 CSP（大小写不敏感）', () => {
    const headers = withCsp({
      'content-security-policy': ['default-src *'],
      'Content-Security-Policy-Report-Only': ['x'],
      'X-Powered-By': 'hono',
    })
    expect(headers['Content-Security-Policy']).toEqual([CONTENT_SECURITY_POLICY])
    expect(headers['content-security-policy']).toBeUndefined()
    expect(headers['Content-Security-Policy-Report-Only']).toBeUndefined()
    expect(headers['X-Powered-By']).toEqual(['hono'])
  })

  it('可以传自定义策略', () => {
    expect(withCsp({}, "default-src 'none'")['Content-Security-Policy']).toEqual([
      "default-src 'none'",
    ])
  })
})
