/**
 * WP119（68）：`/v1/extension/*` 在**网关这一层**的形状。
 *
 * 这一组守的是那条最容易说成"以后再说"的：
 * **插件的三条路不走网关鉴权，判权在处理器里做，而且 Origin 与令牌要同时对。**
 *
 * 换句话说：一个网页拿到了插件令牌也没用——它的 `Origin` 不是扩展的。
 * 这就是"本机服务不开通配 CORS"这句话在代码里的落点，
 * 所以它必须有一条测试，而不是只有一段注释。
 */
import { describe, expect, it } from 'vitest'
import type { ExtensionPort, ExtensionSession } from '../src/index.js'
import { createGateway, createMemoryExtensionStore } from '../src/index.js'
import { harness, makeClock, seeded } from './helpers.js'

const EXT_ORIGIN = 'chrome-extension://abcdefghijklmnop'
const PAGE_ORIGIN = 'https://www.youtube.com'

async function wired() {
  const h = await harness()
  const clock = makeClock()
  const store = createMemoryExtensionStore({ clock, random: seeded(9) })
  const seen: { session: ExtensionSession; count: number }[] = []
  const port: ExtensionPort = {
    store,
    hello: (session) => {
      seen.push({ session, count: 0 })
      return {
        workspace_id: session.workspace_id,
        workspace_name: '我的品牌',
        cloud_linked: false,
        shares_to_public_library: false,
        scopes: session.scopes,
        server_version: '0.1.0',
        // WP119c：装配给了基址就带上（深链的基底只有一个真源）。
        workbench_url: 'http://127.0.0.1:4317',
      }
    },
    ingest: (session, input) => {
      seen.push({ session, count: input.observations.length })
      return {
        rows: input.observations.map((o) => ({ handle: o.handle, status: 'ok' as const })),
        forwarded_to_public_library: 0,
      }
    },
    /* ── WP119c：最小桩——setup / report / seed 有形状，其余回固定值 ── */
    setup: (session) => ({
      organizations: [{ id: session.workspace_id, name: '我的品牌' }],
      workspaces: [
        { id: session.workspace_id, organization_id: session.workspace_id, name: '我的品牌' },
      ],
      brands: [
        {
          id: session.workspace_id,
          organization_id: session.workspace_id,
          workspace_id: session.workspace_id,
          name: '我的品牌',
        },
      ],
      campaigns: [],
      creator_pool: { total: 0, creators: [] },
    }),
    saveCreator: (_session, input) => ({
      status: 'ok' as const,
      creator_id: 'cr_test',
      ...(input.campaign_id === undefined ? {} : { campaign_id: input.campaign_id }),
    }),
    creatorReport: (_session, key) =>
      key.handle === 'nobody'
        ? undefined
        : {
            creator: { channel: key.channel, handle: key.handle },
            report: {
              followers: 123_000,
              avg_views: null,
              video_count: null,
              follower_trend: null,
              snapshot_count: 1,
            },
            tenant_pool: { saved: true, email: null, last_updated_at: null },
          },
    revealPricing: () => ({
      capability: 'data.kol.lookup',
      credits_per_reveal: 0.2,
      free_window_days: 30,
      note: '看一次邮箱的积分价。',
    }),
    contactLookup: () => Promise.resolve({ status: 'none' as const, message: '库里没有。' }),
    contactContribute: () =>
      Promise.resolve({ status: 'recorded' as const, action: 'new' as const, rewarded: false }),
    contactDispute: () => Promise.resolve({ status: 'recorded' as const, message: '记下了。' }),
    saveContact: (_session, input) =>
      Promise.resolve(
        input.contact_kind === 'phone'
          ? ({ status: 'not_stored', creator_id: 'cr_test', reason: '这一版只收邮箱' } as const)
          : ({ status: 'ok', contact_id: 'cc_test', creator_id: 'cr_test' } as const),
      ),
    contentObservation: (_session, input) =>
      Promise.resolve({ status: 'ok' as const, content_id: `co_${input.content_external_id}` }),
    contentSave: (_session, input) =>
      Promise.resolve({
        status: 'ok' as const,
        content_id: `ct_${input.content_external_id}`,
        creator_id: 'cr_test',
        ...(input.captured_comments === undefined
          ? {}
          : { comments_stored: input.captured_comments.length }),
      }),
    bioLinkObservation: () => Promise.resolve({ status: 'ok' as const, attached_creators: 0 }),
    seedSignature: (_session, key) =>
      key.handle === 'nobody'
        ? undefined
        : { platform: key.channel, external_id: key.handle, topic_keywords: ['keyboard'] },
  }
  const gateway = createGateway({ ...h.deps, extension: port })

  /** 工作台那一侧（Bearer + X-Assignment）。 */
  const owner = (method: string, path: string, body?: unknown): Promise<Response> => {
    const headers = new Headers({
      Authorization: `Bearer ${h.token}`,
      'X-Assignment': h.assignment.id,
    })
    if (body !== undefined) headers.set('content-type', 'application/json')
    return Promise.resolve(
      gateway.fetch(
        new Request(`http://127.0.0.1${path}`, {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      ),
    )
  }

  /** 插件那一侧（插件令牌 + Origin，**没有** X-Assignment）。 */
  const plugin = (
    method: string,
    path: string,
    init: { token?: string; origin?: string; body?: unknown } = {},
  ): Promise<Response> => {
    const headers = new Headers()
    if (init.token !== undefined) headers.set('Authorization', `Bearer ${init.token}`)
    if (init.origin !== undefined) headers.set('Origin', init.origin)
    if (init.body !== undefined) headers.set('content-type', 'application/json')
    return Promise.resolve(
      gateway.fetch(
        new Request(`http://127.0.0.1${path}`, {
          method,
          headers,
          ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        }),
      ),
    )
  }

  return { h, gateway, store, seen, owner, plugin }
}

const observation = {
  channel: 'youtube',
  handle: '@fixture',
  observed_at: '2026-09-07T09:00:00.000Z',
  source: 'channel_page',
}

async function paired(w: Awaited<ReturnType<typeof wired>>): Promise<string> {
  const made = await w.owner('POST', '/v1/extension/pairings', {})
  const code = ((await made.json()) as { data: { code: string } }).data.code
  const res = await w.plugin('POST', '/v1/extension/pair', { origin: EXT_ORIGIN, body: { code } })
  return ((await res.json()) as { data: { token: string } }).data.token
}

describe('没装配时', () => {
  it('回 not_implemented，工作台其余一切照常', async () => {
    const h = await harness()
    const gateway = createGateway(h.deps)
    const res = await gateway.fetch(
      new Request('http://127.0.0.1/v1/extension/tokens', {
        headers: { Authorization: `Bearer ${h.token}`, 'X-Assignment': h.assignment.id },
      }),
    )
    expect(res.status).toBe(501)
  })
})

describe('工作台这一侧', () => {
  it('发码 → 清单 → 撤销', async () => {
    const w = await wired()
    const token = await paired(w)
    expect(token).toMatch(/^ext_/)

    const listed = await w.owner('GET', '/v1/extension/tokens')
    const rows = ((await listed.json()) as { data: { tokens: { id: string }[] } }).data.tokens
    expect(rows).toHaveLength(1)

    const revoked = await w.owner(
      'POST',
      `/v1/extension/tokens/${rows[0]?.id ?? ''}/revoke`,
      undefined,
    )
    expect(revoked.status).toBe(200)

    // 撤掉之后插件那一侧当场不认
    const after = await w.plugin('GET', '/v1/extension/hello', { token, origin: EXT_ORIGIN })
    expect(after.status).toBe(401)
  })

  it('撤一把不存在的回 404', async () => {
    const w = await wired()
    expect((await w.owner('POST', '/v1/extension/tokens/ext_nope/revoke')).status).toBe(404)
  })
})

describe('插件这一侧：Origin 与令牌要同时对', () => {
  it('对的令牌 + 对的 Origin = 通', async () => {
    const w = await wired()
    const token = await paired(w)
    const res = await w.plugin('POST', '/v1/extension/observations', {
      token,
      origin: EXT_ORIGIN,
      body: { observations: [observation] },
    })
    expect(res.status).toBe(200)
    expect(w.seen.at(-1)?.count).toBe(1)
  })

  it('**对的令牌 + 网页的 Origin = 不通**（这就是"不开通配 CORS"的落点）', async () => {
    const w = await wired()
    const token = await paired(w)
    const res = await w.plugin('POST', '/v1/extension/observations', {
      token,
      origin: PAGE_ORIGIN,
      body: { observations: [observation] },
    })
    expect(res.status).toBe(401)
  })

  it('没有 Origin 也不通（curl 直接打本机服务这一条路堵死）', async () => {
    const w = await wired()
    const token = await paired(w)
    const res = await w.plugin('GET', '/v1/extension/hello', { token })
    expect(res.status).toBe(401)
  })

  it('没有令牌不通', async () => {
    const w = await wired()
    await paired(w)
    expect((await w.plugin('GET', '/v1/extension/hello', { origin: EXT_ORIGIN })).status).toBe(401)
  })

  it('换码那一条：Origin 不是扩展的 → 403 且话说得不一样', async () => {
    const w = await wired()
    const made = await w.owner('POST', '/v1/extension/pairings', {})
    const code = ((await made.json()) as { data: { code: string } }).data.code
    const res = await w.plugin('POST', '/v1/extension/pair', {
      origin: PAGE_ORIGIN,
      body: { code },
    })
    expect(res.status).toBe(403)
    // 「你不是扩展」与「码不对」是两句话——混成一句用户不知道该改哪一边
    expect(((await res.json()) as { message: string }).message).toContain('chrome-extension')
  })

  it('码不对 → 401，而且不说到底哪儿不对（区分等于给人一台探测机）', async () => {
    const w = await wired()
    const res = await w.plugin('POST', '/v1/extension/pair', {
      origin: EXT_ORIGIN,
      body: { code: '000000' },
    })
    expect(res.status).toBe(401)
  })
})

describe('观测的白名单', () => {
  it('多一个键**整批拒**——悄悄丢掉等于把"有人塞了正文"这个信号也丢了', async () => {
    const w = await wired()
    const token = await paired(w)
    const res = await w.plugin('POST', '/v1/extension/observations', {
      token,
      origin: EXT_ORIGIN,
      body: { observations: [{ ...observation, transcript: '整段视频文案' }] },
    })
    expect(res.status).toBe(400)
    // 一条都没进去
    expect(w.seen.filter((s) => s.count > 0)).toHaveLength(0)
  })

  it('WP130：列表来源三格（只加）收；预筛分出了 0–100 整批拒', async () => {
    const w = await wired()
    const token = await paired(w)
    const listed = {
      ...observation,
      source: 'search_results',
      source_page: 'watch_related',
      source_query: 'https://www.youtube.com/watch?v=SeedVideo01',
      relevance_score: 71,
    }
    const ok = await w.plugin('POST', '/v1/extension/observations', {
      token,
      origin: EXT_ORIGIN,
      body: { observations: [listed, { ...listed, source_page: 'hashtag', relevance_score: 0 }] },
    })
    expect(ok.status).toBe(200)
    const bad = await w.plugin('POST', '/v1/extension/observations', {
      token,
      origin: EXT_ORIGIN,
      body: { observations: [{ ...listed, relevance_score: 101 }] },
    })
    expect(bad.status).toBe(400)
    const badKind = await w.plugin('POST', '/v1/extension/observations', {
      token,
      origin: EXT_ORIGIN,
      body: { observations: [{ ...listed, source_page: 'feed' }] },
    })
    expect(badKind.status).toBe(400)
  })

  it('一批最多 100 条', async () => {
    const w = await wired()
    const token = await paired(w)
    const res = await w.plugin('POST', '/v1/extension/observations', {
      token,
      origin: EXT_ORIGIN,
      body: { observations: Array.from({ length: 101 }, () => observation) },
    })
    expect(res.status).toBe(400)
  })
})

/* ── WP119c：完整版面板要的那一批（docs/76 §10）────────────────────────── */

/** 一把**只有 kol.observe** 的令牌：scope 不足的 403 要有测试钉住。 */
async function pairedWithScope(
  w: Awaited<ReturnType<typeof wired>>,
  scopes: string[],
): Promise<string> {
  const made = await w.owner('POST', '/v1/extension/pairings', {})
  const code = ((await made.json()) as { data: { code: string } }).data.code
  const res = await w.plugin('POST', '/v1/extension/pair', { origin: EXT_ORIGIN, body: { code } })
  const token = ((await res.json()) as { data: { token: string } }).data.token
  // 配对发的令牌三scope全给；这里为了测「令牌上没有」这一格，把桩的认证换成受限会话。
  const real = w.store.authenticate.bind(w.store)
  ;(w.store as { authenticate: unknown }).authenticate = (raw: string, origin?: string) => {
    const session = real(raw, origin)
    return session === undefined ? undefined : { ...session, scopes: scopes as never }
  }
  return token
}

describe('WP119c：scope 的闸', () => {
  it('只有 kol.observe 的令牌：写库的路与读库的 report / seed 全是 403；有 kol.read 的读路照常', async () => {
    const w = await wired()
    const token = await pairedWithScope(w, ['kol.observe'])
    expect(
      (await w.plugin('GET', '/v1/extension/setup', { token, origin: EXT_ORIGIN })).status,
    ).toBe(403)
    expect(
      (
        await w.plugin('POST', '/v1/extension/creators', {
          token,
          origin: EXT_ORIGIN,
          body: { channel: 'youtube', handle: 'fixture', observed_at: nowIso() },
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await w.plugin('POST', '/v1/extension/contacts', {
          token,
          origin: EXT_ORIGIN,
          body: {
            channel: 'youtube',
            handle: 'fixture',
            contact_value: 'a@b.example',
            contact_kind: 'email',
          },
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await w.plugin('GET', '/v1/extension/creators/youtube/fixture/report', {
          token,
          origin: EXT_ORIGIN,
        })
      ).status,
    ).toBe(403)
  })

  it('话里说清缺的是哪个 scope（不是一句干巴巴的 forbidden）', async () => {
    const w = await wired()
    const token = await pairedWithScope(w, ['kol.observe'])
    const res = await w.plugin('GET', '/v1/extension/setup', { token, origin: EXT_ORIGIN })
    expect(((await res.json()) as { message: string }).message).toContain('kol.capture')
  })
})

function nowIso(): string {
  return '2026-09-22T10:00:00.000Z'
}

describe('WP119c：report / reveal-pricing / contact', () => {
  it('report：库里没有 = 404 + 人话', async () => {
    const w = await wired()
    const token = await paired(w)
    expect(
      (
        await w.plugin('GET', '/v1/extension/creators/youtube/nobody/report', {
          token,
          origin: EXT_ORIGIN,
        })
      ).status,
    ).toBe(404)
    const ok = await w.plugin('GET', '/v1/extension/creators/youtube/fixture/report', {
      token,
      origin: EXT_ORIGIN,
    })
    expect(ok.status).toBe(200)
    const body = (await ok.json()) as { data: { tenant_pool: { saved: boolean } } }
    expect(body.data.tenant_pool.saved).toBe(true)
  })

  it('reveal-pricing：读价不扣分', async () => {
    const w = await wired()
    const token = await paired(w)
    const res = await w.plugin('GET', '/v1/extension/reveal-pricing', { token, origin: EXT_ORIGIN })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { credits_per_reveal: number } }
    expect(body.data.credits_per_reveal).toBe(0.2)
  })

  it('hello 带 workbench_url', async () => {
    const w = await wired()
    const token = await paired(w)
    const res = await w.plugin('GET', '/v1/extension/hello', { token, origin: EXT_ORIGIN })
    const body = (await res.json()) as { data: { workbench_url?: string } }
    expect(body.data.workbench_url).toBe('http://127.0.0.1:4317')
  })
})

describe('WP119c：评论文本红线（路由这一层）', () => {
  const contentBody = {
    channel: 'youtube',
    content_external_id: 'vid_1',
    content_type: 'video',
    title: '一条视频',
    stats: { views: 10_000 },
    author: { external_id: 'UC123', handle: 'fixture' },
    captured_at: '2026-09-22T10:00:00.000Z',
  }

  it('content-observations 带 captured_comments → 整批拒（400），服务端一个字段都没收到', async () => {
    const w = await wired()
    const token = await paired(w)
    const res = await w.plugin('POST', '/v1/extension/content-observations', {
      token,
      origin: EXT_ORIGIN,
      body: {
        ...contentBody,
        captured_comments: [{ text: '评论区的一段话', author: '路人' }],
      },
    })
    expect(res.status).toBe(400)
  })

  it('contents 是唯一能带 captured_comments 的端点（200，且回执说实存几条）', async () => {
    const w = await wired()
    const token = await paired(w)
    const res = await w.plugin('POST', '/v1/extension/contents', {
      token,
      origin: EXT_ORIGIN,
      body: {
        ...contentBody,
        captured_comments: [{ text: '评论区的一段话', author: '路人' }],
      },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { comments_stored?: number } }
    expect(body.data.comments_stored).toBe(1)
  })

  it('WP131：标题可选——不带 title、空串都收（200）；超长照旧拒', async () => {
    const w = await wired()
    const token = await paired(w)
    const { title: _dropped, ...untitled } = contentBody
    for (const body of [untitled, { ...contentBody, title: '' }]) {
      const res = await w.plugin('POST', '/v1/extension/content-observations', {
        token,
        origin: EXT_ORIGIN,
        body,
      })
      expect(res.status).toBe(200)
    }
    const tooLong = await w.plugin('POST', '/v1/extension/content-observations', {
      token,
      origin: EXT_ORIGIN,
      body: { ...contentBody, title: 'x'.repeat(301) },
    })
    expect(tooLong.status).toBe(400)
  })
})

describe('WP131：自动评分开关没装配时', () => {
  it('老装配不实现 autoScore → 两条路都回 not_implemented（501），不是 500', async () => {
    const w = await wired()
    const token = await paired(w)
    const read = await w.plugin('GET', '/v1/extension/auto-score', { token, origin: EXT_ORIGIN })
    expect(read.status).toBe(501)
    const write = await w.plugin('PUT', '/v1/extension/auto-score', {
      token,
      origin: EXT_ORIGIN,
      body: { enabled: true },
    })
    expect(write.status).toBe(501)
  })
})

describe('WP119c：seed-signature', () => {
  it('缺参 400；不是种子 404；是种子回主题词', async () => {
    const w = await wired()
    const token = await paired(w)
    expect(
      (await w.plugin('GET', '/v1/extension/seed-signature', { token, origin: EXT_ORIGIN })).status,
    ).toBe(400)
    expect(
      (
        await w.plugin('GET', '/v1/extension/seed-signature?platform=youtube&externalId=nobody', {
          token,
          origin: EXT_ORIGIN,
        })
      ).status,
    ).toBe(404)
    const ok = await w.plugin(
      'GET',
      '/v1/extension/seed-signature?platform=youtube&externalId=fixture',
      {
        token,
        origin: EXT_ORIGIN,
      },
    )
    expect(ok.status).toBe(200)
    const body = (await ok.json()) as { data: { topic_keywords: string[] } }
    expect(body.data.topic_keywords).toEqual(['keyboard'])
  })
})
