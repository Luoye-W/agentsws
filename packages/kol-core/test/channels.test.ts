import { describe, expect, it } from 'vitest'
import {
  createFacebookAdapter,
  createInstagramAdapter,
  createTikTokAdapter,
  createUnlinkedPublicLibrary,
  createXAdapter,
  createYouTubeAdapter,
  type KolChannelTransport,
  NOT_LINKED_MESSAGE,
} from '../src/index.js'

const transport = (over: Partial<KolChannelTransport> = {}): KolChannelTransport => ({
  connected: () => true,
  call: async () => ({}) as never,
  now: () => '2026-09-15T00:00:00Z',
  ...over,
})

describe('渠道适配器（48 §5.2）：拿不到就说拿不到', () => {
  it('没连的时候一跳都不打，回的是人话', async () => {
    let called = 0
    const yt = createYouTubeAdapter(
      transport({
        connected: () => false,
        call: async () => {
          called += 1
          return {} as never
        },
      }),
    )
    const r = await yt.search({ q: '桌面' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('not_connected')
      expect(r.message).toContain('还没连上')
      // 没连也能用：这句话必须在
      expect(r.message).toContain('导入')
    }
    expect(called).toBe(0)
  })

  it('YouTube 搜出来的形状对得上 PlatformAccount，observed_at 从 transport 来', async () => {
    const yt = createYouTubeAdapter(
      transport({
        call: async () =>
          ({
            channels: [
              {
                handle: '@GadgetJonas',
                title: 'Gadget Jonas',
                subscriber_count: 48_000,
                country: 'de',
                topic: '数码',
              },
            ],
          }) as never,
      }),
    )
    const r = await yt.search({ q: '桌面' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.observed_at).toBe('2026-09-15T00:00:00Z')
    expect(r.data[0]).toMatchObject({
      channel: 'youtube',
      handle: 'gadgetjonas',
      display_name: 'Gadget Jonas',
      followers: 48_000,
      region: 'DE',
    })
  })

  it('YouTube 配额用完是自己一类，而且说清楚那是全站的配额', async () => {
    const yt = createYouTubeAdapter(
      transport({
        call: async () => {
          throw new Error('quotaExceeded')
        },
      }),
    )
    const r = await yt.benchmark(50_000)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('quota_exhausted')
      expect(r.message).toContain('10000')
    }
  })

  it('拿不到基准不是错：k-匿名基准在云上，本地拿不到是常态', async () => {
    const yt = createYouTubeAdapter(transport({ call: async () => undefined as never }))
    const r = await yt.benchmark(50_000)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data).toBeUndefined()
  })

  it('contact_hint 只说"在哪儿找"，不回明文', async () => {
    const yt = createYouTubeAdapter(transport({ call: async () => ({}) as never }))
    const r = await yt.contact_hint('gadgetjonas')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data[0]?.kind).toBe('email')
    expect(JSON.stringify(r.data)).not.toContain('@gmail')
    expect(r.data[0]?.how).toContain('人去拿')
  })

  it('IG 没有"按关键词搜人"这个接口——说出来，而不是返回空当作搜不到', async () => {
    const ig = createInstagramAdapter(transport({ call: async () => ({}) as never }))
    const r = await ig.search({ q: '   ' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain('按关键词搜人')
  })

  it('IG 按名字逐个查，查不到的那一个跳过，整批不失败', async () => {
    let n = 0
    const ig = createInstagramAdapter(
      transport({
        call: async () => {
          n += 1
          if (n === 2) throw new Error('not found')
          return { username: `user${n}`, followers_count: 100 } as never
        },
      }),
    )
    const r = await ig.search({ q: '@a, @b @c' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.map((h) => h.handle)).toEqual(['user1', 'user3'])
  })

  it('IG 权限没批下来是 needs_approval，不是"连接失败"', async () => {
    const ig = createInstagramAdapter(
      transport({
        call: async () => {
          throw new Error('(#10) Application does not have permission for this action')
        },
      }),
    )
    const r = await ig.profile('deskrosa')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('needs_approval')
  })

  it('IG 建联走 DM，并说明白"对方没开允许陌生人私信就可能没人看"', async () => {
    const ig = createInstagramAdapter(transport())
    const r = await ig.contact_hint('@deskrosa')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.map((h) => h.kind)).toEqual(['dm', 'email'])
      expect(r.data[0]?.how).toContain('请求箱')
    }
  })

  it('其余三条渠道：接口齐了，四个口子都回 not_implemented + 一句人话', async () => {
    for (const adapter of [createFacebookAdapter(), createTikTokAdapter(), createXAdapter()]) {
      for (const r of [
        await adapter.search({ q: 'x' }),
        await adapter.profile('x'),
        await adapter.benchmark(1),
        await adapter.contact_hint('x'),
      ]) {
        expect(r.ok, adapter.channel).toBe(false)
        if (r.ok) continue
        expect(r.reason, adapter.channel).toBe('not_implemented')
        expect(r.message, adapter.channel).toContain('WP68')
        // 职责本身照常能用，这句话不能少
        expect(r.message, adapter.channel).toContain('照常能用')
      }
    }
  })
})

describe('公共红人库客户端接口（48 §5.3 / 49 M2）', () => {
  it('没连就是没连：三个方法一致回 not_linked，不假装查过', async () => {
    const lib = createUnlinkedPublicLibrary()
    expect(lib.linked()).toBe(false)
    for (const r of [
      await lib.browse({}),
      await lib.audit({ channel: 'youtube', handle: 'x' }),
      await lib.reveal({ public_id: 'p1' }),
    ]) {
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.reason).toBe('not_linked')
        expect(r.message).toBe(NOT_LINKED_MESSAGE)
      }
    }
  })

  it('那句话里写明"没连也能用"——这是本地档的正常状态，不是故障', () => {
    expect(NOT_LINKED_MESSAGE).toContain('没连也能用')
  })
})
