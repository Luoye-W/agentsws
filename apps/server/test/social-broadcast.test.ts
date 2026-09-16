/**
 * WP73（56 §6 第五项）群发向导：算受众 → 出卡 → 分批发。
 *
 * 钉六件事：
 *
 * 1. **受众三选一**（全员 / 标签 / 最近 30 天活跃），三条都只看群里那份名册。
 * 2. **抑制名单剔掉的人要报一个数**，哪怕是 0——"没问过"与"问过了没人"
 *    在群发这件事上必须分得开。
 * 3. **承诺词当场拦**：拦下来就不提卡，照实把那句话摆出来。
 * 4. **群发永远 L1**（`HARD_L1` 里有 `community_broadcast`）。
 * 5. **分批发**：每批 50、间隔 2 秒。
 * 6. **失败即停**：发到一半断了写回"发到第几个停的"，不接着发也不重试。
 */
import type { ChangeKind, StagedChange, WorkspaceId } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { createSocialStore, type SocialStore } from '../src/social.js'
import { createSocialChannels } from '../src/social-channels.js'
import {
  BROADCAST_BATCH_GAP_MS,
  BROADCAST_BATCH_SIZE,
  createSocialService,
} from '../src/social-service.js'

const WS = 'ws_1' as WorkspaceId
const NOW = '2026-09-15T04:00:00.000Z'

function harness(
  options: { changes?: StagedChange[]; respond?: () => { status: number; body: string } } = {},
) {
  const calls: { url: string; body?: string }[] = []
  const naps: number[] = []
  const staged: StagedChange[] = []
  const store = createSocialStore({ workspace_id: WS })

  const channels = createSocialChannels({
    workspace_id: WS,
    clock: { now: () => NOW },
    connections: () => [{ id: 'conn_dc', service: 'discord_bot', status: 'connected' }],
    secrets: {
      available: true,
      get: () => ({ bot_token: 'DISCORD-TEST-TOKEN' }),
    } as unknown as Parameters<typeof createSocialChannels>[0]['secrets'],
    fetch: async (url, init) => {
      calls.push({ url, ...(init.body === undefined ? {} : { body: init.body }) })
      const r = options.respond?.() ?? { status: 200, body: '{"id":"dc_new"}' }
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
      stage: async (input) => {
        const change = {
          id: `chg_${staged.length + 1}`,
          workspace_id: WS,
          status: 'staged',
          kind: input.kind,
          after: input.after,
        } as unknown as StagedChange
        staged.push(change)
        return {
          ok: true,
          change,
          approval: {
            id: `ap_${staged.length}`,
            summary: String(input.approval.summary),
            // `community_broadcast` 在 HARD_L1 里：报什么都按回 L1
            automation: { level_at_creation: 'L1' },
          },
        } as never
      },
      list: async (filter: { kind?: ChangeKind }) =>
        filter.kind === 'community_broadcast' ? (options.changes ?? []) : [],
    },
    effectiveConfig: () => {
      throw new Error('这一份用例不查生效配置')
    },
    appendEvent: () => {},
    random: () => 0.5,
    holdersOf: () => [],
    owner: async () => undefined,
    // 测试里不真等 2 秒，但**记下等了几次**——分批这件事要看得见
    sleep: async (ms) => {
      naps.push(ms)
    },
  })

  store.saveAccount({
    id: 'sa_1',
    workspace_id: WS,
    channel: 'discord',
    handle: 'nordvolt-desk',
    display_name: 'Nordvolt 桌面党',
    url: 'https://discord.gg/nordvolt',
    external_id: '900000000000001/900000000000002',
    member_count: 3,
    observed_at: NOW,
  })

  return { store, service, calls, naps, staged }
}

const actor = {
  workspace_id: WS,
  person_id: 'p_1' as never,
  assignment_id: 'as_1' as never,
  role_id: 'social.discord' as never,
}

/** 群里的几个人。 */
function seedMembers(store: SocialStore): void {
  const base = { account_id: 'sa_1', channel: 'discord' as const }
  store.saveMember({
    ...base,
    id: 'cm_1',
    external_id: 'u_1',
    handle: 'lina',
    status: 'active',
    last_active_at: NOW,
    tags: ['老客'],
  })
  store.saveMember({
    ...base,
    id: 'cm_2',
    external_id: 'u_2',
    handle: 'mike',
    status: 'active',
    last_active_at: '2026-06-01T00:00:00.000Z',
  })
  // 退群的那一个：抑制名单的默认来源
  store.saveMember({ ...base, id: 'cm_3', external_id: 'u_3', handle: 'kai', status: 'left' })
}

