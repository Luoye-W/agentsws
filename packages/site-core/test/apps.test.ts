/**
 * WP77（59 §2）：App 目录。
 *
 * 两条要紧的：店里装了个我们不认识的 App **也要列出来**（看不见比看得见危险）；
 * 装上了却还没连 API 的那几条要指得出来（59 §2「与连接目录待增加卡的对应」）。
 */
import { CONNECTION_DIRECTORY } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  appConfigAfter,
  appInstallAfter,
  appInventory,
  pendingConnections,
  SHOP_APP_CATALOG,
  shopApp,
} from '../src/index.js'

describe('App 目录（59 §2）', () => {
  it('目录里每条的 directory_kind 都在连接目录里真有一行——对不上的接缝等于没有', () => {
    const kinds = new Set(CONNECTION_DIRECTORY.map((e) => e.kind))
    for (const app of SHOP_APP_CATALOG) {
      if (app.directory_kind === undefined) continue
      expect(kinds.has(app.directory_kind), `${app.id} → ${app.directory_kind}`).toBe(true)
    }
    expect(new Set(SHOP_APP_CATALOG.map((a) => a.id)).size).toBe(SHOP_APP_CATALOG.length)
    expect(shopApp('judge-me')?.category).toBe('reviews')
    expect(shopApp('没这个')).toBeUndefined()
  })

  it('目录里有、店里没装 = 可以装；店里装了、目录里没有 = 照样列出来并给一句提醒', () => {
    const rows = appInventory({
      installed: [{ id: 'judge-me' }, { id: 'mystery-popup', name: '某弹窗' }],
    })
    const judge = rows.find((r) => r.id === 'judge-me')
    expect(judge).toMatchObject({ installed: true, known: true })
    expect(rows.find((r) => r.id === 'klaviyo')).toMatchObject({ installed: false, known: true })
    const mystery = rows.find((r) => r.id === 'mystery-popup')
    expect(mystery).toMatchObject({ installed: true, known: false, connectable: false })
    expect(mystery?.caution?.zh).toContain('不在我们的目录里')
  })

  it('装上了但那张"待增加"的卡还没连 —— pendingConnections 指得出来', () => {
    const rows = appInventory({ installed: [{ id: 'judge-me' }, { id: 'aftership' }] })
    expect(pendingConnections(rows).map((r) => r.id)).toEqual(['judge-me', 'aftership'])

    const connected = appInventory({
      installed: [{ id: 'judge-me' }, { id: 'aftership' }],
      connected_kinds: ['reviews'],
    })
    expect(pendingConnections(connected).map((r) => r.id)).toEqual(['aftership'])
  })

  it('没装的 App 不算"待连接"——还没装就提醒去连，等于让人连一个不存在的东西', () => {
    const rows = appInventory({ installed: [] })
    expect(pendingConnections(rows)).toEqual([])
  })

  it('appInstallAfter 带 operation 与目录里那几格；不认识的 App 只带 id 与 operation', () => {
    expect(
      appInstallAfter({ app_id: 'judge-me', operation: 'install', reason: '要收评价' }),
    ).toEqual({
      app_id: 'judge-me',
      operation: 'install',
      app_name: 'Judge.me 评价',
      pricing: 'freemium',
      category: 'reviews',
      reason: '要收评价',
    })
    expect(appInstallAfter({ app_id: 'mystery', operation: 'uninstall' })).toEqual({
      app_id: 'mystery',
      operation: 'uninstall',
    })
  })

  it('appConfigAfter 把设置原样铺开，卡面上逐项比差异', () => {
    expect(
      appConfigAfter({ app_id: 'judge-me', settings: { widget_position: 'product_page' } }),
    ).toEqual({ app_id: 'judge-me', widget_position: 'product_page' })
  })
})
