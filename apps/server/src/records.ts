/**
 * WP53 真账号环境的记录源与工具执行器。
 *
 * 09-14 真店验收撞上的那个洞：一封客户来信走到 direct-llm 运行时，模型调 `get_order`
 * 回 `no_tool_executor`，而且拿不到 `contactOf` 就连回信草稿卡都建不出来。原因是
 * **服务进程只在 `agentsws demo` 里有 `records`**（`apps/cli/src/demo.ts` 的
 * `recordSourceOf(world, pack)` 接的是合成世界）——真环境（`scripts/dev-real.sh` 起的）
 * `options.records` 是空的，于是 `MatterRecordSource` 的五个口子一个都没接上。
 *
 * 这个文件给真环境做那一份记录源：真源是**连接器 + 知识层 + 工作模型**，形状照 demo 抄。
 *
 * 五条纪律（都是别处已经立过的，这里只是照着做）：
 *
 * 1. **读走原生 Action**（08 §2.3）：订单 / 商品从连接器的只读 Action 来，不自己打 Shopify 的 HTTP。
 * 2. **令牌短命**（18 §1）：每次工具调用**现签**一张 `role-read` token——只含这一个 Action、
 *    只含这一条连接、120 秒到期——并在 `finally` 里吊销。和 `live-data.ts` 的刷新、
 *    `connections.ts` 的试连是同一套规矩：成功吊销，失败也吊销。
 * 3. **订单只进模型上下文**（21 §1）：拉回来的订单号、金额、收件地址这些**不落库、
 *    不进事件 payload、不进日志**。事件里只有工具名、成功与否、耗时、provenance 条数。
 * 4. **出处只证明「读过」**（15 §6）：工具真回来的实体才进 `provenance`，编不出来的一律不编。
 * 5. **算不出就说没有**（36 §3）：没有活着的 Shopify 连接，`executeTool` 当场回一句人话，
 *    不假装查过、不回空订单。
 *
 * 收件人门禁（31 §3.3）在 `contactOf` 这一口：来信人本身就是线程台账里的联系人，
 * 认不出来就永远建不了草稿。所以这里**一个 email 只有一条联系人记录**——
 * 不管它是先由 `packages/channels` 的入站解析出来的，还是先由 `get_order` 带回来的，
 * 认的都是同一个 `ObjectRef`（`noteContact` 保证这件事）。
 */
import { createHash } from 'node:crypto'
import type {
  AssignmentId,
  Clock,
  EventEnvelope,
  ObjectRef,
  PermissionScope,
  RangeRef,
  RetrievalActor,
  RetrievalHit,
  RunRequest,
  WorkspaceId,
} from '@agentsws/contracts'
import type { OrderLineItem, OrderRow } from '@agentsws/deck'
import type { ToolExecution, ToolExecutor } from '@agentsws/stand-ins'
import type { Work } from '@agentsws/work'
import { catalogEntry } from './catalog.js'
import type { ConnectLike } from './connections.js'
import { type LiveConnection, lineItemsOf, ordersArrayOf, toOrderRow } from './live-data.js'
import type { MatterRecordSource } from './runtime.js'

/** 事项工具签出来的 token 挂在这个 assignment 下（与试连、活数据源各自分开记账）。 */
export const TOOLS_ASSIGNMENT = 'asg_matter_tools'
/** 一次工具调用的令牌寿命（18 §1：短命，且用完即吊销）。 */
export const TOKEN_TTL_SECONDS = 120
/** `readToken()` 那一张的寿命：一次运行的预算上限是 120 秒，给它留一倍余量。 */
export const RUN_TOKEN_TTL_SECONDS = 300
/** 喂订单 / 商品的那几条连接（我们对外的 provider id，不是上游名）。 */
const SHOP_SERVICES = new Set(['shopify_admin', 'shopify'])

/** 裸工具名 → 连接器上那个只读 Action 的**光杆名**（前缀按连接的 service 现查）。 */
export const TOOL_ACTIONS: Readonly<Record<string, string>> = {
  get_order: 'get_order',
  list_orders: 'list_orders',
  get_product: 'get_product',
  list_products: 'list_products',
}
/** 走知识层、不走连接器的那一个。 */
export const POLICY_TOOL = 'search_policies'

/** `list_orders` / `list_products` 一次最多给模型几条（它是来答一封信的，不是来导数据的）。 */
export const LIST_LIMIT = 20