describe('WP73 群发向导：算受众与出卡', () => {
  it('全员：剔掉退群的那一个，受众数与剔除数都报出来', async () => {
    const h = harness()
    seedMembers(h.store)
    const view = await h.service.port.broadcast(actor, {
      account_id: 'sa_1',
      body: '【群公告】周四晚八点开一场桌面收纳直播。',
      audience: 'all',
    })
    expect(view.audience_size).toBe(2)
    // 退群的那个人本来就不在 `active` 里，所以剔除数是 0——**照实报 0**，
    // 不是"没查"（那两件事在群发上必须分得开）
    expect(view.suppressed).toBe(0)
    expect(view.note).toContain('2 人收')
    expect(view.staged.staged).toBe(true)
    // 群发永远 L1
    expect(view.staged.level).toBe('L1')
    // 受众数与剔除数**写在卡面上**
    expect(h.staged[0]?.after).toMatchObject({ audience_size: 2, suppression_checked: true })
  })

  it('抑制名单里的人真被剔掉，而且卡上说剔了几个', async () => {
    const h = harness()
    seedMembers(h.store)
    // 注入一份名单（现实里从退订 / 投诉那一侧来）
    const service = h.service
    const view = await service.port.broadcast(actor, {
      account_id: 'sa_1',
      body: '【群公告】周四直播。',
      audience: 'all',
    })
    expect(view.audience_size).toBe(2)
    const h2 = harness()
    seedMembers(h2.store)
    // 把 u_2 标成退群 → 它进默认抑制名单
    h2.store.saveMember({
      id: 'cm_2',
      account_id: 'sa_1',
      channel: 'discord',
      external_id: 'u_2',
      handle: 'mike',
      status: 'left',
    })
    const view2 = await h2.service.port.broadcast(actor, {
      account_id: 'sa_1',
      body: '【群公告】周四直播。',
      audience: 'all',
    })
    expect(view2.audience_size).toBe(1)
  })

  it('按标签 / 按活跃筛出来的是不同的两拨人', async () => {
    const h = harness()
    seedMembers(h.store)
    const tagged = await h.service.port.broadcast(actor, {
      account_id: 'sa_1',
      body: '【群公告】老客专场。',
      audience: 'tagged',
      tag: '老客',
    })
    expect(tagged.audience_size).toBe(1)
    const active = await h.service.port.broadcast(actor, {
      account_id: 'sa_1',
      body: '【群公告】周四直播。',
      audience: 'active_30d',
    })
    // mike 上次说话是 6 月，不在最近 30 天里
    expect(active.audience_size).toBe(1)
  })

  it('承诺词当场拦：**不提卡**，把那句话照实摆出来', async () => {
    const h = harness()
    seedMembers(h.store)
    const view = await h.service.port.broadcast(actor, {
      account_id: 'sa_1',
      body: '【群公告】周四直播。放心，我们会给你全额退款的。',
      audience: 'all',
    })
    expect(view.staged.staged).toBe(false)
    expect(view.problems.length).toBeGreaterThan(0)
    expect(h.staged).toHaveLength(0)
  })

  it('剔完一个人都不剩：照实说别发，不提一张发给零个人的卡', async () => {
    const h = harness()
    const view = await h.service.port.broadcast(actor, {
      account_id: 'sa_1',
      body: '【群公告】周四直播。',
      audience: 'all',
    })
    expect(view.audience_size).toBe(0)
    expect(view.problems.join(' ')).toContain('一个人都不剩')
    expect(view.staged.staged).toBe(false)
  })
})

describe('WP73 群发：批准之后分批发', () => {
  /** 一条"批过"的群发变更 + 库里那条排着的帖子。 */
  function ready(recipients: string[], options: Parameters<typeof harness>[0] = {}) {
    const after = {
      post_id: 'sb_1',
      channel: 'discord',
      account_id: 'sa_1',
      body: '【群公告】周四直播',
      audience: recipients,
      audience_size: recipients.length,
      suppression_checked: true,
    }
    const h = harness({
      ...options,
      changes: [
        { id: 'chg_1', workspace_id: WS, status: 'approved', after } as unknown as StagedChange,
      ],
    })
    h.store.savePost({
      id: 'sb_1',
      account_id: 'sa_1',
      channel: 'discord',
      kind: 'post',
      status: 'scheduled',
      body: '【群公告】周四直播',
      scheduled_at: NOW,
    })
    return h
  }

  it(`每批 ${BROADCAST_BATCH_SIZE} 个、间隔 ${BROADCAST_BATCH_GAP_MS / 1000} 秒`, async () => {
    const recipients = Array.from({ length: 120 }, (_, i) => `u_${i}`)
    const h = ready(recipients)
    const out = await h.service.broadcastDue()
    expect(out).toMatchObject({ due: 1, sent: 1, failed: 0 })
    // 120 个 → 三批（50 / 50 / 20），批与批之间等两次
    expect(h.calls).toHaveLength(3)
    expect(h.naps).toEqual([BROADCAST_BATCH_GAP_MS, BROADCAST_BATCH_GAP_MS])
    expect(h.store.post('sb_1')?.status).toBe('published')
  })

  it('失败即停：写回"发到第几个停的"，而且下一轮不再发', async () => {
    const recipients = Array.from({ length: 120 }, (_, i) => `u_${i}`)
    let n = 0
    const h = ready(recipients, {
      respond: () => {
        n += 1
        return n === 1 ? { status: 200, body: '{"id":"m1"}' } : { status: 429, body: '{}' }
      },
    })
    const out = await h.service.broadcastDue()
    expect(out.failed).toBe(1)
    expect(h.calls).toHaveLength(2)
    const row = h.store.post('sb_1')
    expect(row?.status).toBe('failed')
    expect(row?.failure_reason).toContain('发到第 1 个的时候停下来了')
    // 它已经不是 `scheduled` 了 → 下一轮根本不在那一批里
    const again = await h.service.broadcastDue()
    expect(again.due).toBe(0)
  })

  it('还没批过的那一条一跳都不打', async () => {
    const h = harness({
      changes: [
        {
          id: 'chg_1',
          workspace_id: WS,
          status: 'staged',
          after: { post_id: 'sb_1', audience: ['u_1'] },
        } as unknown as StagedChange,
      ],
    })
    h.store.savePost({
      id: 'sb_1',
      account_id: 'sa_1',
      channel: 'discord',
      kind: 'post',
      status: 'scheduled',
      body: 'x',
      scheduled_at: NOW,
    })
    const out = await h.service.broadcastDue()
    expect(out.due).toBe(0)
    expect(h.calls).toHaveLength(0)
  })
})
