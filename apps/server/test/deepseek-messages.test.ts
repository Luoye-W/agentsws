/**
 * WP143：「DeepSeek 官方」API key 那一路改走 Messages 口的开关（`AGENTSWS_DEEPSEEK_MESSAGES`，默认关）。
 *
 * - 不开：照旧 OpenAI 兼容 `/chat/completions`（老行为一个字节不变）；
 * - 开了：官方地址的那条走 `https://api.deepseek.com/anthropic/v1/messages`，key 只在 `x-api-key` 头里，
 *   三步验证（连通 → 文字 → 看图）照跑照过；
 * - 开了但地址改过（代理 / 中转）：不动，照旧 OpenAI 兼容口；别家（百炼等）更不动。
 *
 * 上游是替身（同时认两种形状），不联网。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ModelTestResult } from '@agentsws/api'
import type { FetchLike } from '@agentsws/model-gateway'
import { VISION_PROBE_WORD } from '@agentsws/model-gateway'
import { afterEach, describe, expect, it } from 'vitest'
import { DEEPSEEK_MESSAGES_ENV, deepseekUsesMessages } from '../src/models.js'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'
import { createServer, type Server } from '../src/server.js'

const API_KEY = 'sk-wp143-messages-never-leaves-9d2e'

interface Call {
  url: string
  headers: Record<string, string>
  body: string
}

function fakeUpstream(): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = []
  const fetch: FetchLike = async (url, init) => {
    const body = typeof init.body === 'string' ? init.body : '[form]'
    calls.push({ url, headers: init.headers, body })
    const image = body.includes('"image_url"') || body.includes('"type":"image"')
    const text = image ? VISION_PROBE_WORD : '好'
    const json = url.endsWith('/models')
      ? { object: 'list', data: [{ id: 'deepseek-flash' }] }
      : url.endsWith('/v1/messages')
        ? { content: [{ type: 'text', text }], usage: { input_tokens: 9, output_tokens: 1 } }
        : {
            choices: [{ message: { content: text } }],
            usage: { prompt_tokens: 9, completion_tokens: 1 },
          }
    return { ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) }
  }
  return { fetch, calls }
}

let server: Server | undefined
let dir: string | undefined
afterEach(async () => {
  await server?.close()
  server = undefined
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

async function boot(env: Record<string, string>) {
  dir = mkdtempSync(join(tmpdir(), 'agentsws-wp143-'))
  const upstream = fakeUpstream()
  server = await createServer({
    dbDir: dir,
    quiet: true,
    env: { [SECRETS_KEY_ENV]: 'b'.repeat(64), ...env },
    modelFetch: upstream.fetch,
    tokenRefreshIntervalMs: 0,
  })
  const { url } = await server.listen(0)
  const s = server
  const api = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${s.bootstrap.internalToken}`)
    headers.set('X-Assignment', s.bootstrap.ownerAssignment.id)
    if (init.body !== undefined) headers.set('content-type', 'application/json')
    return fetch(`${url}${path}`, { ...init, headers })
  }
  const save = (base_url: string) =>
    api('/v1/models/providers/deepseek', {
      method: 'PUT',
      body: JSON.stringify({
        kind: 'deepseek',
        base_url,
        model: 'deepseek-flash',
        api_key: API_KEY,
      }),
    })
  const test = async () =>
    (
      (await (await api('/v1/models/providers/deepseek/test', { method: 'POST' })).json()) as {
        data: ModelTestResult
      }
    ).data
  return { upstream, save, test }
}

describe('WP143 DeepSeek 官方 API key → Messages 口（默认关）', () => {
  it('不开开关：照旧 /chat/completions，Authorization: Bearer', async () => {
    const { upstream, save, test } = await boot({})
    await save('https://api.deepseek.com')
    expect((await test()).ok).toBe(true)
    const chats = upstream.calls.filter((c) => c.url.endsWith('/chat/completions'))
    expect(chats).toHaveLength(2)
    expect(upstream.calls.some((c) => c.url.includes('/anthropic/'))).toBe(false)
  })

  it('开了：走 /anthropic/v1/messages，key 只在 x-api-key 头；三步验证照过', async () => {
    const { upstream, save, test } = await boot({ [DEEPSEEK_MESSAGES_ENV]: '1' })
    await save('https://api.deepseek.com')
    const result = await test()
    expect(result.ok).toBe(true)
    expect(result.steps?.map((s) => s.ok)).toEqual([true, true, true])
    const msgs = upstream.calls.filter((c) => c.url.endsWith('/v1/messages'))
    expect(msgs).toHaveLength(2)
    expect(msgs[0]?.url).toBe('https://api.deepseek.com/anthropic/v1/messages')
    for (const c of msgs) {
      expect(c.headers['x-api-key']).toBe(API_KEY)
      expect(c.headers.authorization ?? c.headers.Authorization).toBeUndefined()
      expect(c.body).not.toContain(API_KEY)
    }
    expect(upstream.calls.some((c) => c.url.endsWith('/chat/completions'))).toBe(false)
  })

  it('开了但地址改过（代理）：不动，照旧 OpenAI 兼容口', async () => {
    const { upstream, save, test } = await boot({ [DEEPSEEK_MESSAGES_ENV]: '1' })
    await save('https://proxy.example.com/v1')
    await test()
    expect(upstream.calls.some((c) => c.url.includes('/anthropic/'))).toBe(false)
    expect(upstream.calls.some((c) => c.url.endsWith('/chat/completions'))).toBe(true)
  })

  it('判定只认 DeepSeek 官方这一家、官方地址', () => {
    const on = { [DEEPSEEK_MESSAGES_ENV]: '1' }
    expect(
      deepseekUsesMessages({ kind: 'deepseek', base_url: 'https://api.deepseek.com' }, on),
    ).toBe(true)
    expect(
      deepseekUsesMessages({ kind: 'deepseek', base_url: 'https://api.deepseek.com/v1' }, on),
    ).toBe(true)
    expect(
      deepseekUsesMessages({ kind: 'deepseek', base_url: 'https://api.deepseek.com' }, {}),
    ).toBe(false)
    expect(
      deepseekUsesMessages(
        {
          kind: 'openai_compatible',
          base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        },
        on,
      ),
    ).toBe(false)
    expect(
      deepseekUsesMessages({ kind: 'deepseek', base_url: 'http://api.deepseek.com' }, on),
    ).toBe(false)
    expect(deepseekUsesMessages({ kind: 'deepseek', base_url: 'not a url' }, on)).toBe(false)
  })
})
