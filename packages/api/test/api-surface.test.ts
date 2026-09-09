/**
 * WP33 A：补齐的那几条路由，逐条对照规范。
 *
 * 14 §10（`POST /approvals`、children）、19 §6（sources / cite / gaps）、
 * 20 §3（logout / session）、21 §1 + docs/35 §4（`/v1/events` 按岗位可读）、
 * 36 §3（岗位摘要）。
 */
import { describe, expect, it } from 'vitest'
import { approvalItem, harness, T0 } from './helpers.js'

const data = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data
const err = async (res: Response): Promise<{ code: string; message: string }> =>
  (await res.json()) as { code: string; message: string }

describe('14 §10 建审批项', () => {
  it('人主动建一张 policy_change：提议者是本人、职责随本次岗位、去重键带工作区', async () => {
    const h = await harness()
    const res = await h.post('/v1/approvals', {
      kind: 'policy_change',
      subject: { object: { type: 'policy', id: 'refund_window' } },
      dedupe_key: 'refund_window_14d',
      title: '退货窗口改成 14 天',
      summary: '客服每天都在解释这条，写进策略层省一次解释。',
      payload: { target: 'workspace_policy', after: { return_window_days: 14 } },
    })
    expect(res.status).toBe(201)
    const item = await data<{
      id: string
      kind: string
      role_id: string
      dedupe_key: string
      proposer: { kind: string; id: string; assignment_id: string }
      automation: { level_at_creation: string }
      links: { children: string[] }
    }>(res)
    expect(item.kind).toBe('policy_change')
    expect(item.role_id).toBe(h.assignment.role_id)
    expect(item.dedupe_key).toBe(`${h.workspace_id}:policy_change:refund_window_14d`)
    expect(item.proposer).toEqual({
      kind: 'person',
      id: h.person_id,
      assignment_id: h.assignment.id,
    })
    // 调用方说了不算：等级一律 L1，状态机的其余部分由 14 的实现给
    expect(item.automation.level_at_creation).toBe('L1')
  })

  it('不给收件人时默认是本人，并打上 SoD 标记（14 §11 用例 12 由下游裁决）', async () => {
    const h = await harness()
    const item = await data<{
      routing: { recipients: { person: string }[]; separation_of_duties: boolean }
    }>(
      await h.post('/v1/approvals', {
        kind: 'ai_question',
        subject: { object: { type: 'thread', id: 'thr_9' } },
        dedupe_key: 'q1',
        title: '这单能不能退',
        summary: '缺一条政策',
      }),
    )
    expect(item.routing.recipients).toEqual([{ person: h.person_id, via: 'role_holder' }])
    expect(item.routing.separation_of_duties).toBe(true)
  })

  it('同 dedupe_key 再提一次是同一张卡（14 §11 用例 1 的网关侧）', async () => {
    const h = await harness()
    const body = {
      kind: 'policy_change' as const,
      subject: { object: { type: 'policy', id: 'p1' } },
      dedupe_key: 'same',
      title: 't',
      summary: 's',
    }
    const first = await data<{ id: string }>(await h.post('/v1/approvals', body))
    const second = await data<{ id: string }>(await h.post('/v1/approvals', body))
    expect(second.id).toBe(first.id)
  })

  it('kind 不在 14 §1 的表里 → 400', async () => {
    const h = await harness()
    const res = await h.post('/v1/approvals', {
      kind: 'buy_me_a_coffee',
      subject: { object: { type: 'x', id: 'y' } },
      dedupe_key: 'd',
      title: 't',
      summary: 's',
    })
    expect(res.status).toBe(400)
    expect((await err(res)).code).toBe('invalid_input')
  })

  it('children：只出本工作区的子项，别人的 decision_token 已抹去', async () => {
    const h = await harness()
    h.approvals.seed(
      approvalItem({
        id: 'ap_child',
        workspace_id: h.workspace_id,
        deliveries: [
          {
            channel: 'workstation',
            to: h.other_id,
            sent_at: T0,
            view: 'full',
            decision_token: 'tok_other',
            status: 'sent',
          },
        ],
      }),
    )
    h.approvals.seed({ ...approvalItem({ id: 'ap_elsewhere' }), workspace_id: 'ws_elsewhere' })
    const parent = h.approvals.items.get(h.item.id)
    if (parent) parent.links = { children: ['ap_child', 'ap_elsewhere', 'ap_missing'] }
    const children = await data<{ id: string; deliveries: { decision_token: string }[] }[]>(
      await h.get(`/v1/approvals/${h.item.id}/children`),
    )
    expect(children.map((c) => c.id)).toEqual(['ap_child'])
    expect(children[0]?.deliveries[0]?.decision_token).toBe('[redacted]')
  })

  it('children 挂在不存在的卡上 → 404', async () => {
    const h = await harness()
    expect((await h.get('/v1/approvals/ap_nope/children')).status).toBe(404)
  })
})

