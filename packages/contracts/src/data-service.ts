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
export type DataCapabilityGroup =
  | 'search'
  | 'b2b'
  | 'social'
  | 'amazon'
  | 'seo'
  /** WP192 追加：运营后台新增的自定义能力没归到上面几类的。 */
  | 'other'

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

/* ------------------------------------------------------------------ */
/* 能力目录（WP192 第一批）                                             */
/* ------------------------------------------------------------------ */

/**
 * 一项能力的**规格**（不含价——价只在云上，`/v1/pricing` 与 `GET /v1/data/capabilities` 给）。
 *
 * 这张表是本机与云上共同认的名字与输入白名单：本机按它显示标签、校验输入；云上按它挑渠道、
 * 丢掉白名单以外的字段、决定能不能进共享缓存。云上可以比这张表多（新能力先在云上开），
 * 本机遇到认不出的能力就原样显示云上给的 `label_zh`。
 */
export interface DataCapabilitySpec {
  id: string
  label_zh: string
  label_en: string
  group: DataCapabilityGroup
  mode: DataCapabilityMode
  unit: DataBillingUnit
  input: DataInputField[]
  /** 异步：一次最多多少条；同步按行：一次最多多少行。 */
  max_items?: number
  /** 异步不给 `max_items` 时按这个数跑。 */
  default_items?: number
  /**
   * 结果里有**个人或企业的联系方式**（邮箱、电话、个人主页）。这样的结果**永不进共享缓存**
   * （docs/83 §5）；红人那一侧的联系方式仍走公共红人库「按次揭示 + 审计」。
   */
  personal_contacts?: boolean
  /** 默认关（后台打开才有）。LinkedIn 那一项是这样（docs/84 §11 第 7 条）。 */
  default_off?: boolean
}

const COUNTRY: DataInputField = {
  name: 'country',
  type: 'string',
  required: true,
  max: 8,
  label_zh: '国家（两位字母，如 us）',
}
const LANGUAGE: DataInputField = {
  name: 'language',
  type: 'string',
  required: true,
  max: 16,
  label_zh: '语言（如 en）',
}
const MARKETPLACE: DataInputField = {
  name: 'marketplace',
  type: 'string',
  required: true,
  enum: ['US', 'CA', 'MX', 'UK', 'DE', 'FR', 'IT', 'ES', 'JP', 'AU', 'IN', 'AE', 'BR'],
  label_zh: 'Amazon 站点',
}
const USERNAMES: DataInputField = {
  name: 'usernames',
  type: 'string[]',
  required: true,
  max: 100,
  max_count: 50,
  label_zh: '账号名（不带 @）',
}
const AI_QUESTION: DataInputField[] = [
  { name: 'question', type: 'string', required: true, max: 1000, label_zh: '问题' },
  COUNTRY,
  LANGUAGE,
]

