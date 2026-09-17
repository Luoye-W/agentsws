/**
 * WP75（57 §5）广告库的 `/v1` 面，端到端（起真进程 → 打 HTTP → 过真 guardrail）。
 *
 * 钉的是 04 §5 那条额度纪律的**五句机器判据**，一句一组：
 *
 * 1. **开花钱口子永远 L1**：报什么等级，新建 campaign 都落回人审。
 * 2. **总闸满了新开口子直接拦**：不是"人点一下就过"——那等于把今天的预算上限
 *    就地作废。而且拦下来那句话里带着数。
 * 3. **额度内调整自己走，超了升 L1**：提预算 +10% 与 +30% 是两种结果。
 * 4. **止损要名副其实**：报 `stop_loss` 但 ROAS 与花费不成立的转人审。
 * 5. **广告文案里不许有承诺**：命中当场 block，不给"点一下就发出去"的路径。
 *
 * 外加两件：写动作**一条都不直接改库**（提完之后库里那条还是原样），
 * 以及**每张卡上都有总闸剩余**（人点头之前要看得见今天还能花多少）。
 */
import type { Assignment } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'

const T0 = '2026-09-17T09:00:00.000Z'
const SECRETS_KEY = 'e'.repeat(64)

function makeClock(start = T0) {
  let t = Date.parse(start)
  return {
    now: () => new Date(t).toISOString(),
    advance: (ms: number) => {
      t += ms
    },
  }
}

function seeded(seed = 75): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

let server: Server
let url: string
/** Meta 那条投放职责。 */
let meta: Assignment
/** 一条**不是**投放的职责：广告库这一面对它不该开。 */
let support: Assignment

