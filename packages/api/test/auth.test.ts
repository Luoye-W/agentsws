/** 28 §2 鉴权、31 §3.1 单 Assignment 绑定、20 §3 token 绑工作区。 */
import type { ErrorCode } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { harness } from './helpers.js'

const codeOf = async (res: Response): Promise<string> =>
  ((await res.json()) as { code: string }).code

describe('鉴权（401）', () => {
  it('没有 Authorization 头 → 401 unauthenticated', async () => {
    const h = await harness()
    const res = await h.gateway.fetch(new Request('http://127.0.0.1/v1/me'))
    expect(res.status).toBe(401)
    expect(await codeOf(res)).toBe('unauthenticated')
  })

  it('token 不存在 → 401', async () => {
    const h = await harness()
    const res = await h.get('/v1/me', { headers: { Authorization: 'Bearer nope' } })
    expect(res.status).toBe(401)
  })

  it('token 撤销后 → 401', async () => {
    const h = await harness()
    expect((await h.get('/v1/me')).status).toBe(200)
    h.identity.revoke(h.token)
    expect((await h.get('/v1/me')).status).toBe(401)
  })

  it('会话 token 过期 → 401', async () => {
    const h = await harness()
    const short = h.identity.issue('session', h.person_id, h.workspace_id, 1000).token
    const headers = { Authorization: `Bearer ${short}` }
    expect((await h.get('/v1/me', { headers })).status).toBe(200)
    h.clock.advance(1001)
    expect((await h.get('/v1/me', { headers })).status).toBe(401)
  })

  it('magic link：签发 → 验证 → 换到会话 token；同一 token 不能用第二次', async () => {
    const h = await harness()
    const issued = await h.post(
      '/v1/auth/magic-link',
      { email: 'me@example.com' },
      {
        assignment: null,
      },
    )
    expect(issued.status).toBe(200)
    const { data } = (await issued.json()) as { data: { token: string; expires_at: string } }

    const verified = await h.post('/v1/auth/verify', { token: data.token }, { assignment: null })
    expect(verified.status).toBe(200)
    const session = (await verified.json()) as { data: { session_token: string } }
    const me = await h.get('/v1/me', {
      headers: { Authorization: `Bearer ${session.data.session_token}` },
    })
    expect(me.status).toBe(200)

    const replay = await h.post('/v1/auth/verify', { token: data.token }, { assignment: null })
    expect(replay.status).toBe(401)
  })

  it('托管档（exposeMagicLinkToken=false）不把一次性 token 放进响应', async () => {
    const h = await harness({ exposeMagicLinkToken: false })
    const res = await h.post(
      '/v1/auth/magic-link',
      { email: 'me@example.com' },
      {
        assignment: null,
      },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { token?: string; delivered?: string } }
    expect(body.data.token).toBeUndefined()
    expect(body.data.delivered).toBe('email')
  })

  it('未知邮箱 → 404（不返回 token）', async () => {
    const h = await harness()
    const res = await h.post(
      '/v1/auth/magic-link',
      { email: 'nobody@example.com' },
      {
        assignment: null,
      },
    )
    expect(res.status).toBe(404)
  })

  it('X-Workspace 与凭据不一致 → 403', async () => {
    const h = await harness()
    const res = await h.get('/v1/me', { headers: { 'X-Workspace': 'ws_other' } })
    expect(res.status).toBe(403)
    expect(await codeOf(res)).toBe('forbidden')
  })
})

