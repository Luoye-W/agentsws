/**
 * 服务入口的端到端（49 M3）。
 *
 * 每个用例锁一条"反过来做会出事"的行为：
 * - 流式也要计量 → 否则只要带 `stream: true` 就白嫖；
 * - 余额不足 402 人话 → 否则用户看到一个 500，以为是我们挂了；
 * - cn 驻留拦截 → 否则"数据不出境"是一句空话；
 * - webhook 幂等 → Stripe 会重投，重投不该变成重复充值；
 * - 无 scope 403 → 令牌最小动作集（18 §1）。
 */

import { createHmac } from 'node:crypto'
import { buildPricing, MemoryWalletStore, Wallet } from '@agentsws/metering'
import { beforeEach, describe, expect, it } from 'vitest'
import { createEntryApp } from '../src/routes.js'
import type { EntryDeps, FetchLike } from '../src/types.js'

const NOW = '2026-09-15T12:00:00.000Z'
const WEBHOOK_SECRET = 'whsec_test_not_a_real_secret'

const TOKENS: Record<
  string,
  { account_id: string; org_id: string; workspace_id: string; scopes: string[] }
> = {
  wst_full: {
    account_id: 'acc_1',
    org_id: 'org_1',
    workspace_id: 'ws_1',
    scopes: ['ai', 'wallet:read', 'wallet:topup', 'wallet:admin'],
  },
  wst_member: {
    account_id: 'acc_2',
    org_id: 'org_1',
    workspace_id: 'ws_2',
    scopes: ['ai', 'wallet:read', 'wallet:topup'],
  },
  wst_no_ai: {
    account_id: 'acc_3',
    org_id: 'org_1',
    workspace_id: 'ws_1',
    scopes: ['wallet:read', 'wallet:topup'],
  },
}

const sse = (chunks: string[]): Response => {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
}

interface Harness {
  app: ReturnType<typeof createEntryApp>
  wallet: Wallet
  calls: { url: string; init: RequestInit }[]
  setUpstream: (fn: FetchLike) => void
}

function harness(over: Partial<EntryDeps> = {}): Harness {
  const calls: { url: string; init: RequestInit }[] = []
  let upstream: FetchLike = async () =>
    Response.json({
      id: 'chatcmpl-1',
      choices: [{ message: { role: 'assistant', content: '好的' } }],
      usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
    })
  let seq = 0
  const wallet = new Wallet({
    store: new MemoryWalletStore(),
    now: () => NOW,
    newId: (prefix) => `${prefix}_${++seq}`,
  })
  const app = createEntryApp({
    verifier: async (token) => TOKENS[token],
    wallet,
    pricing: buildPricing(),
    upstream: {
      ai: {
        base_url: 'https://upstream.invalid/v1',
        api_key: () => 'internal-key-never-leaves',
        region_map: { 'deepseek-flash': ['cn', 'global'], 'gpt-5-mini': ['global'] },
      },
    },
    stripe: {
      secret_key: () => 'sk_test_not_a_real_key',
      webhook_secret: () => WEBHOOK_SECRET,
      api_base: 'https://stripe.invalid',
      return_url: 'https://cloud.agentsws.com/billing',
    },
    now: () => NOW,
    newRequestId: () => `req_${++seq}`,
    fetch: (url, init) => {
      calls.push({ url, init })
      return upstream(url, init)
    },
    ...over,
  })
  return {
    app,
    wallet,
    calls,
    setUpstream: (fn) => {
      upstream = fn
    },
  }
}

const auth = (token = 'wst_full') => ({ Authorization: `Bearer ${token}` })

