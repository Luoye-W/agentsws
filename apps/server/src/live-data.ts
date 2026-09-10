/**
 * WP46 真实店铺数据喂岗位面板。
 *
 * 在这之前，服务进程给工作台挂的一直是 `emptyDataSource()`：Shopify 明明连上了、
 * 岗位也 ready 了，岗位页的数字块与「店铺后台」分块却全是空的——**从来没有一条
 * 真实订单进过面板**（截图里那些数来自模拟替身的世界）。这个文件把那条口子接上。
 *
 * 四条纪律：
 *
 * 1. **读走原生 Action**（08 §2.3）：订单从连接器的 `shopify_admin.list_orders` 来，
 *    不自己去打 Shopify 的 HTTP。
 * 2. **令牌短命**（18 §1）：每次刷新现签一张 `role-read` token——只允许这几个只读动作、
 *    只允许这一条连接、120 秒到期，用完立刻吊销。和试连（`connections.ts` 的
 *    `runSmokeAction`）是同一套规矩。
 * 3. **订单只在内存里**（21 §1）：拉回来的行**不落库、不进事件 payload、不进日志**。
 *    事件里只有条数、耗时、成功与否。进程一关，这份缓存就没了。
 * 4. **算不出就说没有**（36 §3）：断开连接 `orders()` 立刻回空、`sources()` 回
 *    `connected: false`，界面显示「去连接」而不是一排永远为 0 的数字块。
 */
import type { Clock, EventEnvelope, WorkspaceId } from '@agentsws/contracts'
import type { ConnectionLike, DataSourceStatus, OrderRow } from '@agentsws/deck'
import { dataSourcesFromConnections } from '@agentsws/deck'
import { catalogEntry } from './catalog.js'
import type { ConnectLike } from './connections.js'
import type { WorkstationDataSource } from './workstation.js'

/** 刷新周期默认 5 分钟；`AGENTSWS_LIVE_DATA_REFRESH_SECONDS` 可调。 */
export const REFRESH_SECONDS_ENV = 'AGENTSWS_LIVE_DATA_REFRESH_SECONDS'
export const DEFAULT_REFRESH_SECONDS = 300
/** 刷新用的 token 挂在这个 assignment 下；用完即吊销（与试连的那把分开记账）。 */
export const LIVE_ASSIGNMENT = 'asg_live_data'
const TOKEN_TTL_SECONDS = 120
/** 只看近 30 天：数字块最长的窗口是「近 7 天 vs 前 7 天」，30 天足够还留了余量。 */
export const ORDER_WINDOW_DAYS = 30
/** 一页拉多少（上游能给多少给多少，Shopify Admin 的上限就是 250）。 */
export const ORDER_PAGE_LIMIT = 250
/** 最多翻几页——面板不是导数据工具，1000 条足够算完 30 天的数字块。 */
export const ORDER_MAX_PAGES = 4

const DAY = 86_400_000

/** 喂「店铺后台」的 service（我们对外的 provider id，不是上游名）。 */
const SHOP_SERVICES = new Set(['shopify_admin', 'shopify'])
/** 喂客服那几个数字块的邮箱 service。 */
const MAIL_SERVICES = new Set(['imap_smtp', 'gmail'])

/** 一条连接的非凭据面（`connections.ts` 的 `liveConnections()` 给的就是这个）。 */
export interface LiveConnection {
  id: string
  service: string
  status: 'active' | 'reauth_required' | 'disabled'
}

/** 活数据源要连接面提供的那点东西（**没有也不可能有凭据**）。 */
export interface LiveDataConnections {
  liveConnections(): LiveConnection[]
  /** 上游 401 时换一张令牌；这条连接不是经纪人接管的就回 false。 */
  refreshConnectionToken(connection_id: string): Promise<boolean>
}

