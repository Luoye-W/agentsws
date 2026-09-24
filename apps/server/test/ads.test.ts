/**
 * WP75（57 §1 / §3 / §5）：广告库、面板投影、四张连接卡、记录源那两类对象。
 *
 * 四组断言分别钉住四件事：
 * 1. 库按平台切得开（四个平台是四个独立的计费主体，串了就是花错钱）；
 * 2. **总闸按岗位聚合**，而且"哪个平台还没拉到数"说得出来；
 * 3. 投影里**没有**编出来的数（拿不到的一律没有那一格，不补 0）；
 * 4. 目录里那四张卡与契约那张平台表一个字不差，且准备说明里先说代价。
 */
import { ADS_PLATFORMS } from '@agentsws/contracts'
import { ALL_DATA_SOURCES, dataSourcesOfService } from '@agentsws/deck'
import { describe, expect, it } from 'vitest'
import { adsDeckData, adsPixelAlerts, createAdsStore, seedDemoAds } from '../src/ads.js'
import { CATALOG, catalogEntry } from '../src/catalog.js'

const NOW = '2026-09-17T09:00:00.000Z'
const store = () => {
  const s = createAdsStore({ workspace_id: 'ws_test' })
  seedDemoAds(s, NOW)
  return s
}

describe('57 §5 广告库（五类对象）', () => {
  it('按平台切得开：Meta 那条职责看不见 Google 的 campaign', () => {
    const s = store()
    expect(s.accounts({ platform: 'meta' }).map((a) => a.id)).toEqual(['aa_demo_meta'])
    expect(s.campaigns({ platform: 'meta' }).every((c) => c.platform === 'meta')).toBe(true)
    expect(s.campaigns({ platform: 'google' }).length).toBeGreaterThan(0)
    // 四个平台之间零共享：两边加起来才是全部
    expect(
      s.campaigns({ platform: 'meta' }).length + s.campaigns({ platform: 'google' }).length,
    ).toBe(s.campaigns().length)
  })

  it('止损记录不会混进 campaign 清单里（它借同一张表存，但不是一条 campaign）', () => {
    const s = store()
    expect(s.stopLosses().length).toBe(1)
    expect(s.campaigns().every((c) => !c.id.startsWith('stoploss:'))).toBe(true)
  })

  it('回填表现：campaign 不在就什么也不做（不凭空建一条只有数字的 campaign）', () => {
    const s = store()
    s.recordMetrics({ campaign_id: 'cmp_nope', metrics: { spend: 9, observed_at: NOW } })
    expect(s.campaign('cmp_nope')).toBeUndefined()
    s.recordMetrics({ campaign_id: 'cmp_demo_google_1', metrics: { spend: 150, observed_at: NOW } })
    expect(s.campaign('cmp_demo_google_1')?.metrics?.spend).toBe(150)
  })
})

describe('04 §5 岗位级日花费总闸', () => {
  it('**四个平台加起来**，不是各算各的', () => {
    const gate = store().spendToday()
    // 400（Meta 泛投）+ 180（Meta 再营销）+ 120（Google 品牌词）
    expect(gate.spent).toBe(700)
    const meta = gate.by_platform.find((r) => r.platform === 'meta')?.spend
    const google = gate.by_platform.find((r) => r.platform === 'google')?.spend
    expect(meta).toBe(580)
    expect(google).toBe(120)
  })

  it('哪个平台今天还没拉到数，**说得出来**（不说就等于谎报宽裕）', () => {
    const gate = store().spendToday()
    // demo 里只有 Meta 与 Google 两个账户；X / TikTok 一条数都没有
    expect(gate.missing).toContain('x')
    expect(gate.missing).toContain('tiktok')
    expect(gate.missing).not.toContain('meta')
  })

  it('**币种不一致就不报币种**：总闸是一个数，而账户是多币种的', () => {
    const s = createAdsStore({ workspace_id: 'ws_test' })
    seedDemoAds(s, NOW)
    expect(s.spendToday().currency).toBe('USD')
    const google = s.account('aa_demo_google')
    if (google === undefined) throw new Error('账户没了')
    s.saveAccount({ ...google, currency: 'CNY' })
    // 700 还是 700，但它不再是任何一种货币里的 700——所以那一格空着
    expect(s.spendToday().spent).toBe(700)
    expect(s.spendToday().currency).toBeUndefined()
  })

  it('账户上直接有 `spend_today` 时优先用它（拉数那一跳写回来的那一格）', () => {
    const s = store()
    const account = s.account('aa_demo_meta')
    if (account === undefined) throw new Error('账户没了')
    s.saveAccount({ ...account, spend_today: 999 })
    const gate = s.spendToday()
    expect(gate.by_platform.find((r) => r.platform === 'meta')?.spend).toBe(999)
  })
})

