#!/usr/bin/env node
/**
 * WP461（WP456 §2，决策 1446）：**视觉档位守卫**——工作台里新写的字号、圆角、颜色必须落在规范的档位上。
 *
 * 查 `apps/workstation/src/**\/*.{ts,tsx}`（测试不查、注释不查）里这三类写法：
 *
 * - **字号**：七档 = 22 / 16 / 14 / 13 / 12 / 11（只给数字和英文）/ 28（Outfit 大数）。
 *   认 `text-xs`（12）、`text-sm`（14）、`text-base`（16）、`text-ws-page/title/read/ui/note/tiny/big`，
 *   以及落在档位上的任意值 `text-[12px]` / `[13px]` / `[14px]` / `[16px]` / `[22px]` / `[28px]`。
 *   其余（`text-[11px]`、`text-[12.5px]`、`text-lg`、`text-2xl`……）算不在档位里——11 那一档请写 `text-ws-tiny`，
 *   写的时候自己确认里面只有数字和英文（中文最小 12px）。
 * - **圆角**：五档 6 / 8 / 12 / 16 / 20 + 全圆。认 `rounded-none/sm/md/lg/xl/2xl/full`（index.css 已把 sm/md/lg/xl
 *   落到 6/8/12/16）、`rounded-ws-tag/ctl/block/card/dialog`、任意值 `[6px]/[8px]/[12px]/[16px]/[20px]`；
 *   光写 `rounded`（4px）、`rounded-xs`、`rounded-3xl`、`rounded-[10px]` 这类算不在档位里。
 * - **原色**：Tailwind 自带色板（`bg-amber-500`、`text-emerald-600`……）和写死的 `bg-[#xxxxxx]` 一律不行，
 *   走 token（`text-ws-warn`、`bg-ws-good-bg`……），深浅色才跟着切。
 *
 * **只挡新出现的**：现有的不在档位里的写法记在豁免清单 `scripts/ui-tokens-baseline.json`（按文件、按类计数），
 * 一个文件某一类的个数**超过**清单上的数才报错；没改过的文件永远不会红。T2–T8 逐步清，清完一处跑一次
 * `--update` 把清单收紧（`--update` 只会往小里改、不会加新文件——清单只减不增）。
 *
 * **插件（WP456-T7）**：另外两道，都不走豁免清单（插件的 CSS 一次清干净了，新写的直接按档位来）：
 * - `apps/extension/src/ui/tokens.css` 必须和工作台 `index.css` 生成出来的一字不差（`gen-extension-tokens.mjs`）——
 *   工作台 token 改了、插件没重出就红；
 * - `apps/extension/src/**\/*.css`（生成的 tokens.css 除外）里的 `font-size` / `border-radius` 只用档位上的数或
 *   `var(--ws-*)`，不写死 `#xxxxxx` 颜色（颜色走 token，深浅色才跟着切）。
 *
 * 用法：node scripts/check-ui-tokens.mjs [--update] [--strict] [--summary]
 *   --update   把豁免清单收紧到现在的数（只减不增）
 *   --strict   清单比现在松（有文件清掉了却没收紧）也算失败
 *   --summary  打印各类总数和豁免最多的文件
 *   --init     （只给定规范的人用）按现在的状态重写整份清单
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkExtensionTokens, DRIFT_MESSAGE, TARGET } from './gen-extension-tokens.mjs'

export const CATEGORIES = ['font-size', 'radius', 'color']
export const CATEGORY_LABEL = { 'font-size': '字号', radius: '圆角', color: '原色' }

/** 字号：允许的 Tailwind 名字与语义档位。 */
const TEXT_NAMED_OK = new Set(['xs', 'sm', 'base'])
const TEXT_NAMED_ALL = /^(xs|sm|base|lg|xl|[2-9]xl)$/u
export const TEXT_TIERS = [
  'ws-page',
  'ws-title',
  'ws-read',
  'ws-ui',
  'ws-note',
  'ws-tiny',
  'ws-big',
]
const TEXT_PX_OK = new Set([12, 13, 14, 16, 22, 28])

