/** WP438：对话里的小报表（genui `ws-report`）——只带报表 id，别的字段（尤其是数）一律不要。 */
import { describe, expect, it } from 'vitest'
import { filterGenuiSpec } from '../src/index.js'

describe('ws-report', () => {
  it('只留 id；模型写进去的数被丢掉（数由宿主按 id 从服务端取）', () => {
    const out = filterGenuiSpec({
      items: [{ type: 'ws-report', id: 'draft_0123456789ab', value: 99999, title: '编的' }],
    })
    expect(out.spec?.items).toEqual([{ type: 'ws-report', id: 'draft_0123456789ab' }])
  })

  it('默认报表 id 也认；乱写的 id 整个不要', () => {
    expect(
      filterGenuiSpec({ items: [{ type: 'ws-report', id: 'web-ops.business' }] }).spec?.items,
    ).toHaveLength(1)
    const bad = filterGenuiSpec({ items: [{ type: 'ws-report', id: '../../etc' }] })
    expect(bad.spec).toBeUndefined()
    expect(bad.dropped).toContain('ws-report')
  })
})