describe('57 §3 面板投影：数字不编、总闸不夹', () => {
  const deck = () => adsDeckData(store(), { now: NOW })

  it('总闸那一格摆的是四个平台加起来与上限，剩余可以是负数', () => {
    const d = deck()
    expect(d.spend_gate.spent).toBe(700)
    expect(d.spend_gate.cap).toBe(1000)
    expect(d.spend_gate.remaining).toBe(300)
    // 上限改小就该显示真实差额，不夹到 0
    const tight = adsDeckData(store(), { now: NOW, cap: 500 })
    expect(tight.spend_gate.remaining).toBe(-200)
  })

  it('每一行都带 platform（四条职责共用一份投影，面板那一层自己筛）', () => {
    const d = deck()
    expect(d.campaigns.every((r) => r.platform !== '')).toBe(true)
    expect(d.pixels.every((r) => r.platform !== '')).toBe(true)
    expect(d.stop_losses.every((r) => r.platform !== '')).toBe(true)
  })

  it('止损那一行带着**判据**，不是"止损"两个字', () => {
    const row = deck().stop_losses[0]
    expect(row?.reason).toContain('ROAS')
    expect(row?.reason).toContain('日预算')
  })

  it('像素：掉了的那一条带着平台原话，而且状态与健康的那条分得开', () => {
    const rows = deck().pixels
    expect(rows.find((p) => p.event_name === 'Purchase')?.status).toBe('healthy')
    const stale = rows.find((p) => p.event_name === 'AddToCart')
    expect(stale?.status).toBe('stale')
    expect(stale?.note).toContain('建站')
  })

  it('归因与待审是宿主递进来的（库里不存审批），不给就是空的**不是编的**', () => {
    const d = deck()
    expect(d.attribution).toEqual([])
    expect(d.pending).toEqual([])
  })
})

describe('57 §1 四张连接卡', () => {
  it('契约那张平台表里每个平台的 `connector_kind` 在目录里都有一张卡', () => {
    for (const spec of ADS_PLATFORMS) {
      const entry = catalogEntry(spec.connector_kind)
      expect(entry, `${spec.id} 少一张卡`).toBeDefined()
    }
  })

  it('Meta / Google 可连（有真实现）；X / TikTok 标着"还没接"、点不动', () => {
    expect(catalogEntry('meta_marketing')?.planned).toBeUndefined()
    expect(catalogEntry('google_ads')?.planned).toBeUndefined()
    expect(catalogEntry('x_ads')?.planned).toContain('还没接')
    expect(catalogEntry('tiktok_ads')?.planned).toContain('还没接')
    // 点不动的那两张没有表单：给一张能填的表、填完撞墙，比明说糟得多
    expect(catalogEntry('x_ads')?.fields).toEqual([])
    expect(catalogEntry('tiktok_ads')?.fields).toEqual([])
  })

  it('准备说明里**先说代价**（57 §1 末行）', () => {
    // Meta：与社媒那张卡是两张，要的权限不一样
    // WP141：卡面默认露出的这句不印权限名（权限名在「要准备什么」的步骤里）
    expect(catalogEntry('meta_marketing')?.setup_guide?.summary).toContain('管理广告')
    expect(catalogEntry('meta_marketing')?.setup_guide?.summary).not.toContain('ads_management')
    expect(catalogEntry('meta_marketing')?.setup_guide?.steps.join('')).toContain('ads_management')
    // Google：developer token 要单独申请过审
    expect(catalogEntry('google_ads')?.setup_guide?.summary).toContain('developer token')
    expect(catalogEntry('x_ads')?.setup_guide?.summary).toContain('申请制')
    expect(catalogEntry('tiktok_ads')?.setup_guide?.summary).toContain('Business Center')
  })

  it('四张卡各喂一个数据源，而且那几个源在 deck 的清单里', () => {
    expect(dataSourcesOfService('meta_marketing')).toContain('ads_meta')
    expect(dataSourcesOfService('google_ads')).toContain('ads_google')
    expect(dataSourcesOfService('x_ads')).toEqual(['ads_x'])
    expect(dataSourcesOfService('tiktok_ads')).toEqual(['ads_tiktok'])
    for (const id of ['ads_meta', 'ads_google', 'ads_x', 'ads_tiktok'])
      expect(ALL_DATA_SOURCES).toContain(id)
  })

  it('Meta 投放那张卡与社媒那张 `meta_graph` 是**两条目录项**（权限不一样）', () => {
    expect(catalogEntry('meta_marketing')).toBeDefined()
    expect(catalogEntry('meta_graph')).toBeDefined()
    expect(catalogEntry('meta_marketing')?.label).not.toBe(catalogEntry('meta_graph')?.label)
    // 目录里 service 不重名
    const services = CATALOG.map((e) => e.service)
    expect(new Set(services).size).toBe(services.length)
  })
})

