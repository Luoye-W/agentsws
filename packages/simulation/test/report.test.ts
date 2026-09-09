import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Baseline, ScenarioReport } from '../src/index.js'
import {
  attachDelta,
  formatReport,
  gate,
  readBaseline,
  runSuite,
  toBaseline,
} from '../src/index.js'
import { HIDDEN_DIR, PACK_DIR, runPackScenario } from './helpers.js'

const temps: string[] = []
const tempDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'agentsws-report-'))
  temps.push(d)
  return d
}
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true })
})

describe('报告（26 §4）', () => {
  it('通过 / 失败 + 不变量违反明细（含事件 id）+ 指标表', async () => {
    const { report } = await runPackScenario('aftersales/return-within-window.yml')
    expect(report.passed).toBe(true)
    expect(report.pack).toBe('dtc-3c-3p')
    expect(report.tier).toBe('fast')
    expect(report.counts.events).toBeGreaterThan(20)
    expect(report.clock.virtual_ms).toBeGreaterThan(24 * 3600 * 1000)
    expect(Object.keys(report.metrics)).toContain('adoption_rate')
    expect(formatReport(report)).toMatch(/^PASS/)
  })

  it('违反明细带事件 id', async () => {
    const { evidence } = await runPackScenario('aftersales/return-within-window.yml')
    const broken = structuredClone(evidence)
    broken.events = broken.events.filter((e) => e.type !== 'change.approved')
    const { checkInvariants } = await import('../src/index.js')
    const [inv] = checkInvariants(['apply_only_after_approved'], {
      evidence: broken,
      writeActions: new Set(),
    })
    expect(inv?.ok).toBe(false)
    expect(inv?.violations[0]?.event_ids.length).toBeGreaterThan(0)
  })

  it('rubric 记 skipped，不跑 judge（26 §1）', async () => {
    const { report } = await runPackScenario('aftersales/return-within-window.yml')
    expect(report.rubric?.skipped).toBe(true)
    expect(report.rubric?.prompt).toContain('退货窗口')
    const other = await runPackScenario('ops/model-outage.yml')
    expect(other.report.rubric).toBeUndefined()
  })
})

