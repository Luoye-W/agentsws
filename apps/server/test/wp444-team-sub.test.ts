/**
 * WP444（决策 1377–1381）：团队通道做成增值服务——本机这一侧。
 *
 * 用云端替身（`team-relay.ts`，`subscriptions: 'required'` = 照真云：没开通申请通道 402）真起一个回环服务：
 * 1. 没开通：通道停在 `needs_subscription`（云那句人话原样带回来），不退避狂试；
 * 2. 开通（7 天试用）→ `retryNow` 马上重新申请 → 连上；同事经通道打得通；
 * 3. 宽限过了（替身拨成 suspended）：连接被断、同事看到 503 + `x-agentsws-team-off: subscription`；
 *    本机重连被拒 → 重新申请 → 402 → 又停在 `needs_subscription`；
 * 4. 同事那边问「批了没有」撞上这一页 → `channel_off`（不是「连不上」）；
 * 5. 订阅客户端：没关联 / 开通 / 人数变了才报；铃铛那一条：试用快结束、宽限、已关、长期免费不打扰。
 *
 * 端口：替身固定 4655（本单只用 4652–4655）。
 */
import {
  DEFAULT_TEAM_PRICING,
  TEAM_SUB_NOTICE_KEYS,
  type TeamSubscriptionView,
} from '@agentsws/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { startTeamRelayStandIn, type TeamRelayStandIn } from '../src/team-relay.js'
import { createTeamSubscriptionClient, teamSubscriptionNotice } from '../src/team-subscription.js'
import { createTeamTunnel, type TeamTunnel } from '../src/team-tunnel.js'

const PORT = 4655
let relay: TeamRelayStandIn | undefined
let tunnel: TeamTunnel | undefined

afterEach(async () => {
  tunnel?.stop()
  tunnel = undefined
  await relay?.close()
  relay = undefined
})

