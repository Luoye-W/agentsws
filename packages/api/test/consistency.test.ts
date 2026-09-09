/** 28 §4 一致性用例六条。 */
import { describe, expect, it } from 'vitest'
import { OPENAPI_PATH } from '../src/index.js'
import { harness } from './helpers.js'

describe('28 §4 用例 1：工作台任何功能仅经 /v1', () => {
  it('注册的路径除 /openapi.json 外全部在 /v1 之下', async () => {
    const h = await harness()
    const paths = h.gateway.paths().map((r) => r.path)
    expect(paths.length).toBeGreaterThan(20)
    const outside = paths.filter((p) => !p.startsWith('/v1/') && p !== OPENAPI_PATH)
    expect(outside).toEqual([])
  })

  it('声明表与实际注册一一对应', async () => {
    const h = await harness()
    const declared = new Set(h.gateway.specs.map((s) => `${s.method.toUpperCase()} ${s.path}`))
    const registered = new Set(
      h.gateway
        .paths()
        .filter((r) => r.path.startsWith('/v1/') && !r.path.endsWith(OPENAPI_PATH))
        .map((r) => `${r.method} ${r.path}`),
    )
    expect([...registered].sort()).toEqual([...declared].sort())
  })

  it('别的前缀一律 404，且是统一错误信封', async () => {
    const h = await harness()
    const res = await h.get('/v2/approvals')
    expect(res.status).toBe(404)
    const body = (await res.json()) as { code: string; trace_id: string }
    expect(body.code).toBe('not_found')
    expect(body.trace_id).not.toBe('')
    expect(res.headers.get('X-Trace-Id')).toBe(body.trace_id)
  })
})

describe('28 §4 用例 2：未签名 / 挂起的模块在 /v1/health 可见', () => {
  it('failed 与 pending 都列出来，且不需要凭据', async () => {
    const h = await harness()
    const res = await h.gateway.fetch(new Request('http://127.0.0.1/v1/health'))
    expect(res.status).toBe(200)
    const { data } = (await res.json()) as {
      data: { status: string; modules: { id: string; state: string; missing?: string[] }[] }
    }
    expect(data.status).toBe('degraded')
    const failed = data.modules.find((m) => m.id === 'evil-module')
    expect(failed?.state).toBe('failed')
    const pending = data.modules.find((m) => m.id === 'ads')
    expect(pending?.state).toBe('pending')
    expect(pending?.missing).toEqual(['connector.ads@^1'])
  })
})

describe('28 §4 用例 3：AGENTSWS_HALT=outbound 后 send / apply 停，读照常', () => {
  it('decide / batch decide / retry-apply → 503 halted；读仍 200', async () => {
    const h = await harness()
    h.halt.set('outbound', true, 'AGENTSWS_HALT env')

    const decide = await h.post(`/v1/approvals/${h.item.id}/decide`, { action: 'approve' })
    expect(decide.status).toBe(503)
    expect(((await decide.json()) as { code: string }).code).toBe('halted')

    const retry = await h.post(`/v1/approvals/${h.item.id}/retry-apply`)
    expect(retry.status).toBe(503)

    const batch = await h.post('/v1/approvals/batch/decide', {
      entries: [{ id: h.item.id }],
      action: 'approve',
    })
    expect(batch.status).toBe(503)

    expect((await h.get('/v1/approvals')).status).toBe(200)
    expect((await h.get(`/v1/approvals/${h.item.id}`)).status).toBe(200)
    expect((await h.get('/v1/changes')).status).toBe(200)
    // 认领不是 send / apply，照常
    expect((await h.post(`/v1/approvals/${h.item.id}/claim`)).status).toBe(200)
    expect(h.approvals.log).toEqual([])
  })

  it('halt=all 时读写都停，只有 /v1/health 还能进', async () => {
    const h = await harness()
    h.halt.set('all', true, 'AGENTSWS_HALT env')
    const read = await h.get('/v1/approvals')
    expect(read.status).toBe(503)
    expect(((await read.json()) as { code: string }).code).toBe('halted')
    const health = await h.gateway.fetch(new Request('http://127.0.0.1/v1/health'))
    expect(health.status).toBe(200)
    expect(((await health.json()) as { data: { status: string } }).data.status).toBe('halted')
  })
})

