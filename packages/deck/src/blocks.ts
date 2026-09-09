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
}

/** 「查看完整报告 →」外链（36 §3 三层链路的最后一层）。 */
export const SOURCE_REPORT_URLS: Partial<Record<DataSourceId, string>> = {
  shop: 'https://admin.shopify.com',
  ga4: 'https://analytics.google.com',
  gsc: 'https://search.google.com/search-console',
  ads: 'https://adsmanager.facebook.com',
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

const QUEUE_BLOCKS = (): BlockDef[] => [
  block('records.timeline', 'timeline', '记录', 'records.timeline'),
]

/** 36 §3：面板 Tab 按数据源分块，块内「查看完整报告 →」外链。 */
const VIEW_BY_ROLE: Record<RoleId, () => BlockDef[]> = {
  // 售后客服的职责里没有 analytics 域（05 §5），所以它的面板只有店铺后台——
  // 无权的数据源连「去连接」都不该出（19 §3 过滤下推：不是先给再脱敏）。
  'dtc.aftersales': () => SHOP_BLOCKS(),
  'dtc.analytics': () => [...SHOP_BLOCKS(), ...GA4_BLOCKS(), ...GSC_BLOCKS()],
  'ads.meta': () => [...ADS_BLOCKS(), ...GA4_BLOCKS()],
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
      sections.set(b.source, {
        source: b.source,
        label: SOURCE_LABELS[b.source],
        connected,
        ...(report_url === undefined || !connected ? {} : { report_url }),
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
