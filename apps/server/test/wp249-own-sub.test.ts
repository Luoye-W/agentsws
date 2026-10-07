/**
 * WP249（决策 81 / 88 / 89）：自家版待处理，端到端（起真进程 → 打 HTTP；Reddit 一侧是内存里的
 * old.reddit 替身，**不访问 reddit.com、不起浏览器**）。
 *
 * | 钉的是什么 | 为什么 |
 * |---|---|
 * | 没登录官方号：照实说怎么接上 | 不当「0 条」 |
 * | 登录官方号 → 体检看到 u/xxx | 我们不碰密码，只看页面右上角 |
 * | 只拉标成自家版的版 | 别人的版我们不是版主 |
 * | 三类队列 + 入群申请照实说读不到 | 每条带建议（引用版规） |
 * | 动作出卡、不直接执行；同一条不出第二张 | 人点头才动 |
 * | 批了过取消窗口才执行、只执行卡上那一个、记账本 | 执行器那一跳 |
 * | 执行失败（验证码）照实报、停下 | 卡上 + 队列里那一条都看得见原话 |
 */
import type { Assignment, OwnSubQueueView } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import { createFakeOldReddit, type FakeOldReddit } from './fake-old-reddit-page.js'

const T0 = '2026-10-07T09:00:00.000Z'
const SECRETS_KEY = 'e'.repeat(64)
const ORIGIN = 'https://old.reddit.com'

let server: Server
let url: string
let reddit: Assignment
let site: FakeOldReddit
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

async function approve(approval_item_id: string | undefined): Promise<void> {
  const fresh = await server.txn.approvals.get(approval_item_id as string)
  const token = [...(fresh?.deliveries ?? [])]
    .reverse()
    .find((d) => d.status === 'sent')?.decision_token
  if (token === undefined) throw new Error(`这张卡没有本人的 decision_token：${fresh?.state}`)
  await server.txn.approvals.decide(approval_item_id as string, server.bootstrap.person.id, {
    action: 'approve',
    decision_token: token,
    via: 'workstation',
  })
}