describe('28 §4 用例 4：事件流按 ulid 续传，无丢无重', () => {
  const seed = (h: Awaited<ReturnType<typeof harness>>, n: number, type: string): void => {
    for (let i = 0; i < n; i += 1)
      h.eventLog.append({
        schema_version: 1,
        workspace_id: h.workspace_id,
        type,
        at: h.clock.now(),
        actor: { kind: 'system', id: 'test' },
        correlation: { trace_id: `tr_${i}` },
        payload: { i },
      })
  }

  it('断线后带最后一条 id 续传，两段拼起来正好是全集', async () => {
    const h = await harness()
    seed(h, 5, 'approval.created')

    const first = await h.get('/v1/events?limit=3')
    const page1 = (await first.json()) as {
      data: { events: { id: string }[]; next_since: string; has_more: boolean }
    }
    expect(page1.data.events).toHaveLength(3)
    expect(page1.data.has_more).toBe(true)

    // 期间又来了两条
    seed(h, 2, 'approval.decided')

    const second = await h.get(`/v1/events?since=${page1.data.next_since}&limit=10`)
    const page2 = (await second.json()) as { data: { events: { id: string }[] } }
    const ids = [...page1.data.events, ...page2.data.events].map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length) // 无重
    expect(ids).toEqual(h.eventLog.events.map((e) => e.id)) // 无丢，且保序
  })

  it('types 过滤与空结果的 next_since 保持不变', async () => {
    const h = await harness()
    seed(h, 2, 'approval.created')
    seed(h, 1, 'change.applied')
    const res = await h.get('/v1/events?types=change.applied')
    const body = (await res.json()) as { data: { events: { type: string }[] } }
    expect(body.data.events.map((e) => e.type)).toEqual(['change.applied'])

    const empty = await h.get('/v1/events?since=evt_999999')
    const emptyBody = (await empty.json()) as { data: { events: unknown[]; next_since: string } }
    expect(emptyBody.data.events).toEqual([])
    expect(emptyBody.data.next_since).toBe('evt_999999')
  })

  it('长轮询：wait_ms 内没有新事件就空返回（轮询次数由 wait_ms/间隔决定）', async () => {
    const h = await harness()
    const res = await h.get('/v1/events?wait_ms=20')
    const body = (await res.json()) as { data: { events: unknown[] } }
    expect(body.data.events).toEqual([])
  })
})