const chat = (body: Record<string, unknown>, token = 'wst_full') =>
  new Request('http://entry/v1/ai/chat/completions', {
    method: 'POST',
    headers: { ...auth(token), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('令牌与 scope（18 §1 最小动作集）', () => {
  it('没令牌 401', async () => {
    const h = harness()
    const res = await h.app.fetch(new Request('http://entry/v1/wallet'))
    expect(res.status).toBe(401)
  })

  it('不是 wst_ 前缀的与验不过的回同一句话——分开说等于告诉试探的人前缀猜对了', async () => {
    const h = harness()
    const bad = await h.app.fetch(
      new Request('http://entry/v1/wallet', { headers: { Authorization: 'Bearer nope' } }),
    )
    const wrong = await h.app.fetch(
      new Request('http://entry/v1/wallet', { headers: { Authorization: 'Bearer wst_unknown' } }),
    )
    expect(bad.status).toBe(wrong.status)
    expect(await bad.text()).toBe(await wrong.text())
  })

  it('没有 ai scope 的令牌打 /v1/ai/* 回 403 人话', async () => {
    const h = harness()
    const res = await h.app.fetch(chat({ model: 'deepseek-flash', messages: [] }, 'wst_no_ai'))
    expect(res.status).toBe(403)
    const body = (await res.json()) as { code: string; message: string; details: unknown }
    expect(body.code).toBe('forbidden')
    expect(body.message).toContain('ai')
    expect(body.details).toMatchObject({ required_scope: 'ai' })
    // 被挡住的请求一次上游都没打
    expect(h.calls).toHaveLength(0)
  })
})

describe('AI 转发与计量', () => {
  let h: Harness
  beforeEach(() => {
    h = harness()
    h.wallet.topup({ org_id: 'org_1', credits: 100, kind: 'purchased' })
  })

  it('非流式：按响应里的 usage 结算，记一条计量事件', async () => {
    const res = await h.app.fetch(
      chat({ model: 'deepseek-flash', messages: [{ role: 'user', content: '你好' }] }),
    )
    expect(res.status).toBe(200)

    const usage = h.wallet.usage({ org_id: 'org_1', group: 'capability' })
    expect(usage.rows).toHaveLength(1)
    expect(usage.rows[0]?.key).toBe('ai.chat')
    // 100 + 200 token → quantity 是 0.3 千 token
    expect(usage.rows[0]?.quantity).toBeCloseTo(0.3, 6)
    expect(usage.total_credits).toBeGreaterThan(0)
    // 预扣已经结清
    expect(h.wallet.balance('org_1').reserved).toBe(0)
  })

  it('内部密钥进的是出站的头，不进响应', async () => {
    const res = await h.app.fetch(
      chat({ model: 'deepseek-flash', messages: [{ role: 'user', content: '你好' }] }),
    )
    const headers = h.calls[0]?.init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer internal-key-never-leaves')
    expect(await res.text()).not.toContain('internal-key-never-leaves')
  })

  it('流式：边转发边找最后那个 usage，结算得跟非流式一样准', async () => {
    h.setUpstream(async () =>
      sse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: '好' } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: '的' } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 200 } })}\n\n`,
        'data: [DONE]\n\n',
      ]),
    )
    const res = await h.app.fetch(chat({ model: 'deepseek-flash', messages: [], stream: true }))
    expect(res.status).toBe(200)
    // 正文原样透传（前端还是拿到 SSE）
    const text = await res.text()
    expect(text).toContain('[DONE]')
    expect(text).toContain('"delta"')

    const usage = h.wallet.usage({ org_id: 'org_1', group: 'capability' })
    expect(usage.rows[0]?.quantity).toBeCloseTo(0.3, 6)
    expect(usage.total_credits).toBeGreaterThan(0)
  })

  it('流式出站会替用户带上 stream_options.include_usage——不带的话根本没有 usage 可结算', async () => {
    h.setUpstream(async () => sse(['data: [DONE]\n\n']))
    await h.app.fetch(chat({ model: 'deepseek-flash', messages: [], stream: true }))
    const sent = JSON.parse(String(h.calls[0]?.init.body)) as {
      stream_options?: { include_usage?: boolean }
    }
    expect(sent.stream_options?.include_usage).toBe(true)
  })

  it('上游出错：状态码原样透传，预扣整笔释放（一分不扣）', async () => {
    h.setUpstream(
      async () =>
        new Response(JSON.stringify({ error: { message: 'model not found' } }), { status: 404 }),
    )
    const res = await h.app.fetch(chat({ model: 'deepseek-flash', messages: [] }))
    expect(res.status).toBe(404)
    expect(await res.text()).toContain('model not found')
    const b = h.wallet.balance('org_1')
    expect(b.purchased).toBe(100)
    expect(b.reserved).toBe(0)
    expect(h.wallet.usage({ org_id: 'org_1', group: 'capability' }).rows).toEqual([])
  })

  it('/v1/ai/models 不扣积分', async () => {
    h.setUpstream(async () => Response.json({ object: 'list', data: [{ id: 'deepseek-flash' }] }))
    const res = await h.app.fetch(new Request('http://entry/v1/ai/models', { headers: auth() }))
    expect(res.status).toBe(200)
    expect(h.wallet.balance('org_1').purchased).toBe(100)
  })
})

describe('余额不足 402', () => {
  it('回 402 + 人话 + 够不够的两个数，而且一次上游都不打', async () => {
    const h = harness()
    h.wallet.topup({ org_id: 'org_1', credits: 0.0001, kind: 'purchased' })
    const res = await h.app.fetch(
      chat({
        model: 'gpt-6-astra',
        messages: [{ role: 'user', content: 'x'.repeat(40_000) }],
        max_tokens: 4000,
      }),
    )
    expect(res.status).toBe(402)
    const body = (await res.json()) as { code: string; message: string }
    expect(body.code).toBe('insufficient_credits')
    expect(body.message).toContain('积分不够了')
    expect(h.calls).toHaveLength(0)
  })

  it('只拒这一次不冻结：充上就能过', async () => {
    const h = harness()
    const call = () =>
      h.app.fetch(chat({ model: 'deepseek-flash', messages: [{ role: 'user', content: '你好' }] }))
    expect((await call()).status).toBe(402)
    h.wallet.topup({ org_id: 'org_1', credits: 100, kind: 'purchased' })
    expect((await call()).status).toBe(200)
  })
})

describe('数据驻留（22 §2）', () => {
  it('cn 的请求打境外模型：422 + 人话，一次上游都不打', async () => {
    const h = harness()
    h.wallet.topup({ org_id: 'org_1', credits: 100, kind: 'purchased' })
    const res = await h.app.fetch(
      new Request('http://entry/v1/ai/chat/completions', {
        method: 'POST',
        headers: { ...auth(), 'content-type': 'application/json', 'X-Agentsws-Region': 'cn' },
        body: JSON.stringify({ model: 'gpt-5-mini', messages: [] }),
      }),
    )
    expect(res.status).toBe(422)
    const body = (await res.json()) as { code: string; message: string }
    expect(body.code).toBe('residency_blocked')
    expect(body.message).toContain('数据不出境')
    expect(h.calls).toHaveLength(0)
  })

  it('cn 的请求打境内模型：照常放行', async () => {
    const h = harness()
    h.wallet.topup({ org_id: 'org_1', credits: 100, kind: 'purchased' })
    const res = await h.app.fetch(
      new Request('http://entry/v1/ai/chat/completions', {
        method: 'POST',
        headers: { ...auth(), 'content-type': 'application/json', 'X-Agentsws-Region': 'cn' },
        body: JSON.stringify({ model: 'deepseek-flash', messages: [] }),
      }),
    )
    expect(res.status).toBe(200)
  })

  it('/v1/ai/models 带 cn 时只列境内可用的', async () => {
    const h = harness()
    h.setUpstream(async () =>
      Response.json({ object: 'list', data: [{ id: 'deepseek-flash' }, { id: 'gpt-5-mini' }] }),
    )
    const res = await h.app.fetch(
      new Request('http://entry/v1/ai/models', {
        headers: { ...auth(), 'X-Agentsws-Region': 'cn' },
      }),
    )
    const body = (await res.json()) as { data: { id: string }[] }
    expect(body.data.map((m) => m.id)).toEqual(['deepseek-flash'])
  })
})

describe('钱包路由', () => {
  it('余额分两类，即将过期的列出来', async () => {
    const h = harness()
    h.wallet.topup({ org_id: 'org_1', credits: 100, kind: 'purchased' })
    h.wallet.topup({
      org_id: 'org_1',
      credits: 30,
      kind: 'granted',
      expires_at: '2026-10-01T00:00:00.000Z',
    })
    const res = await h.app.fetch(new Request('http://entry/v1/wallet', { headers: auth() }))
    const { data } = (await res.json()) as { data: Record<string, unknown> }
    expect(data).toMatchObject({ purchased: 100, granted: 30, available: 130, reserved: 0 })
    expect(data.expiring).toEqual([{ credits: 30, expires_at: '2026-10-01T00:00:00.000Z' }])
  })

  it('价目表端得出来，首批八条 + WP118 的两条订阅都在', async () => {
    const h = harness()
    const res = await h.app.fetch(
      new Request('http://entry/v1/wallet/pricing', { headers: auth() }),
    )
    const { data } = (await res.json()) as { data: { entries: { capability: string }[] } }
    expect(data.entries).toHaveLength(10)
    expect(data.entries.map((e) => e.capability)).toContain('ai.chat')
  })

  it('owner 看整个组织，成员只看自己工作区', async () => {
    const h = harness()
    h.wallet.topup({ org_id: 'org_1', credits: 100, kind: 'purchased' })
    for (const ws of ['ws_1', 'ws_2']) {
      const r = h.wallet.reserve({
        org_id: 'org_1',
        workspace_id: ws,
        capability: 'crawl.page',
        unit: 'page',
        quantity: 1,
        credits: 1,
        request_id: `req_${ws}`,
      })
      h.wallet.settle(r, { quantity: 1, credits: 1 })
    }
    const read = async (token: string) => {
      const res = await h.app.fetch(
        new Request('http://entry/v1/wallet/usage?group=workspace&from=2026-09-01T00:00:00.000Z', {
          headers: auth(token),
        }),
      )
      return (await res.json()) as { data: { rows: { key: string }[]; total_credits: number } }
    }
    expect((await read('wst_full')).data.rows.map((r) => r.key).sort()).toEqual(['ws_1', 'ws_2'])
    const member = await read('wst_member')
    expect(member.data.rows.map((r) => r.key)).toEqual(['ws_2'])
    expect(member.data.total_credits).toBe(1)
  })

  it('group 只认三个值', async () => {
    const h = harness()
    const res = await h.app.fetch(
      new Request('http://entry/v1/wallet/usage?group=nope', { headers: auth() }),
    )
    expect(res.status).toBe(400)
  })
})

describe('充值（Stripe）', () => {
  const signed = (
    payload: string,
    secret = WEBHOOK_SECRET,
    at = Math.floor(Date.parse(NOW) / 1000),
  ) => {
    const sig = createHmac('sha256', secret).update(`${at}.${payload}`).digest('hex')
    return `t=${at},v1=${sig}`
  }

  const paid = (session_id: string, credits: number) =>
    JSON.stringify({
      type: 'checkout.session.completed',
      data: {
        object: {
          id: session_id,
          payment_status: 'paid',
          metadata: { org_id: 'org_1', credits: String(credits) },
        },
      },
    })

  it('按档建单：US$50 一档收 50 美元、到账 350 积分（WP118 四档）', async () => {
    const h = harness()
    h.setUpstream(async () => Response.json({ id: 'cs_test_1', url: 'https://pay.invalid/cs_1' }))
    const res = await h.app.fetch(
      new Request('http://entry/v1/wallet/topup', {
        method: 'POST',
        headers: { ...auth(), 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'stripe', tier_id: 'usd50' }),
      }),
    )
    expect(res.status).toBe(201)
    const { data } = (await res.json()) as { data: Record<string, unknown> }
    expect(data).toMatchObject({
      provider: 'stripe',
      credits: 350,
      amount_usd: 50,
      tier_id: 'usd50',
      checkout_url: 'https://pay.invalid/cs_1',
      status: 'created',
    })
    const sent = String(h.calls[0]?.init.body)
    // 按美元收，不是"积分数 × 当日汇率"——后者会让同一张卡上的价钱每天变一点
    expect(sent).toContain('%5Bunit_amount%5D=5000')
    expect(sent).toContain('%5Bcurrency%5D=usd')
    // 支付渠道那边不需要知道我们的用户是谁：metadata 里只有组织号、积分数与档位
    expect(sent).toContain('metadata%5Borg_id%5D=org_1')
    expect(sent).not.toContain('account_id')
  })

  it('认不出的档位回一句人话，**不退到某个默认档**', async () => {
    const h = harness()
    const res = await h.app.fetch(
      new Request('http://entry/v1/wallet/topup', {
        method: 'POST',
        headers: { ...auth(), 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'stripe', tier_id: 'usd999' }),
      }),
    )
    expect(res.status).toBe(400)
    expect(h.calls).toHaveLength(0)
  })

  it('任意金额只剩 admin 走得通；普通令牌被劝回四张档位卡', async () => {
    const h = harness()
    h.setUpstream(async () => Response.json({ id: 'cs_test_2', url: 'https://pay.invalid/cs_2' }))
    const member = await h.app.fetch(
      new Request('http://entry/v1/wallet/topup', {
        method: 'POST',
        headers: { ...auth('wst_member'), 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'stripe', credits: 37 }),
      }),
    )
    expect(member.status).toBe(400)
    expect(String(((await member.json()) as { message: string }).message)).toContain('档位')

    const admin = await h.app.fetch(
      new Request('http://entry/v1/wallet/topup', {
        method: 'POST',
        headers: { ...auth(), 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'stripe', credits: 37 }),
      }),
    )
    expect(admin.status).toBe(201)
    // 老路按人民币收（1 积分 = ¥1）
    expect(String(h.calls[0]?.init.body)).toContain('%5Bcurrency%5D=cny')
  })

  it('四档端得出来，而且每一档的积分正好等于 usd × 7', async () => {
    const h = harness()
    const res = await h.app.fetch(
      new Request('http://entry/v1/wallet/topup/tiers', { headers: auth() }),
    )
    expect(res.status).toBe(200)
    const { data } = (await res.json()) as {
      data: { credits_per_usd: number; tiers: { usd: number; credits: number }[] }
    }
    expect(data.credits_per_usd).toBe(7)
    expect(data.tiers.map((t) => [t.usd, t.credits])).toEqual([
      [20, 140],
      [50, 350],
      [100, 700],
      [200, 1400],
    ])
  })

  it('微信 / 支付宝回一句人话，不是 500', async () => {
    const h = harness()
    for (const provider of ['wechat', 'alipay']) {
      const res = await h.app.fetch(
        new Request('http://entry/v1/wallet/topup', {
          method: 'POST',
          headers: { ...auth(), 'content-type': 'application/json' },
          body: JSON.stringify({ provider, credits: 100 }),
        }),
      )
      expect(res.status).toBe(501)
      const body = (await res.json()) as { code: string; message: string }
      expect(body.code).toBe('not_implemented')
      expect(body.message).toContain('Stripe')
    }
  })

  it('webhook 幂等：同一个 session_id 重投多少次都只入一次账', async () => {
    const h = harness()
    const payload = paid('cs_test_7', 300)
    const post = () =>
      h.app.fetch(
        new Request('http://entry/v1/wallet/topup/stripe/webhook', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'Stripe-Signature': signed(payload) },
          body: payload,
        }),
      )
    const first = (await (await post()).json()) as {
      data: { handled: boolean; duplicate: boolean }
    }
    expect(first.data).toMatchObject({ handled: true, duplicate: false })
    const again = (await (await post()).json()) as { data: { duplicate: boolean } }
    expect(again.data.duplicate).toBe(true)
    expect(h.wallet.balance('org_1').purchased).toBe(300)
  })

  it('签名对不上就不入账', async () => {
    const h = harness()
    const payload = paid('cs_test_8', 300)
    const res = await h.app.fetch(
      new Request('http://entry/v1/wallet/topup/stripe/webhook', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'Stripe-Signature': signed(payload, 'whsec_someone_elses_secret'),
        },
        body: payload,
      }),
    )
    expect(res.status).toBe(403)
    expect(h.wallet.balance('org_1').purchased).toBe(0)
  })

  it('签名太旧（重放）也不入账', async () => {
    const h = harness()
    const payload = paid('cs_test_9', 300)
    const res = await h.app.fetch(
      new Request('http://entry/v1/wallet/topup/stripe/webhook', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'Stripe-Signature': signed(
            payload,
            WEBHOOK_SECRET,
            Math.floor(Date.parse(NOW) / 1000) - 10_000,
          ),
        },
        body: payload,
      }),
    )
    expect(res.status).toBe(403)
    expect(h.wallet.balance('org_1').purchased).toBe(0)
  })

  it('不是 checkout.session.completed 的事件原样忽略', async () => {
    const h = harness()
    const payload = JSON.stringify({ type: 'payment_intent.created', data: { object: {} } })
    const res = await h.app.fetch(
      new Request('http://entry/v1/wallet/topup/stripe/webhook', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'Stripe-Signature': signed(payload) },
        body: payload,
      }),
    )
    const { data } = (await res.json()) as { data: { handled: boolean } }
    expect(data.handled).toBe(false)
  })
})
