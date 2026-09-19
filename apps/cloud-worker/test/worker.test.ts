/**
 * WP114：Workers 形态走完整条路。
 *
 * 每一条都从**入口 Worker** 进（不是直接打 DO），所以测的是真正的那条链路：
 * 擦头 → 验令牌（问 AccountsDO）→ 选对象 → 转发 → DO 里跑现成的路由包。
 *
 * 要钉住的事，与 `apps/cloud/test/entry.test.ts` 那三条一一对上：
 *
 * 1. magic link → 令牌 → `/v1/wallet` 通；
 * 2. 撤销**立刻** 401（跨 DO 也不缓存）；
 * 3. 没有 `ai` 动作集 → 403（不是 401）；
 *
 * 外加只有这个形态才有的四件：
 *
 * 4. 余额不够 → 402，而且钱一分没扣；
 * 5. SSE **真流式**（上游还没发完，用户已经收到头几块）+ 流结束时结算；
 * 6. 管理员发积分、限流、幂等；
 * 7. 内部头**伪造不了**（进门先剥）。
 */

import {
  DEFAULT_CLOUD_SCOPES,
  METERING_EVENT_FIELDS,
  METERING_EVENT_REQUIRED_FIELDS,
} from '@agentsws/contracts'
import { beforeEach, describe, expect, it } from 'vitest'
import { INTERNAL_HEADERS, route } from '../src/index.js'
import {
  type FakeCloud,
  fakeCloud,
  req,
  SIGNUP_BONUS,
  tokenFromMail,
  zeroOut,
} from './helpers.js'

const ADMIN_TOKEN = 'test-admin-token-at-least-32-bytes-long-0123456789'
const CALLBACK = 'http://127.0.0.1:3000/v1/cloud/account/callback'

interface Json {
  data?: unknown
  code?: string
  message?: string
}

