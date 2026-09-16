/**
 * WP68：五条渠道真打出去的那一跳（`apps/server/src/kol-channels.ts`）。
 *
 * 这五家的接口没有可以随便调的沙箱，也不该在仓库里放真 key——所以"形状对不对"
 * 只能这么验：塞一个假 fetch，对着**真 URL 与真参数名**断言。断错了的代价是
 * 用户填完令牌之后看到一句"没给回数据"，然后找一整天。
 *
 * 顺带钉住两条纪律：凭据只从加密库取（没有就说没连），令牌不进任何错误信息。
 */
import { describe, expect, it } from 'vitest'
import { createKolChannels, type KolConnectionRef, type KolFetch } from '../src/kol-channels.js'
import { createSecretStore, SECRETS_KEY_ENV } from '../src/secret-store.js'

const T0 = '2026-09-15T09:00:00.000Z'
const KEY = 'd'.repeat(64)

const secretStore = () =>
  createSecretStore({
    dbPath: ':memory:',
    clock: { now: () => T0 },
    env: { [SECRETS_KEY_ENV]: KEY },
  })

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

function harness(
  options: {
    connections?: KolConnectionRef[]
    respond?: (call: Call) => { ok?: boolean; status?: number; text: string }
  } = {},
) {
  const calls: Call[] = []
  const secrets = secretStore()
  const connections = options.connections ?? [
    { id: 'conn_yt', service: 'youtube_data', status: 'connected' },
    { id: 'conn_fb', service: 'facebook_graph', status: 'connected' },
    { id: 'conn_ig', service: 'instagram_graph', status: 'connected' },
    { id: 'conn_tt', service: 'tiktok_research', status: 'connected' },
    { id: 'conn_x', service: 'x_api', status: 'connected' },
  ]
  secrets.put('conn_yt', { api_key: 'YT-SECRET' })
  secrets.put('conn_fb', { access_token: 'FB-SECRET' })
  secrets.put('conn_ig', { access_token: 'IG-SECRET', ig_user_id: '17841400000000000' })
  secrets.put('conn_tt', { access_token: 'TT-SECRET' })
  secrets.put('conn_x', { bearer_token: 'X-SECRET' })

  const fetchImpl: KolFetch = async (url, init) => {
    const call: Call = {
      url,
      method: init.method,
      headers: init.headers,
      ...(init.body === undefined ? {} : { body: init.body }),
    }
    calls.push(call)
    const out = options.respond?.(call) ?? { text: '{}' }
    return {
      ok: out.ok ?? true,
      status: out.status ?? 200,
      text: async () => out.text,
    }
  }

  const assembly = createKolChannels({
    workspace_id: 'ws_1' as never,
    clock: { now: () => T0 },
    connections: () => connections,
    secrets,
    fetch: fetchImpl,
  })
  return { ...assembly, calls, secrets }
}