describe('基线与合并门禁（26 §4）', () => {
  const fake = (id: string, over: Partial<ScenarioReport> = {}): ScenarioReport =>
    ({
      id,
      pack: 'dtc-3c-3p',
      tier: 'fast',
      seed: 42,
      passed: true,
      clock: { start: 'a', end: 'b', virtual_ms: 0 },
      counts: {
        events: 0,
        runs: 0,
        inbound: 0,
        approvals: 0,
        changes: 0,
        outbound_observations: 0,
        emails_sent: 0,
      },
      invariants: [],
      expectations: [],
      metrics: {
        adoption_rate: {
          value: 1,
          event_types: ['approval.decided'],
          event_count: 1,
          direction: 'higher_better',
        },
        tokens_per_item: {
          value: 1000,
          event_types: ['model.usage'],
          event_count: 1,
          direction: 'lower_better',
        },
      },
      notes: [],
      ...over,
    }) as ScenarioReport

  const baseline: Baseline = {
    schema_version: 1,
    generated_at: '2026-09-07T00:00:00.000Z',
    scenarios: { 'a/b': { metrics: { adoption_rate: 1, tokens_per_item: 1000 } } },
  }

  it('指标不劣化 → 门禁绿', () => {
    const ok = gate([fake('a/b')], baseline, { maxRegressionPct: 5 })
    expect(ok.ok).toBe(true)
    expect(ok.scenarios).toBe(1)
  })

  it('劣化 5% 以上判红（higher_better 变小、lower_better 变大）', () => {
    const worseAdoption = fake('a/b')
    worseAdoption.metrics.adoption_rate = {
      value: 0.9,
      event_types: ['approval.decided'],
      event_count: 1,
      direction: 'higher_better',
    }
    const red = gate([worseAdoption], baseline, { maxRegressionPct: 5 })
    expect(red.ok).toBe(false)
    expect(red.failures[0]?.kind).toBe('regression')
    expect(red.failures[0]?.detail).toContain('adoption_rate')

    const worseTokens = fake('a/b')
    worseTokens.metrics.tokens_per_item = {
      value: 1100,
      event_types: ['model.usage'],
      event_count: 1,
      direction: 'lower_better',
    }
    expect(gate([worseTokens], baseline, { maxRegressionPct: 5 }).ok).toBe(false)
    // 阈值可配：放到 20% 就不算劣化
    expect(gate([worseTokens], baseline, { maxRegressionPct: 20 }).ok).toBe(true)
  })

  it('4% 的劣化在默认 5% 阈值内不判红', () => {
    const r = fake('a/b')
    r.metrics.tokens_per_item = {
      value: 1040,
      event_types: ['model.usage'],
      event_count: 1,
      direction: 'lower_better',
    }
    expect(gate([r], baseline).ok).toBe(true)
  })

  it('变好不算劣化；基线里没有的场景不判劣化', () => {
    const better = fake('a/b')
    better.metrics.tokens_per_item = {
      value: 500,
      event_types: ['model.usage'],
      event_count: 1,
      direction: 'lower_better',
    }
    expect(gate([better], baseline).ok).toBe(true)
    expect(gate([fake('new/one')], baseline).ok).toBe(true)
    expect(gate([fake('a/b')], undefined).ok).toBe(true)
  })

  it('不变量红 / 断言红 → 门禁红', () => {
    const bad = fake('a/b', {
      passed: false,
      invariants: [
        {
          name: 'prompt_replayable',
          ok: false,
          checked: 1,
          violations: [{ message: '哈希不一致', event_ids: ['evt_1'] }],
        },
      ],
    })
    const r = gate([bad], baseline)
    expect(r.ok).toBe(false)
    expect(r.failures.map((f) => f.kind)).toContain('invariant')

    const bad2 = fake('a/b', {
      passed: false,
      expectations: [{ key: 'first_tool', ok: false, detail: '不是 get_order' }],
    })
    expect(gate([bad2], baseline).failures.map((f) => f.kind)).toContain('expectation')
  })

  it('attachDelta 写出与基线的 delta', () => {
    const r = attachDelta(fake('a/b'), baseline, 5)
    expect(r.delta?.adoption_rate).toEqual({
      baseline: 1,
      current: 1,
      change_pct: 0,
      regressed: false,
    })
  })

  it('toBaseline 按场景 id 与指标名排序（diff 可读）', () => {
    const b = toBaseline([fake('b/x'), fake('a/b')], '2026-09-07T00:00:00.000Z')
    expect(Object.keys(b.scenarios)).toEqual(['a/b', 'b/x'])
    expect(Object.keys(b.scenarios['a/b']?.metrics ?? {})).toEqual([
      'adoption_rate',
      'tokens_per_item',
    ])
  })
})

describe('套件与报告落盘（26 §5）', () => {
  it('对 pack 跑 fast 全部通过并出报告文件', async () => {
    const out = tempDir()
    const result = await runSuite({
      packDir: PACK_DIR,
      scenario: ['scenarios/**/*.yml'],
      reportDir: out,
      seed: 42,
    })
    expect(result.reports).toHaveLength(9)
    expect(result.reports.every((r) => r.passed)).toBe(true)
    expect(result.gate.ok).toBe(true)
    const summary = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8')) as {
      passed: boolean
      scenarios: { id: string }[]
    }
    expect(summary.passed).toBe(true)
    expect(summary.scenarios).toHaveLength(9)
    expect(readFileSync(join(out, 'summary.txt'), 'utf8')).toContain('PASS')
  })

  it('与仓库里提交的基线比，指标没有劣化', async () => {
    const result = await runSuite({ packDir: PACK_DIR, seed: 42 })
    expect(readBaseline(join(PACK_DIR, 'baseline.json'))).toBeDefined()
    expect(result.baseline).toBeDefined()
    expect(result.gate.failures).toEqual([])
    for (const r of result.reports) expect(r.delta, r.id).toBeDefined()
  })

  it('隐藏集用 --scenario-root 单独跑，不在 pack 里', async () => {
    const result = await runSuite({
      packDir: PACK_DIR,
      scenarioRoot: HIDDEN_DIR,
      scenario: ['security/*.yml'],
    })
    expect(result.reports).toHaveLength(2)
    expect(result.reports.every((r) => r.passed)).toBe(true)
    expect(result.reports.map((r) => r.id).sort()).toEqual([
      'hidden/injected-policy-quote',
      'hidden/stranger-claims-order',
    ])
  })

  it('匹配不到场景时报错，而不是"零条全过"', async () => {
    await expect(runSuite({ packDir: PACK_DIR, scenario: ['nope/*.yml'] })).rejects.toThrow(
      /没有匹配到场景/,
    )
  })
})
