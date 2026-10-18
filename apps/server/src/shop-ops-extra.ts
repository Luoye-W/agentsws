/**
 * WP418（自查 A13 / B4 / B5 / B10）：独立站运营**补的那几样**——政策、库存、全站自动折扣、订单发货 / 回填单号。
 *
 * 与 `shop-ops.ts` / `shop-propose.ts` / `shop-apply.ts` 同一套三步（单独一个文件，免得和别的单抢那几个大文件）：
 *
 * 1. **查**（`shop_get_order`）：只读，没有顾客个人信息；读过记进 {@link ReadLog}（改前必读）。
 * 2. **出卡**（{@link draftExtra}）：「原来」是这一刻现读的；一个字节都不改店铺。
 * 3. **批了才改**（{@link applyExtra}）：改之前再读一次，对不上（有人在后台动过）→ 不改、照实说；
 *    改完**读回确认**，对不上回 `verified: false`（执行器记「改了但没核对上」）。
 *
 * 取消订单、给顾客发延误通知**没接**：前者连带退款且不可逆，后者是对外发信——都还没接通（见报告）。
 */
import type { ObjectRef } from '@agentsws/contracts'
import type { ShopifyAdminReader } from './shop-admin.js'
import type { Applied, ApplyContext } from './shop-apply.js'
import { ShopApplyError } from './shop-apply.js'
import { arr, nodes, o, s, userErrorsOf } from './shop-graphql.js'
import {
  gidOf,
  num,
  type ReadLog,
  readProduct,
  type ShopOp,
  ShopOpsError,
  str,
} from './shop-ops.js'
import type { ProposeContext, ShopDraft } from './shop-propose.js'
import { SITE_POLICIES } from './site-facts.js'

type Obj = Record<string, unknown>

// ── GraphQL（写死的那几条） ───────────────────────────────────────────────

export const POLICY_UPDATE = `mutation AgentswsPolicyUpdate($shopPolicy: ShopPolicyInput!) {
  shopPolicyUpdate(shopPolicy: $shopPolicy) { shopPolicy { id type body } userErrors { field message } }
}`

export const VARIANT_INVENTORY = `query AgentswsVariantInventory($id: ID!) {
  productVariant(id: $id) {
    id title sku
    inventoryItem { id tracked
      inventoryLevels(first: 10) { nodes { location { id name } quantities(names: ["available"]) { name quantity } } }
    }
  }
}`

export const INVENTORY_ADJUST = `mutation AgentswsInventoryAdjust($input: InventoryAdjustQuantitiesInput!, $idempotencyKey: String!) {
  inventoryAdjustQuantities(input: $input) @idempotent(key: $idempotencyKey) {
    inventoryAdjustmentGroup { reason changes { name delta } }
    userErrors { field message }
  }
}`

export const AUTO_DISCOUNT_CREATE = `mutation AgentswsAutoDiscountCreate($input: DiscountAutomaticBasicInput!) {
  discountAutomaticBasicCreate(automaticBasicDiscount: $input) { automaticDiscountNode { id } userErrors { field message } }
}`

export const AUTO_DISCOUNT = `query AgentswsAutoDiscount($id: ID!) {
  automaticDiscountNode(id: $id) { id automaticDiscount { ... on DiscountAutomaticBasic { title status } } }
}`

export const ORDER_FULFILLMENT = `query AgentswsOrderFulfillment($id: ID!) {
  order(id: $id) {
    id name displayFulfillmentStatus displayFinancialStatus cancelledAt
    fulfillmentOrders(first: 10) { nodes { id status assignedLocation { name }
      lineItems(first: 50) { nodes { id remainingQuantity totalQuantity lineItem { name sku } } } } }
    fulfillments(first: 10) { id status createdAt trackingInfo(first: 3) { number company url } }
  }
}`

export const ORDER_BY_NAME = `query AgentswsOrderByName($query: String!) {
  orders(first: 1, query: $query) { nodes { id } }
}`

export const FULFILLMENT_CREATE = `mutation AgentswsFulfillmentCreate($fulfillment: FulfillmentInput!) {
  fulfillmentCreate(fulfillment: $fulfillment) {
    fulfillment { id status trackingInfo(first: 3) { number company url } }
    userErrors { field message }
  }
}`

