/**
 * WP332：Reddit 发出的两处遗留（单元那一层；不联网、不起浏览器，插件动作通道是本机内存那一份 = 替身插件）。
 *
 * | 钉的是什么 | 为什么 |
 * |---|---|
 * | 没发出去（等不到人点 / 点了停止 / 没登录 / 24 小时没人领）→ 进度里 `can_refill`，提醒条出一行 | 决策 762 |
 * | 「再填一次」= 同一份已批草稿交给插件的新一件活，**不出新卡**；做完记一行发出记录 | 不用重批 |
 * | 收起之后不出；再填又没发出去 → 重新出；同一条只一行 | docs/96 出现规则 |
 * | 公关回一条评论：卡上带那条评论的链接 → 插件走楼中楼；没链接照实失败 | 公关外部回评论 |
 * | 找链接：给的 → 巡查条目 → 社群线程 → 提及 → 补读所在帖子；都没有就照实说 | 补不到不出卡 |
 */
import {
  type ExternalPost,
  type OutboundRecordInput,
  type RedditWatchEntry,
  redditWriteNotices,
  type StagedChange,
} from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { memoryEvidenceStore } from '../src/ads-actions/evidence-store.js'
import { createAdsActionsService } from '../src/ads-actions/service.js'
import { createPrStore } from '../src/pr.js'
import { createPrService } from '../src/pr-service.js'
import { redditParentLinker } from '../src/reddit-write/parent-link.js'
import {
  createRedditWriteService,
  OPEN_IN_PLUGIN_OFFLINE,
  type RedditWriteEntry,
} from '../src/reddit-write/service.js'
import { applyExternalPost } from '../src/reddit-write/wire.js'

const WS = 'ws_r' as never
const T0 = Date.parse('2026-10-15T09:00:00.000Z')

function make() {
  const now = { ms: T0 }
  const records: OutboundRecordInput[] = []
  const settled: RedditWriteEntry[] = []
  const emitted: string[] = []
  let svc: ReturnType<typeof createRedditWriteService> | undefined
  const actions = createAdsActionsService({
    workspace_id: WS,
    nowMs: () => now.ms,
    evidence: memoryEvidenceStore({ nowMs: () => now.ms }),
    onEvent: (e) => svc?.onActionEvent(e),
    wait: async (_ms, woke) => woke,
  })
  svc = createRedditWriteService({
    workspace_id: WS,
    clock: { now: () => new Date(now.ms).toISOString() },
    approvals: { create: async () => ({}) as never },
    emit: (type) => emitted.push(type),
    brand: () => 'IVRA',
    actions,
    record: (input) => {
      records.push(input)
      return { id: `ob_${records.length}` } as never
    },
    onSettled: (e) => settled.push({ ...e }),
  })
  const iso = (): string => new Date(now.ms).toISOString()
  return { svc, actions, now, records, settled, emitted, iso }
}

const record: OutboundRecordInput = {
  source_key: 'approval:ap_1',
  channel: 'reddit',
  action: 'reply',
  kind: 'reddit_write',
  content: 'Hi Alice',
}
const replyWrite = {
  kind: 'reply' as const,
  parent: 't1_c1',
  permalink: '/r/ivraxr/comments/abc/s/c1/',
}

/** WP432：人在插件侧边栏里点「打开这一条」（最新那条等你发的）——插件这才拿到那一件活。 */
async function openLatest(m: ReturnType<typeof make>) {
  const row = m.svc.writes().find((w) => w.state === 'awaiting')
  if (row === undefined) return undefined
  const got = await m.svc.open(row.job_id)
  return got.ok ? got.job : undefined
}

/** 交一条给插件、人点开、回一个结局。回那一件活的 id。 */
async function sendAndEnd(
  m: ReturnType<typeof make>,
  outcome: 'handover' | 'stopped' | 'failed',
  message: string,
): Promise<string> {
  await m.svc.send({
    approval_item_id: 'ap_1',
    write: replyWrite,
    text: 'Hi Alice',
    subreddit: 'ivraxr',
    record,
    label: '回复 alice（Reddit · r/ivraxr）',
  })
  const job = await openLatest(m)
  m.actions.result(job?.id as string, { outcome, message, step: 6, reads: {} })
  return job?.id as string
}