async function call(
  cloud: FakeCloud,
  path: string,
  init: { method?: string; body?: unknown; token?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: Json; res: Response }> {
  const headers = new Headers(init.headers ?? {})
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  if (init.token !== undefined) headers.set('Authorization', `Bearer ${init.token}`)
  const res = await route(
    req(path, {
      method: init.method ?? 'GET',
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
    cloud.env,
  )
  const text = await res.clone().text()
  return { status: res.status, body: text === '' ? {} : (JSON.parse(text) as Json), res }
}

/** 走一遍完整登录 → 签一把工作区服务令牌。 */
async function issueToken(
  cloud: FakeCloud,
  email: string,
  workspace_id: string,
  scopes: readonly string[],
): Promise<{ token: string; org: string; session: string }> {
  const before = cloud.mails.length
  const sent = await call(cloud, '/v1/cloud/auth/magic-link', {
    method: 'POST',
    body: { email, callback_url: CALLBACK },
  })
  expect(sent.status).toBe(200)
  expect(cloud.mails.length).toBe(before + 1)
  const oneTime = tokenFromMail(cloud.mails[cloud.mails.length - 1] as never)
  const verified = await call(cloud, '/v1/cloud/auth/verify', {
    method: 'POST',
    body: { token: oneTime },
  })
  expect(verified.status).toBe(200)
  const session = (verified.body.data as { session_token: string; org: { id: string } })
    .session_token
  const org = (verified.body.data as { org: { id: string } }).org.id
  const link = await call(cloud, '/v1/cloud/links', {
    method: 'POST',
    token: session,
    body: { workspace_id, scopes },
  })
  expect(link.status).toBe(201)
  return { token: (link.body.data as { token: string }).token, org, session }
}

describe('WP114 Workers 形态 · 账号那一层', () => {
  let cloud: FakeCloud

  beforeEach(() => {
    cloud = fakeCloud()
  })

  it('health 与首页从入口 Worker 打得通；值守与公共库如实说没开通', async () => {
    const health = await call(cloud, '/v1/cloud/health')
    expect(health.status).toBe(200)
    const data = health.body.data as { modules: Record<string, boolean> }
    expect(data.modules.entry).toBe(true)
    expect(data.modules.mail).toBe(true)
    // Workers 上没有常驻子进程，也没上公共红人库——**不假装有**
    expect(data.modules.standby).toBe(false)
    expect(data.modules.kol_public).toBe(false)
  })

  it('magic link → 令牌 → /v1/wallet 通（跨两个 DO）', async () => {
    const { token, org } = await issueToken(cloud, 'a@example.com', 'ws_a', DEFAULT_CLOUD_SCOPES)
    cloud.wallet(org).wallet.topup({ org_id: org, credits: 100, kind: 'purchased' })
    const wallet = await call(cloud, '/v1/wallet', { token })
    expect(wallet.status).toBe(200)
    // 自己充的 100 + WP121 注册赠送
    expect((wallet.body.data as { available: number }).available).toBe(100 + SIGNUP_BONUS)
  })

  it('一次性 token 只进邮件，不进响应体', async () => {
    const sent = await call(cloud, '/v1/cloud/auth/magic-link', {
      method: 'POST',
      body: { email: 'b@example.com', callback_url: CALLBACK },
    })
    expect(JSON.stringify(sent.body)).not.toContain('cml_')
  })

  it('内部路由从公网打进来是 404', async () => {
    const res = await call(cloud, '/__internal/verify-token', { method: 'POST', body: {} })
    expect(res.status).toBe(404)
  })
})

describe('WP114 Workers 形态 · 令牌与动作集', () => {
  let cloud: FakeCloud

  beforeEach(() => {
    cloud = fakeCloud()
  })

  it('撤销之后立刻 401——每次都问 AccountsDO，一秒都不缓存', async () => {
    const { token, org } = await issueToken(cloud, 'a@example.com', 'ws_a', DEFAULT_CLOUD_SCOPES)
    cloud.wallet(org).wallet.topup({ org_id: org, credits: 10, kind: 'purchased' })
    expect((await call(cloud, '/v1/wallet', { token })).status).toBe(200)
    const link = cloud.accounts().store.activeLinkOfWorkspace('ws_a')
    expect(link).toBeDefined()
    cloud.accounts().store.revokeLink(link?.id ?? '')
    // 中间没有任何"等一下"——下一条请求就该是 401
    expect((await call(cloud, '/v1/wallet', { token })).status).toBe(401)
  })

  it('没有 ai 动作集打模型口是 403，不是 401', async () => {
    const { token } = await issueToken(cloud, 'a@example.com', 'ws_a', ['wallet:read'])
    const forbidden = await call(cloud, '/v1/ai/models', { token })
    expect(forbidden.status).toBe(403)
    // 同一把令牌看余额是好的——是动作集不够，不是令牌有问题
    expect((await call(cloud, '/v1/wallet', { token })).status).toBe(200)
  })

  it('不带令牌 / 乱填令牌回同一句话、同一个状态码', async () => {
    const none = await call(cloud, '/v1/wallet')
    const bogus = await call(cloud, '/v1/wallet', { token: 'wst_not_a_real_token' })
    const wrongShape = await call(cloud, '/v1/wallet', { token: 'cs_session_not_service' })
    expect([none.status, bogus.status, wrongShape.status]).toEqual([401, 401, 401])
    expect(none.body.message).toBe(bogus.body.message)
    expect(none.body.message).toBe(wrongShape.body.message)
  })

  it('自己塞一个内部 principal 头没用——进门先剥掉', async () => {
    const forged = JSON.stringify({
      account_id: 'acc_evil',
      org_id: 'org_evil',
      workspace_id: 'ws_evil',
      scopes: ['ai', 'wallet:read', 'wallet:admin'],
    })
    const res = await call(cloud, '/v1/wallet', {
      token: 'wst_still_not_a_real_token',
      headers: { [INTERNAL_HEADERS.principal]: forged },
    })
    expect(res.status).toBe(401)
  })
})

describe('WP114 Workers 形态 · 钱', () => {
  let cloud: FakeCloud

  beforeEach(() => {
    cloud = fakeCloud({
      env: { AGENTSWS_NEWAPI_KEY: 'test-upstream-key' },
      fetch: async () => {
        throw new Error('这条用例不该打上游')
      },
    })
  })

  it('余额不够 → 402，而且钱一分没扣', async () => {
    const { token, org } = await issueToken(cloud, 'a@example.com', 'ws_a', DEFAULT_CLOUD_SCOPES)
    // 一分钱都不充。WP121 之后「刚注册」自带赠送的积分，所以先撤干净
    zeroOut(cloud, org)
    const res = await call(cloud, '/v1/ai/chat/completions', {
      method: 'POST',
      token,
      body: { model: 'deepseek-chat', messages: [{ role: 'user', content: '你好' }] },
    })
    expect(res.status).toBe(402)
    expect(res.body.code).toBe('insufficient_credits')
    expect(cloud.wallet(org).wallet.balance(org).available).toBe(0)
  })

  it('管理员发积分：没配钥匙这条路由根本不存在', async () => {
    const res = await call(cloud, '/v1/admin/topup', {
      method: 'POST',
      body: { email: 'a@example.com', credits: 10 },
    })
    expect(res.status).toBe(404)
  })

  it('管理员发积分：钥匙不对 401；对了就入一笔 granted', async () => {
    const withAdmin = fakeCloud({ env: { AGENTSWS_CLOUD_ADMIN_TOKEN: ADMIN_TOKEN } })
    const { token, org } = await issueToken(
      withAdmin,
      'a@example.com',
      'ws_a',
      DEFAULT_CLOUD_SCOPES,
    )
    const wrong = await call(withAdmin, '/v1/admin/topup', {
      method: 'POST',
      token: 'not-the-admin-token',
      body: { email: 'a@example.com', credits: 10 },
    })
    expect(wrong.status).toBe(401)

    const ok = await call(withAdmin, '/v1/admin/topup', {
      method: 'POST',
      token: ADMIN_TOKEN,
      body: { email: 'a@example.com', credits: 50 },
    })
    expect(ok.status).toBe(201)
    expect((ok.body.data as { org_id: string }).org_id).toBe(org)
    const wallet = await call(withAdmin, '/v1/wallet', { token })
    // 管理员发的 50 + WP121 注册赠送（两笔都是 granted）
    expect((wallet.body.data as { granted: number }).granted).toBe(50 + SIGNUP_BONUS)
  })

  it('管理员发积分：没登录过的邮箱 404，而且那句话不说"这个邮箱不存在"以外的事', async () => {
    const withAdmin = fakeCloud({ env: { AGENTSWS_CLOUD_ADMIN_TOKEN: ADMIN_TOKEN } })
    const res = await call(withAdmin, '/v1/admin/topup', {
      method: 'POST',
      token: ADMIN_TOKEN,
      body: { email: 'nobody@example.com', credits: 10 },
    })
    expect(res.status).toBe(404)
  })
})

describe('WP114 Workers 形态 · 限流与幂等', () => {
  it('同一个邮箱一小时最多五封信，第六次 429 带 Retry-After', async () => {
    const cloud = fakeCloud()
    for (let i = 0; i < 5; i += 1) {
      const res = await call(cloud, '/v1/cloud/auth/magic-link', {
        method: 'POST',
        body: { email: 'flood@example.com', callback_url: CALLBACK },
      })
      expect(res.status).toBe(200)
    }
    const sixth = await call(cloud, '/v1/cloud/auth/magic-link', {
      method: 'POST',
      body: { email: 'flood@example.com', callback_url: CALLBACK },
    })
    expect(sixth.status).toBe(429)
    expect(sixth.res.headers.get('Retry-After')).not.toBeNull()
    // 信只发出去五封
    expect(cloud.mails).toHaveLength(5)
  })

  it('同一个 Idempotency-Key 重放原响应，不签第二把令牌', async () => {
    const cloud = fakeCloud()
    const { session } = await issueToken(cloud, 'a@example.com', 'ws_a', DEFAULT_CLOUD_SCOPES)
    const body = { workspace_id: 'ws_b', scopes: ['wallet:read'] }
    const first = await call(cloud, '/v1/cloud/links', {
      method: 'POST',
      token: session,
      body,
      headers: { 'Idempotency-Key': 'k-1' },
    })
    const second = await call(cloud, '/v1/cloud/links', {
      method: 'POST',
      token: session,
      body,
      headers: { 'Idempotency-Key': 'k-1' },
    })
    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    expect(second.res.headers.get('Idempotent-Replay')).toBe('true')
    expect((second.body.data as { token: string }).token).toBe(
      (first.body.data as { token: string }).token,
    )
  })
})

describe('WP114 Workers 形态 · 流式与结算', () => {
  /** 一个会"边发边等"的假上游：让测试能看出中间有没有被缓冲。 */
  function slowStream(chunks: string[], gate: { release(): void; wait: Promise<void> }): Response {
    const encoder = new TextEncoder()
    let i = 0
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (i === 0) {
          controller.enqueue(encoder.encode(chunks[0] as string))
          i += 1
          gate.release()
          return
        }
        if (i === 1) await gate.wait
        if (i >= chunks.length) {
          controller.close()
          return
        }
        controller.enqueue(encoder.encode(chunks[i] as string))
        i += 1
      },
    })
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }

  it('SSE 不缓冲：上游还没发完，用户已经拿到头一块；流结束才结算', async () => {
    let releaseFirst: () => void = () => undefined
    const firstOut = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let letRest: () => void = () => undefined
    const restGate = new Promise<void>((resolve) => {
      letRest = resolve
    })

    const cloud = fakeCloud({
      env: { AGENTSWS_NEWAPI_KEY: 'test-upstream-key' },
      fetch: async () =>
        slowStream(
          [
            'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
            'data: {"usage":{"prompt_tokens":10,"completion_tokens":20}}\n\n',
            'data: [DONE]\n\n',
          ],
          { release: () => releaseFirst(), wait: restGate },
        ),
    })
    const { token, org } = await issueToken(cloud, 'a@example.com', 'ws_a', DEFAULT_CLOUD_SCOPES)
    cloud.wallet(org).wallet.topup({ org_id: org, credits: 100, kind: 'purchased' })

    const res = await route(
      req('/v1/ai/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          model: 'deepseek-chat',
          stream: true,
          messages: [{ role: 'user', content: '你好' }],
        }),
      }),
      cloud.env,
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    expect(res.body).not.toBeNull()

    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    // 上游只发了第一块（后面的还卡在门后），这里就该能读到它——不缓冲的证据
    await firstOut
    const first = await reader.read()
    expect(decoder.decode(first.value)).toContain('你')
    // 这一刻还没结算：预扣还占着，计量事件一条都没有
    expect(cloud.wallet(org).store.events({ org_id: org })).toHaveLength(0)
    expect(cloud.wallet(org).wallet.balance(org).reserved).toBeGreaterThan(0)

    letRest()
    let rest = ''
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      rest += decoder.decode(next.value)
    }
    expect(rest).toContain('[DONE]')

    /*
     * 流走完 → 按最后那条 usage 结算，记一条计量事件。
     *
     * WP115 之后字段白名单从八个扩到十六个（后八个是成本会计的可选列，65 §3），
     * 所以这里钉的两件事换了说法，但意思一个字没变：**必填那八个都在**，
     * **白名单之外一个键都没有**。
     */
    const events = cloud.wallet(org).store.events({ org_id: org })
    expect(events).toHaveLength(1)
    expect(events[0]?.capability).toBe('ai.chat')
    const allowed = new Set<string>(METERING_EVENT_FIELDS as readonly string[])
    for (const key of Object.keys(events[0] ?? {})) expect(allowed.has(key), key).toBe(true)
    for (const key of METERING_EVENT_REQUIRED_FIELDS)
      expect((events[0] as Record<string, unknown> | undefined)?.[key], key).toBeDefined()
    const after = cloud.wallet(org).wallet.balance(org)
    expect(after.reserved).toBe(0)
    expect(after.available).toBeLessThan(100 + SIGNUP_BONUS)
  })
})

