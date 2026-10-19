/**
 * WP417（自查客服 A24–A26）：客服动订单的三件事——**退款 / 改收货地址 / 补发**。
 *
 * 同 `shop-propose.ts` / `shop-apply.ts` 那一套（WP261）：
 *
 * - **出卡**（{@link orderDraftOf}）：一个字节都不改店铺。卡上的「原来」是这一刻现读的（已付、已退、发货状态、原地址），
 *   不是模型说的；超过能退的、已经发货的、读不到原地址的，**不出卡、照实说为什么**。
 * - **执行**（{@link applyOrderChange}）：人批过的卡才跑。改之前再读一次，卡上的「原来」对不上（有人在后台退过 / 改过）
 *   就不改；跑完**读回**——已退金额涨上去了、地址对上了、补发单建出来了，才算「好了」，对不上回 `verified: false`。
 *
 * 补发是在后台建一张 **0 元的补发单**（`draftOrderCreate` 带 100% 折扣 → `draftOrderComplete`），寄到原收货地址；
 * 发货仍走商家原来的发货流程。
 */
import type { ObjectRef } from '@agentsws/contracts'
import type { ShopifyAdmin, ShopifyAdminReader } from './shop-admin.js'
import type { Applied, ApplyContext } from './shop-apply.js'
import { ShopApplyError } from './shop-apply.js'
import {
  arr,
  DRAFT_ORDER_COMPLETE,
  DRAFT_ORDER_CREATE,
  nodes,
  ORDER_BY_NAME,
  ORDER_UPDATE,
  o,
  orderForChangeDoc,
  REFUND_CREATE,
  s,
  userErrorsOf,
} from './shop-graphql.js'
import type { ShopOp } from './shop-ops.js'
import { num, SHOP_VIA, ShopOpsError, str } from './shop-ops.js'

type Obj = Record<string, unknown>

/** 出卡要的那几样（与 `shop-propose.ts` 的 `ShopDraft` 同形，另带金额）。 */
export interface OrderDraft {
  op: ShopOp
  target: ObjectRef
  field: string
  before: Obj
  after: Obj
  title: string
  notes: string[]
  money?: { amount: number; currency: string }
}

export interface OrderAddress {
  first_name?: string
  last_name?: string
  address1: string
  address2?: string
  city: string
  province_code?: string
  zip: string
  country_code: string
  phone?: string
}

const money2 = (n: number): number => Math.round(n * 100) / 100
const amountOf = (set: unknown): number => Number(s(o(o(set).shopMoney).amount) ?? '0') || 0

