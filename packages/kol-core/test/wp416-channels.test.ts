/**
 * WP416（自查 kol A2 / A3）：YouTube 主页链接打得开；只能按账号查的三家不再把关键词拆成账号名去查。
 */
import { describe, expect, it } from 'vitest'
import {
  createInstagramAdapter,
  createTikTokAdapter,
  createXAdapter,
  createYouTubeAdapter,
  handlesOf,
  type KolChannelTransport,
  youtubeChannelUrl,
} from '../src/index.js'

const transport = (calls: unknown[]): KolChannelTransport => ({
  connected: () => true,
  call: async (input) => {
    calls.push(input)
    return { channels: [{ id: 'UCabcdefghijklmnopqrstuv', title: 'No Handle' }] } as never
  },
  now: () => '2026-10-19T00:00:00Z',
})

describe('WP416 YouTube 主页链接', () => {
  it('有自定义名用 /@name；没有用 /channel/UC…（不再拼成打不开的 /@UC…）', async () => {
    expect(youtubeChannelUrl({ handle: '@GadgetJonas', id: 'UC1' })).toBe(
      'https://www.youtube.com/@GadgetJonas',
    )
    expect(youtubeChannelUrl({ id: 'UCabc' })).toBe('https://www.youtube.com/channel/UCabc')
    const yt = createYouTubeAdapter(transport([]))
    const r = await yt.search({ q: 'desk' })
    expect(r.ok).toBe(true)
    if (r.ok)
      expect(r.data[0]?.url).toBe('https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv')
  })
})

describe('WP416 只能按账号查的三家：关键词照实说', () => {
  it('handlesOf：带 @ / 逗号 / 单个词 = 账号名；几个词空格隔开 = 关键词', () => {
    expect(handlesOf('@a @b', 25)).toEqual(['@a', '@b'])
    expect(handlesOf('a, b', 25)).toEqual(['a', 'b'])
    expect(handlesOf('gadgetjonas', 25)).toEqual(['gadgetjonas'])
    expect(handlesOf('skincare yoga', 25)).toBeUndefined()
    expect(handlesOf('   ', 25)).toBeUndefined()
  })

  for (const [name, make] of [
    ['Instagram', createInstagramAdapter],
    ['TikTok', createTikTokAdapter],
    ['X', createXAdapter],
  ] as const) {
    it(`${name}：「skincare yoga」不拆成 @skincare、@yoga 去查，回 handle_only 并指去插件 / 公共库`, async () => {
      const calls: unknown[] = []
      const adapter = make(transport(calls))
      const r = await adapter.search({ q: 'skincare yoga' })
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.reason).toBe('handle_only')
        expect(r.message).toContain('插件')
        expect(r.message).toContain('按关键词搜人')
      }
      expect(calls).toHaveLength(0)
    })
  }
})
