/**
 * WP511（决策 1547，docs/115 §4 第 5 条）：小结 / 记忆离线评测的框架在替身下跑通——四层（真的那条路：段内压缩、
 * 话题小结、读附件、翻旧账）与不压缩全量对照，出召回 / 误记 / token / 估费。替身不花钱、确定；真模型只由
 * `scripts/eval-assistant-context.mjs` 在估费点头之后跑。
 */
import { describe, expect, it } from 'vitest'
import {
  type EvalRun,
  estimateCost,
  fullHistoryTokens,
  runFull,
  runLayers,
  scoreAnswer,
  summarizeRun,
} from '../src/assistant-eval.js'
import { evalScenarios } from '../src/assistant-eval-scenarios.js'

describe('WP511 助理上下文评测（替身）', () => {
  it('打分：答对看期望，误记 = 说了不该记的而且没答对', () => {
    const p = {
      id: 'x',
      at: '',
      ask: '',
      keys: [],
      expect: ['15 天'],
      forbid: ['30 天'],
      kind: 'superseded' as const,
    }
    expect(scoreAnswer(p, '现在是 15天（之前是 30 天）')).toEqual({ correct: true, wrong: false })
    expect(scoreAnswer(p, '30 天')).toEqual({ correct: false, wrong: true })
    expect(scoreAnswer(p, '不知道')).toEqual({ correct: false, wrong: false })
  })

  it('三条合成长对话：四层与全量都跑得通，压缩真的发生，附件深处的数靠「读附件」取回；出估费', async () => {
    const scenarios = evalScenarios({ seed: 42 })
    const runs: EvalRun[] = []
    for (const s of scenarios) {
      runs.push(await runLayers(s))
      runs.push(await runFull(s))
    }
    const rows = runs.map(summarizeRun)
    // 全量是上限参照：替身在全量里全对
    for (const r of rows.filter((x) => x.mode === 'full')) expect(r.recall).toBe(1)
    const layers = rows.filter((x) => x.mode === 'layers')
    // 话题小结与段内压缩都真的发生了（默认 6K 窗口、每天 24 句填充）
    expect(layers.every((r) => r.summary_calls > 0 && r.compactions > 0)).toBe(true)
    // 管道回归：信息都还留在上下文里或取得回来（替身答对 = 没在压缩 / 卸载里丢）
    for (const r of layers) expect(r.recall).toBe(1)
    expect(layers.every((r) => r.cache_ratio > 0.5)).toBe(true)
    const notes = runs.find((r) => r.scenario === 'meeting-notes' && r.mode === 'layers')
    expect(notes?.probes.find((p) => p.id === 'deposit')?.correct).toBe(true)
    const flash = estimateCost(runs, 'deepseek-flash')
    const pro = estimateCost(runs, 'deepseek-v4-pro')
    expect(flash.usd).toBeGreaterThan(0)
    expect(pro.usd).toBeGreaterThan(flash.usd)
    // 全量每轮都发的话：最后一轮带着整段历史
    const full = fullHistoryTokens(scenarios[0] as (typeof scenarios)[number])
    expect(full.last_turn_tokens).toBeGreaterThan(0)
    expect(full.cached_tokens).toBeLessThan(full.input_tokens)
  })
})