describe('28 §4 用例 5：同 Idempotency-Key 的 POST 重放原响应', () => {
  it('第二次直接返回第一次的响应体，不再打下游', async () => {
    const h = await harness()
    const headers = { 'Idempotency-Key': 'k1' }
    const first = await h.post(`/v1/approvals/${h.item.id}/claim`, undefined, { headers })
    const firstBody = await first.text()
    expect(first.status).toBe(200)

    const again = await h.post(`/v1/approvals/${h.item.id}/claim`, undefined, { headers })
    expect(again.status).toBe(200)
    expect(await again.text()).toBe(firstBody)
    expect(again.headers.get('Idempotent-Replay')).toBe('true')
  })

  it('同键换了请求内容 → idempotency_conflict 409', async () => {
    const h = await harness()
    const headers = { 'Idempotency-Key': 'k2' }
    await h.post(`/v1/approvals/${h.item.id}/decide`, { action: 'approve' }, { headers })
    const conflict = await h.post(
      `/v1/approvals/${h.item.id}/decide`,
      { action: 'reject', reason: '不行' },
      { headers },
    )
    expect(conflict.status).toBe(409)
    expect(((await conflict.json()) as { code: string }).code).toBe('idempotency_conflict')
    expect(h.approvals.log).toEqual([`decide:${h.item.id}:${h.person_id}`])
  })

  it('幂等表按 (workspace, person) 隔离：别人猜到同一个键也拿不到我的响应', async () => {
    const h = await harness()
    const headers = { 'Idempotency-Key': 'shared-key' }
    const mine = await h.post(`/v1/approvals/${h.item.id}/claim`, undefined, { headers })
    expect(mine.status).toBe(200)

    const theirs = await h.gateway.fetch(
      new Request(`http://127.0.0.1/v1/approvals/${h.item.id}/claim`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${h.otherToken}`,
          'X-Assignment': 'asg_foreign',
          ...headers,
        },
      }),
    )
    // 换了人就走自己的鉴权，拿不到重放
    expect(theirs.headers.get('Idempotent-Replay')).toBeNull()
  })

  it('公开路由不进幂等表（否则一次性登录 token 会被同键重放走）', async () => {
    const h = await harness()
    const headers = { 'Idempotency-Key': 'guessed' }
    const first = await h.post(
      '/v1/auth/magic-link',
      { email: 'me@example.com' },
      {
        assignment: null,
        headers,
      },
    )
    const second = await h.post(
      '/v1/auth/magic-link',
      { email: 'me@example.com' },
      {
        assignment: null,
        headers,
      },
    )
    expect(second.headers.get('Idempotent-Replay')).toBeNull()
    const a = (await first.json()) as { data: { token: string } }
    const b = (await second.json()) as { data: { token: string } }
    expect(a.data.token).not.toBe(b.data.token)
  })

  it('不带 Idempotency-Key 就每次都真的执行', async () => {
    const h = await harness()
    // 两条各自 pending 的审批项：网关不去重，两次都真的打到审批总线。
    // （同一条决定两次会被 36 §2 的动作矩阵挡住——已决定的卡只剩「打开」，见下一条用例。）
    const second = h.approvals.seed({ ...h.item, id: 'ap_2', state: 'pending' })
    await h.post(`/v1/approvals/${h.item.id}/decide`, { action: 'approve' })
    await h.post(`/v1/approvals/${second.id}/decide`, { action: 'approve' })
    expect(h.approvals.log).toHaveLength(2)
  })

  it('已决定的卡再决定一次 → 400（36 §2 动作矩阵：只剩「打开」）', async () => {
    const h = await harness()
    expect((await h.post(`/v1/approvals/${h.item.id}/decide`, { action: 'approve' })).status).toBe(
      200,
    )
    const again = await h.post(`/v1/approvals/${h.item.id}/decide`, { action: 'approve' })
    expect(again.status).toBe(400)
    expect(((await again.json()) as { details: { reason: string } }).details.reason).toBe(
      'ACTION_NOT_AVAILABLE',
    )
  })
})

describe('28 §4 用例 6：trace_id 从请求贯到事件日志', () => {
  it('请求头带 X-Trace-Id 时，下游写的事件用同一个 trace_id', async () => {
    const h = await harness()
    const res = await h.post(
      `/v1/approvals/${h.item.id}/decide`,
      { action: 'approve' },
      { headers: { 'X-Trace-Id': 'tr_from_inbound' } },
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Trace-Id')).toBe('tr_from_inbound')
    const decided = h.eventLog.events.filter((e) => e.type === 'approval.decided')
    expect(decided).toHaveLength(1)
    expect(decided[0]?.correlation.trace_id).toBe('tr_from_inbound')
    const body = (await res.json()) as { trace_id: string }
    expect(body.trace_id).toBe('tr_from_inbound')
  })

  it('没带时网关自己生成一个，并同样贯穿', async () => {
    const h = await harness()
    const res = await h.post(`/v1/approvals/${h.item.id}/decide`, { action: 'approve' })
    const body = (await res.json()) as { trace_id: string }
    expect(body.trace_id).toMatch(/^tr_/)
    expect(h.eventLog.events[0]?.correlation.trace_id).toBe(body.trace_id)
  })
})
