/**
 * WP445（决策 1322–1324，Luoye 10-21）单元那一层（不联网、不起浏览器、不起服务进程）：
 *
 * 1. **1322** 出卡落在哪：个人 / 同事互联 / 落回本人 → 卡标 `desk: 'plugin'`、只发给本人、直接「等你发」（插件图标 /
 *    通知 / 铃铛那一路的事件）；公司模式里职责设了「主管先批」→ 卡给主管（工坊里批），不发「等你发」；
 *    `isPluginDeskCard` 认得新卡、老卡、主管卡、社媒插件卡；看板数（还没审的 + 批过等你打开的，同一张算一条）；
 *    主管批过的那一条，「等你发」通知告诉**发起人**；「不发 + 理由」才进学习回路；
 * 2. WP419 社媒「交给你发」：不用主管批、会交给人发的那一条卡标 `after.desk = 'plugin'`（工坊不出卡），到点了**不等批**
 *    直接交给插件；没标的照旧要先批；
 * 3. **1324** 钉住：Reddit 的写只有插件 + 人点这一条路——服务没有直发的口子、没有直发开关，接线里没有直发那一跳。
 */
import { readFileSync } from 'node:fs'
import type {
  ApprovalItem,
  ChangeKind,
  EventEnvelope,
  PersonId,
  SocialPost,
  StagedChange,
  WorkspaceId,
} from '@agentsws/contracts'
import { isPluginDeskCard } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { memoryEvidenceStore } from '../src/ads-actions/evidence-store.js'
import { createAdsActionsService } from '../src/ads-actions/service.js'
import { notificationsOfEvent, REDDIT_AWAITING_EVENT } from '../src/notifications.js'
import { createRedditWriteService } from '../src/reddit-write/service.js'
import { createSocialStore } from '../src/social.js'
import { createSocialChannels } from '../src/social-channels.js'
import { createSocialService } from '../src/social-service.js'

const WS = 'ws_d' as WorkspaceId
const T0 = Date.parse('2026-10-21T09:00:00.000Z')
const ME = 'per_me' as PersonId
const BOSS = 'per_boss' as PersonId
const actor = {
  workspace_id: WS,
  person_id: ME,
  assignment_id: 'asg_1',
  role_id: 'social.reddit',
} as never

const target = {
  kind: 'reply' as const,
  subreddit: 'ivraxr',
  parent_fullname: 't1_c1',
  permalink: '/r/ivraxr/comments/abc/slug/c1/',
  parent_author: 'alice',
  parent_text: 'Fogs up with glasses.',
}

function make(o: { reviewer?: PersonId; desk?: ApprovalItem[] } = {}) {
  const created: ApprovalItem[] = []
  const emitted: { type: string; payload: Record<string, unknown> }[] = []
  const dropped: { reason?: string }[] = []
  const now = { ms: T0 }
  const actions = createAdsActionsService({
    workspace_id: WS,
    nowMs: () => now.ms,
    evidence: memoryEvidenceStore({ nowMs: () => now.ms }),
    onEvent: (e) => svc.onActionEvent(e),
    wait: async (_ms, woke) => woke,
  })
  const svc = createRedditWriteService({
    workspace_id: WS,
    clock: { now: () => new Date(now.ms).toISOString() },
    approvals: {
      create: async (input) => {
        const item = { ...input, id: `ap_${created.length + 1}`, state: 'pending' } as never
        created.push(item)
        return item
      },
    },
    emit: (type, _a, payload) => emitted.push({ type, payload }),
    brand: () => 'IVRA',
    actions,
    record: () => ({ id: 'ob_1' }) as never,
    ...(o.reviewer === undefined
      ? {}
      : {
          reviewer: async () => ({
            person: o.reviewer as PersonId,
            via: 'scope_manager' as const,
            reason: '岗位上级',
          }),
        }),
    deskCards: () => o.desk ?? created.filter((c) => isPluginDeskCard(c)),
    onDropped: (x) => dropped.push(x),
  })
  return { svc, created, emitted, dropped, actions }
}