describe('WP332 没发出去 → 岗位页提醒 +「再填一次」（决策 762）', () => {
  for (const [outcome, message] of [
    [
      'handover',
      '等了 30 分钟没看到发出去的那一条（没点发送，或者被拦了）。已停下；这一条不算发出。',
    ],
    ['stopped', '你点了停止，已停下。'],
    ['handover', 'Chrome 里的 Reddit 没登录（或登录掉了）。'],
  ] as const)
    it(`${message.slice(0, 12)}…：照实一句话、能再填一次、提醒条出一行`, async () => {
      const m = make()
      await sendAndEnd(m, outcome, message)
      const row = m.svc.writes()[0]
      expect(row).toMatchObject({
        state: 'failed',
        message,
        outcome,
        can_refill: true,
        label: '回复 alice（Reddit · r/ivraxr）',
      })
      expect(redditWriteNotices(m.svc.writes(), m.iso())).toHaveLength(1)
    })

  it('再填一次：同一份草稿、同一张卡交给插件（新的一件活），不出新卡；做完记一行发出记录', async () => {
    const m = make()
    const first = await sendAndEnd(m, 'handover', '等了 30 分钟没看到发出去的那一条。')
    const out = await m.svc.refill(first)
    expect(out.ok).toBe(true)
    const view = (out as { view: { job_id: string; state: string; refills?: number } }).view
    expect(view.job_id).not.toBe(first)
    expect(view).toMatchObject({ state: 'awaiting', refills: 1 })
    expect(m.emitted).toContain('reddit.write_refilled')
    expect(m.svc.writes()).toHaveLength(1)
    expect(redditWriteNotices(m.svc.writes(), m.iso())).toEqual([])

    const job = await openLatest(m)
    expect(job?.id).toBe(view.job_id)
    expect(job?.approval_id).toBe('ap_1')
    expect(job?.plan.allow.values).toEqual(['Hi Alice'])
    expect(job?.plan.steps[0]).toMatchObject({
      op: 'goto',
      url: 'https://www.reddit.com/r/ivraxr/comments/abc/s/c1/',
      // WP467：带上帖子 id（已经开着这个帖子就地填）
      post: 'abc',
    })
    m.actions.result(job?.id as string, {
      outcome: 'done',
      message: '做完了。',
      step: 6,
      reads: { fullname: 't1_n1', permalink: '/r/ivraxr/comments/abc/s/n1/' },
    })
    expect(m.svc.writes()[0]).toMatchObject({ state: 'sent', record_id: 'ob_1' })
    expect(m.records).toHaveLength(1)
    expect(m.records[0]).toMatchObject({ external_id: 't1_n1', content: 'Hi Alice' })
    expect(m.settled.map((e) => e.state)).toEqual(['failed', 'sent'])
    // 发出去之后不能再填；老那一件活的迟到事件不认
    expect(await m.svc.refill(view.job_id)).toMatchObject({ ok: false })
  })

  it('WP478：岗位页上修改过再填——交给插件的是改过的字，这一条的草稿换成它（侧边栏看到同一段），批的那一版留着', async () => {
    const m = make()
    const first = await sendAndEnd(m, 'handover', '等了 30 分钟没看到发出去的那一条。')
    // Markdown 记号转纯文字（决策 1510）
    const out = await m.svc.refill(first, { text: '**Hi Alice**, here is the fix.' })
    expect(out.ok).toBe(true)
    const view = (out as { view: { job_id: string; text?: string } }).view
    expect(view.text).toBe('Hi Alice, here is the fix.')
    expect(m.svc.writes()).toHaveLength(1)
    const job = await openLatest(m)
    expect(job?.plan.allow.values).toEqual(['Hi Alice, here is the fix.'])
    m.actions.result(job?.id as string, {
      outcome: 'done',
      message: '做完了。',
      step: 6,
      reads: { fullname: 't1_n2', permalink: '/r/ivraxr/comments/abc/s/n2/' },
    })
    expect(m.records[0]).toMatchObject({ content: 'Hi Alice, here is the fix.' })
  })

  it('WP478：不带字 = 原样再填；带空字不交、照实说', async () => {
    const m = make()
    const first = await sendAndEnd(m, 'handover', '等了 30 分钟没看到发出去的那一条。')
    expect(await m.svc.refill(first, { text: '   ' })).toMatchObject({ ok: false })
    const out = await m.svc.refill(first)
    expect((out as { view: { text?: string } }).view.text).toBe('Hi Alice')
  })

  it('WP432：7 天没在插件里打开也能再填；插件不在线时照实说「打开 Chrome」', async () => {
    const m = make()
    await m.svc.send({
      approval_item_id: 'ap_1',
      write: replyWrite,
      text: 'Hi Alice',
      subreddit: 'ivraxr',
      record,
    })
    m.now.ms += 7 * 24 * 60 * 60 * 1000
    await m.actions.sweep()
    const row = m.svc.writes()[0]
    expect(row).toMatchObject({ state: 'failed', outcome: 'expired', can_refill: true })
    const out = await m.svc.refill(row?.job_id as string)
    expect(out.ok).toBe(true)
    expect(m.svc.writes()[0]?.message).toBe(OPEN_IN_PLUGIN_OFFLINE)
  })

  it('收起之后不出；再填又没发出去 → 重新出，同一条只一行；七天前的不出', async () => {
    const m = make()
    const first = await sendAndEnd(m, 'stopped', '你点了停止，已停下。')
    expect(m.svc.dismiss(first)?.dismissed).toBe(true)
    expect(redditWriteNotices(m.svc.writes(), m.iso())).toEqual([])
    const out = await m.svc.refill(first)
    const job = await openLatest(m)
    expect(job?.id).toBe((out as { view: { job_id: string } }).view.job_id)
    m.actions.result(job?.id as string, {
      outcome: 'handover',
      message: 'Reddit 要你做一次验证。已停下，请你自己处理。',
      step: 6,
      reads: {},
    })
    const notices = redditWriteNotices(m.svc.writes(), m.iso())
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ refills: 1, message: expect.stringContaining('验证') })
    expect(
      redditWriteNotices(m.svc.writes(), new Date(m.now.ms + 8 * 86_400_000).toISOString()),
    ).toEqual([])
  })

  it('还在插件那边 / 找不到 / 老进度没记草稿：不能再填，照实说', async () => {
    const m = make()
    await m.svc.send({
      approval_item_id: 'ap_1',
      write: replyWrite,
      text: 'Hi Alice',
      subreddit: 'ivraxr',
      record,
    })
    const queued = m.svc.writes()[0]?.job_id as string
    expect(await m.svc.refill(queued)).toMatchObject({ ok: false, message: expect.any(String) })
    expect(await m.svc.refill('rdw_nope')).toMatchObject({ ok: false })
    expect(m.svc.writes()[0]?.can_refill).toBeUndefined()
  })
})

