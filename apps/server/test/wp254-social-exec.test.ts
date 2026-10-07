/**
 * WP254（决策 117）：别的社群的版务卡与回帖卡**批了之后**的执行器（单元：真 Discord 适配器 + 假 fetch +
 * 假连接，一个真 key 都不用、一个包都不发出去）。
 *
 * | 钉的是什么 | 为什么 |
 * |---|---|
 * | 删帖 / 封禁按 Discord 的形状真打那一跳，库里跟上 | 「批准执行」真的执行了 |
 * | 平台拒了 → failed + 平台原话、`retryable: false`，只打一跳 | 失败照实报、不重试 |
 * | 「提醒一句」一跳都不打、照样算成 | 平台没有这个动作，卡上事先说明了 |
 * | 自家版那一类不碰 | 归 WP249 |
 * | 回帖：按 `message_reference` 回那一条；改过正文发改过的；线程标成已回 | 回帖卡批了就发 |
 * | 补扫：只施行过了取消窗口的 | 2 分钟内还能撤 |
 */
import type {
  ApprovalItem,
  ChangeKind,
  CommunityThread,
  StagedChange,
  WorkspaceId,
} from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { createSocialStore } from '../src/social.js'
import { createSocialChannels } from '../src/social-channels.js'
import {
  createSocialExecutor,
  isSocialExecutableApproval,
  SOCIAL_REPLY_FORM,
} from '../src/social-executor.js'

const WS = 'ws_1' as WorkspaceId
const NOW = '2026-10-07T10:00:00.000Z'
const GUILD = '900000000000001'
const CHANNEL = '900000000000002'

function harness(respond?: (url: string) => { status: number; body: string }) {
  const calls: { url: string; method?: string; body?: string }[] = []
  const events: { type: string; payload: Record<string, unknown> }[] = []
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
      calls.push({
        url,
        ...(init.method === undefined ? {} : { method: init.method }),
        ...(init.body === undefined ? {} : { body: init.body }),
      })
      const r = respond?.(url) ?? { status: 200, body: '{"id":"dc_reply_1"}' }
      return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => r.body }
    },
  })
  const changes: StagedChange[] = []
  const items: ApprovalItem[] = []
  const applied: string[] = []
  let nowMs = Date.parse(NOW)
  const executor = createSocialExecutor({
    workspace_id: WS,
    store,
    clock: { now: () => new Date(nowMs).toISOString() },
    adapter: (c) => channels.adapters[c],
    emit: (type, _actor, payload) => events.push({ type, payload }),
    ledger: {
      list: async (f: { kind?: ChangeKind }) => changes.filter((c) => c.kind === f.kind),
    },
    approvedItems: () => items,
    applyApproval: async (id) => {
      applied.push(id)
    },
    cancelWindowMs: 120_000,
  })
  store.saveAccount({
    id: 'sa_dc',
    workspace_id: WS,
    channel: 'discord',
    handle: 'nordvolt-desk',
    display_name: 'Nordvolt 桌面党',
    url: 'https://discord.gg/nordvolt',
    external_id: `${GUILD}/${CHANNEL}`,
    observed_at: NOW,
  })
  const thread: CommunityThread = {
    id: 'ct_1',
    account_id: 'sa_dc',
    channel: 'discord',
    external_id: 'msg_42',
    surface: 'thread',
    author_external_id: 'u_1002',
    author_handle: 'cheap_cables_24h',
    text: '低价线材批发，加我私聊 →',
    created_at: NOW,
    status: 'open',
  }
  store.saveThread(thread)
  store.saveMember({
    id: 'cm_1',
    account_id: 'sa_dc',
    channel: 'discord',
    external_id: 'u_1002',
    handle: 'cheap_cables_24h',
    status: 'active',
  })
  return {
    store,
    executor,
    calls,
    events,
    changes,
    items,
    applied,
    advance: (ms: number) => {
      nowMs += ms
    },
  }
}