const until = async (check: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('等太久了')
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe('WP444 跨网通道要先开通（经云端替身真连）', () => {
  it('没开通停在 needs_subscription → 开通后马上连上 → 到期断开、同事看到「未开通 / 已到期」→ 又停回去', async () => {
    relay = await startTeamRelayStandIn({ port: PORT, subscriptions: 'required' })
    const base = relay.base
    let vault: { tunnel_id: string; url: string; secret: string } | undefined
    const token = 'wst_team_owner'
    const sub = createTeamSubscriptionClient({
      cloudBase: () => base,
      token: () => token,
      members: async () => 4,
      onView: (v) => {
        if (v.usable) tunnel?.retryNow()
      },
    })
    tunnel = createTeamTunnel({
      cloudBase: () => base,
      token: () => token,
      vault: { get: () => vault, set: (v) => (vault = v) },
      handler: async () => new Response('ok from owner'),
      members: () => 4,
      idleRetryMs: 60_000,
    })
    tunnel.start()
    await until(() => tunnel?.state() === 'needs_subscription')
    expect(tunnel.reason()).toContain('7 天免费试用')
    expect(vault).toBeUndefined()

    const before = await sub.view()
    expect(before.subscription).toMatchObject({ status: 'none', trial_available: true, members: 4 })
    expect(before.subscription?.tier).toEqual({ members: 5, credits: 68, extra_members: 0 })

    const opened = await sub.subscribe()
    expect(opened.subscription).toMatchObject({ status: 'trial', usable: true })
    expect(await tunnel.whenOnline(5000)).toBe(true)
    const url = tunnel.url() as string
    const ok = await fetch(`${url}/`)
    expect(await ok.text()).toBe('ok from owner')

    // 宽限过了：替身把这个组织拨成 suspended → 连接断、同事看到「未开通 / 已到期」
    relay.setSubscription(token, 'suspended')
    const off = await fetch(`${url}/`)
    expect(off.status).toBe(503)
    expect(off.headers.get('x-agentsws-team-off')).toBe('subscription')
    expect(await off.text()).toContain('未开通或已到期')
    await until(() => tunnel?.state() === 'needs_subscription', 8000)
    expect(tunnel.reason()).toContain('已到期')

    // 续费：马上恢复
    await sub.subscribe()
    expect(await tunnel.whenOnline(5000)).toBe(true)
    expect((await fetch(`${tunnel.url() as string}/`)).status).toBe(200)
  })

  it('订阅客户端：没关联说人话、不打云；人数没变不报、变了报', async () => {
    relay = await startTeamRelayStandIn({ port: PORT, subscriptions: 'required' })
    const base = relay.base
    let token: string | undefined
    let members = 3
    const sub = createTeamSubscriptionClient({
      cloudBase: () => base,
      token: () => token,
      members: async () => members,
    })
    const unlinked = await sub.view()
    expect(unlinked).toEqual({ linked: false, reason: expect.stringContaining('登录工坊账号') })
    token = 'wst_x'
    await sub.subscribe()
    expect(await sub.reportMembers()).toBe(false)
    members = 9
    expect(await sub.reportMembers()).toBe(true)
    expect(sub.last()?.tier.credits).toBe(120)
  })
})

describe('WP444 团队通道进铃铛（类别「积分」）', () => {
  const base: TeamSubscriptionView = {
    service_id: 'team.channel.monthly',
    status: 'active',
    usable: true,
    comped: false,
    trial_available: false,
    cancel_at_period_end: false,
    members: 4,
    tier: { members: 5, credits: 68, extra_members: 0 },
    pricing: DEFAULT_TEAM_PRICING,
  }
  const now = Date.parse('2026-10-21T02:00:00.000Z')
  it('试用还剩 ≤ 2 天才提醒；宽限、已关各一条；回到正常三条都收掉；长期免费不打扰', () => {
    expect(
      teamSubscriptionNotice(
        { ...base, status: 'trial', trial_ends_at: new Date(now + 5 * 86_400_000).toISOString() },
        now,
      ).notice,
    ).toBeUndefined()
    const ending = teamSubscriptionNotice(
      { ...base, status: 'trial', trial_ends_at: new Date(now + 36 * 3_600_000).toISOString() },
      now,
    )
    expect(ending.notice).toEqual({
      key: TEAM_SUB_NOTICE_KEYS.trialEnding,
      text: '团队通道试用还剩 2 天，到期后每月 68 积分',
    })
    const grace = teamSubscriptionNotice(
      { ...base, status: 'grace', grace_until: '2026-11-20T02:00:00.000Z' },
      now,
    )
    expect(grace.notice?.key).toBe(TEAM_SUB_NOTICE_KEYS.grace)
    expect(grace.notice?.text).toContain('宽限到 11-20')
    expect(
      teamSubscriptionNotice({ ...base, status: 'suspended', usable: false }, now).notice?.key,
    ).toBe(TEAM_SUB_NOTICE_KEYS.off)
    // 从来没开过的不打扰
    expect(
      teamSubscriptionNotice({ ...base, status: 'none', usable: false, trial_available: true }, now)
        .notice,
    ).toBeUndefined()
    const fine = teamSubscriptionNotice(base, now)
    expect(fine.notice).toBeUndefined()
    expect(fine.settle).toEqual(Object.values(TEAM_SUB_NOTICE_KEYS))
    expect(
      teamSubscriptionNotice({ ...base, status: 'suspended', usable: true, comped: true }, now)
        .notice,
    ).toBeUndefined()
  })
})

describe('WP444 同事那边：对方的团队通道没开通 / 到期', () => {
  it('贴码经云递申请撞上「未开通 / 已到期」：说清楚，不说成「连不上」', async () => {
    const { createInvites } = await import('../src/invites.js')
    let t = Date.parse('2026-10-21T02:00:00.000Z')
    const invites = createInvites({
      clock: {
        now: () => {
          t += 1000
          return new Date(t).toISOString()
        },
      },
      random: () => 0.42,
      workspace_id: 'ws_b',
      owner: 'per_b',
      appendEvent: () => undefined,
      roles: {
        roles: { get: () => undefined },
        assignments: { listByPerson: () => [], create: () => undefined },
      } as unknown as Parameters<typeof createInvites>[0]['roles'],
      approvals: {
        create: async () => ({ id: 'ap_1', state: 'pending' }),
      } as unknown as Parameters<typeof createInvites>[0]['approvals'],
      identity: {
        personByEmail: () => undefined,
        createPerson: async () => ({ id: 'per_new' }),
        addMember: async () => undefined,
      },
      members: async () => [],
      companyKey: () => 'key',
      peerId: () => 'b',
      peerAddress: () => undefined,
      peerIds: () => [],
      resolveCode: async () => 'http://tabc-team.localhost:4655',
      post: async () => ({ ok: false, status: 503, off: 'subscription' }),
    } as unknown as Parameters<typeof createInvites>[0])
    try {
      await expect(
        invites.request({ code: 'ABCD2345', name: '林峰', email: 'lin@example.com' }),
      ).rejects.toThrow('对方的团队通道未开通或已到期')
    } finally {
      invites.close()
    }
  })
})
