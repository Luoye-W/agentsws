#!/usr/bin/env node
/**
 * 抓各平台官网**当前在用**的那个图标，下载进仓库（WP48）。
 *
 * 为什么是「构建期抓一次入库」而不是运行时去抓：工作台是本地优先的，
 * 用户开着界面的时候不该有一条请求偷偷发去 shopify.com / gstatic.com——那既是
 * 一次隐私泄漏（谁在什么时候打开了连接页），也让离线时界面缺图。这种图标好几年
 * 不变，抓一次提进仓库最合适。**所以这个脚本是手动跑的**（`pnpm icons:fetch`），
 * 不在 CI 里、不在 `pnpm build` 里，仓库里那几个文件就是唯一的真源。
 *
 * 怎么挑：每个 provider 给一串**官方来源**，按顺序试，第一个合格的就用：
 *
 *   - `page`：官网页面，解析 `<link rel="...icon...">`（含 `apple-touch-icon`），
 *     把候选全下下来量真实尺寸，挑最好的那个（矢量优先，其次最大的 PNG）。
 *   - `asset`：直接给一个官方资源 URL（页面是登录墙、抓不到 `<link>` 的情况），
 *     `page` 字段记下它属于哪个官网，MANIFEST 里照实写。
 *
 * 合格线：SVG 一律收；PNG 要 ≥ 64px；**ICO 不收**（我们要在 `<img>` 里用，而且
 * 官网给的 ICO 基本都是 32px 的浏览器页签图标，放到 20px 卡片上也糊）。一个 provider
 * 全部来源都不合格就**不写文件**，`MANIFEST.json` 的 `fallbacks` 里写清楚为什么——
 * 界面会自动退回 WP45 那条 Simple Icons 的 SVG（`brand-icons.tsx`）。
 *
 * 用法：
 *   pnpm icons:fetch            # 抓，写 apps/workstation/src/assets/brand/
 *   pnpm icons:fetch --dry-run  # 只打印挑中了什么，不落盘
 *
 * 抓完**人要自己看一眼**（图对不对、是不是那家现在的标志），再 `git add` 提交。
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'apps/workstation/src/assets/brand')

/**
 * 装成一个普通浏览器：有些站点对无 UA 的请求直接 403。
 *
 * `accept` 里**故意不写 webp / avif**——Shopify 的 CDN 会按 `accept` 协商格式，
 * 说自己能吃 webp 就给 webp，而我们要的是能直接进仓库、任何浏览器都认的 PNG / SVG。
 */
const HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,image/png,image/svg+xml,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
}

/** PNG 最小可接受边长：再小的图放到 20px 卡片上还得糊，不如用矢量兜底。 */
const MIN_PNG = 64

/**
 * provider id → 官方来源（按优先级）。
 *
 * id 跟 `apps/server/src/catalog.ts` 的 `service` 与
 * `packages/api/src/routes/models.ts` 的 `KIND` 对齐——文件名就是 id，
 * `brand-icons.tsx` 按文件名认。
 *
 * 这里**没有** `imap_smtp`（「任意邮箱」是协议不是品牌，用 lucide 的 `Mail`）
 * 和 `openai_compatible`（说的是"任何 OpenAI 兼容网关"，不是 OpenAI 这家公司，
 * 用中性的 `O` 徽标）——见 `docs/36` §8。
 */