const moderation = (after: Record<string, unknown>, extra: Partial<StagedChange> = {}) =>
  ({
    id: 'chg_mod_1',
    workspace_id: WS,
    kind: 'community_moderation',
    status: 'approved',
    target: { type: 'community_thread', id: 'ct_1' },
    before: { status: 'open' },
    after: { channel: 'discord', account_id: 'sa_dc', ...after },
    approval: { item_id: 'ap_mod_1', at: NOW },
    ...extra,
  }) as unknown as StagedChange

const replyCard = (payload: Record<string, unknown> = {}, extra: Partial<ApprovalItem> = {}) =>
  ({
    id: 'ap_reply_1',
    workspace_id: WS,
    kind: 'outbound_draft',
    state: 'approved',
    subject: { object: { type: 'community_thread', id: 'ct_1' } },
    payload: {
      form: SOCIAL_REPLY_FORM,
      channel: 'discord',
      account_id: 'sa_dc',
      thread_id: 'ct_1',
      body: { text: '感谢分享！线材规格在置顶帖里。' },
      ...payload,
    },
    decision: { at: NOW, action: 'approve' },
    ...extra,
  }) as unknown as ApprovalItem

describe('版务卡批了 → 经渠道适配器的 moderate', () => {
  it('删帖：按 Discord 的形状删那一条消息，线程关掉，记一条事件', async () => {
    const h = harness()
    const res = await h.executor.applyModeration(
      moderation({ action: 'delete_post', target_external_id: 'msg_42' }),
    )
    expect(res).toEqual({ status: 'ok', execution_id: 'social_mod_chg_mod_1' })
    expect(h.calls).toEqual([
      {
        url: `https://discord.com/api/v10/channels/${CHANNEL}/messages/msg_42`,
        method: 'DELETE',
      },
    ])
    expect(h.store.thread('ct_1')?.status).toBe('closed')
    expect(h.events.map((e) => e.type)).toEqual(['social.moderation_applied'])
    // 事件里没有原话
    expect(JSON.stringify(h.events)).not.toContain('批发')
  })

  it('封禁：PUT bans；库里那个人标成 banned', async () => {
    const h = harness()
    const res = await h.executor.applyModeration(
      moderation({ action: 'ban', target_external_id: 'u_1002' }),
    )
    expect(res?.status).toBe('ok')
    expect(h.calls[0]).toMatchObject({
      url: `https://discord.com/api/v10/guilds/${GUILD}/bans/u_1002`,
      method: 'PUT',
    })
    expect(h.store.members({ account_id: 'sa_dc' })[0]?.status).toBe('banned')
  })

  it('平台拒了：failed + 平台原话、不可重试，只打了一跳', async () => {
    const h = harness(() => ({ status: 403, body: '{"message":"Missing Permissions"}' }))
    const res = await h.executor.applyModeration(
      moderation({ action: 'delete_post', target_external_id: 'msg_42' }),
    )
    expect(res?.status).toBe('failed')
    expect(res?.error?.retryable).toBe(false)
    expect(res?.error?.message).toBeTruthy()
    expect(h.calls).toHaveLength(1)
    expect(h.store.thread('ct_1')?.status).toBe('open')
    expect(h.events.map((e) => e.type)).toEqual(['social.moderation_failed'])
  })

  it('「提醒一句」：平台上没有这个动作，一跳都不打，照样算成（卡上事先写明了）', async () => {
    const h = harness()
    const res = await h.executor.applyModeration(
      moderation({ action: 'warn', target_external_id: 'u_1002' }),
    )
    expect(res?.status).toBe('ok')
    expect(h.calls).toEqual([])
    expect(h.events[0]?.payload).toMatchObject({ local_only: true })
  })

  it('号已经不在库里：照实说没执行；自家版那一类与别的变更不碰（回 undefined）', async () => {
    const h = harness()
    const gone = await h.executor.applyModeration(
      moderation({ action: 'delete_post', target_external_id: 'msg_42', account_id: 'sa_x' }),
    )
    expect(gone).toMatchObject({ status: 'failed', error: { retryable: false } })
    expect(
      await h.executor.applyModeration(
        moderation({ action: 'delete_post', source: 'own_sub_queue' }),
      ),
    ).toBeUndefined()
    expect(
      await h.executor.applyModeration({
        ...moderation({}),
        kind: 'price_change',
      } as StagedChange),
    ).toBeUndefined()
    expect(h.calls).toEqual([])
  })
})

