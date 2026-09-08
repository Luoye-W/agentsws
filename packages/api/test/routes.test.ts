/** 各域路由的投影正确性 + OpenAPI + decision_token 抹除。 */
import { describe, expect, it } from 'vitest'
import { toOpenApiPath } from '../src/index.js'
import { harness } from './helpers.js'

const data = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data

describe('审批（14 §10）', () => {
  it('队列只回本人是收件人的项，且抹掉别人的 decision_token', async () => {
    const h = await harness()
    const items = await data<
      { id: string; deliveries: { to: string; decision_token: string }[] }[]
    >(await h.get('/v1/approvals?lane=mine'))
    expect(items).toHaveLength(1)
    const mine = items[0]?.deliveries.find((d) => d.to === h.person_id)
    const other = items[0]?.deliveries.find((d) => d.to === h.other_id)
    expect(mine?.decision_token).toBe('tok_me')
    expect(other?.decision_token).toBe('[redacted]')
  })

  it('lane 非法 → 400', async () => {
    const h = await harness()
    const res = await h.get('/v1/approvals?lane=everything')
    expect(res.status).toBe(400)
  })

  it('详情 / 历史 / 认领 / 释放 / 撤回', async () => {
    const h = await harness()
    expect((await h.get(`/v1/approvals/${h.item.id}`)).status).toBe(200)
    const history = await data<{ revisions: unknown[]; events: string[] }>(
      await h.get(`/v1/approvals/${h.item.id}/history`),
    )
    expect(history.events).toEqual(['evt_000001'])
    expect((await h.post(`/v1/approvals/${h.item.id}/claim`)).status).toBe(200)
    expect((await h.post(`/v1/approvals/${h.item.id}/release`)).status).toBe(200)
    expect((await h.post(`/v1/approvals/${h.item.id}/withdraw`)).status).toBe(200)
  })

  it('不存在 / 跨工作区的审批项一律 404（不泄漏存在性）', async () => {
    const h = await harness()
    expect((await h.get('/v1/approvals/ap_nope')).status).toBe(404)
    h.approvals.seed({ ...h.item, id: 'ap_foreign', workspace_id: 'ws_elsewhere' })
    expect((await h.get('/v1/approvals/ap_foreign')).status).toBe(404)
  })

  it('decide 不带 decision_token 时用本人那张投递 token', async () => {
    const h = await harness()
    const res = await h.post(`/v1/approvals/${h.item.id}/decide`, { action: 'approve' })
    expect(res.status).toBe(200)
    expect(h.approvals.log).toEqual([`decide:${h.item.id}:${h.person_id}`])
  })

  it('decide 带了别人的 token → 下游拒（forbidden）', async () => {
    const h = await harness()
    const res = await h.post(`/v1/approvals/${h.item.id}/decide`, {
      action: 'approve',
      decision_token: 'tok_of_nobody',
    })
    expect(res.status).toBe(403)
  })

  it('batch decide：一条成功一条失败，互不影响', async () => {
    const h = await harness()
    h.approvals.seed({
      ...h.item,
      id: 'ap_2',
      deliveries: [{ ...(h.item.deliveries[0] as never), decision_token: 'tok_2' }],
    })
    const res = await h.post('/v1/approvals/batch/decide', {
      entries: [{ id: h.item.id }, { id: 'ap_2', decision_token: 'wrong' }],
      action: 'approve',
    })
    expect(res.status).toBe(200)
    const { results } = await data<{
      results: { id: string; item?: unknown; error?: { code: string } }[]
    }>(res)
    const body = results
    expect(body[0]?.item).toBeDefined()
    expect(body[1]?.error?.code).toBe('forbidden')
  })

  it('batch decide 的 entries 为空 → 400', async () => {
    const h = await harness()
    const res = await h.post('/v1/approvals/batch/decide', { entries: [], action: 'approve' })
    expect(res.status).toBe(400)
  })
})

