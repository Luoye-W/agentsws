/**
 * WP32 三档（26 §4）：fast 之外的 realistic 与 soak，以及 judge、15 / 50 人 pack。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Evidence } from '../src/evidence.js'
import { judgeConfigOf, runRuleJudge } from '../src/judge.js'
import { loadPack } from '../src/pack.js'
import { CostGuard, RealisticCache, resolveSimModel, SIM_MODEL_ENV } from '../src/realistic.js'
import { runScenario } from '../src/runner.js'
import { loadScenario } from '../src/scenario/parse.js'
import { buildSoakScenario, runSoak, sparkline } from '../src/soak.js'
import { runSuite } from '../src/suite.js'
import { synth } from '../src/synth.js'
import { PACK_DIR, pack, REPO_ROOT } from './helpers.js'

const temps: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentsws-wp32-'))
  temps.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

const PACK_15 = join(REPO_ROOT, 'packs', 'dtc-15p')

// ── realistic 档 ──────────────────────────────────────────────────────────

describe('realistic 档（26 §4）', () => {
  it('没有 key 就整档跳过，且**不是失败**', async () => {
    const result = await runSuite({
      packDir: PACK_DIR,
      tier: 'realistic',
      seed: 42,
      env: {},
    })
    expect(result.skipped).toContain('key')
    expect(result.gate.ok).toBe(true)
    expect(result.reports).toHaveLength(0)
  })

  it('key 只从环境变量取：DEEPSEEK_API_KEY 与自定义变量名都认', () => {
    expect(resolveSimModel({})).toBeUndefined()
    // 空串不算有 key
    expect(resolveSimModel({ DEEPSEEK_API_KEY: '   ' })).toBeUndefined()

    const deepseek = resolveSimModel({ DEEPSEEK_API_KEY: 'sk-fake' })
    expect(deepseek?.ref.provider).toBe('deepseek')
    expect(deepseek?.prices['deepseek/deepseek-chat']).toBeDefined()
    // 报告里写的是"key 来自哪个环境变量"，**不是 key 本身**
    expect(deepseek?.describe).toContain('DEEPSEEK_API_KEY')
    expect(deepseek?.describe).not.toContain('sk-fake')

    const custom = resolveSimModel({
      [SIM_MODEL_ENV.key]: 'sk-fake',
      [SIM_MODEL_ENV.provider]: 'openai',
      [SIM_MODEL_ENV.model]: 'gpt-4o-mini',
      [SIM_MODEL_ENV.baseUrl]: 'https://example.invalid/v1',
      [SIM_MODEL_ENV.priceIn]: '1.5',
    })
    expect(custom?.ref.model).toBe('gpt-4o-mini')
    expect(custom?.prices['openai/gpt-4o-mini']?.in).toBe(1.5)
    expect(custom?.describe).toContain('https://example.invalid/v1')
  })

  it('来信缓存：第一次写盘，第二次回放（同 seed 内容固定）', () => {
    const dir = join(tempDir(), 'realistic-cache')
    const cache = new RealisticCache(dir)
    const key = RealisticCache.keyOf(['dtc-3c-3p', 'aftersales/x', 0, 42, 'anna@example.com', 'hi'])
    expect(cache.get(key)).toBeUndefined()
    cache.put(key, 'Hello, order #1001')
    expect(cache.writes).toBe(1)

    // 换一个进程（新对象、只有盘上那份）也读得回来
    const again = new RealisticCache(dir)
    expect(again.get(key)).toBe('Hello, order #1001')
    expect(again.hits).toBe(1)
  })

  it('预算闸门：花超了就说自己花超了', () => {
    const guard = new CostGuard(1)
    expect(guard.exhausted).toBe(false)
    guard.add(0.4)
    expect(guard.remaining).toBeCloseTo(0.6)
    guard.add(0.7)
    expect(guard.exhausted).toBe(true)
    expect(guard.remaining).toBe(0)
  })

  it('没给真模型时 realistic 档退化成确定性 provider，报告仍然完整', async () => {
    const scenario = loadScenario(
      join(PACK_DIR, 'scenarios', 'aftersales', 'return-within-window.yml'),
    )
    const report = await runScenario(scenario, { tier: 'realistic', pack: pack() })
    expect(report.tier).toBe('realistic')
    expect(report.passed).toBe(true)
    expect(report.judge?.rule.total).toBeGreaterThan(0)
  })
})

// ── judge ────────────────────────────────────────────────────────────────

describe('judge（26 §1）', () => {
  it('pack 的 judge/*.md：frontmatter 是规则配置，正文是模型 rubric', () => {
    const { config, rubric, ref } = judgeConfigOf(pack().judges)
    expect(ref).toBe('judge/aftersales-reply.md')
    expect(config.banned).toContain('补偿')
    expect(config.require_any).toContain('order')
    expect(rubric).toContain('只输出一个 JSON 对象')
  })

  it('规则 judge 抓得住：禁用词、没施行就说已退款、没引事实卡、驳回没写原因', () => {
    const evidence = fakeEvidence({
      body: 'Hi,\n\nWe have refunded your 补偿 already.\n\nKind regards',
      citations: [],
      applied: false,
      injectedFactCard: true,
      rejectWithoutReason: true,
    })
    const result = runRuleJudge(evidence, { banned: ['补偿'], require_any: ['order'] })
    const failed = new Set(result.checks.filter((c) => !c.ok).map((c) => c.id))
    expect(failed).toContain('tone') // 出现了"补偿"
    expect(failed).toContain('no_overreach') // 没施行却说已经退了
    expect(failed).toContain('cites_facts') // 注入过事实卡却一张没引
    expect(failed).toContain('require_any') // 一次没提订单
    expect(failed).toContain('decision_reason') // 驳回没写原因
    expect(result.score).toBeLessThan(0.5)
  })

  it('规则 judge 放得过：正常的一封回信满分', () => {
    const evidence = fakeEvidence({
      body: 'Hi Anna,\n\nAbout order #1001 — a colleague will confirm the refund.\n\nKind regards',
      citations: [{ fact_card_id: 'fc_1', quote: 'returns within 14 days' }],
      applied: false,
      injectedFactCard: true,
      rejectWithoutReason: false,
    })
    const result = runRuleJudge(evidence, { banned: ['补偿'], require_any: ['order'] })
    expect(result.checks.filter((c) => !c.ok)).toEqual([])
    expect(result.score).toBe(1)
  })

  it('没有可评对象时不倒扣（score = 1，total = 0）', () => {
    const result = runRuleJudge(fakeEvidence({ body: '', drafts: 0 }))
    expect(result.total).toBe(0)
    expect(result.score).toBe(1)
  })
})

// ── soak 档 ──────────────────────────────────────────────────────────────

describe('soak 档（26 §4）', () => {
  it('同 seed 摊出来的是同一段人生（事件逐条相同）', () => {
    const a = buildSoakScenario({ pack: pack(), days: 3, seed: 42 })
    const b = buildSoakScenario({ pack: pack(), days: 3, seed: 42 })
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events))
    const c = buildSoakScenario({ pack: pack(), days: 3, seed: 7 })
    expect(JSON.stringify(c.events)).not.toBe(JSON.stringify(a.events))
    // 事件按虚拟时间递增（合成时钟不回拨）
    const times = a.events.map((e) => Date.parse(e.at))
    expect(times).toEqual([...times].sort((x, y) => x - y))
    // 三样演练至少各来一次
    const types = new Set(a.events.map((e) => e.type))
    expect(types).toContain('inject.fault')
    expect(types).toContain('model.outage')
    expect(types).toContain('process.restart')
    expect(types).toContain('reconcile.run')
  })

  it('连着两天：不变量全绿、队列不涨、预占收口、日志有上界、重启后链还完整', async () => {
    const dir = tempDir()
    const report = await runSoak({ packDir: PACK_DIR, days: 2, seed: 42, reportDir: dir })
    expect(report.passed).toBe(true)
    expect(report.per_day).toHaveLength(2)
    expect(report.invariants.every((i) => i.ok)).toBe(true)
    for (const day of report.per_day) {
      expect(day.ok, `day ${day.day}: ${day.problems.join('；')}`).toBe(true)
      expect(day.unknown_changes).toBe(0)
    }
    expect(report.db_bytes).toBeGreaterThan(0)
    expect(report.db_bytes).toBeLessThanOrEqual(report.db_bytes_cap)
    // 重启演练真的跑过，而且日志没丢没断链（runner 在链断时会直接抛）
    const restarted = report.scenario.counts.events
    expect(restarted).toBeGreaterThan(0)
    // 报告两份都落了盘
    expect(statSync(join(dir, 'soak.json')).size).toBeGreaterThan(0)
    const md = readFileSync(join(dir, 'soak.md'), 'utf8')
    expect(md).toContain('## 按天')
    expect(md).toContain('日终队列曲线')
  }, 120_000)

  it('曲线是一行字符，不用开图表库', () => {
    expect(sparkline([])).toBe('')
    expect(sparkline([0, 0, 0])).toBe('▁▁▁')
    expect(sparkline([0, 5, 10])).toBe('▁▅█')
  })
})

// ── 更大的合成公司 ────────────────────────────────────────────────────────

describe('15 / 50 人 pack（26 §2 / 27）', () => {
  it('15 人 pack：4 个岗位含投放与运营、2 家店、自带两份职责定义', () => {
    const p = loadPack(PACK_15)
    expect(p.people).toHaveLength(15)
    expect(p.roles.map((r) => r.id).sort()).toEqual(['ads.performance', 'dtc.ops'])
    const roleIds = new Set(p.assignments.map((a) => a.role_id))
    expect(roleIds).toContain('dtc.aftersales')
    expect(roleIds).toContain('dtc.ops')
    expect(roleIds).toContain('ads.performance')
    expect(roleIds).toContain('common.owner')
    const stores = new Set(p.assignments.flatMap((a) => a.ranges.map((r) => r.id)))
    expect(stores).toEqual(new Set(['store_main', 'store_eu']))
    // 升级链第一级换了个人（3 人公司里没有这个人）
    expect(p.people.find((x) => x.scope_manager === true)?.id).toBe('p_li')
  })

  it('15 人 pack 的八条场景在 fast 档全过', async () => {
    const result = await runSuite({ packDir: PACK_15, seed: 42 })
    expect(result.reports.map((r) => r.id).sort()).toEqual([
      'ops/claim-pool',
      'ops/collision-two-people',
      'ops/cross-desk-handover',
      'ops/multi-desk-concurrency',
      'ops/two-desks-no-union',
      // WP39 秘书 Agent（41 §1）
      'secretary/ask-colleague',
      'secretary/meet-conflict',
      'secretary/route-to-desk',
    ])
    for (const r of result.reports) {
      expect(
        r.passed,
        `${r.id}: ${r.expectations
          .filter((e) => !e.ok)
          .map((e) => e.detail)
          .join('；')}`,
      ).toBe(true)
    }
    expect(result.gate.ok).toBe(true)
  }, 120_000)

  it('50 人 pack：`synth --size 50` 能生成，且一条烟测场景在 fast 档跑得通（不进门禁）', async () => {
    const dir = join(tempDir(), 'dtc-50p')
    const out = synth({ size: 50, seed: 42, out: dir })
    expect(out.files.has('roles/dtc.ops.yml')).toBe(true)
    const p = loadPack(dir)
    expect(p.people).toHaveLength(50)
    expect(p.orders.length).toBe(300)

    // 烟测场景不随 pack 发布（50 人档不进门禁，26 §4），临时写一条进去
    mkdirSync(join(dir, 'scenarios', 'smoke'), { recursive: true })
    writeFileSync(join(dir, 'scenarios', 'smoke', 'return-within-window.yml'), SMOKE_50, 'utf8')
    const result = await runSuite({ packDir: dir, seed: 42, writeBaselineIfMissing: false })
    expect(result.reports).toHaveLength(1)
    expect(result.reports[0]?.passed).toBe(true)
  }, 180_000)
})

const SMOKE_50 = `id: smoke/return-within-window
version: 1
dataset: { pack: dtc-50p, seed: 42 }
actors:
  p_chen:
    approve: { policy: always_approve, latency: 10m..30m }
  p_wang:
    approve: { policy: always_approve, latency: 10m..30m }
stand_ins: { provider: mock_open_connector, model: stub, clock: virtual, delivery: inbox }
clock: { start: '2026-09-07T09:00:00+08:00' }
events:
  - at: '+0m'
    inbound.email:
      from: anna@example.com
      thread: new
      subject: Return request for #1001
      body_ref: fixtures/anna-return.txt
  - at: '+4h'
    clock.advance: {}
expected:
  staged_change_kinds: [refund]
  metrics:
    runs_failed: 0
    applied_changes: 1
invariants:
  - no_write_without_stage
  - apply_only_after_approved
  - provenance_respected
  - fencing_covers_external
  - prompt_replayable
`

// ── 造证据 ───────────────────────────────────────────────────────────────

interface FakeInput {
  body: string
  citations?: { fact_card_id: string; quote: string }[]
  applied?: boolean
  injectedFactCard?: boolean
  rejectWithoutReason?: boolean
  drafts?: number
}

/** judge 只读审批项与事件，所以造一份最小的证据就够钉住它的判断。 */
function fakeEvidence(input: FakeInput): Evidence {
  const drafts = input.drafts ?? 1
  const approvals = Array.from({ length: drafts }, (_, i) => ({
    id: `apr_${i + 1}`,
    kind: 'outbound_draft',
    payload: { body: { subject: 'Re: order #1001', text: input.body } },
    evidence: {
      citations: input.citations ?? [],
      source_events: [],
      provenance: { seen: [] },
      precheck: {},
    },
  })) as unknown as Evidence['approvals']

  const events: Evidence['events'] = []
  if (input.applied === true) {
    events.push({
      id: 'ev_applied',
      at: '2026-09-07T10:00:00.000Z',
      schema_version: 1,
      workspace_id: 'ws_dtc3c',
      type: 'change.applied',
      actor: { kind: 'system', id: 'x' },
      correlation: { trace_id: 'tr_1' },
      payload: {},
    } as Evidence['events'][number])
  }
  if (input.rejectWithoutReason === true) {
    events.push({
      id: 'ev_rejected',
      at: '2026-09-07T11:00:00.000Z',
      schema_version: 1,
      workspace_id: 'ws_dtc3c',
      type: 'approval.decided',
      actor: { kind: 'person', id: 'p_wang' },
      subject: { type: 'approval_item', id: 'apr_1' },
      correlation: { trace_id: 'tr_2' },
      payload: { action: 'reject' },
    } as Evidence['events'][number])
  }

  return {
    workspace_id: 'ws_dtc3c',
    start: '2026-09-07T09:00:00.000Z',
    end: '2026-09-07T12:00:00.000Z',
    events,
    runs:
      input.injectedFactCard === true
        ? ([{ request: { context: [{ kind: 'fact_card' }] } }] as unknown as Evidence['runs'])
        : [],
    inbound: [],
    observations: [],
    cards: [],
    emails: [],
    approvals,
    changes: [],
    outages: [],
    notifications: [],
    blocked: [],
    sampling_reviews: [],
    assignments: [],
  }
}
