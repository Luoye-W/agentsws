/**
 * WP68：开发信、campaign 向导、序列跟进（端到端，起真进程打 HTTP）。
 *
 * 四件要紧的事：
 *
 * 1. **禁承诺是 block 不是转人审**：写了"我们付你"的那一封根本不进队列。
 * 2. **日配额是算出来的，不是另记的一张表**：今天发了几封只问变更账本。
 * 3. **campaign 不并集权限**（05 §4）：同一个人只勾了 YouTube，Instagram 那一组
 *    在清单上看得见、灰着、接受时也不建。
 * 4. **序列跟进是定时提，不是定时发**：到点提一张 `kol_outreach` 卡，
 *    走的是与人手点的那一封一模一样的闸；没到点、回过信、名单上的都不提。
 */
import type { Assignment } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'

const T0 = '2026-09-15T09:00:00.000Z'
const SECRETS_KEY = 'e'.repeat(64)
const DAY = 86_400_000

function makeClock(start = T0) {
  let t = Date.parse(start)
  return {
    now: () => new Date(t).toISOString(),
    advance: (ms: number) => {
      t += ms
    },
  }
}

function seeded(seed = 681): () => number {
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
let clock: ReturnType<typeof makeClock>
let youtube: Assignment

const api = async (
  path: string,
  init: RequestInit & { assignment?: string } = {},
): Promise<Response> => {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${server.bootstrap.internalToken}`)
  headers.set('X-Assignment', init.assignment ?? youtube.id)
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
  clock = makeClock()
  server = await createServer({
    quiet: true,
    clock: { now: () => clock.now() },
    random: seeded(),
    scheduleIntervalMs: 0,
    startRun: false,
    env: { AGENTSWS_OWNER_EMAIL: 'luoye@example.com', AGENTSWS_SECRETS_KEY: SECRETS_KEY },
  })
  ;({ url } = await server.listen(0))
  youtube = server.roles.assignments.create({
    person_id: server.bootstrap.person.id,
    workspace_id: server.bootstrap.workspace.id,
    role_id: 'kol.youtube',
    granted_by: server.bootstrap.person.id,
    ranges: [{ kind: 'store', id: 'store_1' }],
  })
})

afterEach(async () => {
  await server.close()
})

/** 建一个红人 + 一条邮箱，回 creator_id。 */
async function creatorWithEmail(name: string, over: Record<string, unknown> = {}): Promise<string> {
  const detail = await data<{ creator: { id: string } }>(
    await post('/v1/kol/creators', {
      display_name: name,
      channel: 'youtube',
      handle: name.toLowerCase().replace(/\s/g, ''),
      followers: 48_000,
      engagement_rate: 0.06,
      category: '数码',
      ...over,
    }),
  )
  await post(`/v1/kol/creators/${detail.creator.id}/contacts`, {
    kind: 'email',
    value: `${name.toLowerCase().replace(/\s/g, '')}@example.com`,
  })
  return detail.creator.id
}

describe('WP68 开发信', () => {
  it('模板那一封提得上去，日配额跟着变（配额只问账本）', async () => {
    const id = await creatorWithEmail('Gadget Jonas')
    const out = await data<{
      staged: boolean
      subject: string
      body: string
      quota: { cap: number; remaining: number; sent_today: number }
      approval_item_id?: string
    }>(
      await post('/v1/kol/outreach', {
        creator_id: id,
        channel: 'youtube',
        product: '65W 氮化镓充电器',
        brand_pitch: '我们做桌面周边的充电与理线。',
      }),
    )
    expect(out.staged).toBe(true)
    expect(out.subject).toContain('Gadget Jonas')
    // 职责 yml 的 `max_outreach_per_day` 默认 30
    expect(out.quota.cap).toBe(30)
    expect(out.quota.remaining).toBe(29)
    expect(out.quota.sent_today).toBe(1)
    const changes = await server.txn.ledger.list({
      workspace_id: server.bootstrap.workspace.id,
      kind: 'kol_outreach',
    })
    expect(changes).toHaveLength(1)
    // 账本里一个真地址都没有：收件人与名单放的都是加密库 key 名
    expect(JSON.stringify(changes[0]?.after)).not.toContain('@example.com')
    expect(JSON.stringify(changes[0]?.after)).toContain('kol.contact.')

    // 第二封：配额从账本重新算出来，不是另记的一张表
    // （回的是**发完这一封之后**的数，界面上那句"今天还能发 N 封"要现在就准）
    const again = await data<{ quota: { sent_today: number; remaining: number } }>(
      await post('/v1/kol/outreach', {
        creator_id: await creatorWithEmail('Desk Rosa'),
        channel: 'youtube',
        product: '65W 氮化镓充电器',
        brand_pitch: '我们做桌面周边的充电与理线。',
      }),
    )
    expect(again.quota.sent_today).toBe(2)
    expect(again.quota.remaining).toBe(28)
  })

  it('写了承诺的那一封当场 block，一条变更都不建', async () => {
    const id = await creatorWithEmail('Gadget Jonas')
    const out = await data<{ staged: boolean; forbidden_hits: string[]; message?: string }>(
      await post('/v1/kol/outreach', {
        creator_id: id,
        channel: 'youtube',
        product: '65W 氮化镓充电器',
        brand_pitch: '我们做桌面周边的充电与理线。',
        reason: '我们付你 800 美元，这一条视频就发吧。',
      }),
    )
    expect(out.staged).toBe(false)
    expect(out.forbidden_hits).toContain('我们付你')
    expect(out.message).toContain('建一条合作')
    expect(
      await server.txn.ledger.list({
        workspace_id: server.bootstrap.workspace.id,
        kind: 'kol_outreach',
      }),
    ).toHaveLength(0)
  })

  it('"我们是做什么的"没给就不起草——服务端不替用户编一句自我介绍', async () => {
    const id = await creatorWithEmail('Gadget Jonas')
    const out = await data<{ staged: boolean; missing_vars: string[]; message?: string }>(
      await post('/v1/kol/outreach', {
        creator_id: id,
        channel: 'youtube',
        product: '65W 氮化镓充电器',
      }),
    )
    expect(out.staged).toBe(false)
    expect(out.missing_vars).toEqual(['brand_pitch'])
    expect(out.message).toContain('brand_pitch')
  })

  it('打分那句"为什么找他"接进正文时不会写出「……里。，所以」这种句子', async () => {
    const id = await creatorWithEmail('Gadget Jonas')
    const out = await data<{ staged: boolean; body: string }>(
      await post('/v1/kol/outreach', {
        creator_id: id,
        channel: 'youtube',
        product: '65W 氮化镓充电器',
        brand_pitch: '我们做桌面周边的充电与理线。',
      }),
    )
    expect(out.staged).toBe(true)
    expect(out.body).not.toMatch(/[。．.][，,]/u)
  })

  it('没有联系方式就不起草，并说清楚下一步做什么', async () => {
    const detail = await data<{ creator: { id: string } }>(
      await post('/v1/kol/creators', {
        display_name: 'No Mail',
        channel: 'youtube',
        handle: 'nomail',
      }),
    )
    const out = await data<{ staged: boolean; message?: string }>(
      await post('/v1/kol/outreach', {
        creator_id: detail.creator.id,
        channel: 'youtube',
        product: '充电器',
        brand_pitch: '我们做桌面周边的充电与理线。',
      }),
    )
    expect(out.staged).toBe(false)
    expect(out.message).toContain('还没有联系方式')
  })
})

describe('WP68 campaign 向导：不并集权限（05 §4）', () => {
  it('跨两条渠道挑人，本人只有 YouTube 职责 → Instagram 那一组灰显、接受时也不建', async () => {
    await creatorWithEmail('Gadget Jonas')
    await creatorWithEmail('Desk Rosa', {
      channel: 'instagram',
      handle: 'deskrosa',
      followers: 31_000,
      engagement_rate: 0.041,
    })

    const plan = await data<{
      campaign_id: string
      ready: boolean
      approval_item_id?: string
      budget_per_creator: number
      by_channel: {
        channel: string
        allowed: boolean
        reason?: string
        picks: { creator_id: string; why: string[] }[]
      }[]
    }>(
      await post('/v1/kol/campaigns', {
        goal: '秋季桌面季',
        budget: 1000,
        channels: ['youtube', 'instagram'],
        headcount: 2,
        criteria: { category: '数码' },
      }),
    )
    expect(plan.ready).toBe(true)
    expect(plan.approval_item_id).toBeDefined()
    const yt = plan.by_channel.find((g) => g.channel === 'youtube')
    const ig = plan.by_channel.find((g) => g.channel === 'instagram')
    expect(yt?.allowed).toBe(true)
    expect(yt?.picks).toHaveLength(1)
    expect(yt?.picks[0]?.why.length).toBeGreaterThan(0)
    // 挑到了人，但本人没有这条职责 → 灰显 + 说清楚为什么
    expect(ig?.picks).toHaveLength(1)
    expect(ig?.allowed).toBe(false)
    expect(ig?.reason).toContain('kol.instagram')

    // 卡上写清楚了哪几组建不了
    const card = await server.txn.approvals.get(plan.approval_item_id as string)
    expect(card?.kind).toBe('kol_campaign')
    expect(card?.summary).toContain('instagram')

    const accepted = await data<{
      created: { channel: string }[]
      skipped: { channel: string; reason: string }[]
    }>(await post(`/v1/kol/campaigns/${plan.approval_item_id}/accept`, {}))
    expect(accepted.created.map((c) => c.channel)).toEqual(['youtube'])
    expect(accepted.skipped[0]?.channel).toBe('instagram')
    expect(accepted.skipped[0]?.reason).toContain('不并集')

    // 库里只多了 YouTube 那一条合作，阶段从"已找到"开始
    const collabs = await data<{
      rows: { channel: string; stage: string; campaign_id?: string }[]
    }>(await api('/v1/kol/collaborations'))
    expect(collabs.rows).toHaveLength(1)
    expect(collabs.rows[0]?.channel).toBe('youtube')
    expect(collabs.rows[0]?.stage).toBe('sourced')
    expect(collabs.rows[0]?.campaign_id).toBe(plan.campaign_id)
  })

  it('四格缺一格就不给清单，而是说还缺哪一格', async () => {
    const res = await post('/v1/kol/campaigns', {
      goal: '秋季桌面季',
      budget: 1000,
      channels: ['youtube'],
      headcount: 0,
    })
    // zod 先挡下来（人数必须是正整数）——错在前面说比在清单里说清楚
    expect(res.status).toBe(400)
  })

  it('接受时重新查一次职责，不信卡上那一格（卡可能是昨天出的）', async () => {
    await creatorWithEmail('Gadget Jonas')
    const plan = await data<{ approval_item_id?: string }>(
      await post('/v1/kol/campaigns', {
        goal: '秋季桌面季',
        budget: 500,
        channels: ['youtube'],
        headcount: 1,
      }),
    )
    // 卡出完之后把这条职责收回来
    server.roles.assignments.revoke(youtube.id, server.bootstrap.person.id)
    const other = server.roles.assignments.create({
      person_id: server.bootstrap.person.id,
      workspace_id: server.bootstrap.workspace.id,
      role_id: 'kol.youtube',
      granted_by: server.bootstrap.person.id,
      ranges: [{ kind: 'store', id: 'store_1' }],
    })
    // 用新那条分配去接受：旧那条已经撤了，服务端按**现在**的持有情况判
    const accepted = await data<{ created: unknown[]; skipped: { reason: string }[] }>(
      await post(`/v1/kol/campaigns/${plan.approval_item_id}/accept`, {}, other.id),
    )
    expect(accepted.created).toHaveLength(1)
  })
})

describe('WP68 序列跟进：定时提，不是定时发', () => {
  it('首封之后第 3 天提跟进那一封；没到时候不提；每一封仍走 guardrail', async () => {
    const id = await creatorWithEmail('Gadget Jonas')
    // 先建一条合作（阶段 sourced），首封提上去之后它变成"已建联"
    await post('/v1/kol/collaborations', { creator_id: id, channel: 'youtube' })
    const first = await data<{ staged: boolean }>(
      await post('/v1/kol/outreach', {
        creator_id: id,
        channel: 'youtube',
        product: '65W 氮化镓充电器',
        brand_pitch: '我们做桌面周边的充电与理线。',
      }),
    )
    expect(first.staged).toBe(true)

    const brand = await server.brands.forWorkspace(server.bootstrap.workspace.id)
    // 当天：还没到时候
    const early = await brand.kolService.sweepSequences()
    expect(early.scanned).toBe(1)
    expect(early.staged).toBe(0)
    expect(early.skipped[0]?.reason).toContain('还没到时候')

    // 第 3 天：该跟进了
    clock.advance(3 * DAY)
    const due = await brand.kolService.sweepSequences()
    expect(due.staged).toBe(1)
    const changes = await server.txn.ledger.list({
      workspace_id: server.bootstrap.workspace.id,
      kind: 'kol_outreach',
    })
    expect(changes).toHaveLength(2)
    const followUp = changes.find((c) => (c.after as { step?: string }).step === 'follow_up')
    expect(followUp).toBeDefined()
    // 跟进那一封用的是首封同一组变量——提到的产品必须和首封是同一个
    expect(String((followUp?.after as { body?: string } | undefined)?.body)).toContain(
      '65W 氮化镓充电器',
    )

    // 同一天再跑一轮不会重复提（序列按已发的那几封算）
    const again = await brand.kolService.sweepSequences()
    expect(again.staged).toBe(0)
  })

  it('对方回过信（阶段推进过）就不再跟——接下来是人在谈', async () => {
    const id = await creatorWithEmail('Gadget Jonas')
    const staged = await data<{ collaboration?: { id: string } }>(
      await post('/v1/kol/collaborations', { creator_id: id, channel: 'youtube' }),
    )
    await post('/v1/kol/outreach', {
      creator_id: id,
      channel: 'youtube',
      product: '65W 氮化镓充电器',
      brand_pitch: '我们做桌面周边的充电与理线。',
    })
    await api(`/v1/kol/collaborations/${staged.collaboration?.id}/stage`, {
      method: 'PATCH',
      body: JSON.stringify({ stage: 'replied' }),
    })
    clock.advance(10 * DAY)
    const brand = await server.brands.forWorkspace(server.bootstrap.workspace.id)
    const out = await brand.kolService.sweepSequences()
    // 已经不在"已建联"这一格里了，扫都不扫它
    expect(out.scanned).toBe(0)
    expect(out.staged).toBe(0)
  })
})
