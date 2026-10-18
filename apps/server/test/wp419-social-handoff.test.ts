/**
 * WP419（决策 1231）：社媒发帖不走开发者应用——到点了、官方接口发不出去（没接 / 没批 / 不能代发），
 * **交给人在自己登录着的后台里发**：帖子挂上「交给你了」（不再按到点重发）、开一条待办兜底；
 * 人在插件侧边栏里回「发好了」（贴链接 = 读回确认；不贴 = 只记你说发了）/「不发了」，待办收掉、记发出记录。
 * 侧边栏那一行：发帖页只会是那几家的站，X / Threads / LinkedIn 正文预填。替身：不连任何平台。
 */
import type {
  ChangeKind,
  OutboundRecordInput,
  SocialPost,
  StagedChange,
  WorkspaceId,
} from '@agentsws/contracts'
import { hostAllowed, SOCIAL_COMPOSE_HOSTS, socialComposeUrl } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { panelPostOf } from '../src/extension-panel.js'
import { createSocialStore } from '../src/social.js'
import { createSocialChannels } from '../src/social-channels.js'
import { createSocialService } from '../src/social-service.js'

const WS = 'ws_1' as WorkspaceId
const NOW = '2026-10-19T04:00:00.000Z'

function harness() {
  const tasks: string[] = []
  const closed: string[] = []
  const sent: OutboundRecordInput[] = []
  const calls: string[] = []
  const store = createSocialStore({ workspace_id: WS })
  const channels = createSocialChannels({
    workspace_id: WS,
    clock: { now: () => NOW },
    connections: () => [],
    secrets: { available: true, get: () => undefined } as never,
    fetch: async (url) => {
      calls.push(url)
      return { ok: false, status: 500, text: async () => '', headers: { get: () => null } }
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
        throw new Error('不提变更')
      },
      list: async (f: { kind?: ChangeKind }) =>
        f.kind === 'social_post'
          ? (['sp_x', 'sp_fb', 'sp_ig'].map((post_id) => ({
              id: `chg_${post_id}`,
              workspace_id: WS,
              status: 'approved',
              after: { post_id },
            })) as unknown as StagedChange[])
          : [],
    },
    effectiveConfig: () => {
      throw new Error('不查生效配置')
    },
    appendEvent: () => {},
    random: () => 0.5,
    holdersOf: () => [],
    owner: async () => undefined,
    manualPublishTask: ({ post }) => {
      tasks.push(post.id)
      return { todo_id: `td_${post.id}`, owner: 'per_social' }
    },
    closeManualTask: (id) => {
      closed.push(id)
    },
    onSent: (r) => {
      sent.push(r)
    },
  })
  const acct = (id: string, channel: 'x' | 'facebook' | 'instagram', url: string) =>
    store.saveAccount({
      id,
      workspace_id: WS,
      channel,
      handle: id,
      display_name: `Nordvolt ${channel}`,
      url,
      external_id: '1',
      observed_at: NOW,
    })
  acct('sa_x', 'x', 'https://x.com/nordvolt')
  acct('sa_fb', 'facebook', 'https://www.facebook.com/nordvolt')
  acct('sa_ig', 'instagram', 'https://www.instagram.com/nordvolt')
  const post = (
    id: string,
    account_id: string,
    channel: SocialPost['channel'],
    extra: Partial<SocialPost> = {},
  ) =>
    store.savePost({
      id,
      account_id,
      channel,
      kind: 'post',
      status: 'scheduled',
      body: 'Weekend camping checklist & what we pack',
      scheduled_at: '2026-10-19T03:00:00.000Z',
      ...extra,
    } as SocialPost)
  return { store, service, tasks, closed, sent, calls, post }
}

