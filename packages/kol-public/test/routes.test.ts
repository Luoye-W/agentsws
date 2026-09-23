/**
 * WP61 的九条纪律，一条一个测试（48 §5.3 / 49 M3-M4 / 21）：
 * 付费动作真扣钱且计量事件里没有正文、余额不足 402、插件配额 429、
 * 24h 重复观察不计奖励、日奖励封顶、基准不到 20 条不出数、
 * 数据驻留 cn 不走境外源、缺 `data` 动作集 403、邮箱库里只有哈希与密文。
 */

import type { KolChannel } from '@agentsws/contracts'
import {
  BENCHMARK_MIN_SAMPLES,
  KOL_LOOKUP_CAPABILITY,
  MAX_DAILY_REWARD_CREDITS,
  MAX_PLUGIN_OBSERVATIONS_PER_DAY,
  METERING_EVENT_FIELDS,
  METERING_EVENT_REQUIRED_FIELDS,
  OBSERVATIONS_PER_CREDIT,
} from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { createQuotaPool, createSourcePool, fakeYoutubeSource } from '../src/sources/index.js'
import type { KolSource, SourceSnapshot } from '../src/types.js'
import { auditableObservations, harness, observation } from './helpers.js'

const KEY = '/v1/data/kol/creators/youtube/somecreator'

/** 直接往库里塞一批观察（不经路由——路由那几条另有测试）。 */
function seed(h: ReturnType<typeof harness>, count: number, handlePrefix = 'creator'): void {
  for (let i = 0; i < count; i += 1) {
    h.service.contributeAs(
      {
        account_id: 'acc_1',
        org_id: 'org_1',
        workspace_id: 'ws_1',
        scopes: ['data'],
        region: 'global',
      },
      [
        observation({
          handle: `${handlePrefix}${String(i)}`,
          followers: 50_000 + i * 10,
          engagement_rate: 0.01 + i * 0.001,
        }),
      ],
    )
  }
}

describe('WP61 鉴权与动作集', () => {
  it('缺 data 动作集 403，令牌不认识 401（形状不对与验不过同一句话）', async () => {
    const h = harness({ scopes: ['ai', 'wallet:read'] })
    const forbidden = await h.call('/v1/data/kol/creators')
    expect(forbidden.status).toBe(403)
    expect(forbidden.body.code).toBe('forbidden')

    const ok = harness()
    const bad = await ok.call('/v1/data/kol/creators', { token: 'wst_nope' })
    const shaped = await ok.call('/v1/data/kol/creators', { token: 'nonsense' })
    expect(bad.status).toBe(401)
    expect(shaped.status).toBe(401)
    expect(bad.body.message).toBe(shaped.body.message)
  })
})

