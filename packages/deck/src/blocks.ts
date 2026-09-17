/**
 * 29 §1 组件注册表 + §2 渲染管线的**校验那一段**，以及 36 §3 的岗位面板装配
 * （面板 Tab 按数据源分块：店铺后台 / GA4 / Search Console / 广告后台）。
 *
 * 29 §7 用例 1：未注册组件名的 Block 直接拒绝写入——`blockDef()` 与 `validateBlock()` 就是那道门。
 */
import type { ComponentDef, RoleId } from '@agentsws/contracts'
import { DeckError } from './errors.js'
import { queryDef, runQuery, sourceStatus } from './queries.js'
import type {
  BlockData,
  BlockDef,
  ComponentName,
  DataSourceId,
  QueryContext,
  QueryData,
  RangeName,
  ViewSection,
} from './types.js'

/** 29 §1：组件只能来自注册表。payload_schema 是 JSON Schema 的最小子集，够描述四种形状。 */
export const COMPONENTS: readonly ComponentDef[] = [
  {
    name: 'stat_tile',
    version: '1.0.0',
    payload_schema: {
      type: 'object',
      required: ['value', 'previous', 'spark'],
      properties: {
        value: { type: 'number' },
        previous: { type: 'number' },
        delta_pct: { type: 'number' },
        spark: { type: 'array', items: { type: 'number' } },
        currency: { type: 'string' },
      },
    },
  },
  {
    name: 'table',
    version: '1.0.0',
    payload_schema: {
      type: 'object',
      required: ['columns', 'rows'],
      properties: { columns: { type: 'array' }, rows: { type: 'array' } },
    },
  },
  {
    name: 'chart_line',
    version: '1.0.0',
    payload_schema: {
      type: 'object',
      required: ['x', 'series'],
      properties: { x: { type: 'array' }, series: { type: 'array' } },
    },
  },
  {
    name: 'timeline',
    version: '1.0.0',
    payload_schema: { type: 'object', required: ['rows'], properties: { rows: { type: 'array' } } },
  },
  {
    name: 'kv',
    version: '1.0.0',
    payload_schema: { type: 'object', required: ['rows'], properties: { rows: { type: 'array' } } },
  },
  {
    name: 'markdown',
    version: '1.0.0',
    payload_schema: { type: 'object', required: ['rows'], properties: { rows: { type: 'array' } } },
  },
]

const COMPONENT_NAMES = new Set<string>(COMPONENTS.map((c) => c.name))

export function isRegisteredComponent(name: string): name is ComponentName {
  return COMPONENT_NAMES.has(name)
}

/** 组件名 → 它能接的查询返回形状。 */
const SHAPE_OF: Record<ComponentName, 'scalar' | 'table' | 'series' | 'records'> = {
  stat_tile: 'scalar',
  table: 'table',
  chart_line: 'series',
  timeline: 'records',
  kv: 'records',
  markdown: 'records',
}

/** 29 §2：按 component.payload_schema 校验 payload。未知组件 → 拒。 */
export function validatePayload(component: string, payload: QueryData): void {
  if (!isRegisteredComponent(component)) {
    throw new DeckError('UNKNOWN_COMPONENT', `组件不在注册表里：${component}`, { component })
  }
  const shape = SHAPE_OF[component]
  const ok =
    shape === 'scalar'
      ? 'value' in payload && 'previous' in payload && 'spark' in payload
      : shape === 'table'
        ? 'columns' in payload && 'rows' in payload
        : shape === 'series'
          ? 'x' in payload && 'series' in payload
          : 'rows' in payload
  if (!ok) {
    throw new DeckError('PAYLOAD_INVALID', `payload 不满足 ${component} 的 payload_schema`, {
      component,
      shape,
    })
  }
}

// ── 数据源与面板 ───────────────────────────────────────────────────────

