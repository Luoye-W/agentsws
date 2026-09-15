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
}

/** 「查看完整报告 →」外链（36 §3 三层链路的最后一层）。 */
export const SOURCE_REPORT_URLS: Partial<Record<DataSourceId, string>> = {
  shop: 'https://admin.shopify.com',
  ga4: 'https://analytics.google.com',
  gsc: 'https://search.google.com/search-console',
  ads: 'https://adsmanager.facebook.com',
  email_marketing: 'https://www.klaviyo.com/dashboard',
  tracking: 'https://admin.aftership.com/trackings',
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

const ADS_BLOCKS = (): BlockDef[] => [
  block('ads.spend', 'stat_tile', '花费', 'ads.spend'),
  block('ads.trend', 'chart_line', '投放走势', 'ads.trend'),
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

const QUEUE_BLOCKS = (): BlockDef[] => [
  block('records.timeline', 'timeline', '记录', 'records.timeline'),
]

/** 36 §3：面板 Tab 按数据源分块，块内「查看完整报告 →」外链。 */
const VIEW_BY_ROLE: Record<RoleId, () => BlockDef[]> = {
  // 售后客服的职责里没有 analytics 域（05 §5），所以它的面板只有店铺后台——
  // 无权的数据源连「去连接」都不该出（19 §3 过滤下推：不是先给再脱敏）。
  'dtc.support': () => SHOP_BLOCKS(),
  'dtc.analytics': () => [...SHOP_BLOCKS(), ...GA4_BLOCKS(), ...GSC_BLOCKS()],
  'ads.meta': () => [...ADS_BLOCKS(), ...GA4_BLOCKS()],
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
