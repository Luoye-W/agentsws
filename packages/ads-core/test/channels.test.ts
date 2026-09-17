/**
 * WP75（57 §2）：四条适配器。
 *
 * **零真 key**：所有用例塞的是一个假 fetch 与一份假凭据。真正要钉住的是三件
 * "接上真账号之后再发现就晚了"的事：
 *
 * 1. **URL 与 body 的形状**（钱的单位、`updateMask`、`status: PAUSED` 而不是删）；
 * 2. **token 一个字节都不许漏到返回值 / 错误消息里**；
 * 3. **"还没接"与"连接失败"是两句不同的话**。
 */

import type { AdsPlatform } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  type AdsTransport,
  createAdsAdapters,
  createGoogleAdsAdapter,
  createMetaAdsAdapter,
  createTiktokAdsAdapter,
  createXAdsAdapter,
  fromMicros,
  fromMinor,
  normalizeCustomerId,
  toMicros,
  toMinor,
} from '../src/index.js'

const TOKEN = 'EAA-super-secret-token-should-never-leak'
const NOW = '2026-09-17T10:00:00Z'

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

function harness(options: {
  reply?: (url: string) => { ok: boolean; status: number; text: string }
  connected?: boolean
  credential?: Record<string, string>
}) {
  const calls: Call[] = []
  const transport: AdsTransport = {
    fetch: async (url, init) => {
      calls.push({
        url,
        method: init?.method ?? 'GET',
        headers: init?.headers ?? {},
        ...(init?.body === undefined ? {} : { body: init.body }),
      })
      const r = options.reply?.(url) ?? { ok: true, status: 200, text: '{}' }
      return { ok: r.ok, status: r.status, text: async () => r.text }
    },
    connected: () => options.connected ?? true,
    credential: async () => options.credential ?? { access_token: TOKEN },
    now: () => NOW,
  }
  return { calls, transport }
}

describe('钱的单位（接上真账号之后再发现就晚了）', () => {
  it('Meta 是「分」：一百块传出去是 10000', () => {
    expect(toMinor(100)).toBe(10_000)
    expect(fromMinor('10000')).toBe(100)
    expect(fromMinor(undefined)).toBeUndefined()
  })

  it('Google 是「微」：一百块传出去是 100000000', () => {
    expect(toMicros(100)).toBe(100_000_000)
    expect(fromMicros('100000000')).toBe(100)
  })

  it('Google 的客户 id 不带横杠', () => {
    expect(normalizeCustomerId('123-456-7890')).toBe('1234567890')
  })
})

