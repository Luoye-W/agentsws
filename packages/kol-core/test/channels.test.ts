import { describe, expect, it } from 'vitest'
import {
  createChannelAdapters,
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

  it('五条渠道都是同一个形状：没连就说没连，一跳都不打（WP68）', async () => {
    for (const make of [
      createYouTubeAdapter,
      createFacebookAdapter,
      createInstagramAdapter,
      createTikTokAdapter,
      createXAdapter,
    ]) {
      let called = 0
      const adapter = make(
        transport({
          connected: () => false,
          call: async () => {
            called += 1
            return {} as never
          },
        }),
      )
      for (const r of [
        await adapter.search({ q: 'x' }),
        await adapter.profile('x'),
        await adapter.benchmark(1),
        await adapter.contact_hint('x'),
      ]) {
        expect(r.ok, adapter.channel).toBe(false)
        if (r.ok) continue
        expect(r.reason, adapter.channel).toBe('not_connected')
      }
      expect(called, adapter.channel).toBe(0)
    }
  })

  it('Facebook：搜主页取的是关注数不是"赞过"，权限没批下来说的是审核制（WP68）', async () => {
    const fb = createFacebookAdapter(
      transport({
        call: async ({ action }) => {
          if (action !== 'search_pages') throw new Error('unexpected')
          return {
            data: [
              {
                id: '1',
                name: 'Nordic Desk',
                username: 'nordicdesk',
                // 2018 之后这两个数分家了：打分要看"有多少人会看到他发的东西"
                followers_count: 82_000,
                fan_count: 120_000,
                category: '家居',
                link: 'https://www.facebook.com/nordicdesk',
              },
            ],
          } as never
        },
      }),
    )
    const r = await fb.search({ q: '家居' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data[0]?.followers).toBe(82_000)
      expect(r.data[0]?.handle).toBe('nordicdesk')
    }
    const denied = createFacebookAdapter(
      transport({
        call: async () => {
          throw new Error('(#10) Application does not have permission for this action')
        },
      }),
    )
    const d = await denied.search({ q: '家居' })
    expect(d.ok).toBe(false)
    if (!d.ok) {
      expect(d.reason).toBe('needs_approval')
      expect(d.message).toContain('审核制')
    }
  })

  it('Facebook 建联走主页私信；"关于"里没公开邮箱就不编一条（WP68）', async () => {
    const withEmail = createFacebookAdapter(
      transport({ call: async () => ({ username: 'nordicdesk', emails: ['hi@x.com'] }) as never }),
    )
    const a = await withEmail.contact_hint('nordicdesk')
    expect(a.ok).toBe(true)
    if (a.ok) expect(a.data.map((h) => h.kind)).toEqual(['dm', 'email'])

    const without = createFacebookAdapter(
      transport({ call: async () => ({ username: 'nordicdesk' }) as never }),
    )
    const b = await without.contact_hint('nordicdesk')
    expect(b.ok).toBe(true)
    if (b.ok) expect(b.data.map((h) => h.kind)).toEqual(['dm'])
  })

  it('TikTok：没有关键词搜人这回事；互动率估不出来就没有这一格（WP68）', async () => {
    const tt = createTikTokAdapter(
      transport({
        call: async ({ params }) => {
          const username = (params as { username?: string }).username
          if (username === 'nobody') throw new Error('user not found')
          return {
            data: {
              display_name: 'Cable Kevin',
              username,
              follower_count: 200_000,
              likes_count: 4_000_000,
              video_count: 400,
            },
          } as never
        },
      }),
    )
    const r = await tt.search({ q: 'cablekevin, nobody' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      // 一个查不到不让整批失败
      expect(r.data).toHaveLength(1)
      // 人均获赞 10000 ÷ 20 万粉 = 0.05
      expect(r.data[0]?.engagement_rate).toBeCloseTo(0.05, 5)
    }

    const noMetrics = createTikTokAdapter(
      transport({ call: async () => ({ data: { username: 'a', follower_count: 100 } }) as never }),
    )
    const one = await noMetrics.profile('a')
    expect(one.ok).toBe(true)
    // 估不出来就没有这一格——0 会被打分当成"互动极差"，那是一句假话
    if (one.ok) expect(one.data.engagement_rate).toBeUndefined()
  })

  it('TikTok 申请没批下来：说的是申请制，不是"没连"（WP68）', async () => {
    const tt = createTikTokAdapter(
      transport({
        call: async () => {
          throw new Error('403 scope_not_authorized')
        },
      }),
    )
    const r = await tt.profile('cablekevin')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('needs_approval')
      expect(r.message).toContain('申请制')
      // 没有它这条职责照常能用，这句话不能少
      expect(r.message).toContain('照常能用')
    }
  })

  it('X：一跳批量查一串账号名；互动率这一格故意空着（WP68）', async () => {
    let seen: unknown
    const x = createXAdapter(
      transport({
        call: async ({ action, params }) => {
          expect(action).toBe('search_users')
          seen = (params as { usernames?: string }).usernames
          return {
            data: [
              {
                id: '7',
                name: 'Gadget Jonas',
                username: 'gadgetjonas',
                public_metrics: { followers_count: 31_000, tweet_count: 900 },
              },
            ],
          } as never
        },
      }),
    )
    const r = await x.search({ q: '@gadgetjonas, deskrosa' })
    expect(seen).toBe('gadgetjonas,deskrosa')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data[0]?.followers).toBe(31_000)
      // 单个用户接口拿不到近期帖子的互动数，所以不给一个编的
      expect(r.data[0]?.engagement_rate).toBeUndefined()
    }
  })

  it('X 的 403 说的是"要买档"，不是"去设置里开一下"（WP68）', async () => {
    const x = createXAdapter(
      transport({
        call: async () => {
          throw new Error('403 client-not-enrolled')
        },
      }),
    )
    const r = await x.profile('gadgetjonas')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('needs_approval')
      expect(r.message).toContain('付费')
    }
  })

  it('createChannelAdapters：一个 transport → 五条渠道，只有这一处按渠道分派（WP68）', () => {
    const all = createChannelAdapters(transport())
    expect(Object.keys(all).sort()).toEqual(['facebook', 'instagram', 'tiktok', 'x', 'youtube'])
    for (const [id, adapter] of Object.entries(all)) expect(adapter.channel).toBe(id)
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
