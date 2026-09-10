/**
 * 内置价目表（WP42 交付 2）。
 *
 * 为什么要有它：在这之前，设置页的「输入价 / 输出价」是两个空的数字框，
 * 用户得自己去官网翻出「每百万 token 多少钱」再填进来。填错了不会报错——
 * 只会让 22 §3 的三级预算按一个假数字拦人（或者永远拦不住）。
 *
 * 三条纪律：
 *
 * 1. **不换算币种**。各家官网标什么币种就记什么币种；汇率会过期，换算出来的数字
 *    比不填还危险。`currency` 跟着每条价一起走，界面上写出来。
 * 2. **分档一律记贵的那一档**（优惠时段 / 阶梯 / 批量都不记）。预算宁可保守：
 *    把上限算低了顶多多按一次「继续」，算高了是真花钱。
 * 3. **每条价都带出处**：`source_url` + `as_of`。界面上写「来源：官网 2026-09-10」，
 *    用户看得见这个数字是哪天从哪儿来的——而不是一个凭空出现的默认值。
 */
import catalog from './catalog.json' with { type: 'json' }

/** 这家的价目页能不能机器抽（`none` = 抓不了，只保内置价）。 */
export type PriceParserId = 'deepseek' | 'openai' | 'kimi' | 'zhipu' | 'none'

/** 一个模型的三个价（每百万 token）。 */
export interface CatalogPrice {
  in: number
  out: number
  cached: number
}

export interface CatalogModel extends CatalogPrice {
  model: string
  /** 上游收但不在价目表上单列的老名字（按同一条价计费）。 */
  aliases?: string[]
}

export interface CatalogVendor {
  id: string
  label: string
  currency: string
  /** 按接口地址的主机名认这家。 */
  hosts: string[]
  source_url: string
  /** 还要看的几页（Kimi 一个模型一页）。 */
  extra_source_urls?: string[]
  as_of: string
  parser: PriceParserId
  /** `parser: 'none'` 时说清楚为什么抓不了。 */
  parser_note?: string
  note?: string
  models: CatalogModel[]
}

export interface PriceCatalog {
  version: number
  as_of: string
  note: string
  vendors: CatalogVendor[]
}

/** 内置价目表本体（`catalog.json`）。 */
export const PRICE_CATALOG = catalog as PriceCatalog

/** 一条查出来的价：三个数字 + 币种 + 出处。 */
export interface CatalogHit extends CatalogPrice {
  vendor_id: string
  vendor_label: string
  currency: string
  source_url: string
  as_of: string
}

/** `https://api.deepseek.com/v1` → `api.deepseek.com`。认不出来就回空串。 */
export function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.toLowerCase()
  } catch {
    // 用户可能填了个没有协议的地址；补一个再试
    try {
      return new URL(`https://${baseUrl}`).hostname.toLowerCase()
    } catch {
      return ''
    }
  }
}

/** 按接口地址认这是哪一家。认不出来回 undefined（内置价就没有，用户自己填）。 */
export function vendorForBaseUrl(
  baseUrl: string,
  from: PriceCatalog = PRICE_CATALOG,
): CatalogVendor | undefined {
  const host = hostOf(baseUrl)
  if (host === '') return undefined
  return from.vendors.find((v) =>
    v.hosts.some((h) => host === h || host.endsWith(`.${h}`) || h.endsWith(`.${host}`)),
  )
}

/**
 * 查一个模型的内置价。
 *
 * 匹配顺序：**完全一样** → 别名 → 去掉日期后缀（`gpt-5.4-2026-01-01` → `gpt-5.4`）。
 * 再模糊就不猜了——猜错一个价比没有价更难查。
 */
export function catalogPrice(
  baseUrl: string,
  model: string,
  from: PriceCatalog = PRICE_CATALOG,
): CatalogHit | undefined {
  const vendor = vendorForBaseUrl(baseUrl, from)
  if (vendor === undefined) return undefined
  const hit = findModel(vendor, model)
  if (hit === undefined) return undefined
  return {
    in: hit.in,
    out: hit.out,
    cached: hit.cached,
    vendor_id: vendor.id,
    vendor_label: vendor.label,
    currency: vendor.currency,
    source_url: vendor.source_url,
    as_of: vendor.as_of,
  }
}

export function findModel(vendor: CatalogVendor, model: string): CatalogModel | undefined {
  const name = model.trim().toLowerCase()
  if (name === '') return undefined
  const exact = vendor.models.find((m) => m.model.toLowerCase() === name)
  if (exact !== undefined) return exact
  const alias = vendor.models.find((m) => (m.aliases ?? []).some((a) => a.toLowerCase() === name))
  if (alias !== undefined) return alias
  // `gpt-5.4-2026-01-01` / `qwen-plus-2025-12-01`：去掉尾巴上的日期再试一次
  const undated = name.replace(/-\d{4}-\d{2}-\d{2}$/, '').replace(/-\d{4}$/, '')
  if (undated === name) return undefined
  return vendor.models.find((m) => m.model.toLowerCase() === undated)
}