describe('WP445 决策 1322：出卡落在哪', () => {
  it('不用主管批：卡标「插件里审」、只发给本人、马上「等你发」（插件图标 / 通知 / 铃铛那一路）', async () => {
    const m = make()
    const r = await m.svc.stage(actor, { target, text: 'Hi Alice!' })
    expect(r.staged).toBe(true)
    const card = m.created[0] as ApprovalItem
    expect(card.payload).toMatchObject({ desk: 'plugin' })
    expect(card.routing).toMatchObject({
      rule: 'role_holder',
      recipients: [{ person: ME, via: 'role_holder' }],
    })
    expect(isPluginDeskCard(card)).toBe(true)
    expect(m.emitted.find((e) => e.type === 'reddit.write_awaiting')?.payload).toMatchObject({
      approval_item_id: card.id,
      desk: 'plugin',
    })
    expect(m.svc.inPlugin()).toBe(1)
  })

  it('落回本人（老板自己就是上级）：照样插件里审', async () => {
    const m = make({ reviewer: ME })
    await m.svc.stage(actor, { target, text: 'Hi Alice!' })
    expect(isPluginDeskCard(m.created[0] as ApprovalItem)).toBe(true)
  })

  it('公司模式里职责设了「主管先批」：卡给主管（工坊里批），不发「等你发」；批过之后才进发起人的插件', async () => {
    const m = make({ reviewer: BOSS })
    await m.svc.stage(actor, { target, text: 'Hi Alice!' })
    const card = m.created[0] as ApprovalItem
    expect(card.payload).toMatchObject({ desk: 'workshop' })
    expect(card.routing).toMatchObject({
      rule: 'scope_manager',
      recipients: [{ person: BOSS, via: 'scope_manager' }],
    })
    expect(isPluginDeskCard(card)).toBe(false)
    expect(m.emitted.some((e) => e.type === 'reddit.write_awaiting')).toBe(false)
    expect(m.svc.inPlugin()).toBe(0)
    // 主管批了 → 交出去 → 发起人的插件「等你发」
    await m.svc.send({
      approval_item_id: card.id,
      write: { kind: 'reply', parent: 't1_c1', permalink: target.permalink },
      text: 'Hi Alice!',
      subreddit: 'ivraxr',
      record: {
        source_key: `approval:${card.id}`,
        channel: 'reddit',
        action: 'reply',
        content: 'x',
      } as never,
    })
    expect(m.svc.inPlugin()).toBe(1)
  })

  it('看板数：还没审的卡 + 批过等你打开的，同一张卡算一条', async () => {
    const m = make()
    await m.svc.stage(actor, { target, text: 'Hi Alice!' })
    const id = (m.created[0] as ApprovalItem).id
    await m.svc.send({
      approval_item_id: id,
      write: { kind: 'reply', parent: 't1_c1', permalink: target.permalink },
      text: 'Hi Alice!',
      subreddit: 'ivraxr',
      record: {
        source_key: `approval:${id}`,
        channel: 'reddit',
        action: 'reply',
        content: 'x',
      } as never,
    })
    expect(m.svc.inPlugin()).toBe(1)
  })

  it('「不发」：写了理由才进学习回路；没写只不发这一条', async () => {
    const m = make({ desk: [] })
    for (const [n, reason] of [
      [1, undefined],
      [2, '时机不对'],
    ] as const) {
      await m.svc.send({
        approval_item_id: `ap_${n}`,
        write: { kind: 'reply', parent: 't1_c1', permalink: target.permalink },
        text: 'Hi Alice!',
        subreddit: 'ivraxr',
        record: {
          source_key: `approval:ap_${n}`,
          channel: 'reddit',
          action: 'reply',
          content: 'x',
        } as never,
      })
      const job = m.svc.writes().find((w) => w.approval_item_id === `ap_${n}`)?.job_id as string
      expect(m.svc.drop(job, reason).ok).toBe(true)
    }
    expect(m.dropped).toEqual([
      expect.objectContaining({ approval_item_id: 'ap_2', reason: '时机不对' }),
    ])
  })
})

