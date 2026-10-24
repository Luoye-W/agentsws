/**
 * WP502：红人详情跟进三件事（起真进程 → 打 HTTP；图片全是本地假响应，一张都不去真网站取）。
 *
 * - **1760 B**：「存入红人池」那一刻把头像 / 横幅 / 前几张作品封面缓存到本机；详情与候选池给同源地址
 *   `/v1/kol/media/<id>`，那条路回字节。只认平台图片域名、四种位图、单张限大小；取不到不影响存入。
 * - **1763 B**：人工标签（整组换、去重、按标签筛、标签清单）与审核决定（通过 / 淘汰带理由 / 重置待审、按决定筛）；
 *   只在本机：不进付费云库的同步种类；`get_creator` 带这两样，`search_creators` 能按它们筛。
 * - **1764 B**：近期作品的原作品链接——送来的只认一条作品（规整掉参数），没送就从封面 / 短码推。
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Assignment, WorkspaceId } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import { createKolStore } from '../src/kol.js'
import { LOCAL_KINDS } from '../src/kol-cloud-sync.js'
import { createKolMediaCache, type KolMediaFetch, kolMediaIdOf } from '../src/kol-media.js'
import { createKolToolExecutor } from '../src/kol-tools.js'

const T0 = '2026-10-24T09:00:00.000Z'
const EXT_ORIGIN = 'chrome-extension://abcdefghijklmnop'

/** 一张「PNG」：文件头对得上就行（本地假字节，不是从哪儿下载来的）。 */
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
])
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>')

const AVATAR = 'https://yt3.ggpht.com/fixture-avatar=s176'
const BANNER = 'https://yt3.googleusercontent.com/fixture-banner=w1060'
const cover = (id: string): string => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`

/** 本地假下载器：按地址回固定字节，记下被要过哪些地址。 */
function fixtureFetch(table: Record<string, Uint8Array | number>): {
  fetch: KolMediaFetch
  asked: string[]
} {
  const asked: string[] = []
  const fetch: KolMediaFetch = async (url) => {
    asked.push(url)
    const hit = table[url]
    if (hit === undefined || typeof hit === 'number')
      return new Response(null, { status: typeof hit === 'number' ? hit : 404 })
    return new Response(hit, { status: 200, headers: { 'content-type': 'image/png' } })
  }
  return { fetch, asked }
}

let server: Server
let url: string
let youtube: Assignment
let fake: ReturnType<typeof fixtureFetch>

const owner = async (
  method: string,
  path: string,
  body?: unknown,
  assignment?: string,
): Promise<Response> => {
  const headers = new Headers({
    Authorization: `Bearer ${server.bootstrap.internalToken}`,
    'X-Assignment': assignment ?? youtube.id,
  })
  if (body !== undefined) headers.set('content-type', 'application/json')
  return fetch(`${url}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

