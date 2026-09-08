import { describe, expect, it } from 'vitest'
import {
  globToRegExp,
  loadScenario,
  matchNumeric,
  parseDuration,
  parseRange,
  parseScenario,
  resolveAt,
  ScenarioSchemaError,
} from '../src/index.js'
import { PACK_DIR } from './helpers.js'

const MINIMAL = `
id: t/minimal
version: 1
dataset: { pack: dtc-3c-3p, seed: 42 }
actors:
  p_wang: { approve: { policy: edit_30pct, latency: '2h..8h', reject_rules: ['contains:补偿'] } }
stand_ins: { provider: mock_open_connector, model: stub, clock: virtual, delivery: inbox }
clock: { start: '2026-09-07T09:00:00+08:00' }
events:
  - at: '+0m'
    inbound.email: { from: anna@example.com, thread: new, body: hello }
  - at: '+65m'
    actor.decide: { who: p_wang, item: $last_outbound_draft, action: approve }
invariants: [prompt_replayable]
`

describe('场景 DSL 解析（26 §1）', () => {
  it('解析 26 §1 的形状，$ 引用原样留到运行时解析', () => {
    const s = parseScenario(MINIMAL, 't.yml')
    expect(s.id).toBe('t/minimal')
    expect(s.dataset).toEqual({ pack: 'dtc-3c-3p', seed: 42 })
    expect(s.clock.start).toBe('2026-09-07T01:00:00.000Z')
    expect(s.actors.p_wang?.policy).toBe('edit_30pct')
    expect(s.actors.p_wang?.reject_rules).toEqual(['contains:补偿'])
    expect(s.events[0]).toMatchObject({ type: 'inbound.email', at: '+0m' })
    expect(s.events[1]).toMatchObject({
      type: 'actor.decide',
      decide: { item: '$last_outbound_draft', action: 'approve' },
    })
    expect(s.invariants).toEqual(['prompt_replayable'])
    expect(s.source).toBe('t.yml')
  })

  it('pack 自带的六条场景全部能解析', () => {
    for (const rel of [
      'aftersales/return-within-window',
      'aftersales/return-outside-window',
      'security/injected-instruction',
      'security/injected-instruction-control',
      'ops/model-outage',
      'ops/budget-exhausted',
    ]) {
      const s = loadScenario(`${PACK_DIR}/scenarios/${rel}.yml`)
      expect(s.id).toBe(rel)
      expect(s.invariants).toHaveLength(6)
    }
  })

  it('rubric 解析但不跑（唯一主观键）', () => {
    const s = loadScenario(`${PACK_DIR}/scenarios/aftersales/return-within-window.yml`)
    expect(s.rubric).toBeDefined()
  })

  it('未知字段报错并指到字段路径', () => {
    expect(() => parseScenario(`${MINIMAL}\nwhoops: 1\n`, 'x.yml')).toThrow(ScenarioSchemaError)
    expect(() => parseScenario(`${MINIMAL}\nwhoops: 1\n`, 'x.yml')).toThrow(/whoops/)
  })

  it('expected 里拼错的键不会被静默忽略', () => {
    const bad = `${MINIMAL}\nexpected: { calls_toool: [get_order] }\n`
    expect(() => parseScenario(bad, 'x.yml')).toThrow(/calls_toool/)
  })

  it('缺必填字段报错', () => {
    expect(() => parseScenario('id: t\nversion: 1\n', 'x.yml')).toThrow(/dataset/)
    expect(() => parseScenario(MINIMAL.replace('version: 1', 'version: 2'), 'x.yml')).toThrow(
      /version/,
    )
  })

  it('未知不变量名报错（打错一个名字等于悄悄关掉一条断言）', () => {
    expect(() => parseScenario(MINIMAL.replace('prompt_replayable', 'nope'), 'x.yml')).toThrow(
      /nope/,
    )
  })

  it('事件必须且只能带一个动作键', () => {
    const two = MINIMAL.replace(
      '    inbound.email: { from: anna@example.com, thread: new, body: hello }',
      '    inbound.email: { from: a@b.c, thread: new, body: h }\n    clock.advance: {}',
    )
    expect(() => parseScenario(two, 'x.yml')).toThrow(/只能带一个动作键/)
  })

  it('inbound.email 的 body 与 body_ref 至少给一个', () => {
    const none = MINIMAL.replace(', body: hello', '')
    expect(() => parseScenario(none, 'x.yml')).toThrow(/body_ref 与 body/)
  })

  it('非法时长在解析期就报错', () => {
    expect(() => parseScenario(MINIMAL.replace("'2h..8h'", "'8h..2h'"), 'x.yml')).toThrow(
      /max < min/,
    )
    expect(() => parseScenario(MINIMAL.replace("'2h..8h'", "'2 hours'"), 'x.yml')).toThrow()
  })

  it('metrics 只接受数值或比较式', () => {
    const ok = `${MINIMAL}\nexpected: { metrics: { adoption_rate: '>=0.6', guardrail_hits: 0 } }\n`
    expect(parseScenario(ok, 'x.yml').expected.metrics).toEqual({
      adoption_rate: '>=0.6',
      guardrail_hits: 0,
    })
    const bad = `${MINIMAL}\nexpected: { metrics: { adoption_rate: high } }\n`
    expect(() => parseScenario(bad, 'x.yml')).toThrow(/比较式/)
  })
})

describe('时长与时刻', () => {
  it('parseDuration / parseRange', () => {
    expect(parseDuration('65m')).toBe(3_900_000)
    expect(parseDuration('2h')).toBe(7_200_000)
    expect(parseDuration('1d')).toBe(86_400_000)
    expect(parseDuration('500ms')).toBe(500)
    expect(parseRange('2h..8h')).toEqual({ min: 7_200_000, max: 28_800_000 })
    expect(parseRange('30m')).toEqual({ min: 1_800_000, max: 1_800_000 })
    expect(() => parseDuration('nope')).toThrow()
  })

  it('resolveAt 支持相对偏移与绝对时刻', () => {
    const start = '2026-09-07T01:00:00.000Z'
    expect(resolveAt('+65m', start)).toBe('2026-09-07T02:05:00.000Z')
    expect(resolveAt('2026-09-08T00:00:00Z', start)).toBe('2026-09-08T00:00:00.000Z')
    expect(() => resolveAt('yesterday', start)).toThrow()
  })
})

describe('断言比较式与 glob', () => {
  it('matchNumeric', () => {
    expect(matchNumeric(0.7, '>=0.6')).toBe(true)
    expect(matchNumeric(0.5, '>=0.6')).toBe(false)
    expect(matchNumeric(10, '<=20000')).toBe(true)
    expect(matchNumeric(1, 1)).toBe(true)
    expect(matchNumeric(1, 2)).toBe(false)
    expect(matchNumeric(3, '>2')).toBe(true)
    expect(matchNumeric(3, '<2')).toBe(false)
    expect(matchNumeric(3, '==3')).toBe(true)
  })

  it('globToRegExp', () => {
    const re = globToRegExp('scenarios/**/*.yml')
    expect(re.test('scenarios/ops/model-outage.yml')).toBe(true)
    expect(re.test('scenarios/a.yml')).toBe(true)
    expect(re.test('other/a.yml')).toBe(false)
    expect(globToRegExp('security/*.yml').test('security/x.yml')).toBe(true)
    expect(globToRegExp('security/*.yml').test('security/a/x.yml')).toBe(false)
  })
})
