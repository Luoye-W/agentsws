/**
 * WP191（docs/86 §4 / §6）服务进程这一侧的三件事：
 *
 * 1. **LinkedIn 到点发不出去 → 一条「复制文案去 LinkedIn 发」的待办**（没连、403 没批、
 *    带素材这一版还不能代发），帖子记 `failed` 并写清"已转成待办"，下一轮不再碰它；
 *    别的渠道照旧只记一句"没发"（不凭空多出待办）。
 * 2. **老库里 `channel: 'meta'` 的账号按 URL 迁到 FB 主页或 IG**，帖子 / 线程跟着账号走；可重复跑。
 * 3. **FB 主页与 IG 共用一条 `meta_graph` 连接**：连一次，两条渠道都算连上。
 *
 * 替身：注入的假 fetch 与假连接，一个真 key 都不用、一个包都不发出去。
 */
import type { ChangeKind, SocialPost, StagedChange, WorkspaceId } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { createSocialStore, migrateSupersededChannels } from '../src/social.js'
import { createSocialChannels } from '../src/social-channels.js'
import { createSocialService } from '../src/social-service.js'

const WS = 'ws_1' as WorkspaceId
const NOW = '2026-09-29T04:00:00.000Z'

const approved = (post_id: string) =>
  ({
    id: `chg_${post_id}`,
    workspace_id: WS,
    status: 'approved',
    after: { post_id },
  }) as unknown as StagedChange

function harness(options: {
  connections?: { id: string; service: string; status: string }[]
  respond?: (url: string) => { status: number; body?: string; headers?: Record<string, string> }
  changes?: StagedChange[]
  manual?: boolean
}) {
  const calls: string[] = []
  const tasks: { title: string; reason: string; body: string }[] = []
  const store = createSocialStore({ workspace_id: WS })
  const channels = createSocialChannels({
    workspace_id: WS,
    clock: { now: () => NOW },
    connections: () => options.connections ?? [],
    secrets: {
      available: true,
      get: () => ({ access_token: 'TEST-TOKEN', author_urn: 'urn:li:organization:42' }),
    } as unknown as Parameters<typeof createSocialChannels>[0]['secrets'],
    fetch: async (url) => {
      calls.push(url)
      const r = options.respond?.(url) ?? { status: 200, body: '{}' }
      const h = r.headers ?? {}
      return {
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        text: async () => r.body ?? '',
        headers: { get: (n: string) => h[n.toLowerCase()] ?? null },
      }
    },
  })
  const service = createSocialService({
    workspace_id: WS,
    store,
    channels,
    clock: { now: () => NOW },
    approvals: {} as never,
    ledger: {
      stage: async () => {
        throw new Error('这一份用例不提变更')
      },
      list: async (filter: { kind?: ChangeKind }) =>
        filter.kind === 'social_post' ? (options.changes ?? []) : [],
    },
    effectiveConfig: () => {
      throw new Error('这一份用例不查生效配置')
    },
    appendEvent: () => {},
    random: () => 0.5,
    holdersOf: () => [],
    owner: async () => undefined,
    ...(options.manual === false
      ? {}
      : {
          manualPublishTask: ({ post, channel_label, reason }) => {
            tasks.push({ title: `复制文案去 ${channel_label} 发`, reason, body: post.body })
            return { todo_id: `td_${tasks.length}` }
          },
        }),
  })
  return { store, service, channels, calls, tasks }
}

const account = (id: string, channel: 'linkedin' | 'discord' | 'meta', url: string) => ({
  id,
  workspace_id: WS,
  channel,
  handle: id,
  display_name: id,
  url,
  external_id: channel === 'linkedin' ? 'urn:li:organization:42' : '1',
  observed_at: NOW,
})

const due = (
  id: string,
  account_id: string,
  channel: SocialPost['channel'],
  extra: Partial<SocialPost> = {},
) =>
  ({
    id,
    account_id,
    channel,
    kind: 'post',
    status: 'scheduled',
    body: '我们为什么只做一种桌垫',
    scheduled_at: '2026-09-29T03:00:00.000Z',
    ...extra,
  }) as SocialPost

