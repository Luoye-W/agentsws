import type { ActionJob } from '@agentsws/browser-action'
/**
 * WP332 端到端（起真进程 → 打 HTTP；插件一侧直接调本机那一份动作通道 = 替身插件，**不起浏览器、不碰 reddit.com**）。
 *
 * - 没发出去 → `GET /v1/social/reddit/writes` 里那一条能再填 →「再填一次」不出新卡、同一张卡交给插件 →
 *   人点了发送、插件读回 → 发出记录一行；收起提醒。
 * - 公关回一条评论：链接从社群线程补齐（装配里那一份找链接的接上了）；哪里都没有 → 不出卡、照实说。
 */
import type { Assignment, OutboundRecord, RedditWriteView } from '@agentsws/contracts'
import { redditWriteNotices } from '@agentsws/contracts'
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

const T0 = '2026-10-15T09:00:00.000Z'
const SECRETS_KEY = 'e'.repeat(64)

let server: Server
let url: string
let reddit: Assignment
let prReddit: Assignment
let as: Assignment
let t = Date.parse(T0)

const api = async (path: string, init: RequestInit = {}): Promise<Response> => {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${server.bootstrap.internalToken}`)
  headers.set('X-Assignment', as.id)
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
  const grant = (role_id: string): Assignment =>
    server.roles.assignments.create({
      person_id: server.bootstrap.person.id,
      workspace_id: server.bootstrap.workspace.id,
      granted_by: server.bootstrap.person.id,
      ranges: [{ kind: 'store' as const, id: 'store_1' }],
      role_id,
    })
  reddit = grant('social.reddit')
  prReddit = grant('pr.reddit')
  as = reddit
})

afterEach(async () => {
  await server.close()
})

describe('WP332 没发出去 → 再填一次（不用重批）', () => {
  it('人点了停止 → 能再填；再填不出新卡、同一张卡交给插件；读回 → 发出记录一行', async () => {
    const b = await brand()
    await b.adsActions?.next(['reddit'], 0)
    const text = 'Hi Alice, IVRA here. The anti-fog insert in the box helps a lot with glasses.'
    const staged = await data<{ approval_item_id: string }>(
      await post('/v1/social/reddit/stage', { target: replyTarget, text }),
    )
    await approve(staged.approval_item_id)
    t += 125_000
    expect(await b.redditWrites.sweep()).toBe(1)
    const first = await openAwaiting(b)
    b.adsActions?.result(first?.id as string, {
      outcome: 'stopped',
      message: '你点了停止，已停下。',
      step: 6,
      reads: {},
    })

    const rows = (await data<{ rows: RedditWriteView[] }>(await api('/v1/social/reddit/writes')))
      .rows
    expect(rows[0]).toMatchObject({ state: 'failed', outcome: 'stopped', can_refill: true })
    expect(redditWriteNotices(rows, new Date(t).toISOString())).toHaveLength(1)
    const cardsBefore = server.txn.runtime.store.listApprovals({ kind: 'outbound_draft' }).length

    const res = await post(`/v1/social/reddit/writes/${first?.id}/refill`)
    expect(res.status).toBe(200)
    const view = await data<RedditWriteView>(res)
    expect(view).toMatchObject({ state: 'awaiting', refills: 1 })
    expect(server.txn.runtime.store.listApprovals({ kind: 'outbound_draft' })).toHaveLength(
      cardsBefore,
    )
    const again = await openAwaiting(b)
    expect(again?.id).toBe(view.job_id)
    expect(again?.approval_id).toBe(staged.approval_item_id)
    expect(again?.plan.allow.values).toEqual([text])
    b.adsActions?.result(again?.id as string, {
      outcome: 'done',
      message: '做完了。',
      step: 6,
      reads: { fullname: 't1_n9', permalink: '/r/ivraxr/comments/abc/slug/n9/' },
    })
    const records = await data<OutboundRecord[]>(await api('/v1/outbound/records'))
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ external_id: 't1_n9', content: text })
    // 发出去之后再点：照实说（409），不再交
    expect((await post(`/v1/social/reddit/writes/${view.job_id}/refill`)).status).toBe(409)
  })

  it('WP478：岗位页「修改」过再填——带 text，交给插件的是改过的字，进度里的草稿也换成它', async () => {
    const b = await brand()
    await b.adsActions?.next(['reddit'], 0)
    const text = 'Hi Alice, IVRA here. The anti-fog insert in the box helps a lot with glasses.'
    const staged = await data<{ approval_item_id: string }>(
      await post('/v1/social/reddit/stage', { target: replyTarget, text }),
    )
    await approve(staged.approval_item_id)
    t += 125_000
    await b.redditWrites.sweep()
    const first = await openAwaiting(b)
    b.adsActions?.result(first?.id as string, {
      outcome: 'stopped',
      message: '你点了停止，已停下。',
      step: 6,
      reads: {},
    })
    const edited = 'Hi Alice, IVRA here. Try the anti-fog insert that ships in the box.'
    const res = await post(`/v1/social/reddit/writes/${first?.id}/refill`, { text: edited })
    expect(res.status).toBe(200)
    const view = await data<RedditWriteView>(res)
    expect(view).toMatchObject({ state: 'awaiting', text: edited })
    const again = await openAwaiting(b)
    expect(again?.plan.allow.values).toEqual([edited])
  })

  it('收起提醒；找不到那一条 404', async () => {
    const b = await brand()
    await b.adsActions?.next(['reddit'], 0)
    const staged = await data<{ approval_item_id: string }>(
      await post('/v1/social/reddit/stage', { target: replyTarget, text: 'Hi Alice, IVRA here.' }),
    )
    await approve(staged.approval_item_id)
    t += 125_000
    await b.redditWrites.sweep()
    const job = await openAwaiting(b)
    b.adsActions?.result(job?.id as string, {
      outcome: 'handover',
      message: 'Chrome 里的 Reddit 没登录（或登录掉了）。',
      step: 1,
      reads: {},
    })
    const view = await data<RedditWriteView>(
      await post(`/v1/social/reddit/writes/${job?.id}/dismiss`),
    )
    expect(view.dismissed).toBe(true)
    const rows = (await data<{ rows: RedditWriteView[] }>(await api('/v1/social/reddit/writes')))
      .rows
    expect(redditWriteNotices(rows, new Date(t).toISOString())).toEqual([])
    expect((await post('/v1/social/reddit/writes/rdw_nope/dismiss')).status).toBe(404)
  })
})

describe('WP332 公关回一条评论：出卡前补齐那条评论的链接', () => {
  it('社群线程里记着链接 → 帖子记下链接；哪里都没有 → 不出卡、照实说', async () => {
    const b = await brand()
    as = reddit
    const account = await data<{ id: string }>(
      await post('/v1/social/accounts', {
        channel: 'reddit',
        handle: 'r/smartglasses',
        display_name: 'smartglasses',
        url: 'https://www.reddit.com/r/smartglasses/',
        external_id: 'smartglasses',
      }),
    )
    const thread = await data<{ thread: { id: string } }>(
      await post('/v1/social/threads', {
        account_id: account.id,
        external_id: 't1_k7',
        surface: 'comment',
        author_external_id: 'carol',
        author_handle: 'carol',
        text: 'Do these fog up?',
      }),
    )
    const row = b.social.thread(thread.thread.id)
    b.social.saveThread({
      ...(row as NonNullable<typeof row>),
      permalink: '/r/smartglasses/comments/p9/fog/k7/',
    })

    as = prReddit
    const found = await data<{ post_id: string; staged: boolean; message?: string }>(
      await post('/v1/pr/posts', {
        platform: 'reddit',
        venue: 'r/smartglasses',
        kind: 'comment',
        body: 'We have an anti-fog insert for that.',
        parent_external_id: 't1_k7',
      }),
    )
    // 链接那一道过了（出不出卡还要过版规那一道，不是本单的事）
    expect(found.message ?? '').not.toContain('找不到被回那条评论的链接')
    expect(b.pr.post(found.post_id)?.parent_permalink).toBe('/r/smartglasses/comments/p9/fog/k7/')

    const missing = await data<{ post_id: string; staged: boolean; message?: string }>(
      await post('/v1/pr/posts', {
        platform: 'reddit',
        venue: 'r/smartglasses',
        kind: 'comment',
        body: 'We have an anti-fog insert for that.',
        parent_external_id: 't1_zz404',
      }),
    )
    expect(missing.staged).toBe(false)
    expect(missing.message).toContain('找不到被回那条评论的链接')
  })
})
