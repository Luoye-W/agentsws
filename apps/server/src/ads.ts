/**
 * 广告库的存储（57 §5 数据面，WP75）。
 *
 * 五类对象（`ad_account` / `campaign` / `ad_set` / `ad` / `pixel_event`）落在
 * **这个品牌自己的**目录下（WP66 的 `BrandModules`：bootstrap 品牌用原来那个目录，
 * 别的品牌在 `<dbDir>/brands/<workspace_id>/` 下）。形状照 `social.ts` / `kol.ts` 抄：
 * 一张表一列 json，后端要么 sqlite 要么全内存（测试与一次性任务）。
 *
 * 五条纪律：
 *
 * 1. **凭据一格都没有**。`AdAccount.connection_id` 指的是连接页上那一条连接；
 *    取 token 要经本品牌加密库，那是打那一跳的事（同 `social.ts` 的第 1 条）。
 * 2. **四个平台之间零共享**。同一个品牌在 Meta 与在 Google 是两条 `AdAccount`，
 *    各带各的币种、各算各的花费。把它们挂到一起的只有 `workspace_id`——
 *    以及**总闸**（下面第 3 条），那是唯一一处要合起来看的地方。
 * 3. **总闸按岗位聚合，在这一层算**（04 §5 / 57 §6）。{@link AdsStore.spendToday}
 *    把四个平台今天的花费加起来，并**说出哪个平台还没拉到数**——不说的话，
 *    "还剩 800"会让人以为很宽裕，而真相是有两个平台压根没数。
 * 4. **数字不重算**。`AdMetrics` 是拉数那一跳写回来的；读的时候原样端出去，
 *    面板上那几列不在渲染时现算（29 §1「数字不经模型手」）。
 * 5. **像素只读**。这个库里有 `savePixel`（拉数那一跳写回来），但**没有**
 *    "改像素"这回事——改追踪代码是建站的事，而且永远 L1（04 §5 `ads.tracking`）。
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type {
  Ad,
  AdAccount,
  AdCampaign,
  AdSet,
  AdsPlatform,
  PixelEvent,
  WorkspaceId,
} from '@agentsws/contracts'
import { ADS_PLATFORM_IDS } from '@agentsws/contracts'
import type { AdsDeckData } from '@agentsws/deck'
import type BetterSqlite3 from 'better-sqlite3'

/** 库里的五张表。名字与对象类型一一对应，不另起别名。 */
export type AdsTable = 'ad_account' | 'ad_campaign' | 'ad_set' | 'ad' | 'pixel_event'

export const ADS_TABLES: readonly AdsTable[] = [
  'ad_account',
  'ad_campaign',
  'ad_set',
  'ad',
  'pixel_event',
]

interface AdsBackend {
  all<T>(table: AdsTable): T[]
  get<T>(table: AdsTable, id: string): T | undefined
  put(table: AdsTable, id: string, row: unknown): void
  remove(table: AdsTable, id: string): void
  close(): void
}

function createMemoryBackend(): AdsBackend {
  const tables = new Map<AdsTable, Map<string, unknown>>()
  const of = (t: AdsTable): Map<string, unknown> => {
    const found = tables.get(t)
    if (found !== undefined) return found
    const fresh = new Map<string, unknown>()
    tables.set(t, fresh)
    return fresh
  }
  return {
    all: <T>(t: AdsTable) => [...of(t).values()].map((r) => structuredClone(r) as T),
    get: <T>(t: AdsTable, id: string) => {
      const row = of(t).get(id)
      return row === undefined ? undefined : (structuredClone(row) as T)
    },
    put: (t, id, row) => {
      of(t).set(id, structuredClone(row))
    },
    remove: (t, id) => {
      of(t).delete(id)
    },
    close: () => tables.clear(),
  }
}

const SCHEMA = ADS_TABLES.map(
  (t) => `CREATE TABLE IF NOT EXISTS ads_${t} (id TEXT PRIMARY KEY, json TEXT NOT NULL);`,
).join('\n')

