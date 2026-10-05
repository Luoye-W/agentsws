/**
 * WP234（docs/54 §6.2）：第 ③ 步「你的岗位」那块板的三条规则。
 */
import { describe, expect, it } from 'vitest'
import {
  addRow,
  deselectDuty,
  EMPTY_BOARD,
  moveDuty,
  planOf,
  rearrange,
  removeRow,
  renameRow,
  selectDuty,
  tooMany,
} from '@/lib/position-board'

const CATALOG = [
  { id: 'customer-care', name: '客服', roles: [{ id: 'dtc.support' }, { id: 'amz.support' }] },
  { id: 'web-ops', name: '网站运营', roles: [{ id: 'dtc.store' }] },
  { id: 'social-media', name: '社媒运营', roles: [{ id: 'social.reddit' }] },
  { id: 'pr', name: '公共关系', roles: [{ id: 'pr.reddit' }] },
]

describe('WP234 你的岗位', () => {
  it('没动过手：每选一条整块按建议重排（同渠道跨类别并成一个）', () => {
    let b = selectDuty(EMPTY_BOARD, 'pr.reddit', CATALOG)
    b = selectDuty(b, 'social.reddit', CATALOG)
    expect(planOf(b)).toEqual([{ name: 'Reddit 运营', role_ids: ['social.reddit', 'pr.reddit'] }])
    b = selectDuty(b, 'dtc.store', CATALOG)
    expect(planOf(b).map((p) => p.name)).toEqual(['网站运营', 'Reddit 运营'])
  })

  it('AI 给了划分就按它（只留选中的），剩下的走算法', () => {
    const suggested = [{ name: '全能', role_ids: ['dtc.store', 'dtc.support', 'x.y'] }]
    let b = selectDuty(EMPTY_BOARD, 'dtc.store', CATALOG, suggested)
    b = selectDuty(b, 'amz.support', CATALOG, suggested)
    expect(planOf(b)).toEqual([
      { name: '全能', role_ids: ['dtc.store'] },
      { name: '客服', role_ids: ['amz.support'], template_id: 'customer-care' },
    ])
  })

  it('动过手：再选的只往同类别那一行加，没有就新开一行；不再整块重排', () => {
    let b = selectDuty(EMPTY_BOARD, 'dtc.support', CATALOG)
    b = renameRow(b, b.rows[0]?.key ?? '', '售后')
    b = selectDuty(b, 'amz.support', CATALOG)
    b = selectDuty(b, 'dtc.store', CATALOG)
    expect(planOf(b)).toEqual([
      { name: '售后', role_ids: ['dtc.support', 'amz.support'], template_id: 'customer-care' },
      { name: '网站运营', role_ids: ['dtc.store'], template_id: 'web-ops' },
    ])
    // 去掉一条：系统开的行变空就收掉
    b = deselectDuty(b, 'dtc.store', CATALOG)
    expect(b.rows.map((r) => r.name)).toEqual(['售后'])
    // 「按建议重新分」回到算法版
    expect(planOf(rearrange(b, CATALOG))[0]?.name).toBe('客服')
  })

  it('新建的空行变空了也留着，自己点删才删；有职责的删不掉', () => {
    let b = selectDuty(EMPTY_BOARD, 'dtc.support', CATALOG)
    b = addRow(b, '新岗位')
    const fresh = b.rows[1]?.key ?? ''
    b = moveDuty(b, 'dtc.support', fresh)
    expect(b.rows.map((r) => r.role_ids.length)).toEqual([0, 1])
    expect(removeRow(b, fresh)).toBe(b)
    b = removeRow(b, b.rows[0]?.key ?? '')
    expect(planOf(b)).toEqual([{ name: '新岗位', role_ids: ['dtc.support'] }])
  })

  it('超过 6 条建议拆；空名字交上去叫「我的岗位」', () => {
    expect(tooMany({ key: 'r', name: 'x', role_ids: ['1', '2', '3', '4', '5', '6', '7'] })).toBe(
      true,
    )
    expect(tooMany({ key: 'r', name: 'x', role_ids: ['1', '2', '3', '4', '5', '6'] })).toBe(false)
    let b = selectDuty(EMPTY_BOARD, 'dtc.store', CATALOG)
    b = renameRow(b, b.rows[0]?.key ?? '', '  ')
    expect(planOf(b)[0]?.name).toBe('我的岗位')
  })
})