export interface LiveDataOptions {
  connections: LiveDataConnections
  connect: ConnectLike
  clock: Clock
  workspace_id: WorkspaceId
  /** 工作区默认时区偏移；店铺自己报了时区就用店铺的。 */
  tz_offset_minutes?: number
  /** 工作区默认币种；`get_shop` 报了就用店铺的。 */
  base_currency?: string
  appendEvent?: (e: Omit<EventEnvelope, 'id' | 'at'> & { at?: string }) => void
  env?: Record<string, string | undefined>
  /** 后台定时器间隔（毫秒）；不给按环境变量 / 默认 5 分钟，传 0 = 不起定时器。 */
  refreshIntervalMs?: number
}

/** 一次刷新的结论（只有计数与原因码，没有任何订单内容）。 */
export interface LiveRefreshReport {
  status: 'ok' | 'skipped' | 'failed'
  /** 没有活跃的店铺连接时是 `no_connection`。 */
  reason?: string
  orders: number
  pages?: number
  duration_ms?: number
  /** 用的是上一份缓存（这次失败了）。 */
  stale?: boolean
  /** 这一轮换过令牌（上游 401 → 换一张再试）。 */
  refreshed_token?: boolean
}

export interface LiveDataSource extends WorkstationDataSource {
  /** 立刻拉一轮（定时器、连接变动与首屏都调它）。**永不抛**。 */
  refresh(): Promise<LiveRefreshReport>
  /** 连接变了：下一次读之前必须重拉一轮。 */
  invalidate(): void
  /** 现在这份数据是打哪来的（状态条与测试用；没有任何订单内容）。 */
  status(): LiveDataStatus
  close(): void
}

/** 活数据源的自述。 */
export interface LiveDataStatus {
  shop_connected: boolean
  /** 有没有活着的邮箱连接（客服那几个数字块的前提，见 §邮箱）。 */
  mail_connected: boolean
  /** 缓存里这份是不是「上游拉失败后留下的旧的」。 */
  stale: boolean
  orders: number
  last?: LiveRefreshReport
}

// ── 上游返回 → OrderRow ────────────────────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** 数字可能是数字，也可能是 `"129.00"` 这种字符串（Shopify 的钱一律是字符串）。 */
function numberOf(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

function stringOf(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined
}

/** `{ shopMoney: { amount, currencyCode } }` 这种钱包结构里的金额。 */
function moneyOf(node: unknown): { amount?: number; currency?: string } {
  if (!isRecord(node)) return {}
  const inner = isRecord(node.shopMoney)
    ? node.shopMoney
    : isRecord(node.shop_money)
      ? node.shop_money
      : isRecord(node.presentmentMoney)
        ? node.presentmentMoney
        : node
  const amount = numberOf(inner.amount)
  const currency = stringOf(inner.currencyCode) ?? stringOf(inner.currency_code)
  return {
    ...(amount === undefined ? {} : { amount }),
    ...(currency === undefined ? {} : { currency }),
  }
}

function pick(row: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const k of keys) {
    const v = row[k]
    if (v !== undefined && v !== null) return v
  }
  return undefined
}

/**
 * 上游那一坨 → 订单行数组。
 *
 * 真身与替身的形状不一定一样（替身回 `{ orders, count }`，真 runtime 可能回裸数组、
 * `{ data: { orders: { edges: [{ node }] } } }` 这种 GraphQL 包装，也可能叫 `items`）。
 * 认不出来就是空数组——**绝不编一条订单出来**。
 */
