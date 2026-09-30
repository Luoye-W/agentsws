#!/usr/bin/env node
/**
 * 给连接目录与模型卡里的每一家，去**它自己的官网**取 favicon，提交进仓库（WP210；前身是 WP48 的
 * `fetch-brand-icons.mjs`，那个文件现在只是转到这里）。
 *
 * Luoye 09-30：「图标没按之前说的做——去对应网站取它们网站的 favicon 作为这里展示的图标」
 * （17TRACK、YouTube 那时还是字母占位）。规矩照 docs/36 §8：
 *
 * - **构建期抓一次入库，运行时绝不联网**：用户打开连接页时不该有请求发去 youtube.com。
 *   这个脚本**手动跑**（`pnpm icons:fetch`），不进 CI、不进 `pnpm build`。
 * - **只从各官方域名取**：每家写一张 `domains` 白名单（官网 + 官网自己在 `<link>` 里声明的
 *   静态资源域），候选 URL 的主机不在白名单里就不要。**不走任何第三方 favicon 服务**
 *   （不拼 google.com/s2/favicons、icon.horse 之类的地址），不登录、不带 cookie。
 * - **怎么挑**（Luoye 定的顺序）：`apple-touch-icon` / 高分辨率 `<link rel=icon>` / `favicon.svg`
 *   优先，都没有再退 `/favicon.ico`。候选全下下来量真实尺寸：矢量 > 大 PNG > ICO 里最大的那一张
 *   （转成 PNG 入库，`<img>` 里不放 ICO）。
 * - **留痕**：`assets/brand/MANIFEST.json` 记每一家的来源 URL、它属于哪个官网、抓取日期、
 *   格式、尺寸、sha256、字节数；同一个标志的几张卡（Meta 三张、TikTok 三张…）记在 `aliases`，
 *   不重复存图。
 * - **抓不到不毁图**：这一轮某家抓失败了，仓库里上一轮那张留着（MANIFEST 照抄上一轮那条，
 *   标 `kept: true`）；真一次都没抓到过的写进 `fallbacks`，界面退回矢量 / 字母徽标——而
 *   `test/brand-icons.test.tsx` 会因此变红，逼人来看。
 *
 * 用法：
 *   pnpm icons:fetch                     # 全部重抓
 *   pnpm icons:fetch --only youtube_data # 只抓这几家（逗号分隔）
 *   pnpm icons:fetch --dry-run           # 只打印挑中了什么，不落盘
 *
 * 抓完**人要自己看一眼**（是不是那家现在的标志、有没有抓成一张促销图），再 `git add` 提交。
 * 商标用错了是法律问题，这一步不自动化。
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'
import { SOURCES } from './provider-favicon-sources.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'apps/workstation/src/assets/brand')
const MANIFEST_PATH = join(OUT_DIR, 'MANIFEST.json')

/**
 * 装成一个普通浏览器：有些站点对无 UA 的请求直接 403。`accept` 里**故意不写 webp / avif**——
 * 有的 CDN 按 `accept` 协商格式，我们要的是任何浏览器都认的 PNG / SVG。
 */
const HEADERS = {
  'user-agent':
    // Safari 的 UA：Meta / WhatsApp 对 Chrome UA 的无 cookie 请求回 400 的「验证一下」页，对 Safari 不会
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  accept: 'text/html,application/xhtml+xml,image/png,image/svg+xml,image/x-icon,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
}

/** 位图最小边长：再小放到 20px 卡上就糊了（2× 屏要 40 个像素）。 */
const MIN_BITMAP = 32
/** 够清楚的边长：一个来源只给出比这小的位图，就接着试下一个来源，最后挑最好的。 */
const GOOD_BITMAP = 64

/** 带一次重试的 fetch：本机代理偶尔抽风，重试一次就够。`credentials` 永远不带。 */
async function get(url) {
  let last
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: HEADERS,
        redirect: 'follow',
        credentials: 'omit',
        signal: AbortSignal.timeout(20_000),
      })
      return { status: res.status, url: res.url, bytes: Buffer.from(await res.arrayBuffer()) }
    } catch (error) {
      last = error
    }
  }
  throw last
}

/** 这个 URL 在不在这一家的官方域名里（主机名等于或以 `.域名` 结尾）。 */
export function onOfficialDomain(url, domains) {
  let host
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return false
  }
  return domains.some((d) => host === d || host.endsWith(`.${d}`))
}

/**
 * 一页 HTML 里的图标候选：`<link rel="...icon...">`（含 `apple-touch-icon`，排掉 Safari 的
 * 单色 `mask-icon`），外加两条约定俗成的路径 `/apple-touch-icon.png`、`/favicon.svg`，
 * 最后是 `/favicon.ico`。返回绝对 URL，按出现顺序去重。
 */
