import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Evidence } from '../src/index.js'
import {
  checkExpectations,
  computeMetrics,
  draftsProposed,
  loadPack,
  loadScenario,
  parseFrontmatter,
  repliesSent,
  runScenario,
  synth,
  toolsCalled,
} from '../src/index.js'
import { PACK_DIR, pack, runPackScenario } from './helpers.js'

const temps: string[] = []
const tempDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'agentsws-pack-'))
  temps.push(d)
  return d
}
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true })
})

async function base(): Promise<Evidence> {
  const { evidence } = await runPackScenario('aftersales/return-within-window.yml')
  return evidence
}

describe('结构化断言（26 §1 expected）', () => {
  it('工具序列、草稿正文、发出的回信都能取到', async () => {
    const evidence = await base()
    expect(toolsCalled(evidence)).toEqual([
      'get_order',
      'search_policies',
      'get_order',
      'search_policies',
    ])
    expect(draftsProposed(evidence).length).toBe(2)
    expect(repliesSent(evidence).length).toBe(2)
  })

  it('calls_tool / first_tool / never_calls / max_tool_calls', async () => {
    const evidence = await base()
    const metrics = computeMetrics(evidence)
    const ok = checkExpectations(
      {
        calls_tool: ['get_order', 'search_policies'],
        first_tool: 'get_order',
        never_calls: ['create_refund'],
        max_tool_calls: 8,
      },
      evidence,
      metrics,
    )
    expect(ok.every((e) => e.ok)).toBe(true)

    const bad = checkExpectations(
      {
        calls_tool: ['list_orders'],
        first_tool: 'search_policies',
        never_calls: ['get_order'],
        max_tool_calls: 1,
      },
      evidence,
      metrics,
    )
    expect(bad.map((e) => [e.key, e.ok])).toEqual([
      ['calls_tool', false],
      ['first_tool', false],
      ['never_calls', false],
      ['max_tool_calls', false],
    ])
  })

  it('staged_change_kinds 是集合相等，不是包含', async () => {
    const evidence = await base()
    const metrics = computeMetrics(evidence)
    expect(checkExpectations({ staged_change_kinds: ['refund'] }, evidence, metrics)[0]?.ok).toBe(
      true,
    )
    expect(checkExpectations({ staged_change_kinds: [] }, evidence, metrics)[0]?.ok).toBe(false)
    expect(
      checkExpectations({ staged_change_kinds: ['refund', 'reship'] }, evidence, metrics)[0]?.ok,
    ).toBe(false)
  })

  it('approval_items 的 count 与 children', async () => {
    const evidence = await base()
    const metrics = computeMetrics(evidence)
    const ok = checkExpectations(
      { approval_items: { kind: 'outbound_draft', count: 2, children: ['staged_change'] } },
      evidence,
      metrics,
    )
    expect(ok[0]?.ok).toBe(true)
    const bad = checkExpectations(
      { approval_items: { kind: 'outbound_draft', count: 1, children: ['knowledge_update'] } },
      evidence,
      metrics,
    )
    expect(bad[0]?.ok).toBe(false)
    expect(bad[0]?.detail).toContain('children 缺')
  })

  it('reply_omits / reply_includes_any 断言措辞白名单，不逐字比对', async () => {
    const evidence = await base()
    const metrics = computeMetrics(evidence)
    expect(checkExpectations({ reply_omits: ['补偿'] }, evidence, metrics)[0]?.ok).toBe(true)
    expect(checkExpectations({ reply_omits: ['refund'] }, evidence, metrics)[0]?.ok).toBe(false)
    expect(
      checkExpectations({ reply_includes_any: ['14 days', '14 天'] }, evidence, metrics)[0]?.ok,
    ).toBe(true)
    expect(checkExpectations({ reply_includes_any: ['nope'] }, evidence, metrics)[0]?.ok).toBe(
      false,
    )
  })

  it('no_applied_changes_before：施行早于批准就红', async () => {
    const evidence = await base()
    const metrics = computeMetrics(evidence)
    expect(
      checkExpectations({ no_applied_changes_before: '$approve' }, evidence, metrics)[0]?.ok,
    ).toBe(true)
    const broken = structuredClone(evidence)
    for (const e of broken.events) {
      if (e.type === 'change.applied') e.at = '2000-01-01T00:00:00.000Z'
    }
    expect(
      checkExpectations({ no_applied_changes_before: '$approve' }, broken, metrics)[0]?.ok,
    ).toBe(false)
  })

  it('metrics 断言不认识的指标名直接判红（不是静默跳过）', async () => {
    const evidence = await base()
    const metrics = computeMetrics(evidence)
    const r = checkExpectations({ metrics: { nope: 1 } }, evidence, metrics)
    expect(r[0]?.ok).toBe(false)
    expect(r[0]?.detail).toContain('没有这个指标')
  })

  it('memory_contains / run_failed_codes / notifications_to / blocked_rules', async () => {
    const { evidence } = await runPackScenario('ops/budget-exhausted.yml')
    const metrics = computeMetrics(evidence)
    expect(
      checkExpectations({ run_failed_codes: ['budget_exhausted'] }, evidence, metrics)[0]?.ok,
    ).toBe(true)
    expect(checkExpectations({ run_failed_codes: ['halted'] }, evidence, metrics)[0]?.ok).toBe(
      false,
    )
    expect(checkExpectations({ notifications_to: ['p_wang'] }, evidence, metrics)[0]?.ok).toBe(true)
    expect(checkExpectations({ notifications_to: ['p_li'] }, evidence, metrics)[0]?.ok).toBe(false)
    expect(checkExpectations({ memory_contains: [] }, evidence, metrics)[0]?.ok).toBe(true)
    expect(checkExpectations({ memory_contains: ['x'] }, evidence, metrics)[0]?.ok).toBe(false)
    const poison = await runPackScenario('security/injected-instruction.yml')
    const pm = computeMetrics(poison.evidence)
    expect(
      checkExpectations({ blocked_rules: ['authorization_check'] }, poison.evidence, pm)[0]?.ok,
    ).toBe(true)
    expect(checkExpectations({ blocked_rules: ['sod'] }, poison.evidence, pm)[0]?.ok).toBe(false)
  })
})

