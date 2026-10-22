#!/usr/bin/env node
/**
 * WP455（决策 1434）：**真机**——「用你的 Chrome（插件）搜 Google」那一环连搜几条。
 *
 * 前提：这台电脑的 Chrome 里装好了 BrowserSkill 扩展、`bsk` 装好（工坊设置里选「用你正在用的浏览器」时装的那一份，
 * 在工坊数据目录 `bin/bsk`；也可以是任何钉过版本的 `bsk`）。先 `npx tsc -b apps/server`。
 *
 * 跑的是服务进程那一份搜索后端（同一份构建产物），**不接内置浏览器**（= 人为让第 1 步失败）、不接云端、
 * 不接公开搜索——所以每条都走到你的 Chrome 那一步。只开后台窗口、只读；Google 一出人机验证就记下、停
 * （不点、不绕、不亮给人）。状态放在会话临时目录，跑完删掉。
 *
 * 用法：node scripts/e2e-own-chrome-search.mjs --bsk <bsk 路径> [--out <json>] [--market US]
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const bskPath = opt('--bsk')
if (bskPath === undefined) {
  process.stderr.write('要给 --bsk <bsk 路径>\n')
  process.exit(2)
}
const market = opt('--market') ?? 'US'
const QUERIES = [
  'best standing desk 2026',
  'wireless earbuds battery life comparison',
  'usb c hub for laptop',
  'ergonomic office chair review',
  'portable monitor 15.6 inch',
]

const wb = await import(pathToFileURL(join(ROOT, 'apps/server/dist/web-browser/index.js')).href)
const dir = mkdtempSync(join(tmpdir(), 'wp455-e2e-'))
const out = resolve(opt('--out') ?? join(tmpdir(), 'wp455-own-chrome-e2e.json'))
const reader = wb.createOwnBrowserReader({
  bsk: wb.bskJsonOf(bskPath),
  log: (m, f) => process.stdout.write(`  · ${m} ${JSON.stringify(f ?? {})}\n`),
})
const gate = wb.createOwnChromeGate({ now: () => Date.now() })
const search = wb.createBrowserWebSearch({
  workspace_id: 'brand_wp455_e2e',
  dir,
  throttle: wb.createSearchThrottle({
    now: () => Date.now(),
    random: Math.random,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  }),
  profile: () => ({ markets: [market] }),
  ownChrome: { reader: () => reader, gate },
  now: () => Date.now(),
  log: (line) => process.stdout.write(`  · ${line}\n`),
})

const results = []
try {
  for (const query of QUERIES) {
    const t0 = Date.now()
    let r
    try {
      r = await search.search(query, 10)
    } catch (e) {
      r = { error: e instanceof Error ? e.message : String(e) }
    }
    const row = {
      query,
      ms: Date.now() - t0,
      via: r.via,
      count: r.sources?.length ?? 0,
      content: r.content ?? r.error,
      first: (r.sources ?? []).slice(0, 3).map((s) => s.title),
    }
    results.push(row)
    process.stdout.write(`${query} → ${row.via ?? '没有'}，${row.count} 条，${row.ms} ms\n`)
    if (gate.pausedUntil() !== undefined) {
      process.stdout.write('  Google 在你的 Chrome 里要验证：停（不点、不绕）\n')
      break
    }
  }
} finally {
  await reader.close()
  const state = JSON.parse(readFileSync(join(dir, 'web-search.json'), 'utf8'))
  writeFileSync(
    out,
    JSON.stringify({ at: new Date().toISOString(), results, trace: state.trace }, null, 2),
  )
  rmSync(dir, { recursive: true, force: true })
  process.stdout.write(`结果：${out}\n`)
}