/** 圆角：允许的名字、语义档位与任意值。 */
const RADIUS_SIDES = new Set([
  't',
  'r',
  'b',
  'l',
  's',
  'e',
  'tl',
  'tr',
  'br',
  'bl',
  'ss',
  'se',
  'es',
  'ee',
])
const RADIUS_NAMED_OK = new Set(['none', 'sm', 'md', 'lg', 'xl', '2xl', 'full'])
export const RADIUS_TIERS = ['ws-tag', 'ws-ctl', 'ws-block', 'ws-card', 'ws-dialog']
const RADIUS_ARBITRARY_OK = new Set([
  '6px',
  '8px',
  '12px',
  '16px',
  '20px',
  '9999px',
  'inherit',
  'var(--ws-radius-card)',
])

const PALETTE =
  'red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone'
const COLOR_UTIL =
  'bg|text|border(?:-[xytrblse])?|ring|ring-offset|inset-ring|outline|fill|stroke|from|via|to|decoration|divide|shadow|inset-shadow|accent|caret|placeholder'
const RAW_PALETTE = new RegExp(
  `(?<![\\w-])(?:${COLOR_UTIL})-(?:${PALETTE})-(?:50|[1-9]00|950)(?:/\\d+)?(?![\\w-])`,
  'gu',
)
const RAW_HEX = new RegExp(`(?<![\\w-])(?:${COLOR_UTIL})-\\[#[0-9a-fA-F]{3,8}\\]`, 'gu')
const TEXT_TOKEN = /(?<![\w/.-])text-(\[[^\]\s]+\]|[a-z0-9-]+)(?![\w[-])/gu
const RADIUS_TOKEN = /(?<![\w/.-])rounded((?:-[a-z0-9]+)*)(?:-(\[[^\]\s]+\]))?(?![\w[-])/gu

/** 去掉注释（块注释、JSX 注释、行注释；行注释只认前面不是 `:` 的 `//`，免得把网址当注释），保留换行好算行号。 */
export function stripComments(text) {
  const blanked = text.replace(/\/\*[\s\S]*?\*\//gu, (m) => m.replace(/[^\n]/gu, ' '))
  return blanked
    .split('\n')
    .map((line) => line.replace(/(^|[^:'"`\\])\/\/.*$/u, '$1'))
    .join('\n')
}

/** 一个 `text-…` 是不是字号、在不在档位里：返回 `undefined`（不是字号）/ `true` / `false`。 */
export function textSizeOk(value) {
  if (value.startsWith('[')) {
    const inner = value.slice(1, -1)
    const len = /^(?:length:)?(\d+(?:\.\d+)?)(px|rem)$/u.exec(inner)
    if (len === null) return /^(?:length:)?[\d.]+(em|%|vw|vh)$/u.test(inner) ? false : undefined
    const px = len[2] === 'rem' ? Number(len[1]) * 16 : Number(len[1])
    return TEXT_PX_OK.has(px)
  }
  if (TEXT_TIERS.includes(value)) return true
  if (TEXT_NAMED_ALL.test(value)) return TEXT_NAMED_OK.has(value)
  return undefined
}

/** `rounded…` 的后半截在不在档位里。`parts` 是 `-a-b` 那一串，`arbitrary` 是 `[…]` 里面的值。 */
export function radiusOk(parts, arbitrary) {
  const segs = parts === '' ? [] : parts.slice(1).split('-')
  if (segs.length > 0 && RADIUS_SIDES.has(segs[0])) segs.shift()
  if (arbitrary !== undefined)
    return segs.length === 0 && RADIUS_ARBITRARY_OK.has(arbitrary.replace(/^\[|\]$/gu, ''))
  if (segs.length === 0) return false // 光写 `rounded` = 4px
  const value = segs.join('-')
  return RADIUS_NAMED_OK.has(value) || RADIUS_TIERS.includes(value)
}

/** 一段源码里不在档位里的写法：`{ 'font-size': [{ line, token }], radius: [...], color: [...] }`。 */
export function scanSource(text) {
  const out = { 'font-size': [], radius: [], color: [] }
  const lines = stripComments(text).split('\n')
  lines.forEach((line, i) => {
    const at = i + 1
    for (const m of line.matchAll(TEXT_TOKEN)) {
      if (textSizeOk(m[1]) === false) out['font-size'].push({ line: at, token: m[0] })
    }
    for (const m of line.matchAll(RADIUS_TOKEN)) {
      if (!radiusOk(m[1], m[2])) out.radius.push({ line: at, token: m[0] })
    }
    for (const m of line.matchAll(RAW_PALETTE)) out.color.push({ line: at, token: m[0] })
    for (const m of line.matchAll(RAW_HEX)) out.color.push({ line: at, token: m[0] })
  })
  return out
}

/** 要查的文件（仓库相对路径，排好序）。 */
export function listFiles(root, dir = 'apps/workstation/src') {
  const abs = join(root, dir)
  const out = []
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (
        /\.tsx?$/u.test(name) &&
        !/\.(test|spec)\.tsx?$/u.test(name) &&
        !name.endsWith('.d.ts')
      )
        out.push(relative(root, p).split('\\').join('/'))
    }
  }
  walk(abs)
  return out.sort()
}

/** 每个文件每类的个数（只留非零的）。 */
export function countAll(root, files = listFiles(root)) {
  const counts = {}
  const hits = {}
  for (const file of files) {
    const found = scanSource(readFileSync(join(root, file), 'utf8'))
    const row = {}
    for (const c of CATEGORIES) if (found[c].length > 0) row[c] = found[c].length
    if (Object.keys(row).length > 0) {
      counts[file] = row
      hits[file] = found
    }
  }
  return { counts, hits }
}

/**
 * 拿现在的数和豁免清单比：`over` 是超出清单的（要报错），`under` 是清单还能收紧的。
 */
export function compare(baseline, counts) {
  const over = []
  const under = []
  const files = new Set([...Object.keys(baseline), ...Object.keys(counts)])
  for (const file of [...files].sort()) {
    for (const c of CATEGORIES) {
      const allowed = baseline[file]?.[c] ?? 0
      const now = counts[file]?.[c] ?? 0
      if (now > allowed) over.push({ file, category: c, allowed, now })
      else if (now < allowed) under.push({ file, category: c, allowed, now })
    }
  }
  return { over, under }
}

/** `--update`：只往小里收，不加新文件、不放宽。 */
export function tighten(baseline, counts) {
  const next = {}
  for (const file of Object.keys(baseline).sort()) {
    const row = {}
    for (const c of CATEGORIES) {
      const v = Math.min(baseline[file]?.[c] ?? 0, counts[file]?.[c] ?? 0)
      if (v > 0) row[c] = v
    }
    if (Object.keys(row).length > 0) next[file] = row
  }
  return next
}

const HEADER =
  'WP461（决策 1446）：视觉规范落地前就有的、不在档位里的写法——按文件、按类计数。只减不增：' +
  'T2–T8 清掉一处就跑 `node scripts/check-ui-tokens.mjs --update` 收紧；新写的地方一律按档位来。'

export function readBaseline(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8')).files ?? {}
  } catch {
    return {}
  }
}

export function writeBaseline(path, files) {
  writeFileSync(path, `${JSON.stringify({ $comment: HEADER, files }, null, 2)}\n`)
}

/** 插件 CSS 里字号能写的数（px）：七档。11 那一档只给数字和英文，写的时候自己确认。 */
const CSS_FONT_PX_OK = new Set([11, 12, 13, 14, 16, 22, 28])
/** 插件 CSS 里圆角能写的数（px）：五档 + 0 + 全圆。 */
const CSS_RADIUS_PX_OK = new Set([0, 6, 8, 12, 16, 20, 999, 9999])

/**
 * 一段插件 CSS 里不在档位里的写法：`[{ line, kind, token }]`（kind = font-size / radius / color）。
 * 只看 `font-size`、`border-radius`（含四个角）和写死的 `#xxxxxx`；`var(…)`、`inherit`、百分比全圆照认。
 */
export function scanCss(text) {
  const out = []
  const lines = text.replace(/\/\*[\s\S]*?\*\//gu, (m) => m.replace(/[^\n]/gu, ' ')).split('\n')
  lines.forEach((line, i) => {
    const at = i + 1
    const font = /(?<![\w-])font-size\s*:\s*([^;]+)/u.exec(line)
    if (font !== null) {
      const v = font[1].trim()
      const px = /^(\d+(?:\.\d+)?)px$/u.exec(v)
      const ok =
        v.startsWith('var(') ||
        v === 'inherit' ||
        (px !== null && CSS_FONT_PX_OK.has(Number(px[1])))
      if (!ok) out.push({ line: at, kind: 'font-size', token: `font-size: ${v}` })
    }
    const radius = /(?<![\w-])border(?:-(?:top|bottom)-(?:left|right))?-radius\s*:\s*([^;]+)/u.exec(
      line,
    )
    if (radius !== null) {
      const v = radius[1].trim()
      const ok =
        v.startsWith('var(') ||
        v === 'inherit' ||
        v === '50%' ||
        v.split(/\s+/u).every((part) => {
          const px = /^(\d+)(?:px)?$/u.exec(part)
          return px !== null && CSS_RADIUS_PX_OK.has(Number(px[1]))
        })
      if (!ok) out.push({ line: at, kind: 'radius', token: `border-radius: ${v}` })
    }
    for (const m of line.matchAll(/#[0-9a-fA-F]{3,8}(?![\w-])/gu))
      out.push({ line: at, kind: 'color', token: m[0] })
  })
  return out
}

/** 插件里要查的 CSS（仓库相对路径；生成的 tokens.css 不查）。 */
export function listExtensionCss(root) {
  const out = []
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (name.endsWith('.css')) out.push(relative(root, p).split('\\').join('/'))
    }
  }
  walk(join(root, 'apps/extension/src'))
  return out.filter((f) => f !== TARGET).sort()
}

/** 插件那两道：令牌没重出、CSS 不在档位里。返回要报的错（空 = 过）。 */
export function checkExtension(root) {
  const errors = []
  if (!checkExtensionTokens(root).ok) errors.push(DRIFT_MESSAGE)
  for (const file of listExtensionCss(root)) {
    for (const h of scanCss(readFileSync(join(root, file), 'utf8')))
      errors.push(`${file} 第 ${h.line} 行：${CATEGORY_LABEL[h.kind]}不在档位里  ${h.token}`)
  }
  return errors
}

function main() {
  const args = process.argv.slice(2)
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
  const baselinePath = join(root, 'scripts/ui-tokens-baseline.json')
  const { counts, hits } = countAll(root)

  if (args.includes('--init')) {
    writeBaseline(baselinePath, counts)
    console.log(`豁免清单已按现状重写：${Object.keys(counts).length} 个文件`)
    return 0
  }
  const baseline = readBaseline(baselinePath)
  if (args.includes('--update')) {
    const next = tighten(baseline, counts)
    writeBaseline(baselinePath, next)
    console.log(
      `豁免清单已收紧：${Object.keys(baseline).length} → ${Object.keys(next).length} 个文件`,
    )
  }

  if (args.includes('--summary')) {
    for (const c of CATEGORIES) {
      const total = Object.values(counts).reduce((n, row) => n + (row[c] ?? 0), 0)
      console.log(`${CATEGORY_LABEL[c]}：${total} 处不在档位里（豁免）`)
    }
  }

  const { over, under } = compare(
    args.includes('--update') ? tighten(baseline, counts) : baseline,
    counts,
  )
  for (const o of over) {
    console.error(
      `✗ ${o.file}：${CATEGORY_LABEL[o.category]}不在档位里的写法 ${o.allowed} → ${o.now}（新加了 ${o.now - o.allowed} 处）`,
    )
    for (const h of hits[o.file]?.[o.category] ?? [])
      console.error(`    第 ${h.line} 行  ${h.token}`)
  }
  if (over.length > 0) {
    console.error(
      '\n规范见 WP456 §2：字号 text-xs / text-sm / text-base / text-ws-*，圆角 rounded-sm/md/lg/xl/2xl/full / rounded-ws-*，颜色走 ws token。',
    )
  }
  if (under.length > 0 && !args.includes('--update')) {
    console.log(
      `ℹ ${under.length} 处豁免可以收紧（有文件清掉了旧写法）：跑 node scripts/check-ui-tokens.mjs --update`,
    )
  }
  const strictFail = args.includes('--strict') && under.length > 0 && !args.includes('--update')
  if (over.length === 0 && !strictFail)
    console.log('✓ 视觉档位守卫：没有新出现的不在档位里的字号 / 圆角 / 原色')
  const ext = checkExtension(root)
  for (const e of ext) console.error(`✗ 插件：${e}`)
  if (ext.length === 0) console.log('✓ 插件：令牌与工作台一致，CSS 的字号 / 圆角 / 颜色都在档位上')
  return over.length > 0 || strictFail || ext.length > 0 ? 1 : 0
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main())
}