describe('WP332 公关在别人帖子下回一条评论：带上那条评论的链接', () => {
  const post: ExternalPost = {
    id: 'ep_2',
    workspace_id: WS,
    role_id: 'pr.reddit',
    kind: 'comment',
    platform: 'reddit',
    venue: 'r/smartglasses',
    body: 'We have an anti-fog insert for that.',
    status: 'draft',
    rules_checked: { ok: true, reasons: [], checked_at: '2026-10-15T00:00:00.000Z' },
    parent_external_id: 't1_k7',
    parent_permalink: '/r/smartglasses/comments/p9/fog/k7/',
    created_at: '2026-10-15T00:00:00.000Z',
  }
  const change = {
    id: 'ch_2',
    workspace_id: WS,
    kind: 'community_post',
    role_id: 'pr.reddit',
    target: { type: 'external_post', id: 'ep_2' },
    after: { platform: 'reddit', venue: 'r/smartglasses', body: post.body },
    approval: { item_id: 'ap_7', by: 'p_1', at: '2026-10-15T00:00:00.000Z' },
  } as unknown as StagedChange

  it('卡上有链接 → 插件走楼中楼（打开那条评论、填进它的回复框）', async () => {
    const m = make()
    await m.actions.next(['reddit'], 0)
    const r = await applyExternalPost(change, { writes: m.svc, post: () => post })
    expect(r?.status).toBe('ok')
    // WP432：定时领活领不到
    expect((await m.actions.next(['reddit'], 0)).job).toBeUndefined()
    const job = await openLatest(m)
    expect(job?.plan.kind).toBe('reddit_reply')
    expect(job?.plan.steps[0]).toEqual({
      op: 'goto',
      url: 'https://www.reddit.com/r/smartglasses/comments/p9/fog/k7/',
    })
    m.actions.result(job?.id as string, {
      outcome: 'done',
      message: '做完了。',
      step: 6,
      reads: { fullname: 't1_m1', permalink: '/r/smartglasses/comments/p9/fog/m1/' },
    })
    expect(m.records[0]).toMatchObject({
      action: 'reply',
      parent_external_id: 't1_k7',
      thread_url: 'https://www.reddit.com/r/smartglasses/comments/p9/fog/k7/',
      external_id: 't1_m1',
    })
  })

  it('卡上没链接（老卡）→ 照实失败，不交给插件', async () => {
    const m = make()
    const { parent_permalink: _drop, ...old } = post
    const r = await applyExternalPost(change, { writes: m.svc, post: () => old })
    expect(r).toMatchObject({
      status: 'failed',
      error: { message: expect.stringContaining('链接') },
    })
    expect((await m.actions.next(['reddit'], 0)).job).toBeUndefined()
  })
})