function createSqliteBackend(dbPath: string): AdsBackend {
  const require = createRequire(import.meta.url)
  const Database = require('better-sqlite3') as typeof BetterSqlite3
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA)
  return {
    all: <T>(t: AdsTable) =>
      (db.prepare(`SELECT json FROM ads_${t} ORDER BY id`).all() as { json: string }[]).map(
        (r) => JSON.parse(r.json) as T,
      ),
    get: <T>(t: AdsTable, id: string) => {
      const row = db.prepare(`SELECT json FROM ads_${t} WHERE id = ?`).get(id) as
        | { json: string }
        | undefined
      return row === undefined ? undefined : (JSON.parse(row.json) as T)
    },
    put: (t, id, row) => {
      db.prepare(
        `INSERT INTO ads_${t} (id, json) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET json = excluded.json`,
      ).run(id, JSON.stringify(row))
    },
    remove: (t, id) => {
      db.prepare(`DELETE FROM ads_${t} WHERE id = ?`).run(id)
    },
    close: () => {
      db.close()
    },
  }
}

export interface AdsStoreOptions {
  workspace_id: WorkspaceId
  /** 这个品牌的落盘目录（`BrandModules` 给的那一个）。不给就全内存。 */
  dbDir?: string
}

/** 一次止损记录（自动停掉一条时写回来的那一条）。 */
export interface AdsStopLoss {
  campaign_id: string
  platform: AdsPlatform
  name: string
  at: string
  roas?: number
  spend?: number
  daily_budget?: number
  /** `ads-core` 的 `stopLossVerdict.reason`，**原样**。 */
  reason: string
}

export interface AdsStore {
  readonly workspace_id: WorkspaceId
  accounts(filter?: { platform?: AdsPlatform }): AdAccount[]
  account(id: string): AdAccount | undefined
  campaigns(filter?: { platform?: AdsPlatform; account_id?: string }): AdCampaign[]
  campaign(id: string): AdCampaign | undefined
  adSets(filter?: { platform?: AdsPlatform; campaign_id?: string }): AdSet[]
  ads(filter?: { platform?: AdsPlatform; ad_set_id?: string }): Ad[]
  ad(id: string): Ad | undefined
  pixels(filter?: { platform?: AdsPlatform; account_id?: string }): PixelEvent[]

  saveAccount(row: AdAccount): void
  saveCampaign(row: AdCampaign): void
  saveAdSet(row: AdSet): void
  saveAd(row: Ad): void
  savePixel(row: PixelEvent): void

  /**
   * 拉完数之后回填一条 campaign 的表现。
   *
   * campaign 不在就什么也不做（**不凭空建一条**：一条只有数字没有名字的
   * campaign 在面板上会变成一行没人认得的数，同 `social.ts` 的 `recordMetrics`）。
   */
  recordMetrics(input: { campaign_id: string; metrics: NonNullable<AdCampaign['metrics']> }): void

  /** 记一次止损（自动停掉一条之后）。 */
  recordStopLoss(row: AdsStopLoss): void
  stopLosses(filter?: { platform?: AdsPlatform; since?: string }): AdsStopLoss[]

  /**
   * **岗位级日花费总闸的那个分子**（04 §5 / 57 §6）：四个平台今天各花了多少、
   * 加起来多少、哪几个还没拉到数。
   *
   * 放在库这一层而不是 deck 里：deck 是**纯**的（29 §1，它连库都不认识），
   * 而这一步要跨账户与 campaign 两张表按平台聚合。
   */
  spendToday(options?: { platforms?: readonly AdsPlatform[] }): {
    spent: number
    by_platform: { platform: string; spend: number; observed_at?: string }[]
    missing: string[]
    currency?: string
  }
  close(): void
}