/**
 * 57 §3 那五张卡里的第五张。前四张是审批项（`/v1/ads/*` 那五个写口子出的），
 * 这一张不是——所以它不在 `ads-routes.test.ts` 里，在这儿。
 */
describe('57 §3 第五张卡：像素异常卡（**通知，不是审批项**）', () => {
  it('健康的一条都不出卡：告警区常年摆着"一切正常"，真出事那天没人会看', () => {
    const s = createAdsStore({ workspace_id: 'ws_test' })
    s.savePixel({
      id: 'px_ok',
      account_id: 'aa',
      platform: 'meta',
      external_id: '1',
      event_name: 'Purchase',
      count_24h: 13,
      status: 'healthy',
      observed_at: NOW,
    })
    expect(adsPixelAlerts(s)).toEqual([])
  })

  it('`stale` 与 `missing` 是**两张不同的卡**，而且坏得最厉害的排最前', () => {
    const s = store()
    s.savePixel({
      id: 'px_missing',
      account_id: 'aa_demo_meta',
      platform: 'meta',
      external_id: '7890000003',
      event_name: 'Purchase',
      status: 'missing',
      note: '平台后台查不到这个转化动作。',
      observed_at: NOW,
    })
    const cards = adsPixelAlerts(s)
    // 一个压根没装的 Purchase 意味着今天所有转化数都是假的——它不该排第二个
    expect(cards.map((c) => c.reason)).toEqual(['missing', 'stale'])
    expect(cards[0]?.event_name).toBe('Purchase')
    expect(cards[0]?.title).not.toBe(cards[1]?.title)
    expect(cards.every((c) => c.kind === 'system_alert')).toBe(true)
  })

  it('平台说的原话**原样**带上，判据那两格也带上（不补 0）', () => {
    const card = adsPixelAlerts(store())[0]
    if (card === undefined) throw new Error('那张卡没出来')
    expect(card.reason).toBe('stale')
    expect(card.note).toContain('五天没收到这个事件了')
    expect(card.count_24h).toBe(0)
    expect(card.last_fired_at).toBeDefined()
  })

  it('卡上写的是"转给建站"，**不是**"去改代码"——投放没有那个权限', () => {
    const card = adsPixelAlerts(store())[0]
    if (card === undefined) throw new Error('那张卡没出来')
    expect(card.actions.map((a) => a.id)).toEqual(['handoff_site', 'dismiss'])
    expect(card.body).toContain('建站')
    expect(card.body).toContain('人审')
  })

  it('按平台筛得开：Google 那条职责看不见 Meta 的像素卡', () => {
    expect(adsPixelAlerts(store(), { platform: 'google' })).toEqual([])
    expect(adsPixelAlerts(store(), { platform: 'meta' }).length).toBe(1)
  })
})
