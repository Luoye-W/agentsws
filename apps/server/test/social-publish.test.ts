/**
 * WP73（56 §6 第四项）定时发布那一跳的**真调用**：`publishDue()`。
 *
 * 端到端那一份（`social-calendar.test.ts`）钉的是"没批的不发、没连上照实说"；
 * 这一份钉的是**发出去那一下真的按渠道适配器打了一跳**，以及回来之后库里那条
 * 怎么写。用的是一个注入的 `channels`（假 fetch + 假连接），所以一个真 key
 * 都不用、一个包都不发出去。
 *
 * 四件事：
 *
 * 1. 只发**已批准**的（账本说了算，不在社媒库那张表上另记一格）。
 * 2. 发出去之后写回 `published` + 平台给的 id + 发布时刻。
 * 3. 发失败写回 `failed` + **平台原话**，而且下一轮不会再发一遍。
 * 4. 这条渠道没有发布接口时照实记一句，**不当成失败**（那是"这件事在这条
 *    渠道上不存在"，与"这次没发成"不是一回事）。
 */
import type { ChangeKind, StagedChange, WorkspaceId } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { createSocialStore } from '../src/social.js'
import { createSocialChannels } from '../src/social-channels.js'
import { createSocialService } from '../src/social-service.js'

const WS = 'ws_1' as WorkspaceId
const NOW = '2026-09-15T04:00:00.000Z'

/** 一条"已经批过"的 `social_post` 变更（账本那一侧的样子）。 */
function approvedChange(
  post_id: string,
  status: StagedChange['status'] = 'approved',
): StagedChange {
  return {
    id: `chg_${post_id}`,
    workspace_id: WS,
    status,
    after: { post_id },
  } as unknown as StagedChange
}

function harness(
  options: {
    changes?: StagedChange[]
    respond?: (url: string) => { status: number; body: string }
  } = {},
) {
  const calls: { url: string; body?: string }[] = []
  const store = createSocialStore({ workspace_id: WS })
  const secrets = {
    available: true,
    get: () => ({ bot_token: 'DISCORD-TEST-TOKEN' }),
  } as unknown as Parameters<typeof createSocialChannels>[0]['secrets']

  const channels = createSocialChannels({
    workspace_id: WS,
    clock: { now: () => NOW },
    // 这个品牌"真有"一条 Discord 连接（`connected()` 看的就是它）
    connections: () => [{ id: 'conn_dc', service: 'discord_bot', status: 'connected' }],
    secrets,
    fetch: async (url, init) => {
      calls.push({ url, ...(init.body === undefined ? {} : { body: init.body }) })
      const r = options.respond?.(url) ?? { status: 200, body: '{"id":"dc_new"}' }
      return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => r.body }
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
  })

  store.saveAccount({
    id: 'sa_1',
    workspace_id: WS,
    channel: 'discord',
    handle: 'nordvolt-desk',
    display_name: 'Nordvolt 桌面党',
    url: 'https://discord.gg/nordvolt',
    external_id: '900000000000001/900000000000002',
    observed_at: NOW,
  })

  return { store, service, calls }
}

/** 一条到点了的排期。 */
const due = (id: string) =>
  ({
    id,
    account_id: 'sa_1',
    channel: 'discord' as const,
    kind: 'post' as const,
    status: 'scheduled' as const,
    body: '周四晚八点直播',
    scheduled_at: '2026-09-15T03:00:00.000Z',
  }) as const

describe('WP73 定时发布：真按适配器打那一跳', () => {
  it('批过的到点真发出去，写回 published + 平台给的 id', async () => {
    const h = harness({ changes: [approvedChange('sp_1')] })
    h.store.savePost(due('sp_1'))
    const out = await h.service.publishDue()
    expect(out).toMatchObject({ due: 1, published: 1, failed: 0 })
    // 真按 Discord 的形状打的（频道消息口，`Bot <token>` 那一条在 social-core 里钉着）
    expect(h.calls[0]?.url).toBe('https://discord.com/api/v10/channels/900000000000002/messages')
    expect(h.calls[0]?.body).toContain('周四晚八点直播')
    const row = h.store.post('sp_1')
    expect(row?.status).toBe('published')
    expect(row?.external_id).toBe('dc_new')
    expect(row?.published_at).toBe(NOW)
  })

  it('`auto_approved` 与 `applied` 也算批过（同一件事的三种落法）', async () => {
    const h = harness({
      changes: [approvedChange('sp_1', 'auto_approved'), approvedChange('sp_2', 'applied')],
    })
    h.store.savePost(due('sp_1'))
    h.store.savePost({ ...due('sp_2'), id: 'sp_2' })
    const out = await h.service.publishDue()
    expect(out.published).toBe(2)
  })

  it('还是 `staged` 的那一条到点了也不发（门在"排"那一下）', async () => {
    const h = harness({ changes: [approvedChange('sp_1', 'staged')] })
    h.store.savePost(due('sp_1'))
    const out = await h.service.publishDue()
    expect(out.published).toBe(0)
    expect(out.skipped[0]?.reason).toContain('还没人点头')
    expect(h.calls).toHaveLength(0)
  })

  it('发失败写回**平台原话**，而且下一轮不会再发一遍', async () => {
    const h = harness({
      changes: [approvedChange('sp_1')],
      respond: () => ({ status: 429, body: '{}' }),
    })
    h.store.savePost(due('sp_1'))
    const first = await h.service.publishDue()
    expect(first.failed).toBe(1)
    const row = h.store.post('sp_1')
    expect(row?.status).toBe('failed')
    expect(row?.failure_reason).toContain('太快了')
    // 它已经不是 `scheduled` 了 → 下一轮根本不在"到点了"那一批里
    const again = await h.service.publishDue()
    expect(again.due).toBe(0)
    expect(h.calls).toHaveLength(1)
  })

  it('这条渠道没有发布接口时照实记一句，**不当成失败**', async () => {
    const h = harness({ changes: [approvedChange('sp_1')] })
    h.store.saveAccount({
      id: 'sa_yt',
      workspace_id: WS,
      channel: 'youtube',
      handle: '@nordvolt',
      display_name: 'Nordvolt',
      url: 'https://youtube.com/@nordvolt',
      external_id: 'UC1',
      observed_at: NOW,
    })
    h.store.savePost({ ...due('sp_1'), account_id: 'sa_yt', channel: 'youtube' })
    const out = await h.service.publishDue()
    expect(out.failed).toBe(0)
    expect(out.published).toBe(0)
    // YouTube 发视频要 resumable upload，适配器上**故意没有** publish 这个口子
    expect(out.skipped[0]?.reason).toContain('发不出去')
    expect(h.store.post('sp_1')?.status).toBe('scheduled')
  })
})