describe('WP61 计费', () => {
  it('reveal 扣 data.kol.lookup，计量事件只有八个字段、没有红人名字', async () => {
    const h = harness({ credits: 100 })
    h.service.contributeAs(
      {
        account_id: 'acc_1',
        org_id: 'org_1',
        workspace_id: 'ws_1',
        scopes: ['data'],
        region: 'global',
      },
      [observation()],
    )
    const saved = await h.call(`${KEY}/contact`, {
      method: 'POST',
      body: { email: 'Hi@Creator.com' },
    })
    expect(saved.status).toBe(201)

    const before = h.wallet.balance('org_1').available
    const revealed = await h.call(`${KEY}/reveal`, { method: 'POST' })
    expect(revealed.status).toBe(200)
    const data = revealed.body.data as { email: string; credits: number }
    expect(data.email).toBe('hi@creator.com')
    expect(data.credits).toBeGreaterThan(0)
    expect(h.wallet.balance('org_1').available).toBe(before - data.credits)

    const events = h.walletStore.events({ org_id: 'org_1' })
    const paid = events.filter((e) => e.credits > 0)
    expect(paid).toHaveLength(1)
    expect(paid[0]?.capability).toBe(KOL_LOOKUP_CAPABILITY)
    /*
     * WP115 之后白名单从八个扩到十六个（后八个是成本会计的可选列，见 65 §3）。
     * 这里钉的两件事一个字没变：**必填那八个都在**，**白名单之外一个键都没有**
     * ——"入口不存正文"靠的是后一条，而不是"总共只有八个"。
     */
    const allowed = new Set<string>(METERING_EVENT_FIELDS as readonly string[])
    for (const event of events) {
      for (const key of Object.keys(event)) expect(allowed.has(key), key).toBe(true)
      for (const key of METERING_EVENT_REQUIRED_FIELDS) expect(event[key], key).toBeDefined()
      expect(JSON.stringify(event)).not.toContain('somecreator')
      expect(JSON.stringify(event)).not.toContain('creator.com')
    }
  })

  it('余额不足回 402 一句人话，且不冻结（充值后同一条请求就过）', async () => {
    const h = harness({ credits: 0 })
    h.service.contributeAs(
      {
        account_id: 'acc_1',
        org_id: 'org_1',
        workspace_id: 'ws_1',
        scopes: ['data'],
        region: 'global',
      },
      auditableObservations(),
    )

    // 深度体检 3 积分，钱包里只有回填奖励那点（0）——不够
    const denied = await h.call(`${KEY}/deep-audit`, { method: 'POST' })
    expect(denied.status).toBe(402)
    expect(denied.body.code).toBe('insufficient_credits')
    expect(String(denied.body.message)).toContain('积分')
    // 只拒这一次不冻结：充了就能用
    h.wallet.topup({ org_id: 'org_1', credits: 10, kind: 'purchased' })
    const after = await h.call(`${KEY}/deep-audit`, { method: 'POST' })
    expect(after.status).toBe(200)
  })

  it('浏览 / 搜索按 data.kol.lookup 收；余额不够 402，充值后同一条就过', async () => {
    const h = harness({ credits: 0 })
    h.service.contributeAs(
      {
        account_id: 'acc_1',
        org_id: 'org_1',
        workspace_id: 'ws_1',
        scopes: ['data'],
        region: 'global',
      },
      [observation()],
    )
    const denied = await h.call('/v1/data/kol/creators?channel=youtube')
    expect(denied.status).toBe(402)
    expect(denied.body.code).toBe('insufficient_credits')
    expect(String(denied.body.message)).toContain('积分')
    // 只拒这一次不冻结：充了就能用，而且真扣了钱
    h.wallet.topup({ org_id: 'org_1', credits: 10, kind: 'purchased' })
    const listed = await h.call('/v1/data/kol/creators?channel=youtube')
    expect(listed.status).toBe(200)
    expect((listed.body.data as { credits: number }).credits).toBeGreaterThan(0)
  })
})

describe('WP61 插件配对与配额', () => {
  it('配对回一次明文，库里只有哈希；上报走插件令牌', async () => {
    const h = harness()
    const paired = await h.call('/v1/data/kol/plugins/pair', {
      method: 'POST',
      body: { label: 'Chrome' },
    })
    expect(paired.status).toBe(201)
    const { token, pairing } = paired.body.data as {
      token: string
      pairing: { token_sha256: string }
    }
    expect(token.startsWith('plg_')).toBe(true)
    expect(JSON.stringify(pairing)).not.toContain(token)
    expect(h.store.pairingBySha(pairing.token_sha256)?.token_sha256).toBe(pairing.token_sha256)

    const reported = await h.call('/v1/data/kol/plugins/observations', {
      method: 'POST',
      token,
      body: { observations: [observation()] },
    })
    expect(reported.status).toBe(201)
    expect((reported.body.data as { accepted: number }).accepted).toBe(1)

    // 工作区令牌打这条打不动（它不是插件）
    const wrongToken = await h.call('/v1/data/kol/plugins/observations', {
      method: 'POST',
      body: { observations: [observation()] },
    })
    expect(wrongToken.status).toBe(401)
  })

  it('插件日配额超了 429，说清楚还剩几条', async () => {
    const h = harness()
    const paired = await h.call('/v1/data/kol/plugins/pair', { method: 'POST', body: {} })
    const { token } = paired.body.data as { token: string }
    const subject = h.service.verifyPluginToken(token)
    expect(subject).toBeDefined()
    if (subject === undefined) return
    // 直接把今天的计数推到上限（报 500 条要跑很久，而配额判定与条数来源无关）
    h.store.putQuota({
      subject: subject.id,
      day: '2026-09-15',
      observations: MAX_PLUGIN_OBSERVATIONS_PER_DAY,
      reward_credits: 0,
      units: 0,
    })
    const over = await h.call('/v1/data/kol/plugins/observations', {
      method: 'POST',
      token,
      body: { observations: [observation()] },
    })
    expect(over.status).toBe(429)
    expect(String(over.body.message)).toContain('0 条')
  })

  it('带正文的观察整批拒（白名单多一个键就不收）', async () => {
    const h = harness()
    const rejected = await h.call('/v1/data/kol/plugins/pair', { method: 'POST', body: {} })
    const { token } = rejected.body.data as { token: string }
    const res = await h.call('/v1/data/kol/plugins/observations', {
      method: 'POST',
      token,
      body: {
        observations: [{ ...observation(), caption: '这是视频文案，绝对不该被收下' }],
      },
    })
    expect(res.status).toBe(400)
    expect(String(res.body.message)).toContain('caption')
  })
})

