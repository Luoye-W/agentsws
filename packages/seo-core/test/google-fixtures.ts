/**
 * WP158 的替身响应：照 Google 官方文档的示例形状、再按 OpenConnector v1.6.5 provider 的归一
 * （`google_search_console` / `google_analytics` 的 outputSchema）写成的。**数是编的，形状是真的**，
 * 不来自任何真账号。
 *
 * - GSC `searchanalytics.query`：`rows[{ keys, clicks, impressions, ctr, position }]` +
 *   `responseAggregationType` + `metadata`（developers.google.com/webmaster-tools/v1/searchanalytics/query）
 * - GSC `urlInspection.index.inspect`：`inspectionResult.indexStatusResult`
 * - GA4 `properties.runReport`：OpenConnector 把 `dimensionValues[{ value }]` 归一成按表头名做键的
 *   `dimensions` / `metrics`（值仍是字符串）
 */

const SITE = 'https://www.example-shop.com'

/** `list_sites`：一个域名属性、一个网址前缀、一个没验证的。 */
export const LIST_SITES = {
  sites: [
    { siteUrl: 'sc-domain:example-shop.com', permissionLevel: 'siteOwner' },
    { siteUrl: `${SITE}/`, permissionLevel: 'siteFullUser' },
    { siteUrl: 'https://old.example-shop.com/', permissionLevel: 'siteUnverifiedUser' },
  ],
}

/** 探最新完整日（`dimensions: ['date']`）：09-25、09-26 还没出数。 */
export const DATE_PROBE = {
  rows: [
    { keys: ['2026-09-21'], clicks: 120, impressions: 9000, ctr: 0.0133, position: 11.2 },
    { keys: ['2026-09-22'], clicks: 118, impressions: 8800, ctr: 0.0134, position: 11.0 },
    { keys: ['2026-09-23'], clicks: 125, impressions: 9100, ctr: 0.0137, position: 10.9 },
    { keys: ['2026-09-24'], clicks: 110, impressions: 8700, ctr: 0.0126, position: 11.3 },
  ],
  responseAggregationType: 'byProperty',
  metadata: { firstIncompleteDate: null, firstIncompleteHour: null },
}

const row = (query: string, path: string, c: number, i: number, p: number) => ({
  keys: [query, `${SITE}${path}`],
  clicks: c,
  impressions: i,
  ctr: i > 0 ? Math.round((c / i) * 10000) / 10000 : 0,
  position: p,
})

/**
 * 本周「查询 × 页面」：六个信号各有一行会响（按 seo-core 的默认阈值），外加一个品牌词。
 */
export const THIS_WEEK = {
  rows: [
    // almost_there：排名 7、非品牌、有专门页（handle 对得上）
    row('usb c charger for travel', '/blogs/news/usb-c-charger-for-travel', 40, 900, 7.4),
    // no_clicks：曝光 > 500、点击率 < 0.5%
    row('fast charging cable', '/collections/cables', 2, 1600, 24.0),
    // decaying：上周 60、这周 30（-50%）
    row('magsafe power bank', '/products/magsafe-power-bank', 30, 700, 2.1),
    // untargeted：排名 12，没有一页的 handle 是它
    row('charger that works in europe', '/blogs/news/travel-tips', 6, 300, 12.0),
    // wrong_intent：对比类查询落在商品页
    row('anker vs ugreen', '/products/gan-charger-65w', 3, 400, 25.0),
    // ai_mode：7 个词以上
    row(
      'what is the best charger to bring on a long flight',
      '/blogs/news/travel-tips',
      1,
      60,
      30.0,
    ),
    // 品牌词：不算 almost_there
    row('example shop charger', '/', 200, 800, 1.2),
  ],
  responseAggregationType: 'byPage',
  metadata: { firstIncompleteDate: null, firstIncompleteHour: null },
}

/** 上周：只列了三对（其余的对上周没有行——翻完了就是 0）。 */
export const LAST_WEEK = {
  rows: [
    row('magsafe power bank', '/products/magsafe-power-bank', 60, 720, 1.9),
    row('usb c charger for travel', '/blogs/news/usb-c-charger-for-travel', 38, 880, 7.9),
    row('example shop charger', '/', 190, 780, 1.1),
  ],
  responseAggregationType: 'byPage',
  metadata: { firstIncompleteDate: null, firstIncompleteHour: null },
}

/** 网址检查（Google 原样）。 */
export const INSPECT = {
  indexed: {
    inspectionResult: {
      indexStatusResult: {
        verdict: 'PASS',
        coverageState: 'Submitted and indexed',
        googleCanonical: `${SITE}/products/magsafe-power-bank`,
        userCanonical: `${SITE}/products/magsafe-power-bank`,
      },
    },
  },
  redirect: {
    inspectionResult: {
      indexStatusResult: { verdict: 'NEUTRAL', coverageState: 'Page with redirect' },
    },
  },
  canonical: {
    inspectionResult: {
      indexStatusResult: {
        verdict: 'NEUTRAL',
        coverageState: 'Excluded by ‘noindex’ tag',
        googleCanonical: `${SITE}/collections/all`,
        userCanonical: `${SITE}/collections/cables`,
      },
    },
  },
  not_indexed: {
    inspectionResult: {
      indexStatusResult: { verdict: 'FAIL', coverageState: 'Crawled - currently not indexed' },
    },
  },
}

