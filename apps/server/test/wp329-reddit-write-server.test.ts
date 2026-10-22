import type { ActionJob } from '@agentsws/browser-action'
/**
 * WP329 端到端（起真进程 → 打 HTTP；插件一侧直接调本机那一份动作通道，**不起浏览器、不碰 reddit.com**）。
 *
 * | 钉的是什么 | 为什么 |
 * |---|---|
 * | 起草（没接模型 → 模板并照实说）→ 出卡（永远 L1、审批人是本人）→ 带承诺词不出卡 | 663 / 669 |
 * | 批了过取消窗口 → 交给插件（卡记 `reddit_fill`），**这时还不记发出记录** | 插件确认了才算发出 |
 * | 插件领到的活：打开那条评论、点 reply、填草稿、等人点发送；白名单里没有发送按钮 | 人点发送 |
 * | 插件回「做完」+ 读回编号 / 链接 → 发出记录多一行（编号、链接、回的是谁）；对方再回挂回这一行 | WP323 |
 * | 插件回「停下交给人」→ 照实记「没发出去」+ 原因，不记发出记录、不重试 | 照实报 |
 * | 社媒线程的 Reddit 回帖卡也走插件：做完线程标已回、记下回的那条编号 | 楼中楼 |
 */
import type { Assignment, OutboundRecord, RedditWriteView } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'

/** WP432：人在插件侧边栏里点「打开这一条」（最新那条等你发的）——插件这才拿到那一件活（定时领活领不到）。 */
async function openAwaiting(b: {
  adsActions?: { next(p: ['reddit'], w: number): Promise<{ job?: unknown }> } | undefined
  redditWrites?: {
    writes(): { state: string; job_id: string }[]
    open(id: string): Promise<{ ok: true; job: ActionJob } | { ok: false; message: string }>
  }
}): Promise<ActionJob | undefined> {
  expect((await b.adsActions?.next(['reddit'], 0))?.job).toBeUndefined()
  const row = b.redditWrites?.writes().find((w) => w.state === 'awaiting')
  if (row === undefined) return undefined
  const got = await b.redditWrites?.open(row.job_id)
  return got?.ok === true ? got.job : undefined
}

const T0 = '2026-10-14T09:00:00.000Z'
const SECRETS_KEY = 'e'.repeat(64)

let server: Server
let url: string
let reddit: Assignment
let t = Date.parse(T0)

