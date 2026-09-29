/**
 * WP182（docs/84 §3.2）：业务员离职 / 被移出时的交接清单——他的客户、商机、未回询盘，
 * 按地区 / 产品线分给接手的人（`ownership.ts` 的 `buildTransferPlan`，规则第一条命中生效），
 * 出一张卡给老板批。
 *
 * 规则从哪来：**接手的人已经在管哪些地区 / 产品线**（他名下客户的 `region` / `product_lines`）。
 * 管欧洲的同事接欧洲的客户、管充电器的接充电器；都对不上的交给「兜底的那一位」（调用方给：
 * 通常是上级，没有上级就是第一个还在做业务的同事）。一个接手的人都没有 = 全部待分，老板在卡上定。
 */
import type {
  B2bAccount,
  B2bHandoverItem,
  B2bInquiry,
  B2bOpportunity,
  PersonId,
} from '@agentsws/contracts'
import { buildTransferPlan, type OwnedRecord, type TransferRule } from './ownership.js'

export interface HandoverSuccessor {
  person_id: PersonId
  /** 他已经在管的地区 / 产品线（不给就按他名下的客户现算）。 */
  regions?: readonly string[]
  product_lines?: readonly string[]
}

const regionOf = (a: B2bAccount | undefined): string | undefined => a?.region ?? a?.country

/** 他名下的客户推出来的「在管哪些地区 / 产品线」。 */
export function coverageOf(
  person_id: PersonId,
  accounts: readonly B2bAccount[],
): { regions: string[]; product_lines: string[] } {
  const mine = accounts.filter((a) => a.owner_person_id === person_id)
  return {
    regions: [
      ...new Set(mine.flatMap((a) => (regionOf(a) === undefined ? [] : [regionOf(a) as string]))),
    ],
    product_lines: [...new Set(mine.flatMap((a) => a.product_lines))],
  }
}

/** 规则表：地区 + 产品线都对上的在前，只对上地区的、只对上产品线的其次，兜底一条放最后。 */
export function handoverRules(
  successors: readonly HandoverSuccessor[],
  accounts: readonly B2bAccount[],
  fallback?: PersonId,
): TransferRule[] {
  const withCoverage = successors.map((s) => {
    const cov = coverageOf(s.person_id, accounts)
    return {
      id: s.person_id,
      regions: s.regions ?? cov.regions,
      product_lines: s.product_lines ?? cov.product_lines,
    }
  })
  const rules: TransferRule[] = []
  for (const s of withCoverage)
    for (const region of s.regions)
      for (const product_line of s.product_lines)
        rules.push({ successor_id: s.id, region, product_line })
  for (const s of withCoverage)
    for (const region of s.regions) rules.push({ successor_id: s.id, region })
  for (const s of withCoverage)
    for (const product_line of s.product_lines) rules.push({ successor_id: s.id, product_line })
  const last = fallback ?? successors[0]?.person_id
  if (last !== undefined) rules.push({ successor_id: last })
  return rules
}

export interface HandoverPlan {
  items: B2bHandoverItem[]
  unassigned: B2bHandoverItem[]
  totals: { accounts: number; deals: number; inquiries: number; value_usd: number }
}

/**
 * 算交接清单。只算他名下的：客户与商机看 `owner_person_id`，询盘看 `owner_person_id` 且还没回。
 * 商机 / 询盘的地区与产品线跟着它挂的那家客户走。
 */
export function planHandover(input: {
  departing: PersonId
  accounts: readonly B2bAccount[]
  opportunities: readonly B2bOpportunity[]
  inquiries: readonly B2bInquiry[]
  successors: readonly HandoverSuccessor[]
  fallback?: PersonId
}): HandoverPlan {
  const byId = new Map(input.accounts.map((a) => [a.id, a]))
  const name = new Map<string, string>()
  const records: OwnedRecord[] = []
  for (const a of input.accounts) {
    if (a.owner_person_id !== input.departing) continue
    name.set(a.id, a.name)
    const region = regionOf(a)
    const product_line = a.product_lines[0]
    records.push({
      id: a.id,
      kind: 'account',
      owner_id: input.departing,
      ...(region === undefined ? {} : { region }),
      ...(product_line === undefined ? {} : { product_line }),
    })
  }
  for (const o of input.opportunities) {
    if (o.owner_person_id !== input.departing || o.stage === 'won' || o.stage === 'lost') continue
    const acc = byId.get(o.account_id)
    name.set(o.id, `${acc?.name ?? o.account_id} · ${o.name}`)
    const region = regionOf(acc)
    const product_line = o.product ?? acc?.product_lines[0]
    records.push({
      id: o.id,
      kind: 'deal',
      owner_id: input.departing,
      ...(o.value_usd === undefined ? {} : { value_usd: o.value_usd }),
      ...(region === undefined ? {} : { region }),
      ...(product_line === undefined ? {} : { product_line }),
    })
  }
  for (const i of input.inquiries) {
    if (i.owner_person_id !== input.departing || i.status !== 'new' || i.kind !== 'inquiry')
      continue
    const acc = i.account_id === undefined ? undefined : byId.get(i.account_id)
    name.set(i.id, `${acc?.name ?? i.from_domain} · ${i.subject}`)
    const region = regionOf(acc)
    const product_line = acc?.product_lines[0]
    records.push({
      id: i.id,
      kind: 'inquiry',
      owner_id: input.departing,
      ...(region === undefined ? {} : { region }),
      ...(product_line === undefined ? {} : { product_line }),
    })
  }
  const successors = input.successors.filter((s) => s.person_id !== input.departing)
  const fallback = input.fallback === input.departing ? undefined : input.fallback
  const plan = buildTransferPlan(
    input.departing,
    records,
    handoverRules(successors, input.accounts, fallback),
  )
  const itemOf = (r: OwnedRecord, successor_id?: string): B2bHandoverItem => ({
    kind: r.kind as B2bHandoverItem['kind'],
    id: r.id,
    name: name.get(r.id) ?? r.id,
    ...(successor_id === undefined ? {} : { successor_id: successor_id as PersonId }),
    ...(r.region === undefined ? {} : { region: r.region }),
    ...(r.product_line === undefined ? {} : { product_line: r.product_line }),
    ...(r.value_usd === undefined ? {} : { value_usd: r.value_usd }),
  })
  return {
    items: plan.assignments.map((a) => itemOf(a, a.successor_id)),
    unassigned: plan.unassigned.map((r) => itemOf(r)),
    totals: {
      accounts: plan.totals.accounts,
      deals: plan.totals.deals,
      inquiries: records.filter((r) => r.kind === 'inquiry').length,
      value_usd: plan.totals.value_usd,
    },
  }
}