/** `#1001` / `1001`（短号）按订单名找；长数字 / gid 直接用。 */
export async function resolveOrderId(reader: ShopifyAdminReader, raw: unknown): Promise<string> {
  const t = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : ''
  const gid = /^gid:\/\/shopify\/Order\/\d{1,20}$/.exec(t)
  if (gid !== null) return t
  const short = /^#?(\d{1,8})$/.exec(t)
  if (short !== null) {
    const hits = nodes(
      o(
        await reader.query({
          name: 'order_by_name',
          document: ORDER_BY_NAME,
          variables: { query: `name:#${short[1]}` },
        }),
      ).orders,
    )
    const hit = hits.find((h) => s(h.name)?.replace(/^#/, '') === short[1])
    if (hit === undefined || s(hit.id) === undefined)
      throw new ShopOpsError('not_found', `店铺后台里没有订单 #${short[1]}`)
    return s(hit.id) as string
  }
  if (/^\d{9,20}$/.test(t)) return `gid://shopify/Order/${t}`
  throw new ShopOpsError('invalid_input', '要给订单号（#1001）或订单 id')
}

/**
 * 现读这一单。`address: true` 先带收货地址读；报错（多半是「受保护的顾客数据」没过审）就退一步不带地址再读，
 * 回 `address_readable: false`——退款照样出卡，改地址 / 补发照实说读不到。
 */
export async function readOrderForChange(
  reader: ShopifyAdminReader,
  id: string,
  address: boolean,
): Promise<{ order: Obj; address_readable: boolean }> {
  const once = async (withAddress: boolean) =>
    o(
      o(
        await reader.query({
          name: 'order_for_change',
          document: orderForChangeDoc(withAddress),
          variables: { id },
        }),
      ).order,
    )
  let order: Obj
  let readable = address
  if (address) {
    try {
      order = await once(true)
    } catch {
      order = await once(false)
      readable = false
    }
  } else order = await once(false)
  if (s(order.id) === undefined) throw new ShopOpsError('not_found', '店里找不到这一单')
  return { order, address_readable: readable && Object.keys(o(order.shippingAddress)).length > 0 }
}

export const formatAddress = (a: Obj): string =>
  [
    [s(a.firstName) ?? s(a.first_name), s(a.lastName) ?? s(a.last_name)]
      .filter(Boolean)
      .join(' ') || s(a.name),
    s(a.address1),
    s(a.address2),
    s(a.city),
    s(a.provinceCode) ?? s(a.province_code),
    s(a.zip),
    s(a.countryCodeV2) ?? s(a.country_code),
  ]
    .filter((x) => x !== undefined && x !== '')
    .join('，')

/** 店里那份地址 → 执行器 / 读回比对用的同一个形状。 */
export function addressOf(a: Obj): OrderAddress {
  const out: OrderAddress = {
    address1: s(a.address1) ?? '',
    city: s(a.city) ?? '',
    zip: s(a.zip) ?? '',
    country_code: s(a.countryCodeV2) ?? s(a.country_code) ?? '',
  }
  const first = s(a.firstName) ?? s(a.first_name)
  const last = s(a.lastName) ?? s(a.last_name)
  const a2 = s(a.address2)
  const prov = s(a.provinceCode) ?? s(a.province_code)
  const phone = s(a.phone)
  if (first !== undefined) out.first_name = first
  if (last !== undefined) out.last_name = last
  if (a2 !== undefined) out.address2 = a2
  if (prov !== undefined) out.province_code = prov
  if (phone !== undefined) out.phone = phone
  return out
}

const sameAddress = (a: OrderAddress, b: OrderAddress): boolean =>
  a.address1 === b.address1 &&
  (a.address2 ?? '') === (b.address2 ?? '') &&
  a.city === b.city &&
  a.zip === b.zip &&
  a.country_code.toUpperCase() === b.country_code.toUpperCase()

const PAID = new Set(['PAID', 'PARTIALLY_PAID', 'PARTIALLY_REFUNDED'])

/** 可退的那一笔收款（成功的 SALE / CAPTURE）。 */
const refundableTx = (order: Obj): Obj | undefined =>
  arr(order.transactions).find(
    (t) => (s(t.kind) === 'SALE' || s(t.kind) === 'CAPTURE') && s(t.status) === 'SUCCESS',
  )

// ── 出卡 ─────────────────────────────────────────────────────────────────

async function refundDraft(
  reader: ShopifyAdminReader,
  store: string,
  input: Obj,
): Promise<OrderDraft> {
  const reason = str(input.reason, 500)
  if (reason === undefined) throw new ShopOpsError('invalid_input', '要说一句为什么退（reason）')
  const id = await resolveOrderId(reader, input.order_id)
  const { order } = await readOrderForChange(reader, id, false)
  const name = s(order.name) ?? id
  const currency =
    s(order.currencyCode) ?? s(o(o(order.totalPriceSet).shopMoney).currencyCode) ?? ''
  if (s(order.cancelledAt) !== undefined)
    throw new ShopOpsError('invalid_input', `${name} 已经取消了，退款要在后台看一眼`)
  const status = s(order.displayFinancialStatus) ?? ''
  if (!PAID.has(status))
    throw new ShopOpsError(
      'invalid_input',
      status === 'REFUNDED'
        ? `${name} 已经全额退过了`
        : `${name} 现在的付款状态是「${status || '未知'}」，退不了（只有已付款的单能退）`,
    )
  const paid = amountOf(order.totalPriceSet)
  const refunded = amountOf(order.totalRefundedSet)
  const left = money2(paid - refunded)
  if (!(left > 0)) throw new ShopOpsError('invalid_input', `${name} 已经全额退过了`)
  const asked = num(input.amount)
  const amount = money2(asked ?? left)
  if (!(amount > 0)) throw new ShopOpsError('invalid_input', '退款金额要大于 0')
  if (amount > left + 0.005)
    throw new ShopOpsError('invalid_input', `${name} 最多还能退 ${left} ${currency}`)
  const tx = refundableTx(order)
  if (tx === undefined || s(tx.id) === undefined || s(tx.gateway) === undefined)
    throw new ShopOpsError(
      'invalid_input',
      `${name} 找不到能原路退回的那笔收款（可能是货到付款或手动标的已付），要在后台手动退`,
    )
  const notify = input.notify_customer === true
  return {
    op: 'order_refund',
    target: { type: 'order', id },
    field: 'refunded_amount',
    before: { order: name, paid, refunded },
    after: {
      via: SHOP_VIA,
      shop_op: 'order_refund',
      store,
      order_id: id,
      transaction_id: s(tx.id),
      gateway: s(tx.gateway),
      notify,
      order: name,
      amount,
      currency,
      refunded: money2(refunded + amount),
      reason,
    },
    title: `退款：${name} 退 ${amount} ${currency}`,
    notes: [
      `这一单付了 ${paid} ${currency}，已退 ${refunded}，这次退 ${amount}`,
      `原因：${reason}`,
      notify ? '退完 Shopify 会给顾客发通知' : '不给顾客发 Shopify 通知（回信里说）',
    ],
    money: { amount, currency },
  }
}

function addressIn(input: Obj): OrderAddress {
  const a1 = str(input.address1)
  const city = str(input.city, 100)
  const zip = str(input.zip, 20)
  const country = str(input.country_code, 2)
  if (a1 === undefined || city === undefined || zip === undefined || country === undefined)
    throw new ShopOpsError('invalid_input', '新地址要给街道、城市、邮编和国家代码（如 US）')
  const out: OrderAddress = {
    address1: a1,
    city,
    zip,
    country_code: country.toUpperCase(),
  }
  const a2 = str(input.address2)
  const prov = str(input.province_code, 10)
  const phone = str(input.phone, 40)
  const name = str(input.name, 120)
  if (a2 !== undefined) out.address2 = a2
  if (prov !== undefined) out.province_code = prov.toUpperCase()
  if (phone !== undefined) out.phone = phone
  if (name !== undefined) {
    const parts = name.split(/\s+/)
    out.first_name = parts.slice(0, -1).join(' ') || name
    if (parts.length > 1) out.last_name = parts.at(-1) as string
  }
  return out
}

async function addressDraft(
  reader: ShopifyAdminReader,
  store: string,
  input: Obj,
): Promise<OrderDraft> {
  const id = await resolveOrderId(reader, input.order_id)
  const next = addressIn(input)
  const { order, address_readable } = await readOrderForChange(reader, id, true)
  const name = s(order.name) ?? id
  const fulfilled = s(order.displayFulfillmentStatus) ?? 'UNFULFILLED'
  if (fulfilled !== 'UNFULFILLED')
    throw new ShopOpsError('invalid_input', `${name} 已经发货（或部分发货），地址改不了了`)
  if (!address_readable)
    throw new ShopOpsError(
      'not_allowed',
      `读不到 ${name} 的原收货地址（店铺授权没给顾客资料），改地址要在 Shopify 后台改`,
    )
  const old = addressOf(o(order.shippingAddress))
  const merged: OrderAddress = {
    ...next,
    ...(next.first_name === undefined && old.first_name !== undefined
      ? { first_name: old.first_name }
      : {}),
    ...(next.last_name === undefined && old.last_name !== undefined
      ? { last_name: old.last_name }
      : {}),
    ...(next.phone === undefined && old.phone !== undefined ? { phone: old.phone } : {}),
  }
  if (sameAddress(old, merged))
    throw new ShopOpsError('invalid_input', `${name} 现在就是这个地址，不用改`)
  const reason = str(input.reason, 500)
  return {
    op: 'order_address',
    target: { type: 'order', id },
    field: 'shipping_address',
    before: { order: name, shipping_to: formatAddress(old as unknown as Obj), _old: old },
    after: {
      via: SHOP_VIA,
      shop_op: 'order_address',
      store,
      order_id: id,
      address: merged,
      order: name,
      shipping_to: formatAddress(merged as unknown as Obj),
      ...(reason === undefined ? {} : { reason }),
    },
    title: `改地址：${name}`,
    notes: [
      `原来：${formatAddress(old as unknown as Obj)}`,
      `改成：${formatAddress(merged as unknown as Obj)}`,
      ...(reason === undefined ? [] : [`原因：${reason}`]),
    ],
  }
}

async function reshipDraft(
  reader: ShopifyAdminReader,
  store: string,
  input: Obj,
): Promise<OrderDraft> {
  const reason = str(input.reason, 500)
  if (reason === undefined)
    throw new ShopOpsError('invalid_input', '要说一句为什么补发（漏发 / 错发 / 破损…）')
  const id = await resolveOrderId(reader, input.order_id)
  const { order, address_readable } = await readOrderForChange(reader, id, true)
  const name = s(order.name) ?? id
  const lines = nodes(order.lineItems)
  const wanted = str(input.line_item_id, 200)
  const line =
    wanted !== undefined
      ? lines.find((l) => s(l.id) === wanted || s(l.id)?.endsWith(`/${wanted}`))
      : lines.length === 1
        ? lines[0]
        : undefined
  if (line === undefined)
    throw new ShopOpsError(
      'invalid_input',
      wanted === undefined
        ? `${name} 有 ${lines.length} 件商品，要说补哪一件（line_item_id）`
        : `${name} 里没有这一件`,
    )
  const variant = s(o(line.variant).id)
  if (variant === undefined)
    throw new ShopOpsError(
      'invalid_input',
      `「${s(line.title) ?? ''}」这件商品已经不在店里了，补发不了`,
    )
  const qty = Math.floor(num(input.quantity) ?? 1)
  const bought = Number(line.quantity ?? 0)
  if (!(qty >= 1) || qty > bought)
    throw new ShopOpsError('invalid_input', `补发数量要在 1 到 ${bought} 之间`)
  if (!address_readable)
    throw new ShopOpsError(
      'not_allowed',
      `读不到 ${name} 的收货地址（店铺授权没给顾客资料），补发要在 Shopify 后台建单`,
    )
  const to = addressOf(o(order.shippingAddress))
  const title = s(line.title) ?? '这件商品'
  return {
    op: 'order_reship',
    target: { type: 'order', id },
    field: 'reship',
    before: { order: name },
    after: {
      via: SHOP_VIA,
      shop_op: 'order_reship',
      store,
      order_id: id,
      line_item_id: s(line.id),
      variant_id_reship: variant,
      address: to,
      order: name,
      item: title,
      quantity: qty,
      ship_to: formatAddress(to as unknown as Obj),
      reason,
    },
    title: `补发：${name} 的「${title}」× ${qty}`,
    notes: [
      `免费再寄 ${qty} 件「${title}」（后台建一张 0 元补发单）`,
      `寄到：${formatAddress(to as unknown as Obj)}`,
      `原因：${reason}`,
    ],
  }
}

export async function orderDraftOf(
  tool: string,
  reader: ShopifyAdminReader,
  store: string,
  input: Obj,
): Promise<OrderDraft> {
  switch (tool) {
    case 'shop_refund_order':
      return refundDraft(reader, store, input)
    case 'shop_change_order_address':
      return addressDraft(reader, store, input)
    case 'shop_reship_order':
      return reshipDraft(reader, store, input)
    default:
      throw new ShopOpsError('not_allowed', `不认识的改动：${tool}`)
  }
}

// ── 执行（人批过的卡） ─────────────────────────────────────────────────────

async function mutate(
  admin: ShopifyAdmin,
  name: string,
  document: string,
  variables: Obj,
  key: string,
) {
  const data = o(await admin.mutate({ name, document, variables }))
  const payload = o(data[key])
  const err = userErrorsOf(payload)
  if (err !== undefined) throw new ShopApplyError(`Shopify 没接受：${err}`)
  return payload
}

async function applyRefund(ctx: ApplyContext, a: Obj, before: Obj): Promise<Applied> {
  const id = s(a.order_id) as string
  const { order } = await readOrderForChange(ctx.admin, id, false)
  const refundedNow = amountOf(order.totalRefundedSet)
  if (Math.abs(refundedNow - Number(before.refunded ?? 0)) > 0.005)
    throw new ShopApplyError(
      `${s(order.name) ?? '这一单'}在卡出来之后又退过一次（已退 ${refundedNow}），这次没退。让 AI 重新读一遍再出卡。`,
    )
  const amount = Number(a.amount)
  await mutate(
    ctx.admin,
    'refund_create',
    REFUND_CREATE,
    {
      input: {
        orderId: id,
        note: s(a.reason) ?? '',
        notify: a.notify === true,
        transactions: [
          {
            orderId: id,
            parentId: a.transaction_id,
            gateway: a.gateway,
            kind: 'REFUND',
            amount: amount.toFixed(2),
          },
        ],
      },
    },
    'refundCreate',
  )
  const back = (await readOrderForChange(ctx.admin, id, false)).order
  const after = amountOf(back.totalRefundedSet)
  const ok = Math.abs(after - (refundedNow + amount)) <= 0.01
  return {
    ref: { type: 'order', id },
    verified: ok,
    ...(ok ? {} : { note: `读回来已退 ${after}，和预期的 ${money2(refundedNow + amount)} 对不上` }),
  }
}

const addressInput = (a: OrderAddress): Obj => ({
  address1: a.address1,
  ...(a.address2 === undefined ? {} : { address2: a.address2 }),
  city: a.city,
  zip: a.zip,
  countryCode: a.country_code,
  ...(a.province_code === undefined ? {} : { provinceCode: a.province_code }),
  ...(a.first_name === undefined ? {} : { firstName: a.first_name }),
  ...(a.last_name === undefined ? {} : { lastName: a.last_name }),
  ...(a.phone === undefined ? {} : { phone: a.phone }),
})

async function applyAddress(ctx: ApplyContext, a: Obj, before: Obj): Promise<Applied> {
  const id = s(a.order_id) as string
  const { order, address_readable } = await readOrderForChange(ctx.admin, id, true)
  if (!address_readable) throw new ShopApplyError('读不到这一单的原地址，这次没改')
  if ((s(order.displayFulfillmentStatus) ?? 'UNFULFILLED') !== 'UNFULFILLED')
    throw new ShopApplyError('这一单在卡出来之后发货了，地址改不了了')
  const old = o(before.old)
  if (
    Object.keys(old).length > 0 &&
    !sameAddress(addressOf(old), addressOf(o(order.shippingAddress)))
  )
    throw new ShopApplyError(
      '这一单的地址在卡出来之后被改过（店里现在的与卡上的「原来」不一样），这次没改。让 AI 重新读一遍再出卡。',
    )
  const next = o(a.address) as unknown as OrderAddress
  await mutate(
    ctx.admin,
    'order_update',
    ORDER_UPDATE,
    { input: { id, shippingAddress: addressInput(next) } },
    'orderUpdate',
  )
  const back = await readOrderForChange(ctx.admin, id, true)
  const ok = back.address_readable && sameAddress(addressOf(o(back.order.shippingAddress)), next)
  return {
    ref: { type: 'order', id },
    verified: ok,
    ...(ok ? {} : { note: '地址读回来对不上' }),
  }
}

async function applyReship(ctx: ApplyContext, a: Obj): Promise<Applied> {
  const to = o(a.address) as unknown as OrderAddress
  const created = await mutate(
    ctx.admin,
    'draft_order_create',
    DRAFT_ORDER_CREATE,
    {
      input: {
        note: `补发 ${s(a.order) ?? ''}：${s(a.reason) ?? ''}`.trim(),
        tags: ['补发'],
        shippingAddress: addressInput(to),
        lineItems: [
          {
            variantId: a.variant_id_reship,
            quantity: Number(a.quantity ?? 1),
            appliedDiscount: { valueType: 'PERCENTAGE', value: 100, title: '补发' },
          },
        ],
      },
    },
    'draftOrderCreate',
  )
  const draftId = s(o(created.draftOrder).id)
  if (draftId === undefined) throw new ShopApplyError('Shopify 没回补发单的编号，去后台看一眼')
  const done = await mutate(
    ctx.admin,
    'draft_order_complete',
    DRAFT_ORDER_COMPLETE,
    { id: draftId },
    'draftOrderComplete',
  )
  const draft = o(done.draftOrder)
  const newOrder = o(draft.order)
  const ok = s(draft.status) === 'COMPLETED' && s(newOrder.id) !== undefined
  return {
    ref: { type: 'order', id: s(newOrder.id) ?? draftId },
    verified: ok,
    ...(ok
      ? { note: `补发单 ${s(newOrder.name) ?? ''}`.trim() }
      : { note: '补发单建了，但没读回成单（去后台「草稿订单」看一眼）' }),
  }
}

/** 批过的订单卡 → 真改 + 读回（`shop-apply.ts` 的 `applyShopChange` 认不出的 op 交到这里）。 */
export async function applyOrderChange(
  ctx: ApplyContext,
  a: Obj,
  before: Obj,
): Promise<Applied | undefined> {
  switch (a.shop_op) {
    case 'order_refund':
      return applyRefund(ctx, a, before)
    case 'order_address':
      return applyAddress(ctx, a, before)
    case 'order_reship':
      return applyReship(ctx, a)
    default:
      return undefined
  }
}
