/**
 * 44 的范围模型：品牌（范围组）怎么展开、产品线（`product_line`）怎么判命中。
 *
 * 三条纪律：
 *
 * 1. **品牌不是范围**（44 G1）：范围组只是"一组范围的名字"，判权限那一刻展开成成员，
 *    于是 19 §3 的过滤下推与 31 §3.1 的完整元组判定一行都不用改。
 * 2. **产品线是范围**（44 G2）：它切在一家店 / 一个账号 / 一个市场**里面**，
 *    成员由平台内的判据决定（Shopify 集合 / 标签 / 供应商 / 商品类型；亚马逊 ASIN / SKU 前缀 / 品牌）。
 * 3. **判不出来就是不在**：目标没带够属性（只给了 product_id，而产品线是按标签切的），
 *    这里回"不在范围内"而不是放行——越权的代价比多问一句大。
 *
 * 本文件是**纯函数**：不查库、不认 id，调用方把对象喂进来。
 */
import type { ProductLine, ProductLineRule, RangeGroup, RangeRef } from '@agentsws/contracts'
import { parseMarketId } from '@agentsws/contracts'

/** 范围的去重键。 */
export const rangeKey = (r: RangeRef): string => `${r.kind}:${r.id}`

/** 产品线只能挂在这三种范围下面（44 G2/G4）。 */
export const PRODUCT_LINE_PARENT_KINDS: readonly RangeRef['kind'][] = ['store', 'account', 'market']

/**
 * 授予的范围盖不盖得住目标范围。
 *
 * 同种同 id 当然盖得住；另加 44 G4 的一条父子关系：**`account` 隐含它下面全部 `market`**，
 * 靠的是 market 的 id 约定 `账号id:站点`（`amz_na:US`），不另建一张表。
 */
export function rangeCoversRef(granted: RangeRef, target: RangeRef): boolean {
  if (granted.kind === target.kind && granted.id === target.id) return true
  if (granted.kind === 'account' && target.kind === 'market')
    return parseMarketId(target.id)?.account === granted.id
  return false
}

/** 去重并保序（先来的排前面）。 */
export function dedupeRanges(ranges: Iterable<RangeRef>): RangeRef[] {
  const seen = new Set<string>()
  const out: RangeRef[] = []
  for (const r of ranges) {
    const key = rangeKey(r)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ kind: r.kind, id: r.id })
  }
  return out
}

/**
 * 44 G1/G3：显式挂的范围 ∪ 各范围组的成员，**取并集**。
 *
 * 组解析不到（被删了 / 跨工作区）就当它没有成员——不抛，因为展开发生在读路径上，
 * 一个坏引用不该让整个岗位打不开；缺失的组由 `RoleStore` 在写路径上拦。
 */
export function expandRanges(
  explicit: readonly RangeRef[],
  groups: readonly RangeGroup[],
): RangeRef[] {
  return dedupeRanges([...explicit, ...groups.flatMap((g) => g.members)])
}

/** 一次写动作的目标（44 G2 的第二处判定）。 */
export interface RangeTarget {
  platform: 'shopify' | 'amazon' | 'manual'
  /** 独立站的商品 id。 */
  product_ids?: string[]
  /** 亚马逊的 ASIN。 */
  asins?: string[]
  /** SKU（亚马逊按前缀切时用）。 */
  skus?: string[]
  /**
   * 目标商品在平台内的属性。产品线按标签 / 供应商 / 集合切时，光有 id 判不出来——
   * 调用方从记录里读出来一起带上（改价那条路本来就 `requires_record_read`）。
   */
  attributes?: {
    tags?: string[]
    vendor?: string
    product_type?: string
    collection_ids?: string[]
    brand?: string
  }
  /** 目标落在哪家店 / 哪个账号 / 哪个市场；给了就先按父范围筛一遍产品线。 */
  parent?: RangeRef
}

const overlaps = (a: readonly string[] | undefined, b: readonly string[] | undefined): boolean =>
  a !== undefined && b !== undefined && a.some((x) => b.includes(x))

/** 这条产品线的判据命中这个目标没有。**判据一条都没填 = 空产品线，谁都不命中**。 */
export function productLineMatches(rule: ProductLineRule, target: RangeTarget): boolean {
  const attrs = target.attributes ?? {}
  switch (rule.platform) {
    case 'manual':
      return overlaps(rule.product_ids, target.product_ids)
    case 'amazon': {
      if (overlaps(rule.asins, target.asins)) return true
      if (rule.sku_prefixes !== undefined && target.skus !== undefined) {
        const prefixes = rule.sku_prefixes
        if (target.skus.some((sku) => prefixes.some((p) => p !== '' && sku.startsWith(p))))
          return true
      }
      return rule.brand !== undefined && attrs.brand === rule.brand
    }
    default: {
      if (overlaps(rule.collection_ids, attrs.collection_ids)) return true
      if (overlaps(rule.tags, attrs.tags)) return true
      if (rule.vendors !== undefined && attrs.vendor !== undefined)
        if (rule.vendors.includes(attrs.vendor)) return true
      if (rule.product_types !== undefined && attrs.product_type !== undefined)
        if (rule.product_types.includes(attrs.product_type)) return true
      return false
    }
  }
}

/** `targetInRange` 的结论：放行说得出靠哪条范围，拒也说得出人话。 */
export interface TargetInRangeResult {
  ok: boolean
  /** 放行时：是这条范围盖住的。 */
  matched?: RangeRef
  /** 拒时的机器码：`unassigned_range` | `target_out_of_range`。 */
  code?: 'unassigned_range' | 'target_out_of_range'
  /** 拒时的人话。 */
  reason?: string
}