const plugin = async (path: string, token: string | undefined, body: unknown): Promise<Response> =>
  fetch(`${url}${path}`, {
    method: 'POST',
    headers: {
      Origin: EXT_ORIGIN,
      'content-type': 'application/json',
      ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  })

const data = async <T>(res: Response): Promise<T> => {
  const parsed = (await res.json()) as { data?: T; code?: string; message?: string }
  if (parsed.data === undefined) throw new Error(`${parsed.code}：${parsed.message}`)
  return parsed.data
}

async function pairedToken(): Promise<string> {
  const made = await owner(
    'POST',
    '/v1/extension/pairings',
    {},
    server.bootstrap.ownerAssignment.id,
  )
  const { code } = await data<{ code: string }>(made)
  return (await data<{ token: string }>(await plugin('/v1/extension/pair', undefined, { code })))
    .token
}

interface Detail {
  creator: { id: string }
  accounts: { id: string }[]
  profiles?: Record<
    string,
    {
      avatar_media_url?: string
      banner_media_url?: string
      recent_items?: { title: string; url?: string; thumbnail_media_url?: string }[]
    }
  >
  tags?: string[]
  review?: { decision: string; reason?: string; decided_at: string }
}

/** 存入红人池那一刻起的取图是后台跑的：等到详情里出现同源地址（最多 2 秒）。 */
async function detailOnceCached(id: string): Promise<Detail> {
  for (let i = 0; i < 40; i++) {
    const d = await data<Detail>(await owner('GET', `/v1/kol/creators/${id}`))
    const p = d.profiles?.[d.accounts[0]?.id ?? '']
    if (p?.avatar_media_url !== undefined && p.banner_media_url !== undefined) return d
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('图片一直没缓存上')
}

const SAVE = {
  channel: 'youtube',
  handle: '@deskfixture',
  display_name: 'Desk Fixture',
  url: 'https://www.youtube.com/@deskfixture',
  followers: 123_000,
  avatar_url: AVATAR,
  banner_url: BANNER,
  observed_at: T0,
  source: 'manual_save',
  recent_items: [
    // 送来了链接（带分享参数）→ 规整
    {
      title: 'Desk setup guide',
      views: 39_000,
      thumbnail_url: cover('dfVid000001'),
      url: 'https://www.youtube.com/watch?v=dfVid000001&si=share&t=3',
    },
    // 没送链接 → 从封面推
    { title: 'Keyboards for beginners', views: 27_000, thumbnail_url: cover('dfVid000002') },
    // 送来的不是一条作品 → 丢掉，再从封面推
    {
      title: 'Lighting plan',
      thumbnail_url: cover('dfVid000003'),
      url: 'https://evil.example/watch?v=dfVid000003',
    },
    // 封面不在平台图片域名上：不缓存、推不出链接
    { title: 'Off-site cover', thumbnail_url: 'https://cdn.evil.example/x.png' },
    // 封面是 SVG（对方说是 PNG）：按文件头认，不收
    { title: 'Sneaky cover', thumbnail_url: cover('dfVid000005') },
  ],
}

beforeEach(async () => {
  fake = fixtureFetch({
    [AVATAR]: PNG,
    [BANNER]: PNG,
    [cover('dfVid000001')]: PNG,
    [cover('dfVid000002')]: PNG,
    [cover('dfVid000003')]: 500,
    [cover('dfVid000005')]: SVG,
  })
  server = await createServer({
    quiet: true,
    clock: { now: () => T0 },
    random: (() => {
      let a = 502
      return () => {
        a = (a * 16807) % 2147483647
        return a / 2147483647
      }
    })(),
    scheduleIntervalMs: 0,
    startRun: false,
    kolMedia: { fetch: fake.fetch },
    env: { AGENTSWS_OWNER_EMAIL: 'luoye@example.com', AGENTSWS_SECRETS_KEY: 'c'.repeat(64) },
  })
  ;({ url } = await server.listen(0))
  youtube = server.roles.assignments.create({
    person_id: server.bootstrap.person.id,
    workspace_id: server.bootstrap.workspace.id,
    role_id: 'kol.youtube',
    granted_by: server.bootstrap.person.id,
    ranges: [{ kind: 'store', id: 'store_1' }],
  })
})

afterEach(async () => {
  await server.close()
})

async function saveFixture(): Promise<string> {
  const token = await pairedToken()
  const res = await plugin('/v1/extension/creators', token, SAVE)
  expect(res.status).toBe(200)
  return (await data<{ creator_id: string }>(res)).creator_id
}

describe('1760 B：存入红人池时把图缓存到本机，界面走同源地址', () => {
  it('头像 / 横幅 / 封面缓存了，详情与候选池给 /v1/kol/media/<id>，那条路回字节', async () => {
    const id = await saveFixture()
    const detail = await detailOnceCached(id)
    const profile = detail.profiles?.[detail.accounts[0]?.id ?? '']
    expect(profile?.avatar_media_url).toBe(`/v1/kol/media/${kolMediaIdOf(AVATAR)}`)
    expect(profile?.banner_media_url).toBe(`/v1/kol/media/${kolMediaIdOf(BANNER)}`)
    const items = profile?.recent_items ?? []
    expect(items[0]?.thumbnail_media_url).toBe(
      `/v1/kol/media/${kolMediaIdOf(cover('dfVid000001'))}`,
    )
    expect(items[1]?.thumbnail_media_url).toBeDefined()
    // 500 的、外站的、SVG 冒充 PNG 的：都没有
    expect(items[2]?.thumbnail_media_url).toBeUndefined()
    expect(items[3]?.thumbnail_media_url).toBeUndefined()
    expect(items[4]?.thumbnail_media_url).toBeUndefined()
    // 外站封面一次都没去要
    expect(fake.asked).not.toContain('https://cdn.evil.example/x.png')

    const img = await owner('GET', profile?.avatar_media_url as string)
    expect(img.status).toBe(200)
    expect(img.headers.get('content-type')).toBe('image/png')
    expect(img.headers.get('x-content-type-options')).toBe('nosniff')
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(PNG)

    // 候选池卡片也拿得到头像
    const list = await data<{ rows: { creator_id: string; avatar_media_url?: string }[] }>(
      await owner('GET', '/v1/kol/creators?channel=youtube'),
    )
    expect(list.rows.find((r) => r.creator_id === id)?.avatar_media_url).toBe(
      profile?.avatar_media_url,
    )
  })

  it('图要登录令牌；认不出的 id / 没有的图 → 404', async () => {
    await saveFixture()
    const anon = await fetch(`${url}/v1/kol/media/${kolMediaIdOf(AVATAR)}`)
    expect(anon.status).toBe(401)
    expect((await owner('GET', '/v1/kol/media/not-an-id')).status).toBe(404)
    expect((await owner('GET', `/v1/kol/media/${'0'.repeat(32)}`)).status).toBe(404)
  })
})

describe('1760 B：缓存那一层的几道闸（直接测 kol-media）', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('落盘、重启后还认得；同一个地址只取一次', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp502-media-'))
    dirs.push(dir)
    const f = fixtureFetch({ [AVATAR]: PNG })
    const one = createKolMediaCache({ dir, fetch: f.fetch })
    await Promise.all([one.cache([AVATAR]), one.cache([AVATAR, AVATAR])])
    expect(f.asked).toEqual([AVATAR])
    expect(readdirSync(dir)).toEqual([`${kolMediaIdOf(AVATAR)}.png`])
    const again = createKolMediaCache({ dir })
    expect(again.localUrlOf(AVATAR)).toBe(`/v1/kol/media/${kolMediaIdOf(AVATAR)}`)
    expect(again.read(kolMediaIdOf(AVATAR))?.content_type).toBe('image/png')
  })

  it('超过单张上限不存；跳转到白名单外的域名不存；http 不认；没给下载器就不下载', async () => {
    const big = new Uint8Array(64)
    big.set(PNG)
    const capped = createKolMediaCache({
      fetch: fixtureFetch({ [AVATAR]: big }).fetch,
      maxBytes: 32,
    })
    await capped.cache([AVATAR])
    expect(capped.localUrlOf(AVATAR)).toBeUndefined()

    const redirected = createKolMediaCache({
      fetch: async () => {
        const r = new Response(PNG, { status: 200 })
        Object.defineProperty(r, 'url', { value: 'https://elsewhere.example/a.png' })
        return r
      },
    })
    await redirected.cache([AVATAR])
    expect(redirected.localUrlOf(AVATAR)).toBeUndefined()

    const f = fixtureFetch({ 'http://yt3.ggpht.com/a': PNG })
    const plain = createKolMediaCache({ fetch: f.fetch })
    await plain.cache(['http://yt3.ggpht.com/a'])
    expect(f.asked).toEqual([])

    const off = createKolMediaCache({})
    await off.cache([AVATAR])
    expect(off.localUrlOf(AVATAR)).toBeUndefined()
  })

  it('下载器抛错 / 超时：不抛出来', async () => {
    const boom = createKolMediaCache({
      fetch: async () => {
        throw new Error('network down')
      },
    })
    await expect(boom.cache([AVATAR])).resolves.toBeUndefined()
    const slow = createKolMediaCache({
      timeoutMs: 20,
      fetch: (_u, init) =>
        new Promise((_, reject) => {
          init.signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          )
        }),
    })
    await expect(slow.cache([AVATAR])).resolves.toBeUndefined()
  })
})