/** WP192 第一批能力。 */
export const DATA_CAPABILITY_CATALOG: readonly DataCapabilitySpec[] = [
  {
    id: 'serp.google',
    label_zh: 'Google 搜索结果页',
    label_en: 'Google results page',
    group: 'search',
    mode: 'sync',
    unit: 'call',
    input: [
      { name: 'query', type: 'string', required: true, max: 400, label_zh: '搜索词' },
      COUNTRY,
      LANGUAGE,
      { name: 'device', type: 'string', enum: ['desktop', 'mobile'], label_zh: '设备' },
    ],
  },
  {
    id: 'serp.bing',
    label_zh: 'Bing 搜索结果页',
    label_en: 'Bing results page',
    group: 'search',
    mode: 'sync',
    unit: 'call',
    input: [
      { name: 'query', type: 'string', required: true, max: 400, label_zh: '搜索词' },
      COUNTRY,
      LANGUAGE,
      { name: 'device', type: 'string', enum: ['desktop', 'mobile'], label_zh: '设备' },
    ],
  },
  {
    id: 'ai_answer.chatgpt',
    label_zh: 'ChatGPT 回答探测',
    label_en: 'ChatGPT answer probe',
    group: 'search',
    mode: 'sync',
    unit: 'call',
    input: AI_QUESTION,
  },
  {
    id: 'ai_answer.gemini',
    label_zh: 'Gemini 回答探测',
    label_en: 'Gemini answer probe',
    group: 'search',
    mode: 'sync',
    unit: 'call',
    input: AI_QUESTION,
  },
  {
    id: 'ai_answer.google_ai_overview',
    label_zh: 'Google AI 概览探测',
    label_en: 'Google AI Overview probe',
    group: 'search',
    mode: 'sync',
    unit: 'call',
    input: AI_QUESTION,
  },
  {
    id: 'amazon.keyword_research',
    label_zh: 'Amazon 关键词挖掘',
    label_en: 'Amazon keyword research',
    group: 'amazon',
    mode: 'sync',
    unit: 'call',
    input: [
      { name: 'keyword', type: 'string', required: true, max: 200, label_zh: '种子词' },
      MARKETPLACE,
      { name: 'limit', type: 'number', min: 1, max: 200, label_zh: '最多几个词' },
    ],
  },
  {
    id: 'amazon.asin_keywords',
    label_zh: 'Amazon ASIN 反查关键词',
    label_en: 'Amazon ASIN reverse keywords',
    group: 'amazon',
    mode: 'sync',
    unit: 'call',
    input: [
      { name: 'asin', type: 'string', required: true, max: 10, label_zh: 'ASIN' },
      MARKETPLACE,
      { name: 'limit', type: 'number', min: 1, max: 200, label_zh: '最多几个词' },
    ],
  },
  {
    id: 'seo.backlinks',
    label_zh: '外链列表',
    label_en: 'Backlinks',
    group: 'seo',
    mode: 'sync',
    unit: 'row',
    max_items: 1000,
    input: [
      { name: 'target', type: 'string', required: true, max: 500, label_zh: '域名或网址' },
      {
        name: 'mode',
        type: 'string',
        enum: ['domain', 'subdomains', 'prefix', 'exact'],
        label_zh: '范围',
      },
      { name: 'limit', type: 'number', min: 1, max: 1000, label_zh: '最多几行' },
    ],
  },
  {
    id: 'seo.domain_rating',
    label_zh: '域名权重',
    label_en: 'Domain rating',
    group: 'seo',
    mode: 'sync',
    unit: 'call',
    input: [{ name: 'target', type: 'string', required: true, max: 500, label_zh: '域名' }],
  },
  {
    id: 'maps.places',
    label_zh: '地图商家（找客户）',
    label_en: 'Map places (lead finding)',
    group: 'b2b',
    mode: 'async',
    unit: 'item',
    max_items: 500,
    default_items: 50,
    input: [
      {
        name: 'query',
        type: 'string',
        required: true,
        max: 200,
        label_zh: '找什么（行业 / 品类）',
      },
      { name: 'location', type: 'string', max: 200, label_zh: '在哪儿（城市 / 国家）' },
      { name: 'language', type: 'string', max: 16, label_zh: '结果语言' },
    ],
  },
  {
    id: 'contacts.website',
    label_zh: '网站公开联系方式',
    label_en: 'Website public contacts',
    group: 'b2b',
    mode: 'async',
    unit: 'item',
    max_items: 50,
    default_items: 20,
    personal_contacts: true,
    input: [
      {
        name: 'urls',
        type: 'string[]',
        required: true,
        max: 500,
        max_count: 50,
        label_zh: '网站地址',
      },
    ],
  },
  {
    id: 'social.instagram.profile',
    label_zh: 'Instagram 公开主页',
    label_en: 'Instagram public profiles',
    group: 'social',
    mode: 'async',
    unit: 'item',
    max_items: 50,
    default_items: 10,
    input: [USERNAMES],
  },
  {
    id: 'social.instagram.posts',
    label_zh: 'Instagram 公开帖子',
    label_en: 'Instagram public posts',
    group: 'social',
    mode: 'async',
    unit: 'item',
    max_items: 500,
    default_items: 50,
    input: [USERNAMES],
  },
  {
    id: 'social.tiktok.profile',
    label_zh: 'TikTok 公开主页',
    label_en: 'TikTok public profiles',
    group: 'social',
    mode: 'async',
    unit: 'item',
    max_items: 50,
    default_items: 10,
    input: [USERNAMES],
  },
  {
    id: 'social.tiktok.posts',
    label_zh: 'TikTok 公开视频',
    label_en: 'TikTok public videos',
    group: 'social',
    mode: 'async',
    unit: 'item',
    max_items: 500,
    default_items: 50,
    input: [USERNAMES],
  },
  {
    id: 'amazon.product',
    label_zh: 'Amazon 商品详情',
    label_en: 'Amazon product details',
    group: 'amazon',
    mode: 'async',
    unit: 'item',
    max_items: 100,
    default_items: 10,
    input: [
      {
        name: 'asins',
        type: 'string[]',
        required: true,
        max: 10,
        max_count: 100,
        label_zh: 'ASIN',
      },
      MARKETPLACE,
    ],
  },
  {
    id: 'amazon.reviews',
    label_zh: 'Amazon 商品评论',
    label_en: 'Amazon product reviews',
    group: 'amazon',
    mode: 'async',
    unit: 'item',
    max_items: 1000,
    default_items: 100,
    input: [
      { name: 'asin', type: 'string', required: true, max: 10, label_zh: 'ASIN' },
      MARKETPLACE,
    ],
  },
  {
    id: 'social.linkedin.profile',
    label_zh: 'LinkedIn 公开资料',
    label_en: 'LinkedIn public profiles',
    group: 'b2b',
    mode: 'async',
    unit: 'item',
    max_items: 50,
    default_items: 10,
    personal_contacts: true,
    default_off: true,
    input: [
      {
        name: 'profile_urls',
        type: 'string[]',
        required: true,
        max: 300,
        max_count: 50,
        label_zh: '资料页地址',
      },
    ],
  },
]