export interface TargetInRangeInput {
  ranges: readonly RangeRef[]
  target: RangeTarget
  /** 按 id 解析产品线定义；解析不到的产品线**不放行**（定义丢了不等于全放开）。 */
  productLine(id: string): ProductLine | undefined
}

/** 目标说成人话（拒绝理由里用）。 */
function describeTarget(target: RangeTarget): string {
  const ids = [...(target.product_ids ?? []), ...(target.asins ?? []), ...(target.skus ?? [])]
  return ids.length === 0 ? '这件商品' : ids.slice(0, 3).join('、')
}

/**
 * 44 G2 写动作那一半：目标商品落不落在这个岗位的范围里。
 *
 * 顺序是"先宽后窄"：
 * 1. 一条范围都没有 → `unassigned_range`（05 §5：范围为空的岗位看不到也动不了任何东西）；
 * 2. 有店铺 / 账号 / 市场这类**整层**范围盖住目标所在的那一层 → 放行
 *    （目标没说自己在哪一层时，有整层范围就算盖住——商品级的切法只有产品线才表达得了）；
 * 3. 否则逐条看产品线：父范围对得上、判据命中 → 放行；
 * 4. 都不中 → `target_out_of_range`。
 */
export function targetInRange(input: TargetInRangeInput): TargetInRangeResult {
  const { ranges, target } = input
  if (ranges.length === 0)
    return {
      ok: false,
      code: 'unassigned_range',
      reason: '这个岗位还没分配店铺 / 品牌 / 产品线，看不到也动不了店铺里的东西',
    }

  const wide = ranges.filter((r) => r.kind !== 'product_line')
  for (const r of wide) {
    if (target.parent === undefined || rangeCoversRef(r, target.parent))
      return { ok: true, matched: r }
  }

  const lines = ranges.filter((r) => r.kind === 'product_line')
  for (const r of lines) {
    const line = input.productLine(r.id)
    if (line === undefined) continue
    if (target.parent !== undefined && !rangeCoversRef(line.parent, target.parent)) continue
    if (productLineMatches(line.rule, target)) return { ok: true, matched: r }
  }

  const names = lines
    .map((r) => input.productLine(r.id)?.name ?? r.id)
    .concat(wide.map((r) => r.id))
  return {
    ok: false,
    code: 'target_out_of_range',
    reason: `${describeTarget(target)}不在这个岗位管的范围里（这个岗位管的是：${names.join('、')}）`,
  }
}

/**
 * 19 §3 过滤下推：能翻成 Shopify 搜索语法的就翻（翻不了的回 undefined，调用方拉回来本地切）。
 *
 * 四个字段 Admin GraphQL 的 `query:` 都认：`tag:` / `vendor:` / `product_type:` /
 * `collection_id:`。多个值之间是 OR，整段用括号包起来，好与外面的 `created_at:` 用空格（AND）拼。
 */
export function shopifyLineQuery(rule: ProductLineRule): string | undefined {
  if (rule.platform !== 'shopify') return undefined
  const clauses: string[] = []
  const push = (field: string, values: readonly string[] | undefined): void => {
    if (values === undefined || values.length === 0) return
    clauses.push(values.map((v) => `${field}:${quote(v)}`).join(' OR '))
  }
  push('collection_id', rule.collection_ids)
  push('tag', rule.tags)
  push('vendor', rule.vendors)
  push('product_type', rule.product_types)
  if (clauses.length === 0) return undefined
  return clauses.map((c) => `(${c})`).join(' OR ')
}

/** 带空格或引号的值要加引号（Shopify 搜索语法）。 */
function quote(value: string): string {
  return /[\s"()]/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value
}

/** 商品类的目标（44 G2 只对这些判范围；退款那种以订单为目标的走别的门禁）。 */
const PRODUCT_TARGET_TYPES: ReadonlySet<string> = new Set(['product', 'variant', 'listing'])

const stringOf = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v : undefined

const stringsOf = (v: unknown): string[] | undefined => {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string')
  const one = stringOf(v)
  return one === undefined ? undefined : one.split(',').map((s) => s.trim())
}

/**
 * 一条变更的目标 → `targetInRange` 认识的形状。
 *
 * `record` 是 stage 时读到的那份记录（15 §1：`before` 必须来自记录）。产品线按标签 /
 * 供应商 / 商品类型切时，判据全靠它——读不到就只剩 id，判不出来就当"不在"（见
 * `productLineMatches` 的注释）。目标不是商品类的回 `undefined` = **这一条不判**。
 */
export function rangeTargetOfProduct(
  target: { type: string; id: string },
  record: unknown,
  parent?: RangeRef,
): RangeTarget | undefined {
  if (!PRODUCT_TARGET_TYPES.has(target.type)) return undefined
  const r = record !== null && typeof record === 'object' ? (record as Record<string, unknown>) : {}
  const sku = stringOf(r.sku)
  const asin = stringOf(r.asin)
  const tags = stringsOf(r.tags)
  const vendor = stringOf(r.vendor)
  const productType = stringOf(r.product_type ?? r.productType)
  const brand = stringOf(r.brand)
  const collections = stringsOf(r.collection_ids ?? r.collections)
  return {
    platform: asin === undefined ? 'shopify' : 'amazon',
    product_ids: [target.id],
    ...(asin === undefined ? {} : { asins: [asin] }),
    ...(sku === undefined ? {} : { skus: [sku] }),
    attributes: {
      ...(tags === undefined ? {} : { tags }),
      ...(vendor === undefined ? {} : { vendor }),
      ...(productType === undefined ? {} : { product_type: productType }),
      ...(brand === undefined ? {} : { brand }),
      ...(collections === undefined ? {} : { collection_ids: collections }),
    },
    ...(parent === undefined ? {} : { parent }),
  }
}
