/**
 * WP254（决策 117）端到端（起真进程 → 打 HTTP；Reddit 一侧是内存里的 old.reddit 替身，**不访问
 * reddit.com、不起浏览器**；Discord 没连接，照实失败）。
 *
 * | 钉的是什么 | 为什么 |
 * |---|---|
 * | 回帖 → 一张回帖卡（不直接发）→ 批了过取消窗口 → 经 Reddit 出口（没 OAuth → 官方号浏览器）发出去 | 回帖卡批了就发 |
 * | 卡上的施行记录 applied、线程标成已回、读回页面看得到那句话 | 结果有账 |
 * | 带承诺词的回帖打回（400），不出卡 | 同客服回信那道门 |
 * | 别的社群的版务卡：改动卡（批准执行 / 不做）；批了 → 经渠道适配器；没连上 → 账本 failed + 原话、不重试 | 失败照实报 |
 */
import type { Assignment } from '@agentsws/contracts'
import { projectCard } from '@agentsws/deck'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import { createFakeOldReddit, type FakeOldReddit } from '../src/reddit-official-browser/stand-in.js'

const T0 = '2026-10-07T09:00:00.000Z'
const SECRETS_KEY = 'e'.repeat(64)
const ORIGIN = 'https://old.reddit.com'

let server: Server
let url: string
let reddit: Assignment
let discord: Assignment
let site: FakeOldReddit
let t = Date.parse(T0)