describe('WP445 isPluginDeskCard', () => {
  const base = {
    kind: 'outbound_draft',
    payload: { form: 'reddit_write' },
    routing: { rule: 'role_holder' },
  }
  it('新卡按 desk、老卡按收件规则；主管 / 老板收的不是；别的卡不是', () => {
    expect(isPluginDeskCard(base)).toBe(true)
    expect(isPluginDeskCard({ ...base, payload: { form: 'reddit_write', desk: 'plugin' } })).toBe(
      true,
    )
    expect(isPluginDeskCard({ ...base, payload: { form: 'reddit_write', desk: 'workshop' } })).toBe(
      false,
    )
    expect(isPluginDeskCard({ ...base, routing: { rule: 'scope_manager' } })).toBe(false)
    expect(isPluginDeskCard({ ...base, routing: { rule: 'owner' } })).toBe(false)
    expect(isPluginDeskCard({ ...base, payload: { form: 'social_reply' } })).toBe(false)
    expect(
      isPluginDeskCard({
        kind: 'staged_change',
        payload: { kind: 'social_post', after: { post_id: 'sp_1', desk: 'plugin' } },
      }),
    ).toBe(true)
    expect(
      isPluginDeskCard({
        kind: 'staged_change',
        payload: { kind: 'social_post', after: { post_id: 'sp_1' } },
      }),
    ).toBe(false)
  })
})

describe('WP445 「等你发」通知告诉谁', () => {
  it('主管在工坊里批了：告诉发起人（他去插件里发），不是批的主管', async () => {
    const item = {
      id: 'ap_9',
      kind: 'outbound_draft',
      title: '回复 alice（Reddit · r/ivraxr）',
      payload: { form: 'reddit_write', desk: 'workshop' },
      proposer: { kind: 'person', id: ME },
      decision: { by: BOSS },
      routing: { rule: 'scope_manager', recipients: [{ person: BOSS }] },
    } as unknown as ApprovalItem
    const ev: Pick<EventEnvelope, 'type' | 'workspace_id' | 'actor' | 'subject' | 'payload'> = {
      type: REDDIT_AWAITING_EVENT,
      workspace_id: WS,
      actor: { kind: 'system', id: 'system' },
      payload: { approval_item_id: 'ap_9', subreddit: 'ivraxr' },
    }
    const out = await notificationsOfEvent(ev, {
      personName: () => undefined,
      owners: () => [BOSS],
      approval: () => item,
    })
    expect(out).toEqual([expect.objectContaining({ person_id: ME, category: 'outbound' })])
  })

  it('插件里审的卡到了本人：不在铃铛里说「等你批」（「等你发」那一路已经说了）', async () => {
    const item = {
      id: 'ap_8',
      kind: 'outbound_draft',
      title: '回复 alice',
      payload: { form: 'reddit_write', desk: 'plugin' },
      proposer: { kind: 'person', id: ME },
      routing: {
        rule: 'role_holder',
        recipients: [{ person: ME }],
        escalation: { escalated_at: [] },
      },
    } as unknown as ApprovalItem
    const out = await notificationsOfEvent(
      {
        type: 'approval.delivered',
        workspace_id: WS,
        actor: { kind: 'system', id: 'system' },
        subject: { type: 'approval_item', id: 'ap_8' },
        payload: { to: ME },
      },
      { personName: () => undefined, owners: () => [ME], approval: () => item },
    )
    expect(out).toEqual([])
  })
})