describe('19 §6 知识：导入源 / 引用 / 缺口', () => {
  it('登记一个导入源再列出来', async () => {
    const h = await harness()
    const created = await data<{ id: string; kind: string; ref: string }>(
      await h.post('/v1/knowledge/sources', {
        kind: 'website',
        ref: 'https://example.com/policy',
        parser: 'html',
      }),
    )
    expect(created.kind).toBe('website')
    const list = await data<{ id: string }[]>(await h.get('/v1/knowledge/sources'))
    expect(list.map((s) => s.id)).toEqual([created.id])
  })

  it('parser 不在 19 §1.3 的三种里 → 400', async () => {
    const h = await harness()
    const res = await h.post('/v1/knowledge/sources', {
      kind: 'website',
      ref: 'x',
      parser: 'pdfmagic',
    })
    expect(res.status).toBe(400)
  })

  it('cite 记一次引用；引用看不见的卡 → 404（不当存在性探测用）', async () => {
    const h = await harness()
    const out = await data<{ cited: boolean }>(
      await h.post('/v1/knowledge/cards/fc_1/cite', { run_id: 'run_7' }),
    )
    expect(out.cited).toBe(true)
    expect(h.knowledgeState.cites).toEqual([{ id: 'fc_1', run_id: 'run_7' }])
    expect((await h.post('/v1/knowledge/cards/fc_nope/cite', { run_id: 'run_7' })).status).toBe(404)
  })

  it('缺口：开 → 列 → 答，答完变一张 knowledge_update 卡（19 §4）', async () => {
    const h = await harness()
    const gap = await data<{ id: string; status: string }>(
      await h.post('/v1/knowledge/gaps', {
        question: '德国境内退货运费谁出？',
        subject: { type: 'policy', key: 'return_shipping_de' },
      }),
    )
    expect(gap.status).toBe('open')
    expect(await data<unknown[]>(await h.get('/v1/knowledge/gaps?status=open'))).toHaveLength(1)
    const answered = await data<{
      gap: { status: string; answer: string }
      approval_item_id: string
    }>(await h.post(`/v1/knowledge/gaps/${gap.id}/answer`, { answer: '我们出', layer: 'policy' }))
    expect(answered.gap.status).toBe('answered')
    expect(answered.gap.answer).toBe('我们出')
    // 写只经审批项：答案本身没有直接写进知识库
    expect(answered.approval_item_id).toBe('ap_from_gap')
    expect(await data<unknown[]>(await h.get('/v1/knowledge/gaps?status=open'))).toHaveLength(0)
  })

  it('status 不合法 → 400', async () => {
    const h = await harness()
    expect((await h.get('/v1/knowledge/gaps?status=whatever')).status).toBe(400)
  })

  it('知识模块没装这几个可选面 → 501，不是 500 也不是 404', async () => {
    const h = await harness({ bareKnowledge: true })
    for (const res of [
      await h.get('/v1/knowledge/sources'),
      await h.get('/v1/knowledge/gaps'),
      await h.post('/v1/knowledge/gaps', {
        question: 'q',
        subject: { type: 'policy', key: 'k' },
      }),
      await h.post('/v1/knowledge/cards/fc_1/cite', { run_id: 'run_1' }),
    ]) {
      expect(res.status).toBe(501)
      expect((await err(res)).code).toBe('not_implemented')
    }
  })
})

describe('20 §3 会话与注销', () => {
  it('session 回当前主体与到期时间', async () => {
    const h = await harness()
    // 会话 token 带 12h 有效期（本地档默认）；`issue` 不传 ttl 的那种（内部凭据）不到期
    const session = h.identity.issue('session', h.person_id, h.workspace_id, 12 * 60 * 60 * 1000)
    const out = await data<{
      person: { id: string }
      workspace_id: string
      kind: string
      expires_at: string
      expires_in_seconds: number
    }>(
      await h.get('/v1/auth/session', {
        assignment: null,
        headers: { Authorization: `Bearer ${session.token}` },
      }),
    )
    expect(out.person.id).toBe(h.person_id)
    expect(out.workspace_id).toBe(h.workspace_id)
    expect(out.kind).toBe('session')
    // 内存身份服务的会话默认 12h
    expect(out.expires_in_seconds).toBe(12 * 60 * 60)
    expect(Date.parse(out.expires_at)).toBeGreaterThan(Date.parse(T0))
  })

  it('logout 撤销的是这一张：本人的另一张 token 照样能用', async () => {
    const h = await harness()
    const second = h.identity.issue('api_key', h.person_id, h.workspace_id).token
    const res = await h.post('/v1/auth/logout', undefined, {
      assignment: null,
      headers: { Authorization: `Bearer ${h.token}` },
    })
    expect(res.status).toBe(200)
    expect(await data<{ revoked: boolean }>(res)).toEqual({ revoked: true })
    // cookie 被抹掉（Max-Age=0）
    expect(res.headers.get('Set-Cookie')).toContain('Max-Age=0')
    // 这一张不能用了
    expect(
      (await h.get('/v1/me', { assignment: null, headers: { Authorization: `Bearer ${h.token}` } }))
        .status,
    ).toBe(401)
    // 另一张还能用
    expect(
      (
        await h.get('/v1/me', {
          assignment: null,
          headers: { Authorization: `Bearer ${second}` },
        })
      ).status,
    ).toBe(200)
  })

  it('没凭据时 logout 也要 401（不是「反正是注销就放行」）', async () => {
    const h = await harness()
    expect(
      (await h.post('/v1/auth/logout', undefined, { assignment: null, headers: {} })).status,
    ).toBe(401)
  })
})

