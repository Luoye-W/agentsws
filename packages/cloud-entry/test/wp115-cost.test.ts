/**
 * WP115（65 §3）：AI 转发在结算处把成本会计那几列填进去。
 *
 * 两条要钉住：
 * - **进出 token 分开记**（只记合计就再也算不出输入输出的成本比）；
 * - **管理员自己的调用 `admin_exempt`**：不向他收积分，但**成本照记**——
 *   那笔钱我们确实付给了上游，只是不从他身上收。
 */

import type { MeteringEvent } from '@agentsws/contracts'
import { buildPricing, MemoryWalletStore, tokenCostMicros, Wallet } from '@agentsws/metering'
import { describe, expect, it } from 'vitest'
import { createEntryApp } from '../src/routes.js'
import type { EntryDeps, FetchLike } from '../src/types.js'

const NOW = '2026-09-18T12:00:00.000Z'

const TOKENS: Record<
  string,
  { account_id: string; org_id: string; workspace_id: string; scopes: string[] }
> = {
  wst_user: { account_id: 'acc_user', org_id: 'org_1', workspace_id: 'ws_1', scopes: ['ai'] },
  wst_staff: { account_id: 'acc_staff', org_id: 'org_1', workspace_id: 'ws_1', scopes: ['ai'] },
}

function harness(over: Partial<EntryDeps> = {}) {
  const events: MeteringEvent[] = []
  const store = new MemoryWalletStore()
  const original = store.appendEvent.bind(store)
  store.appendEvent = (e: MeteringEvent) => {
    events.push(e)
    original(e)
  }
  let seq = 0
  const wallet = new Wallet({
    store,
    now: () => NOW,
    newId: (prefix) => `${prefix}_${++seq}`,
  })
  const upstream: FetchLike = async () =>
    Response.json({
      id: 'chatcmpl-1',
      choices: [{ message: { role: 'assistant', content: '好的' } }],
      usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
    })
  const app = createEntryApp({
    verifier: async (token) => TOKENS[token],
    wallet,
    pricing: buildPricing(),
    upstream: { ai: { base_url: 'https://upstream.invalid/v1', api_key: () => 'k' } },
    fetch: upstream,
    now: () => NOW,
    newRequestId: () => 'req_1',
    ...over,
  })
  wallet.topup({ org_id: 'org_1', credits: 1000, kind: 'purchased', source_ref: 'seed' })
  return { app, wallet, events }
}

const chat = (app: ReturnType<typeof createEntryApp>, token: string, model: string) =>
  app.fetch(
    new Request('http://entry.test/v1/ai/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: '你好' }] }),
    }),
  )

describe('WP115 成本会计落点', () => {
  it('结算时填 provider / model / 进出 token / 我方成本 / charge_status', async () => {
    const h = harness()
    const res = await chat(h.app, 'wst_user', 'deepseek-flash')
    expect(res.status).toBe(200)
    expect(h.events).toHaveLength(1)
    const e = h.events[0]!
    expect(e.provider).toBe('deepseek')
    expect(e.model).toBe('deepseek-flash')
    expect(e.input_tokens).toBe(1000)
    expect(e.output_tokens).toBe(500)
    expect(e.charge_status).toBe('charged')
    expect(e.account_id).toBe('acc_user')
    expect(e.cost_currency).toBe('USD')
    // 成本与成本表算出来的一致（两边不该各算各的）
    expect(e.cost_micros).toBe(
      tokenCostMicros('deepseek-flash', { input_tokens: 1000, output_tokens: 500 }).micros,
    )
    // 收的积分远大于成本——这一行不该出现在亏本告警里
    expect((e.credits ?? 0) * 1_000_000).toBeGreaterThan(e.cost_micros ?? 0)
  })

  it('认不出的模型：provider 落成本表里最贵那一档的家，成本不为 0', async () => {
    const h = harness()
    await chat(h.app, 'wst_user', 'brand-new-model-2028')
    const e = h.events[0]!
    expect(e.cost_micros).toBeGreaterThan(0)
    expect(e.model).toBe('brand-new-model-2028')
  })

  it('管理员账号：admin_exempt，积分 0，但成本照记', async () => {
    const h = harness({ isExemptAccount: (id) => id === 'acc_staff' })
    await chat(h.app, 'wst_staff', 'deepseek-flash')
    const e = h.events[0]!
    expect(e.charge_status).toBe('admin_exempt')
    expect(e.credits).toBe(0)
    expect(e.cost_micros).toBeGreaterThan(0)
    // 余额一分没动
    expect(h.wallet.balance('org_1').purchased).toBe(1000)
  })

  it('costTable: null → 那一列留空（不是 0）：0 与「没算过」在毛利表上不是一回事', async () => {
    const h = harness({ costTable: null })
    await chat(h.app, 'wst_user', 'deepseek-flash')
    const e = h.events[0]!
    expect('cost_micros' in e).toBe(false)
    expect(e.provider).toBe('deepseek')
  })
})