describe('WP114 Workers 形态 · 跨平台导出', () => {
  it('没配 admin 钥匙 → 这条路由不存在', async () => {
    const cloud = fakeCloud()
    expect((await call(cloud, '/v1/admin/export')).status).toBe(404)
  })

  it('钥匙不对 401；对了就把账号 + 组织 + 关联 + 各组织的积分批次一起导出来', async () => {
    const cloud = fakeCloud({ env: { AGENTSWS_CLOUD_ADMIN_TOKEN: ADMIN_TOKEN } })
    const { org } = await issueToken(cloud, 'a@example.com', 'ws_a', DEFAULT_CLOUD_SCOPES)
    cloud.wallet(org).wallet.topup({ org_id: org, credits: 30, kind: 'granted' })

    expect((await call(cloud, '/v1/admin/export', { token: 'nope' })).status).toBe(401)

    const res = await call(cloud, '/v1/admin/export', { token: ADMIN_TOKEN })
    expect(res.status).toBe(200)
    const data = res.body.data as {
      accounts: { email: string }[]
      orgs: { id: string }[]
      links: { token_sha256: string }[]
      wallets: { org_id: string; lots: { credits: number; kind: string }[] }[]
    }
    expect(data.accounts.map((a) => a.email)).toEqual(['a@example.com'])
    expect(data.orgs.map((o) => o.id)).toEqual([org])
    // 令牌哈希在（不带它搬完家所有人都得重新关联），**明文一个都没有**
    expect(data.links[0]?.token_sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(data)).not.toContain('wst_')
    expect(JSON.stringify(data)).not.toContain('cs_')
    expect(JSON.stringify(data)).not.toContain('cml_')
    // 钱那一份跨对象拿回来了
    expect(data.wallets).toHaveLength(1)
    expect(data.wallets[0]?.org_id).toBe(org)
    // 两笔：WP121 注册赠送那一笔，加这条用例自己发的 30
    expect(data.wallets[0]?.lots).toEqual(
      expect.arrayContaining([expect.objectContaining({ credits: 30, kind: 'granted' })]),
    )
    expect(data.wallets[0]?.lots).toHaveLength(SIGNUP_BONUS > 0 ? 2 : 1)
  })
})
