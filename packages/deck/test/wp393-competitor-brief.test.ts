/**
 * WP393（docs/104 一期 A，docs/96 P3）：店铺管理日报里的「竞品动向」——有才出，没有就不出。
 */
import { describe, expect, it } from 'vitest'
import { computeBlock } from '../src/index.js'
import type { TableResult } from '../src/types.js'
import { INVENTORY, queryContext } from './fixtures.js'

const rowsOf = (data: unknown): Record<string, string | number>[] =>
  (data as TableResult).rows ?? []

describe('WP393 日报「竞品动向」', () => {
  it('没有那一段：日报还是原来五行', () => {
    const ctx = queryContext({ role_id: 'dtc.store', inventory: INVENTORY })
    const rows = rowsOf(computeBlock('store.daily_report', ctx, 'yesterday').payload)
    expect(rows).toHaveLength(5)
  })

  it('有要紧的变化、有一家没读到：段名只写一次，一条一句', () => {
    const ctx = {
      ...queryContext({ role_id: 'dtc.store', inventory: INVENTORY }),
      competitor: {
        title: '竞品动向',
        lines: ['Aventon · Level 3：降价12%（$1,799 → $1,599），比你的 Ranger 便宜 $200'],
        failed: ['Cyrusher 这次没读到'],
      },
    }
    const rows = rowsOf(computeBlock('store.daily_report', ctx, 'yesterday').payload).slice(5)
    expect(rows).toEqual([
      {
        item: '竞品动向',
        value: 'Aventon · Level 3：降价12%（$1,799 → $1,599），比你的 Ranger 便宜 $200',
      },
      { item: '', value: 'Cyrusher 这次没读到' },
    ])
  })

  it('只有一家没读到：段名挂在那一行上', () => {
    const ctx = {
      ...queryContext({ role_id: 'dtc.store', inventory: INVENTORY }),
      competitor: { title: '竞品动向', lines: [], failed: ['Cyrusher 这次没读到'] },
    }
    const rows = rowsOf(computeBlock('store.daily_report', ctx, 'yesterday').payload).slice(5)
    expect(rows).toEqual([{ item: '竞品动向', value: 'Cyrusher 这次没读到' }])
  })
})
