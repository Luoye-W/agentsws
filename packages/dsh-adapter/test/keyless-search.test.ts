/**
 * WP353：兜底搜索（社区插件 `@240xu/dsh-websearch` 的两家免 key 公开口）——不读环境变量、只开两家、不联网（fetch 替身）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KEYLESS_SEARCH_BACKENDS, keylessWebSearch } from '../src/index.js'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('keylessWebSearch', () => {
  it('只打 Exa / Parallel 两家公开口；环境里有 key、有后端清单也一概不读', async () => {
    vi.stubEnv('DSH_UNIFIED_SEARCH_BACKENDS', 'brave,tavily,deepseek')
    vi.stubEnv('EXA_API_KEY', 'exa-env-secret')
    vi.stubEnv('BRAVE_API_KEY', 'brave-env-secret')
    vi.stubEnv('DEEPSEEK_API_KEY', 'ds-env-secret')
    const seen: { url: string; headers: string }[] = []
    vi.stubGlobal('fetch', async (url: string, init?: { headers?: Record<string, string> }) => {
      seen.push({ url: String(url), headers: JSON.stringify(init?.headers ?? {}) })
      return new Response('nope', { status: 503 })
    })
    const provider = keylessWebSearch()
    expect(provider).toBeDefined()
    expect(provider?.available()).toBe(true)
    await expect(
      provider?.search({ query: 'site:reddit.com smart glasses', maxResults: 5 }),
    ).rejects.toThrow()
    const hosts = [...new Set(seen.map((s) => new URL(s.url).hostname))].sort()
    expect(hosts).toEqual(['mcp.exa.ai', 'search.parallel.ai'])
    expect(JSON.stringify(seen)).not.toMatch(/env-secret/)
    expect(KEYLESS_SEARCH_BACKENDS).toEqual(['exa', 'parallel'])
  })
})
