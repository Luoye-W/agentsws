/**
 * 场景报告与合并门禁（26 §4）。
 *
 * 报告 = 通过 / 失败 + 不变量违反明细（含事件 id）+ 指标表 + 与基线的 delta。
 * 合并门禁 = fast 全过且指标不劣化（阈值可配，默认 5%）。
 */
import type { Iso8601 } from '@agentsws/contracts'
import type { Evidence } from './evidence.js'
import type { ExpectationResult } from './expectations.js'
import type { InvariantResult } from './invariants.js'
import type { MetricTable } from './metrics.js'
import type { Scenario, Tier } from './scenario/types.js'

export interface MetricDelta {
  baseline: number
  current: number
  /** 相对基线的变化百分比（正 = 变大） */
  change_pct: number
  /** 按指标方向判断是否劣化 */
  regressed: boolean
}

export interface ScenarioReport {
  id: string
  pack: string
  tier: Tier
  seed: number
  passed: boolean
  /** 虚拟时间跨度 */
  clock: { start: Iso8601; end: Iso8601; virtual_ms: number }
  counts: {
    events: number
    runs: number
    inbound: number
    approvals: number
    changes: number
    outbound_observations: number
    emails_sent: number
  }
  invariants: InvariantResult[]
  expectations: ExpectationResult[]
  metrics: MetricTable
  /** 26 §1：v1 不跑 judge，主观键记 skipped */
  rubric?: { skipped: true; reason: string; prompt: string }
  delta?: Record<string, MetricDelta>
  /** 未被断言拦下、但值得看的东西（被挡下的提议、apply 失败） */
  notes: string[]
}

export interface BuildReportInput {
  scenario: Scenario
  tier: Tier
  seed: number
  evidence: Evidence
  metrics: MetricTable
  invariants: InvariantResult[]
  expectations: ExpectationResult[]
}

export function buildReport(input: BuildReportInput): ScenarioReport {
  const { scenario, evidence } = input
  const passed = input.invariants.every((i) => i.ok) && input.expectations.every((e) => e.ok)
  const notes: string[] = []
  for (const b of evidence.blocked) notes.push(`blocked[${b.rule}] ${b.message}`)
  for (const n of evidence.notifications) notes.push(`notify[${n.to}] ${n.title}`)

  return {
    id: scenario.id,
    pack: scenario.dataset.pack,
    tier: input.tier,
    seed: input.seed,
    passed,
    clock: {
      start: evidence.start,
      end: evidence.end,
      virtual_ms: Date.parse(evidence.end) - Date.parse(evidence.start),
    },
    counts: {
      events: evidence.events.length,
      runs: evidence.runs.length,
      inbound: evidence.inbound.length,
      approvals: evidence.approvals.length,
      changes: evidence.changes.length,
      outbound_observations: evidence.observations.length,
      emails_sent: evidence.emails.length,
    },
    invariants: input.invariants,
    expectations: input.expectations,
    metrics: input.metrics,
    ...(scenario.rubric === undefined
      ? {}
      : {
          rubric: {
            skipped: true as const,
            reason: 'v1 不跑 judge（26 §1）：无 key 时 replay 重打分，realistic 档再接',
            prompt: scenario.rubric,
          },
        }),
    notes,
  }
}

// ── 基线与门禁 ────────────────────────────────────────────────────────────

export interface Baseline {
  schema_version: 1
  generated_at: Iso8601
  scenarios: Record<string, { metrics: Record<string, number> }>
}

/** 从一组报告生成基线文件内容。 */
export function toBaseline(reports: readonly ScenarioReport[], at: Iso8601): Baseline {
  const scenarios: Baseline['scenarios'] = {}
  for (const r of [...reports].sort((a, b) => a.id.localeCompare(b.id))) {
    const metrics: Record<string, number> = {}
    for (const key of Object.keys(r.metrics).sort()) {
      const m = r.metrics[key]
      if (m !== undefined) metrics[key] = m.value
    }
    scenarios[r.id] = { metrics }
  }
  return { schema_version: 1, generated_at: at, scenarios }
}

