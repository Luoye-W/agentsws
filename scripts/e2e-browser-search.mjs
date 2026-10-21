#!/usr/bin/env node
/**
 * WP353：**真机端到端**——在工坊桌面壳那一份「应用内搜索浏览器」里真搜几条（本机、真 Google）。
 *
 * - 临时用户数据目录（跑完只删它自己）；不碰 4317、不碰你自己的 Chrome、不开调试口；
 * - 只搜几条，**默认不进 CI**；被人机验证拦下就照实记下，不点、不绕；
 * - 先 `npx tsc -b`（用 `apps/desktop/dist` 与 `apps/server/dist`）。
 *
 * 用法：node scripts/e2e-browser-search.mjs [--out <json>] [--preset wp454]
 *
 * WP454：`--preset wp454` = 一个**全新品牌**（全新 partition）连搜 5 条通用商品词，间隔照产品节流；
 * 留痕（`web-search.json`）原样带进结果；不读正文；Google 一出人机验证就记下、停（不点、不绕）。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(ROOT, 'apps/desktop/package.json'))
const electron = require('electron')
const args = process.argv.slice(2)
const outIdx = args.indexOf('--out')
const userData = mkdtempSync(join(tmpdir(), 'wp353-e2e-'))
const out = outIdx >= 0 ? resolve(args[outIdx + 1]) : join(userData, 'result.json')

const preset = args.includes('--preset') ? args[args.indexOf('--preset') + 1] : undefined

const WP454_QUERIES = [
  'best standing desk 2026',
  'wireless earbuds battery life comparison',
  'usb c hub for laptop',
  'ergonomic office chair review',
  'portable monitor 15.6 inch',
].map((query) => ({ brand: 'brand_new_wp454', markets: ['US'], query }))

const WP353_QUERIES = [
  { brand: 'brand_us', markets: ['US'], query: 'site:reddit.com smart glasses' },
  { brand: 'brand_us', markets: ['US'], query: 'XREAL One review reddit' },
  { brand: 'brand_us', markets: ['US'], query: 'site:linkedin.com XREAL' },
  { brand: 'brand_de', markets: ['DE'], query: 'smarte Brille Test' },
  { brand: 'brand_us', markets: ['US'], query: 'XREAL 智能眼镜 国内 竞品' },
]

const child = spawn(electron, [join(ROOT, 'scripts/e2e-browser-search/main.mjs')], {
  env: {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    TMPDIR: process.env.TMPDIR ?? '',
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    WP353_USER_DATA: userData,
    WP353_OUT: out,
    WP353_QUERIES: JSON.stringify(preset === 'wp454' ? WP454_QUERIES : WP353_QUERIES),
    ...(preset === 'wp454'
      ? { WP353_STATE_DIR: join(userData, 'brands'), WP353_STOP_ON_BLOCK: '1', WP353_NO_FETCH: '1' }
      : {}),
  },
  stdio: ['ignore', 'inherit', 'inherit'],
})
const code = await new Promise((r) => child.once('exit', r))
let report
try {
  report = JSON.parse(readFileSync(out, 'utf8'))
} catch {
  console.error(`没拿到结果（electron 退出码 ${code}）`)
  process.exitCode = 2
}
if (report !== undefined) {
  for (const r of report.results) {
    const hosts = (r.sources ?? []).map((s) => new URL(s.url).hostname.replace(/^www\./, ''))
    console.log(
      `${r.query} | ${JSON.stringify(r.locale ?? {})} | via=${r.via ?? '-'} | n=${hosts.length} | ${hosts.slice(0, 5).join(', ')}${r.error ? ` | ERR ${r.error}` : ''} | ${r.ms}ms`,
    )
  }
  if (report.fetched) console.log('fetch:', JSON.stringify(report.fetched).slice(0, 300))
  for (const [brand, st] of Object.entries(report.state ?? {}))
    for (const e of st.trace ?? [])
      console.log(
        `${brand} ${new Date(e.at).toISOString()} ${e.query_hash} via=${e.via ?? '-'} ${e.ms}ms | ${e.steps.map((x) => `${x.via}:${x.result}(${x.ms}ms${x.why ? ` ${x.why}` : ''})`).join(' → ')}`,
      )
}
if (outIdx < 0) rmSync(userData, { recursive: true, force: true })
else rmSync(userData, { recursive: true, force: true })