const api = async (path: string, init: RequestInit = {}): Promise<Response> => {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${server.bootstrap.internalToken}`)
  headers.set('X-Assignment', reddit.id)
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  return fetch(`${url}${path}`, { ...init, headers })
}
const post = (path: string, body: unknown = {}): Promise<Response> =>
  api(path, { method: 'POST', body: JSON.stringify(body) })
const data = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data

async function approve(id: string): Promise<void> {
  const fresh = await server.txn.approvals.get(id)
  const token = [...(fresh?.deliveries ?? [])]
    .reverse()
    .find((d) => d.status === 'sent')?.decision_token
  if (token === undefined) throw new Error(`这张卡没有本人的 decision_token：${fresh?.state}`)
  await server.txn.approvals.decide(id, server.bootstrap.person.id, {
    action: 'approve',
    decision_token: token,
    via: 'workstation',
  })
}

const brand = () => server.brands.forWorkspace(server.bootstrap.workspace.id)

const replyTarget = {
  kind: 'reply',
  subreddit: 'ivraxr',
  parent_fullname: 't1_c1',
  permalink: '/r/ivraxr/comments/abc/slug/c1/',
  post_title: 'Does the Air3 work with glasses?',
  parent_author: 'alice',
  parent_text: 'Mine fogs up a bit when I wear glasses.',
  inbox_type: 'comment_reply',
  source: { type: 'reddit_watch_item', id: 'rw_1' },
}

beforeEach(async () => {
  t = Date.parse(T0)
  server = await createServer({
    quiet: true,
    clock: { now: () => new Date(t).toISOString() },
    scheduleIntervalMs: 0,
    startRun: false,
    env: { AGENTSWS_OWNER_EMAIL: 'luoye@example.com', AGENTSWS_SECRETS_KEY: SECRETS_KEY },
  })
  ;({ url } = await server.listen(0))
  reddit = server.roles.assignments.create({
    person_id: server.bootstrap.person.id,
    workspace_id: server.bootstrap.workspace.id,
    granted_by: server.bootstrap.person.id,
    ranges: [{ kind: 'store' as const, id: 'store_1' }],
    role_id: 'social.reddit',
  })
})

afterEach(async () => {
  await server.close()
})

/** 插件来过一次（连着 Reddit）。 */
async function pluginSeen(): Promise<void> {
  await (await brand()).adsActions?.next(['reddit'], 0)
}

/** 起草 → 出卡 → 批 → 过取消窗口施行。回卡 id。 */
async function stageAndApprove(text: string): Promise<string> {
  const staged = await data<{ staged: boolean; approval_item_id?: string; message?: string }>(
    await post('/v1/social/reddit/stage', { target: replyTarget, text }),
  )
  expect(staged.staged, staged.message).toBe(true)
  const id = staged.approval_item_id as string
  await approve(id)
  t += 125_000
  expect(await (await brand()).redditWrites.sweep()).toBe(1)
  return id
}

describe('WP329 Reddit 写：起草 → 卡 → 插件填草稿、人点发送 → 读回 → 发出记录', () => {
  it('起草没接模型：给一句开头并照实说；起草不出卡', async () => {
    const draft = await data<{ text: string; source: string; note?: string; facts: unknown[] }>(
      await post('/v1/social/reddit/draft', { target: replyTarget }),
    )
    expect(draft.source).toBe('template')
    expect(draft.text).toContain('alice')
    expect(draft.note).toContain('没用 AI')
    expect(Array.isArray(draft.facts)).toBe(true)
    const cards = server.txn.runtime.store.listApprovals({ kind: 'outbound_draft' })
    expect(cards).toEqual([])
  })

  it('带承诺词不出卡；正常的出一张永远 L1、发给本人的「发出去」卡', async () => {
    const bad = await data<{ staged: boolean; message?: string }>(
      await post('/v1/social/reddit/stage', {
        target: replyTarget,
        text: 'We will refund you 100% tomorrow, guaranteed.',
      }),
    )
    expect(bad.staged).toBe(false)
    const ok = await data<{ staged: boolean; approval_item_id: string }>(
      await post('/v1/social/reddit/stage', {
        target: replyTarget,
        text: 'Hi Alice, IVRA here. The anti-fog insert in the box helps a lot with glasses.',
      }),
    )
    expect(ok.staged).toBe(true)
    const card = await server.txn.approvals.get(ok.approval_item_id)
    expect(card).toMatchObject({
      kind: 'outbound_draft',
      state: 'pending',
      payload: { form: 'reddit_write', channel: 'reddit', reddit: { kind: 'reply' } },
      automation: { level_at_creation: 'L1', auto_approved: false },
    })
    expect(card?.routing.recipients.map((r) => r.person)).toEqual([server.bootstrap.person.id])
  })

  it('批了 → 交给插件；插件填好、人点发送、读回 → 发出记录多一行，对方再回挂回这一行', async () => {
    await pluginSeen()
    const text = 'Hi Alice, IVRA here. The anti-fog insert in the box helps a lot with glasses.'
    const id = await stageAndApprove(text)
    const card = await server.txn.approvals.get(id)
    expect(card?.state).toBe('applied')
    expect(card?.apply?.outcome_ref).toMatchObject({ type: 'reddit_fill' })
    // 交给插件 ≠ 发出去：这时还不记发出记录
    expect(await data<OutboundRecord[]>(await api('/v1/outbound/records'))).toEqual([])

    const b = await brand()
    const job = await openAwaiting(b)
    expect(job?.plan).toMatchObject({ platform: 'reddit', kind: 'reddit_reply', pace: 'write' })
    expect(job?.approval_id).toBe(id)
    expect(job?.plan.steps[0]).toMatchObject({
      op: 'goto',
      url: 'https://www.reddit.com/r/ivraxr/comments/abc/slug/c1/',
      // WP467：带上帖子 id（已经开着这个帖子就地填）
      post: 'abc',
    })
    expect(job?.plan.allow.values).toEqual([text])
    expect(job?.plan.allow.click.join(' ')).not.toMatch(/save|submit/u)
    b.adsActions?.progress(job?.id as string, { step: 6, of: 6, label: '填好了，等你点发送' })
    const filling = await data<{ rows: RedditWriteView[] }>(await api('/v1/social/reddit/writes'))
    expect(filling.rows[0]?.state).toBe('filling')

    b.adsActions?.result(job?.id as string, {
      outcome: 'done',
      message: '做完了。',
      step: 6,
      reads: { fullname: 't1_new1', permalink: '/r/ivraxr/comments/abc/slug/new1/' },
    })
    const writes = await data<{ rows: RedditWriteView[] }>(await api('/v1/social/reddit/writes'))
    expect(writes.rows[0]).toMatchObject({
      state: 'sent',
      link: 'https://www.reddit.com/r/ivraxr/comments/abc/slug/new1/',
    })
    const records = await data<OutboundRecord[]>(await api('/v1/outbound/records'))
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      channel: 'reddit',
      action: 'reply',
      destination: 'r/ivraxr',
      counterpart: 'alice',
      content: text,
      external_id: 't1_new1',
      parent_external_id: 't1_c1',
      link: 'https://www.reddit.com/r/ivraxr/comments/abc/slug/new1/',
      approval_item_id: id,
      status: 'sent',
    })
    // 对方再回（WP328 读收件箱时按 parent_id 挂）→ 挂回这一行
    const followed = await data<OutboundRecord | null>(
      await post('/v1/outbound/follow-ups', {
        parent_external_id: 't1_new1',
        author: 'alice',
        text: 'Thanks, that worked!',
      }),
    )
    expect(followed?.follow_ups).toHaveLength(1)
  })

  it('插件停下交给人：照实记「没发出去」+ 原因，不记发出记录', async () => {
    await pluginSeen()
    await stageAndApprove('Hi Alice, IVRA here. The anti-fog insert in the box helps.')
    const b = await brand()
    const job = await openAwaiting(b)
    b.adsActions?.result(job?.id as string, {
      outcome: 'handover',
      message: '等了 30 分钟没看到发出去的那一条（没点发送，或者被拦了）。已停下；这一条不算发出。',
      step: 6,
      reads: {},
    })
    const writes = await data<{ rows: RedditWriteView[] }>(await api('/v1/social/reddit/writes'))
    expect(writes.rows[0]?.state).toBe('failed')
    expect(writes.rows[0]?.message).toContain('不算发出')
    expect(await data<OutboundRecord[]>(await api('/v1/outbound/records'))).toEqual([])
  })

  it('插件从没连过：不走程序直发（决策 761 关），等你在插件里打开，进度里说插件不在线', async () => {
    await stageAndApprove('Hi Alice, IVRA here. The anti-fog insert in the box helps.')
    const writes = await data<{ rows: RedditWriteView[] }>(await api('/v1/social/reddit/writes'))
    expect(writes.rows[0]?.state).toBe('awaiting')
    expect(writes.rows[0]?.message).toContain('插件不在线')
  })

  it('WP328 交过来的「待处理」条目：起草一份、直接出卡（人在卡上改字再批）；私信不回', async () => {
    const b = await brand()
    const actor = {
      workspace_id: server.bootstrap.workspace.id,
      person_id: server.bootstrap.person.id,
      assignment_id: reddit.id,
      role_id: reddit.role_id,
    }
    // WP411：品牌号怎么说话没定 → 先不起草（宿主出设置卡）；定了再起草
    expect(
      await b.redditWrites.draftAndStage(actor, { target: replyTarget as never }),
    ).toMatchObject({ staged: false, skipped: 'needs_persona' })
    const full = await server.brands.forWorkspace(server.bootstrap.workspace.id)
    full.redditPersona?.set({ stance: 'personal' })
    const out = await b.redditWrites.draftAndStage(
      {
        workspace_id: server.bootstrap.workspace.id,
        person_id: server.bootstrap.person.id,
        assignment_id: reddit.id,
        role_id: reddit.role_id,
      },
      { target: replyTarget as never, reason: '有人追问我们的回复' },
    )
    expect(out.staged).toBe(true)
    const card = await server.txn.approvals.get(
      (out as { approval_item_id: string }).approval_item_id,
    )
    expect(card?.payload).toMatchObject({
      form: 'reddit_write',
      reason: '有人追问我们的回复',
      body: { text: 'Hi alice, thanks for sharing this!' },
    })
    const dm = await b.redditWrites.draftAndStage(
      {
        workspace_id: server.bootstrap.workspace.id,
        person_id: server.bootstrap.person.id,
        assignment_id: reddit.id,
        role_id: reddit.role_id,
      },
      { target: { ...replyTarget, parent_fullname: 't4_x' } as never },
    )
    expect(dm.staged).toBe(false)
  })

  it('社媒线程的 Reddit 回帖卡（评论、带链接）也走插件：做完线程标已回', async () => {
    await pluginSeen()
    const account = await data<{ id: string }>(
      await post('/v1/social/accounts', {
        channel: 'reddit',
        handle: 'r/ivraxr',
        display_name: 'IVRA XR',
        url: 'https://www.reddit.com/r/ivraxr/',
        external_id: 'ivraxr',
        own_subreddit: true,
      }),
    )
    const thread = await data<{ thread: { id: string } }>(
      await post('/v1/social/threads', {
        account_id: account.id,
        external_id: 't1_c9',
        surface: 'comment',
        author_external_id: 'bob',
        author_handle: 'bob',
        text: 'Is the hinge sturdy?',
      }),
    )
    const b = await brand()
    // 链接由入库那一侧带上（自家版队列 / WP328 巡查）；这里直接补一格
    const row = b.social.thread(thread.thread.id)
    b.social.saveThread({
      ...(row as NonNullable<typeof row>),
      permalink: '/r/ivraxr/comments/xyz/s/c9/',
    })
    const staged = await data<{ approval_item_id: string }>(
      await post(`/v1/social/threads/${thread.thread.id}/reply`, {
        text: 'Hi Bob, yes, it is rated for daily folding.',
      }),
    )
    await approve(staged.approval_item_id)
    t += 125_000
    await b.socialService.publishDue()
    const job = await openAwaiting(b)
    expect(job?.plan.kind).toBe('reddit_reply')
    b.adsActions?.result(job?.id as string, {
      outcome: 'done',
      message: '做完了。',
      step: 6,
      reads: { fullname: 't1_r1', permalink: '/r/ivraxr/comments/xyz/s/r1/' },
    })
    expect(b.social.thread(thread.thread.id)).toMatchObject({
      status: 'answered',
      reply_external_id: 't1_r1',
    })
    const records = await data<OutboundRecord[]>(await api('/v1/outbound/records'))
    expect(records[0]).toMatchObject({ kind: 'social_reply', external_id: 't1_r1' })
  })
})