describe('1764 B：近期作品的原作品链接', () => {
  it('送来的规整、认不出的丢掉再推、推不出来就不带', async () => {
    const id = await saveFixture()
    const d = await data<Detail>(await owner('GET', `/v1/kol/creators/${id}`))
    const items = d.profiles?.[d.accounts[0]?.id ?? '']?.recent_items ?? []
    expect(items.map((r) => r.url)).toEqual([
      'https://www.youtube.com/watch?v=dfVid000001',
      'https://www.youtube.com/watch?v=dfVid000002',
      'https://www.youtube.com/watch?v=dfVid000003',
      undefined,
      'https://www.youtube.com/watch?v=dfVid000005',
    ])
  })
})

describe('1763 B：人工标签与审核决定', () => {
  it('标签整组换、去重去空白、按标签筛、清单给下拉；审核通过 / 淘汰带理由 / 重置待审、按决定筛', async () => {
    const id = await saveFixture()
    const other = (
      await data<{ creator: { id: string } }>(
        await owner('POST', '/v1/kol/creators', {
          display_name: 'Other Person',
          channel: 'youtube',
          handle: '@other',
        }),
      )
    ).creator.id

    const tagged = await data<Detail>(
      await owner('PUT', `/v1/kol/creators/${id}/tags`, {
        tags: ['  桌搭 ', '桌搭', 'Keyboard', 'keyboard', '', '德国   区'],
      }),
    )
    expect(tagged.tags).toEqual(['桌搭', 'Keyboard', '德国 区'])

    const byTag = await data<{ rows: { creator_id: string; tags?: string[] }[]; tags?: string[] }>(
      await owner('GET', `/v1/kol/creators?channel=youtube&tag=${encodeURIComponent('keyboard')}`),
    )
    expect(byTag.rows.map((r) => r.creator_id)).toEqual([id])
    expect(byTag.rows[0]?.tags).toEqual(['桌搭', 'Keyboard', '德国 区'])
    expect(byTag.tags).toEqual(['Keyboard', '德国 区', '桌搭'].sort((a, b) => a.localeCompare(b)))

    const rejected = await data<Detail>(
      await owner('PUT', `/v1/kol/creators/${id}/review`, {
        decision: 'rejected',
        reason: '  受众不在欧洲  ',
      }),
    )
    expect(rejected.review).toEqual({
      decision: 'rejected',
      reason: '受众不在欧洲',
      decided_at: T0,
    })

    const pending = await data<{ rows: { creator_id: string }[] }>(
      await owner('GET', '/v1/kol/creators?channel=youtube&review=pending'),
    )
    expect(pending.rows.map((r) => r.creator_id)).toEqual([other])
    const rej = await data<{ rows: { creator_id: string; review?: { decision: string } }[] }>(
      await owner('GET', '/v1/kol/creators?channel=youtube&review=rejected'),
    )
    expect(rej.rows.map((r) => [r.creator_id, r.review?.decision])).toEqual([[id, 'rejected']])

    const approved = await data<Detail>(
      await owner('PUT', `/v1/kol/creators/${other}/review`, { decision: 'approved' }),
    )
    expect(approved.review).toEqual({ decision: 'approved', decided_at: T0 })

    const reset = await data<Detail>(
      await owner('PUT', `/v1/kol/creators/${id}/review`, { decision: 'pending' }),
    )
    expect(reset.review).toBeUndefined()
    const cleared = await data<Detail>(
      await owner('PUT', `/v1/kol/creators/${id}/tags`, { tags: [] }),
    )
    expect(cleared.tags).toBeUndefined()

    expect((await owner('GET', '/v1/kol/creators?review=maybe')).status).toBe(400)
    expect(
      (await owner('PUT', '/v1/kol/creators/cr_nobody/review', { decision: 'approved' })).status,
    ).toBe(404)
  })

  it('get_creator 带 tags / review；search_creators 给了 tag / review 只查本机库', async () => {
    const id = await saveFixture()
    await owner('PUT', `/v1/kol/creators/${id}/tags`, { tags: ['桌搭'] })
    await owner('PUT', `/v1/kol/creators/${id}/review`, {
      decision: 'approved',
      reason: '内容对路',
    })
    const brand = await server.brands.forWorkspace(server.bootstrap.workspace.id)
    const exec = createKolToolExecutor({
      workspace_id: server.bootstrap.workspace.id,
      port: () => brand.kolService.port,
      now: () => T0,
    })
    const request = {
      actor: {
        person_id: server.bootstrap.person.id,
        assignment_id: youtube.id,
        role_id: 'kol.youtube',
      },
    } as never
    const got = await exec({ name: 'get_creator', input: { creator_id: id }, request })
    expect((got.data as Detail).tags).toEqual(['桌搭'])
    expect((got.data as Detail).review).toMatchObject({ decision: 'approved', reason: '内容对路' })

    const found = await exec({
      name: 'search_creators',
      input: { tag: '桌搭', review: 'approved' },
      request,
    })
    const out = found.data as { rows: { creator_id: string }[]; source: string; criteria: string }
    expect(out.source).toBe('local_library')
    expect(out.rows.map((r) => r.creator_id)).toEqual([id])
    expect(out.criteria).toBe('标签「桌搭」 · 已通过')
    const none = await exec({ name: 'search_creators', input: { review: 'rejected' }, request })
    expect((none.data as { rows: unknown[] }).rows).toEqual([])
  })
})

