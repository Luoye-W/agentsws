/**
 * WP30 D：**同一批场景，四个运行时各跑一遍**。
 *
 * `stub` / `direct` / `dsh(in-process)` / `dsh(subprocess)` 走的是同一份 pack、
 * 同一份不变量检查、同一套证据来源。全过 = 17 §4「运行时可替换」在场景级别成立
 * （31 §1 I6）。dsh 两档还要**逐条相等**：换宿主进程不换语义。
 *
 * 这里也是 dsh 场景级端到端的新家——以前它在 `packages/dsh-adapter/test/e2e.test.ts` 里，
 * 那条 import 让 dsh-adapter 反向依赖 simulation，构成 devDependency 环（38 §1）。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Evidence, RuntimeName, ScenarioReport } from '../src/index.js'
import { findScenarios, loadScenario, runScenario } from '../src/index.js'
import { PACK_DIR, pack } from './helpers.js'

// 子进程档每条场景要起好几个 node 进程
vi.setConfig({ testTimeout: 600_000, hookTimeout: 600_000 })

const INVARIANTS = [
  'no_write_without_stage',
  'apply_only_after_approved',
  'provenance_respected',
  'fencing_covers_external',
  'prompt_replayable',
  'freeze_on_model_outage',
] as const

const RUNTIMES: RuntimeName[] = ['stub', 'direct', 'dsh-in-process', 'dsh-subprocess']

async function run(
  rel: string,
  runtime: RuntimeName,
): Promise<{ report: ScenarioReport; evidence: Evidence }> {
  const scenario = loadScenario(rel.startsWith('/') ? rel : `${PACK_DIR}/scenarios/${rel}`)
  let evidence: Evidence | undefined
  const report = await runScenario(scenario, {
    pack: pack(),
    runtime,
    captureEvidence: (e) => {
      evidence = e
    },
  })
  if (evidence === undefined) throw new Error('没有拿到证据')
  return { report, evidence }
}

/** pack 里全部场景（现在 9 条；加了新场景自动纳入矩阵）。 */
const ALL = findScenarios(PACK_DIR, ['scenarios/**/*.yml']).sort()

describe('WP30：同一批场景 × 四个运行时', () => {
  it('场景一条都没少', () => {
    expect(ALL.length).toBeGreaterThanOrEqual(9)
  })

  for (const runtime of RUNTIMES) {
    it(`${runtime}：全部场景通过，六条不变量全绿`, async () => {
      const failures: string[] = []
      for (const file of ALL) {
        const { report } = await run(file, runtime)
        // 每条场景自己声明要检哪几条不变量；名字必须在这六条之内
        expect(report.invariants.length).toBeGreaterThan(0)
        for (const inv of report.invariants) expect(INVARIANTS).toContain(inv.name)
        for (const inv of report.invariants) {
          if (!inv.ok) {
            failures.push(
              `${report.id} ${inv.name}: ${inv.violations.map((v) => v.message).join('|')}`,
            )
          }
        }
        for (const exp of report.expectations) {
          if (!exp.ok) failures.push(`${report.id} expected.${exp.key}: ${exp.detail}`)
        }
        expect(report.runtime).toBe(runtime)
      }
      expect(failures).toEqual([])
    })
  }
})

describe('WP30 A：dsh 两档（进程内 / 子进程）逐条一致', () => {
  it('事件序列、产物、指标完全相同——换宿主进程不换语义', async () => {
    for (const rel of [
      'aftersales/return-within-window.yml',
      'aftersales/boundary-first-time.yml',
      'security/injected-instruction.yml',
    ]) {
      const inProcess = await run(rel, 'dsh-in-process')
      const subprocess = await run(rel, 'dsh-subprocess')
      const fingerprint = (e: Evidence): string[] =>
        e.events.filter((x) => x.correlation.run_id !== undefined).map((x) => `${x.type}@${x.at}`)
      expect(fingerprint(subprocess.evidence)).toEqual(fingerprint(inProcess.evidence))
      expect(subprocess.evidence.runs.map((r) => r.result?.summary)).toEqual(
        inProcess.evidence.runs.map((r) => r.result?.summary),
      )
      expect(subprocess.report.metrics).toEqual(inProcess.report.metrics)
      // 换的确实是运行时：每次运行都说自己是 dsh
      for (const record of subprocess.evidence.runs) {
        expect(record.result?.session_ref.runtime).toBe('dsh')
      }
    }
  })
})

describe('WP30 C：边界提问在三个运行时下都出那张卡（36 §2.2）', () => {
  for (const runtime of RUNTIMES) {
    it(`${runtime}：boundary-first-time 出一张 policy_change 选择题卡且不提变更`, async () => {
      const { evidence } = await run('aftersales/boundary-first-time.yml', runtime)
      const cards = evidence.approvals.filter((a) => a.kind === 'policy_change')
      expect(cards).toHaveLength(1)
      expect(cards[0]?.dedupe_key).toBe('ws_dtc3c:policy_change:policy.lost_package_liability')
      expect((cards[0]?.options ?? []).length).toBeGreaterThan(1)
      // 不自作主张：一条变更都没提
      expect(evidence.changes).toHaveLength(0)
      // 17 §3：摘要是一句人话，而且把"问了口径"说出来了
      const summary = evidence.runs[0]?.result?.summary ?? ''
      expect(summary).toContain('物流丢件赔付')
      expect(summary).not.toMatch(/次工具调用/)
    })
  }
})

describe('WP30 C：事项摘要是一句人话（17 §3）', () => {
  for (const runtime of RUNTIMES) {
    it(`${runtime}：退货窗口内的摘要写清了查了什么、挂了什么`, async () => {
      const { evidence } = await run('aftersales/return-within-window.yml', runtime)
      const summary = evidence.runs[0]?.result?.summary ?? ''
      expect(summary).toContain('订单 #')
      expect(summary).toContain('起草了回复')
      expect(summary).toMatch(/挂了一笔 .* 的退款待批/)
      expect(summary).not.toMatch(/^(stub|dsh|direct-llm) 运行/)
    })
  }
})
