/**
 * WP506（决策 1789 B）：知识条目就地**停用 / 启用**（单条 + 批量）——停用不删、不动状态，
 * 检索层直接排除（回复 / 起草取不到）；列表照样看得见（面板「已停用」筛选靠它）；
 * 只给人点：AI 运行的令牌一律 403。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'

const T0 = '2026-09-15T09:00:00.000Z'

let server: Server
let url: string

const api = async (path: string, init: RequestInit = {}, token?: string): Promise<Response> => {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token ?? server.bootstrap.internalToken}`)
  headers.set('X-Assignment', server.bootstrap.ownerAssignment.id)
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  return fetch(`${url}${path}`, { ...init, headers })
}
const post = (path: string, body: unknown = {}, token?: string): Promise<Response> =>
  api(path, { method: 'POST', body: JSON.stringify(body) }, token)
const data = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data

beforeEach(async () => {
  server = await createServer({
    quiet: true,
    clock: { now: () => T0 },
    scheduleIntervalMs: 0,
    startRun: false,
    env: { AGENTSWS_OWNER_EMAIL: 'luoye@example.com' },
  })
  ;({ url } = await server.listen(0))
})

afterEach(async () => {
  await server.close()
})

async function card(key: string, statement: string): Promise<string> {
  const c = await server.knowledge.store.propose({
    schema_version: 1,
    workspace_id: server.bootstrap.workspace.id,
    layer: 'fact',
    domain: 'knowledge',
    scope: [],
    sensitivity: 'internal',
    subject: { type: 'faq', key },
    statement,
    provenance: [{ source: 'document', ref: 'faq.md', locator: key, at: T0 }],
    confidence: { value: 0.9, state: 'probable' },
    valid: {},
    owner: server.bootstrap.person.id,
    created_by: { kind: 'person', id: server.bootstrap.person.id },
  })
  await server.knowledge.store.activate(c.id, server.bootstrap.person.id)
  return c.id
}

const found = async (text: string): Promise<string[]> =>
  (
    await data<{ hits: { fact_card_id: string }[] }>(
      await post('/v1/knowledge/search', { text, mode: 'lexical' }),
    )
  ).hits.map((h) => h.fact_card_id)

describe('WP506 知识条目停用 / 启用', () => {
  it('停用一条：检索取不到、列表照样看得见（带停用时间）；启用回来原样', async () => {
    const warranty = await card('faq.warranty', '保修期 12 个月，人为损坏不保。')
    const returns = await card('faq.returns', '收到货 30 天内可以退货，保修卡要一起寄回。')
    expect(new Set(await found('保修'))).toEqual(new Set([warranty, returns]))

    const res = await post(`/v1/knowledge/cards/${warranty}/disable`)
    expect(res.status).toBe(200)
    const off = await data<{ id: string; status: string; disabled_at?: string }>(res)
    expect(off).toMatchObject({ id: warranty, status: 'active', disabled_at: T0 })
    expect(await found('保修')).toEqual([returns])

    const list = await data<{ id: string; disabled_at?: string }[]>(
      await api('/v1/knowledge/cards'),
    )
    expect(list.find((c) => c.id === warranty)?.disabled_at).toBe(T0)

    const on = await data<{ disabled_at?: string; status: string }>(
      await post(`/v1/knowledge/cards/${warranty}/enable`),
    )
    expect(on.disabled_at).toBeUndefined()
    expect(on.status).toBe('active')
    expect(new Set(await found('保修'))).toEqual(new Set([warranty, returns]))
  })

  it('批量：一次停用几条；看不见的 / 不存在的进 missing；撤销 = 批量启用', async () => {
    const a = await card('faq.shipping', '下单后 48 小时内发货。')
    const b = await card('faq.shipping_fee', '满 50 美元包邮，发货走 DHL。')
    const out = await data<{ updated: { id: string }[]; missing: string[] }>(
      await post('/v1/knowledge/cards/disable', { ids: [a, b, 'fact_nope'] }),
    )
    expect(out.updated.map((c) => c.id).sort()).toEqual([a, b].sort())
    expect(out.missing).toEqual(['fact_nope'])
    expect(await found('发货')).toEqual([])
    const back = await data<{ updated: { id: string }[] }>(
      await post('/v1/knowledge/cards/enable', { ids: [a, b] }),
    )
    expect(back.updated).toHaveLength(2)
    expect(new Set(await found('发货'))).toEqual(new Set([a, b]))
  })

  it('只给人点：AI 运行的令牌停用 / 启用一律 403，那一条不动', async () => {
    const a = await card('faq.size', '尺码偏小，建议拍大一码。')
    const runtime = server.identity.issue(
      'runtime',
      server.bootstrap.person.id,
      server.bootstrap.workspace.id,
    ).token
    expect((await post(`/v1/knowledge/cards/${a}/disable`, {}, runtime)).status).toBe(403)
    expect((await post('/v1/knowledge/cards/disable', { ids: [a] }, runtime)).status).toBe(403)
    expect(await found('尺码')).toEqual([a])
  })
})
