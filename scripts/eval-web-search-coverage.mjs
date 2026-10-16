#!/usr/bin/env node
/**
 * 10-16 Luoye：DeepSeek 自带的联网搜索，会不会因为国内环境排除掉 Reddit、LinkedIn 这类海外内容？
 * 先验证再决定要不要换搜索方案。
 *
 * 做法：直接用官方 `DeepSeekSearchProvider`（和产品里一模一样的请求：Anthropic Messages 口 +
 * `web_search_20250305` 服务端工具），跑一组出海卖家常查的英文查询，数每条结果来自哪些网站。
 * 两类查询：
 * - 自然查询：不带 site:，看结果里有没有 Reddit / LinkedIn / YouTube / X / Amazon / Trustpilot 等；
 * - 指定站点：带 site:reddit.com 之类，看是不是一条都搜不到（搜不到 = 很可能被排除）。
 * 另跑两条中文查询作对照。
 *
 * 用法：key 先找环境变量 DEEPSEEK_API_KEY，没有就从 macOS 钥匙串取（服务名 agentsws-deepseek；
 * Luoye 10-16 存一次：`security add-generic-password -a "$USER" -s agentsws-deepseek -U -w`）。
 * 取到的值只交给请求头，不打印、不写文件。
 *   node scripts/eval-web-search-coverage.mjs
 * 结果写到 out/web-search-coverage.json，并在终端打一张表。每条查询约等于一次模型调用，全套 24 条。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const require = createRequire(join(root, 'packages', 'dsh-adapter', 'package.json'))
const mod = await import(require.resolve('@deepseek-ai/dsh-web-search-deepseek'))
const { DeepSeekSearchProvider, DEEPSEEK_DEFAULT_BASE_URL, DEEPSEEK_DEFAULT_MODEL } = mod

const fromKeychain = () => {
  if (process.platform !== 'darwin') return undefined
  try {
    return execFileSync('security', ['find-generic-password', '-s', 'agentsws-deepseek', '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return undefined
  }
}
const apiKey = process.env.DEEPSEEK_API_KEY || fromKeychain()
if (apiKey === undefined || apiKey.length === 0) {
  console.error(
    '没找到 DeepSeek key：环境变量 DEEPSEEK_API_KEY 和钥匙串 agentsws-deepseek 里都没有',
  )
  process.exit(2)
}

const provider = new DeepSeekSearchProvider(() => ({
  apiKey,
  baseURL: process.env.DEEPSEEK_SEARCH_BASE_URL ?? DEEPSEEK_DEFAULT_BASE_URL,
  model: DEEPSEEK_DEFAULT_MODEL,
  apiVersion: '2023-06-01',
  maxTokens: 4096,
  maxUses: 5,
}))

const QUERIES = [
  ['natural', 'INMO Air3 review reddit'],
  ['natural', 'best AI translation glasses 2026'],
  ['natural', 'smart glasses with teleprompter recommendations'],
  ['natural', 'XREAL vs RayNeo which to buy'],
  ['natural', 'Even Realities G1 problems'],
  ['natural', 'AR glasses subreddit'],
  ['natural', 'Shopify Facebook ads ROAS benchmark 2026'],
  ['natural', 'how to do influencer outreach for a DTC brand'],
  ['natural', 'INMO glasses company LinkedIn'],
  ['natural', 'Anker Soundcore customer complaints'],
  ['site', 'site:reddit.com smart glasses captions'],
  ['site', 'site:reddit.com INMO'],
  ['site', 'site:reddit.com r/SmartGlasses'],
  ['site', 'site:linkedin.com INMO'],
  ['site', 'site:linkedin.com smart glasses head of marketing'],
  ['site', 'site:youtube.com INMO Air3 review'],
  ['site', 'site:x.com RayNeo X3'],
  ['site', 'site:amazon.com translation glasses'],
  ['site', 'site:trustpilot.com XREAL'],
  ['site', 'site:quora.com AR glasses'],
  ['site', 'site:facebook.com smart glasses group'],
  ['site', 'site:tiktok.com smart glasses'],
  ['zh', '智能眼镜 推荐 2026'],
  ['zh', 'INMO 影目 眼镜 评测'],
]

const WATCH = {
  reddit: /(^|\.)reddit\.com$/,
  linkedin: /(^|\.)linkedin\.com$/,
  youtube: /(^|\.)(youtube\.com|youtu\.be)$/,
  x: /(^|\.)(x\.com|twitter\.com)$/,
  facebook: /(^|\.)facebook\.com$/,
  tiktok: /(^|\.)tiktok\.com$/,
  amazon: /(^|\.)amazon\.[a-z.]+$/,
  trustpilot: /(^|\.)trustpilot\.com$/,
  quora: /(^|\.)quora\.com$/,
  cn: /(^|\.)(zhihu\.com|csdn\.net|baidu\.com|bilibili\.com|sohu\.com|163\.com|qq\.com|smzdm\.com|jd\.com|sina\.com\.cn|toutiao\.com)$/,
}

const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return '?'
  }
}

const rows = []
for (const [kind, query] of QUERIES) {
  const started = Date.now()
  try {
    const out = await provider.search({ query })
    const results = Array.isArray(out) ? out : (out?.sources ?? out?.results ?? [])
    const hosts = results.map((r) => hostOf(r.url))
    const hit = Object.fromEntries(
      Object.entries(WATCH).map(([k, re]) => [k, hosts.filter((h) => re.test(h)).length]),
    )
    rows.push({
      kind,
      query,
      ok: true,
      ms: Date.now() - started,
      count: results.length,
      hosts,
      hit,
    })
    console.log(
      `${kind.padEnd(7)} ${String(results.length).padStart(2)} 条  ${query}\n        ${hosts.join(', ') || '（无结果）'}`,
    )
  } catch (err) {
    rows.push({
      kind,
      query,
      ok: false,
      ms: Date.now() - started,
      error: String(err).slice(0, 300),
    })
    console.log(`${kind.padEnd(7)} 失败  ${query}\n        ${String(err).slice(0, 200)}`)
  }
}

const natural = rows.filter((r) => r.kind === 'natural' && r.ok)
const sites = rows.filter((r) => r.kind === 'site')
const anyHit = (k) => natural.filter((r) => r.hit[k] > 0).length
console.log('\n== 自然查询（不带 site:）里出现过这些站的条数 ==')
for (const k of Object.keys(WATCH))
  console.log(`  ${k.padEnd(10)} ${anyHit(k)} / ${natural.length}`)
console.log('\n== 指定站点查询：结果里有没有那个站 ==')
for (const r of sites) {
  const want = r.query.match(/site:([a-z.]+)/)?.[1] ?? ''
  const got = r.ok ? r.hosts.filter((h) => h === want || h.endsWith(`.${want}`)).length : -1
  console.log(
    `  ${r.ok ? (got > 0 ? '有  ' : '没有') : '失败'} ${String(got).padStart(2)} / ${r.ok ? r.count : '-'}  ${r.query}`,
  )
}

const outDir = join(root, 'out')
mkdirSync(outDir, { recursive: true })
writeFileSync(
  join(outDir, 'web-search-coverage.json'),
  `${JSON.stringify({ at: new Date().toISOString(), rows }, null, 2)}\n`,
)
console.log(`\n明细：${join(outDir, 'web-search-coverage.json')}`)