const api = async (path: string, init: RequestInit = {}, as?: Assignment): Promise<Response> => {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${server.bootstrap.internalToken}`)
  headers.set('X-Assignment', (as ?? reddit).id)
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  return fetch(`${url}${path}`, { ...init, headers })
}
const post = (path: string, body: unknown = {}, as?: Assignment): Promise<Response> =>
  api(path, { method: 'POST', body: JSON.stringify(body) }, as)
const data = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data

async function approve(id: string | undefined): Promise<void> {
  const fresh = await server.txn.approvals.get(id as string)
  const token = [...(fresh?.deliveries ?? [])]
    .reverse()
    .find((d) => d.status === 'sent')?.decision_token
  if (token === undefined) throw new Error(`这张卡没有本人的 decision_token：${fresh?.state}`)
  await server.txn.approvals.decide(id as string, server.bootstrap.person.id, {
    action: 'approve',
    decision_token: token,
    via: 'workstation',
  })
}

/** 定时发布那一轮（调度器按品牌各跑一次；它顺手补扫批了、过了取消窗口的版务卡与回帖卡）。 */
const tick = async () =>
  (await server.brands.forWorkspace(server.bootstrap.workspace.id)).socialService.publishDue()

beforeEach(async () => {
  t = Date.parse(T0)
  site = createFakeOldReddit(ORIGIN)
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
  const grant = (role_id: string) =>
    server.roles.assignments.create({
      person_id: server.bootstrap.person.id,
      workspace_id: server.bootstrap.workspace.id,
      granted_by: server.bootstrap.person.id,
      ranges: [{ kind: 'store' as const, id: 'store_1' }],
      role_id,
    })
  reddit = grant('social.reddit')
  discord = grant('social.discord')
})

afterEach(async () => {
  await server.close()
})

describe('WP254 回帖卡批了就发（Reddit：没有 OAuth → 官方号浏览器）', () => {
  it('回帖出卡不直接发 → 批了过取消窗口 → 发出去、读回看得到；带承诺词打回', async () => {
    const account = await data<{ id: string }>(
      await post('/v1/social/accounts', {
        channel: 'reddit',
        handle: 'r/inmoxr',
        display_name: 'INMO XR',
        url: 'https://www.reddit.com/r/inmoxr/',
        external_id: 'inmoxr',
        own_subreddit: true,
      }),
    )
    // 官方号：用户自己在窗口里登录
    await post('/v1/social/reddit-browser/login')
    site.loggedIn = true
    await post('/v1/social/reddit-browser/check')

    const thread = await data<{ thread: { id: string } }>(
      await post('/v1/social/threads', {
        account_id: account.id,
        external_id: 't3_held1',
        surface: 'thread',
        author_external_id: 'bob',
        author_handle: 'bob',
        text: 'Display is sharp, nice job on the hinge.',
      }),
    )
    const id = thread.thread.id

    // 带第一人称承诺：打回，不出卡
    const bad = await post(`/v1/social/threads/${id}/reply`, {
      text: 'We will refund you 100% tomorrow, guaranteed.',
    })
    expect(bad.status).toBe(400)

    const staged = await data<{ staged: boolean; approval_item_id?: string }>(
      await post(`/v1/social/threads/${id}/reply`, {
        text: 'Thanks Bob! Glad the hinge holds up.',
      }),
    )
    expect(staged.staged).toBe(true)
    const card = await server.txn.approvals.get(staged.approval_item_id as string)
    expect(card).toMatchObject({
      kind: 'outbound_draft',
      payload: { form: 'social_reply', channel: 'reddit', thread_id: id },
    })
    // 出卡不发
    expect(site.posts).toEqual([])

    await approve(staged.approval_item_id)
    await tick()
    // 取消窗口里：不发
    expect(site.posts).toEqual([])
    t += 121_000
    await tick()
    expect(site.posts).toEqual(['POST /api/comment thing_id=t3_held1'])
    expect(site.comments.held1).toEqual(['Thanks Bob! Glad the hinge holds up.'])
    expect((await server.txn.approvals.get(staged.approval_item_id as string))?.state).toBe(
      'applied',
    )
    const brand = await server.brands.forWorkspace(server.bootstrap.workspace.id)
    expect(brand.social.thread(id)?.status).toBe('answered')
    // 再扫一轮：不会再发一遍
    t += 121_000
    await tick()
    expect(site.posts).toHaveLength(1)
    const events = server.kernel.eventLog
      .readSync({ workspace_id: server.bootstrap.workspace.id })
      .filter((e) => e.type === 'social.reply_sent')
    expect(events).toHaveLength(1)
    expect(JSON.stringify(events)).not.toContain('Glad the hinge')
  })
})

describe('WP254 别的社群的版务卡：改动卡，批了经渠道适配器执行', () => {
  it('Discord 删帖卡排成改动卡（批准执行 / 不做）；批了 → 没连上 → 账本 failed + 原话，不重试', async () => {
    const account = await data<{ id: string }>(
      await post(
        '/v1/social/accounts',
        {
          channel: 'discord',
          handle: 'nordvolt-desk',
          display_name: 'Nordvolt 桌面党',
          url: 'https://discord.gg/nordvolt',
          external_id: '900000000000001/900000000000002',
        },
        discord,
      ),
    )
    const view = await data<{ approval_item_id?: string; moderation?: { action: string } }>(
      await post(
        '/v1/social/threads',
        {
          account_id: account.id,
          external_id: 'dc_t_2',
          surface: 'thread',
          author_external_id: 'u_1002',
          author_handle: 'cheap_cables_24h',
          text: '低价线材批发，加我私聊 →',
        },
        discord,
      ),
    )
    expect(view.moderation?.action).toBe('delete_post')
    const item = await server.txn.approvals.get(view.approval_item_id as string)
    const card = projectCard(item as NonNullable<typeof item>, {
      now: new Date(t).toISOString(),
      position_id: discord.id,
    })
    expect(card).toMatchObject({ layout: 'change', change_kind: 'community_moderation' })
    // 卡面：将执行什么、经哪条渠道、原话
    const after = (item?.payload as { after?: Record<string, unknown> } | undefined)?.after
    expect(after).toMatchObject({
      action: 'delete_post',
      action_label: '删掉这条',
      excerpt: '低价线材批发，加我私聊 →',
    })
    expect(String(after.will_do)).toContain('Discord')

    const [change] = await server.txn.ledger.list({
      workspace_id: server.bootstrap.workspace.id,
      kind: 'community_moderation',
    })
    await approve(view.approval_item_id)
    t += 121_000
    await tick()
    const failed = await server.txn.ledger.get(change?.id as string)
    expect(failed?.status).toBe('failed')
    expect(JSON.stringify(failed?.apply)).toContain('还没连上')
    // 库里那条线程没动（没真删成）
    const brand = await server.brands.forWorkspace(server.bootstrap.workspace.id)
    expect(brand.social.threads({ account_id: account.id })[0]?.status).toBe('open')
    // 不重试：再扫一轮账本还是 failed、没有第二次尝试
    t += 121_000
    await tick()
    expect((await server.txn.ledger.get(change?.id as string))?.status).toBe('failed')
    const tries = server.kernel.eventLog
      .readSync({ workspace_id: server.bootstrap.workspace.id })
      .filter((e) => e.type === 'social.moderation_failed')
    expect(tries).toHaveLength(1)
  })
})
