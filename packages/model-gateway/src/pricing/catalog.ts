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

/**
 * 这家怎么收钱。
 *
 * - `per_token`（默认）：按 token 算，`in / out / cached` 是每百万 token 的价；
 * - `quota`：**包月 / 包周套餐**，调用不按 token 扣钱，扣的是次数配额（百炼 Coding Plan
 *   就是这样：¥200/月，每 5 小时 6000 次、每周 45000 次）。这一档的三个价一律是 0——
 *   **不是"价未知"，是"这次调用真的不花钱"**，所以 22 §3 的 `cost_base` 记 0 而
 *   token 照记（配额用掉多少由上游那边算，我们这边算不出来也不该编）。
 */
export type BillingMode = 'per_token' | 'quota'

export interface CatalogVendor {
  id: string
  label: string
  currency: string
  /** 怎么收钱；不写就是按 token。 */
  billing?: BillingMode
  /**
   * 按接口地址的主机名认这家。**写全写准**：`vendorForBaseUrl` 先比完全相等，
   * 所以互为子域的两家（百炼按量的 `dashscope.aliyuncs.com` 与 Coding Plan 的
   * `coding.dashscope.aliyuncs.com`）只要各自都列全，就各归各的、与行序无关。
   */
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

/**
 * 按接口地址认这是哪一家。认不出来回 undefined（内置价就没有，用户自己填）。
 *
 * **三轮，从严到宽**（WP88 改成分轮；在这之前是一次 `some(...)` 把三条规则并列）：
 *
 * 1. **主机名一模一样**；
 * 2. 用户填的是表里那家的**子域**（`x.api.example.com` 对 `api.example.com`）；
 * 3. 反过来——表里的地址是用户填的那个的子域（用户只填了个母域名）。
 *
 * 为什么非分轮不可：百炼的两套口是 `dashscope.aliyuncs.com`（按量）与
 * `coding.dashscope.aliyuncs.com`（Coding Plan 套餐），后者是前者的子域。三条规则
 * 并列时，两个地址会**互相**命中对方，谁排前面谁赢——于是"按量的调用被按套餐记成
 * 0 花费"或者"套餐的调用被按 token 记成花钱"，取决于 `catalog.json` 里的行序。
 * 先比完全相等，两边就各归各的，跟顺序无关了。
 */
export function vendorForBaseUrl(
  baseUrl: string,
  from: PriceCatalog = PRICE_CATALOG,
): CatalogVendor | undefined {
  const host = hostOf(baseUrl)
  if (host === '') return undefined
  return (
    from.vendors.find((v) => v.hosts.some((h) => host === h)) ??
    from.vendors.find((v) => v.hosts.some((h) => host.endsWith(`.${h}`))) ??
    from.vendors.find((v) => v.hosts.some((h) => h.endsWith(`.${host}`)))
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

/**
 * 这家在内置价目表里有哪几个模型名（WP88）。
 *
 * 用处只有一个：**`/models` 拉不到时的兜底清单**。百炼的 OpenAI 兼容口没有
 * `GET /models`（官方文档里从头到尾只有 `/chat/completions`），用户点「拉取模型列表」
 * 只会拿到一个 404——然后面对一个空的手填框，还得自己去官网翻模型名。
 *
 * 兜底清单只能来自这里：价目表里的名字是**核实过出处的**（`source_url` + `as_of`），
 * 而不是另写一份迟早和价对不上的硬编码清单。认不出这一家就回空数组——**不猜**。
 */
export function catalogModels(baseUrl: string, from: PriceCatalog = PRICE_CATALOG): string[] {
  return (vendorForBaseUrl(baseUrl, from)?.models ?? []).map((m) => m.model)
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
