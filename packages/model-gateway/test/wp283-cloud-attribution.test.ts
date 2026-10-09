/**
 * WP283（决策 310）：「Agents 工坊官方接口」那一条的**生图 / 改图 / 向量**也带「谁 / 哪个岗位」
 * （同 WP194 对话那一路）——少带一处，那一处的积分就落进「没标注」。全部替身，不联网。
 */
import { describe, expect, it } from 'vitest'
import { createModelGateway, openaiCompatibleProvider, openaiImageProvider } from '../src/index.js'
import { fixedClock, meta, policy, recorder } from './helpers.js'

type Init = { method: string; headers: Record<string, string>; body?: unknown }

const who = (m: { assignment_id: string } | undefined): Record<string, string> =>
  m === undefined
    ? {}
    : { 'X-Agentsws-Member': `p_${m.assignment_id}`, 'X-Agentsws-Position': 'design' }

function images() {
  const calls: { url: string; init: Init }[] = []
  const p = openaiImageProvider({
    baseUrl: 'https://cloud.test.invalid/v1/ai',
    apiKey: () => 'wst_test_not_real',
    model: 'gpt-image-2.5-flare',
    provider: 'agentsws_cloud',
    requestHeaders: who,
    fetch: async (url, init) => {
      calls.push({ url, init: init as Init })
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ b64_json: Buffer.from([1]).toString('base64') }] }),
        text: async () => '',
      }
    },
  })
  return { p, calls }
}

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1])

describe('WP283 官方接口：生图 / 改图带「谁」', () => {
  it('出图（images/generations）按这一次的 meta 带归属头，key 仍只在 Authorization', async () => {
    const { p, calls } = images()
    await p.generate({ prompt: 'banner', meta: meta({ assignment_id: 'asg_d' }) })
    expect(calls[0]?.url).toBe('https://cloud.test.invalid/v1/ai/images/generations')
    expect(calls[0]?.init.headers['X-Agentsws-Member']).toBe('p_asg_d')
    expect(calls[0]?.init.headers['X-Agentsws-Position']).toBe('design')
    expect(calls[0]?.init.headers.authorization).toBe('Bearer wst_test_not_real')
  })

  it('改图（images/edits，multipart）也带', async () => {
    const { p, calls } = images()
    await p.edit?.({
      prompt: 'same bottle, marble table',
      images: [{ bytes: png, content_type: 'image/png' }],
      meta: meta({ assignment_id: 'asg_e' }),
    })
    expect(calls[0]?.url).toBe('https://cloud.test.invalid/v1/ai/images/edits')
    expect(calls[0]?.init.headers['X-Agentsws-Member']).toBe('p_asg_e')
    // multipart 的 content-type 仍交给 fetch 自己填
    expect(calls[0]?.init.headers['content-type']).toBeUndefined()
  })

  it('没给 requestHeaders 的（自己的 key / 别家）一个归属头都不带', async () => {
    const calls: Init[] = []
    const p = openaiImageProvider({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: () => 'sk-test',
      model: 'gpt-image-2.5-flare',
      provider: 'openai',
      fetch: async (_url, init) => {
        calls.push(init as Init)
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ b64_json: Buffer.from([1]).toString('base64') }] }),
          text: async () => '',
        }
      },
    })
    await p.generate({ prompt: 'x', meta: meta({ assignment_id: 'asg_x' }) })
    expect(Object.keys(calls[0]?.headers ?? {}).some((h) => /x-agentsws/i.test(h))).toBe(false)
  })
})

describe('WP283 官方接口：向量也带「谁」', () => {
  it('网关把 meta 递给 provider.embed，官方那一条带归属头', async () => {
    const calls: { url: string; init: Init }[] = []
    const p = openaiCompatibleProvider({
      baseUrl: 'https://cloud.test.invalid/v1/ai',
      apiKey: () => 'wst_test_not_real',
      model: 'deepseek-chat',
      provider: 'agentsws_cloud',
      region: 'cn',
      embeddingModel: 'text-embedding-3-small',
      requestHeaders: who,
      fetch: async (url, init) => {
        calls.push({ url, init: init as Init })
        const body = JSON.stringify({
          data: [{ embedding: [0.1, 0.2] }],
          usage: { prompt_tokens: 2 },
        })
        return {
          ok: true,
          status: 200,
          json: async () => JSON.parse(body) as unknown,
          text: async () => body,
        }
      },
    })
    const gw = createModelGateway({
      providers: [p],
      policy: policy({
        default: { provider: 'agentsws_cloud', model: 'deepseek-chat', region: 'cn' },
        prices: { 'agentsws_cloud/deepseek-chat': { in: 0, out: 0, cached: 0 } },
      }),
      clock: fixedClock(),
      eventSink: recorder().sink,
      env: {},
    })
    const out = await gw.embed(['hello'], meta({ assignment_id: 'asg_v' }))
    expect(out.vectors).toEqual([[0.1, 0.2]])
    expect(calls[0]?.url).toBe('https://cloud.test.invalid/v1/ai/embeddings')
    expect(calls[0]?.init.headers['X-Agentsws-Member']).toBe('p_asg_v')
    // 直接调 provider、不给 meta：不带（同对话那一路）
    await p.embed?.(['x'])
    expect(calls[1]?.init.headers['X-Agentsws-Member']).toBeUndefined()
  })
})