describe('回帖卡批了 → 经渠道出口发出去', () => {
  it('按 message_reference 回那一条；线程标成已回、记下平台给的 id', async () => {
    const h = harness()
    const res = await h.executor.deliverReply(replyCard())
    expect(res).toMatchObject({
      status: 'ok',
      outcome_ref: { type: 'community_thread', id: 'ct_1' },
    })
    expect(h.calls[0]?.url).toBe(`https://discord.com/api/v10/channels/${CHANNEL}/messages`)
    expect(JSON.parse(h.calls[0]?.body ?? '{}')).toEqual({
      content: '感谢分享！线材规格在置顶帖里。',
      message_reference: { message_id: 'msg_42' },
    })
    expect(h.store.thread('ct_1')).toMatchObject({
      status: 'answered',
      reply_external_id: 'dc_reply_1',
    })
    expect(h.events.map((e) => e.type)).toEqual(['social.reply_sent'])
  })

  it('批的时候改过正文：发改过的那一版', async () => {
    const h = harness()
    await h.executor.deliverReply(
      replyCard({}, {
        decision: {
          at: NOW,
          action: 'approve_edited',
          edited_payload: { ...(replyCard().payload as object), body: { text: '改过的一句' } },
        },
      } as Partial<ApprovalItem>),
    )
    expect(JSON.parse(h.calls[0]?.body ?? '{}').content).toBe('改过的一句')
  })

  it('发失败：failed + 原话、不可重试；线程不动', async () => {
    const h = harness(() => ({ status: 500, body: 'oops' }))
    const res = await h.executor.deliverReply(replyCard())
    expect(res).toMatchObject({ status: 'failed', error: { retryable: false } })
    expect(h.calls).toHaveLength(1)
    expect(h.store.thread('ct_1')?.status).toBe('open')
    expect(h.events.map((e) => e.type)).toEqual(['social.reply_failed'])
  })

  it('不是回帖卡（客服回信）：回 undefined，掉回原来那条路', async () => {
    const h = harness()
    expect(
      await h.executor.deliverReply(replyCard({ form: undefined, channel: 'email' })),
    ).toBeUndefined()
    expect(h.calls).toEqual([])
  })
})

describe('什么时候施行', () => {
  it('决定钩子认这两类；补扫只施行过了取消窗口、批了还没施行的', async () => {
    const h = harness()
    expect(isSocialExecutableApproval(replyCard())).toBe(true)
    expect(
      isSocialExecutableApproval({
        kind: 'staged_change',
        payload: { kind: 'community_moderation', after: { action: 'ban' } },
      } as unknown as ApprovalItem),
    ).toBe(true)
    expect(
      isSocialExecutableApproval({
        kind: 'staged_change',
        payload: { kind: 'community_moderation', after: { source: 'own_sub_queue' } },
      } as unknown as ApprovalItem),
    ).toBe(false)

    h.changes.push(
      moderation({ action: 'delete_post' }),
      moderation({ action: 'ban' }, { id: 'chg_own', after: { source: 'own_sub_queue' } }),
      moderation({ action: 'ban' }, { id: 'chg_done', status: 'applied' }),
    )
    h.items.push(replyCard())
    // 取消窗口里：一张都不施行
    expect(await h.executor.sweep()).toBe(0)
    expect(h.applied).toEqual([])
    h.advance(121_000)
    expect(await h.executor.sweep()).toBe(2)
    expect(h.applied).toEqual(['ap_mod_1', 'ap_reply_1'])
  })
})
