/**
 * 升级前后对比（WP41 第 4 步 / `docs/42` 的"对比"环节）。
 *
 * 这里**不跑场景**，只读两份采集好的基线 JSON——采集是
 * `test/upgrade-baseline/capture.mjs` 的事（它才需要 `@agentsws/simulation`，
 * 而且是用相对路径 import `dist`，不进包的依赖图：dsh-adapter ↔ simulation 的
 * devDependency 环（38 §1）不会因为这个文件长回来）。
 *
 * 断言的口径就是 17 §4「任一红 = 不升级」在**场景级**的展开：
 * 事件类型序列相同、六条不变量全绿、`tokens_per_item` 偏差 ≤ 5%、两档 dsh 仍然逐条相等。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/** 升级前后的两版。换版本时改这两行 + 采一份新基线。 */
const FROM = '0.1.3-alpha.2'
const TO = '0.1.5-rc.1'

/** `tokens_per_item` 允许的偏差（%）。超了就说明提示词或工具集实质变了。 */
const MAX_TOKEN_DRIFT_PCT = 5

const RUNTIMES = ['dsh-in-process', 'dsh-subprocess'] as const
type RuntimeKey = (typeof RUNTIMES)[number]

const INVARIANTS = [
  'no_write_without_stage',
  'apply_only_after_approved',
  'provenance_respected',
  'fencing_covers_external',
  'prompt_replayable',
  'freeze_on_model_outage',
] as const

interface ScenarioFingerprint {
  passed: boolean
  /** `type@at`：事件类型 + 合成时钟时刻。 */
  events: string[]
  invariants: Record<string, boolean>
  expectations: Record<string, boolean>
  metrics: Record<string, number>
  summaries: (string | null)[]
  counts: Record<string, number>
}

interface Baseline {
  schema_version: number
  dsh_version: string
  packages: Record<string, string | null>
  pack: string
  runtimes: Record<RuntimeKey, Record<string, ScenarioFingerprint>>
}

function load(version: string): Baseline {
  const file = fileURLToPath(new URL(`./upgrade-baseline/${version}.json`, import.meta.url))
  return JSON.parse(readFileSync(file, 'utf8')) as Baseline
}

const before = load(FROM)
const after = load(TO)

/** 事件类型序列（把 `@at` 切掉）。 */
const types = (fp: ScenarioFingerprint): string[] =>
  fp.events.map((e) => e.slice(0, e.indexOf('@')))

interface Pair {
  runtime: RuntimeKey
  id: string
  a: ScenarioFingerprint
  b: ScenarioFingerprint
}

/** 每条运行时 × 场景走一遍的入口。 */
function each(): Pair[] {
  const out: Pair[] = []
  for (const runtime of RUNTIMES) {
    for (const id of Object.keys(before.runtimes[runtime]).sort()) {
      const a = before.runtimes[runtime][id]
      const b = after.runtimes[runtime][id]
      if (a === undefined || b === undefined) continue
      out.push({ runtime, id, a, b })
    }
  }
  return out
}

describe('升级基线：两份都在，说的是同一件事', () => {
  it('版本号对得上', () => {
    expect(before.dsh_version).toBe(FROM)
    expect(after.dsh_version).toBe(TO)
  })

  it('同一个 pack、同一批场景、同一批运行时', () => {
    expect(after.pack).toBe(before.pack)
    for (const runtime of RUNTIMES) {
      expect(Object.keys(after.runtimes[runtime]).sort()).toEqual(
        Object.keys(before.runtimes[runtime]).sort(),
      )
    }
    // 场景一条都没少（pack 现在 13 条）
    expect(Object.keys(before.runtimes['dsh-in-process']).length).toBeGreaterThanOrEqual(13)
  })

  it(`升级后装的确实是 ${TO}`, () => {
    for (const [name, version] of Object.entries(after.packages)) {
      if (version === null) continue
      if (name === '@deepseek-ai/cordis') {
        // cordis 是 dsh vendored 出来的独立包，不随 dsh 的版本走（34 §核实）
        expect(version).toBe(before.packages[name])
        continue
      }
      expect(version).toBe(TO)
    }
  })
})

describe(`升级 ${FROM} → ${TO}：行为不变`, () => {
  for (const { runtime, id, a, b } of each()) {
    describe(`${runtime} ${id}`, () => {
      it('事件类型序列相同', () => {
        expect(types(b)).toEqual(types(a))
      })

      it('事件时刻也相同（合成时钟没被上游推着走）', () => {
        expect(b.events).toEqual(a.events)
      })

      it('六条不变量全绿，且逐条与升级前相同', () => {
        for (const [name, ok] of Object.entries(b.invariants)) {
          expect(INVARIANTS).toContain(name)
          expect(ok, `${id} ${name}`).toBe(true)
        }
        expect(b.invariants).toEqual(a.invariants)
      })

      it('场景断言逐条相同且全绿', () => {
        for (const [key, ok] of Object.entries(b.expectations)) {
          expect(ok, `${id} expected.${key}`).toBe(true)
        }
        expect(b.expectations).toEqual(a.expectations)
      })

      it(`tokens_per_item 偏差 ≤ ${MAX_TOKEN_DRIFT_PCT}%`, () => {
        const from = a.metrics.tokens_per_item ?? 0
        const to = b.metrics.tokens_per_item ?? 0
        if (from === 0) {
          // 没打过模型的场景（预算耗尽 / 空跑）：升级后也必须还是 0
          expect(to).toBe(0)
          return
        }
        const drift = Math.abs((to - from) / from) * 100
        expect(drift, `${id} tokens_per_item ${from} → ${to}`).toBeLessThanOrEqual(
          MAX_TOKEN_DRIFT_PCT,
        )
      })

      it('运行摘要（人话那句）没变', () => {
        expect(b.summaries).toEqual(a.summaries)
      })
    })
  }
})

describe(`${TO}：两档 dsh 仍然逐条相等（换宿主进程不换语义）`, () => {
  for (const id of Object.keys(after.runtimes['dsh-in-process']).sort()) {
    it(`${id}：事件、指标、摘要三样都相同`, () => {
      const inProcess = after.runtimes['dsh-in-process'][id]
      const subprocess = after.runtimes['dsh-subprocess'][id]
      expect(subprocess).toBeDefined()
      if (inProcess === undefined || subprocess === undefined) return
      expect(subprocess.events).toEqual(inProcess.events)
      expect(subprocess.metrics).toEqual(inProcess.metrics)
      expect(subprocess.summaries).toEqual(inProcess.summaries)
      expect(subprocess.invariants).toEqual(inProcess.invariants)
    })
  }
})
