/**
 * WP466（决策 1311 / 1404）：原首页告警区的系统卡（`system_alert`）每种都进铃铛、点得进去。
 *
 * 钉住：
 * - 每种告警（目标市场校正、退役模型换了、店铺日报异常、广告改动、WP448 改版回归·严重、没登记的新种类）
 *   都变成「告警」一类的一条通知，去处 = 卡上的 `open_path`；
 * - 紧急档：店铺日报异常、改版回归、广告没做成 / 读回对不上 / 等你确认、别的 P0 / P1；没读时排最上；
 * - 同一张卡一直挂着：不加计数、读过的不变回未读；卡没了：那条收成已读；
 * - 设置里关了「告警」就不记；「系统」开着也只有紧急的弹系统通知。
 */
import type { AdsLedgerEntryView, PersonId, WorkspaceId } from '@agentsws/contracts'
import type { DeckCard } from '@agentsws/deck'
import { describe, expect, it } from 'vitest'
import { adsNoticeCards } from '../src/ads-wiring/notices.js'
import { alertKey, alertNotificationOf, alertUrgent } from '../src/alert-notifications.js'
import { MARKETS_SETTINGS_PATH, storeMarketsNoticeCard } from '../src/markets.js'
import { createNotifications } from '../src/notifications.js'
import { retiredModelNoticeCard } from '../src/retired-models.js'
import { createStoreDigest } from '../src/store-digest.js'

const WS = 'ws_a' as WorkspaceId
const ME = 'p_me' as PersonId
const me = { workspace_id: WS, person_id: ME }
const AT = '2026-10-22T02:00:00.000Z'

function make() {
  let t = Date.parse(AT)
  const clock = {
    now: () => new Date(t).toISOString(),
    advance: (ms: number) => {
      t += ms
    },
  }
  let r = 0.2
  const svc = createNotifications({
    clock,
    random: () => {
      r = (r * 7.3) % 1
      return r
    },
  })
  return { clock, svc }
}

const markets = storeMarketsNoticeCard({
  id: 'mkt_1',
  at: AT,
  note: '按店铺后台的「市场」校正：加上了 英国',
  markets: ['US', 'GB'],
  owner: ME,
  position_id: 'asg_owner',
})

const retired = retiredModelNoticeCard({
  id: 'retired_model_1',
  swap: { from: 'gpt-5.4', to: 'gpt-5.5', at: AT },
  position_id: 'asg_owner',
})

async function storeAnomalies(): Promise<DeckCard[]> {
  const NOW = '2026-09-07T01:00:00.000Z'
  const order = (id: string, at: string, total: number) => ({
    id,
    name: `#${id}`,
    email: 'buyer@example.com',
    currency: 'USD',
    created_at: at,
    total_price: total,
    refunded_amount: 0,
    financial_status: 'paid',
    fulfillment_status: 'unfulfilled',
  })
  const ctx = {
    now: NOW,
    tz_offset_minutes: 480,
    base_currency: 'USD',
    role_id: 'dtc.store',
    position_id: 'asg_store',
    orders: [
      order('1', '2026-09-06T02:00:00.000Z', 10),
      order('2', '2026-09-05T02:00:00.000Z', 100),
    ],
    inventory: [{ id: 'inv_1', product_id: 'p1', sku: 'SKU-1', title: '收纳箱', quantity: 0 }],
    approvals: [],
    sources: [
      { id: 'shop', label: '店铺后台', connected: true },
      { id: 'approvals', label: '工作队列', connected: true },
    ],
    thresholds: { low_stock_quantity: 5, sales_drop_pct: 30 },
  }
  const digest = createStoreDigest({
    workspace_id: WS,
    clock: { now: () => NOW },
    assignments: () =>
      [{ id: 'asg_store', role_id: 'dtc.store', person_id: ME, workspace_id: WS }] as never,
    approvals: { create: async () => ({ id: 'ap_1' }) as never },
    port: async () =>
      ({
        positions: async () => [{ position_id: 'asg_store', role_id: 'dtc.store' }],
        queryContext: async () => ctx,
      }) as never,
  })
  await digest.run()
  return digest.alerts(ME)
}