export const TRACKING_UPDATE = `mutation AgentswsTrackingUpdate($fulfillmentId: ID!, $trackingInfoInput: FulfillmentTrackingInput!, $notifyCustomer: Boolean) {
  fulfillmentTrackingInfoUpdate(fulfillmentId: $fulfillmentId, trackingInfoInput: $trackingInfoInput, notifyCustomer: $notifyCustomer) {
    fulfillment { id trackingInfo(first: 3) { number company url } }
    userErrors { field message }
  }
}`

// ── 小工具 ───────────────────────────────────────────────────────────────

const plain = (html: string | undefined): string =>
  (html ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
const short = (t: string, n = 60): string => (t.length > n ? `${t.slice(0, n)}…` : t)
const money = (n: number): string => n.toFixed(2)
const base = (store: string, op: ShopOp) => ({ via: 'shop_admin', shop_op: op, store })

async function mutate(
  ctx: ApplyContext,
  name: string,
  document: string,
  variables: Obj,
  key: string,
) {
  const data = o(await ctx.admin.mutate({ name, document, variables }))
  const payload = o(data[key])
  const err = userErrorsOf(payload)
  if (err !== undefined) throw new ShopApplyError(`Shopify 没接受：${err}`)
  return payload
}

function stale(what: string): never {
  throw new ShopApplyError(
    `${what}在卡出来之后变过（店里现在的与卡上的「原来」不一样），这次没改。让 AI 重新读一遍再出卡。`,
  )
}

// ── 政策（A13） ──────────────────────────────────────────────────────────

export const POLICY_TYPES: Readonly<Record<string, { api: string; zh: string }>> = {
  refund: { api: 'REFUND_POLICY', zh: '退换货政策' },
  privacy: { api: 'PRIVACY_POLICY', zh: '隐私政策' },
  terms_of_service: { api: 'TERMS_OF_SERVICE', zh: '服务条款' },
  shipping: { api: 'SHIPPING_POLICY', zh: '配送政策' },
  contact: { api: 'CONTACT_INFORMATION', zh: '联系方式' },
}

async function readPolicies(reader: ShopifyAdminReader): Promise<Obj[]> {
  return arr(
    o(o(await reader.query({ name: 'site_policies', document: SITE_POLICIES })).shop).shopPolicies,
  )
}

async function savePolicy(ctx: ProposeContext, input: Obj): Promise<ShopDraft> {
  const key = str(input.type, 40)
  const spec = key === undefined ? undefined : POLICY_TYPES[key]
  if (spec === undefined)
    throw new ShopOpsError('invalid_input', `type 只认：${Object.keys(POLICY_TYPES).join(' / ')}`)
  const body = str(input.body_html, 64 * 1024)
  if (body === undefined) throw new ShopOpsError('invalid_input', '要给正文 body_html')
  const now = (await readPolicies(ctx.reader)).find((p) => s(p.type) === spec.api)
  const old = plain(s(now?.body))
  return {
    op: 'policy_update',
    target: { type: 'policy', id: spec.api },
    before: { policy: spec.zh, body: old === '' ? '（还没写）' : short(old, 200) },
    after: {
      ...base(ctx.access.store, 'policy_update'),
      policy_type: spec.api,
      policy: spec.zh,
      body_html: body,
    },
    title: `${old === '' ? '写上' : '改写'}「${spec.zh}」`,
    notes: [
      `这是 Shopify 的「政策」（设置 → 政策），不是普通页面；检查单认的是这里。`,
      `正文：${short(plain(body), 120)}`,
    ],
    // 这一刻真读过店里的政策（「原来」就是读到的）
    synthetic: true,
  }
}

async function applyPolicy(ctx: ApplyContext, a: Obj, before: Obj): Promise<Applied> {
  const type = s(a.policy_type) as string
  const nowBody = plain(s((await readPolicies(ctx.admin)).find((p) => s(p.type) === type)?.body))
  const was = s(before.body)
  if (was !== undefined && was !== '（还没写）' && !nowBody.startsWith(was.replace(/…$/, '')))
    stale('这张政策')
  if (was === '（还没写）' && nowBody !== '') stale('这张政策')
  await mutate(
    ctx,
    'policy_update',
    POLICY_UPDATE,
    { shopPolicy: { type, body: a.body_html } },
    'shopPolicyUpdate',
  )
  const back = plain(s((await readPolicies(ctx.admin)).find((p) => s(p.type) === type)?.body))
  const ok = back === plain(s(a.body_html))
  return {
    ref: { type: 'policy', id: type },
    verified: ok,
    ...(ok ? {} : { note: '政策正文读回来对不上' }),
  }
}

// ── 库存（B4） ───────────────────────────────────────────────────────────

interface Level {
  location: string
  location_name: string
  available: number
}

async function readLevels(
  reader: ShopifyAdminReader,
  variant: string,
): Promise<{ item: string; levels: Level[] }> {
  const v = o(
    o(
      await reader.query({
        name: 'variant_inventory',
        document: VARIANT_INVENTORY,
        variables: { id: variant },
      }),
    ).productVariant,
  )
  const item = o(v.inventoryItem)
  if (s(item.id) === undefined) throw new ShopOpsError('not_found', '店里找不到这个变体的库存')
  if (item.tracked === false)
    throw new ShopOpsError(
      'invalid_input',
      '这个变体没开「跟踪库存」，改不了数量（先在后台打开跟踪）',
    )
  const levels = nodes(item.inventoryLevels).map((l) => ({
    location: s(o(l.location).id) ?? '',
    location_name: s(o(l.location).name) ?? '',
    available: Number(arr(l.quantities).find((q) => s(q.name) === 'available')?.quantity ?? 0),
  }))
  return { item: s(item.id) as string, levels }
}

const REASONS = ['received', 'correction', 'damaged', 'shrinkage', 'restock'] as const
const REASON_ZH: Readonly<Record<string, string>> = {
  received: '收货',
  correction: '盘点更正',
  damaged: '损坏',
  shrinkage: '丢失 / 报损',
  restock: '退货入库',
}

async function adjustInventory(ctx: ProposeContext, input: Obj): Promise<ShopDraft> {
  if (!ctx.access.scopes.includes('read_inventory'))
    throw new ShopOpsError('not_allowed', '店铺授权里没有库存权限，去岗位页重新授权一次。')
  const id = gidOf('Product', input.product_id)
  if (id === undefined) throw new ShopOpsError('invalid_input', '要给商品 id')
  const delta = num(input.delta)
  if (delta === undefined || !Number.isInteger(delta) || delta === 0)
    throw new ShopOpsError('invalid_input', 'delta 要是不为 0 的整数（加几件 / 减几件）')
  if (!ctx.log.has(ctx.run_id, { type: 'product', id }))
    throw new ShopOpsError('must_read_first', '改之前先用 shop_get_product 读一遍（改前必读）。')
  const p = await readProduct(ctx.reader, ctx.access, id)
  const variants = nodes(p.variants)
  const wanted =
    input.variant_id === undefined ? undefined : gidOf('ProductVariant', input.variant_id)
  const v =
    wanted !== undefined
      ? variants.find((x) => x.id === wanted)
      : variants.length === 1
        ? variants[0]
        : undefined
  if (v === undefined)
    throw new ShopOpsError(
      'invalid_input',
      wanted === undefined
        ? `这件商品有 ${variants.length} 个变体，要给 variant_id`
        : '这件商品里没有这个变体',
    )
  const inv = await readLevels(ctx.reader, s(v.id) as string)
  const wantLoc = str(input.location_id, 200)
  const level =
    wantLoc !== undefined
      ? inv.levels.find((l) => l.location === wantLoc || l.location.endsWith(`/${wantLoc}`))
      : inv.levels.length === 1
        ? inv.levels[0]
        : undefined
  if (level === undefined)
    throw new ShopOpsError(
      'invalid_input',
      inv.levels.length === 0
        ? '这个变体还没放进任何一个仓'
        : `店里有 ${inv.levels.length} 个仓（${inv.levels.map((l) => `${l.location_name} ${l.location}`).join('、')}），要给 location_id`,
    )
  const reasonIn = str(input.reason, 20) ?? 'correction'
  const reason = (REASONS as readonly string[]).includes(reasonIn) ? reasonIn : 'correction'
  const after = level.available + delta
  if (after < 0)
    throw new ShopOpsError('invalid_input', `现在只有 ${level.available} 件，减不了 ${-delta} 件`)
  const label = s(v.title) === 'Default Title' || s(v.title) === undefined ? '' : ` · ${s(v.title)}`
  return {
    op: 'inventory_adjust',
    target: { type: 'inventory', id: inv.item },
    field: 'available',
    before: { quantity: level.available, location_name: level.location_name },
    after: {
      ...base(ctx.access.store, 'inventory_adjust'),
      product_id: id,
      variant_id: s(v.id),
      product_title: s(p.title),
      inventory_item: inv.item,
      location: level.location,
      location_name: level.location_name,
      mode: 'adjust',
      delta,
      quantity: after,
      reason,
    },
    title: `库存：「${short(s(p.title) ?? '', 30)}${label}」${level.available} → ${after}（${delta > 0 ? '+' : ''}${delta}，${REASON_ZH[reason]}）`,
    notes: [`仓：${level.location_name}`, `可售：${level.available} → ${after}`],
  }
}

async function applyInventory(
  ctx: ApplyContext,
  a: Obj,
  before: Obj,
  change_id: string,
): Promise<Applied> {
  const variant = s(a.variant_id) as string
  const inv = await readLevels(ctx.admin, variant)
  const level = inv.levels.find((l) => l.location === s(a.location))
  if (level === undefined) throw new ShopApplyError('这个仓里找不到这件货了')
  if (level.available !== Number(before.quantity)) stale('这一格库存')
  const delta = Number(a.delta)
  await mutate(
    ctx,
    'inventory_adjust',
    INVENTORY_ADJUST,
    {
      input: {
        reason: s(a.reason) ?? 'correction',
        name: 'available',
        changes: [
          {
            delta,
            inventoryItemId: inv.item,
            locationId: level.location,
            changeFromQuantity: level.available,
          },
        ],
      },
      // 同一张卡重放不会加两次（Shopify 2026-04 起这个键必填）
      idempotencyKey: change_id,
    },
    'inventoryAdjustQuantities',
  )
  const back = (await readLevels(ctx.admin, variant)).levels.find(
    (l) => l.location === level.location,
  )
  const ok = back !== undefined && back.available === level.available + delta
  return {
    ref: { type: 'inventory', id: inv.item },
    verified: ok,
    ...(ok
      ? {}
      : { note: `读回来是 ${back?.available ?? '读不到'}，应是 ${level.available + delta}` }),
  }
}

// ── 全站自动折扣（B5） ───────────────────────────────────────────────────

async function createPromotion(ctx: ProposeContext, input: Obj): Promise<ShopDraft> {
  const title = str(input.title)
  if (title === undefined) throw new ShopOpsError('invalid_input', '要给活动名 title')
  const percent = num(input.percent)
  const amount_off = num(input.amount_off)
  if ((percent === undefined) === (amount_off === undefined))
    throw new ShopOpsError(
      'invalid_input',
      'percent（减百分之几）与 amount_off（每单减多少）给一个',
    )
  if (percent !== undefined && (percent <= 0 || percent > 100))
    throw new ShopOpsError('invalid_input', 'percent 要在 0–100 之间')
  if (amount_off !== undefined && amount_off <= 0)
    throw new ShopOpsError('invalid_input', 'amount_off 要大于 0')
  const date = (raw: unknown, name: string): Date | undefined => {
    const t = str(raw, 40)
    if (t === undefined) return undefined
    const d = new Date(t)
    if (Number.isNaN(d.getTime())) throw new ShopOpsError('invalid_input', `${name} 认不出`)
    return d
  }
  const starts = date(input.starts_at, 'starts_at')
  const ends = date(input.ends_at, 'ends_at')
  if (starts !== undefined && ends !== undefined && ends <= starts)
    throw new ShopOpsError('invalid_input', '结束时间要晚于开始时间')
  const minimum = num(input.minimum_subtotal)
  const power = percent !== undefined ? `全站减 ${percent}%` : `每单减 ${amount_off}`
  const fmt = (d: Date): string => d.toISOString().slice(0, 16).replace('T', ' ')
  return {
    op: 'automatic_discount_create',
    target: { type: 'campaign', id: `auto:${title}` },
    before: {},
    after: {
      ...base(ctx.access.store, 'automatic_discount_create'),
      title,
      ...(percent === undefined ? {} : { percent }),
      ...(amount_off === undefined ? {} : { amount_off }),
      ...(starts === undefined ? {} : { starts_at: starts.toISOString() }),
      ...(ends === undefined ? {} : { ends_at: ends.toISOString() }),
      ...(minimum === undefined || minimum <= 0 ? {} : { minimum_subtotal: minimum }),
    },
    title: `全站活动「${short(title, 30)}」：${power}`,
    notes: [
      `顾客不用输码，整店商品自动${power}${minimum !== undefined && minimum > 0 ? `（满 ${minimum}）` : ''}`,
      `时间：${starts === undefined ? '批了马上' : fmt(starts)} 起，${ends === undefined ? '不设结束（记得自己关）' : `到 ${fmt(ends)}`}`,
    ],
    synthetic: true,
  }
}

async function applyPromotion(ctx: ApplyContext, a: Obj): Promise<Applied> {
  const value =
    typeof a.percent === 'number'
      ? { percentage: Math.round(a.percent * 100) / 10000 }
      : { discountAmount: { amount: money(a.amount_off as number), appliesOnEachItem: false } }
  const out = await mutate(
    ctx,
    'auto_discount_create',
    AUTO_DISCOUNT_CREATE,
    {
      input: {
        title: a.title,
        startsAt: a.starts_at ?? ctx.now(),
        ...(a.ends_at === undefined ? {} : { endsAt: a.ends_at }),
        customerGets: { value, items: { all: true } },
        ...(typeof a.minimum_subtotal === 'number'
          ? {
              minimumRequirement: {
                subtotal: { greaterThanOrEqualToSubtotal: money(a.minimum_subtotal) },
              },
            }
          : {}),
      },
    },
    'discountAutomaticBasicCreate',
  )
  const id = s(o(out.automaticDiscountNode).id)
  if (id === undefined) throw new ShopApplyError('Shopify 没回新活动的 id')
  const back = o(
    o(await ctx.admin.query({ name: 'auto_discount', document: AUTO_DISCOUNT, variables: { id } }))
      .automaticDiscountNode,
  )
  const ok = s(o(back.automaticDiscount).title) === a.title
  return {
    ref: { type: 'campaign', id },
    verified: ok,
    ...(ok ? {} : { note: '活动读回来对不上' }),
  }
}

// ── 订单发货 / 回填单号（B10） ───────────────────────────────────────────

async function readOrder(reader: ShopifyAdminReader, id: string): Promise<Obj> {
  const order = o(
    o(
      await reader.query({
        name: 'order_fulfillment',
        document: ORDER_FULFILLMENT,
        variables: { id },
      }),
    ).order,
  )
  if (s(order.id) === undefined) throw new ShopOpsError('not_found', '店里找不到这张订单')
  return order
}

/** 还能发的那几行（未完成的发货单里剩下的）。 */
function openLines(order: Obj): { fo: string; id: string; name: string; remaining: number }[] {
  return nodes(order.fulfillmentOrders)
    .filter((fo) => ['OPEN', 'IN_PROGRESS', 'SCHEDULED'].includes(s(fo.status) ?? ''))
    .flatMap((fo) =>
      nodes(fo.lineItems)
        .filter((l) => Number(l.remainingQuantity ?? 0) > 0)
        .map((l) => ({
          fo: s(fo.id) as string,
          id: s(l.id) as string,
          name: s(o(l.lineItem).name) ?? '',
          remaining: Number(l.remainingQuantity),
        })),
    )
}

function orderOutline(order: Obj): Obj {
  return {
    id: s(order.id),
    name: s(order.name),
    fulfillment_status: s(order.displayFulfillmentStatus)?.toLowerCase(),
    financial_status: s(order.displayFinancialStatus)?.toLowerCase(),
    cancelled: order.cancelledAt !== null && order.cancelledAt !== undefined,
    to_ship: openLines(order).map((l) => ({ id: l.id, name: l.name, remaining: l.remaining })),
    shipped: arr(order.fulfillments).map((f) => ({
      fulfillment_id: s(f.id),
      status: s(f.status)?.toLowerCase(),
      tracking: arr(f.trackingInfo).map((t) => ({
        number: s(t.number),
        carrier: s(t.company),
        url: s(t.url),
      })),
    })),
  }
}

export async function readExtra(
  ctx: { reader: ShopifyAdminReader; log: ReadLog },
  tool: string,
  input: Obj,
  run_id: string,
): Promise<unknown | undefined> {
  if (tool !== 'shop_get_order') return undefined
  let id = gidOf('Order', input.id)
  const name = str(input.name, 40)
  if (id === undefined && name !== undefined) {
    const hit = nodes(
      o(
        await ctx.reader.query({
          name: 'order_by_name',
          document: ORDER_BY_NAME,
          variables: { query: `name:${name.replace(/[^#A-Za-z0-9-]/g, '')}` },
        }),
      ).orders,
    )[0]
    id = s(hit?.id)
  }
  if (id === undefined) throw new ShopOpsError('invalid_input', '要给订单 id 或订单号')
  const order = await readOrder(ctx.reader, id)
  ctx.log.mark(run_id, { type: 'order', id })
  return orderOutline(order)
}

async function fulfillOrder(ctx: ProposeContext, input: Obj): Promise<ShopDraft> {
  const id = gidOf('Order', input.order_id)
  if (id === undefined) throw new ShopOpsError('invalid_input', '要给订单 id')
  const tracking = str(input.tracking_number, 100)
  const carrier = str(input.carrier, 80)
  if (tracking === undefined || carrier === undefined)
    throw new ShopOpsError('invalid_input', '要给物流单号与承运商（单号没拿到就别出卡）')
  if (!ctx.log.has(ctx.run_id, { type: 'order', id }))
    throw new ShopOpsError('must_read_first', '先用 shop_get_order 读一遍这张单（改前必读）。')
  const url = str(input.tracking_url, 500)
  if (url !== undefined && !/^https:\/\//.test(url))
    throw new ShopOpsError('invalid_input', '查件链接要是 https 开头')
  const order = await readOrder(ctx.reader, id)
  const orderName = s(order.name) ?? id
  if (order.cancelledAt !== null && order.cancelledAt !== undefined)
    throw new ShopOpsError('invalid_input', `${orderName} 已经取消了`)
  const notify = input.notify_customer !== false
  const status = s(order.displayFulfillmentStatus)?.toLowerCase() ?? 'unknown'
  const fid =
    input.fulfillment_id === undefined ? undefined : gidOf('Fulfillment', input.fulfillment_id)
  if (fid !== undefined) {
    const f = arr(order.fulfillments).find((x) => s(x.id) === fid)
    if (f === undefined) throw new ShopOpsError('invalid_input', '这张单里没有这个包裹')
    const old = arr(f.trackingInfo)[0]
    return {
      op: 'tracking_update',
      target: { type: 'order', id },
      field: 'tracking',
      before: {
        fulfillment_status: 'tracking_update',
        tracking_number: s(old?.number) ?? '（没有）',
        carrier: s(old?.company) ?? '（没有）',
      },
      after: {
        ...base(ctx.access.store, 'tracking_update'),
        order_id: id,
        order_name: orderName,
        fulfillment_id: fid,
        tracking_number: tracking,
        carrier,
        ...(url === undefined ? {} : { tracking_url: url }),
        notify_customer: notify,
      },
      title: `回填单号：${orderName} → ${carrier} ${tracking}`,
      notes: [
        `原来：${s(old?.company) ?? '没有承运商'} ${s(old?.number) ?? '没有单号'}`,
        notify ? '会让 Shopify 给顾客发一封物流更新' : '不通知顾客',
      ],
    }
  }
  const lines = openLines(order)
  if (lines.length === 0) throw new ShopOpsError('invalid_input', `${orderName} 没有要发的了`)
  const wanted = Array.isArray(input.line_items) ? input.line_items.map(o) : []
  const picked =
    wanted.length === 0
      ? lines.map((l) => ({ ...l, quantity: l.remaining }))
      : wanted.map((w) => {
          const line = lines.find((l) => l.id === s(w.id))
          if (line === undefined)
            throw new ShopOpsError('invalid_input', `这张单里没有这一行（${String(w.id)}）`)
          const q = Math.floor(num(w.quantity) ?? line.remaining)
          if (q <= 0 || q > line.remaining)
            throw new ShopOpsError('invalid_input', `「${line.name}」只剩 ${line.remaining} 个能发`)
          return { ...line, quantity: q }
        })
  const partial = picked.length < lines.length || picked.some((p) => p.quantity < p.remaining)
  const by_fo = [...new Set(picked.map((p) => p.fo))].map((fo) => ({
    fulfillmentOrderId: fo,
    fulfillmentOrderLineItems: picked
      .filter((p) => p.fo === fo)
      .map((p) => ({ id: p.id, quantity: p.quantity })),
  }))
  const count = picked.reduce((n, p) => n + p.quantity, 0)
  return {
    op: 'fulfillment_create',
    target: { type: 'order', id },
    field: 'fulfillment',
    before: {
      fulfillment_status: status,
      to_ship: lines.map((l) => `${l.name} ×${l.remaining}`).join('、'),
    },
    after: {
      ...base(ctx.access.store, 'fulfillment_create'),
      order_id: id,
      order_name: orderName,
      by_fo,
      shipping: picked.map((p) => `${p.name} ×${p.quantity}`).join('、'),
      tracking_number: tracking,
      carrier,
      ...(url === undefined ? {} : { tracking_url: url }),
      notify_customer: notify,
    },
    title: `${partial ? '拆单先发' : '发货'}：${orderName}（${count} 件）· ${carrier} ${tracking}`,
    notes: [
      `这次发：${picked.map((p) => `${p.name} ×${p.quantity}`).join('、')}`,
      ...(partial ? ['剩下的留在这张单里，之后再发'] : []),
      notify ? '会让 Shopify 给顾客发发货通知' : '不通知顾客',
    ],
  }
}

async function applyFulfillment(ctx: ApplyContext, a: Obj): Promise<Applied> {
  const id = s(a.order_id) as string
  const order = await readOrder(ctx.admin, id)
  const tracking: Obj = {
    number: a.tracking_number,
    company: a.carrier,
    ...(a.tracking_url === undefined ? {} : { url: a.tracking_url }),
  }
  const hasTracking = (o2: Obj, fid?: string): boolean =>
    arr(o2.fulfillments).some(
      (f) =>
        (fid === undefined || s(f.id) === fid) &&
        arr(f.trackingInfo).some((t) => s(t.number) === a.tracking_number),
    )
  if (a.shop_op === 'tracking_update') {
    const fid = s(a.fulfillment_id) as string
    if (!arr(order.fulfillments).some((f) => s(f.id) === fid))
      throw new ShopApplyError('这个包裹在店里找不到了')
    await mutate(
      ctx,
      'tracking_update',
      TRACKING_UPDATE,
      {
        fulfillmentId: fid,
        trackingInfoInput: tracking,
        notifyCustomer: a.notify_customer !== false,
      },
      'fulfillmentTrackingInfoUpdate',
    )
    const ok = hasTracking(await readOrder(ctx.admin, id), fid)
    return { ref: { type: 'order', id }, verified: ok, ...(ok ? {} : { note: '单号读回来对不上' }) }
  }
  const lines = openLines(order)
  for (const g of arr(a.by_fo))
    for (const li of arr(g.fulfillmentOrderLineItems)) {
      const line = lines.find((l) => l.id === s(li.id))
      if (line === undefined || line.remaining < Number(li.quantity)) stale('这张单的待发数量')
    }
  await mutate(
    ctx,
    'fulfillment_create',
    FULFILLMENT_CREATE,
    {
      fulfillment: {
        lineItemsByFulfillmentOrder: a.by_fo,
        trackingInfo: tracking,
        notifyCustomer: a.notify_customer !== false,
      },
    },
    'fulfillmentCreate',
  )
  const ok = hasTracking(await readOrder(ctx.admin, id))
  return {
    ref: { type: 'order', id },
    verified: ok,
    ...(ok ? {} : { note: '发货记录读回来没有这个单号' }),
  }
}

// ── 分发 ─────────────────────────────────────────────────────────────────

export const EXTRA_WRITE_TOOLS: readonly string[] = [
  'shop_save_policy',
  'shop_adjust_inventory',
  'shop_create_automatic_discount',
  'shop_fulfill_order',
]

export async function draftExtra(
  tool: string,
  ctx: ProposeContext,
  input: Obj,
): Promise<ShopDraft | undefined> {
  switch (tool) {
    case 'shop_save_policy':
      return savePolicy(ctx, input)
    case 'shop_adjust_inventory':
      return adjustInventory(ctx, input)
    case 'shop_create_automatic_discount':
      return createPromotion(ctx, input)
    case 'shop_fulfill_order':
      return fulfillOrder(ctx, input)
    default:
      return undefined
  }
}

export async function applyExtra(
  ctx: ApplyContext,
  a: Obj,
  before: Obj,
  change: { id: string; target: ObjectRef },
): Promise<Applied | undefined> {
  switch (a.shop_op) {
    case 'policy_update':
      return applyPolicy(ctx, a, before)
    case 'inventory_adjust':
      return applyInventory(ctx, a, before, change.id)
    case 'automatic_discount_create':
      return applyPromotion(ctx, a)
    case 'fulfillment_create':
    case 'tracking_update':
      return applyFulfillment(ctx, a)
    default:
      return undefined
  }
}