describe('变更与 guardrail（15 §7）', () => {
  it('列表 / 详情 / withdraw / reverse', async () => {
    const h = await harness()
    expect(await data<unknown[]>(await h.get('/v1/changes'))).toHaveLength(1)
    expect((await h.get('/v1/changes/chg_1')).status).toBe(200)
    expect((await h.get('/v1/changes/chg_nope')).status).toBe(404)
    const withdrawn = await data<{ status: string }>(await h.post('/v1/changes/chg_1/withdraw'))
    expect(withdrawn.status).toBe('withdrawn')
    const reversed = await h.post('/v1/changes/chg_1/reverse')
    expect(reversed.status).toBe(201)
  })

  it('target_type 与 target_id 必须成对', async () => {
    const h = await harness()
    expect((await h.get('/v1/changes?target_type=order')).status).toBe(400)
    expect((await h.get('/v1/changes?target_type=order&target_id=ord_1')).status).toBe(200)
  })

  it('guardrails/evaluate 只评估不 stage', async () => {
    const h = await harness()
    const res = await h.post('/v1/guardrails/evaluate', {
      kind: 'refund',
      target: { type: 'order', id: 'ord_1' },
      before: { total: 89 },
      after: { refund_amount: 89 },
      amount_base: 89,
    })
    expect(res.status).toBe(200)
    const result = await data<{ verdict: string; hits: unknown[] }>(res)
    expect(result.verdict).toBe('require_review')
    expect(result.hits).toHaveLength(1)
  })

  it('evaluate 缺 kind → 400，details 指出字段', async () => {
    const h = await harness()
    const res = await h.post('/v1/guardrails/evaluate', { target: { type: 'order', id: 'o' } })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { details: { path: string }[] }
    expect(body.details.map((d) => d.path)).toContain('kind')
  })
})

