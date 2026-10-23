/**
 * WP483（决策 1658 / 1660）：**选路**——ego 能用走 ego（批了工坊自己在 ego 里发、读回、记「已发 · 已记录」），
 * 不能用走插件；ego 跑失败自动退插件并说一句原因；被平台拦就停下；点过发送没确认也停下（不发两遍）；
 * 「发之前让我看一眼」开着只填好、之后读回。Reddit 写、社媒发帖、社媒评论三处都钉。
 *
 * ego 是注入的假手（按剧本回结果），不起 ego、不联网、什么都没真发。
 */
import type {
  ApprovalItem,
  ChangeKind,
  EgoWriteResult,
  PersonId,
  SocialPost,
  StagedChange,
  WorkspaceId,
} from '@agentsws/contracts'
import { EGO_HUMAN_WAIT_MS, isPluginDeskCard } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { memoryEvidenceStore } from '../src/ads-actions/evidence-store.js'
import { createAdsActionsService } from '../src/ads-actions/service.js'
import type { EgoWriteCall } from '../src/ego-write/writer.js'
import { notificationsOfEvent, REDDIT_EGO_HUMAN_EVENT } from '../src/notifications.js'
import { createRedditWriteService } from '../src/reddit-write/service.js'
import { createSocialStore } from '../src/social.js'
import { createSocialChannels } from '../src/social-channels.js'
import { createSocialService } from '../src/social-service.js'

const WS = 'ws_e' as WorkspaceId
const T0 = Date.parse('2026-10-23T09:00:00.000Z')
const ME = 'per_me' as PersonId
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

/** 按剧本回结果的假 ego。 */
function fakeEgo(
  script: (cfg: EgoWriteCall, n: number) => Partial<EgoWriteResult>,
  ok = { v: true },
) {
  const calls: EgoWriteCall[] = []
  return {
    calls,
    ok,
    ego: {
      available: () => ok.v,
      run: async (cfg: EgoWriteCall): Promise<EgoWriteResult> => {
        calls.push(cfg)
        return { platform: cfg.platform, state: 'failed', ...script(cfg, calls.length) }
      },
    },
  }
}

function reddit(o: { ego?: ReturnType<typeof fakeEgo>; review?: boolean } = {}) {
  const created: ApprovalItem[] = []
  const emitted: { type: string; payload: Record<string, unknown> }[] = []
  const records: Record<string, unknown>[] = []
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
    record: (input) => {
      records.push(input as never)
      return { id: `ob_${records.length}` } as never
    },
    deskCards: () => created.filter((c) => isPluginDeskCard(c)),
    ...(o.ego === undefined ? {} : { ego: { ...o.ego.ego, reviewFirst: () => o.review === true } }),
  })
  /** 批了：卡照原样施行（`deliver`）。 */
  const approveAndDeliver = async (card: ApprovalItem) =>
    svc.deliver({
      ...card,
      state: 'approved',
      decision: { by: ME, at: new Date(now.ms).toISOString() },
    } as never)
  return { svc, created, emitted, records, now, actions, approveAndDeliver }
}

