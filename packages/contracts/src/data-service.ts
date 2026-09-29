/**
 * WP192（docs/83 §4、docs/75）：**Agents 工坊官方数据接口的统一能力口**——同步调用与异步任务。
 *
 * 本机只认**能力**（`maps.places`、`serp.google`、`amazon.reviews`……），不认上游是哪一家：
 * 云上一个能力可以有好几条渠道（同一家上游的不同账号、或不同的上游），按权重分流、失败自动换下一家；
 * 换上游不用本机发版。对外叫法照 docs/75 §4：只叫「Agents 工坊官方数据接口」，响应里的 `source`
 * 固定是 `official`，错误信息里不出现上游名。
 *
 * 两种调用形态：
 *
 * - **同步**（查一次就回，如搜索结果页）：`POST /v1/data/call/{capability}`；
 * - **异步任务**（要跑一阵子、按条计费，如抓 Google 地图商家）：`POST /v1/data/tasks` 提交
 *   （带幂等键）→ `GET /v1/data/tasks/{id}` 看状态 → `GET /v1/data/tasks/{id}/items` 分页取结果；
 *   `POST /v1/data/tasks/{id}/cancel` 取消。
 *
 * 钱（与 docs/75 §2 同一套规矩）：同步先预扣再取数，命中共享缓存照价收，失败 / 0 条不收；
 * 异步提交时按上限条数预扣，跑完按实际条数结算、多扣的退回，失败 / 超时全退，取消时已经拿到的那几条照收。
 *
 * **只加不删**（契约纪律）。
 */

import type { DataSourceLevel } from './cloud-entry.js'
import type { Iso8601 } from './common.js'

/** 令牌要带的动作集：与公共红人库、搜索数据同一个 `data`。 */
export const DATA_SERVICE_SCOPE = 'data' as const

/** 云端路径。`call` 后面接 `/{capability}`，`tasks` 后面接 `/{id}`、`/{id}/items`、`/{id}/cancel`。 */
export const DATA_SERVICE_CLOUD_PATHS = {
  capabilities: '/v1/data/capabilities',
  call: '/v1/data/call',
  tasks: '/v1/data/tasks',
} as const

/** 一项能力是查一次就回（`sync`），还是提交任务、过一会儿再取（`async`）。 */
export type DataCapabilityMode = 'sync' | 'async'

/** 按什么计价：按次 / 按条（异步任务拿回来的每一条）/ 按行（同步回来的每一行）。 */
export type DataBillingUnit = 'call' | 'item' | 'row'

/** 能力分组（界面分组、后台筛选用）。 */
export type DataCapabilityGroup = 'search' | 'b2b' | 'social' | 'amazon' | 'seo'

/**
 * 一项能力收哪些输入。**白名单**：不在这张表里的字段云端一律丢掉，不转给上游。
 */
export interface DataInputField {
  name: string
  type: 'string' | 'number' | 'boolean' | 'string[]'
  required?: boolean
  /** `string` / `string[]` 每一项最长多少个字符；`number` 的上限；`string[]` 另见 `max_count`。 */
  max?: number
  /** `number` 的下限。 */
  min?: number
  /** `string[]` 最多几项。 */
  max_count?: number
  /** 只认这几个值。 */
  enum?: string[]
  label_zh: string
}

/** `GET /v1/data/capabilities` 里的一项能力。 */
export interface DataCapabilityView {
  id: string
  label_zh: string
  label_en: string
  group: DataCapabilityGroup
  mode: DataCapabilityMode
  unit: DataBillingUnit
  /** 每单位多少积分（与 `/v1/pricing` 同一份）。云上价目里没有这一条就没有这一格——没价就不能用。 */
  credits_per_unit?: number
  /** 异步：一次最多多少条；同步按行计价：一次最多多少行。 */
  max_items?: number
  /** 不给 `max_items` 时按这个数跑（异步）。 */
  default_items?: number
  /** 现在能不能用（云上有可用的渠道、后台没关、有价）。 */
  available: boolean
  /** 不能用时一句人话（还没开通 / 这项能力暂时关了……）。 */
  reason?: string
  input: DataInputField[]
}

export interface DataCapabilityList {
  capabilities: DataCapabilityView[]
  at: Iso8601
}

/** `POST /v1/data/call/{capability}` 的路径参数。 */
export interface DataCallParams {
  capability: string
}