export const SOURCE_LABELS: Record<DataSourceId, string> = {
  shop: '店铺后台',
  approvals: '工作队列',
  ga4: 'GA4',
  gsc: 'Search Console',
  ads: '广告后台',
  csat: '满意度调查',
  // WP64（51 §2.3 / §2.4）：两个还没接真服务的源。连接目录里有卡、状态是"还没接"，
  // 于是面板上这两块永远走「去连接」那一支——36 §3：明说，不出空图。
  email_marketing: '邮件营销后台',
  tracking: '物流追踪',
  reviews: '评价应用',
  // WP67（48 §5.2）：红人库是我们自己的库，永远算连上；渠道那一侧五个连接器
  // 都还是"待增加"，所以那一块永远走"还没连"那一支（36 §3）。
  kol: '红人库',
  kol_channel: '渠道数据',
  // WP72（56 §2）：我们自己的社媒库永远算连上；八条渠道各一个源，
  // 名字就是用户在连接页上看到的那个名字——"去连接"点过去要对得上。
  social: '社媒库',
  social_meta: 'Meta（FB 主页 + IG）',
  social_tiktok: 'TikTok',
  social_x: 'X',
  social_youtube: 'YouTube',
  social_reddit: 'Reddit',
  social_discord: 'Discord',
  social_telegram: 'Telegram',
  social_whatsapp: 'WhatsApp',
  // WP75（57 §1）：四个平台各一个源。名字就是用户在连接页上看到的那个名字——
  // "去连接"点过去要对得上
  ads_meta: 'Meta Ads',
  ads_google: 'Google Ads',
  ads_x: 'X Ads',
  ads_tiktok: 'TikTok Ads',
  // WP78（60 §3）：我们自己的公关库永远算连上；外面那一侧是 Google Alerts，
  // 名字就是用户在连接页上看到的那个名字——"去连接"点过去要对得上。
  pr: '公关库',
  google_alerts: 'Google Alerts',
}

/** 「查看完整报告 →」外链（36 §3 三层链路的最后一层）。 */
export const SOURCE_REPORT_URLS: Partial<Record<DataSourceId, string>> = {
  shop: 'https://admin.shopify.com',
  ga4: 'https://analytics.google.com',
  gsc: 'https://search.google.com/search-console',
  ads: 'https://adsmanager.facebook.com',
  email_marketing: 'https://www.klaviyo.com/dashboard',
  tracking: 'https://admin.aftership.com/trackings',
  // WP75：各平台的后台首页（36 §3 三层链路的最后一层）
  ads_meta: 'https://adsmanager.facebook.com',
  ads_google: 'https://ads.google.com',
  ads_x: 'https://ads.x.com',
  ads_tiktok: 'https://ads.tiktok.com',
}

const block = (id: string, component: ComponentName, title: string, query: string): BlockDef => {
  const def = queryDef(query)
  const report_url = SOURCE_REPORT_URLS[def.source]
  return {
    id,
    placement: 'role_view',
    component,
    title,
    query,
    source: def.source,
    ...(report_url === undefined ? {} : { report_url }),
  }
}

const SHOP_BLOCKS = (): BlockDef[] => [
  block('shop.sales_trend', 'chart_line', '销售走势（近 7 天）', 'sales.trend'),
  block('shop.recent_orders', 'table', '最近订单', 'orders.recent'),
  block('shop.overdue_orders', 'table', '超期未发', 'orders.overdue'),
  block('shop.sales_total', 'stat_tile', '总销售额', 'sales.total'),
]

/**
 * WP63（51 §2.1 面板）：待审改动**四条车道**。
 *
 * 为什么分车道而不是一张大表：这四种卡该看的东西不一样——文案看 diff、改价看幅度、
 * 上下架看影响面、促销看力度与限量。混成一张「待审 12 条」，人只能一张张点开看
 * 它到底是哪一类。
 */
const STORE_QUEUE_BLOCKS = (): BlockDef[] => [
  block('store.pending_listing', 'table', '待审：文案与详情页', 'changes.pending_listing'),
  block('store.pending_price', 'table', '待审：改价', 'changes.pending_price'),
  block('store.pending_publish', 'table', '待审：上下架', 'changes.pending_publish'),
  block('store.pending_promotion', 'table', '待审：促销与折扣', 'changes.pending_promotion'),
]