describe('1763 B：只在本机，合并时跟着走', () => {
  it('不在付费云库的同步种类里', () => {
    expect(LOCAL_KINDS as readonly string[]).not.toContain('creator_tag')
    expect(LOCAL_KINDS as readonly string[]).not.toContain('creator_review')
  })

  it('合并：标签取并集，审核决定以保留那条为准（它没定过才用被合掉那条的）', () => {
    const kol = createKolStore({ workspace_id: 'ws_1' as WorkspaceId, now: () => T0 })
    kol.saveCreator({ id: 'cr_a', display_name: 'A', merged_from: [] })
    kol.saveCreator({ id: 'cr_b', display_name: 'B', merged_from: [] })
    kol.saveCreatorTags({ id: 'cr_a', creator_id: 'cr_a', tags: ['桌搭'], updated_at: T0 })
    kol.saveCreatorTags({
      id: 'cr_b',
      creator_id: 'cr_b',
      tags: ['桌搭', '德国'],
      updated_at: T0,
    })
    kol.saveCreatorReview({ id: 'cr_b', creator_id: 'cr_b', decision: 'rejected', decided_at: T0 })
    kol.merge({ keep_id: 'cr_a', merge_id: 'cr_b' })
    expect(kol.creatorTags('cr_a')[0]?.tags).toEqual(['桌搭', '德国'])
    expect(kol.creatorReviews('cr_a')[0]?.decision).toBe('rejected')
    expect(kol.creatorTags('cr_b')).toEqual([])
    expect(kol.creatorReviews('cr_b')).toEqual([])
  })
})