describe('WP332 找被回那条评论的链接', () => {
  const entry = (o: Partial<RedditWatchEntry>): RedditWatchEntry =>
    ({ fullname: 't1_k7', subreddit: 'smartglasses', ...o }) as RedditWatchEntry
  const none = { watchEntries: () => [], threads: () => [], mentions: () => [] }
  const ask = { fullname: 't1_k7', venue: 'r/smartglasses' }

  it('给的就是这条评论的链接 → 用它（整网址也认）', async () => {
    const find = redditParentLinker(none)
    expect(
      await find({
        ...ask,
        permalink: 'https://www.reddit.com/r/smartglasses/comments/p9/fog/k7/?context=3',
      }),
    ).toEqual({ ok: true, permalink: '/r/smartglasses/comments/p9/fog/k7/' })
  })

  it('从巡查条目 / 社群线程 / 提及里补齐', async () => {
    expect(
      await redditParentLinker({
        ...none,
        watchEntries: () => [
          entry({ url: 'https://www.reddit.com/r/smartglasses/comments/p9/fog/k7/' }),
        ],
      })(ask),
    ).toEqual({ ok: true, permalink: '/r/smartglasses/comments/p9/fog/k7/' })
    expect(
      await redditParentLinker({
        ...none,
        threads: () =>
          [
            {
              channel: 'reddit',
              external_id: 'k7',
              permalink: '/r/smartglasses/comments/p9/fog/k7/',
            },
          ] as never,
      })(ask),
    ).toEqual({ ok: true, permalink: '/r/smartglasses/comments/p9/fog/k7/' })
    expect(
      await redditParentLinker({
        ...none,
        mentions: () => [{ url: 'https://www.reddit.com/r/smartglasses/comments/p9/fog/k7/' }],
      })(ask),
    ).toEqual({ ok: true, permalink: '/r/smartglasses/comments/p9/fog/k7/' })
  })

  it('只知道所在帖子 → 出卡前补读那个帖子的评论，按编号找到', async () => {
    const asked: string[] = []
    const find = redditParentLinker({
      ...none,
      watchEntries: () => [entry({ link_fullname: 't3_p9' })],
      readComments: async (url) => {
        asked.push(url)
        return {
          ok: true,
          items: [
            { id: 'zz', url: 'https://www.reddit.com/r/smartglasses/comments/p9/fog/zz/' },
            { id: 't1_k7', url: 'https://www.reddit.com/r/smartglasses/comments/p9/fog/k7/' },
          ],
        }
      },
    })
    expect(await find(ask)).toEqual({ ok: true, permalink: '/r/smartglasses/comments/p9/fog/k7/' })
    expect(asked).toEqual(['https://www.reddit.com/r/smartglasses/comments/p9/'])
    // 给的是帖子链接也一样补读
    expect(
      await redditParentLinker({
        ...none,
        readComments: async () => ({
          ok: true,
          items: [{ id: 'k7', url: 'https://www.reddit.com/r/smartglasses/comments/p9/fog/k7/' }],
        }),
      })({ ...ask, permalink: '/r/smartglasses/comments/p9/fog/' }),
    ).toMatchObject({ ok: true })
  })

  it('哪里都没有、补读也没找到 → 照实说（不编链接）', async () => {
    expect(await redditParentLinker(none)(ask)).toMatchObject({ ok: false })
    expect(
      await redditParentLinker({
        ...none,
        watchEntries: () => [entry({ link_fullname: 't3_p9' })],
        readComments: async () => ({ ok: true, items: [] }),
      })(ask),
    ).toMatchObject({ ok: false, message: expect.stringContaining('没找到') })
    expect(
      await redditParentLinker({
        ...none,
        watchEntries: () => [entry({ link_fullname: 't3_p9' })],
        readComments: async () => ({ ok: false, message: '两路都没取到' }),
      })(ask),
    ).toMatchObject({ ok: false, message: expect.stringContaining('两路都没取到') })
  })
})