/** 同步调用的请求。 */
export interface DataCallRequest {
  /** 按能力的 `input` 白名单给；多给的字段丢掉。 */
  input: Record<string, unknown>
  /** 「重新查」：不用共享缓存，照常收费（docs/83 §5）。 */
  fresh?: boolean
}

/** 一条结果（规范化之后的，字段按能力固定；不带上游原始字段）。 */
export type DataItem = Record<string, unknown>

/** 同步调用的结果。 */
export interface DataCallResult {
  capability: string
  items: DataItem[]
  /** 计费数量：按次 = 1；按行 = 行数；0 条不收钱时是 0。 */
  quantity: number
  credits: number
  /** 命中共享缓存（照价收，docs/83 §5）。 */
  cached: boolean
  /** 这份数据是什么时候取的（命中缓存时是当初取的时刻）。 */
  fetched_at: Iso8601
  source: 'official'
}

/** 任务的状态机：`queued → running → succeeded | failed | cancelled | timed_out`。 */
export const DATA_TASK_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
] as const
export type DataTaskStatus = (typeof DATA_TASK_STATUSES)[number]

/** 走到这几个状态就不会再变了。 */
export const DATA_TASK_TERMINAL_STATUSES: readonly DataTaskStatus[] = [
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
]

/** `POST /v1/data/tasks` 的请求。 */
export interface DataTaskSubmit {
  capability: string
  input: Record<string, unknown>
  /** 最多要几条（按它预扣）；不给按能力的 `default_items`，超过 `max_items` 按 `max_items`。 */
  max_items?: number
  /** 幂等键（1–128 个字符）：同一个组织同一个键只建一个任务，网络抖了重发拿回的是同一个。 */
  idempotency_key: string
}

export interface DataTaskError {
  code: string
  /** 一句人话（不带上游名）。 */
  message: string
}

/** 一个任务的样子。 */
export interface DataTaskView {
  id: string
  capability: string
  status: DataTaskStatus
  max_items: number
  /** 已经拿到几条。 */
  item_count: number
  /** 提交时按上限预扣了多少积分。 */
  reserved_credits: number
  /** 实际扣了多少（结束之前是 0）。 */
  credits: number
  /** 退回了多少（= 预扣 − 实扣；结束之后才有）。 */
  refunded_credits?: number
  created_at: Iso8601
  started_at?: Iso8601
  finished_at?: Iso8601
  /** 结果保留到什么时候；过了就取不到了。 */
  expires_at?: Iso8601
  error?: DataTaskError
  source: 'official'
}

/** `/v1/data/tasks/{id}*` 的路径参数。 */
export interface DataTaskParams {
  id: string
}

/** `GET /v1/data/tasks/{id}/items` 的查询参数。 */
export interface DataTaskItemsQuery {
  /** 上一页回的 `next_cursor`；不给就从头取。 */
  cursor?: string
}

/** 一页结果。 */
export interface DataTaskItemsPage {
  task_id: string
  items: DataItem[]
  /** 还有下一页才有。 */
  next_cursor?: string
  /** 一共几条。 */
  total: number
  expires_at?: Iso8601
}

/** 我们认的请求头：数据驻留。`cn` = 境外渠道一个都不走，只能境外取的能力回 422 `residency_blocked`。 */
export interface DataRegionHeaders {
  'X-Agentsws-Region'?: 'cn' | 'global'
}

/* ------------------------------------------------------------------ */
/* 本机那一侧的路由（docs/75：数据从哪来）                               */
/* ------------------------------------------------------------------ */

/**
 * 这些能力在 `data_source_routing` 里的键：`data.<能力>`（如 `data.maps.places`）。
 * 与红人那几条（`kol.<渠道>`）、网页搜索（`web.search`）同一张设置。
 */
export const DATA_CAPABILITY_ROUTE_PREFIX = 'data.'

export function dataCapabilityRouteKey(capability: string): string {
  return `${DATA_CAPABILITY_ROUTE_PREFIX}${capability}`
}

/**
 * 默认顺序：只有「Agents 工坊（用积分）」这一级。自带数据接口（`byo_source`）那一级认，
 * 但这一版本机还没有这些能力的自带适配器——选了也是「没配」，落到下一级。
 */
export const DEFAULT_DATA_CAPABILITY_ORDER: readonly DataSourceLevel[] = ['workshop']

/** 这些能力认哪几级。 */
export const DATA_CAPABILITY_ROUTE_LEVELS: readonly DataSourceLevel[] = ['byo_source', 'workshop']
