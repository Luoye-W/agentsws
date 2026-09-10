/**
 * 「模型名从接口拉」（WP42 交付 1）：provider 自己报一份可用模型清单。
 *
 * 全程注入 fetch 回放固定的响应，**不联网**。三条主张：
 * 1. OpenAI 形态的 `GET {base}/models` 是主路——各家（DeepSeek / OpenAI / Moonshot /
 *    通义 / 智谱 / SiliconFlow / Ollama）回的都是同一个 `{ data: [{ id }] }`；
 * 2. 主路不通就兜 Ollama 自己的 `GET {origin}/api/tags`；两条都不通报**主路**的错；
 * 3. 清单去重、排序；key 只在 Authorization 头里出现，不进返回值也不进错误。
 */
import { describe, expect, it } from 'vitest'
import type { FetchLike } from '../src/index.js'
import { ollamaTagsUrl, openaiCompatibleProvider, ProviderError } from '../src/index.js'

const KEY = 'sk-list-models-never-leaks-1a2b'

interface Call {
  url: string
  method: string
  auth: string | undefined
}

/** 按 URL 回放：命中就回 body，没命中就 404。 */
function replay(routes: Record<string, unknown>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = []
  const fetch: FetchLike = async (url, init) => {
    calls.push({
      url,
      method: init.method,
      auth: init.headers.authorization ?? init.headers.Authorization,
    })
    const body = routes[url]
    if (body === undefined) {
      return {
        ok: false,
        status: 404,
        json: async () => ({}),
        text: async () => 'not found',
      }
    }
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
  }
  return { fetch, calls }
}

const provider = (baseUrl: string, fetch: FetchLike) =>
  openaiCompatibleProvider({ baseUrl, apiKey: () => KEY, model: 'x', provider: 'p', fetch })

describe('listModels（注入 fetch 回放，不联网）', () => {
  it('OpenAI 形态：GET {base}/models，回一份去重排序的清单', async () => {
    const { fetch, calls } = replay({
      'https://api.deepseek.com/models': {
        object: 'list',
        data: [
          { id: 'deepseek-v4-pro', object: 'model', owned_by: 'deepseek' },
          { id: 'deepseek-flash', object: 'model', owned_by: 'deepseek' },
          // 上游偶尔回重复条目；清单里只该有一条
          { id: 'deepseek-flash', object: 'model', owned_by: 'deepseek' },
          { id: '  ', object: 'model' },
        ],
      },
    })
    const models = await provider('https://api.deepseek.com', fetch).listModels?.()
    expect(models).toEqual([
      { id: 'deepseek-flash', owned_by: 'deepseek' },
      { id: 'deepseek-v4-pro', owned_by: 'deepseek' },
    ])
    expect(calls).toHaveLength(1)
    expect(calls[0]?.method).toBe('GET')
  })

  it('Ollama：/v1/models 不通时兜 /api/tags', async () => {
    const { fetch, calls } = replay({
      'http://127.0.0.1:11434/api/tags': {
        models: [
          { name: 'qwen3:8b', model: 'qwen3:8b' },
          { name: 'llama3.1:latest', model: 'llama3.1:latest' },
        ],
      },
    })
    const models = await provider('http://127.0.0.1:11434/v1', fetch).listModels?.()
    expect(models).toEqual([{ id: 'llama3.1:latest' }, { id: 'qwen3:8b' }])
    expect(calls.map((c) => c.url)).toEqual([
      'http://127.0.0.1:11434/v1/models',
      'http://127.0.0.1:11434/api/tags',
    ])
  })

  it('空清单也当"主路没通"，继续兜底', async () => {
    const { fetch } = replay({
      'http://127.0.0.1:11434/v1/models': { data: [] },
      'http://127.0.0.1:11434/api/tags': { models: [{ model: 'gemma3:4b' }] },
    })
    const models = await provider('http://127.0.0.1:11434/v1', fetch).listModels?.()
    expect(models).toEqual([{ id: 'gemma3:4b' }])
  })

  it('两条都不通：报主路的错（401 而不是兜底口的 404）', async () => {
    const fetch: FetchLike = async (url) => ({
      ok: false,
      status: url.endsWith('/models') ? 401 : 404,
      json: async () => ({}),
      text: async () => 'Invalid API key',
    })
    await expect(
      provider('https://api.moonshot.cn/v1', fetch).listModels?.(),
    ).rejects.toMatchObject({ name: 'ProviderError', status: 401 })
  })

  it('没有 key 就不发请求（错误信封里只有来源，没有值）', async () => {
    const calls: string[] = []
    const fetch: FetchLike = async (url) => {
      calls.push(url)
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' }
    }
    const p = openaiCompatibleProvider({
      baseUrl: 'https://api.deepseek.com',
      apiKey: () => undefined,
      model: 'x',
      fetch,
    })
    await expect(p.listModels?.()).rejects.toThrow(/missing api key/)
    expect(calls).toEqual([])
  })

  it('key 只出现在 Authorization 头里', async () => {
    const { fetch, calls } = replay({
      'https://api.deepseek.com/models': { data: [{ id: 'deepseek-flash' }] },
    })
    await provider('https://api.deepseek.com', fetch).listModels?.()
    expect(calls[0]?.auth).toBe(`Bearer ${KEY}`)
    expect(calls[0]?.url).not.toContain(KEY)
  })

  it('ollamaTagsUrl 只削尾巴上的 /v1', () => {
    expect(ollamaTagsUrl('http://127.0.0.1:11434/v1')).toBe('http://127.0.0.1:11434/api/tags')
    expect(ollamaTagsUrl('http://127.0.0.1:11434')).toBe('http://127.0.0.1:11434/api/tags')
    expect(ollamaTagsUrl('https://h/v1/compatible-mode/v1')).toBe(
      'https://h/v1/compatible-mode/api/tags',
    )
  })

  it('ProviderError 仍然是可降级判定认识的那一个', () => {
    expect(new ProviderError('x', { status: 503 }).status).toBe(503)
  })
})
