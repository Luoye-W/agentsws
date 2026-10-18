/**
 * WP423：模拟包里那条「查资料查到一半预算到了」——四个运行时都再跑一次收尾，交出同一段话：
 * 为什么停 + 已经搜到的来源 + 还差细看第一条 + 接着做。绝不以一句开场白结束。
 */
import { budgetStopReason, WEB_WRAP_UP_MISSING_FETCH, WRAP_UP_STEP } from '@agentsws/stand-ins'
import { describe, expect, it, vi } from 'vitest'
import type { Evidence, RuntimeName } from '../src/index.js'
import { loadScenario, runScenario } from '../src/index.js'
import { PACK_DIR, pack } from './helpers.js'

vi.setConfig({ testTimeout: 600_000, hookTimeout: 600_000 })

const FILE = `${PACK_DIR}/scenarios/content/web-research-budget.yml`
const RUNTIMES: RuntimeName[] = ['stub', 'direct', 'dsh-in-process', 'dsh-subprocess']

async function evidenceOf(runtime: RuntimeName): Promise<{ passed: boolean; evidence: Evidence }> {
  let evidence: Evidence | undefined
  const report = await runScenario(loadScenario(FILE), {
    pack: pack(),
    runtime,
    captureEvidence: (e) => {
      evidence = e
    },
  })
  if (evidence === undefined) throw new Error('没有拿到证据')
  return { passed: report.passed, evidence }
}

describe('WP423 content/web-research-budget × 四个运行时', () => {
  it('预算到了：同一段收尾话（原因 + 已搜到的来源 + 还差什么 + 接着做），状态是预算用完', async () => {
    const answers: Record<string, string> = {}
    for (const runtime of RUNTIMES) {
      const { passed, evidence } = await evidenceOf(runtime)
      expect(passed, runtime).toBe(true)
      const run = evidence.runs.find((r) => r.request.web !== undefined)
      expect(run?.status, runtime).toBe('budget_exhausted')
      expect(
        run?.events.some((e) => e.type === 'progress' && e.step === WRAP_UP_STEP),
        runtime,
      ).toBe(true)
      const answer = run?.result?.outputs.find((o) => o.kind === 'answer')
      const text = answer?.kind === 'answer' ? answer.text : ''
      expect(text.startsWith(budgetStopReason('max_tool_calls')), runtime).toBe(true)
      expect(text, runtime).toContain(WEB_WRAP_UP_MISSING_FETCH)
      expect(text, runtime).toContain('接着做')
      expect(
        [...new Set(text.match(/https:\/\/example\.com\/[0-9a-f]{8}\/\d/g) ?? [])],
        runtime,
      ).toHaveLength(3)
      answers[runtime] = text
    }
    expect(answers.direct).toBe(answers.stub)
    expect(answers['dsh-in-process']).toBe(answers.stub)
    expect(answers['dsh-subprocess']).toBe(answers.stub)
  })
})