describe('WP61 贡献奖励风控', () => {
  const principal = {
    account_id: 'acc_1',
    org_id: 'org_1',
    workspace_id: 'ws_1',
    scopes: ['data'],
    region: 'global' as const,
  }

  it('同一个 handle 24 小时内重复观察不计奖励，过了 24 小时又算', () => {
    const h = harness()
    const first = h.service.contributeAs(principal, [observation()])
    expect(first.accepted).toBe(1)
    const again = h.service.contributeAs(principal, [observation()])
    expect(again.accepted).toBe(0)
    expect(again.rejected[0]?.count).toBe(1)
    // 两条都进库了（不算奖励 ≠ 不收）
    expect(h.store.observationsOf('youtube', 'somecreator')).toHaveLength(2)

    h.clock.advance(25 * 60 * 60 * 1000)
    const later = h.service.contributeAs(principal, [observation({ observed_at: h.clock.now() })])
    expect(later.accepted).toBe(1)
  })

  it('每 100 条有效观察换 1 积分（送的那一类，90 天到期）', () => {
    const h = harness()
    const observations = Array.from({ length: OBSERVATIONS_PER_CREDIT }, (_, i) =>
      observation({ handle: `creator${String(i)}` }),
    )
    const event = h.service.contributeAs(principal, observations)
    expect(event.accepted).toBe(OBSERVATIONS_PER_CREDIT)
    expect(event.credits_granted).toBe(1)
    const balance = h.wallet.balance('org_1')
    expect(balance.granted).toBe(1)
    expect(balance.purchased).toBe(0)
    // 送的那一类有期限（90 天到期清零）
    expect(balance.expiring).toHaveLength(1)
  })

  it('单日奖励封顶 5 积分，封顶之外的明天接着拿', async () => {
    const h = harness()
    seed(h, MAX_DAILY_REWARD_CREDITS)
    // 五条联系方式回填 = 5 积分，今天的奖励到顶
    for (let i = 0; i < MAX_DAILY_REWARD_CREDITS; i += 1) {
      const res = await h.call(`/v1/data/kol/creators/youtube/creator${String(i)}/contact`, {
        method: 'POST',
        body: { email: `c${String(i)}@creator.com` },
      })
      expect((res.body.data as { credits_granted: number }).credits_granted).toBe(1)
    }
    expect(h.wallet.balance('org_1').granted).toBe(MAX_DAILY_REWARD_CREDITS)

    // 再报满 100 条有效观察：该得 1 积分，但今天到顶了 —— 记着，不发
    const observations = Array.from({ length: OBSERVATIONS_PER_CREDIT }, (_, i) =>
      observation({ handle: `late${String(i)}` }),
    )
    const capped = h.service.contributeAs(principal, observations)
    expect(capped.credits_granted).toBe(0)
    expect(capped.daily_reward_remaining).toBe(0)
    expect(capped.rejected.some((r) => r.reason.includes('到顶'))).toBe(true)
    expect(h.wallet.balance('org_1').granted).toBe(MAX_DAILY_REWARD_CREDITS)

    // 第二天：昨天没发出去的那 1 积分还在（累计数只按真发的前进）
    h.clock.advance(24 * 60 * 60 * 1000)
    const next = h.service.contributeAs(principal, [
      observation({ handle: 'tomorrow', observed_at: h.clock.now() }),
    ])
    expect(next.credits_granted).toBe(1)
  })
})

