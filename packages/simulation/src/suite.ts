/**
 * 场景套件：按 glob 选场景、按 pack 起世界、跑完出报告文件与合并门禁结论（26 §4 §5）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Iso8601 } from '@agentsws/contracts'
import { SimulationError } from './errors.js'
import type { Pack } from './pack.js'
import { listFiles, loadPack } from './pack.js'
import type { Baseline, GateResult, ScenarioReport } from './report.js'
import { attachDelta, formatReport, gate, toBaseline } from './report.js'
import { runScenario } from './runner.js'
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
}

export interface SuiteResult {
  pack: string
  tier: Tier
  reports: ScenarioReport[]
  gate: GateResult
  baseline?: Baseline
  /** 落盘的文件（绝对路径） */
  written: string[]
}

export function readBaseline(file: string): Baseline | undefined {
  if (!existsSync(file)) return undefined
  return JSON.parse(readFileSync(file, 'utf8')) as Baseline
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
  const scenarios: Scenario[] = unique.map((f) => loadScenario(f))
  const reports: ScenarioReport[] = []
  for (const scenario of scenarios) {
    reports.push(
      await runScenario(scenario, {
        tier,
        pack,
        ...(options.seed === undefined ? {} : { seed: options.seed }),
      }),
    )
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
  }

  if (baseline === undefined && options.writeBaselineIfMissing === true) {
    const next = toBaseline(withDelta, generatedAt)
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
  }
}