/** 把基线里的数与报告比一比，写进报告的 `delta`。 */
export function attachDelta(
  report: ScenarioReport,
  baseline: Baseline | undefined,
  maxRegressionPct: number,
): ScenarioReport {
  const row = baseline?.scenarios[report.id]
  if (row === undefined) return report
  const delta: Record<string, MetricDelta> = {}
  for (const [name, metric] of Object.entries(report.metrics)) {
    const before = row.metrics[name]
    if (before === undefined) continue
    const change_pct =
      before === 0
        ? metric.value === 0
          ? 0
          : 100
        : ((metric.value - before) / Math.abs(before)) * 100
    const worse = metric.direction === 'higher_better' ? change_pct < 0 : change_pct > 0
    delta[name] = {
      baseline: before,
      current: metric.value,
      change_pct: Math.round(change_pct * 100) / 100,
      regressed: worse && Math.abs(change_pct) > maxRegressionPct,
    }
  }
  return { ...report, delta }
}

export interface GateOptions {
  maxRegressionPct?: number
}

export interface GateFailure {
  scenario: string
  kind: 'invariant' | 'expectation' | 'regression'
  detail: string
}

export interface GateResult {
  ok: boolean
  failures: GateFailure[]
  /** 参与门禁的场景数 */
  scenarios: number
}

/**
 * 合并门禁（26 §4）：fast 全过 + 指标不劣化超过阈值（默认 5%）。
 * 基线里没有的场景不判劣化（新场景第一次跑）。
 */
export function gate(
  reports: readonly ScenarioReport[],
  baseline: Baseline | undefined,
  options: GateOptions = {},
): GateResult {
  const maxRegressionPct = options.maxRegressionPct ?? 5
  const failures: GateFailure[] = []
  for (const report of reports) {
    for (const inv of report.invariants) {
      if (inv.ok) continue
      failures.push({
        scenario: report.id,
        kind: 'invariant',
        detail: `${inv.name}: ${inv.violations.map((v) => v.message).join(' | ')}`,
      })
    }
    for (const exp of report.expectations) {
      if (exp.ok) continue
      failures.push({
        scenario: report.id,
        kind: 'expectation',
        detail: `${exp.key}: ${exp.detail}`,
      })
    }
    const withDelta = attachDelta(report, baseline, maxRegressionPct)
    for (const [name, d] of Object.entries(withDelta.delta ?? {})) {
      if (!d.regressed) continue
      failures.push({
        scenario: report.id,
        kind: 'regression',
        detail: `${name} ${d.baseline} → ${d.current}（${d.change_pct}%，阈值 ${maxRegressionPct}%）`,
      })
    }
  }
  return { ok: failures.length === 0, failures, scenarios: reports.length }
}

/** 一行一条的人可读摘要（CLI 与提交报告用）。 */
export function formatReport(report: ScenarioReport): string {
  const lines: string[] = []
  lines.push(
    `${report.passed ? 'PASS' : 'FAIL'}  ${report.id}  [${report.tier}, seed ${report.seed}]`,
  )
  const inv = report.invariants.map((i) => `${i.ok ? '✓' : '✗'}${i.name}`).join(' ')
  if (inv.length > 0) lines.push(`  invariants: ${inv}`)
  for (const i of report.invariants.filter((x) => !x.ok)) {
    for (const v of i.violations) {
      lines.push(
        `    ✗ ${i.name}: ${v.message}${v.event_ids.length > 0 ? ` [${v.event_ids.join(',')}]` : ''}`,
      )
    }
  }
  for (const e of report.expectations) {
    if (!e.ok) lines.push(`    ✗ expected.${e.key}: ${e.detail}`)
  }
  const metrics = Object.entries(report.metrics)
    .map(([k, m]) => `${k}=${m.value}`)
    .join(' ')
  lines.push(`  metrics: ${metrics}`)
  if (report.rubric !== undefined) lines.push('  rubric: skipped (v1 不跑 judge)')
  return lines.join('\n')
}