/** WP63：库存告急表 + 日报卡（日报是 L3 自动出、看完归档的那一张）。 */
const STORE_SHOP_BLOCKS = (): BlockDef[] => [
  block('store.low_stock', 'table', '库存告急', 'inventory.low_stock'),
  block('store.daily_report', 'table', '今日日报', 'store.daily_report'),
]

/** WP63：差评表。评价应用连接器待增加 → 这一块永远出"还没连"，不出空表。 */
const REVIEW_BLOCKS = (): BlockDef[] => [
  block('store.bad_reviews', 'table', '差评', 'reviews.negative'),
]

/** WP63（51 §2.2 面板）：草稿队列、待发布、近 30 天发布与流量。 */
const CONTENT_BLOCKS = (): BlockDef[] => [
  block('content.drafts', 'table', '草稿队列', 'content.drafts'),
  block('content.recent_posts', 'table', '近 30 天发布与流量', 'content.recent_posts'),
]

const CONTENT_QUEUE_BLOCKS = (): BlockDef[] => [
  block('content.pending_publish', 'table', '待发布', 'changes.pending_publish_post'),
]

const GA4_BLOCKS = (): BlockDef[] => [
  block('ga4.active_users', 'stat_tile', '活跃用户', 'analytics.active_users'),
  block('ga4.events', 'table', '事件', 'analytics.events'),
]

const GSC_BLOCKS = (): BlockDef[] => [
  block('gsc.queries', 'table', '查询词', 'gsc.top_queries'),
  block('gsc.landing_pages', 'table', '落地页', 'gsc.landing_pages'),
]

/**
 * WP75（57 §3 面板）：投放那**四个数字块 + 五个分块**。
 *
 * 四条平台职责共用这一组积木（骨架相同，57 §1）。分块**不按平台再拆一遍**：
 * 一个人手上挂着 Meta 与 Google 两条职责时，他看到的是两个岗位视图、每个视图里
 * 各九块——而不是一个视图里十八块（同 48 §5.1 红人那条）。
 *
 * 分两层，因为"没连就明说"这句话只对得上其中一层（36 §3）：
 *
 * - **我们自己算出来的那几块**（今日花费 / 总闸剩余、campaign 表、待审四车道、
 *   止损记录、归因、日报）走 `ads` 这个源。
 * - **平台那一侧那两块**（转化数、像素健康）走**这条职责自己的平台源**
 *   （`ads_meta` / `ads_google`…）：连上 Meta 不会把 Google 的像素那一块点亮。
 *
 * 为什么"今日花费"走 `ads` 而不是平台源：它是**岗位级总闸**的那一格，
 * 四个平台加起来算的（04 §5）。挂到某一个平台源上，那个平台没连就整格没了——
 * 而总闸这件事恰恰在只连了一个平台的时候也成立。
 */
const ADS_POSITION_BLOCKS = (platform: string): BlockDef[] => [
  block(`ads.${platform}.spend_today`, 'stat_tile', '今日花费 / 总闸剩余', 'ads.spend_today'),
  block(`ads.${platform}.roas`, 'stat_tile', 'ROAS（两口径）', 'ads.roas_two_views'),
  block(`ads.${platform}.conversions`, 'stat_tile', '转化数', `ads.conversions.${platform}`),
  block(`ads.${platform}.stop_losses`, 'stat_tile', '止损次数', 'ads.stop_loss_count'),
  block(`ads.${platform}.campaigns`, 'table', 'campaign', 'ads.campaigns'),
  block(`ads.${platform}.pending`, 'table', '待审改动', 'ads.pending_changes'),
  block(`ads.${platform}.stop_loss_log`, 'table', '止损记录', 'ads.stop_loss_log'),
  block(`ads.${platform}.pixels`, 'table', '像素健康', `ads.pixel_health.${platform}`),
  block(`ads.${platform}.daily_report`, 'table', '日报', 'ads.daily_report'),
]