describe('知识（19 §6）与技能（24 §5）', () => {
  it('search / cards / card / health', async () => {
    const h = await harness()
    const search = await data<{ hits: unknown[]; relevant: boolean }>(
      await h.post('/v1/knowledge/search', { text: '退货窗口' }),
    )
    expect(search.hits).toHaveLength(1)
    expect(await data<unknown[]>(await h.get('/v1/knowledge/cards?layer=fact'))).toHaveLength(1)
    expect((await h.get('/v1/knowledge/cards/fc_1')).status).toBe(200)
    expect((await h.get('/v1/knowledge/cards/fc_nope')).status).toBe(404)
    expect(await data<{ total: number }>(await h.get('/v1/knowledge/health'))).toMatchObject({
      total: 1,
    })
  })

  it('非法 layer / status → 400', async () => {
    const h = await harness()
    expect((await h.get('/v1/knowledge/cards?layer=nope')).status).toBe(400)
    expect((await h.get('/v1/lessons?status=nope')).status).toBe(400)
  })

  it('resolved / overlay / lessons；overlay 只能写个人层', async () => {
    const h = await harness()
    const resolved = await data<{ name: string }>(
      await h.get('/v1/skills/aftersales-reply/resolved'),
    )
    expect(resolved.name).toBe('aftersales-reply')
    expect((await h.get('/v1/skills/nope/resolved')).status).toBe(404)

    const put = await h.gateway.fetch(
      new Request('http://127.0.0.1/v1/skills/aftersales-reply/overlay', {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${h.token}`,
          'X-Assignment': h.assignment.id,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ops: [{ op: 'replace', section_id: 'sec_1', body: '新正文' }],
          base_version: '1.0.0',
          version: 2,
        }),
      }),
    )
    expect(put.status).toBe(200)
    expect(await data<{ skill: string; version: number }>(put)).toEqual({
      skill: 'aftersales-reply',
      version: 2,
    })

    expect(await data<unknown[]>(await h.get('/v1/lessons'))).toHaveLength(1)
    expect(await data<unknown[]>(await h.get('/v1/lessons?status=accepted'))).toHaveLength(0)
  })
})

describe('身份（20 §5）', () => {
  it('/v1/me 带出人、工作区、成员身份与名下 Assignment', async () => {
    const h = await harness()
    const me = await data<{
      person: { id: string }
      workspace: { id: string }
      membership: { role: string }
      assignments: unknown[]
      kind: string
    }>(await h.get('/v1/me'))
    expect(me.person.id).toBe(h.person_id)
    expect(me.workspace.id).toBe(h.workspace_id)
    expect(me.membership.role).toBe('owner')
    expect(me.assignments.length).toBeGreaterThan(0)
    expect(me.kind).toBe('session')
  })

  it('建工作区 201；加成员要策略层写权限且不能跨工作区', async () => {
    const h = await harness()
    const created = await h.post('/v1/workspaces', { name: '新工作区' })
    expect(created.status).toBe(201)

    const outsider = await h.identity.createPerson({ email: 'x@example.com', name: 'x' })
    const added = await h.post(`/v1/workspaces/${h.workspace_id}/memberships`, {
      person_id: outsider.id,
      role: 'member',
    })
    expect(added.status).toBe(201)

    const wrongWs = await h.post('/v1/workspaces/ws_elsewhere/memberships', {
      person_id: outsider.id,
      role: 'member',
    })
    expect(wrongWs.status).toBe(403)

    const noPerm = await h.post(
      `/v1/workspaces/${h.workspace_id}/memberships`,
      { person_id: outsider.id, role: 'member' },
      { assignment: h.weakAssignment.id },
    )
    expect(noPerm.status).toBe(403)
  })

  it('重复加同一个人 → 409 conflict', async () => {
    const h = await harness()
    const res = await h.post(`/v1/workspaces/${h.workspace_id}/memberships`, {
      person_id: h.other_id,
      role: 'member',
    })
    expect(res.status).toBe(409)
  })
})

describe('OpenAPI', () => {
  it('路径转成 {param} 形式，且每条都有错误信封与安全声明', async () => {
    const h = await harness()
    const doc = (await (
      await h.gateway.fetch(new Request('http://127.0.0.1/openapi.json'))
    ).json()) as {
      openapi: string
      info: { version: string }
      paths: Record<
        string,
        Record<string, { responses: Record<string, unknown>; security: unknown[] }>
      >
    }
    expect(doc.openapi).toBe('3.1.0')
    expect(doc.info.version).toBe('9.9.9')
    expect(Object.keys(doc.paths)).toContain('/v1/approvals/{id}/decide')
    expect(Object.keys(doc.paths).every((p) => !p.includes(':'))).toBe(true)

    const decide = doc.paths['/v1/approvals/{id}/decide']?.post
    expect(decide?.responses['401']).toBeDefined()
    expect(decide?.responses['503']).toBeDefined()
    expect(decide?.security).toEqual([{ bearerAuth: [] }])

    const health = doc.paths['/v1/health']?.get
    expect(health?.security).toEqual([])
  })

  it('声明里有请求体 schema 与鉴权元组', async () => {
    const h = await harness()
    const doc = h.gateway.openapi
    const decide = doc.paths['/v1/approvals/{id}/decide']?.post as {
      requestBody: { content: Record<string, { schema: { properties: Record<string, unknown> } }> }
      'x-authz': { domain: string }
      'x-halt-scope': string
      parameters: { name: string; in: string; required: boolean }[]
    }
    expect(
      Object.keys(decide.requestBody.content['application/json']?.schema.properties ?? {}),
    ).toContain('action')
    expect(decide['x-authz'].domain).toBe('approval')
    expect(decide['x-halt-scope']).toBe('outbound')
    expect(decide.parameters.find((p) => p.name === 'X-Assignment')?.required).toBe(true)
    expect(decide.parameters.find((p) => p.name === 'Idempotency-Key')?.required).toBe(false)
  })

  it('toOpenApiPath 只换路径参数', () => {
    expect(toOpenApiPath('/v1/approvals/:id/history')).toBe('/v1/approvals/{id}/history')
    expect(toOpenApiPath('/v1/health')).toBe('/v1/health')
  })
})