/** `list_properties`（OpenConnector 归一过的平铺列表）。 */
export const LIST_PROPERTIES = {
  properties: [
    {
      propertyId: '312345678',
      property: 'properties/312345678',
      displayName: 'Example Shop – GA4',
      propertyType: 'PROPERTY_TYPE_ORDINARY',
      parent: 'accounts/100',
      account: 'accounts/100',
      accountDisplayName: 'Example Shop',
      raw: {},
    },
    {
      propertyId: null,
      property: 'properties/400000001',
      displayName: 'Staging',
      propertyType: 'PROPERTY_TYPE_ORDINARY',
      parent: 'accounts/100',
      account: 'accounts/100',
      accountDisplayName: null,
      raw: {},
    },
  ],
  nextPageToken: null,
}

const gaRow = (dims: Record<string, string>, mets: Record<string, string>) => ({
  dimensions: dims,
  metrics: mets,
  dimensionValues: Object.values(dims),
  metricValues: Object.values(mets),
  raw: {},
})

const header = (names: string[]) => names.map((name) => ({ name, type: null }))

/** 落地页报表（自然搜索）：值都是字符串，同官方 `runReport`。 */
export const GA4_LANDING = {
  report: {
    dimensionHeaders: header(['landingPage']),
    metricHeaders: header(['sessions', 'keyEvents', 'ecommercePurchases', 'purchaseRevenue']),
    rows: [
      gaRow(
        { landingPage: '/blogs/news/usb-c-charger-for-travel' },
        { sessions: '52', keyEvents: '4', ecommercePurchases: '2', purchaseRevenue: '118.5' },
      ),
      gaRow(
        { landingPage: '/products/magsafe-power-bank' },
        { sessions: '40', keyEvents: '6', ecommercePurchases: '5', purchaseRevenue: '249.75' },
      ),
      gaRow(
        { landingPage: '(not set)' },
        { sessions: '7', keyEvents: '0', ecommercePurchases: '0', purchaseRevenue: '0' },
      ),
    ],
    rowCount: 3,
    metadata: { currencyCode: 'USD', timeZone: 'America/New_York', raw: {} },
    propertyQuota: null,
    totals: [],
    minimums: [],
    maximums: [],
    raw: {},
  },
}

/** Google 原样（没经 OpenConnector 归一）的同一种报表：`dimensionValues[{ value }]`。 */
export const GA4_LANDING_RAW = {
  dimensionHeaders: [{ name: 'landingPage' }],
  metricHeaders: [{ name: 'sessions' }, { name: 'ecommercePurchases' }],
  rows: [
    {
      dimensionValues: [{ value: '/collections/cables' }],
      metricValues: [{ value: '20' }, { value: '1' }],
    },
  ],
}

/** 总量：两段日期（GA4 自动加 `dateRange` 维度）。 */
export const GA4_TOTALS = {
  report: {
    dimensionHeaders: header(['dateRange']),
    metricHeaders: header(['activeUsers', 'sessions', 'ecommercePurchases', 'purchaseRevenue']),
    rows: [
      gaRow(
        { dateRange: 'current' },
        {
          activeUsers: '1234',
          sessions: '1500',
          ecommercePurchases: '30',
          purchaseRevenue: '1890',
        },
      ),
      gaRow(
        { dateRange: 'previous' },
        {
          activeUsers: '1100',
          sessions: '1320',
          ecommercePurchases: '24',
          purchaseRevenue: '1512.4',
        },
      ),
    ],
    rowCount: 2,
    metadata: { currencyCode: 'USD', timeZone: 'America/New_York', raw: {} },
    propertyQuota: null,
    totals: [],
    minimums: [],
    maximums: [],
    raw: {},
  },
}

/** 事件表。 */
export const GA4_EVENTS = {
  report: {
    dimensionHeaders: header(['eventName']),
    metricHeaders: header(['eventCount', 'keyEvents']),
    rows: [
      gaRow({ eventName: 'page_view' }, { eventCount: '8200', keyEvents: '0' }),
      gaRow({ eventName: 'add_to_cart' }, { eventCount: '310', keyEvents: '0' }),
      gaRow({ eventName: 'purchase' }, { eventCount: '30', keyEvents: '30' }),
    ],
    rowCount: 3,
    metadata: { currencyCode: 'USD', timeZone: 'America/New_York', raw: {} },
    propertyQuota: null,
    totals: [],
    minimums: [],
    maximums: [],
    raw: {},
  },
}