describe('36 §3 岗位摘要', () => {
  it('三个 Tab 的计数一次给全，且与各自那条路由对得上', async () => {
    const h = await harness()
    const summary = await data<{
      position: { position_id: string }
      counts: { cards: number; sections: number; records: number }
      sections: { source: string; blocks: number }[]
    }>(await h.get(`/v1/positions/${h.assignment.id}/summary`))
    expect(summary.position.position_id).toBe(h.assignment.id)
    const cards = await data<{ counts: { total: number } }>(
      await h.get(`/v1/positions/${h.assignment.id}/cards`),
    )
    expect(summary.counts.cards).toBe(cards.counts.total)
    const view = await data<{ sections: { source: string }[] }>(
      await h.get(`/v1/positions/${h.assignment.id}/view`),
    )
    expect(summary.sections.map((s) => s.source)).toEqual(view.sections.map((s) => s.source))
    const records = await data<{ payload: { rows: unknown[] } }>(
      await h.get(`/v1/positions/${h.assignment.id}/records`),
    )
    expect(summary.counts.records).toBe(records.payload.rows.length)
  })

  it('岗位 id 与 X-Assignment 不一致 → 403（31 §3.1）', async () => {
    const h = await harness()
    expect((await h.get('/v1/positions/asg_somebody_else/summary')).status).toBe(403)
  })
})

describe('28 §2 OpenAPI 覆盖全部路由', () => {
  it('每条注册的路由都在文档里，operationId 唯一且非空', async () => {
    const h = await harness()
    const doc = h.gateway.openapi
    for (const spec of h.gateway.specs) {
      const key = spec.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}')
      expect(doc.paths[key], `${spec.method} ${spec.path} 不在 openapi 里`).toBeDefined()
      expect((doc.paths[key] as Record<string, unknown>)[spec.method]).toBeDefined()
    }
    const ids = h.gateway.specs.map((s) => s.operationId)
    expect(ids.filter((id) => id === '')).toHaveLength(0)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('错误信封与成功信封走 $ref，不是每条路由内联一份', async () => {
    const h = await harness()
    const doc = h.gateway.openapi
    const decide = (doc.paths['/v1/approvals/{id}/decide'] as Record<string, unknown>)?.post as {
      responses: Record<string, { content: Record<string, { schema: { $ref?: string } }> }>
      'x-returns': string
    }
    expect(decide.responses['200']?.content['application/json']?.schema.$ref).toBe(
      '#/components/schemas/Envelope',
    )
    expect(decide.responses['403']?.content['application/json']?.schema.$ref).toBe(
      '#/components/schemas/Error',
    )
    // `data` 的形状说明搬到了 x-returns（$ref 之后 description 不在那一层了）
    expect(decide['x-returns']).toContain('ApprovalItem')
    const schemas = (doc.components as { schemas: Record<string, unknown> }).schemas
    expect(Object.keys(schemas)).toEqual(
      expect.arrayContaining(['Envelope', 'Error', 'WsFrame', 'WsClientMessage']),
    )
  })

  it('WP33 新加的那几条都有 operationId（第三方靠它生成客户端）', async () => {
    const h = await harness()
    const ids = new Set(h.gateway.specs.map((s) => s.operationId))
    for (const id of [
      'createApproval',
      'listApprovalChildren',
      'listKnowledgeSources',
      'addKnowledgeSource',
      'citeKnowledgeCard',
      'listKnowledgeGaps',
      'openKnowledgeGap',
      'answerKnowledgeGap',
      'getSession',
      'logout',
      'getPositionSummary',
      'openEventStream',
    ])
      expect(ids, id).toContain(id)
  })
})