export function createAdsStore(options: AdsStoreOptions): AdsStore {
  const backend =
    options.dbDir === undefined
      ? createMemoryBackend()
      : createSqliteBackend(join(options.dbDir, 'ads.sqlite'))

  /**
   * 止损记录落在 `pixel_event` 之外的一张伪表上会多一个表名；这里借用
   * `ad_campaign` 表的 id 前缀存——**不是**偷懒：一次止损永远绑着一条 campaign，
   * 它没有独立的生命周期，查它一定是从那条 campaign 查过去的。
   */
  const stopLossId = (row: AdsStopLoss) => `stoploss:${row.campaign_id}:${row.at}`

  return {
    workspace_id: options.workspace_id,
    accounts: (filter) =>
      backend
        .all<AdAccount>('ad_account')
        .filter((a) => filter?.platform === undefined || a.platform === filter.platform),
    account: (id) => backend.get<AdAccount>('ad_account', id),
    campaigns: (filter) =>
      backend
        .all<AdCampaign>('ad_campaign')
        .filter((c) => !c.id.startsWith('stoploss:'))
        .filter((c) => filter?.platform === undefined || c.platform === filter.platform)
        .filter((c) => filter?.account_id === undefined || c.account_id === filter.account_id),
    campaign: (id) => backend.get<AdCampaign>('ad_campaign', id),
    adSets: (filter) =>
      backend
        .all<AdSet>('ad_set')
        .filter((s) => filter?.platform === undefined || s.platform === filter.platform)
        .filter((s) => filter?.campaign_id === undefined || s.campaign_id === filter.campaign_id),
    ads: (filter) =>
      backend
        .all<Ad>('ad')
        .filter((a) => filter?.platform === undefined || a.platform === filter.platform)
        .filter((a) => filter?.ad_set_id === undefined || a.ad_set_id === filter.ad_set_id),
    ad: (id) => backend.get<Ad>('ad', id),
    pixels: (filter) =>
      backend
        .all<PixelEvent>('pixel_event')
        .filter((p) => filter?.platform === undefined || p.platform === filter.platform)
        .filter((p) => filter?.account_id === undefined || p.account_id === filter.account_id),

    saveAccount: (row) => backend.put('ad_account', row.id, row),
    saveCampaign: (row) => backend.put('ad_campaign', row.id, row),
    saveAdSet: (row) => backend.put('ad_set', row.id, row),
    saveAd: (row) => backend.put('ad', row.id, row),
    savePixel: (row) => backend.put('pixel_event', row.id, row),

    recordMetrics: ({ campaign_id, metrics }) => {
      const campaign = backend.get<AdCampaign>('ad_campaign', campaign_id)
      if (campaign === undefined) return
      backend.put('ad_campaign', campaign.id, { ...campaign, metrics })
    },

    recordStopLoss: (row) => {
      backend.put('ad_campaign', stopLossId(row), { ...row, id: stopLossId(row) })
    },
    stopLosses: (filter) =>
      backend
        .all<AdsStopLoss & { id: string }>('ad_campaign')
        .filter((r) => r.id.startsWith('stoploss:'))
        .filter((r) => filter?.platform === undefined || r.platform === filter.platform)
        .filter((r) => filter?.since === undefined || r.at >= filter.since)
        .sort((a, b) => (a.at < b.at ? 1 : -1))
        .map(({ id: _id, ...rest }) => rest),

    spendToday: (opts) => {
      const platforms = opts?.platforms ?? ADS_PLATFORM_IDS
      const accounts = backend.all<AdAccount>('ad_account')
      const campaigns = backend
        .all<AdCampaign>('ad_campaign')
        .filter((c) => !c.id.startsWith('stoploss:'))
      const by_platform: { platform: string; spend: number; observed_at?: string }[] = []
      const missing: string[] = []
      for (const platform of platforms) {
        /*
         * 优先用账户上那一格（`spend_today`，拉数那一跳直接写回来的）；
         * 没有就把这个平台各条 campaign 的 `metrics.spend` 加起来。
         * 两样都没有 = 这个平台今天**还没拉过数**——进 `missing`，按 0 算但说出来。
         */
        const mine = accounts.filter((a) => a.platform === platform)
        const direct = mine.filter((a) => a.spend_today !== undefined)
        if (direct.length > 0) {
          const spend = direct.reduce((sum, a) => sum + (a.spend_today ?? 0), 0)
          const observed_at = direct.map((a) => a.observed_at).sort()[0]
          by_platform.push({
            platform,
            spend,
            ...(observed_at === undefined ? {} : { observed_at }),
          })
          continue
        }
        const rows = campaigns.filter(
          (c) => c.platform === platform && c.metrics?.spend !== undefined,
        )
        if (rows.length === 0) {
          if (mine.length > 0 || platforms.length <= ADS_PLATFORM_IDS.length) missing.push(platform)
          by_platform.push({ platform, spend: 0 })
          continue
        }
        const observed_at = rows
          .map((c) => c.metrics?.observed_at)
          .filter((v): v is string => v !== undefined)
          .sort()[0]
        by_platform.push({
          platform,
          spend: rows.reduce((sum, c) => sum + (c.metrics?.spend ?? 0), 0),
          ...(observed_at === undefined ? {} : { observed_at }),
        })
      }
      const currency = accounts[0]?.currency
      return {
        spent: by_platform.reduce((sum, r) => sum + r.spend, 0),
        by_platform,
        missing,
        ...(currency === undefined ? {} : { currency }),
      }
    },

    close: () => backend.close(),
  }
}

