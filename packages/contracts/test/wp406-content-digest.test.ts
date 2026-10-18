/** WP406：岗位更新契约里的两个小函数——ISO 周、公司模式谁能点。 */
import { describe, expect, it } from 'vitest'
import {
  CONTENT_ITEM_KINDS,
  canApplyContentUpdates,
  contentChoiceKey,
  isoWeekOf,
} from '../src/index.js'

describe('WP406 岗位更新契约', () => {
  it('种类只加：老的三种还在，新加四种', () => {
    expect(CONTENT_ITEM_KINDS.slice(0, 3)).toEqual(['skill', 'role', 'declarative'])
    expect(CONTENT_ITEM_KINDS).toEqual(
      expect.arrayContaining(['role_content', 'position_content', 'rules', 'knowledge']),
    )
  })

  it('ISO 周：周一开始，跨年按周四所在的那一年', () => {
    expect(isoWeekOf('2026-10-19T00:00:00.000Z')).toBe('2026-W43')
    expect(isoWeekOf('2026-10-25T23:59:59.000Z')).toBe('2026-W43')
    expect(isoWeekOf('2026-10-26T00:00:00.000Z')).toBe('2026-W44')
    expect(isoWeekOf('2021-01-03T12:00:00.000Z')).toBe('2020-W53')
    expect(isoWeekOf('2024-12-30T12:00:00.000Z')).toBe('2025-W01')
  })

  it('公司模式只有品牌负责人与这个岗位的负责人能点；个人 / 同事模式本人说了算', () => {
    const base = { person_id: 'per_a', position_supervisor: 'per_sup' }
    expect(canApplyContentUpdates({ ...base, company: false, is_owner: false }).ok).toBe(true)
    expect(canApplyContentUpdates({ ...base, company: true, is_owner: true }).ok).toBe(true)
    expect(
      canApplyContentUpdates({ ...base, person_id: 'per_sup', company: true, is_owner: false }).ok,
    ).toBe(true)
    const no = canApplyContentUpdates({ ...base, company: true, is_owner: false })
    expect(no).toEqual({ ok: false, reason: '有更新，等负责人看' })
    expect(contentChoiceKey('rules:x', 'row.a')).toBe('rules:x#row.a')
  })
})