/** 按 id 找一项能力的规格（认不出回 `undefined`）。 */
export function dataCapabilitySpec(id: string): DataCapabilitySpec | undefined {
  return DATA_CAPABILITY_CATALOG.find((c) => c.id === id)
}

/** 输入校验的结果。 */
export type DataInputCheck =
  | { ok: true; input: Record<string, unknown> }
  | { ok: false; field?: string; message: string }

/** 这几个字段统一小写（国家 / 语言码、社媒账号名大小写不敏感）。 */
const LOWERCASE_FIELDS = new Set(['country', 'language', 'usernames'])
/** 这几个字段统一大写（ASIN）。 */
const UPPERCASE_FIELDS = new Set(['asin', 'asins'])

function tidy(name: string, value: string): string {
  let v = value.trim()
  if (name === 'usernames') v = v.replace(/^@+/u, '')
  if (LOWERCASE_FIELDS.has(name)) v = v.toLowerCase()
  if (UPPERCASE_FIELDS.has(name)) v = v.toUpperCase()
  return v
}

/**
 * 按能力的输入白名单**校验并规范化**：白名单以外的字段丢掉；字符串去首尾空白；
 * 列表去空、去重、排序（同一个问法才算同一次——共享缓存的键就用它，docs/83 §5）；
 * 枚举不分大小写、归成表里的写法；数字要在范围里。
 *
 * 云上与本机替身用同一个函数，所以「这个输入合不合法」两边的话一样。
 */
export function normalizeDataInput(spec: DataCapabilitySpec, raw: unknown): DataInputCheck {
  const src =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {}
  const out: Record<string, unknown> = {}
  for (const field of spec.input) {
    const value = src[field.name]
    const missing =
      value === undefined ||
      value === null ||
      (typeof value === 'string' && value.trim() === '') ||
      (Array.isArray(value) && value.length === 0)
    if (missing) {
      if (field.required === true)
        return { ok: false, field: field.name, message: `缺「${field.label_zh}」` }
      continue
    }
    const bad = (why: string): DataInputCheck => ({
      ok: false,
      field: field.name,
      message: `「${field.label_zh}」${why}`,
    })
    if (field.type === 'string') {
      if (typeof value !== 'string') return bad('要是文字')
      let v = tidy(field.name, value)
      if (field.max !== undefined && v.length > field.max)
        return bad(`太长了（最多 ${String(field.max)} 个字）`)
      if (field.enum !== undefined) {
        const hit = field.enum.find((e) => e.toLowerCase() === v.toLowerCase())
        if (hit === undefined) return bad(`只能是 ${field.enum.join(' / ')}`)
        v = hit
      }
      out[field.name] = v
    } else if (field.type === 'number') {
      const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
      if (!Number.isFinite(n)) return bad('要是数字')
      if (field.min !== undefined && n < field.min) return bad(`不能小于 ${String(field.min)}`)
      if (field.max !== undefined && n > field.max) return bad(`不能大于 ${String(field.max)}`)
      out[field.name] = Math.floor(n)
    } else if (field.type === 'boolean') {
      if (typeof value !== 'boolean') return bad('要是 true / false')
      out[field.name] = value
    } else {
      const list = Array.isArray(value) ? value : typeof value === 'string' ? [value] : undefined
      if (list === undefined || !list.every((x) => typeof x === 'string'))
        return bad('要是一组文字')
      const cleaned = [...new Set((list as string[]).map((x) => tidy(field.name, x)))]
        .filter((x) => x !== '')
        .sort()
      if (cleaned.length === 0) {
        if (field.required === true) return bad('不能是空的')
        continue
      }
      if (field.max_count !== undefined && cleaned.length > field.max_count)
        return bad(`最多 ${String(field.max_count)} 个`)
      const each = field.max
      if (each !== undefined && cleaned.some((x) => x.length > each))
        return bad(`每一项最多 ${String(each)} 个字`)
      out[field.name] = cleaned
    }
  }
  return { ok: true, input: out }
}
