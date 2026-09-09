/**
 * 场景套件：按 glob 选场景、按 pack 起世界、跑完出报告文件与合并门禁结论（26 §4 §5）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Iso8601 } from '@agentsws/contracts'
import { SimulationError } from './errors.js'
import type { Pack } from './pack.js'
import { listFiles, loadPack } from './pack.js'
import type { Env } from './realistic.js'
import { CostGuard, createRealisticHooks, RealisticCache, resolveSimModel } from './realistic.js'
import type { Baseline, BaselineV1, GateResult, ScenarioReport } from './report.js'
import { attachDelta, formatReport, gate, normalizeBaseline, toBaseline } from './report.js'
import { runScenario } from './runner.js'
import type { RuntimeName } from './runtime-name.js'
import { baselineRuntime as baselineRuntimeOf } from './runtime-name.js'
import { loadScenario } from './scenario/parse.js'
import type { Scenario, Tier } from './scenario/types.js'

/** `scenarios/**\/*.yml` 这样的 glob → 正则。只支持 `**`、`*`、`?`。 */
export function globToRegExp(pattern: string): RegExp {
  let out = '^'
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i]
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` 也匹配零级目录
        if (pattern[i + 2] === '/') {
          out += '(?:[^/]*\\/)*'
          i += 2
        } else {
          out += '.*'
          i += 1
        }
      } else {
        out += '[^/]*'
      }
      continue
    }
    if (c === '?') {
      out += '[^/]'
      continue
    }
    out += (c ?? '').replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`${out}$`)
}

const posix = (p: string): string => p.split(sep).join('/')

/** 在 `root` 下按 glob 找场景文件（相对 root 匹配）。 */
export function findScenarios(root: string, patterns: readonly string[]): string[] {
  const all = listFiles(root, '.yml')
  const res = patterns.map((p) => globToRegExp(p))
  return all.filter((f) => {
    const rel = posix(relative(root, f))
    return res.some((re) => re.test(rel) || re.test(posix(f)))
  })
}

export interface SuiteOptions {
  /** pack 目录（`packs/dtc-3c-3p`）。 */
  packDir: string
  /** 场景 glob（相对 pack 目录，或相对 `scenarioRoot`）。缺省 `scenarios/**\/*.yml`。 */
  scenario?: string[]
  /** 场景根目录；缺省 = pack 目录（隐藏集用 `packages/simulation/hidden`）。 */
  scenarioRoot?: string
  tier?: Tier
  seed?: number
  /** 报告输出目录；不给就不落盘。 */
  reportDir?: string
  /** 基线文件；缺省 `<packDir>/baseline.json`。 */
  baselineFile?: string
  /** 没有基线时写一份（首次生成）。 */
  writeBaselineIfMissing?: boolean
  maxRegressionPct?: number
  /** 报告文件里的生成时刻；不给就用最后一条场景的虚拟结束时刻（保持可复现）。 */
  generatedAt?: Iso8601
  /** 用哪个运行时跑（17 §4）；缺省 `stub`。基线按运行时分档（`baselineRuntime`）。 */
  runtime?: RuntimeName
  /** 已有基线时也覆盖写这一档（跑新运行时时用）。 */
  writeBaseline?: boolean
  /**
   * WP32 realistic 档：这一次跑全部场景最多花多少（基准货币）。
   * 超了就停在那一条，把**已跑的部分**报出来（22 §3 预算最外面那一级）。
   */
  maxCostBase?: number
  /** WP32：真模型从哪些环境变量取（缺省 `process.env`）。 */
  env?: Env
  /** WP32：客户来信缓存目录（缺省 `<reportDir ?? out>/realistic-cache`）。 */
  cacheDir?: string
}

export interface SuiteResult {
  pack: string
  tier: Tier
  reports: ScenarioReport[]
  gate: GateResult
  baseline?: Baseline
  /** 落盘的文件（绝对路径） */
  written: string[]
  /**
   * 整档跳过了（realistic 档没有 key）。**跳过不是失败**——
   * `gate.ok` 仍然是 true，调用方据此退 0 并打印这句话（26 §1）。
   */
  skipped?: string
  /** WP32 realistic 档：这次真花了多少（基准货币），以及有没有因为预算停下来。 */
  cost?: { spent: number; cap: number; stopped_at?: string; model: string }
  /** 声明了 `tiers` 而这一档不跑的场景。 */
  not_in_tier: string[]
}

export function readBaseline(file: string): Baseline | undefined {
  if (!existsSync(file)) return undefined
  return normalizeBaseline(JSON.parse(readFileSync(file, 'utf8')) as Baseline | BaselineV1)
}

