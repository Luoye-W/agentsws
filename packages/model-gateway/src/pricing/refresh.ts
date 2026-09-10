/**
 * 去各家官网抓一次价（WP42 交付 2）。
 *
 * 边界，一条都不能少：
 *
 * - **普通 HTTP GET，不经模型**。抓回来的是一段网页文本，交给一个几十行的解析器，
 *   不是交给 Agent 去「读懂」——价目表是要拿来算钱的，不能是模型编出来的数字。
 * - **出站受急停管**（28 §1 的 `outbound` 档）。判定在宿主那边做，这里只负责抓。
 * - **UA 写明自己是谁**，超时 10 秒，**失败不抛**：抓不到就回一条 `ok: false` +
 *   原因，内置价原样留着。价目刷新是锦上添花，不该让任何东西挂掉。
 * - **key 不参与**。这些是公开页面，请求里没有任何凭据。
 *
 * 每家一个小解析器，因为每家的页面长得都不一样：
 * | 家 | 页面 | 抽法 |
 * |---|---|---|
 * | DeepSeek | Docusaurus 里一张带 rowspan 的 HTML 表 | 找 `PEAK` 那两行，按列对到表头的模型名 |
 * | OpenAI | Next.js 的 flight 数据，价在 `[[0,"gpt-5"],[0,1.25],…]` 里 | 正则捞行，头一个数是输入价、第二个是缓存命中、最后一个是输出 |
 * | Kimi | `.md` 里一段 `rows={[["kimi-k3","1M tokens","¥2.00",…]]}` | 正则捞行，按列取 |
 * | 智谱 | `.md` 里的 markdown 竖线表 | 按 `\|` 切列，认表头 |
 * | 通义 / SiliconFlow | 阶梯 × 地域 / 登录后才有 | 不抓（`parser: 'none'`），说明写在 catalog.json 里 |
 */
import type { CatalogPrice, CatalogVendor, PriceCatalog } from './catalog.js'
import { PRICE_CATALOG } from './catalog.js'