export function iconCandidates(html, baseUrl) {
  const urls = []
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    const rel = /\brel=["']?([^"'>]+)["']?/i.exec(tag)?.[1] ?? ''
    if (!/icon/i.test(rel) || /mask-icon/i.test(rel)) continue
    const href = /\bhref=["']([^"']+)["']/i.exec(tag)?.[1]
    if (href === undefined || href.startsWith('data:')) continue
    try {
      urls.push(new URL(href.replace(/&amp;/g, '&'), baseUrl).toString())
    } catch {
      // 拼不出绝对 URL 就跳过
    }
  }
  const origin = new URL(baseUrl).origin
  urls.push(`${origin}/apple-touch-icon.png`, `${origin}/favicon.svg`, `${origin}/favicon.ico`)
  return [...new Set(urls)]
}

/** 认一张图：`png`（量边长）/ `svg` / `ico`（量最大的一张）/ `unknown`。 */
export function identify(bytes) {
  if (bytes.length > 24 && bytes.subarray(1, 4).toString('latin1') === 'PNG') {
    return { format: 'png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  }
  if (bytes.length > 6 && bytes.readUInt16LE(0) === 0 && bytes.readUInt16LE(2) === 1) {
    const count = bytes.readUInt16LE(4)
    let max = 0
    for (let i = 0; i < count; i++) max = Math.max(max, bytes[6 + i * 16] || 256)
    return { format: 'ico', width: max, height: max }
  }
  if (
    bytes.length > 16 &&
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return { format: 'webp', width: 0, height: 0 }
  const head = bytes.subarray(0, 1024).toString('utf8')
  if (/<svg[\s>]/i.test(head) || (/^\s*<\?xml/.test(head) && /<svg/i.test(bytes.toString('utf8'))))
    return { format: 'svg', width: 0, height: 0 }
  return { format: 'unknown', width: 0, height: 0 }
}

/* ── ICO → PNG（纯 Node，不引图像库）─────────────────────────────────────── */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** RGBA 像素 → 一张最朴素的 PNG（8 位 RGBA、不隔行、每行 filter 0）。 */
export function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** ICO 里的一张 BMP（DIB）→ RGBA。支持 32 / 24 / 8 / 4 / 1 位；不认的回 `undefined`。 */
function decodeDib(dib) {
  const headerSize = dib.readUInt32LE(0)
  const width = dib.readInt32LE(4)
  const height = Math.abs(dib.readInt32LE(8)) / 2 // ICO 里的高度含 AND 掩码，是两倍
  const bits = dib.readUInt16LE(14)
  const compression = dib.readUInt32LE(16)
  if (compression !== 0 || width <= 0 || height <= 0) return undefined
  const paletteSize = bits <= 8 ? dib.readUInt32LE(32) || 2 ** bits : 0
  const palette = dib.subarray(headerSize, headerSize + paletteSize * 4)
  const xorStart = headerSize + paletteSize * 4
  const xorStride = Math.ceil((width * bits) / 32) * 4
  const andStart = xorStart + xorStride * height
  const andStride = Math.ceil(width / 32) * 4
  const rgba = Buffer.alloc(width * height * 4)
  let anyAlpha = false
  for (let y = 0; y < height; y++) {
    const row = xorStart + (height - 1 - y) * xorStride // 自底向上
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      let b = 0
      let g = 0
      let r = 0
      let a = 255
      if (bits === 32) {
        ;[b, g, r, a] = [
          dib[row + x * 4],
          dib[row + x * 4 + 1],
          dib[row + x * 4 + 2],
          dib[row + x * 4 + 3],
        ]
        if (a !== 0) anyAlpha = true
      } else if (bits === 24) {
        ;[b, g, r] = [dib[row + x * 3], dib[row + x * 3 + 1], dib[row + x * 3 + 2]]
      } else if (bits === 8 || bits === 4 || bits === 1) {
        const bitPos = x * bits
        const byte = dib[row + (bitPos >> 3)]
        const idx = (byte >> (8 - bits - (bitPos & 7))) & ((1 << bits) - 1)
        ;[b, g, r] = [palette[idx * 4], palette[idx * 4 + 1], palette[idx * 4 + 2]]
      } else {
        return undefined
      }
      rgba[o] = r
      rgba[o + 1] = g
      rgba[o + 2] = b
      rgba[o + 3] = a
    }
  }
  // 没有 alpha 通道（或 32 位但 alpha 全 0）的，透明度看 AND 掩码
  if (bits !== 32 || !anyAlpha) {
    for (let y = 0; y < height; y++) {
      const row = andStart + (height - 1 - y) * andStride
      for (let x = 0; x < width; x++) {
        const masked = row < dib.length && (dib[row + (x >> 3)] >> (7 - (x & 7))) & 1
        rgba[(y * width + x) * 4 + 3] = masked ? 0 : 255
      }
    }
  }
  return { width, height, rgba }
}

/** ICO 里挑最大的一张，转成 PNG 字节（内嵌的就是 PNG 就原样拿出来）。 */
export function icoToPng(bytes) {
  const count = bytes.readUInt16LE(4)
  let best
  for (let i = 0; i < count; i++) {
    const e = 6 + i * 16
    const size = bytes[e] || 256
    const len = bytes.readUInt32LE(e + 8)
    const offset = bytes.readUInt32LE(e + 12)
    if (best === undefined || size > best.size) best = { size, len, offset }
  }
  if (best === undefined) return undefined
  const image = bytes.subarray(best.offset, best.offset + best.len)
  if (image.subarray(1, 4).toString('latin1') === 'PNG') return image
  const dib = decodeDib(image)
  return dib === undefined ? undefined : encodePng(dib.width, dib.height, dib.rgba)
}

/**
 * WEBP → PNG：借 macOS 自带的 `sips`（不为一两张图引图像库）。别的系统上回 `undefined`，
 * 那一家就退到下一个候选（通常是 ICO）。临时文件只有这两个，用完逐个删。
 */
export function webpToPng(bytes) {
  if (process.platform !== 'darwin') return undefined
  const dir = mkdtempSync(join(tmpdir(), 'favicon-'))
  const src = join(dir, 'in.webp')
  const out = join(dir, 'out.png')
  try {
    writeFileSync(src, bytes)
    execFileSync('sips', ['-s', 'format', 'png', src, '--out', out], { stdio: 'ignore' })
    return readFileSync(out)
  } catch {
    return undefined
  } finally {
    rmSync(src, { force: true })
    rmSync(out, { force: true })
    rmdirSync(dir)
  }
}

/* ── 挑图 ───────────────────────────────────────────────────────────────── */

/**
 * 候选的分数：矢量最高；位图按边长（ICO 同尺寸比 PNG 低一点，因为要转一道）。
 * 不合格（太小 / 不认识）回 `undefined` 与原因。
 */
function score(kind) {
  if (kind.format === 'svg') return { score: 100_000 }
  if (kind.format === 'png' || kind.format === 'ico') {
    if (kind.width < MIN_BITMAP)
      return { why: `${kind.format.toUpperCase()} 只有 ${kind.width}px，小于 ${MIN_BITMAP}px` }
    return { score: kind.width * 10 - (kind.format === 'ico' ? 1 : 0) }
  }
  return { why: '既不是 PNG / SVG 也不是 ICO' }
}

/** 下一张候选图，量一量、打分；ICO 当场转成 PNG。 */
async function candidate(url) {
  const res = await get(url)
  if (res.status !== 200) return { url, why: `HTTP ${res.status}` }
  let kind = identify(res.bytes)
  let bytes = res.bytes
  if (kind.format === 'webp') {
    // Instagram 只在 <link> 里给 WEBP：转成 PNG 再量（`<img>` 认 WEBP，但仓库里统一 PNG / SVG）
    const png = webpToPng(res.bytes)
    if (png === undefined) return { url, why: 'WEBP 转不了 PNG（这台机器上没有 sips）' }
    bytes = png
    kind = { ...identify(png), converted_from: 'webp' }
  }
  const verdict = score(kind)
  if (verdict.why !== undefined) return { url, why: verdict.why }
  if (kind.format === 'ico') {
    const png = icoToPng(res.bytes)
    if (png === undefined) return { url, why: 'ICO 里那张图解不开' }
    bytes = png
    kind = { ...identify(png), converted_from: 'ico' }
  }
  return { url, final_url: res.url, kind, bytes, score: verdict.score }
}

/** 走完一家的来源清单，返回分最高的那张（或者一串失败原因）。 */
async function resolveProvider(spec) {
  const tried = []
  /** 前面的来源只给出了小图：先记着，后面的来源有更好的就换。 */
  let backup
  for (const source of spec.sources) {
    const urls = []
    if (source.asset !== undefined) {
      urls.push(source.asset)
    } else {
      try {
        const page = await get(source.page)
        if (!onOfficialDomain(page.url, spec.domains)) {
          tried.push({ source: source.page, why: `跳到了官方域名以外：${page.url}` })
          continue
        }
        urls.push(...iconCandidates(page.bytes.toString('utf8'), page.url))
      } catch (error) {
        tried.push({ source: source.page, why: `打不开：${String(error?.message ?? error)}` })
        continue
      }
    }
    let best
    for (const url of urls) {
      if (!onOfficialDomain(url, spec.domains)) {
        tried.push({ source: url, why: '不在这家的官方域名清单里，不取' })
        continue
      }
      let got
      try {
        got = await candidate(url)
      } catch (error) {
        tried.push({ source: url, why: `下不下来：${String(error?.message ?? error)}` })
        continue
      }
      if (got.why !== undefined) {
        // 约定路径（/favicon.svg 之类）404 是常态，不记噪声
        if (!/^HTTP 404$/.test(got.why)) tried.push({ source: url, why: got.why })
        continue
      }
      if (!onOfficialDomain(got.final_url, spec.domains)) {
        tried.push({ source: url, why: `重定向到了官方域名以外：${got.final_url}` })
        continue
      }
      if (best === undefined || got.score > best.score) best = got
    }
    if (best === undefined) continue
    const found = { picked: best, page: source.page ?? source.asset, note: source.note, tried }
    if (best.kind.format === 'svg' || best.kind.width >= GOOD_BITMAP) return found
    if (backup === undefined || best.score > backup.picked.score) backup = found
  }
  return backup ?? { tried }
}

function readManifest() {
  if (!existsSync(MANIFEST_PATH)) return { icons: {}, fallbacks: {}, aliases: {} }
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
}

export async function main(argv = process.argv.slice(2)) {
  const dryRun = argv.includes('--dry-run')
  const onlyIdx = argv.indexOf('--only')
  const only = onlyIdx >= 0 ? new Set((argv[onlyIdx + 1] ?? '').split(',')) : undefined
  const previous = readManifest()
  const fetchedAt = new Date().toISOString().slice(0, 10)
  const icons = {}
  const fallbacks = {}
  const aliases = {}

  for (const [id, spec] of Object.entries(SOURCES)) {
    if (spec.same_as !== undefined) {
      aliases[id] = spec.same_as
      continue
    }
    if (only !== undefined && !only.has(id)) {
      // 这一轮不抓它：上一轮的原样留着
      if (previous.icons?.[id] !== undefined) icons[id] = previous.icons[id]
      if (previous.fallbacks?.[id] !== undefined) fallbacks[id] = previous.fallbacks[id]
      continue
    }
    const result = await resolveProvider(spec)
    if (result.picked === undefined) {
      const old = previous.icons?.[id]
      if (old !== undefined && existsSync(join(OUT_DIR, old.file))) {
        icons[id] = { ...old, kept: true }
        console.log(`… ${id.padEnd(18)} 这一轮没抓到，留着 ${old.fetched_at} 那张`)
      } else {
        fallbacks[id] = {
          brand: spec.brand,
          reason: '官方来源都没给出能用的图',
          tried: result.tried,
        }
        console.log(`✗ ${id.padEnd(18)} ${result.tried.map((t) => t.why).join('；')}`)
      }
      continue
    }
    const { kind, bytes, url } = result.picked
    const file = `${id}.${kind.format}`
    const old = previous.icons?.[id]
    if (!dryRun && old !== undefined && old.file !== file)
      rmSync(join(OUT_DIR, old.file), { force: true })
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
      ...(kind.converted_from === undefined ? {} : { converted_from: kind.converted_from }),
      ...(result.note === undefined ? {} : { note: result.note }),
      fetched_at: fetchedAt,
    }
    if (!dryRun) writeFileSync(join(OUT_DIR, file), bytes)
    const size = kind.format === 'png' ? `${kind.width}×${kind.height}` : '矢量'
    const via =
      kind.converted_from === undefined ? '' : `（${kind.converted_from.toUpperCase()} 转 PNG）`
    console.log(`✓ ${id.padEnd(18)} ${file.padEnd(24)} ${size.padEnd(9)} ${url}${via}`)
  }

  const manifest = {
    $comment:
      '各家官网的 favicon，构建期抓一次入库（WP48 起；WP210 改成连接目录每一家都取）。手动跑 `pnpm icons:fetch` 更新，跑完人自己看一眼再提交。运行时不联网。规矩见 docs/36 §8。',
    fetched_at: fetchedAt,
    min_bitmap: MIN_BITMAP,
    icons,
    aliases,
    fallbacks,
  }
  if (!dryRun) writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(
    `\n${Object.keys(icons).length} 家有官网图标、${Object.keys(aliases).length} 张卡借同一个标志、${Object.keys(fallbacks).length} 家没抓到${dryRun ? '（--dry-run，没落盘）' : `；写进 ${OUT_DIR}`}`,
  )
  return manifest
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main()
}
