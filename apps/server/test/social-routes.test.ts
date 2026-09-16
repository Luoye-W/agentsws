/**
 * WP73（56 §6 第三项）社媒库的 `/v1` 面，端到端（起真进程 → 打 HTTP）。
 *
 * 钉五件事，每一件都是 WP72 交付报告里那份"未完成"清单上的一条：
 *
 * 1. **社媒库有门了**：登记号、读帖子、读线程、读成员，都有真路由。
 * 2. **triage 有调用方**：一条新入站的帖子进来，类由 `social-core` 判，
 *    判成客户问题就出**转客服卡**——社媒运营一个字都不答（56 的边界）。
 * 3. **moderation 有调用方**：违反群规的那一条出一张 `community_moderation` 卡，
 *    没违反的只记一条分类结论。
 * 4. **写动作永远先出卡**：入群审核提的是 `community_membership`，不是直接改库。
 * 5. **成员名册那把闸**：客服的「社群管理」读得到线程、**读不到成员名册**
 *    （56 §4 那三处不同里最要紧的一处）。
 */
import type { Assignment } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'

const T0 = '2026-09-15T09:00:00.000Z'
const SECRETS_KEY = 'd'.repeat(64)

function makeClock(start = T0) {
  let t = Date.parse(start)
  return {
    now: () => new Date(t).toISOString(),
    advance: (ms: number) => {
      t += ms
    },
  }
}

function seeded(seed = 73): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

let server: Server
let url: string
/** 社群组那一条（Discord）：成员名册读得到。 */
let discord: Assignment
/** 客服的「社群管理」：线程读得到，成员名册**读不到**。 */
let support: Assignment