// ── 对外的那几个小口子（都只要"最小面"，拿到它们不等于拿到凭据）───────────

/** 19 §3 带身份检索；`grants` 由调用方从该 Assignment 的 scopes 取（不做跨 Assignment 并集）。 */
export interface RecordKnowledgePort {
  search(q: {
    text: string
    actor: RetrievalActor & { grants: PermissionScope[]; ranges?: RangeRef[] }
    k?: number
  }): Promise<{ hits: readonly RetrievalHit[] }>
}

/** 只要 `effectiveConfig` 的那两样（`RoleStore` 原样满足）。 */
export interface RecordRolesPort {
  effectiveConfig(id: AssignmentId): {
    scopes: readonly PermissionScope[]
    ranges: readonly RangeRef[]
  }
}

/** 活数据源里那份内存缓存（命中就不必再打一次上游）。 */
export interface RecordLiveDataPort {
  orders(): readonly OrderRow[]
}

export interface ConnectRecordSourceOptions {
  /** 当前真实连接（只有 id / service / 状态——**没有也不可能有凭据**）。 */
  connections: { liveConnections(): readonly LiveConnection[] }
  /** OpenConnector 那一面（真适配器或替身）。 */
  connect: ConnectLike
  clock: Clock
  workspace_id: WorkspaceId
  /** 19 §3 知识层；不给的话 `search_policies` 就是一句"这台机器上没有知识库"。 */
  knowledge?: RecordKnowledgePort
  /** 检索要的岗位身份；不给就没有任何 grant，候选集为空（宁可零命中也不越权）。 */
  roles?: RecordRolesPort
  /**
   * 37 工作模型。**迟绑定**：服务进程里 `createRuntime` 在 `createWork` 之前
   * （运行时与工作模型互相需要），所以这里收的是一个取值函数，不是实例。
   */
  work?: () => Work | undefined
  /** WP46 的内存缓存；命中就不打上游。 */
  liveData?: RecordLiveDataPort
  appendEvent?: (e: Omit<EventEnvelope, 'id' | 'at'> & { at?: string }) => void
}

/** 起草要的订单事实（字段名与 support-core 的 `OrderFacts` 逐字一致，外加起草真用得上的三样）。 */
export interface OrderRecord {
  id: string
  name: string
  currency: string
  total_price: number
  refunded_amount: number
  financial_status: string
  fulfillment_status: string
  email?: string
  customer_name?: string
  delivered_at?: string
  created_at: string
  line_items?: OrderLineItem[]
  /** 收件地址：**只进模型上下文**，一个字节都不进事件。 */
  shipping_address?: Record<string, string>
}

export interface ProductRecord {
  id: string
  title: string
  status?: string
  vendor?: string
  product_type?: string
  variants?: { id?: string; sku?: string; title?: string; price?: number }[]
}

/** 一条联系人记录（31 §3.3 的"线程台账里的联系人"）。 */
export interface ContactRecord {
  ref: ObjectRef
  email: string
  name?: string
  /** 第一次是怎么认出来的：来信解析 / 订单带回来。 */
  origin: 'inbound' | 'order'
  first_seen: string
}

// ── 小工具 ─────────────────────────────────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const stringOf = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v : typeof v === 'number' ? String(v) : undefined

const refKey = (ref: ObjectRef): string => `${ref.type}:${ref.id}`

/** 光杆工具名（`shopify_admin.get_order` → `get_order`）。 */
export const bareToolName = (name: string): string =>
  name.includes('.') ? name.slice(name.indexOf('.') + 1) : name

/** email → 稳定的联系人 id。**不可逆**：事件里出现的是它，不是邮箱。 */
export const contactIdOf = (email: string): string =>
  `cnt_${createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 12)}`

const normalizeEmail = (email: string): string => email.trim().toLowerCase()

/** 上游那一坨里的错误码（形状同 `live-data.ts`）。 */
function codeOf(e: unknown): string {
  if (isRecord(e) && typeof (e as { code?: unknown }).code === 'string') {
    return (e as { code: string }).code
  }
  return 'internal'
}

