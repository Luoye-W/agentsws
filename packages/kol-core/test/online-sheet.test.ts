import { describe, expect, it } from 'vitest'
import {
  gridFromHtml,
  gridFromRead,
  gridFromText,
  onlineSheetBlock,
  onlineSheetPlan,
} from '../src/index.js'

describe('WP489 在线表格', () => {
  it('认链接：Google 先读导出页、再读页面；飞书读页面', () => {
    const g = onlineSheetPlan('https://docs.google.com/spreadsheets/d/1AbC-xyz/edit#gid=42')
    expect(g?.kind).toBe('google')
    expect(g?.reads[0]).toEqual({
      url: 'https://docs.google.com/spreadsheets/d/1AbC-xyz/gviz/tq?tqx=out:html&gid=42',
      as: 'html',
    })
    expect(onlineSheetPlan('https://acme.feishu.cn/sheets/shtcnXYZ?sheet=abc')?.kind).toBe('feishu')
    expect(onlineSheetPlan('https://example.com/table')?.kind).toBe('other')
    expect(onlineSheetPlan('javascript:alert(1)')).toBeUndefined()
  })

  it('导出页的 <table> → 格子（实体、colspan、空行）', () => {
    const html = `<html><body><table border=1><tr><th>名称</th><th colspan="2">链接</th></tr>
      <tr><td>A &amp; B</td><td>https://www.youtube.com/@ab</td><td></td></tr><tr><td></td><td></td></tr></table></body></html>`
    expect(gridFromHtml(html)).toEqual([
      ['名称', '链接', '链接'],
      ['A & B', 'https://www.youtube.com/@ab', ''],
    ])
  })

  it('页面文字（制表符隔开的行）→ 格子；导航栏的字不算', () => {
    const text = '文件  编辑  视图\n名称\t链接\t状态\n小桌\thttps://www.youtube.com/@d\t已合作\n'
    expect(gridFromText(text)).toEqual([
      ['名称', '链接', '状态'],
      ['小桌', 'https://www.youtube.com/@d', '已合作'],
    ])
    expect(gridFromRead({ ok: true, text: '只是一段话' })).toBeUndefined()
  })

  it('登录页 / 没权限页认得出', () => {
    expect(
      onlineSheetBlock({ ok: true, final_url: 'https://accounts.google.com/v3/signin/identifier' }),
    ).toBe('login')
    expect(
      onlineSheetBlock({
        ok: true,
        final_url: 'https://acme.feishu.cn/sheets/x',
        password_inputs: 1,
      }),
    ).toBe('login')
    expect(
      onlineSheetBlock({
        ok: true,
        final_url: 'https://docs.google.com/x',
        text: 'You need access. Request access',
      }),
    ).toBe('no_access')
    expect(
      onlineSheetBlock({ ok: true, final_url: 'https://docs.google.com/x', text: '名称\t链接' }),
    ).toBeUndefined()
  })
})
