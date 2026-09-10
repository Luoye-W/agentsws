/**
 * 升级基线采集器（WP41 / docs/42 第 1 步与第 4 步）。
 *
 * 在**当前安装的 dsh 版本**下把两档 dsh 运行时的行为压成一份指纹：
 * 每条场景的事件类型序列、六条不变量、指标、摘要。升级前跑一次、升级后跑一次，
 * `test/upgrade.test.ts` 只读这两份 JSON 做对比——所以它不需要 import `@agentsws/simulation`，
 * dsh-adapter ↔ simulation 的 devDependency 环（38 §1）不会因为这个 WP 又长回来。
 *
 * 用法（先 `tsc -b`）：
 *   node packages/dsh-adapter/test/upgrade-baseline/capture.mjs [输出文件名]
 * 省略文件名时按 `@deepseek-ai/dsh` 的实际安装版本命名。
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const require = createRequire(import.meta.url)

const sim = await import(join(REPO_ROOT, 'packages/simulation/dist/index.js'))
const { findScenarios, loadPack, loadScenario, runScenario } = sim

const PACK_DIR = join(REPO_ROOT, 'packs/dtc-3c-3p')
const RUNTIMES = ['dsh-in-process', 'dsh-subprocess']

/** 装的到底是哪一版（不看 package.json 的声明，看解析出来的那个包）。 */
function installedVersions() {
  const names = [
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh',
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-headless',
    '@deepseek-ai/dsh-llm',
    '@deepseek-ai/dsh-scope',
    '@deepseek-ai/dsh-sdk-client',
    '@deepseek-ai/dsh-sdk-protocol',
    '@deepseek-ai/dsh-session',
    '@deepseek-ai/dsh-system-prompt',
    '@deepseek-ai/dsh-tools',
    '@deepseek-ai/dsh-user-approval',
    '@deepseek-ai/dsh-util-values',
  ]
  const out = {}
  for (const n of names) {
    try {
      out[n] = require(`${n}/package.json`).version
    } catch {
      out[n] = null
    }
  }
  return out
}

/**
 * 事件序列指纹：只取属于某次运行的事件（与 `runtime-parity.test.ts` 同一条过滤规则），
 * 记 `type@at`——类型 + 合成时钟时刻，不含随机 id，两次跑必须逐字节相同。
 */
function eventFingerprint(evidence) {
  return evidence.events
    .filter((e) => e.correlation.run_id !== undefined)
    .map((e) => `${e.type}@${e.at}`)
}

async function capture() {
  const pack = loadPack(PACK_DIR)
  const files = findScenarios(PACK_DIR, ['scenarios/**/*.yml']).sort()
  const runtimes = {}
  for (const runtime of RUNTIMES) {
    const scenarios = {}
    for (const file of files) {
      const rel = file.slice(`${PACK_DIR}/scenarios/`.length).replace(/\.yml$/, '')
      let evidence
      const report = await runScenario(loadScenario(file), {
        pack,
        runtime,
        captureEvidence: (e) => {
          evidence = e
        },
      })
      if (evidence === undefined) throw new Error(`没有拿到证据：${rel}`)
      scenarios[rel] = {
        passed: report.passed,
        // `type@at`：类型 + 合成时钟时刻。事件类型序列由它派生（`upgrade.test.ts` 里切一刀）
        events: eventFingerprint(evidence),
        invariants: Object.fromEntries(report.invariants.map((i) => [i.name, i.ok])),
        expectations: Object.fromEntries(report.expectations.map((e) => [e.key, e.ok])),
        // 只留数值：指标表里的 event_types / note 是给人看的，比对用不上，留着让基线文件肿三倍
        metrics: Object.fromEntries(Object.entries(report.metrics).map(([k, v]) => [k, v.value])),
        summaries: evidence.runs.map((r) => r.result?.summary ?? null),
        counts: report.counts,
      }
      process.stderr.write(`  ${runtime} ${rel} ${report.passed ? 'ok' : 'FAIL'}\n`)
    }
    runtimes[runtime] = scenarios
  }
  return runtimes
}

const versions = installedVersions()
const label = process.argv[2] ?? `${versions['@deepseek-ai/dsh'] ?? 'unknown'}.json`
const runtimes = await capture()
const payload = {
  schema_version: 1,
  dsh_version: versions['@deepseek-ai/dsh'],
  packages: versions,
  pack: 'dtc-3c-3p',
  runtimes,
}
mkdirSync(HERE, { recursive: true })
const out = join(HERE, label.endsWith('.json') ? label : `${label}.json`)
writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
// 基线文件是要提交的产物，`biome check .` 也会看它：让采集器自己排好版，
// 免得每次重采都要人手补一次 format（`biome check .` 退出码必须是 0）。
execFileSync(join(REPO_ROOT, 'node_modules/.bin/biome'), ['check', '--write', out], {
  stdio: 'ignore',
})
process.stderr.write(`写入 ${out}\n`)