/** 失败原因分三档（进事件的只有这个码，没有上游原话里可能夹带的任何内容）。 */
export function failureReasonOf(e: unknown): 'not_found' | 'upstream_error' {
  const code = codeOf(e)
  if (code === 'not_found' || code === 'no_such_object') return 'not_found'
  const message = e instanceof Error ? e.message : String(e)
  return /\bnot[_ ]?found\b|\b404\b|不存在/i.test(message) ? 'not_found' : 'upstream_error'
}

/** `execute` 的返回可能叫 `data`，也可能叫 `result`，也可能就是裸的那一坨。 */
function payloadOf(outcome: unknown): unknown {
  if (!isRecord(outcome)) return outcome
  const withData = outcome as { data?: unknown; result?: unknown }
  return withData.data ?? withData.result ?? outcome
}

/** 上游那一坨 → 一张订单的原始行（`get_order` 可能包在 `order` / `data.order` 里）。 */
export function orderRowOf(payload: unknown): Record<string, unknown> | undefined {
  const seen = new Set<unknown>()
  const walk = (node: unknown, depth: number): Record<string, unknown> | undefined => {
    if (depth > 4 || !isRecord(node) || seen.has(node)) return undefined
    seen.add(node)
    // 认得出「这是一张订单」的标志：有 id，而且带着订单才有的那几格
    if (
      (node.id !== undefined || node.name !== undefined) &&
      ('financial_status' in node ||
        'financialStatus' in node ||
        'displayFinancialStatus' in node ||
        'line_items' in node ||
        'lineItems' in node)
    ) {
      return node
    }
    for (const key of ['order', 'data', 'node', 'result']) {
      const hit = walk(node[key], depth + 1)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  return walk(payload, 0)
}

/** 收件地址：起草要的那几格（**不含电话**——起一封回信用不上它）。 */
export function shippingAddressOf(
  row: Record<string, unknown>,
): Record<string, string> | undefined {
  const node = row.shipping_address ?? row.shippingAddress
  if (!isRecord(node)) return undefined
  const out: Record<string, string> = {}
  for (const [key, aliases] of [
    ['name', ['name', 'firstName', 'first_name']],
    ['address1', ['address1']],
    ['address2', ['address2']],
    ['city', ['city']],
    ['province', ['province', 'provinceCode', 'province_code']],
    ['zip', ['zip', 'postalCode', 'postal_code']],
    ['country', ['country', 'countryCode', 'country_code', 'countryCodeV2']],
  ] as const) {
    for (const alias of aliases) {
      const v = stringOf(node[alias])
      if (v !== undefined) {
        out[key] = v
        break
      }
    }
  }
  return Object.keys(out).length === 0 ? undefined : out
}

/** `OrderRow`（活数据源那一份）+ 原始行 → 起草要的订单事实。 */
export function orderRecordOf(
  row: Record<string, unknown>,
  fallbackCurrency: string,
): OrderRecord | undefined {
  const base = toOrderRow(row, fallbackCurrency)
  if (base === undefined) return undefined
  const customer = row.customer
  const customerName =
    (isRecord(customer)
      ? (stringOf(customer.displayName) ??
        [
          stringOf(customer.first_name) ?? stringOf(customer.firstName),
          stringOf(customer.last_name) ?? stringOf(customer.lastName),
        ]
          .filter((p): p is string => p !== undefined)
          .join(' ')
          .trim())
      : undefined) || undefined
  const address = shippingAddressOf(row)
  const lineItems = base.line_items ?? lineItemsOf(row.line_items ?? row.lineItems)
  return {
    id: base.id,
    name: base.name,
    currency: base.currency,
    total_price: base.total_price,
    refunded_amount: base.refunded_amount,
    financial_status: base.financial_status,
    fulfillment_status: base.fulfillment_status,
    created_at: base.created_at,
    ...(base.email === '' ? {} : { email: base.email }),
    ...(base.delivered_at === undefined ? {} : { delivered_at: base.delivered_at }),
    ...(customerName === undefined
      ? address?.name === undefined
        ? {}
        : { customer_name: address.name }
      : { customer_name: customerName }),
    ...(lineItems === undefined ? {} : { line_items: lineItems }),
    ...(address === undefined ? {} : { shipping_address: address }),
  }
}

/** 活数据源缓存里的那一行 → 同一份形状（它已经是 `OrderRow` 了，不必再解析一次）。 */
function fromCachedRow(row: OrderRow): OrderRecord {
  return {
    id: row.id,
    name: row.name,
    currency: row.currency,
    total_price: row.total_price,
    refunded_amount: row.refunded_amount,
    financial_status: row.financial_status,
    fulfillment_status: row.fulfillment_status,
    created_at: row.created_at,
    ...(row.email === '' ? {} : { email: row.email }),
    ...(row.delivered_at === undefined ? {} : { delivered_at: row.delivered_at }),
    ...(row.line_items === undefined ? {} : { line_items: [...row.line_items] }),
  }
}

/** 上游那一坨 → 一条商品记录（认不出来回 undefined，**不编**）。 */
export function productRecordOf(payload: unknown): ProductRecord | undefined {
  const seen = new Set<unknown>()
  const walk = (node: unknown, depth: number): Record<string, unknown> | undefined => {
    if (depth > 4 || !isRecord(node) || seen.has(node)) return undefined
    seen.add(node)
    if (node.id !== undefined && (node.title !== undefined || node.handle !== undefined))
      return node
    for (const key of ['product', 'data', 'node', 'result']) {
      const hit = walk(node[key], depth + 1)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  const row = walk(payload, 0)
  if (row === undefined) return undefined
  const id = stringOf(row.id)
  if (id === undefined) return undefined
  const rawVariants = isRecord(row.variants)
    ? (row.variants.edges ?? row.variants.nodes)
    : row.variants
  const variants = Array.isArray(rawVariants)
    ? rawVariants
        .map((v) => (isRecord(v) && isRecord(v.node) ? v.node : v))
        .filter(isRecord)
        .map((v) => {
          const price = v.price ?? v.priceV2
          const amount =
            typeof price === 'number'
              ? price
              : typeof price === 'string'
                ? Number(price)
                : isRecord(price) && typeof price.amount === 'string'
                  ? Number(price.amount)
                  : undefined
          return {
            ...(stringOf(v.id) === undefined ? {} : { id: stringOf(v.id) as string }),
            ...(stringOf(v.sku) === undefined ? {} : { sku: stringOf(v.sku) as string }),
            ...(stringOf(v.title) === undefined ? {} : { title: stringOf(v.title) as string }),
            ...(amount === undefined || !Number.isFinite(amount) ? {} : { price: amount }),
          }
        })
    : undefined
  return {
    id,
    title: stringOf(row.title) ?? stringOf(row.handle) ?? id,
    ...(stringOf(row.status) === undefined ? {} : { status: stringOf(row.status) as string }),
    ...(stringOf(row.vendor) === undefined ? {} : { vendor: stringOf(row.vendor) as string }),
    ...(stringOf(row.product_type ?? row.productType) === undefined
      ? {}
      : { product_type: stringOf(row.product_type ?? row.productType) as string }),
    ...(variants === undefined || variants.length === 0 ? {} : { variants }),
  }
}

/** 上游那一坨 → 商品数组（同 `ordersArrayOf` 的认法）。 */
export function productsArrayOf(payload: unknown): Record<string, unknown>[] {
  const seen = new Set<unknown>()
  const walk = (node: unknown, depth: number): Record<string, unknown>[] | undefined => {
    if (depth > 4 || node === null || typeof node !== 'object' || seen.has(node)) return undefined
    seen.add(node)
    if (Array.isArray(node)) {
      const rows = node.filter(isRecord)
      return rows.map((r) => (isRecord(r.node) ? r.node : r))
    }
    const record = node as Record<string, unknown>
    for (const key of ['products', 'items', 'results', 'nodes', 'edges', 'data']) {
      const hit = walk(record[key], depth + 1)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  return walk(payload, 0) ?? []
}

// ── 装配 ───────────────────────────────────────────────────────────────

/** 记录源本体外加几个"给测试与服务进程看"的自述口（`MatterRecordSource` 只多不少）。 */
export interface ConnectRecordSource extends MatterRecordSource {
  /** 认识的联系人（31 §3.3 的台账；**测试用**，不对外暴露到 HTTP）。 */
  contacts(): ContactRecord[]
  /** 入站解析出来的发件人 → 同一条联系人记录（`channels` 的 `resolveActor` 接这一口）。 */
  noteContact(email: string, opts?: { name?: string; origin?: ContactRecord['origin'] }): ObjectRef
}

export function createConnectRecordSource(
  options: ConnectRecordSourceOptions,
): ConnectRecordSource {
  const { clock, workspace_id } = options

  /** 这一轮进程里认识的联系人（key = 小写邮箱）。 */
  const contacts = new Map<string, ContactRecord>()
  /** ref → 邮箱（`record`/`label` 反查用）。 */
  const contactByRef = new Map<string, string>()
  /** 工具真读回来的订单（id 与订单号都当键）。**只在内存里**。 */
  const orders = new Map<string, OrderRecord>()
  const products = new Map<string, ProductRecord>()
  /** 检索命中过的知识卡正文（已脱敏）；`record('fact_card')` 从这里取。 */
  const policies = new Map<string, { statement: string; layer: string; as_of?: string }>()
  /** Action 目录查一次就记住（目录是静态的）。 */
  const actionIds = new Map<string, string>()

  let traceSeq = 0
  const emit = (type: string, payload: Record<string, unknown>): void => {
    traceSeq += 1
    try {
      options.appendEvent?.({
        schema_version: 1,
        workspace_id,
        type,
        actor: { kind: 'system', id: 'records' },
        // 后台没有请求上下文，空 trace_id 会被内核整条顶回（`live-data.ts` 踩过）
        correlation: { trace_id: `trc_tool_${Date.parse(clock.now()).toString(36)}_${traceSeq}` },
        payload,
      })
    } catch {
      // 记不上事件不该把已经拿回来的数据作废——那是日志的问题
    }
  }

  // ── 联系人台账（31 §3.3）──────────────────────────────────────────
  /**
   * 一个邮箱只有一条记录、只有一个 `ObjectRef`。
   *
   * 先被谁认出来就用谁给的 ref：入站解析先到就是 `contact:<hash>`，`get_order` 先到
   * 就是上游的 `customer:<id>`。**后到的那一方不另起一条**——否则 `contactOf` 回的 ref
   * 与工具 provenance 里的 ref 对不上，收件人门禁永远过不去，草稿卡永远建不出来。
   */
  const noteContact = (
    email: string,
    opts: { name?: string; origin?: ContactRecord['origin']; ref?: ObjectRef } = {},
  ): ObjectRef => {
    const key = normalizeEmail(email)
    const existing = contacts.get(key)
    if (existing !== undefined) {
      if (existing.name === undefined && opts.name !== undefined) existing.name = opts.name
      return existing.ref
    }
    const ref = opts.ref ?? { type: 'contact', id: contactIdOf(key) }
    const record: ContactRecord = {
      ref,
      email: key,
      origin: opts.origin ?? 'inbound',
      first_seen: clock.now(),
      ...(opts.name === undefined ? {} : { name: opts.name }),
    }
    contacts.set(key, record)
    contactByRef.set(refKey(ref), key)
    // 事件里只有不可逆的 id 与来路：**邮箱与姓名不进事件**（21 §1）
    emit('contact.noted', { contact_id: ref.id, ref_type: ref.type, origin: record.origin })
    return ref
  }

  const rememberOrder = (record: OrderRecord): ObjectRef[] => {
    orders.set(record.id, record)
    if (record.name !== record.id) orders.set(record.name, record)
    const refs: ObjectRef[] = [{ type: 'order', id: record.id }]
    if (record.email !== undefined) {
      refs.push(
        noteContact(record.email, {
          origin: 'order',
          ...(record.customer_name === undefined ? {} : { name: record.customer_name }),
        }),
      )
    }
    return refs
  }

  // ── 连接器 ─────────────────────────────────────────────────────────
  const activeShop = (): LiveConnection | undefined =>
    options.connections
      .liveConnections()
      .find((c) => SHOP_SERVICES.has(c.service) && c.status === 'active')

  /**
   * 目录里这个只读动作叫什么。查目录要用**上游的 service 名**（`catalog.ts` 的
   * `upstream`）——两者对 Shopify 恰好同名，别的 provider 不是。
   */
  const findAction = async (service: string, bare: string): Promise<string | undefined> => {
    const cacheKey = `${service}.${bare}`
    const hit = actionIds.get(cacheKey)
    if (hit !== undefined) return hit
    const actions = await options.connect.actions(catalogEntry(service)?.upstream ?? service)
    const found = actions.find((a) => a.side_effect === 'read' && a.id.endsWith(`.${bare}`))
    if (found === undefined) return undefined
    actionIds.set(cacheKey, found.id)
    return found.id
  }

  /**
   * 跑一次只读 Action：现签一张只含它的 token → 执行 → **`finally` 里一定吊销**。
   *
   * 成功吊销、失败也吊销：这张令牌的存在时间就该只有这一次调用（18 §1）。
   */
  const runAction = async (
    connection: LiveConnection,
    action_id: string,
    input: unknown,
  ): Promise<unknown> => {
    const token = await options.connect.issueToken({
      assignment_id: TOOLS_ASSIGNMENT,
      kind: 'role-read',
      allowed_actions: [action_id],
      allowed_connections: [connection.id],
      expires_in_seconds: TOKEN_TTL_SECONDS,
    })
    try {
      const outcome = await options.connect.execute(action_id, input, {
        token: token.token,
        connection: connection.id,
      })
      return payloadOf(outcome)
    } finally {
      try {
        await options.connect.revokeTokens(TOOLS_ASSIGNMENT)
      } catch {
        // 吊销失败不该把这一次调用变成失败：token 120 秒后自己过期
      }
    }
  }

  const NOT_CONNECTED =
    'not_connected：这个工作区还没有连上店铺后台（Shopify），查不到订单和商品。' +
    '先去「连接」页连一个，再来问这封信。'
  const ACTION_UNAVAILABLE = (bare: string): string =>
    `action_unavailable：连上的这个店铺后台没有「${bare}」这个只读动作，这次查不了。`

  /** 真去拉一张订单（`record()` 与 `executeTool` 共用这一条路）。 */
  const fetchOrder = async (order_id: string): Promise<OrderRecord | undefined> => {
    const shop = activeShop()
    if (shop === undefined) return undefined
    const action = await findAction(shop.service, 'get_order')
    if (action === undefined) return undefined
    const payload = await runAction(shop, action, { order_id })
    const row = orderRowOf(payload)
    return row === undefined ? undefined : orderRecordOf(row, 'USD')
  }

  // ── 工具执行器 ─────────────────────────────────────────────────────
  const searchPolicies = async (request: RunRequest, query: string): Promise<ToolExecution> => {
    const knowledge = options.knowledge
    if (knowledge === undefined) {
      return {
        status: 'error',
        reason: 'knowledge_unavailable：这台机器上没有装知识库，查不了政策。',
      }
    }
    // 19 §3 过滤下推：本次 Assignment 的 scopes 原样传下去（不做跨 Assignment 并集），
    // 无权数据域根本不进候选集。取不到配置就是零 grant——宁可零命中也不越权。
    const config = options.roles?.effectiveConfig(request.actor.assignment_id)
    const { hits } = await knowledge.search({
      text: query,
      actor: {
        person_id: request.actor.person_id,
        assignment_id: request.actor.assignment_id,
        role_id: request.actor.role_id,
        workspace_id,
        grants: [...(config?.scopes ?? [])],
        ranges: [...(config?.ranges ?? [])],
      },
      k: 3,
    })
    for (const h of hits) {
      policies.set(h.fact_card_id, {
        statement: h.statement_redacted,
        layer: h.layer,
        ...(h.as_of === undefined ? {} : { as_of: h.as_of }),
      })
    }
    return {
      status: 'ok',
      data: {
        hits: hits.map((h) => ({
          id: h.fact_card_id,
          statement: h.statement_redacted,
          layer: h.layer,
          ...(h.as_of === undefined ? {} : { as_of: h.as_of }),
        })),
      },
      provenance: hits.map((h) => ({ type: 'fact_card', id: h.fact_card_id }) satisfies ObjectRef),
    }
  }

  /** 连接器那四个的入参：按上游 schema 现造，**不把模型给的键原样透传**（多一个键就被顶回）。 */
  const inputFor = (bare: string, input: Record<string, unknown>): Record<string, unknown> => {
    const query = stringOf(input.query)
    switch (bare) {
      case 'get_order':
        return {
          order_id: stringOf(input.order_id ?? input.id ?? input.name ?? input.order_name) ?? '',
        }
      case 'get_product':
        return { product_id: stringOf(input.product_id ?? input.id ?? input.handle) ?? '' }
      default:
        return {
          first: Math.min(
            Math.max(Math.trunc(Number(input.first ?? input.limit ?? LIST_LIMIT)) || LIST_LIMIT, 1),
            LIST_LIMIT,
          ),
          ...(query === undefined ? {} : { query }),
        }
    }
  }

  const runConnectorTool = async (
    bare: string,
    input: Record<string, unknown>,
  ): Promise<ToolExecution> => {
    const shop = activeShop()
    if (shop === undefined) return { status: 'error', reason: NOT_CONNECTED }
    const action = await findAction(shop.service, TOOL_ACTIONS[bare] as string)
    if (action === undefined) return { status: 'error', reason: ACTION_UNAVAILABLE(bare) }
    const payload = await runAction(shop, action, inputFor(bare, input))

    if (bare === 'get_order') {
      const row = orderRowOf(payload)
      const record = row === undefined ? undefined : orderRecordOf(row, 'USD')
      if (record === undefined) {
        return { status: 'error', reason: 'not_found：上游没有这张订单，或者回的不是一张订单。' }
      }
      return { status: 'ok', data: record, provenance: rememberOrder(record) }
    }
    if (bare === 'list_orders') {
      const rows = ordersArrayOf(payload)
        .map((r) => orderRecordOf(r, 'USD'))
        .filter((r): r is OrderRecord => r !== undefined)
        .slice(0, LIST_LIMIT)
      const provenance: ObjectRef[] = []
      for (const record of rows) provenance.push(...rememberOrder(record))
      return { status: 'ok', data: { orders: rows }, provenance }
    }
    if (bare === 'get_product') {
      const record = productRecordOf(payload)
      if (record === undefined) {
        return { status: 'error', reason: 'not_found：上游没有这个商品，或者回的不是一个商品。' }
      }
      products.set(record.id, record)
      return { status: 'ok', data: record, provenance: [{ type: 'product', id: record.id }] }
    }
    const rows = productsArrayOf(payload)
      .map((r) => productRecordOf(r))
      .filter((r): r is ProductRecord => r !== undefined)
      .slice(0, LIST_LIMIT)
    for (const record of rows) products.set(record.id, record)
    return {
      status: 'ok',
      data: { products: rows },
      provenance: rows.map((r) => ({ type: 'product', id: r.id }) satisfies ObjectRef),
    }
  }

  const executeTool: ToolExecutor = async ({ name, input, request }) => {
    const bare = bareToolName(name)
    // 17 §6.3：不在 allowlist 的工具不到达工具（与替身执行器同一道门）
    if (!request.tools.allow.includes(name) && !request.tools.allow.includes(bare)) {
      return { status: 'blocked', reason: `not_in_allowlist: ${name}` }
    }
    const started = Date.now()
    const finish = (exec: ToolExecution): ToolExecution => {
      // 事件里只有工具名、成功与否、耗时、provenance **条数**——订单内容一个字节都不进
      emit('tool.executed', {
        tool: bare,
        status: exec.status,
        duration_ms: Date.now() - started,
        provenance: exec.provenance?.length ?? 0,
        ...(exec.status === 'ok'
          ? {}
          : { reason: (exec.reason ?? 'internal').split('：')[0]?.split(': ')[0] ?? 'internal' }),
      })
      return exec
    }
    try {
      if (bare === POLICY_TOOL) {
        return finish(
          await searchPolicies(request, stringOf(input.query) ?? request.work_item?.id ?? ''),
        )
      }
      if (TOOL_ACTIONS[bare] === undefined) {
        return finish({ status: 'error', reason: `unsupported_tool：这个进程没接「${bare}」。` })
      }
      return finish(await runConnectorTool(bare, input))
    } catch (e) {
      const reason = failureReasonOf(e)
      return finish({
        status: 'error',
        reason:
          reason === 'not_found'
            ? 'not_found：上游说没有这条记录。'
            : 'upstream_error：店铺后台这次没答上来，稍后再试或去「连接」页看看连接状态。',
      })
    }
  }

  // ── 记录 / 人话 / 收件人 / 令牌 ───────────────────────────────────
  const cachedOrder = (id: string): OrderRecord | undefined => {
    const hit = orders.get(id)
    if (hit !== undefined) return hit
    const live = options.liveData
      ?.orders()
      .find((o) => o.id === id || o.name === id || o.name === `#${id}`)
    if (live === undefined) return undefined
    const record = fromCachedRow(live)
    orders.set(record.id, record)
    return record
  }

  const matterOfThread = (ref: ObjectRef): { title: string; summary: string } | undefined => {
    const work = options.work?.()
    if (work === undefined) return undefined
    const matter = work
      .listMatters({ kind: 'conversation' })
      .find((m) => m.context.pinned.some((p) => p.type === ref.type && p.id === ref.id))
    return matter === undefined
      ? undefined
      : { title: matter.title, summary: matter.context.summary }
  }

  const record = (ref: ObjectRef): unknown => {
    if (ref.type === 'order') {
      const hit = cachedOrder(ref.id)
      if (hit !== undefined) return hit
      // 缓存没有就真去拉一张（`buildRequest` 会 await 这个 Promise）；拉不到回 undefined
      return fetchOrder(ref.id).then(
        (fetched) => {
          if (fetched === undefined) return undefined
          rememberOrder(fetched)
          return fetched
        },
        () => undefined,
      )
    }
    if (ref.type === 'customer' || ref.type === 'contact') {
      const email = contactByRef.get(refKey(ref))
      const contact = email === undefined ? undefined : contacts.get(email)
      return contact === undefined
        ? undefined
        : {
            id: ref.id,
            email: contact.email,
            ...(contact.name === undefined ? {} : { name: contact.name }),
          }
    }
    if (ref.type === 'product') return products.get(ref.id)
    if (ref.type === 'thread') {
      const matter = matterOfThread(ref)
      if (matter === undefined) return undefined
      return {
        id: ref.id,
        subject: matter.title,
        ...(matter.summary.trim() === '' ? {} : { summary: matter.summary }),
        participants: [...contacts.values()].map((c) => c.email),
      }
    }
    if (ref.type === 'fact_card') {
      const hit = policies.get(ref.id)
      return hit === undefined ? undefined : { id: ref.id, ...hit }
    }
    // 不认识的一律 undefined——**不编造**
    return undefined
  }

  const label = (ref: ObjectRef): string | undefined => {
    if (ref.type === 'order') {
      const hit = cachedOrder(ref.id)
      if (hit === undefined) return undefined
      return hit.name.startsWith('#') ? `订单 ${hit.name}` : `订单 #${hit.name}`
    }
    if (ref.type === 'customer' || ref.type === 'contact') {
      const email = contactByRef.get(refKey(ref))
      const contact = email === undefined ? undefined : contacts.get(email)
      return contact?.name ?? contact?.email
    }
    if (ref.type === 'product') return products.get(ref.id)?.title
    if (ref.type === 'thread') return matterOfThread(ref)?.title
    if (ref.type === 'fact_card') {
      const statement = policies.get(ref.id)?.statement
      return statement === undefined
        ? undefined
        : statement.length > 40
          ? `${statement.slice(0, 39)}…`
          : statement
    }
    return undefined
  }

  /**
   * 31 §3.3 收件人门禁：只给线程台账里的联系人发信。
   *
   * 认不出来就**建一条**——来信人本身就是台账里的联系人（这封信就是他寄来的），
   * 否则这个工作区永远建不出一张回信草稿卡。建出来的这条与 `packages/channels`
   * 入站解析出来的是同一条（两边都走 `noteContact`）。
   */
  const contactOf = (email: string): ObjectRef | undefined => {
    const trimmed = email.trim()
    if (trimmed === '') return undefined
    return noteContact(trimmed)
  }

  const readToken = async (assignment_id: AssignmentId): Promise<string> => {
    const shop = activeShop()
    if (shop === undefined) return ''
    const allowed: string[] = []
    for (const bare of Object.values(TOOL_ACTIONS)) {
      const action = await findAction(shop.service, bare).catch(() => undefined)
      if (action !== undefined) allowed.push(action)
    }
    if (allowed.length === 0) return ''
    try {
      const token = await options.connect.issueToken({
        assignment_id,
        kind: 'role-read',
        allowed_actions: allowed,
        allowed_connections: [shop.id],
        expires_in_seconds: RUN_TOKEN_TTL_SECONDS,
      })
      return token.token
    } catch {
      // 签不出来就是没有写口——运行时照常跑，工具走 `executeTool` 自己那张现签的
      return ''
    }
  }

  return {
    record,
    label,
    contactOf,
    readToken,
    executeTool,
    contacts: () => [...contacts.values()],
    noteContact: (email, opts = {}) => noteContact(email, opts),
  }
}
