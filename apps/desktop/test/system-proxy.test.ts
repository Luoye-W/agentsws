/**
 * 10-16 内测：系统代理（只在操作系统设置里）转成服务进程的 HTTP(S)_PROXY，修订阅登录换令牌 403（地区不支持）。
 */
import { describe, expect, it } from 'vitest'
import { proxyEnvFor, proxyUrlFromResolution } from '../src/system-proxy.js'

describe('系统代理 → 服务进程环境', () => {
  it('认 Chromium resolveProxy 的写法', () => {
    expect(proxyUrlFromResolution('PROXY 127.0.0.1:7897; DIRECT')).toBe('http://127.0.0.1:7897')
    expect(proxyUrlFromResolution('HTTPS proxy.example:443')).toBe('https://proxy.example:443')
    expect(proxyUrlFromResolution('DIRECT')).toBeUndefined()
    // SOCKS Node 不认：跳过，后面有 HTTP 的就用后面的
    expect(proxyUrlFromResolution('SOCKS5 127.0.0.1:7891')).toBeUndefined()
    expect(proxyUrlFromResolution('SOCKS5 127.0.0.1:7891; PROXY 127.0.0.1:7890')).toBe(
      'http://127.0.0.1:7890',
    )
  })

  it('环境里没有代理变量：用系统代理，本机地址不走代理，并让 Node 内置 fetch 认它', () => {
    expect(proxyEnvFor({}, 'http://127.0.0.1:7897')).toEqual({
      HTTP_PROXY: 'http://127.0.0.1:7897',
      HTTPS_PROXY: 'http://127.0.0.1:7897',
      NO_PROXY: '127.0.0.1,localhost,::1',
      NODE_USE_ENV_PROXY: '1',
    })
  })

  it('环境里已有代理变量：不覆盖，只补 NO_PROXY 与开关', () => {
    const out = proxyEnvFor(
      { HTTPS_PROXY: 'http://corp:8080', NO_PROXY: 'intranet' },
      'http://127.0.0.1:7897',
    )
    expect(out.HTTPS_PROXY).toBeUndefined()
    expect(out.NO_PROXY).toBe('intranet,127.0.0.1,localhost,::1')
    expect(out.NODE_USE_ENV_PROXY).toBe('1')
  })

  it('没有任何代理：什么都不加', () => {
    expect(proxyEnvFor({}, undefined)).toEqual({})
  })
})