/** WP64（51 §2.3）：邮件营销面板——待审发送、自动流状态、近 30 天效果。 */
const EMAIL_BLOCKS = (): BlockDef[] => [
  block('email.pending_sends', 'stat_tile', '待审发送', 'email.pending_sends'),
  block('email.flows', 'table', '自动流状态', 'email.flows'),
  block('email.performance_30d', 'table', '近 30 天效果', 'email.campaign_performance'),
]

/** WP64（51 §2.4）：订单履约面板——待发货、超期未发（已有积木）、物流异常、今日发货数。 */
const FULFILLMENT_BLOCKS = (): BlockDef[] => [
  block('fulfillment.unfulfilled', 'table', '待发货', 'orders.unfulfilled'),
  // 「超期未发」用的就是 WP20 那条 `orders.overdue`：同一个判据不写第二遍
  block('shop.overdue_orders', 'table', '超期未发', 'orders.overdue'),
  block('fulfillment.shipped_today', 'stat_tile', '今日发货数', 'fulfillments.today'),
  block('fulfillment.exceptions', 'table', '物流异常', 'shipments.exceptions'),
]

/**
 * WP67（48 §5.1 面板五个分块）：找人 / 建联 / 合作 / 审核 / 归因。
 *
 * 五条渠道职责共用这一组积木（骨架相同，48 §5.1）。分块**不按渠道再拆一遍**：
 * 一个人手上挂着 YouTube 与 Instagram 两条职责时，他看到的是两个岗位视图，
 * 每个视图里各五块——而不是一个视图里十块。
 *
 * 五块全走 `kol` 这个源（我们自己的库，永远算连上）。**渠道那一侧的数据一块都不放**：
 * 五个连接器都还是"待增加"，放进来就是五块永远写着"还没连"的空表，
 * 而这条职责没有连接器照样干得了活（导入 + 公共库）。
 */
const KOL_BLOCKS = (): BlockDef[] => [
  block('kol.discovery', 'table', '找人清单', 'kol.discovery'),
  block('kol.funnel', 'table', '建联漏斗', 'kol.outreach_funnel'),
  block('kol.collaborations', 'table', '合作进行中', 'kol.collaborations'),
  block('kol.pending_deliverables', 'table', '待审交付物', 'kol.pending_deliverables'),
  block('kol.attribution', 'table', '归因', 'kol.attribution'),
]

/**
 * WP72（56 §2 面板）：**内容账号组**四块 + 转客服计数。
 *
 * 前三块与最后一块走 `social` 这个源（我们自己的库，永远算连上）；
 * "近 30 天表现"走**这条渠道自己的源**——TikTok 没连时它照 36 §3 出「去连接」，
 * 而内容日历照样有数：那是我们自己排的。两件事分得开，是这一层存在的理由。
 *
 * 按渠道传入而不是九条各写一遍：九条职责的面板骨架完全相同（56 §2），
 * 不同的只有"表现"那一块读哪个源。
 */
const SOCIAL_CONTENT_BLOCKS = (channel: string): BlockDef[] => [
  block(`social.${channel}.calendar`, 'table', '内容日历', 'social.content_calendar'),
  block(`social.${channel}.queue`, 'table', '待发布', 'social.publish_queue'),
  block(
    `social.${channel}.performance`,
    'table',
    '近 30 天表现',
    `social.performance_30d.${channel}`,
  ),
  block(`social.${channel}.comments`, 'table', '待回评论', 'social.pending_comments'),
  block(`social.${channel}.handoffs`, 'table', '转客服', 'social.support_handoffs'),
]

/**
 * WP72（56 §2 面板）：**社群组**五块。
 *
 * 四块走我们自己的库，"活跃度"走这条渠道自己的源（同上一条的理由）。
 *
 * Facebook 群组没有自己的源（Groups API 已停，走受控浏览器），所以它的面板上
 * **没有活跃度那一块**——不是漏了：给它一块永远写着"还没连"的空表，比没有更糟
 * （36 §3）。那一块的数要等 WP73 的浏览器执行器。
 */