describe('Meta Ads 适配器', () => {
  it('读 campaign：URL 形状对、token 在 header 上（不在 query 上）', async () => {
    const { calls, transport } = harness({
      reply: () => ({
        ok: true,
        status: 200,
        text: JSON.stringify({
          data: [{ id: '120', name: '九月桌面', status: 'ACTIVE', daily_budget: '10000' }],
        }),
      }),
    })
    const out = await createMetaAdsAdapter(transport).campaigns('act_1')
    expect(out.ok).toBe(true)
    if (!out.ok) return
    // 钱进来转成元
    expect(out.data[0]).toMatchObject({ external_id: '120', status: 'active', daily_budget: 100 })
    expect(calls[0]?.url).toContain('https://graph.facebook.com/v21.0/act_1/campaigns')
    expect(calls[0]?.url).not.toContain('access_token')
    expect(calls[0]?.headers.Authorization).toBe(`Bearer ${TOKEN}`)
  })

  it('新建 campaign：一律**先停着**（批的是"建一条"不是"现在开始花钱"），预算转成分', async () => {
    const { calls, transport } = harness({
      reply: () => ({ ok: true, status: 200, text: JSON.stringify({ id: '999' }) }),
    })
    const out = await createMetaAdsAdapter(transport).applyChange({
      kind: 'create_campaign',
      external_id: '',
      account_external_id: 'act_1',
      after: { name: '九月桌面', daily_budget: 150 },
      approval_id: 'ap_1',
    })
    expect(out.ok).toBe(true)
    const body = new URLSearchParams(calls[0]?.body ?? '')
    expect(body.get('status')).toBe('PAUSED')
    expect(body.get('daily_budget')).toBe('15000')
    expect(calls[0]?.method).toBe('POST')
  })

  it('暂停是 `status: PAUSED`，**不是 DELETE**（删掉连历史数据都带走）', async () => {
    const { calls, transport } = harness({})
    const out = await createMetaAdsAdapter(transport).applyChange({
      kind: 'pause_ad',
      external_id: '120',
      account_external_id: 'act_1',
      after: { reason: 'stop_loss' },
      approval_id: 'ap_2',
    })
    expect(out.ok).toBe(true)
    expect(calls[0]?.method).toBe('POST')
    expect(new URLSearchParams(calls[0]?.body ?? '').get('status')).toBe('PAUSED')
  })

  it('像素：24 小时没响过是 `stale`，从来没响过是 `missing`（去找谁修不一样）', async () => {
    const { transport } = harness({
      reply: () => ({
        ok: true,
        status: 200,
        text: JSON.stringify({
          data: [
            { id: '1', name: 'Purchase', last_fired_time: '2026-09-17T09:00:00Z' },
            { id: '2', name: 'AddToCart', last_fired_time: '2026-09-10T09:00:00Z' },
            { id: '3', name: 'Lead' },
          ],
        }),
      }),
    })
    const out = await createMetaAdsAdapter(transport).pixels('act_1')
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.data.map((p) => p.status)).toEqual(['healthy', 'stale', 'missing'])
  })

  it('没连上就**一跳都不打**，而且那句话是"去连接页"不是"出错了"', async () => {
    const { calls, transport } = harness({ connected: false })
    const out = await createMetaAdsAdapter(transport).accounts()
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toBe('not_connected')
    expect(calls).toHaveLength(0)
  })

  it('401 翻成 `needs_approval`，而且错误消息里**没有 token、没有 query**', async () => {
    const { transport } = harness({ reply: () => ({ ok: false, status: 401, text: TOKEN }) })
    const out = await createMetaAdsAdapter(transport).campaigns('act_1')
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toBe('needs_approval')
    expect(out.message).not.toContain(TOKEN)
    expect(out.message).not.toContain('fields=')
    expect(out.message).toContain('?…')
  })

  it('429 翻成 `rate_limited`，而且明说没有重试', async () => {
    const { transport } = harness({ reply: () => ({ ok: false, status: 429, text: '' }) })
    const out = await createMetaAdsAdapter(transport).campaigns('act_1')
    if (out.ok) return
    expect(out.reason).toBe('rate_limited')
    expect(out.message).toContain('没有重试')
  })
})