/** 抓页面用的 fetch。只要 text()——这些是网页，不是 JSON 接口。 */
export type PageFetch = (
  url: string,
  init: { method: 'GET'; headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

/** 让对面知道是谁在抓（并且怎么找我们）。 */
export const PRICING_USER_AGENT = 'agentsws-pricing/1.0 (+https://github.com/Luoye-W/agentsws)'

export const PRICING_TIMEOUT_MS = 10_000

/** 一家抓完的结果。 */
export interface VendorRefresh {
  vendor_id: string
  vendor_label: string
  ok: boolean
  /** 抓到几条价（`ok: false` 时是 0）。 */
  models: number
  /** 抓到的价本体（宿主拿它覆盖内置价）。 */
  prices: Record<string, CatalogPrice>
  currency: string
  source_url: string
  /** 抓不到的原因（人话）。 */
  reason?: string
}

export interface RefreshOptions {
  fetch?: PageFetch
  timeoutMs?: number
  catalog?: PriceCatalog
  /** 只抓这几家（不给就是全抓）。 */
  only?: string[]
}

/** 抓一轮。**永不抛**——每家自己的成败各自记在 `VendorRefresh` 里。 */
export async function refreshPriceCatalog(options: RefreshOptions = {}): Promise<VendorRefresh[]> {
  const catalog = options.catalog ?? PRICE_CATALOG
  const doFetch = options.fetch ?? (globalThis.fetch as unknown as PageFetch)
  const out: VendorRefresh[] = []
  for (const vendor of catalog.vendors) {
    if (options.only !== undefined && !options.only.includes(vendor.id)) continue
    out.push(await refreshVendor(vendor, doFetch, options.timeoutMs ?? PRICING_TIMEOUT_MS))
  }
  return out
}

async function refreshVendor(
  vendor: CatalogVendor,
  doFetch: PageFetch,
  timeoutMs: number,
): Promise<VendorRefresh> {
  const base = {
    vendor_id: vendor.id,
    vendor_label: vendor.label,
    currency: vendor.currency,
    source_url: vendor.source_url,
  }
  const parse = PARSERS[vendor.parser]
  if (parse === undefined) {
    return {
      ...base,
      ok: false,
      models: 0,
      prices: {},
      reason: vendor.parser_note ?? '这家的价目页抓不了，用的是内置价',
    }
  }
  const prices: Record<string, CatalogPrice> = {}
  const failures: string[] = []
  for (const url of [vendor.source_url, ...(vendor.extra_source_urls ?? [])]) {
    try {
      const text = await getText(doFetch, url, timeoutMs)
      Object.assign(prices, parse(text))
    } catch (e) {
      failures.push(`${url}：${e instanceof Error ? e.message : String(e)}`.slice(0, 160))
    }
  }
  const models = Object.keys(prices).length
  if (models === 0) {
    return {
      ...base,
      ok: false,
      models: 0,
      prices: {},
      reason:
        failures.length === 0
          ? '页面结构变了，一条价都没抽出来'
          : failures.join('；').slice(0, 300),
    }
  }
  return { ...base, ok: true, models, prices }
}

async function getText(doFetch: PageFetch, url: string, timeoutMs: number): Promise<string> {
  const res = await doFetch(url, {
    method: 'GET',
    headers: { 'user-agent': PRICING_USER_AGENT, accept: 'text/html,text/markdown,text/plain' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.text()
}

// ── 每家一个小解析器 ───────────────────────────────────────────────────

type Parser = (text: string) => Record<string, CatalogPrice>

const PARSERS: Partial<Record<string, Parser>> = {
  deepseek: parseDeepSeek,
  openai: parseOpenAi,
  kimi: parseKimi,
  zhipu: parseZhipu,
}

const num = (raw: string): number | undefined => {
  const cleaned = raw.replace(/[¥$￥元,\s]/g, '')
  const value = Number(cleaned)
  return Number.isFinite(value) && value >= 0 ? value : undefined
}

const stripTags = (html: string): string =>
  html
    .replace(/<sup>.*?<\/sup>/gis, '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .trim()

/**
 * DeepSeek：`https://api-docs.deepseek.com/quick_start/pricing/`。
 *
 * 一张 `text-align:center` 的 HTML 表，模型名在第一行，价在
 * `1M INPUT TOKENS (CACHE HIT|MISS)` 与 `1M OUTPUT TOKENS` 三段里，
 * 每段又分 `OFF-PEAK` / `PEAK` 两行（rowspan 撑着）。我们要 `PEAK` 那一行。
 */
export function parseDeepSeek(html: string): Record<string, CatalogPrice> {
  const table = /<table[\s\S]*?<\/table>/i.exec(html)?.[0]
  if (table === undefined) return {}
  const rows = [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) =>
    [...(m[1] ?? '').matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => stripTags(c[1] ?? '')),
  )
  const header = rows.find((cells) => cells[0]?.toUpperCase() === 'MODEL')
  const models = header?.slice(1).filter((c) => c !== '') ?? []
  if (models.length === 0) return {}

  const out: Record<string, CatalogPrice> = {}
  let section: keyof CatalogPrice | undefined
  for (const cells of rows) {
    const joined = cells.join(' ').toUpperCase()
    if (joined.includes('INPUT TOKENS') && joined.includes('CACHE HIT')) section = 'cached'
    else if (joined.includes('INPUT TOKENS') && joined.includes('CACHE MISS')) section = 'in'
    else if (joined.includes('OUTPUT TOKENS')) section = 'out'
    // rowspan 的缘故，PEAK 那一行只剩 ['PEAK', '$x', '$y']
    const at = cells.findIndex((c) => c.toUpperCase() === 'PEAK')
    if (at < 0 || section === undefined) continue
    const values = cells.slice(at + 1)
    for (const [i, model] of models.entries()) {
      const value = num(values[i] ?? '')
      if (value === undefined) continue
      out[model] ??= { in: 0, out: 0, cached: 0 }
      const entry = out[model]
      if (entry !== undefined) entry[section] = value
    }
  }
  return Object.fromEntries(Object.entries(out).filter(([, p]) => p.in > 0 || p.out > 0))
}

/**
 * OpenAI：`https://developers.openai.com/api/docs/pricing`。
 *
 * 页面是 Next.js 的 flight 数据，一行价长这样（HTML 转义过）：
 * `[[0,"gpt-5-mini"],[0,0.25],[0,0.025],[0,2]]`。列数不固定（有的模型多一列
 * Fast mode），但**第一个数是输入价、第二个是缓存命中价、最后一个是输出价**。
 */
export function parseOpenAi(html: string): Record<string, CatalogPrice> {
  const text = html.replace(/&quot;/g, '"').replace(/&#x27;|&apos;/g, "'")
  const out: Record<string, CatalogPrice> = {}
  const row = /\[\[0,"([a-z0-9][a-z0-9.-]{2,60})"\]((?:,\[0,(?:-?[\d.]+|"[^"]*"|null)\])+)\]/g
  for (const m of text.matchAll(row)) {
    const model = m[1]
    if (model === undefined || out[model] !== undefined) continue
    const cells = [...(m[2] ?? '').matchAll(/\[0,(-?[\d.]+|"[^"]*"|null)\]/g)].map((c) =>
      num((c[1] ?? '').replace(/"/g, '')),
    )
    const numbers = cells.filter((v): v is number => v !== undefined)
    if (cells.length < 3 || numbers.length < 2) continue
    const input = cells[0]
    const output = cells[cells.length - 1]
    if (input === undefined || output === undefined) continue
    out[model] = { in: input, out: output, cached: cells[1] ?? 0 }
  }
  return out
}

/**
 * Kimi：`https://platform.kimi.com/docs/pricing/chat-k3.md` 等。
 *
 * `.md` 里嵌了一段 JSX：
 * `rows={[["kimi-k3", "1M tokens", "¥2.00", "¥20.00", "¥100.00", "1,048,576 tokens"]]}`
 * ——列是 [模型, 计费单位, 缓存命中, 缓存未命中, 输出, 上下文窗口]。
 */
export function parseKimi(md: string): Record<string, CatalogPrice> {
  const out: Record<string, CatalogPrice> = {}
  const row = /\["([a-z0-9][a-z0-9.-]{2,60})",\s*"1M tokens",\s*([^\]]+)\]/gi
  for (const m of md.matchAll(row)) {
    const model = m[1]
    if (model === undefined) continue
    const cells = [...(m[2] ?? '').matchAll(/"([^"]*)"/g)].map((c) => c[1] ?? '')
    const cached = num(cells[0] ?? '')
    const input = num(cells[1] ?? '')
    const output = num(cells[2] ?? '')
    if (input === undefined || output === undefined) continue
    out[model] = { in: input, out: output, cached: cached ?? 0 }
  }
  return out
}

/**
 * 智谱：`https://docs.bigmodel.cn/cn/guide/start/pricing.md`。
 *
 * 普通的 markdown 竖线表，表头写着「输入单价（元/百万 Tokens）」等等。
 * 按表头认列号，再一行行取——列顺序换了也还认得出来。
 */
export function parseZhipu(md: string): Record<string, CatalogPrice> {
  const out: Record<string, CatalogPrice> = {}
  let cols: { name: number; in: number; out: number; cached: number } | undefined
  for (const raw of md.split('\n')) {
    const line = raw.trim()
    if (!line.startsWith('|')) {
      cols = undefined
      continue
    }
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim())
    if (cells.length < 4) continue
    const header = {
      name: cells.findIndex((c) => c.includes('模型名称')),
      in: cells.findIndex((c) => c.includes('输入单价')),
      out: cells.findIndex((c) => c.includes('输出单价')),
      cached: cells.findIndex((c) => c.includes('缓存命中')),
    }
    if (header.name >= 0 && header.in >= 0 && header.out >= 0) {
      cols = { ...header, cached: header.cached }
      continue
    }
    if (cols === undefined) continue
    const model = (cells[cols.name] ?? '').replace(/\\/g, '').trim()
    if (model === '' || /^-+$/.test(model)) continue
    const input = num(cells[cols.in] ?? '')
    const output = num(cells[cols.out] ?? '')
    if (input === undefined || output === undefined) continue
    const cached = cols.cached >= 0 ? num(cells[cols.cached] ?? '') : undefined
    out[model.toLowerCase()] = { in: input, out: output, cached: cached ?? 0 }
  }
  return out
}