describe('WP332 公关出卡前补齐链接；补不到不出卡', () => {
  function prMake(link?: (fullname: string) => string | undefined) {
    const store = createPrStore({ workspace_id: WS })
    const staged: { after: Record<string, unknown> }[] = []
    const svc = createPrService({
      workspace_id: WS,
      store,
      clock: { now: () => '2026-10-15T09:00:00.000Z' },
      approvals: {} as never,
      ledger: {
        stage: async (input) => {
          staged.push(input as never)
          return {
            ok: true,
            change: { id: 'ch_1' },
            approval: { id: 'ap_1', automation: { level_at_creation: 'L1' } },
          } as never
        },
        list: async () => [],
      },
      effectiveConfig: () => {
        throw new Error('no config')
      },
      appendEvent: () => {},
      random: () => 0.5,
      holdersOf: () => [],
      owner: async () => undefined,
      // 这里只看链接那一道：版规给一份放行的（真版规怎么判不是本单的事）
      policyOf: ({ venue }) => ({
        name: venue,
        no_self_promotion: false,
        flair_required: false,
        raw_rules: [],
        observed_at: '2026-10-15T00:00:00.000Z',
      }),
      ...(link === undefined
        ? {}
        : {
            redditParent: async ({ fullname }) => {
              const p = link(fullname)
              return p === undefined
                ? { ok: false as const, message: '巡查、社群线程、提及里都没有这条评论的链接' }
                : { ok: true as const, permalink: p }
            },
          }),
    })
    return { svc, store, staged }
  }
  const actor = {
    workspace_id: WS,
    person_id: 'p_1',
    assignment_id: 'as_1',
    role_id: 'pr.reddit',
  } as never
  const input = {
    platform: 'reddit',
    venue: 'r/smartglasses',
    kind: 'comment' as const,
    body: 'We have an anti-fog insert for that.',
    parent_external_id: 't1_k7',
  }

  it('从来源补到链接 → 出卡，卡上带被回那条的链接；帖子记下链接（批了插件按它找回复框）', async () => {
    const m = prMake(() => '/r/smartglasses/comments/p9/fog/k7/')
    const out = await m.svc.port.proposeExternalPost(actor, input)
    expect(out.staged).toBe(true)
    expect(m.staged[0]?.after).toMatchObject({
      parent_external_id: 't1_k7',
      parent_permalink: '/r/smartglasses/comments/p9/fog/k7/',
      parent_url: 'https://www.reddit.com/r/smartglasses/comments/p9/fog/k7/',
    })
    expect(m.store.post(out.post_id)?.parent_permalink).toBe('/r/smartglasses/comments/p9/fog/k7/')
  })

  it('补不到 → 不出卡、照实说；稿子留着', async () => {
    const m = prMake(() => undefined)
    const out = await m.svc.port.proposeExternalPost(actor, input)
    expect(out.staged).toBe(false)
    expect(out.message).toContain('找不到被回那条评论的链接')
    expect(m.staged).toEqual([])
    expect(m.store.post(out.post_id)).toMatchObject({
      status: 'draft',
      parent_external_id: 't1_k7',
    })
  })

  it('没装找链接的（只认调用方给的）：给了就出卡，没给不出', async () => {
    const m = prMake()
    const bad = await m.svc.port.proposeExternalPost(actor, input)
    expect(bad.staged).toBe(false)
    const good = await m.svc.port.proposeExternalPost(actor, {
      ...input,
      parent_permalink: 'https://www.reddit.com/r/smartglasses/comments/p9/fog/k7/',
    })
    expect(good.staged).toBe(true)
  })

  it('回帖子（t3_）、发新帖、别的平台：不要这条链接', async () => {
    const m = prMake(() => undefined)
    expect(
      (await m.svc.port.proposeExternalPost(actor, { ...input, parent_external_id: 't3_p9' }))
        .staged,
    ).toBe(true)
    expect(
      (await m.svc.port.proposeExternalPost(actor, { ...input, platform: 'quora' })).staged,
    ).toBe(true)
  })
})