describe('X-Assignment 与授权（400 / 403）', () => {
  it('需要 Assignment 的路由缺头 → 400 invalid_input', async () => {
    const h = await harness()
    const res = await h.get('/v1/approvals', {
      headers: { Authorization: `Bearer ${h.token}` },
      assignment: undefined,
      // 显式清掉 X-Assignment
    })
    // helper 默认会补上，这里手动构造一个不带头的请求
    expect(res.status).toBe(200)
    const bare = await h.gateway.fetch(
      new Request('http://127.0.0.1/v1/approvals', {
        headers: { Authorization: `Bearer ${h.token}` },
      }),
    )
    expect(bare.status).toBe(400)
    expect(await codeOf(bare)).toBe('invalid_input')
  })

  it('X-Assignment 不属于本人 / 已撤销 / 不存在 → 403', async () => {
    const h = await harness()
    for (const id of ['asg_foreign', 'asg_revoked', 'asg_missing']) {
      const res = await h.get('/v1/approvals', { assignment: id })
      expect(res.status, id).toBe(403)
      expect(await codeOf(res)).toBe('forbidden')
    }
  })

  it('权限不足（弱 Assignment 读知识）→ 403，带判定元组', async () => {
    const h = await harness()
    const res = await h.get('/v1/knowledge/cards', { assignment: h.weakAssignment.id })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { code: string; details: { domain: string; op: string } }
    expect(body.code).toBe('forbidden')
    expect(body.details).toMatchObject({ domain: 'knowledge', op: 'read', range: 'workspace' })
  })

  it('同一个人换成有权限的 Assignment 就通过（不做跨 Assignment 并集）', async () => {
    const h = await harness()
    expect((await h.get('/v1/knowledge/cards', { assignment: h.weakAssignment.id })).status).toBe(
      403,
    )
    expect((await h.get('/v1/knowledge/cards', { assignment: h.assignment.id })).status).toBe(200)
  })

  it('自助豁免：读自己的 Assignment 不需要策略层读权限，读别人的需要', async () => {
    const h = await harness()
    const own = await h.get(`/v1/assignments/${h.weakAssignment.id}/effective`, {
      assignment: h.weakAssignment.id,
    })
    expect(own.status).toBe(200)
    const other = await h.get(`/v1/assignments/${h.assignment.id}/effective`, {
      assignment: h.weakAssignment.id,
    })
    expect(other.status).toBe(403)
    const self = await h.get(`/v1/assignments?person=${h.person_id}`, {
      assignment: h.weakAssignment.id,
    })
    expect(self.status).toBe(200)
    const someone = await h.get(`/v1/assignments?person=${h.other_id}`, {
      assignment: h.weakAssignment.id,
    })
    expect(someone.status).toBe(403)
  })

  it('公开路由不需要 Bearer，也不需要 Assignment', async () => {
    const h = await harness()
    for (const path of ['/v1/health', '/openapi.json', '/v1/openapi.json'])
      expect((await h.gateway.fetch(new Request(`http://127.0.0.1${path}`))).status, path).toBe(200)
  })
})

describe('错误码 → HTTP 状态映射（28 §2）', () => {
  const cases: [ErrorCode, number][] = [
    ['not_found', 404],
    ['forbidden', 403],
    ['sod_violation', 403],
    ['invalid_input', 400],
    ['conflict', 409],
    ['idempotency_conflict', 409],
    ['stale_record', 409],
    ['snapshot_mismatch', 409],
    ['budget_exhausted', 429],
    ['halted', 503],
    ['not_approved', 500],
    ['unknown_outcome', 500],
  ]

  it.each(cases)('下游抛 %s → %i', async (code, status) => {
    const h = await harness()
    h.thrower.code = code
    const res = await h.get('/v1/changes')
    expect(res.status).toBe(status)
    const body = (await res.json()) as { code: string; message: string; trace_id: string }
    expect(body.code).toBe(code)
    expect(body.trace_id).not.toBe('')
  })

  it('没有 code 的意外错误 → 500 internal，且不回传内部消息', async () => {
    const h = await harness()
    const deps = h.deps
    deps.changes.list = async () => {
      throw new Error('secret: db password is hunter2')
    }
    const res = await h.get('/v1/changes')
    expect(res.status).toBe(500)
    const body = (await res.json()) as { code: string; message: string }
    expect(body.code).toBe('internal')
    expect(body.message).toBe('internal error')
    expect(JSON.stringify(body)).not.toContain('hunter2')
  })
})

describe('限流（429 + Retry-After）', () => {
  it('超出令牌桶 → 429 budget_exhausted，带 Retry-After', async () => {
    const h = await harness({ rateLimit: { burst: 2, per_second: 1 } })
    expect((await h.get('/v1/approvals')).status).toBe(200)
    expect((await h.get('/v1/approvals')).status).toBe(200)
    const limited = await h.get('/v1/approvals')
    expect(limited.status).toBe(429)
    expect(((await limited.json()) as { code: string }).code).toBe('budget_exhausted')
    expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1)

    // 时钟前进 → 令牌恢复
    h.clock.advance(2000)
    expect((await h.get('/v1/approvals')).status).toBe(200)
  })

  it('不同 workspace × kind 各自一个桶', async () => {
    const h = await harness({ rateLimit: { burst: 1, per_second: 0.001 } })
    expect((await h.get('/v1/approvals')).status).toBe(200)
    expect((await h.get('/v1/approvals')).status).toBe(429)
    // 另一个人用 api_key（不同 kind）不受影响
    const other = await h.gateway.fetch(
      new Request('http://127.0.0.1/v1/me', {
        headers: { Authorization: `Bearer ${h.otherToken}` },
      }),
    )
    expect(other.status).toBe(200)
  })
})
