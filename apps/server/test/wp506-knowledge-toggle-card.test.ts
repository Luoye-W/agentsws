/**
 * WP506（决策 1796 C）：AI 用 `propose_knowledge_toggle` **提议**停用 / 启用知识——只出一张确认卡（中栏「要你处理」）；
 * 人批了才真停用（检索就取不到了），不批什么都不变；批了之后还能撤销（人点、走只给人点的那个接口）。
 * 真停用 / 启用的接口照旧挡 AI 运行的令牌。
 */
import type { Assignment, KnowledgeTogglePayload } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import { createKnowledgeLearnToolExecutor } from '../src/knowledge-learn-tools.js'
import { createKnowledgeToggle } from '../src/knowledge-toggle.js'

const T0 = '2026-09-15T09:00:00.000Z'

let server: Server
let url: string
let support: Assignment

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
  support = server.roles.assignments.create({
    person_id: server.bootstrap.person.id,
    workspace_id: server.bootstrap.workspace.id,
    role_id: 'dtc.support',
    granted_by: server.bootstrap.person.id,
    ranges: [{ kind: 'store', id: 'store_1' }],
  })
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

/** 运行时那一条：客服职责的 AI 调工具（执行器同服务端装配的那一个，提议走同一个 knowledge-toggle）。 */
function tool() {
  const toggle = createKnowledgeToggle({
    knowledge: server.knowledge,
    approvals: server.txn.approvals,
    grantsOf: (id) => {
      const config = server.roles.effectiveConfig(id)
      return { scopes: config.scopes, ranges: config.ranges }
    },
    random: Math.random,
  })
  const exec = createKnowledgeLearnToolExecutor({
    learner: () => undefined,
    mailConnected: async () => false,
    proposeToggle: (actor, input) => toggle.propose(actor, input),
  })
  return (input: Record<string, unknown>, role_id = 'dtc.support') =>
    exec({
      name: 'propose_knowledge_toggle',
      input,
      request: {
        id: 'run_1',
        workspace_id: server.bootstrap.workspace.id,
        actor: {
          person_id: server.bootstrap.person.id,
          assignment_id: support.id,
          role_id,
        },
      },
    } as never)
}

async function decide(id: string, action: 'approve' | 'reject'): Promise<void> {
  const res = await post(`/v1/approvals/${id}/decide`, {
    action,
    ...(action === 'reject' ? { reason: '不用' } : {}),
  })
  expect(res.status).toBe(200)
}

describe('WP506 AI 提议停用 / 启用知识', () => {
  it('工具 → 一张确认卡（哪几条、AI 的理由），不改任何东西；批了才停用，检索取不到；撤销 = 人点启用回来', async () => {
    const seeded = (await server.knowledge.store.exportMarkdown(server.bootstrap.workspace.id))
      .length
    const oldFee = await card('faq.shipping_fee_old', '运费统一 9.9 美元（旧口径）')
    const oldCarrier = await card('faq.carrier_old', '旧口径：发货走 4PX，运费另算')
    const keep = await card('faq.returns', '收到货 30 天内可以退货。')
    const out = (await tool()({
      action: 'disable',
      query: '旧口径',
      reason: '运费政策 10 月改了，这两条还是老说法',
    })) as { status: string; data: { ok: boolean; approval_item_id: string; count: number } }
    expect(out.status).toBe('ok')
    expect(out.data).toMatchObject({ ok: true, count: 2 })

    const item = await server.txn.approvals.get(out.data.approval_item_id)
    expect(item?.kind).toBe('knowledge_update')
    expect(item?.state).toBe('pending')
    expect(item?.title).toBe('停用 2 条知识？')
    const payload = item?.payload as KnowledgeTogglePayload
    expect(payload.form).toBe('knowledge_toggle')
    expect(payload.reason).toContain('10 月改了')
    expect(payload.items.map((i) => i.id).sort()).toEqual([oldFee, oldCarrier].sort())
    // 出卡不改任何东西
    expect(await found('运费')).toEqual(expect.arrayContaining([oldFee, oldCarrier]))

    await decide(out.data.approval_item_id, 'approve')
    const after = await found('运费')
    expect(after).not.toContain(oldFee)
    expect(after).not.toContain(oldCarrier)
    expect(await found('退货')).toContain(keep)
    const disabled = server.knowledge.store.getUnchecked(oldFee)
    expect(disabled?.disabled_by).toBe(server.bootstrap.person.id)
    // 没有再写一条新知识进去（这张卡不走「采纳 knowledge_update」那条路）
    expect(
      await server.knowledge.store.list({ workspace_id: server.bootstrap.workspace.id }, {
        person_id: server.bootstrap.person.id,
        workspace_id: server.bootstrap.workspace.id,
        assignment_id: support.id,
        role_id: 'dtc.support',
        grants: server.roles.effectiveConfig(support.id).scopes,
        ranges: server.roles.effectiveConfig(support.id).ranges,
      } as never),
    ).toHaveLength(3 + seeded)

    // 撤销：人点（卡身里那个按钮走的就是这个接口）
    await post('/v1/knowledge/cards/enable', { ids: [oldFee, oldCarrier] })
    expect(await found('运费')).toEqual(expect.arrayContaining([oldFee, oldCarrier]))
  })

  it('不批：什么都不变', async () => {
    const a = await card('faq.size_old', '旧尺码表：S 码胸围 88')
    const out = (await tool()({ action: 'disable', ids: [a], reason: '尺码表换了' })) as {
      data: { approval_item_id: string }
    }
    await decide(out.data.approval_item_id, 'reject')
    expect(await found('尺码')).toEqual([a])
    expect(server.knowledge.store.getUnchecked(a)?.disabled_at).toBeUndefined()
  })

  it('启用回来也是一张卡；找不到 / 都已经是那个状态 / 没写理由：不出卡；不是客服职责：拦下', async () => {
    const a = await card('faq.warranty', '保修 12 个月')
    await post(`/v1/knowledge/cards/${a}/disable`)
    const none = (await tool()({ action: 'disable', ids: [a], reason: '过时' })) as {
      data: { ok: boolean; message: string }
    }
    expect(none.data.ok).toBe(false)
    expect(none.data.message).toContain('已经是停用的')
    const miss = (await tool()({ action: 'enable', query: '不存在的词', reason: 'x' })) as {
      data: { ok: boolean; message: string }
    }
    expect(miss.data.message).toContain('没找到')
    expect(((await tool()({ action: 'enable', ids: [a] })) as { status: string }).status).toBe(
      'error',
    )
    expect(
      ((await tool()({ action: 'enable', ids: [a], reason: 'x' }, 'dtc.seo')) as { status: string })
        .status,
    ).toBe('blocked')

    const back = (await tool()({ action: 'enable', ids: [a], reason: '保修政策又恢复了' })) as {
      data: { ok: boolean; approval_item_id: string }
    }
    expect(back.data.ok).toBe(true)
    expect(await found('保修')).toEqual([])
    await decide(back.data.approval_item_id, 'approve')
    expect(await found('保修')).toEqual([a])
  })
})