describe('WP61 k-匿名基准', () => {
  it('桶里不到 20 条不出数，只说一句人话——而且不收钱（WP126 口径②）', async () => {
    const h = harness({ credits: 100 })
    seed(h, BENCHMARK_MIN_SAMPLES - 1)
    const thin = await h.call('/v1/data/kol/benchmarks?channel=youtube&followers_band=10k-100k')
    expect(thin.status).toBe(200)
    const thinData = thin.body.data as {
      insufficient_samples: boolean
      engagement_rate?: unknown
      note: string
      credits: number
    }
    expect(thinData.insufficient_samples).toBe(true)
    expect(thinData.engagement_rate).toBeUndefined()
    expect(thinData.note).toContain('20')
    expect(thinData.credits).toBe(0)
    expect(h.wallet.balance('org_1').available).toBe(100)
  })

  it('够 20 条只回分位数，不回任何个体——并且扣一次 lookup（WP126）', async () => {
    const h = harness({ credits: 100 })
    seed(h, BENCHMARK_MIN_SAMPLES)
    const before = h.wallet.balance('org_1').available
    const full = await h.call('/v1/data/kol/benchmarks?channel=youtube&followers=50000')
    const data = full.body.data as {
      insufficient_samples: boolean
      sample_size: number
      credits: number
      engagement_rate: { p25: number; p50: number; p75: number }
    }
    expect(data.insufficient_samples).toBe(false)
    expect(data.credits).toBeGreaterThan(0)
    expect(h.wallet.balance('org_1').available).toBeLessThan(before)
    expect(data.sample_size).toBe(BENCHMARK_MIN_SAMPLES)
    expect(Object.keys(data.engagement_rate).sort()).toEqual(['p25', 'p50', 'p75'])
    expect(JSON.stringify(data)).not.toContain('creator0')
  })
})

describe('WP61 数据驻留', () => {
  const snapshot: SourceSnapshot = {
    ...observation({ handle: 'fresh', followers: 88_000 }),
    email: 'fresh@creator.com',
  }

  it('X-Agentsws-Region: cn 一个境外源都不走，且不扣积分', async () => {
    let called = 0
    const h = harness({ credits: 100 })
    const youtube = fakeYoutubeSource([snapshot])
    const counting: KolSource = {
      ...youtube,
      fetch: (key: { channel: KolChannel; handle: string }) => {
        called += 1
        return youtube.fetch(key)
      },
    }
    const cn = harness({
      credits: 100,
      sources: createSourcePool({
        youtube: counting,
        quota: createQuotaPool({ store: h.store }),
      }),
    })
    const res = await cn.call('/v1/data/kol/creators/youtube/fresh/refresh', {
      method: 'POST',
      region: 'cn',
    })
    expect(res.status).toBe(200)
    const data = res.body.data as { refreshed: boolean; reason: string; credits: number }
    expect(data.refreshed).toBe(false)
    expect(data.reason).toBe('residency')
    expect(called).toBe(0)
    expect(cn.wallet.balance('org_1').available).toBe(100)
  })

  it('不带驻留头就走官方口，扣一次 social.fetch，并把顺手抓到的邮箱存成哈希 + 密文', async () => {
    const base = harness()
    const h = harness({
      credits: 100,
      sources: createSourcePool({
        youtube: fakeYoutubeSource([snapshot]),
        quota: createQuotaPool({ store: base.store }),
      }),
    })
    const res = await h.call('/v1/data/kol/creators/youtube/fresh/refresh', { method: 'POST' })
    expect(res.status).toBe(200)
    const data = res.body.data as { refreshed: boolean; credits: number }
    expect(data.refreshed).toBe(true)
    expect(data.credits).toBeGreaterThan(0)
    const events = h.walletStore.events({ org_id: 'org_1' })
    expect(events.some((e) => e.capability === 'social.fetch' && e.credits > 0)).toBe(true)
    const contact = h.store.contactOf('youtube', 'fresh')
    expect(contact?.email_sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(contact)).not.toContain('fresh@creator.com')
  })

  it('YouTube 配额耗尽自动走降级；没有降级源就一句"今天配额用完了"', async () => {
    const base = harness()
    const quota = createQuotaPool({ store: base.store, unitsPerDay: 1 })
    const noFallback = harness({
      credits: 100,
      sources: createSourcePool({ youtube: fakeYoutubeSource([snapshot]), quota }),
    })
    const res = await noFallback.call('/v1/data/kol/creators/youtube/fresh/refresh', {
      method: 'POST',
    })
    const data = res.body.data as { refreshed: boolean; reason: string; credits: number }
    expect(data.refreshed).toBe(false)
    expect(data.reason).toBe('quota_exhausted')
    expect(data.credits).toBe(0)
    expect(noFallback.wallet.balance('org_1').available).toBe(100)

    const withFallback = harness({
      credits: 100,
      sources: createSourcePool({
        youtube: fakeYoutubeSource([snapshot]),
        apify: fakeYoutubeSource([snapshot]),
        quota: createQuotaPool({ store: base.store, unitsPerDay: 1 }),
      }),
    })
    const fell = await withFallback.call('/v1/data/kol/creators/youtube/fresh/refresh', {
      method: 'POST',
    })
    expect((fell.body.data as { refreshed: boolean }).refreshed).toBe(true)
  })
})

