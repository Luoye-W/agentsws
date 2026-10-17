/**
 * WP387（docs/103 v2 T1）：在用户的 Google 账号里建 / 改提醒——永远人审，形状不对就拦。
 */
import { describe, expect, it } from 'vitest'
import { evaluateGuardrail, HARD_L1, KIND_RISK, Provenance } from '../src/index.js'

const target = { type: 'google_alerts', id: 'ws_t' } as const
const facts = () => {
  const p = new Provenance('run_1')
  p.see([target as never], { full: true })
  return { now: '2026-10-18T09:00:00Z', changeSet: [], windowCount: 0, provenance: p }
}
const line = (id: string, query: string) => ({
  id,
  op: 'create',
  query,
  language: 'en',
  region: 'US',
  label: id,
  group: 'competitor',
  selected: true,
})
const change = (after: Record<string, unknown>) => ({
  kind: 'google_alert_change' as const,
  target,
  before: null,
  after,
})
const rules = (r: { hits: { rule: string; severity: string }[] }, severity: string) =>
  r.hits.filter((h) => h.severity === severity).map((h) => h.rule)

describe('google_alert_change', () => {
  it('永远人审（硬顶）、风险 medium', () => {
    expect(HARD_L1.has('google_alert_change')).toBe(true)
    expect(KIND_RISK.google_alert_change).toBe('medium')
  })

  it('一批好好的：不拦', () => {
    const r = evaluateGuardrail(
      change({ op: 'create', lines: [line('ga_1', '"Aventon" -job'), line('ga_2', '"Lectric"')] }),
      { caps: {} },
      facts(),
      'stage',
    )
    expect(rules(r, 'block')).toEqual([])
  })

  it('一行都没有 / 查询语句是空的 / op 不认识 / 超过一批的上限：拦', () => {
    const empty = evaluateGuardrail(
      change({ op: 'create', lines: [] }),
      { caps: {} },
      facts(),
      'stage',
    )
    expect(rules(empty, 'block')).toContain('google_alert_lines_required')
    const blank = evaluateGuardrail(
      change({ op: 'create', lines: [line('ga_1', '  ')] }),
      { caps: {} },
      facts(),
      'stage',
    )
    expect(rules(blank, 'block')).toContain('google_alert_query_required')
    const op = evaluateGuardrail(
      change({ op: 'delete', lines: [line('ga_1', 'x')] }),
      { caps: {} },
      facts(),
      'stage',
    )
    expect(rules(op, 'block')).toContain('google_alert_op')
    const many = Array.from({ length: 41 }, (_, i) => line(`ga_${i}`, `q${i}`))
    const big = evaluateGuardrail(
      change({ op: 'create', lines: many }),
      { caps: {} },
      facts(),
      'stage',
    )
    expect(rules(big, 'block')).toContain('google_alert_lines_max')
  })
})