const adsRow = (patch: Partial<AdsLedgerEntryView>): AdsLedgerEntryView => ({
  change_id: 'chg_1',
  kind: 'ads_sheet',
  platform: 'google',
  account_id: 'aa_g',
  title: '改广告',
  state: 'done',
  jobs: [],
  evidence: [],
  evidence_missing: [],
  files: [],
  undo: { available: true },
  created_at: AT,
  updated_at: AT,
  kept_until: AT,
  ...patch,
})
const ads = (rows: AdsLedgerEntryView[]): DeckCard[] =>
  adsNoticeCards({
    rows,
    now: AT,
    hrefOf: () => ({
      href: '/positions/asg_g/duties/ads.google',
      position_id: 'asg_g',
      role_id: 'ads.google',
    }),
  })

/** WP448 分支 `seo-drift-alerts.ts` 出的那张卡的形状（还没合进来，照它的字段摆一张）。 */
const drift: DeckCard = {
  ...markets,
  id: 'seo_drift_run_1',
  priority_band: 'P1',
  risk_class: 'medium',
  role_id: 'dtc.seo',
  position_id: 'asg_seo',
  title: '改版回归：主题发布之后 2 处严重问题',
  dedupe_key: 'seo_drift|run_1',
  detail: {
    ...markets.detail,
    payload: { kind: 'seo_drift', open_path: '/matters/m_site_fix', run_id: 'run_1' },
  },
}

describe('每种告警在铃铛里一条，点得进去', () => {
  it('目标市场校正 / 退役模型换了：普通档，去设置页', () => {
    expect(alertNotificationOf(markets, me)).toMatchObject({
      category: 'alert',
      text: markets.title,
      href: MARKETS_SETTINGS_PATH,
      key: 'alert:markets_store|2026-10-22T02:00:00.000Z',
    })
    expect(alertNotificationOf(markets, me)?.urgent).toBeUndefined()
    expect(alertNotificationOf(retired, me)).toMatchObject({
      category: 'alert',
      text: 'ChatGPT 订阅的 gpt-5.4 停用了，已换成 gpt-5.5',
      href: '/settings?tab=models',
    })
    expect(alertUrgent(retired)).toBe(false)
  })

  it('店铺日报异常：紧急档，去店铺管理的职责页', async () => {
    const cards = await storeAnomalies()
    expect(cards.length).toBeGreaterThan(0)
    for (const c of cards)
      expect(alertNotificationOf(c, me)).toMatchObject({
        category: 'alert',
        urgent: true,
        href: '/positions/asg_store/duties/dtc.store',
      })
  })

  it('广告改动：没做成 / 读回对不上 / 等你确认是紧急；退回、交给你是普通；都去职责页那一块（按钮在那里）', () => {
    const urgentOf = (row: Partial<AdsLedgerEntryView>) => {
      const [card] = ads([adsRow(row)])
      if (card === undefined) throw new Error('no card')
      const n = alertNotificationOf(card, me)
      expect(n?.href).toBe('/positions/asg_g/duties/ads.google')
      return n?.urgent === true
    }
    expect(urgentOf({ state: 'waiting_confirm' })).toBe(true)
    expect(urgentOf({ state: 'failed' })).toBe(true)
    expect(urgentOf({ readback: { ok: false, sentence: '1 条对不上' } })).toBe(true)
    expect(urgentOf({ state: 'rejected' })).toBe(false)
    expect(urgentOf({ state: 'handover' })).toBe(false)
  })

  it('WP448 改版回归·严重：紧急档，去交给建站的那件事', () => {
    expect(alertNotificationOf(drift, me)).toMatchObject({
      category: 'alert',
      urgent: true,
      text: '改版回归：主题发布之后 2 处严重问题',
      href: '/matters/m_site_fix',
      key: 'alert:seo_drift|run_1',
    })
  })

  it('没登记的新种类：按档位（P0 / P1 紧急）；`payload.urgent` 也算；外链不跟；不是系统卡的不进', () => {
    const other = (band: DeckCard['priority_band'], payload: Record<string, unknown>) =>
      ({ ...markets, priority_band: band, detail: { ...markets.detail, payload } }) as DeckCard
    expect(alertUrgent(other('P1', { kind: 'new_thing' }))).toBe(true)
    expect(alertUrgent(other('P3', { kind: 'new_thing' }))).toBe(false)
    expect(alertUrgent(other('P3', { kind: 'new_thing', urgent: true }))).toBe(true)
    expect(
      alertNotificationOf(other('P3', { open_path: 'https://evil.example/' }), me)?.href,
    ).toBeUndefined()
    expect(
      alertNotificationOf(other('P3', { open_path: '//evil.example/' }), me)?.href,
    ).toBeUndefined()
    expect(alertNotificationOf({ ...markets, kind: 'daily_report' } as DeckCard, me)).toBe(
      undefined,
    )
    expect(alertKey({ id: 'x', dedupe_key: '' })).toBe('alert:x')
  })
})

