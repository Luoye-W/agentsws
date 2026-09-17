/**
 * WP87：realistic 档的诊断设施。
 *
 * 三件事要钉住：
 * 1. 一条场景抛错只算**这一条**失败（`tolerateScenarioError`），fast 档语义不变；
 * 2. 模型往返摘要里**没有消息正文、没有凭据**，但有"这一轮手上有哪些工具 / 停在哪儿"；
 * 3. 诊断汇总把"为什么没过"写成一句话。
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Completion, ModelMeta } from '@agentsws/contracts'
import type { ModelGatewayApi } from '@agentsws/model-gateway'
import { describe, expect, it } from 'vitest'
import {
  diagnoseScenario,
  errorReport,
  gate,
  loadScenario,
  type ModelTrace,
  maskSecrets,
  runScenario,
  summarizeDiagnostics,
  traceGateway,
  writeEventsJsonl,
  writeModelJsonl,
} from '../src/index.js'
import { PACK_DIR, pack, runPackScenario } from './helpers.js'

const META: ModelMeta = {
  workspace_id: 'ws_t',
  assignment_id: 'asg_t',
  role_id: 'role_t',
  run_id: 'run_t',
  purpose: 'run',
}

/** 只实现 `complete` 的假网关；其余方法这几条用例用不到。 */
function fakeGateway(complete: ModelGatewayApi['complete']): ModelGatewayApi {
  return { complete } as unknown as ModelGatewayApi
}

describe('WP87 一条场景错不再让整次运行停', () => {
  it('tolerateScenarioError 打开时，抛错记成 expected.scenario_error，报告照出', async () => {
    // `$last_outbound_draft` 指向一张还不存在的卡 → runner 抛 SimulationError('not_found')
    const scenario = loadScenario(`${PACK_DIR}/scenarios/aftersales/return-within-window.yml`)
    const broken = {
      ...scenario,
      id: 'test/decide-before-any-draft',
      // 把来信事件拿掉，只留下"批那张不存在的草稿"
      events: scenario.events.filter((e) => e.type === 'actor.decide'),
    }
    expect(broken.events.length).toBeGreaterThan(0)

    await expect(runScenario(broken, { pack: pack() })).rejects.toThrow()

    const report = await runScenario(broken, { pack: pack(), tolerateScenarioError: true })
    expect(report.passed).toBe(false)
    const err = report.expectations.find((e) => e.key === 'scenario_error')
    expect(err?.ok).toBe(false)
    expect(err?.detail).toContain('not_found')
    // 门禁把它当一条没过的断言
    expect(gate([report], undefined).ok).toBe(false)
  })

  it('errorReport 是连报告都没出来时的兜底，同样进门禁', () => {
    const scenario = loadScenario(`${PACK_DIR}/scenarios/aftersales/return-within-window.yml`)
    const report = errorReport({
      scenario,
      tier: 'realistic',
      seed: 42,
      runtime: 'dsh-subprocess',
      error: Object.assign(new Error('起世界失败 sk-abcdefghijkl'), { code: 'internal' }),
    })
    expect(report.passed).toBe(false)
    expect(report.expectations[0]?.key).toBe('scenario_error')
    // 凭据遮罩：兜底报告里也不许出现 key
    expect(JSON.stringify(report)).not.toContain('sk-abcdefghijkl')
    expect(gate([report], undefined).failures[0]?.kind).toBe('expectation')
  })
})