describe('Google Ads 适配器', () => {
  const cred = { access_token: TOKEN, developer_token: 'dev-123', customer_id: '123-456-7890' }

  it('缺 developer token 就**一跳都不打**，而且那句话指向 API Center 不是重连授权', async () => {
    const { calls, transport } = harness({ credential: { access_token: TOKEN, customer_id: '1' } })
    const out = await createGoogleAdsAdapter(transport).campaigns('1')
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toBe('needs_developer_token')
    expect(out.message).toContain('API Center')
    expect(calls).toHaveLength(0)
  })

  it('读走 GAQL（POST `searchStream`），三个头一起给', async () => {
    const { calls, transport } = harness({
      credential: { ...cred, login_customer_id: '999-888-7777' },
      reply: () => ({
        ok: true,
        status: 200,
        text: JSON.stringify([
          {
            results: [
              {
                campaign: { id: '55', name: '品牌词', status: 'ENABLED' },
                campaignBudget: { amountMicros: '100000000' },
              },
            ],
          },
        ]),
      }),
    })
    const out = await createGoogleAdsAdapter(transport).campaigns('123-456-7890')
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.data[0]).toMatchObject({ external_id: '55', status: 'active', daily_budget: 100 })
    expect(calls[0]?.url).toContain('/customers/1234567890/googleAds:searchStream')
    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.headers['developer-token']).toBe('dev-123')
    expect(calls[0]?.headers['login-customer-id']).toBe('9998887777')
    expect(calls[0]?.body).toContain('FROM campaign')
  })

  it('改预算：走 `campaignBudgets:mutate` 且**带 updateMask**（不带的话改了个寂寞还回 200）', async () => {
    const { calls, transport } = harness({
      credential: cred,
      reply: () => ({ ok: true, status: 200, text: JSON.stringify({ results: [{}] }) }),
    })
    const out = await createGoogleAdsAdapter(transport).applyChange({
      kind: 'budget_change',
      external_id: '55',
      account_external_id: '1234567890',
      after: { value: 250, budget_resource_name: 'customers/1234567890/campaignBudgets/7' },
      approval_id: 'ap_3',
    })
    expect(out.ok).toBe(true)
    expect(calls[0]?.url).toContain('campaignBudgets:mutate')
    const body = JSON.parse(calls[0]?.body ?? '{}')
    expect(body.operations[0].updateMask).toBe('amount_micros')
    expect(body.operations[0].update.amountMicros).toBe('250000000')
  })

  it('改预算少给预算资源名 → 说清"Google 这边预算是独立对象"，不瞎打一跳', async () => {
    const { calls, transport } = harness({ credential: cred })
    const out = await createGoogleAdsAdapter(transport).applyChange({
      kind: 'budget_change',
      external_id: '55',
      account_external_id: '1234567890',
      after: { value: 250 },
      approval_id: 'ap_4',
    })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.message).toContain('预算是独立对象')
    expect(calls).toHaveLength(0)
  })

  it('换文案：Google 不许就地改在跑的广告 —— 照实说，**不假装改了**', async () => {
    const { transport } = harness({ credential: cred })
    const out = await createGoogleAdsAdapter(transport).applyChange({
      kind: 'creative_swap',
      external_id: '55',
      account_external_id: '1234567890',
      after: { headline: '新标题' },
      approval_id: 'ap_5',
    })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toBe('not_implemented')
    expect(out.message).toContain('建一条新广告')
  })

  it('insights：ROAS 用它自己那两格算（它不给 ROAS），花费从「微」转回元', async () => {
    const { transport } = harness({
      credential: cred,
      reply: () => ({
        ok: true,
        status: 200,
        text: JSON.stringify([
          {
            results: [
              {
                campaign: { id: '55', name: '品牌词' },
                metrics: { costMicros: '100000000', conversionsValue: '400', conversions: '8' },
              },
            ],
          },
        ]),
      }),
    })
    const out = await createGoogleAdsAdapter(transport).insights({
      account_external_id: '1234567890',
      since: '2026-09-10',
      until: '2026-09-17',
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.data[0]?.metrics).toMatchObject({ spend: 100, conversion_value: 400, roas: 4 })
    expect(out.data[0]?.metrics.observed_at).toBe(NOW)
  })
})

describe('X / TikTok：还没接（57 §2）', () => {
  it('五个口子一律 `not_implemented`，而且说得清为什么', async () => {
    const { transport, calls } = harness({})
    const x = createXAdsAdapter(transport)
    const tt = createTiktokAdsAdapter(transport)
    expect(x.implemented).toBe(false)
    expect(tt.implemented).toBe(false)
    const a = await x.accounts()
    expect(a.ok).toBe(false)
    if (!a.ok) {
      expect(a.reason).toBe('not_implemented')
      expect(a.message).toContain('申请制')
    }
    const b = await tt.applyChange({
      kind: 'pause_ad',
      external_id: '1',
      account_external_id: '1',
      after: {},
      approval_id: 'ap',
    })
    expect(b.ok).toBe(false)
    if (!b.ok) expect(b.message).toContain('Business Center')
    // 一跳都没打
    expect(calls).toHaveLength(0)
  })

  it('"还没接"与"没连上"是两句不同的话（reason 不一样）', async () => {
    const { transport } = harness({ connected: false })
    const off = await createMetaAdsAdapter(transport).accounts()
    const todo = await createXAdsAdapter(transport).accounts()
    if (off.ok || todo.ok) throw new Error('该是失败')
    expect(off.reason).toBe('not_connected')
    expect(todo.reason).toBe('not_implemented')
  })
})

describe('createAdsAdapters', () => {
  it('四条齐了，顺序按契约那张表', () => {
    const { transport } = harness({})
    const all = createAdsAdapters(transport)
    expect(Object.keys(all)).toEqual(['meta', 'google', 'x', 'tiktok'])
    const implemented = (Object.keys(all) as AdsPlatform[]).filter((k) => all[k].implemented)
    expect(implemented).toEqual(['meta', 'google'])
  })
})