/** 每块最多端多少行——面板不是导出（同 `social.ts`）。 */
const MAX_ROWS = 20

/**
 * `AdsStore` → 面板那九块要的那份投影（57 §3）。
 *
 * 放在这里而不是 deck 里：deck 是**纯**的（29 §1），而这一步要跨五张表把
 * "这条 campaign 是哪个账户下面的"拼出来，还要把总闸那一格算出来。
 *
 * 三件事在这一跳定死：
 *
 * 1. **每一行都带 `platform`**。四条职责共用同一份投影，面板那一层按自己那个
 *    平台筛（`adsPlatformOfRole`）——不在这里按职责切，切了就得算四遍。
 * 2. **总闸那一格不按平台切**：它是岗位级的（04 §5），四个平台加起来的那个数。
 * 3. **数字原样端出去**：拿不到的一律留空，**不补 0**（"这个平台还没拉数"与
 *    "今天真的没花钱"在面板上必须分得开——前者会让总闸显得很宽裕）。
 */
export function adsDeckData(
  store: Pick<
    AdsStore,
    'accounts' | 'campaigns' | 'pixels' | 'stopLosses' | 'spendToday' | 'account'
  >,
  options: {
    /** 岗位级总闸那个数（57 §6 默认 1000；按品牌可改）。 */
    cap?: number
    /** 归因那几行（`ads-core` 的 `attributeAds` 算完递进来）。 */
    attribution?: AdsDeckData['attribution']
    /** 归不上的订单数。 */
    unmatched_orders?: number
    /** 待审改动四车道（从审批总线读出来递进来——库里不存审批）。 */
    pending?: AdsDeckData['pending']
    now?: string
  } = {},
): AdsDeckData {
  const cap = options.cap ?? 1000
  const gate = store.spendToday()
  const accounts = new Map(store.accounts().map((a) => [a.id, a]))
  const accountName = (id: string): string => accounts.get(id)?.name ?? id

  const campaigns = store
    .campaigns()
    .slice(0, MAX_ROWS)
    .map((c) => ({
      campaign_id: c.id,
      platform: c.platform as string,
      account: accountName(c.account_id),
      name: c.name,
      status: c.status as string,
      ...(c.daily_budget === undefined ? {} : { daily_budget: c.daily_budget }),
      ...(c.metrics?.spend === undefined ? {} : { spend: c.metrics.spend }),
      ...(c.metrics?.roas === undefined ? {} : { roas: c.metrics.roas }),
      ...(c.metrics?.conversions === undefined ? {} : { conversions: c.metrics.conversions }),
      ...(c.metrics?.observed_at === undefined ? {} : { observed_at: c.metrics.observed_at }),
    }))

  const stop_losses = store
    .stopLosses()
    .slice(0, MAX_ROWS)
    .map((r) => ({
      campaign_id: r.campaign_id,
      platform: r.platform as string,
      name: r.name,
      at: r.at,
      ...(r.roas === undefined ? {} : { roas: r.roas }),
      ...(r.spend === undefined ? {} : { spend: r.spend }),
      ...(r.daily_budget === undefined ? {} : { daily_budget: r.daily_budget }),
      reason: r.reason,
    }))

  const pixels = store
    .pixels()
    .slice(0, MAX_ROWS)
    .map((p) => ({
      pixel_id: p.id,
      platform: p.platform as string,
      event_name: p.event_name,
      status: p.status as string,
      ...(p.count_24h === undefined ? {} : { count_24h: p.count_24h }),
      ...(p.last_fired_at === undefined ? {} : { last_fired_at: p.last_fired_at }),
      ...(p.note === undefined ? {} : { note: p.note }),
      observed_at: p.observed_at,
    }))

  const conversions = store
    .campaigns()
    .map((c) => c.metrics?.conversions)
    .filter((v): v is number => v !== undefined)

  return {
    spend_gate: {
      spent: gate.spent,
      cap,
      // 已经负了就是负数：面板上那一格要显示真实差额，不夹到 0
      remaining: cap - gate.spent,
      ...(gate.currency === undefined ? {} : { currency: gate.currency }),
      by_platform: gate.by_platform,
      missing: gate.missing,
    },
    campaigns,
    pending: options.pending ?? [],
    stop_losses,
    pixels,
    attribution: options.attribution ?? [],
    ...(options.unmatched_orders === undefined
      ? {}
      : { unmatched_orders: options.unmatched_orders }),
    ...(conversions.length === 0
      ? {}
      : { conversions_today: conversions.reduce((a, b) => a + b, 0) }),
    stop_loss_count: stop_losses.length,
  }
}