/** 跑一整套场景。 */
export async function runSuite(options: SuiteOptions): Promise<SuiteResult> {
  const packDir = resolve(options.packDir)
  const pack: Pack = loadPack(packDir)
  const root = resolve(options.scenarioRoot ?? packDir)
  const patterns = options.scenario ?? ['scenarios/**/*.yml']
  const files = patterns
    .filter((p) => isAbsolute(p) && existsSync(p))
    .concat(
      findScenarios(
        root,
        patterns.filter((p) => !isAbsolute(p) || !existsSync(p)),
      ),
    )
  const unique = [...new Set(files)].sort()
  if (unique.length === 0) {
    throw new SimulationError('not_found', `没有匹配到场景：${patterns.join(', ')}（根 ${root}）`)
  }

  const tier: Tier = options.tier ?? 'fast'
  const all: Scenario[] = unique.map((f) => loadScenario(f))
  // 声明了 `tiers` 的场景只在它写的那几档跑（soak 那条合成场景不该出现在 fast 里）
  const scenarios = all.filter((s) => s.tiers === undefined || s.tiers.includes(tier))
  const not_in_tier = all.filter((s) => !scenarios.includes(s)).map((s) => s.id)

  // ── realistic 档：真模型 + 预算 + 来信缓存（没有 key 就整档跳过，不红）──
  const env = options.env ?? process.env
  const sim = tier === 'realistic' ? resolveSimModel(env) : undefined
  if (tier === 'realistic' && sim === undefined) {
    return {
      pack: pack.manifest.pack,
      tier,
      reports: [],
      gate: { ok: true, failures: [], scenarios: 0 },
      written: [],
      not_in_tier,
      skipped:
        'realistic 档需要真模型的 key：设 DEEPSEEK_API_KEY，或 AGENTSWS_SIM_MODEL_API_KEY ' +
        '（配合 AGENTSWS_SIM_MODEL_PROVIDER / _NAME / _BASE_URL）。没有 key 不算失败，整档跳过。',
    }
  }
  const guard = new CostGuard(options.maxCostBase ?? 2)
  const cache = new RealisticCache(
    options.cacheDir ?? join(options.reportDir ?? resolve('out'), 'realistic-cache'),
  )

  const reports: ScenarioReport[] = []
  let stoppedAt: string | undefined
  for (const scenario of scenarios) {
    if (sim !== undefined && guard.exhausted) {
      stoppedAt = scenario.id
      break
    }
    reports.push(
      await runScenario(scenario, {
        tier,
        pack,
        ...(options.seed === undefined ? {} : { seed: options.seed }),
        ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
        ...(sim === undefined
          ? {}
          : {
              model: { provider: sim.provider, ref: sim.ref, prices: sim.prices },
              modelJudge: true,
              realistic: (world) => createRealisticHooks({ world, pack, cache, guard }),
            }),
      }),
    )
    // 一条场景真花了多少，以**事件日志**为准（22 §3 每次调用一条 model.usage）——
    // 钩子在场景内部自己累的那份只是为了让 `max_cost_base` 实时收紧，跑完以账为准
    if (sim !== undefined) {
      guard.spent = reports.reduce((n, r) => n + (r.metrics.cost_base?.value ?? 0), 0)
    }
  }

  const baselineFile = resolve(options.baselineFile ?? join(packDir, 'baseline.json'))
  const baseline = readBaseline(baselineFile)
  const maxRegressionPct = options.maxRegressionPct ?? 5
  const withDelta = reports.map((r) => attachDelta(r, baseline, maxRegressionPct))
  const verdict = gate(withDelta, baseline, { maxRegressionPct })

  const written: string[] = []
  const generatedAt =
    options.generatedAt ?? withDelta[withDelta.length - 1]?.clock.end ?? '1970-01-01T00:00:00.000Z'
  if (options.reportDir !== undefined) {
    const dir = resolve(options.reportDir)
    mkdirSync(dir, { recursive: true })
    for (const report of withDelta) {
      const file = join(dir, `${report.id.replace(/[/\\]/g, '__')}.json`)
      writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
      written.push(file)
    }
    const summary = join(dir, 'summary.json')
    writeFileSync(
      summary,
      `${JSON.stringify(
        {
          pack: pack.manifest.pack,
          tier,
          generated_at: generatedAt,
          passed: verdict.ok,
          scenarios: withDelta.map((r) => ({ id: r.id, passed: r.passed })),
          gate: verdict,
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
    written.push(summary)
    const text = join(dir, 'summary.txt')
    writeFileSync(text, `${withDelta.map(formatReport).join('\n')}\n`, 'utf8')
    written.push(text)
    // 26 §4 的报告：人看的那一份（judge 分数、不变量、指标表、与基线的 delta）
    const md = join(dir, 'summary.md')
    const view = {
      pack: pack.manifest.pack,
      tier,
      runtime: baselineRuntimeOf(options.runtime),
      generated_at: generatedAt,
      reports: withDelta,
      gate: verdict,
      ...(sim === undefined
        ? {}
        : {
            cost: {
              spent: guard.spent,
              cap: guard.cap,
              model: sim.describe,
              ...(stoppedAt === undefined ? {} : { stopped_at: stoppedAt }),
            },
          }),
    }
    writeFileSync(md, suiteMarkdown(view), 'utf8')
    written.push(md)
    const html = join(dir, 'summary.html')
    writeFileSync(html, suiteHtml(view), 'utf8')
    written.push(html)
  }

  const missingTier =
    baseline === undefined || baseline.runtimes[baselineRuntimeOf(options.runtime)] === undefined
  if (options.writeBaseline === true || (missingTier && options.writeBaselineIfMissing === true)) {
    const next = toBaseline(withDelta, generatedAt, baseline)
    mkdirSync(resolve(baselineFile, '..'), { recursive: true })
    writeFileSync(baselineFile, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    written.push(baselineFile)
  }

  return {
    pack: pack.manifest.pack,
    tier,
    reports: withDelta,
    gate: verdict,
    ...(baseline === undefined ? {} : { baseline }),
    written,
    not_in_tier,
    ...(sim === undefined
      ? {}
      : {
          cost: {
            spent: Math.round(guard.spent * 1e6) / 1e6,
            cap: guard.cap,
            model: sim.describe,
            ...(stoppedAt === undefined ? {} : { stopped_at: stoppedAt }),
          },
        }),
  }
}

export interface SuiteView {
  pack: string
  tier: Tier
  runtime: string
  generated_at: Iso8601
  reports: readonly ScenarioReport[]
  gate: GateResult
  cost?: { spent: number; cap: number; model: string; stopped_at?: string }
}

/** 26 §4 的报告：人看的那一份。 */
export function suiteMarkdown(view: SuiteView): string {
  const lines: string[] = []
  const passed = view.reports.filter((r) => r.passed).length
  lines.push(`# 模拟回路报告 —— ${view.pack}`)
  lines.push('')
  lines.push(
    `${view.gate.ok ? '**合并门禁：通过**' : '**合并门禁：不通过**'}｜${passed}/${view.reports.length} 场景通过｜` +
      `${view.tier} 档｜${view.runtime} 运行时｜${view.generated_at}`,
  )
  if (view.cost !== undefined) {
    lines.push('')
    lines.push(
      `真模型：${view.cost.model}；这次花了 ${view.cost.spent.toFixed(4)} / 上限 ${view.cost.cap}` +
        (view.cost.stopped_at === undefined
          ? ''
          : `；**预算用完，停在 \`${view.cost.stopped_at}\` 之前**（前面几条的结果照常有效）`),
    )
  }
  lines.push('')
  lines.push('## 场景')
  lines.push('')
  lines.push('| 场景 | 结果 | 不变量 | 规则 judge | 模型 judge |')
  lines.push('|---|---|---|---|---|')
  for (const r of view.reports) {
    const inv = `${r.invariants.filter((i) => i.ok).length}/${r.invariants.length}`
    const rule = r.judge === undefined ? '—' : r.judge.rule.score.toFixed(3)
    const model =
      r.judge?.model === undefined
        ? '—'
        : r.judge.model.skipped === undefined
          ? r.judge.model.score.toFixed(3)
          : `skipped（${r.judge.model.skipped.slice(0, 40)}）`
    lines.push(`| \`${r.id}\` | ${r.passed ? '✓' : '✗'} | ${inv} | ${rule} | ${model} |`)
  }
  lines.push('')
  if (!view.gate.ok) {
    lines.push('## 门禁没过的地方')
    lines.push('')
    for (const f of view.gate.failures) lines.push(`- \`${f.scenario}\` [${f.kind}] ${f.detail}`)
    lines.push('')
  }
  const names = [...new Set(view.reports.flatMap((r) => Object.keys(r.metrics)))].sort()
  lines.push('## 指标（括号里是与基线的 delta）')
  lines.push('')
  lines.push(`| 场景 | ${names.join(' | ')} |`)
  lines.push(`|---|${names.map(() => '---').join('|')}|`)
  for (const r of view.reports) {
    const cells = names.map((n) => {
      const m = r.metrics[n]
      if (m === undefined) return '—'
      const d = r.delta?.[n]
      return d === undefined
        ? `${m.value}`
        : `${m.value}（${d.change_pct >= 0 ? '+' : ''}${d.change_pct}%）`
    })
    lines.push(`| \`${r.id}\` | ${cells.join(' | ')} |`)
  }
  lines.push('')
  const withJudge = view.reports.filter((r) => r.judge !== undefined && r.judge.rule.total > 0)
  if (withJudge.length > 0) {
    lines.push('## judge 明细（规则 judge 进门禁，模型 judge 只报不拦）')
    lines.push('')
    for (const r of withJudge) {
      const j = r.judge
      if (j === undefined) continue
      lines.push(`### \`${r.id}\` —— ${j.rule.passed}/${j.rule.total}`)
      lines.push('')
      for (const c of j.rule.checks) {
        lines.push(`- ${c.ok ? '✓' : '✗'} \`${c.id}\` @ ${c.target}：${c.detail}`)
      }
      if (j.model !== undefined && j.model.notes.length > 0) {
        lines.push(`- 模型 judge（${j.model.model}）：${j.model.notes.join('；')}`)
      }
      lines.push('')
    }
  }
  return `${lines.join('\n')}\n`
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** 同一份内容的网页版（`--report` 目录里直接双击能开）。 */
export function suiteHtml(view: SuiteView): string {
  const passed = view.reports.filter((r) => r.passed).length
  const rows = view.reports
    .map((r) => {
      const inv = r.invariants
        .map((i) => `<span class="${i.ok ? 'ok' : 'bad'}">${i.ok ? '✓' : '✗'}${esc(i.name)}</span>`)
        .join(' ')
      const metrics = Object.entries(r.metrics)
        .map(([k, m]) => {
          const d = r.delta?.[k]
          const tag =
            d === undefined
              ? ''
              : `<em class="${d.regressed ? 'bad' : 'dim'}">${d.change_pct >= 0 ? '+' : ''}${d.change_pct}%</em>`
          return `<span class="metric">${esc(k)} <b>${m.value}</b>${tag}</span>`
        })
        .join(' ')
      const judge =
        r.judge === undefined
          ? '—'
          : `规则 ${r.judge.rule.score.toFixed(3)}（${r.judge.rule.passed}/${r.judge.rule.total}）` +
            (r.judge.model === undefined
              ? ''
              : r.judge.model.skipped === undefined
                ? `，模型 ${r.judge.model.score.toFixed(3)}`
                : '，模型 skipped')
      return `<tr class="${r.passed ? '' : 'fail'}">
  <td><code>${esc(r.id)}</code></td>
  <td>${r.passed ? '✓' : '✗'}</td>
  <td>${inv}</td>
  <td>${esc(judge)}</td>
  <td>${metrics}</td>
</tr>`
    })
    .join('\n')
  const failures = view.gate.failures
    .map((f) => `<li><code>${esc(f.scenario)}</code> [${esc(f.kind)}] ${esc(f.detail)}</li>`)
    .join('\n')
  const cost =
    view.cost === undefined
      ? ''
      : `<p class="cost">真模型 ${esc(view.cost.model)}；花了 <b>${view.cost.spent.toFixed(4)}</b> / 上限 ${view.cost.cap}${
          view.cost.stopped_at === undefined
            ? ''
            : `；<b>预算用完，停在 <code>${esc(view.cost.stopped_at)}</code> 之前</b>`
        }</p>`
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>模拟回路报告 · ${esc(view.pack)}</title>
<style>
:root { color-scheme: light dark; }
body { font: 14px/1.6 system-ui, -apple-system, "PingFang SC", sans-serif; margin: 2rem auto; max-width: 72rem; padding: 0 1rem; }
h1 { font-size: 1.4rem; } table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
th, td { border-bottom: 1px solid rgba(128,128,128,.3); padding: .4rem .5rem; text-align: left; vertical-align: top; }
th { font-weight: 600; opacity: .7; font-size: .85em; }
code { font-size: .9em; } .ok { color: #2a7; } .bad { color: #c33; font-weight: 600; } .dim { opacity: .55; }
tr.fail { background: rgba(204,51,51,.08); }
.metric { display: inline-block; margin-right: .75rem; white-space: nowrap; font-size: .9em; }
.metric em { font-style: normal; margin-left: .2rem; font-size: .85em; }
.verdict { font-size: 1.05rem; font-weight: 600; } .cost { opacity: .8; }
</style></head><body>
<h1>模拟回路报告 · ${esc(view.pack)}</h1>
<p class="verdict ${view.gate.ok ? 'ok' : 'bad'}">${view.gate.ok ? '合并门禁：通过' : '合并门禁：不通过'} · ${passed}/${view.reports.length} 场景通过</p>
<p class="dim">${esc(view.tier)} 档 · ${esc(view.runtime)} 运行时 · ${esc(view.generated_at)}</p>
${cost}
${failures === '' ? '' : `<h2>门禁没过的地方</h2><ul>${failures}</ul>`}
<table><thead><tr><th>场景</th><th></th><th>不变量</th><th>judge</th><th>指标</th></tr></thead>
<tbody>
${rows}
</tbody></table>
</body></html>
`
}