describe('WP483 Reddit 写：选路', () => {
  it('ego 能用：卡在工坊里批（不进插件「等你发」）；批了工坊在 ego 里发、读回，记「已发 · 已记录」', async () => {
    const f = fakeEgo(() => ({
      state: 'sent',
      link: 'https://www.reddit.com/r/ivraxr/comments/abc/slug/c9/',
      external_id: 't1_c9',
      readback: 'link',
      clicked: true,
    }))
    const m = reddit({ ego: f })
    await m.svc.stage(actor, { target, text: 'Hi Alice!' })
    const card = m.created[0] as ApprovalItem
    expect(card.payload).toMatchObject({ desk: 'workshop', route: 'ego' })
    expect(isPluginDeskCard(card)).toBe(false)
    expect(m.emitted.some((e) => e.type === 'reddit.write_awaiting')).toBe(false)
    const res = await m.approveAndDeliver(card)
    expect(res).toMatchObject({ status: 'ok' })
    expect(res?.execution_id).toMatch(/^reddit_ego_/u)
    await m.svc.idle()
    // ego 那一趟：回评论、点发送（「发之前让我看一眼」关着）
    expect(f.calls[0]).toMatchObject({
      platform: 'reddit-reply',
      mode: 'write',
      submit: true,
      parent: 't1_c1',
    })
    expect(f.calls[0]?.url).toBe('https://www.reddit.com/r/ivraxr/comments/abc/slug/c1/')
    const w = m.svc.writes()[0]
    expect(w).toMatchObject({
      state: 'sent',
      route: 'ego',
      link: 'https://www.reddit.com/r/ivraxr/comments/abc/slug/c9/',
    })
    expect(m.records[0]).toMatchObject({ content: 'Hi Alice!', external_id: 't1_c9' })
    // 插件那边什么都没排
    expect(m.actions.jobs()).toHaveLength(0)
  })

  it('ego 用不了：照旧插件路（卡进插件「等你发」，批了等你在插件里打开）', async () => {
    const f = fakeEgo(() => ({ state: 'sent' }), { v: false })
    const m = reddit({ ego: f })
    await m.svc.stage(actor, { target, text: 'Hi Alice!' })
    expect(isPluginDeskCard(m.created[0] as ApprovalItem)).toBe(true)
    await m.approveAndDeliver(m.created[0] as ApprovalItem)
    expect(m.svc.writes()[0]).toMatchObject({ state: 'awaiting' })
    expect(m.svc.writes()[0]?.route).toBeUndefined()
    expect(f.calls).toHaveLength(0)
  })

  it('出卡时走 ego、批的时候 ego 用不了了：退插件，说一句原因', async () => {
    const f = fakeEgo(() => ({ state: 'sent' }))
    const m = reddit({ ego: f })
    await m.svc.stage(actor, { target, text: 'Hi Alice!' })
    f.ok.v = false
    await m.approveAndDeliver(m.created[0] as ApprovalItem)
    const w = m.svc.writes()[0]
    expect(w).toMatchObject({ state: 'awaiting' })
    expect(w?.route_note).toContain('ego 这会儿用不了')
    expect(f.calls).toHaveLength(0)
  })

  it('ego 跑失败（没登录 / 选择器对不上）：自动退插件「等你发」，事项里那一句说原因', async () => {
    const f = fakeEgo(() => ({ state: 'needs_login', why: 'login_button' }))
    const m = reddit({ ego: f })
    await m.svc.stage(actor, { target, text: 'Hi Alice!' })
    await m.approveAndDeliver(m.created[0] as ApprovalItem)
    await m.svc.idle()
    const w = m.svc.writes()[0]
    expect(w).toMatchObject({ state: 'awaiting', route_note: expect.stringContaining('没登录') })
    expect(m.actions.jobs()).toHaveLength(1)
    expect(
      m.emitted.some((e) => e.type === 'reddit.write_route' && e.payload.route === 'plugin'),
    ).toBe(true)
    expect(m.emitted.some((e) => e.type === 'reddit.write_awaiting')).toBe(true)
  })

  it('平台拦了（验证码 / 风控）：停下、记原因、提醒人；不退插件、不重试', async () => {
    const f = fakeEgo(() => ({ state: 'blocked', why: 'captcha' }))
    const m = reddit({ ego: f })
    await m.svc.stage(actor, { target, text: 'Hi Alice!' })
    await m.approveAndDeliver(m.created[0] as ApprovalItem)
    await m.svc.idle()
    expect(m.svc.writes()[0]).toMatchObject({ state: 'failed', outcome: 'blocked' })
    expect(m.actions.jobs()).toHaveLength(0)
    expect(m.emitted.some((e) => e.type === 'reddit.write_ego_stopped')).toBe(true)
    await m.svc.sweep()
    await m.svc.idle()
    expect(f.calls).toHaveLength(1)
  })

  it('点过发送、没确认发出去：停下请人看（不退插件，免得发两遍）', async () => {
    const f = fakeEgo(() => ({ state: 'failed', clicked: true, why: 'no-success-sign-after-send' }))
    const m = reddit({ ego: f })
    await m.svc.stage(actor, { target, text: 'Hi Alice!' })
    await m.approveAndDeliver(m.created[0] as ApprovalItem)
    await m.svc.idle()
    expect(m.svc.writes()[0]).toMatchObject({ state: 'failed', outcome: 'ego_unconfirmed' })
    expect(m.actions.jobs()).toHaveLength(0)
  })

  it('ego 交给人（权限框）：铃铛提醒；人点掉后下一轮续上同一个 Space 接着做；等太久退插件', async () => {
    let first = true
    const f = fakeEgo((cfg) => {
      if (first) {
        first = false
        return { state: 'needs_human', space_id: 7 }
      }
      return cfg.resume === 7 ? { state: 'needs_human', space_id: 7 } : { state: 'sent' }
    })
    const m = reddit({ ego: f })
    await m.svc.stage(actor, { target, text: 'Hi Alice!' })
    await m.approveAndDeliver(m.created[0] as ApprovalItem)
    await m.svc.idle()
    expect(m.svc.writes()[0]?.message).toContain('阻止')
    const human = m.emitted.find((e) => e.type === REDDIT_EGO_HUMAN_EVENT)
    expect(human).toBeDefined()
    // 下一轮：续上 Space 7
    m.now.ms += 60_000
    await m.svc.sweep()
    await m.svc.idle()
    expect(f.calls[1]?.resume).toBe(7)
    // 半小时没人管：退插件
    m.now.ms += EGO_HUMAN_WAIT_MS + 1
    await m.svc.sweep()
    await m.svc.idle()
    expect(m.svc.writes()[0]).toMatchObject({
      state: 'awaiting',
      route_note: expect.stringContaining('没人处理'),
    })
    // 铃铛那一句告诉发起人
    const out = await notificationsOfEvent(
      {
        type: REDDIT_EGO_HUMAN_EVENT,
        workspace_id: WS,
        actor: { kind: 'system', id: 'system' } as never,
        payload: human?.payload ?? {},
      },
      { personName: () => undefined, owners: () => [ME], approval: () => m.created[0] } as never,
    )
    expect(out[0]).toMatchObject({ person_id: ME, key: 'ego:ap_1' })
  })

  it('「发之前让我看一眼」开着：只填好不点发送；之后到点读回一次，认出你发了就记上', async () => {
    const f = fakeEgo((cfg) =>
      cfg.mode === 'readback'
        ? {
            state: 'sent',
            link: 'https://www.reddit.com/r/ivraxr/comments/abc/slug/c10/',
            external_id: 't1_c10',
          }
        : { state: 'filled', space_id: 3 },
    )
    const m = reddit({ ego: f, review: true })
    await m.svc.stage(actor, { target, text: 'Hi Alice!' })
    await m.approveAndDeliver(m.created[0] as ApprovalItem)
    await m.svc.idle()
    expect(f.calls[0]).toMatchObject({ submit: false })
    expect(m.svc.writes()[0]).toMatchObject({ state: 'filling', route: 'ego' })
    // 还没到读回的点：不读
    await m.svc.sweep()
    await m.svc.idle()
    expect(f.calls).toHaveLength(1)
    m.now.ms += 3 * 60_000
    await m.svc.sweep()
    await m.svc.idle()
    expect(f.calls[1]).toMatchObject({ mode: 'readback' })
    expect(m.svc.writes()[0]).toMatchObject({ state: 'sent' })
    expect(m.records).toHaveLength(1)
  })

  it('社媒回帖卡 / 公关外部帖（别的路批过的）：`auto`——ego 能用走 ego，不能用悄悄走插件（不说「ego 用不了」）', async () => {
    const f = fakeEgo(() => ({ state: 'sent' }), { v: false })
    const m = reddit({ ego: f })
    await m.svc.send({
      approval_item_id: 'ap_x',
      write: { kind: 'reply', parent: 't1_c1', permalink: target.permalink },
      text: 'Hi',
      subreddit: 'ivraxr',
      record: {
        source_key: 'approval:ap_x',
        channel: 'reddit',
        action: 'reply',
        content: 'Hi',
      } as never,
      route: 'auto',
    })
    expect(m.svc.writes()[0]).toMatchObject({ state: 'awaiting' })
    expect(m.svc.writes()[0]?.route_note).toBeUndefined()
  })
})