describe('WP419 社媒发帖交给人：到点 → 交给你 → 发好了 / 不发了', () => {
  it('到点没接官方接口：挂上「交给你了」、开待办、不再重发；侧边栏那一行指向那家的发帖页', async () => {
    const h = harness()
    h.post('sp_x', 'sa_x', 'x')
    h.post('sp_fb', 'sa_fb', 'facebook')
    h.post('sp_ig', 'sa_ig', 'instagram', { kind: 'image', media_refs: ['asset_1'] })
    const out = await h.service.publishDue()
    expect(out.handed_off?.sort()).toEqual(['sp_fb', 'sp_ig', 'sp_x'])
    expect(out.published).toBe(0)
    expect(h.tasks.sort()).toEqual(['sp_fb', 'sp_ig', 'sp_x'])
    expect(h.store.post('sp_x')?.status).toBe('scheduled')
    expect(h.store.post('sp_x')?.handoff).toMatchObject({
      at: NOW,
      todo_id: 'td_sp_x',
      owner: 'per_social',
    })
    // 下一轮不再碰它们（不会开第二条待办）
    const again = await h.service.publishDue()
    expect(again.due).toBe(0)
    expect(h.tasks).toHaveLength(3)
    expect(h.service.handoffs()).toHaveLength(3)

    const x = panelPostOf(h.store.post('sp_x') as SocialPost, h.store.account('sa_x'))
    expect(x).toMatchObject({ channel: 'x', prefilled: true, owner: 'per_social', media: 0 })
    expect(x?.compose_url.startsWith('https://x.com/intent/post?text=Weekend%20camping')).toBe(true)
    const fb = panelPostOf(h.store.post('sp_fb') as SocialPost, h.store.account('sa_fb'))
    expect(fb).toMatchObject({ compose_url: 'https://www.facebook.com/nordvolt', prefilled: false })
    const ig = panelPostOf(h.store.post('sp_ig') as SocialPost, h.store.account('sa_ig'))
    expect(ig?.media).toBe(1)
  })

  it('发好了：贴链接 = 读回确认；不贴 = 只记你说发了；不发了 = 记没发；待办都收掉', async () => {
    const h = harness()
    h.post('sp_x', 'sa_x', 'x')
    h.post('sp_fb', 'sa_fb', 'facebook')
    h.post('sp_ig', 'sa_ig', 'instagram', { media_refs: ['asset_1'] })
    await h.service.publishDue()
    const x = h.service.answerHandoff('sp_x', {
      done: true,
      by: 'per_social',
      link: 'https://x.com/nordvolt/status/1',
    })
    expect(x).toMatchObject({
      status: 'published',
      published_via: 'extension',
      readback: 'link',
      post_url: 'https://x.com/nordvolt/status/1',
    })
    // 链接不是这几家的站：当没贴（不记一个外站链接）
    const fb = h.service.answerHandoff('sp_fb', {
      done: true,
      by: 'per_social',
      link: 'https://evil.example/x',
    })
    expect(fb).toMatchObject({ status: 'published', readback: 'self_report' })
    expect(fb?.post_url).toBeUndefined()
    const ig = h.service.answerHandoff('sp_ig', {
      done: false,
      by: 'per_social',
      reason: '素材没准备好',
    })
    expect(ig).toMatchObject({
      status: 'failed',
      failure_reason: '交给你发的这一条没发：素材没准备好',
    })
    expect(h.closed.sort()).toEqual(['td_sp_fb', 'td_sp_ig', 'td_sp_x'])
    expect(h.sent.map((r) => r.source_key).sort()).toEqual(['post:sp_fb', 'post:sp_x'])
    expect(h.sent.find((r) => r.source_key === 'post:sp_x')?.link).toBe(
      'https://x.com/nordvolt/status/1',
    )
    // 回过话的不能再回；没交给人的回 undefined
    expect(h.service.answerHandoff('sp_x', { done: true, by: 'per_social' })).toBeUndefined()
    expect(h.service.handoffs()).toHaveLength(0)
    expect(h.calls).toHaveLength(0)
  })

  it('发帖页只会是那几家的站；社群渠道没有发帖页', () => {
    for (const ch of ['x', 'threads', 'linkedin', 'facebook', 'instagram', 'tiktok', 'youtube']) {
      const c = socialComposeUrl(ch, 'hi')
      expect(c).toBeDefined()
      expect(hostAllowed(new URL(c?.url ?? '').hostname, SOCIAL_COMPOSE_HOSTS)).toBe(true)
    }
    expect(socialComposeUrl('facebook', 'hi', 'https://evil.example/')?.url).toBe(
      'https://www.facebook.com/',
    )
    expect(socialComposeUrl('discord', 'hi')).toBeUndefined()
  })
})
