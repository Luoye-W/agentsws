/**
 * 决策 942（WP371）：托盘「在浏览器打开」直接进——壳这一侧。
 *
 * - 个人档 + 回环地址：向服务要一次性 token，拼在 `#agentsws-enter=` 后面；
 * - `remote` 档、非回环地址：一律不要（连问都不问）；
 * - 要不到（局域网档 501、旧服务、连不上、抛错）：打开不带 token 的老地址；
 * - api-client 的 `browserLink()` 只把会话密钥放在请求体里；
 * - 主进程的两处「在浏览器打开」都走这条（源码钉住，不再直接 `openExternal(serverUrl())`）。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createApiClient } from '../src/api-client.js'
import { browserEntryUrl, ENTRY_HASH_KEY, isLoopbackUrl } from '../src/browser-entry.js'
import type { ApiFetchLike } from '../src/ports.js'

const BASE = 'http://127.0.0.1:4317'

describe('browserEntryUrl', () => {
  it('个人档 + 回环：带一次性 token，放在 # 后面（不发给服务端）', async () => {
    const url = await browserEntryUrl({
      base: `${BASE}/`,
      remote: false,
      issue: async () => 'ml_a+b',
    })
    expect(url).toBe(`${BASE}/#${ENTRY_HASH_KEY}=ml_a%2Bb`)
    const scenes = await browserEntryUrl({
      base: BASE,
      path: '/?scenes=1',
      remote: false,
      issue: async () => 'ml_x',
    })
    expect(scenes).toBe(`${BASE}/?scenes=1#${ENTRY_HASH_KEY}=ml_x`)
  })

  it('remote 档、非回环地址：不要 token，连问都不问', async () => {
    let asked = 0
    const issue = async () => {
      asked += 1
      return 'ml_x'
    }
    expect(await browserEntryUrl({ base: BASE, remote: true, issue })).toBe(`${BASE}/`)
    expect(await browserEntryUrl({ base: 'http://192.168.1.20:4317', remote: false, issue })).toBe(
      'http://192.168.1.20:4317/',
    )
    expect(asked).toBe(0)
  })

  it('要不到 / 抛错：打开老地址', async () => {
    expect(await browserEntryUrl({ base: BASE, remote: false, issue: async () => undefined })).toBe(
      `${BASE}/`,
    )
    expect(
      await browserEntryUrl({
        base: BASE,
        remote: false,
        issue: async () => {
          throw new Error('boom')
        },
      }),
    ).toBe(`${BASE}/`)
  })

  it('isLoopbackUrl', () => {
    expect(isLoopbackUrl('http://127.0.0.1:1')).toBe(true)
    expect(isLoopbackUrl('http://[::1]:1')).toBe(true)
    expect(isLoopbackUrl('http://localhost:1')).toBe(true)
    expect(isLoopbackUrl('http://10.0.0.2:1')).toBe(false)
    expect(isLoopbackUrl('file:///etc/passwd')).toBe(false)
    expect(isLoopbackUrl('not a url')).toBe(false)
  })
})

describe('api-client browserLink()', () => {
  const make = (status: number, body: unknown) => {
    const seen: { url: string; body?: string }[] = []
    const fetchImpl: ApiFetchLike = async (url, init) => {
      seen.push({ url, ...(init?.body === undefined ? {} : { body: init.body }) })
      return {
        ok: status < 400,
        status,
        text: async () => JSON.stringify(body),
        headers: { get: () => null },
      }
    }
    return { seen, api: createApiClient({ baseUrl: BASE, sessionKey: 'k'.repeat(40), fetchImpl }) }
  }

  it('成功：回 token；会话密钥只在请求体里', async () => {
    const { seen, api } = make(200, { data: { token: 'ml_1', expires_at: 'x' } })
    expect(await api.browserLink()).toEqual({ ok: true, value: 'ml_1' })
    expect(seen[0]?.url).toBe(`${BASE}/v1/auth/browser-link`)
    expect(seen[0]?.url).not.toContain('k'.repeat(40))
    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({ key: 'k'.repeat(40) })
  })

  it('服务不开（局域网档 501）：失败，带人话原因', async () => {
    const { api } = make(501, { error: { message: '这个服务不给浏览器发一次性进入链接' } })
    const out = await api.browserLink()
    expect(out.ok).toBe(false)
  })
})

describe('主进程：两处「在浏览器打开」都走一次性链接', () => {
  it('不再直接 openExternal(serverUrl())', () => {
    const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
    expect(main).not.toMatch(/shell\.openExternal\(serverUrl\(\)\)/)
    expect(main).toMatch(/case 'open-browser':\s*void openInBrowser\(\)/)
    expect(main).toMatch(/if \(config\.openInBrowser\) return openInBrowser\(path\)/)
  })
})
