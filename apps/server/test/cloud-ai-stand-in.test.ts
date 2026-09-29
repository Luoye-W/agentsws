/** WP188：demo 里「Agents 工坊（用积分）」模型口替身——不出网、会流、认得验证图、别的地址放行。 */
import type { FetchLike } from '@agentsws/model-gateway'
import { VISION_PROBE_WORD } from '@agentsws/model-gateway'
import { describe, expect, it } from 'vitest'
import { cloudAiStandInFetch, demoWebSearch } from '../src/cloud-ai-stand-in.js'
import { CLOUD_STAND_IN_BASE_URL } from '../src/cloud-stand-in.js'

const base = `${CLOUD_STAND_IN_BASE_URL}/v1/ai`
const post = (body: unknown) => ({ method: 'POST', headers: {}, body: JSON.stringify(body) })

describe('cloudAiStandInFetch', () => {
  it('模型清单、验证图、非流式', async () => {
    const fetch = cloudAiStandInFetch({ delayMs: 0 })
    const models = (await (
      await fetch(`${base}/models`, { method: 'GET', headers: {} })
    ).json()) as {
      data: { id: string }[]
    }
    expect(models.data.map((m) => m.id)).toContain('deepseek-flash')
    const probe = await fetch(
      `${base}/chat/completions`,
      post({
        messages: [
          { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:x' } }] },
        ],
      }),
    )
    expect(JSON.stringify(await probe.json())).toContain(VISION_PROBE_WORD)
  })

  it('流式：一段段回，最后一块带用量；有搜索工具时先搜一次', async () => {
    const fetch = cloudAiStandInFetch({ delayMs: 0 })
    const res = await fetch(
      `${base}/chat/completions`,
      post({ stream: true, messages: [{ role: 'user', content: '你好' }] }),
    )
    const text = await res.text()
    expect(text.split('data: ').length).toBeGreaterThan(10)
    expect(text).toContain('"usage"')
    expect(text.trim().endsWith('data: [DONE]')).toBe(true)
    const search = await fetch(
      `${base}/chat/completions`,
      post({
        stream: true,
        tools: [{ type: 'function', function: { name: 'web_search' } }],
        messages: [{ role: 'user', content: '充电器新闻' }],
      }),
    )
    expect(await search.text()).toContain('web_search')
    expect((await demoWebSearch('充电器')).sources.length).toBe(2)
  })

  it('别的地址原样交给下一个 fetch', async () => {
    const seen: string[] = []
    const next: FetchLike = async (url) => {
      seen.push(url)
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' }
    }
    await cloudAiStandInFetch({ next })('https://api.deepseek.com/chat/completions', post({}))
    expect(seen).toEqual(['https://api.deepseek.com/chat/completions'])
  })
})