const SOCIAL_COMMUNITY_BLOCKS = (channel: string, source?: string): BlockDef[] => [
  block(`social.${channel}.pending_members`, 'table', '待审入群', 'social.pending_members'),
  block(`social.${channel}.threads`, 'table', '待处理', 'social.pending_threads'),
  block(`social.${channel}.broadcasts`, 'table', '群发队列', 'social.broadcast_queue'),
  ...(source === undefined
    ? []
    : [
        block(
          `social.${channel}.activity`,
          'table',
          '活跃度',
          `social.community_activity.${channel}`,
        ),
      ]),
  block(`social.${channel}.handoffs`, 'table', '转客服', 'social.support_handoffs'),
]

/**
 * WP72（56 §4）：客服的「社群管理」面板。
 *
 * 第一块就是转客服卡——这条职责的活多数从那里来。后面跟着店铺后台那几块：
 * 答订单、物流、退换货离不开它们（这条职责的 scopes 里订单是只读的）。
 *
 * **一块社媒运营的积木都不放**：内容日历、群发队列、待审入群不是它的事
 * （56 边界行），而且它的 scopes 里没有 `social_account` 域——19 §3 说无权的
 * 数据源连「去连接」都不该出。
 */
const COMMUNITY_SUPPORT_BLOCKS = (): BlockDef[] => [
  block('community_support.handoffs', 'table', '转过来的客户问题', 'social.support_handoffs'),
]

/**
 * WP78（60 §3 面板）：公关那五块。
 *
 * 分两层，理由与社媒那九块逐字相同（36 §3「没连就明说」只对得上其中一层）：
 *
 * - **我们自己库里那四块**（待发新闻稿 / pitch 漏斗 / 外部露出 / 负面预警）
 *   走 `pr` 这个源——它永远算连上。一个平台都没连，稿子照样写得出来：
 *   **那是我们自己写的**；一条预警也是我们自己判出来并开出来的卡。
 * - **外面那一侧那一块**（提及流）走 `google_alerts`。没连的时候它照 36 §3
 *   出「去连接」——一张空的提及流等于说"今天没人提我们"，而那是这条职责上
 *   最贵的一种谎。同一屏上的待发新闻稿照样有数。
 *
 * 四条职责各挑自己那几块（`VIEW_BY_ROLE` 里那四行），不是四条都摆五块：
 * 一个人同时挂着新闻稿与品牌监控时，他看到的是**两个岗位视图**，
 * 每个视图里各几块（同 56 / 48 §5.1 的那条）。
 */
const PR_PRESS_BLOCKS = (): BlockDef[] => [
  block('pr.press.releases', 'table', '待发新闻稿', 'pr.release_queue'),
  block('pr.press.funnel', 'table', 'pitch 漏斗', 'pr.pitch_funnel'),
  block('pr.press.mentions', 'table', '外面在说什么', 'pr.mentions'),
]

const PR_OUTREACH_BLOCKS = (): BlockDef[] => [
  block('pr.external.posts', 'table', '外部露出与反馈', 'pr.external_posts'),
  block('pr.external.mentions', 'table', '外面在说什么', 'pr.mentions'),
]

const PR_MONITORING_BLOCKS = (): BlockDef[] => [
  block('pr.monitoring.alerts', 'table', '负面预警', 'pr.negative_alerts'),
  block('pr.monitoring.mentions', 'table', '提及流', 'pr.mentions'),
  block('pr.monitoring.handoffs', 'table', '转客服', 'pr.support_handoffs'),
]

const QUEUE_BLOCKS = (): BlockDef[] => [
  block('records.timeline', 'timeline', '记录', 'records.timeline'),
]

