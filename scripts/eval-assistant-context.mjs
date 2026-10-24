#!/usr/bin/env node
/**
 * WP511（决策 1547，docs/115 §4 第 5 条）：助理小结 / 记忆离线评测。
 *
 *   node scripts/eval-assistant-context.mjs                         # 替身（默认）：不花钱，出召回 / 误记 / token 与估费
 *   node scripts/eval-assistant-context.mjs --size 400 --chatter 40 --window 64000   # 大一号的对话（看估费）
 *   node scripts/eval-assistant-context.mjs --runtime deepseek --model deepseek-flash --approved-usd 0.5
 *
 * 真模型那条**只有在 Luoye 看过估费、点了头之后**才跑：必须给 `--approved-usd`（花费上限，美元），跑之前先用替身估一遍，
 * 估出来超过上限就不跑；跑的过程中按模型报回的用量累计，超过上限立刻停。key 只认环境变量 DEEPSEEK_API_KEY，
 * 没有再读 macOS 钥匙串 `agentsws-deepseek`；值不打印、不进日志。
 *
 * 先 `npx tsc -b apps/server`（读 apps/server/dist）。
 */
import { execFileSync } from 'node:child_process'
import {
  EVAL_PRICES,
  estimateCost,
  fullHistoryTokens,
  runFull,
  runLayers,
  summarizeRun,
} from '../apps/server/dist/assistant-eval.js'
import { evalScenarios } from '../apps/server/dist/assistant-eval-scenarios.js'

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i < 0 ? fallback : args[i + 1]
}
const runtime = arg('runtime', 'stub')
const model = arg('model', 'deepseek-flash')
const window = Number(arg('window', '6000'))
const seed = Number(arg('seed', '42'))
const json = args.includes('--json')

// 每句填充多少字、每天几句填充（撑长对话、逼出压缩；越大越贵）
const size = Number(arg('size', '200'))
const chatterPerDay = Number(arg('chatter', '24'))
const scenarios = evalScenarios({ seed, size, chatterPerDay })

async function runAll(provider) {
  const runs = []
  for (const s of scenarios) {
    runs.push(await runLayers(s, { window, ...(provider === undefined ? {} : { provider }) }))
    runs.push(await runFull(s, provider === undefined ? {} : { provider }))
  }
  return runs
}

// 1) 替身先跑一遍：框架通不通、估费多少
const stubRuns = await runAll(undefined)
const estimate = Object.fromEntries(
  Object.keys(EVAL_PRICES).map((m) => [m, estimateCost(stubRuns, m)]),
)
const report = {
  runtime: 'stub',
  window,
  seed,
  size,
  chatterPerDay,
  runs: stubRuns.map(summarizeRun),
  full_every_turn: scenarios.map((s) => ({ scenario: s.id, ...fullHistoryTokens(s) })),
  estimate_usd: estimate,
}
if (runtime === 'stub') {
  if (json) console.log(JSON.stringify(report, null, 2))
  else {
    console.table(report.runs)
    console.table(report.full_every_turn)
    console.log('估费（真模型跑一遍，美元）：', JSON.stringify(estimate))
  }
  process.exit(0)
}

// 2) 真模型：要有上限，估出来超了不跑
if (runtime !== 'deepseek') throw new Error(`不认的 --runtime：${runtime}（stub / deepseek）`)
const approved = Number(arg('approved-usd', 'NaN'))
if (!Number.isFinite(approved) || approved <= 0)
  throw new Error('真模型要先估费、Luoye 点头后给 --approved-usd <上限美元> 才跑')
const price = EVAL_PRICES[model]
if (price === undefined) throw new Error(`没有 ${model} 的单价，先补进 EVAL_PRICES`)
if ((estimate[model]?.usd ?? Infinity) > approved)
  throw new Error(`估费 $${estimate[model]?.usd} 超过上限 $${approved}，不跑`)

const { openaiCompatibleProvider } = await import('../packages/model-gateway/dist/index.js')
const key = () => {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY
  try {
    return execFileSync('security', ['find-generic-password', '-s', 'agentsws-deepseek', '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return undefined
  }
}
let spent = 0
const real = (_probes, calls) => {
  const inner = openaiCompatibleProvider({ model, provider: 'deepseek', apiKey: key })
  return {
    ...inner,
    async complete(req) {
      if (spent > approved) throw new Error(`已花 $${spent.toFixed(4)}，到上限 $${approved}，停`)
      const out = await inner.complete(req)
      const sys = typeof req.messages[0]?.content === 'string' ? req.messages[0].content : ''
      const kind = sys.includes('压缩前半段')
        ? 'compact'
        : sys.includes('话题小结')
          ? 'summary'
          : 'chat'
      const u = out.usage
      calls.push({
        kind,
        input_tokens: u.input_tokens,
        cached_tokens: u.cached_tokens ?? 0,
        output_tokens: u.output_tokens,
      })
      spent +=
        ((u.input_tokens - (u.cached_tokens ?? 0)) * price.in +
          (u.cached_tokens ?? 0) * price.cached +
          u.output_tokens * price.out) /
        1_000_000
      return out
    },
  }
}
const realRuns = await runAll(real)
const out = { runtime: model, window, seed, runs: realRuns.map(summarizeRun), spent_usd: spent }
if (json) console.log(JSON.stringify(out, null, 2))
else {
  console.table(out.runs)
  for (const r of realRuns)
    for (const p of r.probes)
      console.log(
        r.scenario,
        r.mode,
        p.id,
        p.correct ? '✓' : p.wrong ? '✗ 误记' : '✗',
        p.answer.slice(0, 120).replace(/\s+/g, ' '),
      )
  console.log(`实际花费：$${spent.toFixed(4)}`)
}