beforeEach(async () => {
  t = Date.parse(T0)
  site = createFakeOldReddit(ORIGIN)
  site.queues.modqueue = [
    {
      kind: 't3',
      id: 'spam1',
      title: 'Cheap INMO Air3 wholesale, DM me on telegram',
      body: 'best price https://bit.ly/x',
      author: 'spammer1',
      reports: ['No spam or self-promotion'],
    },
    {
      kind: 't1',
      id: 'cmt1',
      title: 'Battery life',
      body: 'This is off topic',
      author: 'alice',
      reports: ['Stay on topic'],
    },
    {
      kind: 't3',
      id: 'held1',
      title: 'My review',
      body: 'Display is sharp.',
      author: 'bob',
      reports: [],
    },
  ]
  site.queues.unmoderated = [
    {
      kind: 't3',
      id: 'new1',
      title: 'Hello from Berlin',
      body: 'Just got mine!',
      author: 'carol',
      reports: [],
    },
  ]
  server = await createServer({
    quiet: true,
    clock: { now: () => new Date(t).toISOString() },
    scheduleIntervalMs: 0,
    startRun: false,
    env: { AGENTSWS_OWNER_EMAIL: 'luoye@example.com', AGENTSWS_SECRETS_KEY: SECRETS_KEY },
    redditOfficialBrowser: {
      origin: ORIGIN,
      openPage: site.opener(),
      sleep: async () => undefined,
    },
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

async function registerSubs(): Promise<string> {
  const own = await post('/v1/social/accounts', {
    channel: 'reddit',
    handle: 'r/inmoxr',
    display_name: 'INMO XR',
    url: 'https://www.reddit.com/r/inmoxr/',
    external_id: 'inmoxr',
    own_subreddit: true,
  })
  expect(own.status).toBe(201)
  // 别人的版（没标自家版）：不拉
  await post('/v1/social/accounts', {
    channel: 'reddit',
    handle: 'r/augmentedreality',
    display_name: 'AR',
    url: 'https://www.reddit.com/r/augmentedreality/',
    external_id: 'augmentedreality',
  })
  return (await data<{ id: string }>(own)).id
}

async function login(): Promise<void> {
  const opened = await data<{ state: string }>(await post('/v1/social/reddit-browser/login'))
  expect(opened.state).toBe('login_window_open')
  site.loggedIn = true // 用户在窗口里自己登录了
  const checked = await data<{ state: string; username?: string }>(
    await post('/v1/social/reddit-browser/check'),
  )
  expect(checked).toMatchObject({ state: 'logged_in', username: 'inmo_official' })
}

const queue = async (): Promise<OwnSubQueueView> => data(await api('/v1/social/own-sub/queue'))

describe('WP249 自家版待处理', () => {
  it('没登录官方号：照实说怎么接上，不当 0 条', async () => {
    await registerSubs()
    const q = await queue()
    expect(q.channel).toBe('none')
    expect(q.items).toEqual([])
    expect(q.sources.every((s) => s.status === 'failed')).toBe(true)
    expect(q.sources[0]?.message).toContain('登录官方号')
    expect(site.visited).toEqual([])
  })

  it('登录后：只拉自家版，三类分好、带建议；入群申请照实说读不到', async () => {
    await registerSubs()
    await login()
    const q = await queue()
    expect(q.channel).toBe('browser')
    expect(q.subreddits.map((s) => s.name)).toEqual(['inmoxr'])
    expect(site.visited.some((p) => p.includes('augmentedreality'))).toBe(false)
    expect(q.items.map((i) => [i.id, i.kind, i.suggestion.verdict])).toEqual([
      ['t3_spam1', 'reported', 'remove'],
      ['t1_cmt1', 'reported', 'ignore'],
      ['t3_held1', 'held', 'approve'],
      ['t3_new1', 'new_post', 'ignore'],
    ])
    expect(q.items[0]?.suggestion).toMatchObject({ rule: 'No spam or self-promotion' })
    expect(q.rules).toEqual([
      { subreddit: 'inmoxr', rules: ['No spam or self-promotion', 'Be civil', 'Stay on topic'] },
    ])
    expect(q.sources.find((s) => s.source === 'join_requests')).toMatchObject({
      status: 'unsupported',
    })
    // 读的时候一个写请求都没发
    expect(site.posts).toEqual([])
  })

  it('.json 读不回来时退到页面上的 div.thing', async () => {
    await registerSubs()
    await login()
    site.jsonBroken = true
    const q = await queue()
    expect(q.items.map((i) => i.id)).toContain('t3_spam1')
    expect(q.items.find((i) => i.id === 't3_spam1')?.report_reasons).toEqual([
      'No spam or self-promotion',
    ])
  })

  it('移除出卡（附版规理由）→ 不直接执行 → 批了过取消窗口 → 只执行那一个、读回自证、记账本', async () => {
    const account_id = await registerSubs()
    await login()
    await queue()
    const res = await post('/v1/social/own-sub/stage', {
      account_id,
      item_id: 't3_spam1',
      action: 'remove',
      removal_rule: 'No spam or self-promotion',
    })
    expect(res.status).toBe(201)
    const staged = await data<{ staged: boolean; approval_item_id?: string; change_id?: string }>(
      res,
    )
    expect(staged.staged).toBe(true)
    expect(site.posts).toEqual([])
    // 卡上：将执行的动作、AI 建议、理由、原文、公开留的那句理由
    const card = await server.txn.approvals.get(staged.approval_item_id as string)
    const face = `${card?.title} ${card?.summary}`
    expect(face).toContain('移除 u/spammer1 的这条帖子')
    expect(face).toContain('AI 建议：移除')
    expect(face).toContain('Cheap INMO Air3')
    const change = await server.txn.ledger.get(staged.change_id as string)
    expect(change?.after).toMatchObject({
      source: 'own_sub_queue',
      action: 'delete_post',
      removal_message: 'Removed: this breaks r/inmoxr rule "No spam or self-promotion".',
    })
    // 同一条不出第二张
    const again = await data<{ staged: boolean; message?: string }>(
      await post('/v1/social/own-sub/stage', { account_id, item_id: 't3_spam1', action: 'remove' }),
    )
    expect(again.staged).toBe(false)
    expect((await queue()).items.find((i) => i.id === 't3_spam1')?.pending_approval_id).toBe(
      staged.approval_item_id,
    )

    await approve(staged.approval_item_id)
    // 取消窗口里：不执行
    await queue()
    expect(site.posts).toEqual([])
    t += 121_000
    const after = await queue()
    expect(site.posts).toEqual([
      'POST /api/remove id=t3_spam1',
      'POST /api/comment thing_id=t3_spam1',
    ])
    expect(site.comments.spam1).toEqual([
      'Removed: this breaks r/inmoxr rule "No spam or self-promotion".',
    ])
    expect(after.items.map((i) => i.id)).not.toContain('t3_spam1')
    expect((await server.txn.ledger.get(staged.change_id as string))?.status).toBe('applied')
    expect(site.blocked).toEqual([])
  })

  it('封禁出卡（永久 → L1）；批了执行，封禁名单里读得回他', async () => {
    const account_id = await registerSubs()
    await login()
    await queue()
    const staged = await data<{
      staged: boolean
      approval_item_id?: string
      change_id?: string
      level?: string
    }>(await post('/v1/social/own-sub/stage', { account_id, item_id: 't3_spam1', action: 'ban' }))
    expect(staged).toMatchObject({ staged: true, level: 'L1' })
    await approve(staged.approval_item_id)
    t += 121_000
    await queue()
    expect(site.banned).toEqual(['spammer1'])
    expect((await server.txn.ledger.get(staged.change_id as string))?.status).toBe('applied')
  })

  it('执行时弹验证码：照实停下、记失败，官方号通道停一阵（不重试、不硬读）', async () => {
    const account_id = await registerSubs()
    await login()
    await queue()
    const staged = await data<{ approval_item_id?: string; change_id?: string }>(
      await post('/v1/social/own-sub/stage', {
        account_id,
        item_id: 't3_held1',
        action: 'approve',
      }),
    )
    await approve(staged.approval_item_id)
    t += 121_000
    site.captchaNext = true
    const q = await queue()
    expect(site.posts).toEqual([])
    expect((await server.txn.ledger.get(staged.change_id as string))?.status).toBe('failed')
    const item = await server.txn.approvals.get(staged.approval_item_id as string)
    expect(item?.state).toBe('apply_failed')
    // 被拦之后这一轮读也停了（不重试、不硬读）
    expect(q.browser.state).toBe('blocked')
    const status = await data<{ state: string; message?: string }>(
      await api('/v1/social/reddit-browser'),
    )
    expect(status.state).toBe('blocked')
    expect(status.message).toContain('人机验证')
  })

  it('写也限速：两张卡同一刻施行，第二张照实说「要隔 20 秒」、队列里那一条带原话', async () => {
    const account_id = await registerSubs()
    await login()
    await queue()
    const a = await data<{ approval_item_id?: string; change_id?: string }>(
      await post('/v1/social/own-sub/stage', {
        account_id,
        item_id: 't3_held1',
        action: 'approve',
      }),
    )
    const b = await data<{ approval_item_id?: string; change_id?: string }>(
      await post('/v1/social/own-sub/stage', { account_id, item_id: 't3_new1', action: 'approve' }),
    )
    await approve(a.approval_item_id)
    await approve(b.approval_item_id)
    t += 121_000
    const q = await queue()
    expect(site.posts).toEqual(['POST /api/approve id=t3_held1'])
    expect((await server.txn.ledger.get(b.change_id as string))?.status).toBe('failed')
    expect(q.items.find((i) => i.id === 't3_new1')?.last_failure).toContain('要隔 20 秒')
    // 过一会儿在卡片流里点「重试」就做成了
    t += 30_000
    await server.txn.approvals.retryApply(b.approval_item_id as string, server.bootstrap.person.id)
    expect(site.posts).toEqual(['POST /api/approve id=t3_held1', 'POST /api/approve id=t3_new1'])
  })
})