const SOURCES = {
  shopify_admin: {
    brand: 'Shopify',
    sources: [{ page: 'https://www.shopify.com', note: '官网首页的 apple-touch-icon' }],
  },
  gmail: {
    brand: 'Gmail',
    sources: [
      // mail.google.com 会 302 到登录页，`<link rel=icon>` 是 Google 账号的，不是 Gmail 的；
      // 下面这个是 Google 自己的品牌资源目录（app 切换器、登录页产品图都从这里取）。
      {
        asset: 'https://www.gstatic.com/images/branding/product/2x/gmail_2020q4_64dp.png',
        page: 'https://mail.google.com',
        note: 'Google 品牌资源目录 gstatic branding/product（2020 版多色 M）；mail.google.com 本身是登录墙',
      },
      { page: 'https://mail.google.com', note: '兜底：直接读 mail.google.com 的 <link>' },
    ],
  },
  ga4: {
    brand: 'Google Analytics',
    sources: [
      {
        asset: 'https://www.gstatic.com/images/branding/product/2x/google_analytics_64dp.png',
        page: 'https://analytics.google.com',
        note: 'Google 品牌资源目录 gstatic branding/product（GA4 的黄橙柱状图标）；analytics.google.com 是登录墙',
      },
      { page: 'https://analytics.google.com/analytics/web/', note: '兜底：读 GA 应用壳的 <link>' },
    ],
  },
  gsc: {
    brand: 'Google Search Console',
    sources: [
      {
        asset: 'https://www.gstatic.com/images/branding/product/2x/search_console_64dp.png',
        page: 'https://search.google.com/search-console',
        note: 'Google 品牌资源目录 gstatic branding/product；与 search-console/about 页上那张 logo_search_console.svg 是同一个标志的方形版',
      },
      {
        page: 'https://search.google.com/search-console',
        note: '兜底：读 about 页的 <link>（32px favicon）',
      },
    ],
  },
  meta_ads: {
    brand: 'Meta 广告',
    sources: [
      { page: 'https://www.meta.com', note: '官网首页 <link rel=icon>' },
      {
        asset: 'https://business.facebook.com/favicon.ico',
        page: 'https://business.facebook.com',
        note: 'Meta 商务后台（广告管理工具的入口）的 favicon',
      },
    ],
  },
  deepseek: {
    brand: 'DeepSeek',
    sources: [
      // www.deepseek.com 的 `<link rel=icon>` 是 ICO（单张 225px，BMP 编码），我们不收 ICO；
      // DeepSeek 官方文档站给的是同一只蓝鲸的 SVG。
      {
        page: 'https://api-docs.deepseek.com/',
        note: 'DeepSeek 官方 API 文档站的 <link rel=icon>（矢量）',
      },
      { page: 'https://platform.deepseek.com/', note: 'DeepSeek 开放平台' },
      { page: 'https://www.deepseek.com', note: '官网首页（ICO，收不了）' },
    ],
  },
}

/** 带一次重试的 fetch：本机代理偶尔抽风，重试一次就够，别卡住。 */
async function get(url) {
  let last
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: HEADERS,
        redirect: 'follow',
        signal: AbortSignal.timeout(20_000),
      })
      return { status: res.status, url: res.url, bytes: Buffer.from(await res.arrayBuffer()) }
    } catch (error) {
      last = error
    }
  }
  throw last
}

/** 从一页 HTML 里掏出所有 `<link rel="...icon...">` 的绝对 URL（排掉 Safari 的单色 mask-icon）。 */
function iconLinks(html, baseUrl) {
  const urls = []
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    const rel = /\brel=["']([^"']+)["']/i.exec(tag)?.[1] ?? ''
    if (!/icon/i.test(rel) || /mask-icon/i.test(rel)) continue
    const href = /\bhref=["']([^"']+)["']/i.exec(tag)?.[1]
    if (href === undefined) continue
    try {
      urls.push(new URL(href, baseUrl).toString())
    } catch {
      // href 拼不出绝对 URL 就跳过
    }
  }
  return [...new Set(urls)]
}

