/**
 * WP487（决策 1678）：SEO 表格里那两列「证据」改叫「依据」（放的是凭什么建议改的数字，英文 Basis）。
 * 卡上的「证据」WP486 已经改叫「详情」——这两列不是能点开的详情，所以单独叫「依据」。
 */
import { describe, expect, it } from 'vitest'
import { ALL_DATA_SOURCES, type QueryContext, runQuery, SOURCE_LABELS } from '../src/index.js'

const ctx: QueryContext = {
  now: '2026-10-23T09:00:00.000Z',
  tz_offset_minutes: 480,
  base_currency: 'USD',
  role_id: 'dtc.seo',
  position_id: 'asg_1',
  orders: [],
  approvals: [],
  sources: ALL_DATA_SOURCES.map((id) => ({ id, label: SOURCE_LABELS[id], connected: true })),
}

const labelsOf = (name: string): string[] => {
  const out = runQuery(name, ctx, 'last_7d')
  if (out.status !== 'ok') throw new Error(`${name} 没跑出来`)
  return (out.data as { columns: { label: string }[] }).columns.map((c) => c.label)
}

describe('WP487 决策 1678：「证据」→「依据」', () => {
  it('「今天值得动的 5 件事」与技术体检两张表都叫「依据」，不再有「证据」', () => {
    for (const name of ['seo.today', 'site.tech_audit']) {
      expect(labelsOf(name)).toContain('依据')
      expect(labelsOf(name)).not.toContain('证据')
    }
  })
})