describe('WP61 邮箱与争议', () => {
  it('库里只有哈希与密文，明文只在 reveal 那一次响应里出现', async () => {
    const h = harness({ credits: 100 })
    h.service.contributeAs(
      {
        account_id: 'acc_1',
        org_id: 'org_1',
        workspace_id: 'ws_1',
        scopes: ['data'],
        region: 'global',
      },
      [observation()],
    )
    await h.call(`${KEY}/contact`, { method: 'POST', body: { email: 'hi@creator.com' } })
    const contact = h.store.contactOf('youtube', 'somecreator')
    expect(contact).toBeDefined()
    expect(Object.keys(contact ?? {})).not.toContain('email')
    expect(JSON.stringify(contact)).not.toContain('hi@creator.com')
    expect(h.secrets.decrypt(contact?.email_cipher ?? '')).toBe('hi@creator.com')

    // 浏览回的卡上只有"有没有"
    const listed = await h.call('/v1/data/kol/creators')
    const creators = (listed.body.data as { creators: { has_contact: boolean }[] }).creators
    expect(creators[0]?.has_contact).toBe(true)
    expect(JSON.stringify(creators)).not.toContain('hi@creator.com')
  })

  it('同一条联系方式回填第二次不再发奖励', async () => {
    const h = harness()
    h.service.contributeAs(
      {
        account_id: 'acc_1',
        org_id: 'org_1',
        workspace_id: 'ws_1',
        scopes: ['data'],
        region: 'global',
      },
      [observation()],
    )
    const first = await h.call(`${KEY}/contact`, {
      method: 'POST',
      body: { email: 'hi@creator.com' },
    })
    const second = await h.call(`${KEY}/contact`, {
      method: 'POST',
      body: { email: 'HI@creator.com' },
    })
    expect((first.body.data as { credits_granted: number }).credits_granted).toBe(1)
    expect((second.body.data as { credits_granted: number }).credits_granted).toBe(0)
  })

  it('争议只记不裁：数据不动，状态是 open', async () => {
    const h = harness()
    h.service.contributeAs(
      {
        account_id: 'acc_1',
        org_id: 'org_1',
        workspace_id: 'ws_1',
        scopes: ['data'],
        region: 'global',
      },
      [observation()],
    )
    const before = h.store.creator('youtube', 'somecreator')
    const res = await h.call(`${KEY}/disputes`, {
      method: 'POST',
      body: { field: 'followers', claim: '粉丝数比库里高很多' },
    })
    expect(res.status).toBe(201)
    expect((res.body.data as { dispute: { status: string } }).dispute.status).toBe('open')
    expect(h.store.creator('youtube', 'somecreator')).toEqual(before)
    expect(h.store.disputesOf('youtube', 'somecreator')).toHaveLength(1)
  })
})

describe('WP61 体检报告', () => {
  const principal = {
    account_id: 'acc_1',
    org_id: 'org_1',
    workspace_id: 'ws_1',
    scopes: ['data'],
    region: 'global' as const,
  }

  it('样本不够就明说，不给编出来的估计值——而且这次不收（WP129，与 0 条不收钱同口径）', async () => {
    const h = harness({ credits: 100 })
    h.service.contributeAs(principal, [observation()])
    const res = await h.call(`${KEY}/audit`)
    const report = res.body.data as {
      insufficient_samples: boolean
      follower_authenticity?: number
      note: string
      credits: number
    }
    expect(report.insufficient_samples).toBe(true)
    expect(report.follower_authenticity).toBeUndefined()
    expect(report.note).toContain('样本不够')
    expect(report.note).toContain('这次不收')
    expect(report.credits).toBe(0)
    expect(h.wallet.balance('org_1').available).toBe(100)
  })

  it('体检报告付费（WP126 起 GET audit 与 POST deep-audit 同价，都扣 data.kol.audit）', async () => {
    const h = harness({ credits: 100 })
    h.service.contributeAs(principal, auditableObservations())
    const before = h.wallet.balance('org_1').available
    const basic = await h.call(`${KEY}/audit`)
    expect(basic.status).toBe(200)
    expect(h.wallet.balance('org_1').available).toBeLessThan(before)
    const deep = await h.call(`${KEY}/deep-audit`, { method: 'POST' })
    expect(deep.status).toBe(200)
    expect((deep.body.data as { depth: string }).depth).toBe('deep')
    expect(h.wallet.balance('org_1').available).toBeLessThan(before)
  })
})
