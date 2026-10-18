/**
 * WP404：外置规则表的读取口——没登记覆盖源时原样、按品牌覆盖、坏的覆盖整张不用。
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  builtinContentTable,
  type ContentTableProvider,
  contentTableProblem,
  hasContentTableProviders,
  readContentTable,
  registerContentTableProvider,
} from '../src/index.js'

interface Row {
  id: string
  text: string
}
const TABLE = builtinContentTable<Row>({
  table: 'test.rows',
  rows: [
    { id: 'a', text: '甲' },
    { id: 'b', text: '乙' },
  ],
})
const isRow = (r: unknown): r is Row => typeof (r as Row).text === 'string'

let undo: (() => void)[] = []
const register = (p: ContentTableProvider): void => {
  undo.push(registerContentTableProvider(p))
}
afterEach(() => {
  for (const u of undo) u()
  undo = []
})

describe('readContentTable', () => {
  it('没登记覆盖源：就是随软件带的那一份（同一个数组）', () => {
    expect(hasContentTableProviders()).toBe(false)
    expect(readContentTable(TABLE)).toBe(TABLE.rows)
    expect(readContentTable(TABLE, { brand: 'b1' })).toBe(TABLE.rows)
  })

  it('按品牌覆盖：只管自己那张表、那个品牌；别的回落', () => {
    register((table, brand) =>
      table === 'test.rows' && brand === 'b1' ? [{ id: 'a', text: '改' }] : undefined,
    )
    expect(readContentTable(TABLE, { brand: 'b1' })).toEqual([{ id: 'a', text: '改' }])
    expect(readContentTable(TABLE, { brand: 'b2' })).toBe(TABLE.rows)
    expect(readContentTable(TABLE)).toBe(TABLE.rows)
  })

  it('后登记的先问', () => {
    register(() => [{ id: 'x', text: '先' }])
    register(() => [{ id: 'y', text: '后' }])
    expect(readContentTable(TABLE)).toEqual([{ id: 'y', text: '后' }])
  })

  it('坏的覆盖整张不用：缺 id、id 重名、过不了 accepts、覆盖源自己抛错', () => {
    register(() => [{ text: '没 id' }] as never)
    expect(readContentTable(TABLE)).toBe(TABLE.rows)
    undo.pop()?.()
    register(() => [
      { id: 'a', text: '1' },
      { id: 'a', text: '2' },
    ])
    expect(readContentTable(TABLE)).toBe(TABLE.rows)
    undo.pop()?.()
    register(() => [{ id: 'a', text: 3 }] as never)
    expect(readContentTable(TABLE, { accepts: isRow })).toBe(TABLE.rows)
    undo.pop()?.()
    register(() => {
      throw new Error('boom')
    })
    expect(readContentTable(TABLE)).toBe(TABLE.rows)
  })

  it('随软件带的表不合格直接抛（打包打错了）', () => {
    expect(() => builtinContentTable({ table: 't', rows: [{ id: 'a' }, { id: 'a' }] })).toThrow(
      /id 重名/,
    )
    expect(() => builtinContentTable({ table: '', rows: [] })).toThrow(/缺 table/)
    expect(contentTableProblem('x')).toBe('rows 不是数组')
  })
})