export function ordersArrayOf(payload: unknown): Record<string, unknown>[] {
  const seen = new Set<unknown>()
  const walk = (node: unknown, depth: number): Record<string, unknown>[] | undefined => {
    if (depth > 4 || node === null || typeof node !== 'object' || seen.has(node)) return undefined
    seen.add(node)
    if (Array.isArray(node)) {
      const rows = node.filter(isRecord)
      // GraphQL 的 `edges: [{ node: {...} }]`
      const unwrapped = rows.map((r) => (isRecord(r.node) ? r.node : r))
      return unwrapped.length === rows.length ? unwrapped : rows
    }
    const record = node as Record<string, unknown>
    for (const key of ['orders', 'items', 'results', 'nodes', 'edges', 'data']) {
      const hit = walk(record[key], depth + 1)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  return walk(payload, 0) ?? []
}

/** 上游的一行 → `OrderRow`；缺下单时间这种硬字段的直接丢掉（宁可少一条也不猜）。 */
export function toOrderRow(
  row: Record<string, unknown>,
  fallbackCurrency: string,
): OrderRow | undefined {
  const created = stringOf(pick(row, ['created_at', 'createdAt', 'processed_at', 'processedAt']))
  if (created === undefined || !Number.isFinite(Date.parse(created))) return undefined
  const rawId = pick(row, ['id', 'order_id', 'orderId', 'gid', 'admin_graphql_api_id'])
  // 上游的 id 可能是数字（REST）也可能是 gid 字符串（GraphQL）
  const id = typeof rawId === 'number' && Number.isFinite(rawId) ? `${rawId}` : stringOf(rawId)
  if (id === undefined) return undefined
  const number = pick(row, ['name', 'order_number', 'orderNumber'])
  const total =
    numberOf(
      pick(row, ['total_price', 'totalPrice', 'current_total_price', 'totalAmount', 'total']),
    ) ??
    moneyOf(pick(row, ['totalPriceSet', 'total_price_set', 'currentTotalPriceSet'])).amount ??
    0
  const refunded =
    numberOf(pick(row, ['refunded_amount', 'refundedAmount', 'total_refunded'])) ??
    moneyOf(pick(row, ['totalRefundedSet', 'total_refunded_set'])).amount ??
    refundsSum(row.refunds) ??
    0
  const currency =
    stringOf(
      pick(row, [
        'currency',
        'currency_code',
        'currencyCode',
        'totalCurrencyCode',
        'presentment_currency',
      ]),
    ) ??
    moneyOf(pick(row, ['totalPriceSet', 'total_price_set'])).currency ??
    fallbackCurrency
  const customer = row.customer
  const email =
    stringOf(pick(row, ['email', 'contact_email', 'contactEmail'])) ??
    (isRecord(customer) ? stringOf(customer.email) : undefined) ??
    ''
  const delivered = stringOf(pick(row, ['delivered_at', 'deliveredAt']))
  return {
    id,
    name: typeof number === 'string' || typeof number === 'number' ? `${number}` : id,
    email,
    currency,
    created_at: created,
    ...(delivered === undefined ? {} : { delivered_at: delivered }),
    total_price: total,
    refunded_amount: refunded,
    financial_status: statusOf(
      pick(row, ['financial_status', 'financialStatus', 'displayFinancialStatus']),
      'pending',
    ),
    // Shopify 未发货的订单这一格是 null；deck 的「超期未发」按 `unfulfilled` 判
    fulfillment_status: statusOf(
      pick(row, ['fulfillment_status', 'fulfillmentStatus', 'displayFulfillmentStatus']),
      'unfulfilled',
    ),
  }
}

function refundsSum(node: unknown): number | undefined {
  if (!Array.isArray(node)) return undefined
  let total = 0
  let seen = false
  for (const r of node) {
    if (!isRecord(r)) continue
    const amount = numberOf(pick(r, ['amount', 'total'])) ?? moneyOf(r.totalRefundedSet).amount
    if (amount === undefined) continue
    seen = true
    total += amount
  }
  return seen ? Math.round(total * 100) / 100 : undefined
}

/** 状态一律小写（GraphQL 回 `UNFULFILLED`，REST 回 `unfulfilled` / null）。 */
function statusOf(v: unknown, fallback: string): string {
  const raw = stringOf(v)
  return raw === undefined ? fallback : raw.toLowerCase()
}

/** `get_shop` 里的币种。 */
export function shopCurrencyOf(payload: unknown): string | undefined {
  const seen = new Set<unknown>()
  const walk = (node: unknown, depth: number): string | undefined => {
    if (depth > 4 || !isRecord(node) || seen.has(node)) return undefined
    seen.add(node)
    for (const key of ['currency', 'currencyCode', 'currency_code', 'defaultCurrencyCode']) {
      const v = stringOf(node[key])
      if (v !== undefined) return v.toUpperCase()
    }
    for (const v of Object.values(node)) {
      const hit = walk(v, depth + 1)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  return walk(payload, 0)
}

/** `get_shop` 里的时区 → 分钟偏移。认 IANA 名，也认 `(GMT-05:00) Eastern Time` 这种。 */
export function shopTimezoneOffsetOf(payload: unknown, at: number): number | undefined {
  const seen = new Set<unknown>()
  const walk = (node: unknown, depth: number): number | undefined => {
    if (depth > 4 || !isRecord(node) || seen.has(node)) return undefined
    seen.add(node)
    for (const key of ['iana_timezone', 'ianaTimezone', 'timezone', 'timeZone', 'time_zone']) {
      const raw = stringOf(node[key])
      if (raw === undefined) continue
      const offset = offsetMinutesOf(raw, at)
      if (offset !== undefined) return offset
    }
    for (const v of Object.values(node)) {
      const hit = walk(v, depth + 1)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  return walk(payload, 0)
}

const GMT_OFFSET = /([+-])(\d{2}):?(\d{2})/

export function offsetMinutesOf(zone: string, at: number): number | undefined {
  // `(GMT-05:00) Eastern Time (US & Canada)` —— Shopify REST 的 `timezone` 就长这样
  const literal = GMT_OFFSET.exec(zone)
  if (literal !== null) {
    const [, sign = '+', hh = '0', mm = '0'] = literal
    const minutes = Number(hh) * 60 + Number(mm)
    return sign === '-' ? -minutes : minutes
  }
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      timeZoneName: 'longOffset',
    }).formatToParts(new Date(at))
    const name = parts.find((p) => p.type === 'timeZoneName')?.value ?? ''
    const found = GMT_OFFSET.exec(name)
    if (found === null) return name.startsWith('GMT') ? 0 : undefined
    const [, sign = '+', hh = '0', mm = '0'] = found
    const minutes = Number(hh) * 60 + Number(mm)
    return sign === '-' ? -minutes : minutes
  } catch {
    // 不认识的时区名：用工作区默认，别让面板因为一个字符串崩掉
    return undefined
  }
}

/** 上游说「你没权限」的那几个码（Shopify 那张 24 小时令牌过期就长这样）。 */
function isUnauthorized(e: unknown): boolean {
  const code =
    isRecord(e) && typeof (e as { code?: unknown }).code === 'string'
      ? (e as { code: string }).code
      : ''
  if (
    code === 'unauthenticated' ||
    code === 'authorization_failed' ||
    code === 'forbidden' ||
    code === 'bad_credentials'
  ) {
    return true
  }
  const message = e instanceof Error ? e.message : String(e)
  return /\b401\b|unauthor|unauthenticated/i.test(message)
}

/** 带错误码的失败（上游的错误码长这样，我们自己的也照这个形状）。 */
function codedError(code: string, message: string): Error {
  const err = new Error(message) as Error & { code: string }
  err.code = code
  return err
}

function codeOf(e: unknown): string {
  if (isRecord(e) && typeof (e as { code?: unknown }).code === 'string') {
    return (e as { code: string }).code
  }
  return 'internal'
}

/** 失败原因进事件时截短——它是上游的话，不是我们的（更不是订单内容）。 */
function detailOf(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  return raw.length > 200 ? `${raw.slice(0, 200)}…` : raw
}

export function refreshSecondsOf(env: Record<string, string | undefined>): number {
  const raw = env[REFRESH_SECONDS_ENV]?.trim()
  if (raw === undefined || raw === '') return DEFAULT_REFRESH_SECONDS
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_REFRESH_SECONDS
}

// ── 装配 ───────────────────────────────────────────────────────────────

interface ShopCache {
  orders: OrderRow[]
  connection_id: string
  fetched_at: number
  base_currency?: string
  tz_offset_minutes?: number
}

export function createLiveDataSource(options: LiveDataOptions): LiveDataSource {
  const env = options.env ?? {}
  const clock = options.clock
  const defaultTz = options.tz_offset_minutes ?? 480
  const defaultCurrency = options.base_currency ?? 'USD'
  const intervalMs = options.refreshIntervalMs ?? refreshSecondsOf(env) * 1000

  let cache: ShopCache | undefined
  let stale = false
  let last: LiveRefreshReport | undefined
  let inflight: Promise<LiveRefreshReport> | undefined
  let dirty = true

  /**
   * 后台作业自成一条 trace 的根。
   *
   * 请求里的事件由服务进程用当前 trace 覆盖掉，写空串没关系；**定时刷新不一样**——
   * 它压根没有请求，空 trace_id 会被内核顶回来（事件要求非空），于是每一轮后台刷新
   * 都抛。这条坑 `shopify-broker` 的自动换令牌已经踩过一次。
   */
  let traceSeq = 0
  const nextTraceId = (): string => {
    traceSeq += 1
    return `trc_live_${Date.parse(clock.now()).toString(36)}_${traceSeq}`
  }

  const emit = (type: string, payload: Record<string, unknown>): void => {
    try {
      appendEvent(type, payload)
    } catch {
      // 记不上事件不该把已经拉回来的数据作废——那是日志的问题，不是数据的问题
    }
  }

  const appendEvent = (type: string, payload: Record<string, unknown>): void => {
    options.appendEvent?.({
      schema_version: 1,
      workspace_id: options.workspace_id,
      type,
      actor: { kind: 'system', id: 'live-data' },
      correlation: { trace_id: nextTraceId() },
      payload,
    })
  }

  const connectionsOf = (): ConnectionLike[] =>
    options.connections
      .liveConnections()
      .map((c) => ({ service: c.service, status: c.status }) satisfies ConnectionLike)

  const activeShop = (): LiveConnection | undefined =>
    options.connections
      .liveConnections()
      .find((c) => SHOP_SERVICES.has(c.service) && c.status === 'active')

  /**
   * 目录里这个只读动作叫什么（真身与替身都用 `service.动作名`，但别写死）。
   *
   * 查目录要用**上游的 service 名**（`catalog.ts` 的 `upstream`），不是我们对外的
   * provider id——两者对 Shopify 恰好同名，别的 provider 不是（`smokeRemote` 同此）。
   */
  const findAction = async (service: string, bare: string): Promise<{ id: string } | undefined> => {
    const actions = await options.connect.actions(catalogEntry(service)?.upstream ?? service)
    return actions.find((a) => a.side_effect === 'read' && a.id.endsWith(`.${bare}`))
  }

  /**
   * 一轮真正的拉取：签一张只读 token → get_shop + list_orders（翻页）→ 吊销。
   *
   * 令牌在 `finally` 里一定吊销：它的存在时间就该只有这一次刷新。
   */
  const pullOnce = async (
    connection: LiveConnection,
  ): Promise<{ orders: OrderRow[]; pages: number; currency?: string; tz?: number }> => {
    const listOrders = await findAction(connection.service, 'list_orders')
    if (listOrders === undefined) {
      throw codedError('action_unavailable', `连接器目录里没有 ${connection.service}.list_orders`)
    }
    const getShop = await findAction(connection.service, 'get_shop')
    const allowed = [listOrders.id, ...(getShop === undefined ? [] : [getShop.id])]
    const token = await options.connect.issueToken({
      assignment_id: LIVE_ASSIGNMENT,
      kind: 'role-read',
      allowed_actions: allowed,
      allowed_connections: [connection.id],
      expires_in_seconds: TOKEN_TTL_SECONDS,
    })
    try {
      const run = async (action_id: string, input: unknown): Promise<unknown> => {
        const outcome = await options.connect.execute(action_id, input, {
          token: token.token,
          connection: connection.id,
        })
        return (outcome as { data?: unknown }).data ?? outcome
      }

      let currency: string | undefined
      let tz: number | undefined
      if (getShop !== undefined) {
        const shop = await run(getShop.id, {})
        currency = shopCurrencyOf(shop)
        tz = shopTimezoneOffsetOf(shop, Date.parse(clock.now()))
      }

      const cutoff = Date.parse(clock.now()) - ORDER_WINDOW_DAYS * DAY
      const rows: OrderRow[] = []
      const ids = new Set<string>()
      let cursor: string | undefined
      let pages = 0
      while (pages < ORDER_MAX_PAGES) {
        // 入参按 OpenConnector `shopify_admin.list_orders` 的真实 schema（09-11 对着容器源码核过）：
        // GraphQL connection 三件套 `first` / `after` / `query`，多一个键都会被 schema 校验顶回来。
        // 30 天窗口先让上游按 Shopify 搜索语法切一刀，本地再切一次兜底。
        const payload = await run(listOrders.id, {
          first: ORDER_PAGE_LIMIT,
          query: `created_at:>=${new Date(cutoff).toISOString().slice(0, 10)}`,
          ...(cursor === undefined ? {} : { after: cursor }),
        })
        pages += 1
        const raw = ordersArrayOf(payload)
        for (const item of raw) {
          const row = toOrderRow(item, currency ?? defaultCurrency)
          if (row === undefined || ids.has(row.id)) continue
          // 30 天窗口在这一层切：上游给多了不占内存，给少了也不会算错
          if (Date.parse(row.created_at) < cutoff) continue
          ids.add(row.id)
          rows.push(row)
        }
        cursor = cursorOf(payload)
        if (cursor === undefined || raw.length === 0) break
      }
      return {
        orders: rows,
        pages,
        ...(currency === undefined ? {} : { currency }),
        ...(tz === undefined ? {} : { tz }),
      }
    } finally {
      try {
        await options.connect.revokeTokens(LIVE_ASSIGNMENT)
      } catch {
        // 吊销失败不该把这一轮变成失败：token 120 秒后自己过期
      }
    }
  }

  const refresh = async (): Promise<LiveRefreshReport> => {
    if (inflight !== undefined) return inflight
    const started = Date.now()
    const run = async (): Promise<LiveRefreshReport> => {
      const shop = activeShop()
      if (shop === undefined) {
        // 断开了：缓存当场作废，`orders()` 回空，界面显示「去连接」
        cache = undefined
        stale = false
        dirty = false
        return { status: 'skipped', reason: 'no_connection', orders: 0 }
      }
      let refreshed_token = false
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const pulled = await pullOnce(shop)
          cache = {
            orders: pulled.orders,
            connection_id: shop.id,
            fetched_at: started,
            ...(pulled.currency === undefined ? {} : { base_currency: pulled.currency }),
            ...(pulled.tz === undefined ? {} : { tz_offset_minutes: pulled.tz }),
          }
          stale = false
          dirty = false
          // 事件里只有条数与耗时——**订单原文不进事件、不进日志**
          emit('data.refreshed', {
            source: 'shop',
            connection_id: shop.id,
            orders: pulled.orders.length,
            pages: pulled.pages,
            duration_ms: Date.now() - started,
            ...(refreshed_token ? { refreshed_token: true } : {}),
          })
          return {
            status: 'ok',
            orders: pulled.orders.length,
            pages: pulled.pages,
            duration_ms: Date.now() - started,
            ...(refreshed_token ? { refreshed_token: true } : {}),
          }
        } catch (e) {
          // 上游 401 多半只是那张 24 小时的令牌过期了：换一张再跑一次
          if (attempt === 0 && isUnauthorized(e)) {
            let swapped = false
            try {
              swapped = await options.connections.refreshConnectionToken(shop.id)
            } catch {
              swapped = false
            }
            if (swapped) {
              refreshed_token = true
              continue
            }
          }
          // 别的失败：保留上一份缓存，标 stale，记一条事件（只有原因码）
          stale = cache !== undefined
          dirty = false
          emit('data.refresh_failed', {
            source: 'shop',
            connection_id: shop.id,
            reason: codeOf(e),
            detail: detailOf(e),
            kept_cached_orders: cache?.orders.length ?? 0,
          })
          return {
            status: 'failed',
            reason: codeOf(e),
            orders: cache?.orders.length ?? 0,
            duration_ms: Date.now() - started,
            ...(cache === undefined ? {} : { stale: true }),
            ...(refreshed_token ? { refreshed_token: true } : {}),
          }
        }
      }
      /* c8 ignore next */
      return { status: 'failed', reason: 'internal', orders: 0 }
    }
    inflight = run().then(
      (report) => {
        last = report
        inflight = undefined
        return report
      },
      /* c8 ignore start */
      (e: unknown) => {
        // `run()` 自己吞掉了所有上游异常；走到这里只可能是我们自己的 bug
        const report: LiveRefreshReport = { status: 'failed', reason: codeOf(e), orders: 0 }
        last = report
        inflight = undefined
        return report
      },
      /* c8 ignore stop */
    )
    return inflight
  }

  /** 首屏与每次读之前：缓存过期或连接刚变过就先拉一轮（**永不抛**）。 */
  const ensureFresh = async (): Promise<void> => {
    const shop = activeShop()
    if (shop === undefined) {
      if (cache !== undefined) cache = undefined
      return
    }
    const fresh =
      cache !== undefined &&
      cache.connection_id === shop.id &&
      !dirty &&
      Date.now() - cache.fetched_at < Math.max(intervalMs, 1000)
    if (fresh) return
    await refresh()
  }

  let timer: ReturnType<typeof setInterval> | undefined
  if (intervalMs > 0) {
    timer = setInterval(() => {
      void refresh()
    }, intervalMs)
    timer.unref?.()
  }

  return {
    orders: () => (activeShop() === undefined ? [] : (cache?.orders ?? [])),

    sources: (): DataSourceStatus[] => dataSourcesFromConnections(connectionsOf()),

    label: () => undefined,

    get tz_offset_minutes(): number {
      return cache?.tz_offset_minutes ?? defaultTz
    },

    get base_currency(): string {
      return cache?.base_currency ?? defaultCurrency
    },

    ensureFresh,
    refresh,
    invalidate: () => {
      dirty = true
    },
    status: (): LiveDataStatus => ({
      shop_connected: activeShop() !== undefined,
      mail_connected: options.connections
        .liveConnections()
        .some((c) => MAIL_SERVICES.has(c.service) && c.status === 'active'),
      stale,
      orders: cache?.orders.length ?? 0,
      ...(last === undefined ? {} : { last }),
    }),
    close: () => {
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
    },
  }
}

/** 上游给了下一页的游标就接着翻；没给就这一页拉完。 */
function cursorOf(payload: unknown): string | undefined {
  const seen = new Set<unknown>()
  const walk = (node: unknown, depth: number): string | undefined => {
    if (depth > 4 || !isRecord(node) || seen.has(node)) return undefined
    seen.add(node)
    const hasNext = node.hasNextPage ?? node.has_next_page ?? node.has_more
    if (hasNext === false) return undefined
    for (const key of ['next_cursor', 'nextCursor', 'cursor', 'endCursor', 'end_cursor']) {
      const v = stringOf(node[key])
      if (v !== undefined) return v
    }
    for (const key of ['page_info', 'pageInfo', 'meta', 'data']) {
      const hit = walk(node[key], depth + 1)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  return walk(payload, 0)
}