const api = async (
  path: string,
  init: RequestInit & { assignment?: string } = {},
): Promise<Response> => {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${server.bootstrap.internalToken}`)
  headers.set('X-Assignment', init.assignment ?? meta.id)
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  return fetch(`${url}${path}`, { ...init, headers })
}

const post = (path: string, body: unknown, assignment?: string): Promise<Response> =>
  api(path, {
    method: 'POST',
    body: JSON.stringify(body),
    ...(assignment === undefined ? {} : { assignment }),
  })

const data = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data

interface Staged {
  staged: boolean
  level?: string
  message?: string
  approval_item_id?: string
  spend_gate?: { spent: number; cap: number; remaining: number; note: string }
}

/** 直接往这个品牌的广告库里放几行（真环境里这几行是拉数那一跳写回来的）。 */
async function seed(options: { spend?: number; roas?: number; dailyBudget?: number } = {}) {
  const brand = await server.brands.forWorkspace(server.bootstrap.workspace.id)
  const ws = server.bootstrap.workspace.id
  brand.ads.saveAccount({
    id: 'aa_1',
    workspace_id: ws,
    platform: 'meta',
    external_id: 'act_1',
    name: '测试广告账户',
    currency: 'CNY',
    status: 'active',
    observed_at: T0,
  })
  brand.ads.saveCampaign({
    id: 'cmp_1',
    account_id: 'aa_1',
    platform: 'meta',
    external_id: '120000001',
    name: '九月桌面收纳',
    status: 'active',
    daily_budget: options.dailyBudget ?? 1000,
    metrics: {
      spend: options.spend ?? 100,
      ...(options.roas === undefined ? {} : { roas: options.roas }),
      observed_at: T0,
    },
  })
  brand.ads.saveAdSet({
    id: 'as_1',
    campaign_id: 'cmp_1',
    account_id: 'aa_1',
    platform: 'meta',
    external_id: '1230001',
    name: '泛投',
    status: 'active',
    bid_amount: 2,
  })
  brand.ads.saveAd({
    id: 'ad_1',
    ad_set_id: 'as_1',
    campaign_id: 'cmp_1',
    account_id: 'aa_1',
    platform: 'meta',
    external_id: '4560001',
    name: '方图 A',
    status: 'active',
    headline: '一格放下所有线',
    primary_text: '三档可调的桌面收纳，线材一次收齐。',
  })
  return brand
}

beforeEach(async () => {
  const clock = makeClock()
  server = await createServer({
    quiet: true,
    clock: { now: () => clock.now() },
    random: seeded(),
    scheduleIntervalMs: 0,
    startRun: false,
    env: { AGENTSWS_OWNER_EMAIL: 'luoye@example.com', AGENTSWS_SECRETS_KEY: SECRETS_KEY },
  })
  ;({ url } = await server.listen(0))
  const base = {
    person_id: server.bootstrap.person.id,
    workspace_id: server.bootstrap.workspace.id,
    granted_by: server.bootstrap.person.id,
    ranges: [{ kind: 'store' as const, id: 'store_1' }],
  }
  meta = server.roles.assignments.create({ ...base, role_id: 'ads.meta' })
  support = server.roles.assignments.create({ ...base, role_id: 'dtc.support' })
})

afterEach(async () => {
  await server.close()
})

describe('WP75 广告库路由：库有门了', () => {
  it('账户与 campaign 读得到；按平台筛只看自己那个', async () => {
    await seed()
    const all = await data<{ rows: { id: string }[] }>(await api('/v1/ads/accounts'))
    expect(all.rows.map((r) => r.id)).toContain('aa_1')
    const google = await data<{ rows: unknown[] }>(await api('/v1/ads/accounts?platform=google'))
    // 四个平台之间零共享：Meta 那个账户不该出现在 Google 的清单里
    expect(google.rows).toHaveLength(0)
  })

  it('campaign 清单上带账户名（表格上要认得出是哪个计费主体）', async () => {
    await seed()
    const rows = await data<{ rows: { account_name: string }[] }>(await api('/v1/ads/campaigns'))
    expect(rows.rows[0]?.account_name).toBe('测试广告账户')
  })

  it('不认识的平台名回 400 + 一句人话，不是空清单', async () => {
    await seed()
    const res = await api('/v1/ads/accounts?platform=pinterest')
    expect(res.status).toBe(400)
  })

  it('客服那条职责**打不开**广告库（它的 scopes 里没有 `ad_account`）', async () => {
    await seed()
    const res = await api('/v1/ads/accounts', { assignment: support.id })
    expect(res.status).toBe(403)
  })
})

describe('04 §5 ① 开花钱口子永远 L1', () => {
  it('新建 campaign 落回人审，而且卡上写着预算与受众', async () => {
    await seed()
    const out = await data<Staged>(
      await post('/v1/ads/campaigns', {
        account_id: 'aa_1',
        name: '十月新品',
        daily_budget: 200,
        audience_summary: '25-44 岁，居家办公兴趣',
      }),
    )
    expect(out.staged).toBe(true)
    expect(out.level).toBe('L1')
    const item = await server.txn.approvals.get(out.approval_item_id ?? '')
    expect(item?.automation.auto_approved).toBe(false)
    expect(item?.summary).toContain('200')
    expect(item?.summary).toContain('居家办公')
  })

  it('**一条都没直接改库**：提完之后库里还是原来那几条 campaign', async () => {
    const brand = await seed()
    const before = brand.ads.campaigns().length
    await post('/v1/ads/campaigns', { account_id: 'aa_1', name: '十月新品', daily_budget: 200 })
    expect(brand.ads.campaigns().length).toBe(before)
  })
})

describe('04 §5 ② 总闸满了新开口子直接拦', () => {
  it('今天已经花到 980，再开一条日预算 200 的 → **block**，而且话里带着数', async () => {
    await seed({ spend: 980 })
    const out = await data<Staged>(
      await post('/v1/ads/campaigns', { account_id: 'aa_1', name: '十月新品', daily_budget: 200 }),
    )
    expect(out.staged).toBe(false)
    expect(out.message).toContain('max_daily_spend')
    // 拦下来也要把总闸那一格给出来：人要知道差多少
    expect(out.spend_gate?.spent).toBe(980)
    expect(out.spend_gate?.cap).toBe(1000)
  })

  it('总闸还开着的时候照常提上去（只是要人点一下）', async () => {
    await seed({ spend: 100 })
    const out = await data<Staged>(
      await post('/v1/ads/campaigns', { account_id: 'aa_1', name: '十月新品', daily_budget: 200 }),
    )
    expect(out.staged).toBe(true)
  })
})

describe('04 §5 ③ 额度内调整 L2、超了升 L1', () => {
  it('提预算 +10% 在额度里（`max_budget_delta_pct` 20）', async () => {
    await seed({ spend: 100, dailyBudget: 1000 })
    const out = await data<Staged>(await post('/v1/ads/campaigns/cmp_1/budget', { value: 1100 }))
    expect(out.staged).toBe(true)
    const item = await server.txn.approvals.get(out.approval_item_id ?? '')
    expect(item?.automation.mandate_check.caps_hit ?? []).not.toContain('max_budget_delta_pct')
  })

  it('提预算 +30% 超了 → 卡上记着那条 cap（升 L1）', async () => {
    await seed({ spend: 100, dailyBudget: 1000 })
    const out = await data<Staged>(await post('/v1/ads/campaigns/cmp_1/budget', { value: 1300 }))
    expect(out.staged).toBe(true)
    const item = await server.txn.approvals.get(out.approval_item_id ?? '')
    expect(item?.automation.auto_approved).toBe(false)
    expect(item?.automation.mandate_check.caps_hit ?? []).toContain('max_budget_delta_pct')
  })

  it('**调低**预算不被额度卡（04 §5：减少花钱的动作从宽），卡上也这么写', async () => {
    await seed({ spend: 100, dailyBudget: 1000 })
    const out = await data<Staged>(await post('/v1/ads/campaigns/cmp_1/budget', { value: 200 }))
    expect(out.staged).toBe(true)
    const item = await server.txn.approvals.get(out.approval_item_id ?? '')
    // 幅度是 80%，超了额度所以照样要人点；但总闸那条不该响
    expect(item?.automation.mandate_check.caps_hit ?? []).not.toContain('max_daily_spend')
  })

  it('改出价超 15% → 卡上记着 `max_bid_delta_pct`', async () => {
    await seed()
    const out = await data<Staged>(await post('/v1/ads/campaigns/cmp_1/bid', { value: 2.6 }))
    const item = await server.txn.approvals.get(out.approval_item_id ?? '')
    expect(item?.automation.mandate_check.caps_hit ?? []).toContain('max_bid_delta_pct')
  })
})

describe('04 §5 ④ 止损要名副其实', () => {
  it('真的止损（ROAS 0.6、花了 400 / 日预算 1000）→ 自己走，卡面上是**判据**不是"止损"', async () => {
    await seed({ spend: 400, roas: 0.6, dailyBudget: 1000 })
    const out = await data<Staged>(
      await post('/v1/ads/campaigns/cmp_1/pause', { reason: 'stop_loss' }),
    )
    expect(out.staged).toBe(true)
    const item = await server.txn.approvals.get(out.approval_item_id ?? '')
    expect(item?.automation.auto_approved).toBe(true)
    expect(item?.summary).toContain('ROAS 0.6')
    expect(item?.summary).toContain('40%')
  })

  it('写着止损但 ROAS 还好（4.2）→ 转人审，卡上记着 `stop_loss_conditions_unmet`', async () => {
    await seed({ spend: 400, roas: 4.2, dailyBudget: 1000 })
    const out = await data<Staged>(
      await post('/v1/ads/campaigns/cmp_1/pause', { reason: 'stop_loss' }),
    )
    expect(out.staged).toBe(true)
    const item = await server.txn.approvals.get(out.approval_item_id ?? '')
    expect(item?.automation.auto_approved).toBe(false)
    expect(item?.automation.mandate_check.caps_hit ?? []).toContain('stop_loss_conditions_unmet')
  })

  it('理由必须在那一组里（写别的当场 400，不是悄悄按"止损"办）', async () => {
    await seed()
    const res = await post('/v1/ads/campaigns/cmp_1/pause', { reason: '我想停' })
    expect(res.status).toBe(400)
  })
})

describe('04 §5 ⑤ 广告文案里不许有承诺', () => {
  it('效果保证 → **block**，不给"点一下就发出去"的路径', async () => {
    await seed()
    const out = await data<Staged>(
      await post('/v1/ads/ads/ad_1/creative', { primary_text: '投了就保证出单，无效退款。' }),
    )
    expect(out.staged).toBe(false)
    expect(out.message).toContain('ad_copy_commitment')
  })

  it('极限词（广告法第九条）→ block', async () => {
    await seed()
    const out = await data<Staged>(
      await post('/v1/ads/ads/ad_1/creative', { headline: '全网最低价' }),
    )
    expect(out.staged).toBe(false)
  })

  it('干净的新文案照常提上去', async () => {
    await seed()
    const out = await data<Staged>(
      await post('/v1/ads/ads/ad_1/creative', { primary_text: '三档可调，桌面一次收齐。' }),
    )
    expect(out.staged).toBe(true)
  })
})

describe('每张卡上都有总闸剩余（04 §5）', () => {
  it('新建 / 改预算 / 暂停 / 换素材四张卡都带 `spend_gate`，而且摘要里也有那句话', async () => {
    await seed({ spend: 300, roas: 0.5, dailyBudget: 1000 })
    const calls: Promise<Response>[] = [
      post('/v1/ads/campaigns', { account_id: 'aa_1', name: 'x', daily_budget: 50 }),
      post('/v1/ads/campaigns/cmp_1/budget', { value: 1050 }),
      post('/v1/ads/campaigns/cmp_1/pause', { reason: 'creative_fatigue' }),
      post('/v1/ads/ads/ad_1/creative', { primary_text: '换一版更短的文案。' }),
    ]
    for (const call of calls) {
      const out = await data<Staged>(await call)
      expect(out.spend_gate?.cap).toBe(1000)
      expect(out.spend_gate?.note).toContain('总闸')
      if (out.approval_item_id !== undefined)
        expect((await server.txn.approvals.get(out.approval_item_id))?.summary).toContain('总闸')
    }
  })
})
