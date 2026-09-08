import type { Clock, PermissionScope, RangeRef } from '@agentsws/contracts'
import { type DataActor, defineCollection } from '../src/index.js'

export function stepClock(start = '2026-09-09T00:00:00.000Z'): Clock {
  let n = 0
  const base = Date.parse(start)
  return {
    now: () => new Date(base + n++ * 1000).toISOString(),
  }
}

/** 05 §5 dtc.aftersales 的密级样例：cost_price 是 confidential，售后客服看不到。 */
export const product = defineCollection({
  name: 'product',
  domain: 'product',
  fields: {
    sku: { sensitivity: 'public' },
    title: { sensitivity: 'internal' },
    cost_price: { sensitivity: 'confidential' },
    supplier_quote: { sensitivity: 'confidential' },
  },
})

export const order = defineCollection({
  name: 'order',
  domain: 'order',
  fields: {
    total: { sensitivity: 'internal' },
    payout_note: { sensitivity: 'restricted' },
  },
})

export const customer = defineCollection({
  name: 'customer',
  domain: 'customer',
  fields: {
    display_name: { sensitivity: 'internal' },
    tier: { sensitivity: 'internal' },
    phone: { sensitivity: 'confidential', pii: true },
    email: { sensitivity: 'confidential', pii: true },
  },
})

export const ALL_COLLECTIONS = [product, order, customer]

export const SHOP_US: RangeRef = { kind: 'store', id: 'shop_us' }
export const SHOP_EU: RangeRef = { kind: 'store', id: 'shop_eu' }

/** 05 §5 dtc.aftersales 的 scopes（节选）：没有 product 域。 */
export const AFTERSALES_SCOPES: PermissionScope[] = [
  { domain: 'order', ops: ['read'], range: 'assigned', max_sensitivity: 'internal' },
  { domain: 'customer', ops: ['read', 'stage'], range: 'assigned', max_sensitivity: 'internal' },
]

export function actor(over: Partial<DataActor> & Pick<DataActor, 'grants'>): DataActor {
  return {
    person_id: over.person_id ?? 'p_amy',
    assignment_id: over.assignment_id ?? 'as_aftersales',
    workspace_id: over.workspace_id ?? 'ws_1',
    grants: over.grants,
    ranges: over.ranges ?? [SHOP_US],
  }
}
