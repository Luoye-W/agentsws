#!/usr/bin/env node
import { createEntryApp } from '@agentsws/cloud-entry'
import { buildPricing, MemoryWalletStore, Wallet } from '@agentsws/metering'
/**
 * 本地联调用的服务入口（49 M3）。
 *
 * **不是生产形态**——生产时这个包只是一堆路由，挂在云侧那个进程里（WP58 的
 * `apps/cloud`）。这里把它拼成一个能跑起来的最小壳：
 *
 * - 内存 verifier：一把写死的令牌 `wst_dev`（org_dev / ws_dev / 全 scope）；
 *   另有一把 `wst_dev_nowallet`（只有 `wallet`，没有 `ai`）用来验 403；
 * - 内存钱包：起手送 1000 积分（500 永不过期 + 500 三十天后清零，验"先扣有期限的"）；
 * - **假上游**：不打真的 New API，回一段固定的补全与 usage。
 *   所以跑它**不需要任何密钥**，也不会产生任何真实花费。
 *
 * 用法：
 *   node packages/cloud-entry/bin/dev.mjs            # 起在 4401
 *   PORT=4402 node packages/cloud-entry/bin/dev.mjs
 *
 * 试一下：
 *   curl -s localhost:4401/v1/wallet -H 'Authorization: Bearer wst_dev'
 *   curl -s localhost:4401/v1/ai/chat/completions -H 'Authorization: Bearer wst_dev' \
 *     -H 'content-type: application/json' \
 *     -d '{"model":"deepseek-flash","messages":[{"role":"user","content":"你好"}]}'
 */
import { serve } from '@hono/node-server'

const PORT = Number(process.env.PORT ?? 4401)
const DAY = 24 * 60 * 60 * 1000

/** 写死的两把令牌。真的签发在 WP58 那边，这里只为把中间件跑通。 */
const TOKENS = new Map([
  [
    'wst_dev',
    {
      account_id: 'acc_dev',
      org_id: 'org_dev',
      workspace_id: 'ws_dev',
      scopes: ['ai', 'wallet:read', 'wallet:topup', 'wallet:admin'],
    },
  ],
  [
    'wst_dev_nowallet',
    {
      account_id: 'acc_dev',
      org_id: 'org_dev',
      workspace_id: 'ws_dev',
      // 故意没有 'ai'：打 /v1/ai/* 应该 403
      scopes: ['wallet:read', 'wallet:topup'],
    },
  ],
])

let seq = 0
const wallet = new Wallet({
  store: new MemoryWalletStore(),
  now: () => new Date().toISOString(),
  newId: (prefix) => `${prefix}_${++seq}`,
  onEvent: (e) => {
    process.stdout.write(`[wallet] ${e.type} org=${e.org_id} available=${e.available}\n`)
  },
})
wallet.topup({ org_id: 'org_dev', credits: 500, kind: 'purchased' })
wallet.topup({
  org_id: 'org_dev',
  credits: 500,
  kind: 'granted',
  expires_at: new Date(Date.now() + 30 * DAY).toISOString(),
})

/** 假上游：不打真的 New API，所以这个脚本不需要任何密钥。 */
const fakeUpstream = async (url, init) => {
  if (url.endsWith('/models')) {
    return Response.json({
      object: 'list',
      data: [{ id: 'deepseek-flash' }, { id: 'gpt-5-mini' }],
    })
  }
  const body = JSON.parse(String(init.body ?? '{}'))
  /*
   * usage 按请求长度算，不是一个写死的 42。
   *
   * 写死的话钱包永远只动最后一位小数，界面上看着像坏了——而"预扣按估算、结算按
   * 真实 usage、差额退回"这条线恰恰只有在两个数字不一样的时候才看得出来。
   */
  const chars = JSON.stringify(body.messages ?? body.input ?? '').length
  const prompt_tokens = Math.max(16, Math.ceil(chars / 4))
  const completion_tokens = Math.max(8, Math.round(prompt_tokens / 3))
  const usage = {
    prompt_tokens,
    completion_tokens,
    total_tokens: prompt_tokens + completion_tokens,
  }
  if (body.stream === true) {
    const chunks = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: '你好，' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: '我是假上游。' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [], usage })}\n\n`,
      'data: [DONE]\n\n',
    ]
    const encoder = new TextEncoder()
    return new Response(
      new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
          controller.close()
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )
  }
  if (url.endsWith('/embeddings')) {
    return Response.json({ data: [{ embedding: [0.1, 0.2, 0.3] }], usage })
  }
  return Response.json({
    id: 'chatcmpl-dev',
    choices: [{ message: { role: 'assistant', content: '你好，我是假上游。' } }],
    usage,
  })
}

const app = createEntryApp({
  verifier: async (token) => TOKENS.get(token),
  wallet,
  pricing: buildPricing(),
  upstream: {
    ai: {
      base_url: 'https://fake-upstream.invalid/v1',
      // 假上游不看它；生产里这一把只从环境变量 AGENTSWS_NEWAPI_KEY 读
      api_key: () => process.env.AGENTSWS_NEWAPI_KEY ?? 'dev-not-a-real-key',
      region_map: { 'deepseek-flash': ['cn', 'global'], 'gpt-5-mini': ['global'] },
    },
  },
  fetch: fakeUpstream,
})

serve({ fetch: app.fetch, port: PORT }, (info) => {
  process.stdout.write(
    `服务入口（联调档）起在 http://localhost:${info.port}\n` +
      '  令牌：wst_dev（全 scope） / wst_dev_nowallet（没有 ai，打 /v1/ai/* 应该 403）\n' +
      '  上游是假的，不产生任何真实花费。\n',
  )
})
