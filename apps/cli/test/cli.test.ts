import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildProgram, main } from '../src/index.js'

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const PACK_DIR = join(REPO_ROOT, 'packs', 'dtc-3c-3p')
const HIDDEN_DIR = join(REPO_ROOT, 'packages', 'simulation', 'hidden')

const temps: string[] = []
const tempDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'agentsws-cli-'))
  temps.push(d)
  return d
}
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true })
})

let out: string[] = []
const write = (s: string): void => {
  out.push(s)
}
const text = (): string => out.join('')

beforeEach(() => {
  out = []
  process.exitCode = undefined
})
afterEach(() => {
  process.exitCode = undefined
})

const run = async (...args: string[]): Promise<void> => {
  await buildProgram(write).parseAsync(['node', 'agentsws', ...args])
}

describe('agentsws simulate（26 §5）', () => {
  it('对 pack 跑 fast 全部通过并出报告文件，退出码 0', async () => {
    const report = tempDir()
    await run(
      'simulate',
      '--tier',
      'fast',
      '--pack',
      PACK_DIR,
      '--scenario',
      'scenarios/**/*.yml',
      '--seed',
      '42',
      '--report',
      report,
    )
    expect(text()).toContain('14/14 场景通过')
    expect(text()).toContain('合并门禁：通过')
    expect(process.exitCode).toBeUndefined()
    expect(existsSync(join(report, 'summary.json'))).toBe(true)
    const summary = JSON.parse(readFileSync(join(report, 'summary.json'), 'utf8')) as {
      passed: boolean
      scenarios: unknown[]
    }
    expect(summary.passed).toBe(true)
    expect(summary.scenarios).toHaveLength(14)
    expect(existsSync(join(report, 'aftersales__return-within-window.json'))).toBe(true)
  }, 60_000)

  it('指标劣化阈值收到 0 且拿一份假基线比 → 门禁红，退出码 1', async () => {
    const dir = tempDir()
    const baseline = join(dir, 'baseline.json')
    // 假基线：把 tokens_per_item 压到 1，任何真实值都算劣化
    const fake = {
      schema_version: 1,
      generated_at: '2026-09-07T00:00:00.000Z',
      scenarios: {
        'ops/model-outage': { metrics: { tokens_per_item: 1 } },
      },
    }
    const { writeFileSync } = await import('node:fs')
    writeFileSync(baseline, JSON.stringify(fake), 'utf8')
    await run(
      'simulate',
      '--pack',
      PACK_DIR,
      '--scenario',
      'scenarios/ops/model-outage.yml',
      '--baseline',
      baseline,
      '--max-regression-pct',
      '5',
    )
    expect(text()).toContain('合并门禁：不通过')
    expect(text()).toContain('regression')
    expect(process.exitCode).toBe(1)
  }, 30_000)

  it('隐藏集用 --scenario-root 跑（不随 pack 发布）', async () => {
    await run(
      'simulate',
      '--pack',
      PACK_DIR,
      '--scenario-root',
      HIDDEN_DIR,
      '--scenario',
      'security/*.yml',
    )
    expect(text()).toContain('2/2 场景通过')
    expect(text()).toContain('hidden/stranger-claims-order')
  }, 30_000)

  it('未知运行档报错，退出码 1', async () => {
    await main(['node', 'agentsws', 'simulate', '--tier', 'turbo', '--pack', PACK_DIR])
    expect(process.exitCode).toBe(1)
  })

  it('匹配不到场景 → 退出码 1，不是"零条全过"', async () => {
    await main(['node', 'agentsws', 'simulate', '--pack', PACK_DIR, '--scenario', 'nope/*.yml'])
    expect(process.exitCode).toBe(1)
  })
})

describe('agentsws synth', () => {
  it('生成一个 pack，文件列表按路径排序', async () => {
    const dir = tempDir()
    await run(
      'synth',
      '--pack',
      'dtc-3c',
      '--people',
      '3',
      '--orders',
      '10',
      '--seed',
      '42',
      '--out',
      dir,
    )
    expect(text()).toContain('生成 25 个文件')
    expect(existsSync(join(dir, 'manifest.yml'))).toBe(true)
    expect(existsSync(join(dir, 'store', 'orders.yml'))).toBe(true)
    expect(text().indexOf('  README.md')).toBeLessThan(text().indexOf('  workspace.yml'))
  })

  it('非法参数报错，退出码 1', async () => {
    await main(['node', 'agentsws', 'synth', '--orders', '1', '--out', tempDir()])
    expect(process.exitCode).toBe(1)
  })
})

describe('agentsws replay', () => {
  it('从事件日志重组 prompt 并比对；不给 run_id 就列出全部', async () => {
    const dir = tempDir()
    const db = join(dir, 'events.db')
    const { loadPack, loadScenario, runScenario } = await import('@agentsws/simulation')
    const pack = loadPack(PACK_DIR)
    const scenario = loadScenario(
      join(PACK_DIR, 'scenarios', 'aftersales', 'return-within-window.yml'),
    )
    await runScenario(scenario, { pack, dbPath: db })

    await run('replay', '--db', db)
    expect(text()).toContain('2 次运行')
    const first = text().match(/run_\S+/)?.[0] as string

    out = []
    await run('replay', first, '--db', db)
    expect(text()).toContain('OK')
    expect(text()).toContain('prompt.assembled.hash')
    expect(process.exitCode).toBeUndefined()
  }, 30_000)

  it('数据库里没有这次运行 → 退出码 1', async () => {
    const dir = tempDir()
    const db = join(dir, 'events.db')
    const { loadPack, loadScenario, runScenario } = await import('@agentsws/simulation')
    const scenario = loadScenario(join(PACK_DIR, 'scenarios', 'ops', 'model-outage.yml'))
    await runScenario(scenario, { pack: loadPack(PACK_DIR), dbPath: db })
    await main(['node', 'agentsws', 'replay', 'run_nope', '--db', db])
    expect(process.exitCode).toBe(1)
  }, 30_000)
})