/** 认一张图：`png`（量出真实边长）/ `svg` / `ico` / `unknown`。 */
function identify(bytes) {
  if (bytes.length > 24 && bytes.subarray(1, 4).toString('latin1') === 'PNG') {
    return { format: 'png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  }
  if (bytes.length > 6 && bytes.readUInt16LE(0) === 0 && bytes.readUInt16LE(2) === 1) {
    const count = bytes.readUInt16LE(4)
    let max = 0
    for (let i = 0; i < count; i++) max = Math.max(max, bytes[6 + i * 16] || 256)
    return { format: 'ico', width: max, height: max }
  }
  const head = bytes.subarray(0, 512).toString('utf8')
  if (/<svg[\s>]/i.test(head) || /^\s*<\?xml/.test(head))
    return { format: 'svg', width: 0, height: 0 }
  return { format: 'unknown', width: 0, height: 0 }
}

/** 合格吗？不合格连原因一起说。 */
function verdict(kind) {
  if (kind.format === 'svg') return { ok: true }
  if (kind.format === 'png') {
    return kind.width >= MIN_PNG
      ? { ok: true }
      : { ok: false, why: `PNG 只有 ${kind.width}×${kind.height}，小于 ${MIN_PNG}px` }
  }
  if (kind.format === 'ico') return { ok: false, why: `返回的是 ICO（最大 ${kind.width}px），不收` }
  return { ok: false, why: '既不是 PNG 也不是 SVG' }
}

/** 矢量 > 大 PNG > 小 PNG。 */
function better(a, b) {
  if (a === undefined) return b
  if (a.kind.format === 'svg') return a
  if (b.kind.format === 'svg') return b
  return b.kind.width > a.kind.width ? b : a
}

/** 下一张候选图回来，量一量。 */
async function candidate(url) {
  const res = await get(url)
  if (res.status !== 200) return { url, error: `HTTP ${res.status}` }
  const kind = identify(res.bytes)
  return { url, kind, bytes: res.bytes, check: verdict(kind) }
}

/** 走完一个 provider 的来源清单，返回选中的那张（或者一串失败原因）。 */
async function resolveProvider(id, spec) {
  const tried = []
  for (const source of spec.sources) {
    const urls = []
    if (source.asset !== undefined) {
      urls.push(source.asset)
    } else {
      try {
        const page = await get(source.page)
        urls.push(...iconLinks(page.bytes.toString('utf8'), page.url))
        if (urls.length === 0)
          tried.push({ source: source.page, why: '页面里没有 <link rel=icon>' })
      } catch (error) {
        tried.push({ source: source.page, why: `打不开：${String(error?.message ?? error)}` })
      }
    }

    let best
    for (const url of urls) {
      let got
      try {
        got = await candidate(url)
      } catch (error) {
        tried.push({ source: url, why: `下不下来：${String(error?.message ?? error)}` })
        continue
      }
      if (got.error !== undefined) {
        tried.push({ source: url, why: got.error })
        continue
      }
      if (!got.check.ok) {
        tried.push({ source: url, why: got.check.why })
        continue
      }
      best = better(best, got)
    }
    if (best !== undefined) {
      return {
        id,
        brand: spec.brand,
        picked: best,
        page: source.page ?? source.asset,
        note: source.note,
        tried,
      }
    }
  }
  return { id, brand: spec.brand, tried }
}

const dryRun = process.argv.includes('--dry-run')

mkdirSync(OUT_DIR, { recursive: true })
if (!dryRun) {
  // 每次重抓都从干净的目录开始：上一轮抓到、这一轮退回兜底的，文件不能留在仓库里
  for (const name of readdirSync(OUT_DIR)) {
    if (name === 'MANIFEST.json' || /\.(png|svg)$/.test(name)) rmSync(join(OUT_DIR, name))
  }
}

const fetchedAt = new Date().toISOString().slice(0, 10)
const icons = {}
const fallbacks = {}

for (const [id, spec] of Object.entries(SOURCES)) {
  const result = await resolveProvider(id, spec)
  if (result.picked === undefined) {
    fallbacks[id] = {
      brand: spec.brand,
      reason:
        '官方来源都没给出能用的 PNG / SVG，界面退回 Simple Icons 的矢量图（见 brand-icons.tsx）',
      tried: result.tried,
    }
    console.log(`✗ ${id.padEnd(14)} 兜底 —— ${result.tried.map((t) => t.why).join('；')}`)
    continue
  }
  const { kind, bytes, url } = result.picked
  const file = `${id}.${kind.format}`
  icons[id] = {
    brand: spec.brand,
    file,
    format: kind.format,
    width: kind.format === 'png' ? kind.width : null,
    height: kind.format === 'png' ? kind.height : null,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    source_url: url,
    source_page: result.page,
    note: result.note,
    fetched_at: fetchedAt,
  }
  if (!dryRun) writeFileSync(join(OUT_DIR, file), bytes)
  const size = kind.format === 'png' ? `${kind.width}×${kind.height}` : '矢量'
  console.log(`✓ ${id.padEnd(14)} ${file.padEnd(22)} ${size.padEnd(9)} ${url}`)
}

const manifest = {
  $comment:
    '构建期抓一次入库的第三方品牌图标（WP48）。手动跑 `pnpm icons:fetch` 更新，跑完人自己看一眼再提交。运行时不联网。规矩见 docs/36 §8。',
  fetched_at: fetchedAt,
  min_png: MIN_PNG,
  icons,
  fallbacks,
}
if (!dryRun) writeFileSync(join(OUT_DIR, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`)

console.log(
  `\n${Object.keys(icons).length} 个抓到官方图，${Object.keys(fallbacks).length} 个走 Simple Icons 兜底${dryRun ? '（--dry-run，没落盘）' : `；写进 ${OUT_DIR}`}`,
)