/** 36 §3：面板 Tab 按数据源分块，块内「查看完整报告 →」外链。 */
const VIEW_BY_ROLE: Record<RoleId, () => BlockDef[]> = {
  // 售后客服的职责里没有 analytics 域（05 §5），所以它的面板只有店铺后台——
  // 无权的数据源连「去连接」都不该出（19 §3 过滤下推：不是先给再脱敏）。
  'dtc.support': () => SHOP_BLOCKS(),
  'dtc.analytics': () => [...SHOP_BLOCKS(), ...GA4_BLOCKS(), ...GSC_BLOCKS()],
  /*
   * WP75（57 §3）：四条平台职责，面板骨架相同（四个数字块 + 五个分块）。
   *
   * 一块店铺后台的积木都不放：投放的 scopes 里订单是**只读**的（归因要它），
   * 没有 store_config / inventory / product 的写——19 §3 说无权的数据源连
   * 「去连接」都不该出。GA4 留着：转化与落地页那一侧的数在它那儿。
   */
  'ads.meta': () => [...ADS_POSITION_BLOCKS('meta'), ...GA4_BLOCKS()],
  'ads.google': () => [...ADS_POSITION_BLOCKS('google'), ...GA4_BLOCKS()],
  'ads.x': () => ADS_POSITION_BLOCKS('x'),
  'ads.tiktok': () => ADS_POSITION_BLOCKS('tiktok'),
  // WP64（51 §2.3 / §2.4）：两条新职责各自的面板。
  //
  // 邮件营销看得到店铺后台（弃购挽回要知道购物车里是什么），但看不到 GA4 / 广告——
  // 职责的 scopes 里没有那两个域，无权的数据源连「去连接」都不该出（19 §3）。
  'dtc.email-marketing': () => [...EMAIL_BLOCKS(), ...SHOP_BLOCKS()],
  'dtc.fulfillment': () => [...FULFILLMENT_BLOCKS()],
  // WP63（51 §2.1）：店铺管理的面板 = 店铺后台（含库存告急与日报）+ 待审四条车道
  // + 转化那一格（GA4）+ 差评（评价应用，今天必然是"还没连"）
  'dtc.store': () => [
    ...SHOP_BLOCKS(),
    ...STORE_SHOP_BLOCKS(),
    ...STORE_QUEUE_BLOCKS(),
    ...GA4_BLOCKS(),
    ...REVIEW_BLOCKS(),
  ],
  // WP63（51 §2.2）：内容与博客的面板 = 草稿与发布（店铺后台）+ 待发布队列 + 流量（GSC）
  'dtc.content': () => [...CONTENT_BLOCKS(), ...CONTENT_QUEUE_BLOCKS(), ...GSC_BLOCKS()],
  // WP67（48 §5.1）：五条渠道职责，面板骨架相同（找人 / 建联 / 合作 / 审核 / 归因）。
  //
  // 一块店铺后台的积木都不放：红人这条职责的 scopes 里订单是**只读**、没有
  // store_config / inventory，19 §3 说无权的数据源连「去连接」都不该出。
  // 归因要读订单，但那是 `kol.attribution` 自己算完之后的数，不是店铺面板。
  'kol.youtube': () => KOL_BLOCKS(),
  'kol.facebook': () => KOL_BLOCKS(),
  'kol.instagram': () => KOL_BLOCKS(),
  'kol.tiktok': () => KOL_BLOCKS(),
  'kol.x': () => KOL_BLOCKS(),
  /*
   * WP72（56 §2）：九条社媒渠道职责，两组骨架各自相同。
   *
   * 一块店铺后台的积木都不放：社媒运营的 scopes 里没有 order / store_config
   * （产品是只读的，也不该有面板），19 §3 说无权的数据源连「去连接」都不该出。
   */
  'social.meta': () => SOCIAL_CONTENT_BLOCKS('meta'),
  'social.tiktok': () => SOCIAL_CONTENT_BLOCKS('tiktok'),
  'social.x': () => SOCIAL_CONTENT_BLOCKS('x'),
  'social.youtube': () => SOCIAL_CONTENT_BLOCKS('youtube'),
  // Facebook 群组没有渠道源（没有连接器）：少一块活跃度，不出空表
  'social.facebook-group': () => SOCIAL_COMMUNITY_BLOCKS('facebook_group'),
  'social.reddit': () => SOCIAL_COMMUNITY_BLOCKS('reddit', 'social_reddit'),
  'social.discord': () => SOCIAL_COMMUNITY_BLOCKS('discord', 'social_discord'),
  'social.telegram-group': () => SOCIAL_COMMUNITY_BLOCKS('telegram_group', 'social_telegram'),
  'social.whatsapp': () => SOCIAL_COMMUNITY_BLOCKS('whatsapp', 'social_whatsapp'),
  // WP72（56 §4）：客服的社群管理——转客服卡 + 店铺后台（答订单离不开它）
  'dtc.community-support': () => [...COMMUNITY_SUPPORT_BLOCKS(), ...SHOP_BLOCKS()],
  /*
   * WP78（60 §3）：公关四条职责。
   *
   * 一块店铺后台的积木都不放：公关的 scopes 里没有 order / customer
   * （60 分界行——客户的问题转客服），19 §3 说无权的数据源连「去连接」都不该出。
   * `pr.reddit` 与 `pr.forums` 的面板一模一样：它们干的是同一件事，
   * 只是一个有接口、一个走浏览器。
   */
  'pr.press': () => PR_PRESS_BLOCKS(),
  'pr.reddit': () => PR_OUTREACH_BLOCKS(),
  'pr.forums': () => PR_OUTREACH_BLOCKS(),
  'pr.monitoring': () => PR_MONITORING_BLOCKS(),
}