describe('WP68 渠道 transport：真 URL 形状', () => {
  it('YouTube 搜人是两跳：search.list 拿 id，再用 channels.list 补粉丝数', async () => {
    const h = harness({
      respond: (call) =>
        call.url.includes('/search?')
          ? {
              text: JSON.stringify({
                items: [{ id: { channelId: 'UC_1' }, snippet: { title: 'Gadget Jonas' } }],
              }),
            }
          : {
              text: JSON.stringify({
                items: [
                  {
                    id: 'UC_1',
                    snippet: { title: 'Gadget Jonas', customUrl: '@gadgetjonas', country: 'DE' },
                    statistics: { subscriberCount: '48000' },
                    topicDetails: {
                      topicCategories: ['https://en.wikipedia.org/wiki/Technology'],
                    },
                  },
                ],
              }),
            },
    })
    const r = await h.adapters.youtube.search({ q: '桌面配件', limit: 10, region: 'DE' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data[0]?.handle).toBe('gadgetjonas')
      // 粉丝数只有第二跳才有——没有它打分那一项会直接 0 分，那不是事实
      expect(r.data[0]?.followers).toBe(48_000)
      expect(r.data[0]?.category).toBe('Technology')
      expect(r.data[0]?.region).toBe('DE')
    }
    expect(h.calls).toHaveLength(2)
    const first = new URL(h.calls[0]?.url as string)
    expect(first.origin + first.pathname).toBe('https://www.googleapis.com/youtube/v3/search')
    expect(first.searchParams.get('type')).toBe('channel')
    expect(first.searchParams.get('part')).toBe('snippet')
    expect(first.searchParams.get('maxResults')).toBe('10')
    expect(first.searchParams.get('regionCode')).toBe('DE')
    expect(first.searchParams.get('key')).toBe('YT-SECRET')
    const second = new URL(h.calls[1]?.url as string)
    expect(second.pathname).toBe('/youtube/v3/channels')
    expect(second.searchParams.get('id')).toBe('UC_1')
    expect(second.searchParams.get('part')).toBe('snippet,statistics,topicDetails')
  })

  it('YouTube 隐藏了订阅数的频道：那一格不出现，而不是写成 0', async () => {
    const h = harness({
      respond: () =>
        ({
          text: JSON.stringify({
            items: [{ id: 'UC_2', snippet: { title: '不公开订阅数', customUrl: '@quiet' } }],
          }),
        }) as never,
    })
    const r = await h.adapters.youtube.profile('@quiet')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.followers).toBeUndefined()
  })

  it('YouTube 按 handle 查用的是 forHandle（带 @）', async () => {
    const h = harness({
      respond: () => ({ text: JSON.stringify({ items: [{ id: 'UC_1', snippet: {} }] }) }),
    })
    await h.adapters.youtube.profile('gadgetjonas')
    expect(new URL(h.calls[0]?.url as string).searchParams.get('forHandle')).toBe('@gadgetjonas')
  })

  it('Facebook 搜主页：/pages/search + fields，令牌走 access_token', async () => {
    const h = harness({ respond: () => ({ text: JSON.stringify({ data: [] }) }) })
    await h.adapters.facebook.search({ q: '家居', limit: 5 })
    const u = new URL(h.calls[0]?.url as string)
    expect(u.origin + u.pathname).toBe('https://graph.facebook.com/v21.0/pages/search')
    expect(u.searchParams.get('q')).toBe('家居')
    expect(u.searchParams.get('limit')).toBe('5')
    expect(u.searchParams.get('fields')).toContain('followers_count')
    expect(u.searchParams.get('access_token')).toBe('FB-SECRET')
  })

  it('Instagram 的 business_discovery 挂在你自己那个商业账号下；少填 id 时说的是"补全那张卡"', async () => {
    const h = harness({
      respond: () =>
        ({
          text: JSON.stringify({
            business_discovery: { username: 'deskrosa', name: 'Desk Rosa', followers_count: 31000 },
          }),
        }) as never,
    })
    const r = await h.adapters.instagram.profile('@deskrosa')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.followers).toBe(31_000)
    const u = new URL(h.calls[0]?.url as string)
    expect(u.pathname).toBe('/v21.0/17841400000000000')
    expect(u.searchParams.get('fields')).toContain('business_discovery.username(deskrosa)')

    const missing = harness()
    missing.secrets.put('conn_ig', { access_token: 'IG-SECRET' })
    const bad = await missing.adapters.instagram.profile('@deskrosa')
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.message).toContain('IG 商业账号 id')
  })

  it('TikTok 是 POST /v2/research/user/info/，username 在 body 里，令牌走 Bearer', async () => {
    const h = harness({
      respond: () =>
        ({
          text: JSON.stringify({
            data: {
              username: 'cablekevin',
              display_name: 'Cable Kevin',
              follower_count: 200_000,
              likes_count: 4_000_000,
              video_count: 400,
            },
          }),
        }) as never,
    })
    const r = await h.adapters.tiktok.profile('@cablekevin')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.followers).toBe(200_000)
    const call = h.calls[0] as Call
    expect(call.method).toBe('POST')
    expect(new URL(call.url).pathname).toBe('/v2/research/user/info/')
    expect(new URL(call.url).searchParams.get('fields')).toContain('follower_count')
    expect(call.headers.authorization).toBe('Bearer TT-SECRET')
    expect(JSON.parse(call.body as string)).toEqual({ username: 'cablekevin' })
  })

  it('X 批量查走 /2/users/by?usernames=，单个查走 /2/users/by/username/:name', async () => {
    const h = harness({ respond: () => ({ text: JSON.stringify({ data: [] }) }) })
    await h.adapters.x.search({ q: '@gadgetjonas, deskrosa' })
    const batch = new URL(h.calls[0]?.url as string)
    expect(batch.origin + batch.pathname).toBe('https://api.x.com/2/users/by')
    expect(batch.searchParams.get('usernames')).toBe('gadgetjonas,deskrosa')
    expect(batch.searchParams.get('user.fields')).toContain('public_metrics')
    expect(h.calls[0]?.headers.authorization).toBe('Bearer X-SECRET')

    await h.adapters.x.profile('@gadgetjonas')
    expect(new URL(h.calls[1]?.url as string).pathname).toBe('/2/users/by/username/gadgetjonas')
  })

  it('基准本地永远没有：回 undefined 而不是报错（k-匿名在云上）', async () => {
    const h = harness()
    const r = await h.adapters.tiktok.benchmark(50_000)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data).toBeUndefined()
    // 一跳都没打出去
    expect(h.calls).toHaveLength(0)
  })
})

describe('WP68 渠道 transport：凭据与错误', () => {
  it('没有那条连接 = 没连，一跳都不打', async () => {
    const h = harness({ connections: [] })
    expect(h.transport.connected('youtube')).toBe(false)
    const r = await h.adapters.youtube.search({ q: 'x' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('not_connected')
    expect(h.calls).toHaveLength(0)
  })

  it('上游报权限错 → 适配器说"审核制"；令牌一个字符都不出现在错误里', async () => {
    const h = harness({
      respond: () => ({
        ok: false,
        status: 403,
        text: JSON.stringify({
          error: { message: 'Application does not have permission for this action', code: 10 },
        }),
      }),
    })
    const r = await h.adapters.facebook.search({ q: '家居' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('needs_approval')
      expect(r.message).toContain('审核制')
      expect(r.message).not.toContain('FB-SECRET')
    }
  })

  it('YouTube 报配额用完 → 说的是"全站一天 10000"，并给出还能干什么', async () => {
    const h = harness({
      respond: () => ({
        ok: false,
        status: 403,
        text: JSON.stringify({ error: { message: 'quotaExceeded', code: 403 } }),
      }),
    })
    const r = await h.adapters.youtube.profile('gadgetjonas')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('quota_exhausted')
      expect(r.message).toContain('10000')
      expect(r.message).toContain('导入')
    }
  })
})