describe('WP483 社媒发帖：选路', () => {
  const NOW = '2026-10-23T09:00:00.000Z'
  function harness(
    changes: { post_id: string; status: string; desk?: boolean }[],
    f?: ReturnType<typeof fakeEgo>,
    o: { review?: boolean; media?: boolean } = {},
  ) {
    const staged: unknown[] = []
    const sent: Record<string, unknown>[] = []
    const now = { iso: NOW }
    const store = createSocialStore({ workspace_id: WS })
    const channels = createSocialChannels({
      workspace_id: WS,
      clock: { now: () => now.iso },
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
      clock: { now: () => now.iso },
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
        list: async (fl: { kind?: ChangeKind }) =>
          fl.kind === 'social_post'
            ? (changes.map((c) => ({
                id: `chg_${c.post_id}`,
                workspace_id: WS,
                status: c.status,
                role_id: 'social.content',
                assignment_id: 'asg_s',
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
      onSent: (input) => sent.push(input as never),
      ...(f === undefined
        ? {}
        : {
            ego: {
              ...f.ego,
              reviewFirst: (who) => o.review === true && who.assignment_id === 'asg_s',
              ...(o.media === false
                ? { media: async () => ({ why: '取不到' }) }
                : {
                    media: async (refs) => ({
                      files: refs.map((r) => `/tmp/${r}`),
                      cleanup: () => undefined,
                    }),
                  }),
            },
          }),
    })
    for (const ch of ['x', 'instagram'] as const)
      store.saveAccount({
        id: `sa_${ch}`,
        workspace_id: WS,
        channel: ch,
        handle: 'nordvolt',
        display_name: `Nordvolt ${ch}`,
        url: `https://${ch === 'x' ? 'x.com' : 'www.instagram.com'}/nordvolt`,
        external_id: '1',
        observed_at: NOW,
      } as never)
    const post = (id: string, ch: 'x' | 'instagram' = 'x', media?: string[]) =>
      store.savePost({
        id,
        account_id: `sa_${ch}`,
        channel: ch,
        kind: media === undefined ? 'post' : 'image',
        status: 'scheduled',
        body: 'Weekend checklist',
        scheduled_at: '2026-10-23T08:00:00.000Z',
        ...(media === undefined ? {} : { media_refs: media }),
      } as SocialPost)
    return { service, store, staged, post, sent, now }
  }

  it('ego 能用：出卡在工坊批（不标插件里审，标 route ego）', async () => {
    const h = harness(
      [],
      fakeEgo(() => ({ state: 'sent' })),
    )
    await h.service.port.createPost(actor, {
      account_id: 'sa_x',
      kind: 'post',
      body: 'Weekend checklist',
    } as never)
    const input = h.staged[0] as { after: { desk?: string; route?: string } }
    expect(input.after.desk).toBeUndefined()
    expect(input.after.route).toBe('ego')
  })

  it('批了、到点：工坊在 ego 里发 → published（via ego，读回了链接）+ 发出记录', async () => {
    const f = fakeEgo(() => ({
      state: 'sent',
      link: 'https://x.com/nordvolt/status/123',
      external_id: '123',
      readback: 'link',
    }))
    const h = harness([{ post_id: 'sp_1', status: 'approved' }], f)
    h.post('sp_1')
    const out = await h.service.publishDue()
    expect(out.published).toBe(1)
    expect(f.calls[0]).toMatchObject({
      platform: 'x-post',
      submit: true,
      readback_url: 'https://x.com/nordvolt',
    })
    expect(h.store.post('sp_1')).toMatchObject({
      status: 'published',
      published_via: 'ego',
      readback: 'link',
      post_url: 'https://x.com/nordvolt/status/123',
    })
    expect(h.sent[0]).toMatchObject({
      source_key: 'post:sp_1',
      link: 'https://x.com/nordvolt/status/123',
    })
  })

  it('读不回链接：照实标 clicked（不当成核实过）', async () => {
    const h = harness(
      [{ post_id: 'sp_1', status: 'approved' }],
      fakeEgo(() => ({ state: 'sent', readback: 'clicked', clicked: true })),
    )
    h.post('sp_1')
    await h.service.publishDue()
    expect(h.store.post('sp_1')).toMatchObject({ status: 'published', readback: 'clicked' })
  })

  it('ego 没发成：退给人 / 插件（handoff + 待办），原因写进去；Instagram 没素材直接交给人', async () => {
    const h = harness(
      [
        { post_id: 'sp_1', status: 'approved' },
        { post_id: 'sp_2', status: 'approved' },
      ],
      fakeEgo(() => ({ state: 'failed', why: 'composer-trigger-not-found' })),
    )
    h.post('sp_1')
    h.post('sp_2', 'instagram')
    const out = await h.service.publishDue()
    expect(out.handed_off).toEqual(['sp_1', 'sp_2'])
    expect(h.store.post('sp_1')?.handoff?.reason).toContain('ego 没发成')
    expect(h.store.post('sp_1')?.ego?.state).toBe('fell_back')
    expect(h.store.post('sp_2')?.handoff?.reason).toContain('图 / 视频')
  })

  it('素材取不到：不发（宁可交给人也不少挂一张图）', async () => {
    const f = fakeEgo(() => ({ state: 'sent' }))
    const h = harness([{ post_id: 'sp_1', status: 'approved' }], f, { media: false })
    h.post('sp_1', 'instagram', ['blob://img'])
    await h.service.publishDue()
    expect(f.calls).toHaveLength(0)
    expect(h.store.post('sp_1')?.handoff?.reason).toContain('素材取不到')
  })

  it('平台拦了：failed + 原因，不交插件、不重试', async () => {
    const f = fakeEgo(() => ({ state: 'blocked', why: 'unusual activity' }))
    const h = harness([{ post_id: 'sp_1', status: 'approved' }], f)
    h.post('sp_1')
    const out = await h.service.publishDue()
    expect(out.failed).toBe(1)
    expect(h.store.post('sp_1')).toMatchObject({ status: 'failed' })
    expect(h.store.post('sp_1')?.handoff).toBeUndefined()
  })

  it('「发之前让我看一眼」：只填好、交给你（插件 / 待办「发好了」照旧）；到点读回认出来就记 published', async () => {
    const f = fakeEgo((cfg) =>
      cfg.mode === 'readback'
        ? { state: 'sent', link: 'https://x.com/nordvolt/status/9' }
        : { state: 'filled', space_id: 4 },
    )
    const h = harness([{ post_id: 'sp_1', status: 'approved' }], f, { review: true })
    h.post('sp_1')
    await h.service.publishDue()
    expect(f.calls[0]).toMatchObject({ submit: false })
    expect(h.store.post('sp_1')).toMatchObject({ status: 'scheduled', ego: { state: 'filled' } })
    expect(h.store.post('sp_1')?.handoff).toBeDefined()
    h.now.iso = '2026-10-23T09:03:00.000Z'
    await h.service.publishDue()
    expect(f.calls[1]).toMatchObject({ mode: 'readback', url: 'https://x.com/nordvolt' })
    expect(h.store.post('sp_1')).toMatchObject({
      status: 'published',
      published_via: 'ego',
      readback: 'link',
    })
  })

  it('ego 用不了：插件那一路照旧（插件里审的卡到点直接交给插件）', async () => {
    const h = harness(
      [{ post_id: 'sp_desk', status: 'staged', desk: true }],
      fakeEgo(() => ({ state: 'sent' }), { v: false }),
    )
    h.post('sp_desk')
    const out = await h.service.publishDue()
    expect(out.handed_off).toEqual(['sp_desk'])
  })
})

describe('WP483 社媒评论（X / FB / IG / LinkedIn / TikTok，没有回帖接口）：ego 能用就回', () => {
  async function replyHarness(f?: ReturnType<typeof fakeEgo>, review = false) {
    const { createSocialExecutor, SOCIAL_REPLY_FORM } = await import('../src/social-executor.js')
    const NOW = '2026-10-23T09:00:00.000Z'
    const store = createSocialStore({ workspace_id: WS })
    const sent: Record<string, unknown>[] = []
    const executor = createSocialExecutor({
      workspace_id: WS,
      store,
      clock: { now: () => NOW },
      adapter: () => undefined,
      emit: () => {},
      ledger: { list: async () => [] } as never,
      onSent: (x) => sent.push(x as never),
      ...(f === undefined ? {} : { ego: { ...f.ego, reviewFirst: () => review } }),
    })
    store.saveAccount({
      id: 'sa_ig',
      workspace_id: WS,
      channel: 'instagram',
      handle: 'nordvolt',
      display_name: 'Nordvolt',
      url: 'https://www.instagram.com/nordvolt',
      external_id: '1',
      observed_at: NOW,
    } as never)
    store.saveThread({
      id: 'ct_1',
      account_id: 'sa_ig',
      channel: 'instagram',
      external_id: 'c_1',
      surface: 'comment',
      author_handle: 'amy',
      text: 'Love it',
      created_at: NOW,
      status: 'open',
      permalink: 'https://www.instagram.com/p/AbC/',
    } as never)
    const card = {
      id: 'ap_r1',
      workspace_id: WS,
      kind: 'outbound_draft',
      state: 'approved',
      role_id: 'social.content',
      proposer: { kind: 'person', id: ME, assignment_id: 'asg_s' },
      subject: { object: { type: 'community_thread', id: 'ct_1' } },
      payload: {
        form: SOCIAL_REPLY_FORM,
        channel: 'instagram',
        account_id: 'sa_ig',
        thread_id: 'ct_1',
        body: { text: 'Thank you Amy!' },
      },
      decision: { at: NOW, action: 'approve', by: ME },
    } as unknown as ApprovalItem
    return { executor, store, sent, card }
  }

  it('ego 能用：在 ego 里回、读回，线程标已回、发出记录有链接', async () => {
    const f = fakeEgo(() => ({
      state: 'sent',
      link: 'https://www.instagram.com/p/AbC/c/9/',
      readback: 'link',
    }))
    const h = await replyHarness(f)
    const res = await h.executor.deliverReply(h.card)
    expect(res?.status).toBe('ok')
    expect(f.calls[0]).toMatchObject({
      platform: 'instagram-comment',
      url: 'https://www.instagram.com/p/AbC/',
      submit: true,
    })
    expect(h.store.thread('ct_1')?.status).toBe('answered')
    expect(h.sent[0]).toMatchObject({
      link: 'https://www.instagram.com/p/AbC/c/9/',
      content: 'Thank you Amy!',
    })
  })

  it('没有 ego：照旧说「还没有能回帖的出口」；ego 回不成：说原因、不假装发了', async () => {
    const none = await replyHarness()
    expect((await none.executor.deliverReply(none.card))?.status).toBe('failed')
    const f = fakeEgo(() => ({ state: 'failed', why: 'comment-box-not-found' }))
    const h = await replyHarness(f)
    const res = await h.executor.deliverReply(h.card)
    expect(res).toMatchObject({ status: 'failed' })
    expect(h.store.thread('ct_1')?.status).toBe('open')
  })

  it('「发之前让我看一眼」：只填不点', async () => {
    const f = fakeEgo(() => ({ state: 'filled' }))
    const h = await replyHarness(f, true)
    const res = await h.executor.deliverReply(h.card)
    expect(res?.status).toBe('ok')
    expect(f.calls[0]).toMatchObject({ submit: false })
    expect(h.sent).toHaveLength(0)
  })
})