describe('pack 加载（26 §2）', () => {
  it('目录 / 文件缺失时明确报错', () => {
    expect(() => loadPack(join(tempDir(), 'nope'))).toThrow(/不存在/)
    expect(() => loadPack(tempDir())).toThrow(/缺文件/)
  })

  it('线程文件缺 id → 报错', () => {
    const dir = tempDir()
    synth({ out: dir })
    writeFileSync(join(dir, 'threads', 'broken.yml'), 'subject: x\n', 'utf8')
    expect(() => loadPack(dir)).toThrow(/缺 id/)
  })

  it('parseFrontmatter 读知识层与主题键', () => {
    const { meta, body } = parseFrontmatter('---\nlayer: fact\ndomain: knowledge\n---\n# T\n正文\n')
    expect(meta).toEqual({ layer: 'fact', domain: 'knowledge' })
    expect(body).toBe('# T\n正文\n')
    expect(parseFrontmatter('# no front').meta).toEqual({})
  })

  it('pack 的策略层额度进 EffectiveConfig（Role 默认 → WorkspacePolicy 覆盖）', async () => {
    const p = loadPack(PACK_DIR)
    // 职责默认 50，pack 的 policy.yml 覆盖成 60
    expect(p.policy.mandates.stage_refund?.caps?.max_auto_refund_amount).toBe(60)
    const { evidence } = await runPackScenario('aftersales/return-within-window.yml')
    const item = evidence.runs[0]?.request.context.find((c) => c.kind === 'policy')
    expect(item).toBeDefined()
    const content = (item?.content ?? {}) as { refund_caps?: Record<string, unknown> }
    expect(content.refund_caps).toMatchObject({ max_auto_refund_amount: 60 })
  })
})

describe('运行档', () => {
  it('v1 只实现 fast，其余明确拒绝而不是假装跑了', async () => {
    const scenario = loadScenario(join(PACK_DIR, 'scenarios', 'ops', 'model-outage.yml'))
    await expect(runScenario(scenario, { tier: 'realistic', pack: pack() })).rejects.toThrow(
      /只实现了 fast/,
    )
    await expect(runScenario(scenario, { tier: 'soak', pack: pack() })).rejects.toThrow()
  })
})
