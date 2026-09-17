/**
 * 数据源的连接状态从**真实连接**算（WP20）。
 *
 * 36 §3：「数据源没接（连接未建）时显示『去连接』卡而不是空图」。在 WP20 之前，
 * `DataSourceStatus` 是装配方写死的一张表；现在它由工作区里真有哪些连接决定——
 * 连上 Shopify，首页的销售数字块就不再是「去连接」；断开了就变回去。
 *
 * 这一层仍然**没有 IO**：调用方把连接清单（只要 service 与状态，绝无凭据）递进来，
 * 这里只做「哪个 service 喂哪个数据源」的映射。
 */
import { SOURCE_LABELS, SOURCE_REPORT_URLS } from './blocks.js'
import type { DataSourceId, DataSourceStatus } from './types.js'

/**
 * service → 数据源。
 *
 * 左边是我们对外的 provider id（`apps/server` 的连接目录），不是 OpenConnector 的
 * 上游 service 名——上游叫 `google_analytics` / `google_search_console` / `meta`，
 * 那层映射在装配方，不在 deck 里。
 */
export const SOURCES_BY_SERVICE: Readonly<Record<string, readonly DataSourceId[]>> = {
  shopify_admin: ['shop'],
  shopify: ['shop'],
  ga4: ['ga4'],
  google_analytics: ['ga4'],
  gsc: ['gsc'],
  google_search_console: ['gsc'],
  meta_ads: ['ads'],
  meta: ['ads'],
  googleads: ['ads'],
  // WP64（51 §2.3 / §2.4）：连接器骨架。这两行现在没有一条真连接会命中——
  // 目录里那几张卡的状态是"还没接"——但映射先立着：接上那天只改连接目录，不改 deck。
  klaviyo: ['email_marketing'],
  shopify_email: ['email_marketing'],
  aftership: ['tracking'],
  track17: ['tracking'],
  // WP67（48 §5.1）/ WP68：五条渠道。WP68 起这五张卡在连接目录里是**可连**的，
  // 所以这张映射现在真的会命中——连上哪一条，面板那一块就亮哪一条。
  youtube_data: ['kol_channel', 'social_youtube'],
  instagram_graph: ['kol_channel'],
  tiktok_research: ['kol_channel'],
  facebook_graph: ['kol_channel'],
  // WP72：`youtube_data` 与 `x_api` **一张卡喂两条职责**（56 §1）——红人那条读别人的，
  // 社媒运营那条读写我们自己的。连一次，两处都亮；写成两张卡的话用户会连两遍。
  x_api: ['kol_channel', 'social_x'],
  // WP72（56 §1）：社媒运营那六张新卡，一张喂一个渠道源。
  // Facebook 群组不在这里——它没有连接器（Groups API 已停），走受控浏览器。
  meta_graph: ['social_meta'],
  tiktok_content: ['social_tiktok'],
  reddit: ['social_reddit'],
  discord_bot: ['social_discord'],
  telegram_bot: ['social_telegram'],
  whatsapp_business: ['social_whatsapp'],
  // WP75（57 §1）：投放那四张卡，一张喂一个平台源。
  // 旧的 `meta_ads` / `meta` / `googleads` 三行（上面）喂的是首页那个 `ads` 源，
  // 不动——那是"广告后台只读"，与这四条"能动预算"的连接是两件事。
  meta_marketing: ['ads_meta', 'ads'],
  google_ads: ['ads_google', 'ads'],
  x_ads: ['ads_x'],
  tiktok_ads: ['ads_tiktok'],
}

/**
 * WP75（57 §1）：平台 id（契约 `AdsPlatform`）→ 那个平台的数据源。
 *
 * 与 {@link SOCIAL_SOURCE_BY_CHANNEL} 同一条理由显式写出来、不靠字符串拼：
 * 拼错了不会报错，只会让那一块永远显示"还没连"。
 */
export const ADS_SOURCE_BY_PLATFORM: Readonly<Record<string, DataSourceId>> = {
  meta: 'ads_meta',
  google: 'ads_google',
  x: 'ads_x',
  tiktok: 'ads_tiktok',
}

/**
 * WP72（56 §1）：渠道 id（契约 `SocialChannel`）→ 那条渠道的数据源。
 *
 * 多数是 `social_` 加渠道 id，但**不是全部**：`telegram_group` 的源叫
 * `social_telegram`（源说的是"连的是哪家平台"，不是"这条职责管的是群还是频道"）。
 * 所以这张表显式写出来，不靠字符串拼——拼出来的 `social_telegram_group`
 * 在别处一个都对不上，而这种错不会报，只会让那一块永远显示"还没连"。
 *
 * Facebook 群组不在表里：它没有连接器（Groups API 已停），平台那一侧的数要等
 * WP73 的浏览器执行器。
 */
export const SOCIAL_SOURCE_BY_CHANNEL: Readonly<Record<string, DataSourceId>> = {
  meta: 'social_meta',
  tiktok: 'social_tiktok',
  x: 'social_x',
  youtube: 'social_youtube',
  reddit: 'social_reddit',
  discord: 'social_discord',
  telegram_group: 'social_telegram',
  whatsapp: 'social_whatsapp',
}

/**
 * 我们自己的库，永远算连上。
 *
 * WP67 加进 `kol`：红人库就在这台机器上（六张表，`apps/server/src/kol.ts`），
 * 没有"去连接"这回事。**空的红人库与没连的渠道是两件事**——前者说"还没有人，
 * 先导入一张表"，后者说"去连接页把 YouTube 连上"，界面上那两句话不能混。
 *
 * WP72 加进 `social`：社媒库同理（四张表，`apps/server/src/social.ts`）。
 * 内容日历上那几条是**我们自己排的**，一个平台都没连也照样在那儿摆着。
 */