describe('WP87 模型往返摘要：只有形状，没有正文与凭据', () => {
  it('记下工具清单、tool_calls 名字、停法与 usage；正文一个字都不进', async () => {
    const trace: ModelTrace = { records: [] }
    const secret = '客户的真实地址：Baker Street 12'
    const gateway = traceGateway(
      fakeGateway(
        async (): Promise<Completion> => ({
          text: '',
          tool_calls: [{ id: 'c1', name: 'get_order', input: { order_id: 'ord_1001' } }],
          reasoning: '先查订单',
          usage: { input_tokens: 100, output_tokens: 20, cached_tokens: 64, cost_base: 0.5 },
          model: { provider: 'deepseek', model: 'deepseek-flash' },
          static_prefix_hash: 'h',
        }),
      ),
      trace,
    )
    await gateway.complete({
      messages: [
        { role: 'system', content: 'you are support' },
        { role: 'user', content: secret },
        { role: 'assistant', content: '', tool_calls: [{ id: 'c0', name: 'x', input: {} }] },
        { role: 'assistant', content: '', reasoning: '上一轮的推理' },
      ],
      tools: [{ name: 'get_order', description: 'read an order', input_schema: {} }],
      meta: META,
      max_cost_base: 2,
    })

    const rec = trace.records[0]
    expect(rec?.request.roles).toEqual({ system: 1, user: 1, assistant: 2 })
    expect(rec?.request.tools).toEqual(['get_order'])
    expect(rec?.request.carried_tool_calls).toBe(1)
    expect(rec?.request.carried_reasoning).toBe(1)
    expect(rec?.response?.tool_calls).toEqual(['get_order'])
    expect(rec?.response?.stop).toBe('tool_calls')
    expect(rec?.response?.usage.cost_base).toBe(0.5)
    expect(JSON.stringify(rec)).not.toContain('Baker Street')
  })

  it('上游报错也记一条，且把 key 遮掉', async () => {
    const trace: ModelTrace = { records: [] }
    const gateway = traceGateway(
      fakeGateway(async () => {
        throw Object.assign(
          new Error('provider http 400: {"error":"bad key sk-sp-0123456789abcdef"}'),
          { code: 'provider_unavailable' },
        )
      }),
      trace,
    )
    await expect(
      gateway.complete({ messages: [{ role: 'user', content: 'hi' }], meta: META }),
    ).rejects.toThrow()
    const rec = trace.records[0]
    expect(rec?.error?.code).toBe('provider_unavailable')
    expect(rec?.error?.message).toContain('provider http 400')
    expect(rec?.error?.message).not.toContain('sk-sp-0123456789abcdef')
    expect(rec?.error?.message).toContain('sk-***')
  })

  it('maskSecrets 遮 sk- 开头的 key 与 Bearer 头', () => {
    expect(maskSecrets('Authorization: Bearer abcdef0123456789')).toBe('Authorization: Bearer ***')
    expect(maskSecrets('key=sk-sp-abcdefghijkl 结束')).toBe('key=sk-*** 结束')
  })
})

describe('WP87 落盘与汇总', () => {
  it('events.jsonl 第一行是摘要，之后是运行与事件；model.jsonl 一次往返一行', async () => {
    const { report, evidence } = await runPackScenario('aftersales/return-within-window.yml')
    const dir = mkdtempSync(join(tmpdir(), 'wp87-'))
    const eventsFile = writeEventsJsonl(dir, report.id, evidence)
    const rows = readFileSync(eventsFile, 'utf8')
      .trimEnd()
      .split('\n')
      .map((l) => JSON.parse(l) as { kind: string; type?: string })
    expect(rows[0]?.kind).toBe('summary')
    expect(rows.some((r) => r.kind === 'run')).toBe(true)
    expect(rows.some((r) => r.kind === 'event' && r.type === 'tool.call')).toBe(true)

    const trace: ModelTrace = { records: [] }
    const modelFile = writeModelJsonl(dir, report.id, trace.records)
    expect(readFileSync(modelFile, 'utf8')).toBe('')
  })

  it('诊断汇总把失败原因写成一句话，并把调用次数与 token 加起来', async () => {
    const { report } = await runPackScenario('aftersales/return-within-window.yml')
    const row = diagnoseScenario({
      report,
      records: [
        {
          seq: 1,
          at: '2026-09-07T01:00:00.000Z',
          run_id: 'r1',
          purpose: 'run',
          assignment_id: 'a1',
          request: {
            messages: 3,
            roles: { system: 2, user: 1 },
            content_chars: 100,
            tools: ['get_order'],
            carried_tool_calls: 0,
            carried_reasoning: 0,
          },
          response: {
            text_chars: 0,
            reasoning_chars: 10,
            tool_calls: ['get_order'],
            stop: 'tool_calls',
            usage: { input_tokens: 100, output_tokens: 20, cached_tokens: 0, cost_base: 0.25 },
            duration_ms: 5,
          },
        },
      ],
    })
    expect(row.model_calls).toBe(1)
    expect(row.tools_called).toEqual(['get_order'])
    expect(row.stops).toEqual({ tool_calls: 1 })
    const total = summarizeDiagnostics([row]).total
    expect(total.model_calls).toBe(1)
    expect(total.input_tokens).toBe(100)
    expect(total.cost_base).toBe(0.25)
  })
})