/**
 * WP75（57 §3）：demo 里给广告库放几行。
 *
 * 理由与 `seedDemoKol` / `seedDemoSocial` 逐字相同：广告库是我们自己的库，
 * 合成 pack 里没有它的行——不放的话投放岗位那九块面板在演示与截图里全是空的，
 * "这个岗位长什么样"就无从谈起。只在挂了合成世界时放（真环境的行该是
 * 用户连上平台之后拉回来的）。
 *
 * 放的这几条是**故意挑的**：
 *
 * - 两个平台（Meta + Google）各一个账户：总闸是四个平台加起来的那个数，
 *   只放一个平台就看不出"加起来"这件事。
 * - 一条 ROAS 0.6 且已经花过日预算 40% 的 campaign：那正是止损该触发的那一条，
 *   演示里看得见"为什么停它"。
 * - 一条 ROAS 4.2 的爆款：止损不该碰它——两条判据是"且"不是"或"。
 * - 一条 24 小时没响过的像素：投放看得见它掉了，但改不动（那是建站的事）。
 */
export function seedDemoAds(store: AdsStore, now: string): void {
  if (store.accounts().length > 0) return
  const nowMs = Date.parse(now)
  const iso = (offsetMs: number): string => new Date(nowMs + offsetMs).toISOString()
  const observed_at = now

  store.saveAccount({
    id: 'aa_demo_meta',
    workspace_id: store.workspace_id,
    platform: 'meta',
    external_id: 'act_100000000000001',
    name: 'Nordvolt 广告账户',
    currency: 'CNY',
    status: 'active',
    observed_at,
  })
  store.saveAccount({
    id: 'aa_demo_google',
    workspace_id: store.workspace_id,
    platform: 'google',
    external_id: '1234567890',
    name: 'Nordvolt Google Ads',
    currency: 'CNY',
    status: 'active',
    observed_at,
  })

  // 该止损的那一条：ROAS 0.6 < 1，今天花了 400 > 日预算 1000 的 30%
  store.saveCampaign({
    id: 'cmp_demo_meta_1',
    account_id: 'aa_demo_meta',
    platform: 'meta',
    external_id: '120000000000001',
    name: '九月桌面收纳 · 泛投',
    status: 'active',
    objective: 'OUTCOME_SALES',
    daily_budget: 1000,
    metrics: {
      spend: 400,
      impressions: 62_000,
      clicks: 910,
      conversions: 4,
      conversion_value: 240,
      roas: 0.6,
      observed_at,
    },
  })
  // 跑得好的那一条：止损不该碰它（两条判据是「且」不是「或」）
  store.saveCampaign({
    id: 'cmp_demo_meta_2',
    account_id: 'aa_demo_meta',
    platform: 'meta',
    external_id: '120000000000002',
    name: '九月桌面收纳 · 老客再营销',
    status: 'active',
    daily_budget: 300,
    metrics: {
      spend: 180,
      impressions: 9_400,
      clicks: 320,
      conversions: 11,
      conversion_value: 756,
      roas: 4.2,
      observed_at,
    },
  })
  store.saveCampaign({
    id: 'cmp_demo_google_1',
    account_id: 'aa_demo_google',
    platform: 'google',
    external_id: '55000001',
    name: '品牌词',
    status: 'active',
    daily_budget: 200,
    metrics: {
      spend: 120,
      impressions: 3_100,
      clicks: 260,
      conversions: 9,
      conversion_value: 640,
      roas: 5.33,
      observed_at,
    },
  })

  store.saveAdSet({
    id: 'as_demo_meta_1',
    campaign_id: 'cmp_demo_meta_1',
    account_id: 'aa_demo_meta',
    platform: 'meta',
    external_id: '1230000001',
    name: '25-44 · 居家办公兴趣',
    status: 'active',
    bid_amount: 2.4,
    bid_strategy: 'LOWEST_COST_WITH_BID_CAP',
    daily_budget: 1000,
    audience_summary: '25-44 岁，居家办公 / 数码配件兴趣，中国大陆',
  })
  store.saveAd({
    id: 'ad_demo_1',
    ad_set_id: 'as_demo_meta_1',
    campaign_id: 'cmp_demo_meta_1',
    account_id: 'aa_demo_meta',
    platform: 'meta',
    external_id: '4560000001',
    name: '桌面收纳 · 方图 A',
    status: 'active',
    creative_refs: ['blob_demo_creative_a'],
    headline: '一格放下所有线',
    primary_text: '三档可调的桌面收纳，线材一次收齐。',
  })

  store.savePixel({
    id: 'px_demo_purchase',
    account_id: 'aa_demo_meta',
    platform: 'meta',
    external_id: '7890000001',
    event_name: 'Purchase',
    count_24h: 13,
    last_fired_at: iso(-2 * 3_600_000),
    status: 'healthy',
    observed_at,
  })
  // 掉了的那一条：投放看得见，但改不动——改追踪代码是建站的事（04 §5）
  store.savePixel({
    id: 'px_demo_addtocart',
    account_id: 'aa_demo_meta',
    platform: 'meta',
    external_id: '7890000002',
    event_name: 'AddToCart',
    count_24h: 0,
    last_fired_at: iso(-5 * 86_400_000),
    status: 'stale',
    note: '五天没收到这个事件了。多半是主题改版把那段代码带掉了——改它要走建站那条职责（永远人审）。',
    observed_at,
  })

  store.recordStopLoss({
    campaign_id: 'cmp_demo_meta_1',
    platform: 'meta',
    name: '九月桌面收纳 · 泛投',
    at: iso(-3_600_000),
    roas: 0.6,
    spend: 400,
    daily_budget: 1000,
    reason:
      '两条判据都成立，止损：ROAS 0.6（线是 1），今天花了 400，占日预算 1000 的 40%（线是 30%）。',
  })
}