describe('WP191 LinkedIn：到点发不出去变成一条待办（docs/86 §4）', () => {
  it('没连上 LinkedIn：一跳都不打，开一条「复制文案去 LinkedIn 发」，帖子写清已转待办', async () => {
    const h = harness({ changes: [approved('sp_li')] })
    h.store.saveAccount(account('sa_li', 'linkedin', 'https://www.linkedin.com/company/nordvolt'))
    h.store.savePost(due('sp_li', 'sa_li', 'linkedin'))
    const out = await h.service.publishDue()
    expect(out.manual_tasks).toEqual([{ post_id: 'sp_li', todo_id: 'td_1' }])
    expect(h.tasks[0]?.title).toBe('复制文案去 LinkedIn 发')
    expect(h.tasks[0]?.body).toBe('我们为什么只做一种桌垫')
    expect(h.calls).toHaveLength(0)
    const post = h.store.post('sp_li')
    expect(post?.status).toBe('failed')
    expect(post?.failure_reason).toContain('已转成一条待办')
    // 下一轮不再碰它（不会开第二条待办）
    const again = await h.service.publishDue()
    expect(again.due).toBe(0)
    expect(h.tasks).toHaveLength(1)
  })

  it('连上了但公司主页没批（403）：同样转待办，原因是"要先过审核"那句人话', async () => {
    const h = harness({
      connections: [{ id: 'conn_li', service: 'linkedin_api', status: 'connected' }],
      respond: () => ({ status: 403 }),
      changes: [approved('sp_li')],
    })
    h.store.saveAccount(account('sa_li', 'linkedin', 'https://www.linkedin.com/company/nordvolt'))
    h.store.savePost(due('sp_li', 'sa_li', 'linkedin'))
    const out = await h.service.publishDue()
    expect(out.manual_tasks).toHaveLength(1)
    expect(h.tasks[0]?.reason).toContain('Community Management API')
    expect(h.calls).toEqual(['https://api.linkedin.com/rest/posts'])
  })

  it('连上且批了：真发出去，id 从响应头拿，不开待办', async () => {
    const h = harness({
      connections: [{ id: 'conn_li', service: 'linkedin_api', status: 'connected' }],
      respond: () => ({ status: 201, headers: { 'x-restli-id': 'urn:li:share:9' } }),
      changes: [approved('sp_li')],
    })
    h.store.saveAccount(account('sa_li', 'linkedin', 'https://www.linkedin.com/company/nordvolt'))
    h.store.savePost(due('sp_li', 'sa_li', 'linkedin'))
    const out = await h.service.publishDue()
    expect(out.published).toBe(1)
    expect(out.manual_tasks ?? []).toEqual([])
    expect(h.store.post('sp_li')?.external_id).toBe('urn:li:share:9')
  })

  it('没批的到点也不发、也不开待办（发布永远人审，门在"排"那一下）', async () => {
    const h = harness({ changes: [] })
    h.store.saveAccount(account('sa_li', 'linkedin', 'https://www.linkedin.com/company/nordvolt'))
    h.store.savePost(due('sp_li', 'sa_li', 'linkedin'))
    const out = await h.service.publishDue()
    expect(out.skipped).toHaveLength(1)
    expect(h.tasks).toHaveLength(0)
  })

  it('别的渠道没连上照旧只记一句"没发"——待办只给标了 manual_task 的渠道', async () => {
    const h = harness({ changes: [approved('sp_dc')] })
    h.store.saveAccount(account('sa_dc', 'discord', 'https://discord.gg/nordvolt'))
    h.store.savePost(due('sp_dc', 'sa_dc', 'discord'))
    const out = await h.service.publishDue()
    expect(h.tasks).toHaveLength(0)
    expect(out.failed + out.skipped.length).toBe(1)
  })
})

describe('WP191 老库里的 meta 账号迁到 FB 主页 / IG（docs/86 §6）', () => {
  it('按 URL 判：instagram.com → instagram，其余 → facebook；帖子与线程跟着账号走；可重复跑', () => {
    const store = createSocialStore({ workspace_id: WS })
    store.saveAccount(account('sa_fb', 'meta', 'https://www.facebook.com/nordvolt'))
    store.saveAccount(account('sa_ig', 'meta', 'https://www.instagram.com/nordvolt/'))
    store.savePost(due('sp_fb', 'sa_fb', 'meta', { status: 'published', metrics: { likes: 3 } }))
    store.savePost(due('sp_ig', 'sa_ig', 'meta'))
    store.saveThread({
      id: 'th_ig',
      account_id: 'sa_ig',
      channel: 'meta',
      external_id: 'c1',
      surface: 'comment',
      author_external_id: 'u1',
      author_handle: 'u1',
      text: '好看',
      created_at: NOW,
      status: 'open',
    })
    const out = migrateSupersededChannels(store)
    expect(out).toEqual({ accounts: 2, posts: 2, threads: 1, members: 0 })
    expect(store.account('sa_fb')?.channel).toBe('facebook')
    expect(store.account('sa_ig')?.channel).toBe('instagram')
    expect(store.post('sp_ig')?.channel).toBe('instagram')
    // 只改渠道那一格：数字、状态一个字没动
    expect(store.post('sp_fb')).toMatchObject({
      channel: 'facebook',
      status: 'published',
      metrics: { likes: 3 },
    })
    expect(store.thread('th_ig')?.channel).toBe('instagram')
    expect(store.accounts({ channel: 'meta' })).toEqual([])
    // 幂等
    expect(migrateSupersededChannels(store)).toEqual({
      accounts: 0,
      posts: 0,
      threads: 0,
      members: 0,
    })
  })
})

describe('WP191 FB 主页与 IG 共用一条 meta_graph 连接（连一次、批一次）', () => {
  it('一条 meta_graph 连接：facebook / instagram（以及老的 meta）都算连上；Threads 不算', () => {
    const h = harness({
      connections: [{ id: 'conn_meta', service: 'meta_graph', status: 'connected' }],
    })
    expect(h.channels.transport.connected('facebook')).toBe(true)
    expect(h.channels.transport.connected('instagram')).toBe(true)
    expect(h.channels.transport.connected('meta')).toBe(true)
    expect(h.channels.connectionOf('facebook')?.id).toBe(h.channels.connectionOf('instagram')?.id)
    // Threads 的授权是另一套：主页令牌调不动它
    expect(h.channels.transport.connected('threads')).toBe(false)
  })
})