export function blocksForRole(role_id: RoleId): BlockDef[] {
  return (VIEW_BY_ROLE[role_id] ?? SHOP_BLOCKS)()
}

export function allBlocks(): BlockDef[] {
  const out = new Map<string, BlockDef>()
  for (const role of Object.keys(VIEW_BY_ROLE)) {
    for (const b of blocksForRole(role)) out.set(b.id, b)
  }
  for (const b of QUEUE_BLOCKS()) out.set(b.id, b)
  return [...out.values()]
}

export function blockDef(id: string): BlockDef {
  const found = allBlocks().find((b) => b.id === id)
  if (found === undefined) {
    throw new DeckError('UNKNOWN_COMPONENT', `没有这个积木：${id}`, { id })
  }
  return found
}

/** 岗位面板：按数据源分块，未连接的块只出「去连接」，不出空图（36 §3）。 */
export function assembleView(role_id: RoleId, ctx: QueryContext): ViewSection[] {
  const sections = new Map<DataSourceId, ViewSection>()
  for (const b of blocksForRole(role_id)) {
    const existing = sections.get(b.source)
    if (existing === undefined) {
      const connected = sourceStatus(ctx, b.source)
      const report_url = SOURCE_REPORT_URLS[b.source]
      // WP62：数据源自带的那一句"还没做"（平台没接）原样端到面板上——
      // 36 §3 的老规矩：缺连接器就明说，不出一块永远为空的图
      const note = ctx.sources.find((s) => s.id === b.source)?.note
      sections.set(b.source, {
        source: b.source,
        label: SOURCE_LABELS[b.source],
        connected,
        ...(report_url === undefined || !connected ? {} : { report_url }),
        ...(note === undefined ? {} : { note }),
        blocks: [b],
      })
    } else {
      existing.blocks.push(b)
    }
  }
  return [...sections.values()]
}

/** 29 §2 全管线：命名查询 → 连接判定 → payload_schema 校验 → 返回 payload。 */
export function computeBlock(id: string, ctx: QueryContext, range: RangeName): BlockData {
  const def = blockDef(id)
  const result = runQuery(def.query, ctx, range)
  if (result.status !== 'ok') return { block: def, range, status: 'not_connected' }
  validatePayload(def.component, result.data)
  return { block: def, range, status: 'ok', payload: result.data }
}