describe('WP445 社媒「交给你发」也在插件里一步完成（WP419 那一块）', () => {
  const NOW = '2026-10-21T09:00:00.000Z'
  function harness(changes: { post_id: string; status: string; desk?: boolean }[]) {
    const staged: unknown[] = []
    const store = createSocialStore({ workspace_id: WS })
    const channels = createSocialChannels({
      workspace_id: WS,
      clock: { now: () => NOW },
      connections: () => [],
      secrets: { available: true, get: () => undefined } as never,
      fetch: async () => ({
        ok: false,
        status: 500,
        text: async () => '',
        headers: { get: () => null },
      }),
    })
    const service = createSocialService({
      workspace_id: WS,
      store,
      channels,
      clock: { now: () => NOW },
      approvals: {} as never,
      ledger: {
        stage: async (input: unknown) => {
          staged.push(input)
          return {
            ok: true,
            change: { id: 'chg_new' },
            approval: { id: 'ap_new', automation: { level_at_creation: 'L1' } },
          } as never
        },
        list: async (f: { kind?: ChangeKind }) =>
          f.kind === 'social_post'
            ? (changes.map((c) => ({
                id: `chg_${c.post_id}`,
                workspace_id: WS,
                status: c.status,
                after: { post_id: c.post_id, ...(c.desk === true ? { desk: 'plugin' } : {}) },
              })) as unknown as StagedChange[])
            : [],
      } as never,
      effectiveConfig: () => {
        throw new Error('不查生效配置')
      },
      appendEvent: () => {},
      random: () => 0.5,
      holdersOf: () => [],
      owner: async () => undefined,
      manualPublishTask: ({ post }) => ({ todo_id: `td_${post.id}` }),
    })
    store.saveAccount({
      id: 'sa_x',
      workspace_id: WS,
      channel: 'x',
      handle: 'nordvolt',
      display_name: 'Nordvolt X',
      url: 'https://x.com/nordvolt',
      external_id: '1',
      observed_at: NOW,
    } as never)
    const post = (id: string) =>
      store.savePost({
        id,
        account_id: 'sa_x',
        channel: 'x',
        kind: 'post',
        status: 'scheduled',
        body: 'Weekend checklist',
        scheduled_at: '2026-10-21T08:00:00.000Z',
      } as SocialPost)
    return { service, store, staged, post }
  }

  it('不用主管批、会交给人发的：卡标 `after.desk = plugin`；没排时间的当「现在就到点」', async () => {
    const h = harness([])
    await h.service.port.createPost(actor, {
      account_id: 'sa_x',
      kind: 'post',
      body: 'Weekend checklist',
    } as never)
    const input = h.staged[0] as { after: { desk?: string }; approval: { recipients: unknown[] } }
    expect(input.after.desk).toBe('plugin')
    expect(input.approval.recipients).toEqual([{ person: ME, via: 'scope_manager' }])
    const saved = h.store.posts()[0]
    expect(saved?.status).toBe('scheduled')
    expect(saved?.scheduled_at).toBe(NOW)
  })

  it('到点了：插件里审的那一条不等批，直接交给插件「等你发」；没标的照旧要先批', async () => {
    const h = harness([
      { post_id: 'sp_desk', status: 'staged', desk: true },
      { post_id: 'sp_old', status: 'staged' },
    ])
    h.post('sp_desk')
    h.post('sp_old')
    const out = await h.service.publishDue()
    expect(out.handed_off).toEqual(['sp_desk'])
    expect(out.published).toBe(0)
    expect(h.store.post('sp_desk')?.handoff).toBeDefined()
    expect(h.store.post('sp_old')?.handoff).toBeUndefined()
    expect(out.skipped.find((s) => s.post_id === 'sp_old')?.reason).toContain('还没人点头')
  })
})

describe('WP445 决策 1324：Reddit 写只有插件 + 人点这一条路', () => {
  const src = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')
  it('服务没有直发的口子与开关；接线里没有直发那一跳；社媒回帖在 Reddit 上不走接口直发', () => {
    const service = src('../src/reddit-write/service.ts')
    expect(service).not.toMatch(/options\.direct\b|direct\?\(|directFallback|setSettings/u)
    const wire = src('../src/reddit-write/wire.ts')
    expect(wire).not.toMatch(
      /redditDirectWriter|submitApprovedPost|adapter\.publish|adapter\.reply/u,
    )
    const server = src('../src/server.ts')
    expect(server).not.toMatch(/redditDirectWriter|direct_fallback/u)
    const exec = src('../src/social-executor.ts')
    expect(exec).toContain("if (thread.channel === 'reddit')")
    const m = make()
    expect('settings' in m.svc).toBe(false)
    expect('setSettings' in m.svc).toBe(false)
  })
})
