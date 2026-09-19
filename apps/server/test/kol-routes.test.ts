/**
 * WP68（48 §5.4）红人库的 `/v1` 面，端到端（起真进程 → 打 HTTP）。
 *
 * 钉四件事，每一件都是 WP67 交付报告里那份"未完成"清单上的一条：
 *
 * 1. **联系方式真进加密库**：`value_ref` 指向的那条记录在秘密库里真的存在，
 *    库里那张表一个字节明文都没有，读回来的只有 `a***@x.com`。
 * 2. **合并建议有调用方**：`suggestMerges` 出的建议进了一张真的审批卡，
 *    点"合"之后账号与联系方式跟着走、`merged_from` 留着被合掉那条的 id。
 * 3. **阶段机是唯一那一份**：非法跳转回 400 + 一句人话，不是 `invalid transition`。
 * 4. **审核结论走变更账本**：`kol_deliverable_review` 真的在账本上留了一条。
 */
import type { Assignment } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'

const T0 = '2026-09-15T09:00:00.000Z'
const SECRETS_KEY = 'c'.repeat(64)

function makeClock(start = T0) {
  let t = Date.parse(start)
  return {
    now: () => new Date(t).toISOString(),
    advance: (ms: number) => {
      t += ms
    },
  }
}

function seeded(seed = 68): () => number {
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
const err = async (res: Response): Promise<{ code: string; message: string }> =>
  (await res.json()) as { code: string; message: string }

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

/** 建一个红人，回它的 creator_id。 */
async function addCreator(
  display_name: string,
  over: Record<string, unknown> = {},
): Promise<string> {
  const res = await post('/v1/kol/creators', {
    display_name,
    channel: 'youtube',
    handle: display_name.toLowerCase().replace(/\s/g, ''),
    followers: 48_000,
    engagement_rate: 0.06,
    category: '数码',
    ...over,
  })
  expect(res.status).toBe(201)
  const detail = await data<{ creator: { id: string } }>(res)
  return detail.creator.id
}

describe('WP68 红人库路由：找人与资料', () => {
  it('建一个红人 → 清单上有他，分是 kol-core 算的，"有没有联系方式"只说有没有', async () => {
    const id = await addCreator('Gadget Jonas')
    const list = await data<{
      rows: { creator_id: string; score: number; has_contact: boolean; handle: string }[]
    }>(await api('/v1/kol/creators'))
    expect(list.rows).toHaveLength(1)
    const row = list.rows[0] as (typeof list.rows)[number]
    expect(row.creator_id).toBe(id)
    expect(row.handle).toBe('gadgetjonas')
    expect(row.score).toBeGreaterThan(0)
    expect(row.has_contact).toBe(false)
  })

  it('同一渠道同一 handle 建两次 = 同一条账号，不建第二条', async () => {
    const first = await addCreator('Gadget Jonas')
    const again = await addCreator('Gadget Jonas')
    expect(again).toBe(first)
    const list = await data<{ rows: unknown[] }>(await api('/v1/kol/creators'))
    expect(list.rows).toHaveLength(1)
  })

  it('改资料时 observed_at 跟着走——半年前的粉丝数不该顶着今天的时间戳', async () => {
    const id = await addCreator('Desk Rosa')
    const before = await data<{ accounts: { id: string; observed_at: string }[] }>(
      await api(`/v1/kol/creators/${id}`),
    )
    const account = before.accounts[0] as { id: string; observed_at: string }
    const after = await data<{ accounts: { followers?: number; observed_at: string }[] }>(
      await api(`/v1/kol/creators/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ account: { id: account.id, followers: 99_000 } }),
      }),
    )
    expect(after.accounts[0]?.followers).toBe(99_000)
    expect(after.accounts[0]?.observed_at).toBe(T0)
  })
})

describe('WP68 联系方式：明文只在加密库里', () => {
  it('POST 一条邮箱 → 回来的只有脱敏形态，库里存的是 key 名，明文在秘密库里', async () => {
    const id = await addCreator('Gadget Jonas')
    const res = await post(`/v1/kol/creators/${id}/contacts`, {
      kind: 'email',
      value: 'jonas@example.com',
      source: 'channel_about',
    })
    expect(res.status).toBe(201)
    const view = await data<{ id: string; masked: string }>(res)
    // 够人认出是哪个邮箱，不足以拿去发信
    expect(view.masked).toBe('j***@example.com')
    expect(JSON.stringify(view)).not.toContain('jonas@example.com')

    // 库里那一行只有 key 名
    const brand = await server.brands.forWorkspace(server.bootstrap.workspace.id)
    const row = brand.kol.contacts(id)[0]
    expect(row?.value_ref).toBe(`kol.contact.${view.id}`)
    expect(JSON.stringify(row)).not.toContain('jonas@example.com')

    // 明文真的在加密库里——起草开发信那一跳靠这个口子取
    expect(brand.kolService.revealContact(view.id)).toBe('jonas@example.com')

    // 详情页读回来的也只有脱敏形态
    const detail = await data<{ contacts: { masked: string }[] }>(
      await api(`/v1/kol/creators/${id}`),
    )
    expect(detail.contacts[0]?.masked).toBe('j***@example.com')
    // 清单上"有没有联系方式"这一格跟着变了
    const list = await data<{ rows: { has_contact: boolean }[] }>(await api('/v1/kol/creators'))
    expect(list.rows[0]?.has_contact).toBe(true)
  })
})

describe('WP68 合作与交付物', () => {
  it('建合作走变更账本，永远 L1（HARD_L1）；阶段非法跳转回一句人话', async () => {
    const id = await addCreator('Gadget Jonas')
    const staged = await data<{
      staged: boolean
      approval_item_id?: string
      auto_approved?: boolean
      collaboration?: { id: string; stage: string }
    }>(await post('/v1/kol/collaborations', { creator_id: id, channel: 'youtube', budget: 400 }))
    expect(staged.staged).toBe(true)
    expect(staged.auto_approved).toBe(false)
    expect(staged.collaboration?.stage).toBe('sourced')
    const changes = await server.txn.ledger.list({
      workspace_id: server.bootstrap.workspace.id,
      kind: 'kol_collaboration',
    })
    expect(changes).toHaveLength(1)

    const col = staged.collaboration?.id as string
    // 合法的一跳
    const ok = await api(`/v1/kol/collaborations/${col}/stage`, {
      method: 'PATCH',
      body: JSON.stringify({ stage: 'contacted' }),
    })
    expect(ok.status).toBe(200)
    // 非法的一跳：回人话，不是 `invalid transition`
    const bad = await api(`/v1/kol/collaborations/${col}/stage`, {
      method: 'PATCH',
      body: JSON.stringify({ stage: 'delivered' }),
    })
    expect(bad.status).toBe(400)
    expect((await err(bad)).message).toContain('已建联')
  })

  it('审核结论提一条 kol_deliverable_review 变更', async () => {
    const id = await addCreator('Gadget Jonas')
    const staged = await data<{ collaboration?: { id: string } }>(
      await post('/v1/kol/collaborations', { creator_id: id, channel: 'youtube' }),
    )
    const col = staged.collaboration?.id as string
    const deliverable = await data<{ id: string; review: string }>(
      await post('/v1/kol/deliverables', {
        collaboration_id: col,
        kind: 'video',
        due_at: '2026-09-20T09:00:00.000Z',
      }),
    )
    expect(deliverable.review).toBe('pending')
    const out = await data<{ staged: boolean; change_id?: string }>(
      await post(`/v1/kol/deliverables/${deliverable.id}/review`, {
        review: 'changes_requested',
        notes: '描述区的追踪链接还没加。',
      }),
    )
    expect(out.staged).toBe(true)
    const changes = await server.txn.ledger.list({
      workspace_id: server.bootstrap.workspace.id,
      kind: 'kol_deliverable_review',
    })
    expect(changes).toHaveLength(1)
    expect(changes[0]?.after).toMatchObject({ review: 'changes_requested' })
  })

  it('追踪链接：UTM 三参数由服务端定，联盟码按 handle 生成', async () => {
    const id = await addCreator('Gadget Jonas')
    const staged = await data<{ collaboration?: { id: string } }>(
      await post('/v1/kol/collaborations', { creator_id: id, channel: 'youtube' }),
    )
    const col = staged.collaboration?.id as string
    const link = await data<{
      url: string
      utm: { source: string; medium: string; campaign: string; content?: string }
      affiliate_code?: string
    }>(
      await post('/v1/kol/tracked-links', {
        collaboration_id: col,
        url: 'https://nordvolt.example/p/charger-65w',
        campaign: '秋季桌面',
      }),
    )
    expect(link.utm.source).toBe('youtube')
    expect(link.utm.medium).toBe('kol')
    // `content` 放的是合作 id 而不是红人的名字——UTM 会出现在公开链接上
    expect(link.utm.content).toBe(col.toLowerCase())
    expect(link.url).toContain('utm_medium=kol')
    expect(link.affiliate_code).toMatch(/^GADGETJO\d\d$/)
  })

  it('追踪链接：活动名不给了就默认用这条合作的活动 id（WP117b，合作线程上顺手建一条不该被活动名挡住）', async () => {
    const id = await addCreator('Gadget Jonas')
    const staged = await data<{ collaboration?: { id: string } }>(
      await post('/v1/kol/collaborations', { creator_id: id, channel: 'youtube' }),
    )
    const col = staged.collaboration?.id as string
    const link = await data<{ utm: { campaign: string } }>(
      await post('/v1/kol/tracked-links', {
        collaboration_id: col,
        url: 'https://nordvolt.example/p/charger-65w',
      }),
    )
    // 没有活动就落在合作 id 上：稳定、不重复、不透懒（UTM 会出现在公开链接上）
    expect(link.utm.campaign).toBe(col.toLowerCase())
  })
})

describe('WP68 导入与合并建议', () => {
  it('导一张 CSV：认出账号、合并重复行、认不出来的照实说，邮箱进加密库', async () => {
    const csv = [
      '红人,链接,粉丝,互动率,类目,邮箱',
      'Gadget Jonas,https://www.youtube.com/@gadgetjonas,48K,6.2%,数码,jonas@example.com',
      'Desk Rosa,https://www.instagram.com/deskrosa,31000,4.1%,家居,',
      'Jonas again,https://www.youtube.com/@gadgetjonas,50K,,数码,',
      '谁也不知道,,,,,',
    ].join('\n')
    const out = await data<{
      summary: string
      created_creators: number
      created_contacts: number
      duplicates: { source_row: number; same_as_row: number }[]
      rejected: { source_row: number; reason: string }[]
    }>(await post('/v1/kol/import', { filename: '红人.csv', content: csv }))
    expect(out.created_creators).toBe(2)
    expect(out.created_contacts).toBe(1)
    expect(out.duplicates).toHaveLength(1)
    expect(out.duplicates[0]?.same_as_row).toBe(2)
    expect(out.rejected).toHaveLength(1)
    expect(out.rejected[0]?.reason).toContain('认不出')
    expect(out.summary).toContain('认出 2 个账号')

    const list = await data<{ rows: { channel: string; has_contact: boolean }[] }>(
      await api('/v1/kol/creators'),
    )
    expect(list.rows.map((r) => r.channel).sort()).toEqual(['instagram', 'youtube'])
  })

  it('收到 xlsx 时照实说只认 CSV，不做半个解析', async () => {
    const out = await data<{ note?: string }>(
      await post('/v1/kol/import', { filename: '红人.xlsx', content: '红人,链接\n' }),
    )
    expect(out.note).toContain('只认 CSV')
  })

  it('同一条联系方式的两个人 → 出一条建议卡 → 点合，账号与联系方式跟着走', async () => {
    const a = await addCreator('Gadget Jonas', { handle: 'gadgetjonas', channel: 'youtube' })
    const b = await addCreator('Gadget Jonas', { handle: 'gadgetjonas', channel: 'instagram' })
    expect(b).not.toBe(a)
    await post(`/v1/kol/creators/${a}/contacts`, { kind: 'email', value: 'jonas@example.com' })
    await post(`/v1/kol/creators/${b}/contacts`, { kind: 'email', value: 'Jonas@Example.com ' })

    const suggestions = await data<{
      rows: {
        id: string
        keep: { creator_id: string }
        merge: { creator_id: string }
        reasons: { id: string }[]
        approval_item_id?: string
      }[]
    }>(await api('/v1/kol/merge-suggestions'))
    expect(suggestions.rows).toHaveLength(1)
    const s = suggestions.rows[0] as (typeof suggestions.rows)[number]
    expect(s.reasons.map((r) => r.id)).toContain('same_contact')
    // 建议真的摆到人面前了：一张 14 四段式卡，带选择题
    expect(s.approval_item_id).toBeDefined()
    const card = await server.txn.approvals.get(s.approval_item_id as string)
    expect(card?.options?.map((o) => o.id)).toEqual(['merge', 'keep_apart'])
    expect(card?.title).toContain('是同一个人吗')

    const merged = await data<{ creator: { id: string; merged_from: string[] } }>(
      await post(`/v1/kol/merge-suggestions/${s.id}/accept`, {}),
    )
    expect(merged.creator.merged_from).toContain(s.merge.creator_id)
    const detail = await data<{ accounts: unknown[]; contacts: unknown[] }>(
      await api(`/v1/kol/creators/${s.keep.creator_id}`),
    )
    expect(detail.accounts).toHaveLength(2)
    expect(detail.contacts).toHaveLength(2)
    // 被合掉那条不在库里了（不留孤儿）
    expect((await api(`/v1/kol/creators/${s.merge.creator_id}`)).status).toBe(404)
  })

  it('点"不是同一个人"之后这一对不再建议', async () => {
    const a = await addCreator('Gadget Jonas', { handle: 'gadgetjonas', channel: 'youtube' })
    const b = await addCreator('Gadget Jonas', { handle: 'gadgetjonas', channel: 'instagram' })
    expect(b).not.toBe(a)
    const first = await data<{ rows: { id: string }[] }>(await api('/v1/kol/merge-suggestions'))
    expect(first.rows).toHaveLength(1)
    await post(`/v1/kol/merge-suggestions/${first.rows[0]?.id}/reject`, {})
    const again = await data<{ rows: unknown[] }>(await api('/v1/kol/merge-suggestions'))
    expect(again.rows).toHaveLength(0)
  })
})

describe('WP68 授权：一个对象域一把闸', () => {
  it('没有红人那几条 scope 的岗位读不到红人库（403）', async () => {
    const support = server.roles.assignments.create({
      person_id: server.bootstrap.person.id,
      workspace_id: server.bootstrap.workspace.id,
      role_id: 'dtc.support',
      granted_by: server.bootstrap.person.id,
      ranges: [{ kind: 'store', id: 'store_1' }],
    })
    const res = await api('/v1/kol/creators', { assignment: support.id })
    expect(res.status).toBe(403)
  })
})