const api = async (
  path: string,
  init: RequestInit & { assignment?: string } = {},
): Promise<Response> => {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${server.bootstrap.internalToken}`)
  headers.set('X-Assignment', init.assignment ?? discord.id)
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  return fetch(`${url}${path}`, { ...init, headers })
}

const post = (path: string, body: unknown, assignment?: string): Promise<Response> =>
  api(path, {
    method: 'POST',
    body: JSON.stringify(body),
    ...(assignment === undefined ? {} : { assignment }),
  })

const data = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data

beforeEach(async () => {
  const clock = makeClock()
  server = await createServer({
    quiet: true,
    clock: { now: () => clock.now() },
    random: seeded(),
    scheduleIntervalMs: 0,
    startRun: false,
    env: { AGENTSWS_OWNER_EMAIL: 'luoye@example.com', AGENTSWS_SECRETS_KEY: SECRETS_KEY },
  })
  ;({ url } = await server.listen(0))
  const base = {
    person_id: server.bootstrap.person.id,
    workspace_id: server.bootstrap.workspace.id,
    granted_by: server.bootstrap.person.id,
    ranges: [{ kind: 'store' as const, id: 'store_1' }],
  }
  discord = server.roles.assignments.create({ ...base, role_id: 'social.discord' })
  support = server.roles.assignments.create({ ...base, role_id: 'dtc.community-support' })
})

afterEach(async () => {
  await server.close()
})

/** 登记一个 Discord 服务器，回它的 account_id。 */
async function addAccount(): Promise<string> {
  const res = await post('/v1/social/accounts', {
    channel: 'discord',
    handle: 'nordvolt-desk',
    display_name: 'Nordvolt 桌面党',
    url: 'https://discord.gg/nordvolt',
    external_id: '900000000000001/900000000000002',
  })
  expect(res.status).toBe(201)
  return (await data<{ id: string }>(res)).id
}

describe('WP73 社媒库路由：库有门了', () => {
  it('登记一个号之后清单上读得到它；按渠道筛只看自己那条', async () => {
    const id = await addAccount()
    const all = await data<{ rows: { id: string; channel: string }[] }>(
      await api('/v1/social/accounts'),
    )
    expect(all.rows.map((r) => r.id)).toContain(id)
    const meta = await data<{ rows: unknown[] }>(await api('/v1/social/accounts?channel=meta'))
    // 九条渠道之间零共享：Discord 那个号不该出现在 Meta 的清单里
    expect(meta.rows).toHaveLength(0)
  })

  it('不认识的渠道名回 400 + 一句人话，不是空清单', async () => {
    const res = await api('/v1/social/accounts?channel=weibo')
    expect(res.status).toBe(400)
    expect(((await res.json()) as { message: string }).message).toContain('weibo')
  })

  it('帖子清单四态分得开（退回混进排期里就再也没人发现它没发出去）', async () => {
    const account_id = await addAccount()
    const brand = await server.brands.forWorkspace(server.bootstrap.workspace.id)
    brand.social.savePost({
      id: 'sp_t1',
      account_id,
      channel: 'discord',
      kind: 'post',
      status: 'failed',
      body: '九宫格',
      failure_reason: '图片比例不符合要求',
    })
    const failed = await data<{ rows: { failure_reason?: string }[] }>(
      await api('/v1/social/posts?status=failed'),
    )
    expect(failed.rows).toHaveLength(1)
    // 平台退回来的原话原样端出去，不翻译成"出错了"
    expect(failed.rows[0]?.failure_reason).toBe('图片比例不符合要求')
    const scheduled = await data<{ rows: unknown[] }>(
      await api('/v1/social/posts?status=scheduled'),
    )
    expect(scheduled.rows).toHaveLength(0)
  })
})

describe('WP73 triage 有调用方了（56 那条边界在服务进程里的落点）', () => {
  it('群里有人问"我的单什么时候到" → 转客服卡；社媒运营一个字都不答', async () => {
    const account_id = await addAccount()
    const res = await post('/v1/social/threads', {
      account_id,
      external_id: 'dc_t_1',
      surface: 'thread',
      author_external_id: 'u_1003',
      author_handle: 'linaw',
      text: '我上周下的单到现在还没发货，单号 #10231，什么时候能寄出？',
    })
    expect(res.status).toBe(201)
    const view = await data<{
      triage: string
      route: string
      approval_item_id?: string
      thread: { status: string }
    }>(res)
    expect(view.triage).toBe('customer_question')
    expect(view.route).toBe('support')
    expect(view.approval_item_id).toBeDefined()
    // 线程从此归客服：社媒运营的"待处理"里它就不在了
    expect(view.thread.status).toBe('routed_to_support')
    const open = await data<{ rows: unknown[] }>(await api('/v1/social/threads?open=true'))
    expect(open.rows).toHaveLength(0)

    // 卡真的落到持有「社群管理」的那个人头上，而且带着原话
    const items = await server.txn.approvals.queue({
      workspace_id: server.bootstrap.workspace.id,
      person_id: server.bootstrap.person.id,
      lane: 'mine',
    })
    const card = items.find((i) => i.kind === 'claim')
    expect(card?.role_id).toBe('dtc.community-support')
    expect(String(card?.title)).toContain('转客服')
    expect(String((card?.payload as { text?: string } | undefined)?.text)).toContain('#10231')
  })

  it('违反群规的那一条出一张审核卡（community_moderation），不是直接删', async () => {
    const account_id = await addAccount()
    const view = await data<{
      triage: string
      moderation?: { action: string; matched_rules: string[] }
      approval_item_id?: string
    }>(
      await post('/v1/social/threads', {
        account_id,
        external_id: 'dc_t_2',
        surface: 'thread',
        author_external_id: 'u_1002',
        author_handle: 'cheap_cables_24h',
        text: '低价线材批发，加我私聊 →',
      }),
    )
    expect(view.triage).toBe('spam')
    expect(view.moderation?.action).toBe('delete_post')
    expect(view.moderation?.matched_rules[0]).toContain('推广链接')
    expect(view.approval_item_id).toBeDefined()
    const changes = await server.txn.ledger.list({
      workspace_id: server.bootstrap.workspace.id,
      kind: 'community_moderation',
    })
    expect(changes).toHaveLength(1)
    // **库里那条线程一个字都没动**：删是执行器在卡被批准之后做的事
    const brand = await server.brands.forWorkspace(server.bootstrap.workspace.id)
    expect(brand.social.threads()[0]?.status).toBe('open')
  })

  it('没违规也不是客户问题的那一条只记一条分类结论，不出卡', async () => {
    const account_id = await addAccount()
    const view = await data<{ triage: string; moderation?: { action: string } }>(
      await post('/v1/social/threads', {
        account_id,
        external_id: 'dc_t_3',
        surface: 'thread',
        author_external_id: 'u_1',
        author_handle: 'mikez',
        text: '这个桌面照拍得真好看',
      }),
    )
    expect(view.moderation?.action).toBe('none')
    const changes = await server.txn.ledger.list({
      workspace_id: server.bootstrap.workspace.id,
      kind: 'community_moderation',
    })
    expect(changes).toHaveLength(0)
  })
})

describe('WP73 写动作永远先出卡', () => {
  it('批一条入群申请 = 一张 community_membership 卡；申请答案原样在卡上', async () => {
    const account_id = await addAccount()
    const brand = await server.brands.forWorkspace(server.bootstrap.workspace.id)
    brand.social.saveMember({
      id: 'cm_t1',
      account_id,
      channel: 'discord',
      external_id: 'u_1001',
      handle: 'deskhero',
      status: 'pending',
      application_answers: ['在用 Nordvolt 的 65W'],
    })
    const view = await data<{ staged: boolean; change_id?: string }>(
      await post('/v1/social/members/cm_t1/approve', { decision: 'approve' }),
    )
    expect(view.staged).toBe(true)
    const changes = await server.txn.ledger.list({
      workspace_id: server.bootstrap.workspace.id,
      kind: 'community_membership',
    })
    expect(changes).toHaveLength(1)
    // 库里那条成员**还是 pending**：改状态是执行器的事
    expect(brand.social.members()[0]?.status).toBe('pending')
    const items = await server.txn.approvals.queue({
      workspace_id: server.bootstrap.workspace.id,
      person_id: server.bootstrap.person.id,
      lane: 'mine',
    })
    const card = items.find((i) => String(i.title).includes('入群'))
    expect(String(card?.summary)).toContain('在用 Nordvolt 的 65W')
  })

  it('已经批过的人再批一次回 400（不是又提一张卡）', async () => {
    const account_id = await addAccount()
    const brand = await server.brands.forWorkspace(server.bootstrap.workspace.id)
    brand.social.saveMember({
      id: 'cm_t2',
      account_id,
      channel: 'discord',
      external_id: 'u_1002',
      handle: 'linaw',
      status: 'active',
    })
    const res = await post('/v1/social/members/cm_t2/approve', { decision: 'approve' })
    expect(res.status).toBe(400)
  })

  it('手动下一个封禁动作也是一张卡（封禁那一档 guardrail 升 L1）', async () => {
    const account_id = await addAccount()
    const brand = await server.brands.forWorkspace(server.bootstrap.workspace.id)
    brand.social.saveThread({
      id: 'ct_t9',
      account_id,
      channel: 'discord',
      external_id: 'dc_9',
      surface: 'thread',
      author_external_id: 'u_9',
      author_handle: 'spammer',
      text: '广告广告',
      created_at: T0,
      status: 'open',
    })
    const view = await data<{ staged: boolean; level?: string }>(
      await post('/v1/social/threads/ct_t9/moderate', { action: 'permanent_ban', reason: '刷屏' }),
    )
    expect(view.staged).toBe(true)
    expect(view.level).toBe('L1')
  })
})

describe('WP73 成员名册那把闸（56 §4 那三处不同里最要紧的一处）', () => {
  it('社群组读得到成员名册；客服的「社群管理」读不到', async () => {
    const account_id = await addAccount()
    const brand = await server.brands.forWorkspace(server.bootstrap.workspace.id)
    brand.social.saveMember({
      id: 'cm_t3',
      account_id,
      channel: 'discord',
      external_id: 'u_2',
      handle: 'deskhero',
      status: 'pending',
    })
    const mine = await data<{ rows: unknown[] }>(await api('/v1/social/members?pending=true'))
    expect(mine.rows).toHaveLength(1)

    // 同一条路由，换成客服那条职责：403（yml 的 scopes 里没有 community_member）
    const theirs = await api('/v1/social/members?pending=true', { assignment: support.id })
    expect(theirs.status).toBe(403)

    // 但线程他读得到——转过来的客户问题他得看得见
    const threads = await api('/v1/social/threads', { assignment: support.id })
    expect(threads.status).toBe(200)
  })
})
