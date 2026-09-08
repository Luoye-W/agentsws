/**
 * 端到端：同一条场景在 dsh 运行时下跑通，六条不变量全绿（WP11 完成标准）。
 *
 * 用的是 `packages/simulation` 的真 runner、真 pack、真交易控制模块——
 * 只把 `runtime` 从 `stub` 换成 `dsh`。换得掉，就证明运行时是可替换的（31 I6）。
 */
import { fileURLToPath } from 'node:url'
import type { Evidence, Pack, ScenarioReport } from '@agentsws/simulation'
import { loadPack, loadScenario, runScenario } from '@agentsws/simulation'
import { describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const PACK_DIR = `${ROOT}packs/dtc-3c-3p`

let cached: Pack | undefined
const pack = (): Pack => {
  if (cached === undefined) cached = loadPack(PACK_DIR)
  return cached
}

async function run(
  path: string,
  runtime: 'stub' | 'dsh',
): Promise<{ report: ScenarioReport; evidence: Evidence }> {
  const scenario = loadScenario(`${PACK_DIR}/scenarios/${path}`)
  let evidence: Evidence | undefined
  const report = await runScenario(scenario, {
    pack: pack(),
    runtime,
    captureEvidence: (e) => {
      evidence = e
    },
  })
  if (evidence === undefined) throw new Error('没有拿到证据')
  // 换的确实是运行时：每次运行的 session_ref 都说 dsh（空跑会在这里露馅）
  expect(evidence.runs.length).toBeGreaterThan(0)
  for (const record of evidence.runs) {
    expect(record.result?.session_ref.runtime).toBe(runtime)
  }
  return { report, evidence }
}

const failures = (report: ScenarioReport): string[] =>
  report.invariants
    .filter((i) => !i.ok)
    .map((i) => `${i.name}: ${i.violations.map((v) => v.message).join(' / ')}`)

describe('端到端：aftersales/return-within-window（dsh 运行时）', () => {
  it('六条不变量全绿', async () => {
    const { report } = await run('aftersales/return-within-window.yml', 'dsh')
    expect(failures(report)).toEqual([])
    expect(report.invariants).toHaveLength(6)
    // 每条都真的检查了对象，不是空跑
    expect(report.invariants.every((i) => i.checked > 0)).toBe(true)
  }, 120_000)

  it('该做的事都做了：先查单、staged 一笔退款、回信引用了退货窗口', async () => {
    const { report } = await run('aftersales/return-within-window.yml', 'dsh')
    const byKey = new Map(report.expectations.map((e) => [e.key, e]))
    for (const key of [
      'calls_tool',
      'first_tool',
      'never_calls',
      'staged_change_kinds',
      'reply_includes_any',
      'reply_omits',
    ]) {
      expect(`${key}:${byKey.get(key)?.ok}`).toBe(`${key}:true`)
    }
  }, 120_000)
})

describe('端到端：security/injected-instruction（dsh 运行时）', () => {
  it('六条不变量全绿', async () => {
    const { report } = await run('security/injected-instruction.yml', 'dsh')
    expect(failures(report)).toEqual([])
  }, 120_000)

  it('毒样本：模型碰不到写工具，关系授权门禁挡下变更', async () => {
    const { report } = await run('security/injected-instruction.yml', 'dsh')
    const byKey = new Map(report.expectations.map((e) => [e.key, e]))
    expect(byKey.get('never_calls')?.ok).toBe(true)
    expect(byKey.get('staged_change_kinds')?.ok).toBe(true)
    expect(byKey.get('blocked_rules')?.ok).toBe(true)
  }, 120_000)
})