export const ALWAYS_CONNECTED: readonly DataSourceId[] = ['approvals', 'kol', 'social']

/** 全部数据源，按面板里的出场顺序。 */
export const ALL_DATA_SOURCES: readonly DataSourceId[] = [
  'shop',
  'approvals',
  'ga4',
  'gsc',
  'ads',
  'csat',
  'email_marketing',
  'tracking',
  'reviews',
  'kol',
  'kol_channel',
  // WP72（56 §2）：我们自己的社媒库 + 八条渠道各一个源（Facebook 群组没有连接器）
  'social',
  'social_meta',
  'social_tiktok',
  'social_x',
  'social_youtube',
  'social_reddit',
  'social_discord',
  'social_telegram',
  'social_whatsapp',
  // WP75（57 §1）：四个平台各一个源
  'ads_meta',
  'ads_google',
  'ads_x',
  'ads_tiktok',
]

/**
 * WP63（51 §2.1 评价管理 / §3 N2）：**还没做**的数据源那一句人话。
 *
 * 与"没连"分得开（`DataSourceStatus.note` 的注释里那一条）：评价应用不是用户忘了
 * 去连，是连接目录里压根还没有这张卡。给一个「去连接」按钮才是骗人。
 */
export const PLANNED_SOURCE_NOTES: Partial<Record<DataSourceId, string>> = {
  reviews:
    '评价应用（Judge.me / Loox）还没接上——连接目录里已经登记为"待增加"，接上了这一块自己就有数了。',
}

/** 算连接状态时只认这个形状——**没有也不可能有凭据字段**。 */
export interface ConnectionLike {
  service: string
  status?: 'active' | 'reauth_required' | 'disabled'
}

/** 这条连接喂哪些数据源（不认识的 service 喂不了任何一个，返回空）。 */
export function dataSourcesOfService(service: string): readonly DataSourceId[] {
  return SOURCES_BY_SERVICE[service] ?? []
}

/**
 * 连接清单 → `DataSourceStatus[]`。
 *
 * 只有 `status === 'active'` 才算连上：需要重新授权的连接跟没连一样出「去连接」，
 * 否则界面会显示一个永远为 0 的数字块，比空图更糟。
 */
export function dataSourcesFromConnections(
  connections: readonly ConnectionLike[],
  options: { sources?: readonly DataSourceId[]; storefrontNote?: string } = {},
): DataSourceStatus[] {
  const connected = new Set<DataSourceId>(ALWAYS_CONNECTED)
  for (const c of connections) {
    if (c.status !== undefined && c.status !== 'active') continue
    for (const s of dataSourcesOfService(c.service)) connected.add(s)
  }
  return (options.sources ?? ALL_DATA_SOURCES).map((id) => {
    // WP62（51 §1 N0 ③）：这个工作区的网站平台我们还没接 → 「店铺后台」永远算没连，
    // 并带上那一句人话。给「去连接」按钮才是骗人：点进去也没有这个平台的卡。
    const unsupported = id === 'shop' && options.storefrontNote !== undefined
    // WP63：连接目录里还没有这张卡的数据源（评价应用）——永远算没连，并带上那句话
    const planned = PLANNED_SOURCE_NOTES[id]
    const on = !unsupported && planned === undefined && connected.has(id)
    const report_url = SOURCE_REPORT_URLS[id]
    const note = unsupported ? options.storefrontNote : planned
    return {
      id,
      label: SOURCE_LABELS[id],
      connected: on,
      // 没连上就别给「查看完整报告」——点进去也是别人的后台登录页
      ...(on && report_url !== undefined ? { report_url } : {}),
      ...(note === undefined ? {} : { note }),
    }
  })
}

/**
 * 把**我们自己的**那几个数据源补进一份既有的表里。
 *
 * WP67：demo 接进来的合成世界、`emptyDataSource()` 这两份写死的表是 WP20 之前
 * 留下来的，它们列的是"有哪些连接"。红人库不是连接（它就在这台机器上），
 * 所以那两份表里不会有它——不补的话，红人面板五块全显示「去连接」，
 * 而那个按钮点进去无处可点。补进来的一律 `connected: true`（`ALWAYS_CONNECTED`）。
 *
 * 已经在表里的不动：调用方自己写了什么状态就是什么状态。
 */
export function withOwnSources(base: readonly DataSourceStatus[]): DataSourceStatus[] {
  const have = new Set(base.map((s) => s.id))
  const missing = ALWAYS_CONNECTED.filter((id) => !have.has(id)).map((id) => ({
    id,
    label: SOURCE_LABELS[id],
    connected: true,
  }))
  return [...base, ...missing]
}

/**
 * 把真实连接算出来的状态盖到一份既有表上（demo / 测试里那份写死的表）。
 *
 * 规则是**只加不减**：底表里已经 `connected: true` 的（比如 demo 里由合成世界喂的店铺后台）
 * 保持连上；真实连接再把别的源点亮。这样接一个连接不会把 demo 的数据打没。
 */
export function mergeDataSources(
  base: readonly DataSourceStatus[],
  connections: readonly ConnectionLike[],
): DataSourceStatus[] {
  const computed = new Map(dataSourcesFromConnections(connections).map((s) => [s.id, s] as const))
  return base.map((s) => {
    const live = computed.get(s.id)
    if (live === undefined || !live.connected || s.connected) return s
    return {
      ...s,
      connected: true,
      ...(live.report_url === undefined ? {} : { report_url: live.report_url }),
    }
  })
}