describe('对进铃铛：一直挂着不加计数，没了收成已读', () => {
  it('每张一条；紧急的没读时排最上；再对一遍不加计数', async () => {
    const { clock, svc } = make()
    const anomalies = await storeAnomalies()
    svc.notify({ ...me, category: 'task', text: '「选品」跑完了', key: 'run:1' })
    clock.advance(1000)
    svc.syncAlerts(me, [markets, retired, drift, ...anomalies])
    clock.advance(1000)
    svc.syncAlerts(me, [markets, retired, drift, ...anomalies])
    const list = svc.list(me, { view: 'unread', limit: 50 })
    expect(list.unread).toBe(4 + anomalies.length)
    expect(list.items.every((n) => n.count === 1)).toBe(true)
    const urgentCount = 1 + anomalies.length
    expect(list.items.slice(0, urgentCount).every((n) => n.urgent === true)).toBe(true)
    expect(list.items.slice(urgentCount).some((n) => n.urgent === true)).toBe(false)
    // 紧急的弹系统通知；普通告警只进铃铛；别的类照旧按设置
    const byText = (t: string) => list.items.find((n) => n.text === t)
    expect(byText(drift.title)?.system).toBe(true)
    expect(byText(retired.title)?.system).toBe(false)
  })

  it('读过的还挂着：不变回未读；卡没了：没读的那几条收成已读；读过的那条紧急档也不再排最上', () => {
    const { svc } = make()
    svc.syncAlerts(me, [markets, drift])
    const first = svc.list(me, { view: 'unread', limit: 50 })
    const driftRow = first.items.find((n) => n.key === alertKey(drift))
    expect(first.items[0]?.key).toBe(alertKey(drift))
    svc.markRead(me, [driftRow?.id ?? ''])
    svc.syncAlerts(me, [markets, drift])
    expect(svc.list(me, { view: 'unread', limit: 50 }).items.map((n) => n.key)).toEqual([
      alertKey(markets),
    ])
    // 改版回归改回去了、市场那条也过了 → 都没了
    svc.syncAlerts(me, [])
    expect(svc.list(me, { view: 'unread', limit: 50 }).unread).toBe(0)
    expect(svc.list(me, { view: 'all', limit: 50 }).items).toHaveLength(2)
  })

  it('卡上的字 / 档位变了（读回结果补上了）：同一条改字，不另起一条', () => {
    const { svc } = make()
    const [waiting] = ads([adsRow({ state: 'rejected' })])
    if (waiting === undefined) throw new Error('no card')
    svc.syncAlerts(me, [waiting])
    svc.syncAlerts(me, [{ ...waiting, title: '退回了，没提交：改广告（第二版）' }])
    const items = svc.list(me, { view: 'all', limit: 50 }).items
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ text: '退回了，没提交：改广告（第二版）', count: 1 })
  })

  it('设置里关了「告警」：不记；别人的告警不进我的铃铛', () => {
    const { svc } = make()
    svc.setPrefs(me, { alert: { inbox: false } })
    svc.syncAlerts(me, [drift])
    expect(svc.list(me, { view: 'all', limit: 50 }).items).toEqual([])
    svc.syncAlerts({ workspace_id: WS, person_id: 'p_other' as PersonId }, [drift])
    expect(svc.list(me, { view: 'all', limit: 50 }).items).toEqual([])
  })

  it('别的类的通知不受告警同步影响', () => {
    const { svc } = make()
    svc.notify({ ...me, category: 'connection', text: 'Shopify 连接断了', key: 'conn:1' })
    svc.syncAlerts(me, [])
    expect(svc.list(me, { view: 'unread', limit: 50 }).unread).toBe(1)
  })
})
