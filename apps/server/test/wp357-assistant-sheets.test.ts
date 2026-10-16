/**
 * WP357（决策 904）：助理附件加收 .xlsx / .csv——读成表格文字（一行一行、格子用 | 隔开），
 * 按整行截断、照 3 万字上限；口令照样抹掉；读不了的照实说。夹具全是现编的假数据。
 */
import { zipFiles } from '@agentsws/knowledge'
import { describe, expect, it } from 'vitest'
import {
  ASSISTANT_FILE_EXTENSIONS,
  ASSISTANT_FILE_MAX_CHARS,
  readAssistantFile,
  sheetText,
} from '../src/assistant-files.js'

const b64 = (s: string | Buffer): string => Buffer.from(s).toString('base64')
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')

/** 最小的 xlsx：每张表一份 XML（行内字串），workbook + rels 指过去。 */
function xlsx(sheets: { name: string; rows: string[][] }[]): Buffer {
  const col = (c: number): string => String.fromCharCode(65 + c)
  const sheetXml = sheets.map(
    (s) =>
      `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${s.rows
        .map(
          (row, r) =>
            `<row r="${r + 1}">${row
              .map(
                (v, c) =>
                  `<c r="${col(c)}${r + 1}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`,
              )
              .join('')}</row>`,
        )
        .join('')}</sheetData></worksheet>`,
  )
  const workbook = `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets
    .map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join('')}</sheets></workbook>`
  const rels = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
    .map(
      (_, i) =>
        `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
    )
    .join('')}</Relationships>`
  return zipFiles([
    { path: '[Content_Types].xml', content: '<?xml version="1.0"?><Types/>' },
    { path: 'xl/workbook.xml', content: workbook },
    { path: 'xl/_rels/workbook.xml.rels', content: rels },
    ...sheetXml.map((content, i) => ({ path: `xl/worksheets/sheet${i + 1}.xml`, content })),
  ])
}

describe('WP357 助理附件读表格（决策 904）', () => {
  it('认 .xlsx / .csv（原来四种照旧）', () => {
    expect([...ASSISTANT_FILE_EXTENSIONS]).toEqual(['txt', 'md', 'docx', 'pdf', 'xlsx', 'csv'])
  })

  it('xlsx：读成一行一行的表格文字；多张表各带一行表名；空行跳过', () => {
    const file = xlsx([
      {
        name: '本周任务',
        rows: [
          ['事项', '负责岗位', '截止'],
          ['上架新款耳机', '网站运营', '10-20'],
          ['', '', ''],
          ['回复差评', '客服', '10-18'],
        ],
      },
      { name: '口径', rows: [['退货期统一 30 天']] },
    ])
    const a = readAssistantFile({ name: '周会安排.xlsx', data: b64(file) })
    expect(a.unreadable).toBeUndefined()
    expect(a.text).toBe(
      [
        '## 本周任务',
        '事项 | 负责岗位 | 截止',
        '上架新款耳机 | 网站运营 | 10-20',
        '回复差评 | 客服 | 10-18',
        '## 口径',
        '退货期统一 30 天',
      ].join('\n'),
    )
    expect(a.chars).toBe(a.text?.length)
  })

  it('csv：引号里的逗号与换行照读；只有一张表不带表名；口令那格抹掉', () => {
    const csv = '﻿事项,说明\n"运费, 满 50 包邮","第一行\n第二行"\n后台账号,密码：hunter2-fake\n'
    const a = readAssistantFile({ name: '口径.csv', data: b64(csv) })
    expect(a.text?.split('\n')[0]).toBe('事项 | 说明')
    expect(a.text).toContain('运费, 满 50 包邮 | 第一行 第二行')
    expect(a.text).not.toContain('hunter2-fake')
    expect(a.text).toContain('[已抹掉]')
    expect(a.redacted).toBe(1)
  })

  it('太长按整行截断：不切半行，照实说读了几行', () => {
    const row = 'x'.repeat(99)
    const out = sheetText([{ name: '', rows: Array.from({ length: 400 }, () => [row]) }])
    expect(out.total).toBe(400)
    expect(out.rows).toBe(Math.floor(ASSISTANT_FILE_MAX_CHARS / 100))
    expect(out.text.length).toBeLessThanOrEqual(ASSISTANT_FILE_MAX_CHARS)
    expect(out.text.split('\n').every((l) => l === row)).toBe(true)

    const csv = Array.from({ length: 400 }, (_, i) => `${i},${row}`).join('\n')
    const a = readAssistantFile({ name: '长表.csv', data: b64(csv) })
    expect(a.unreadable).toMatch(/只读了前 \d+ 行（共 400 行）/u)
    expect((a.text ?? '').length).toBeLessThanOrEqual(ASSISTANT_FILE_MAX_CHARS)
    expect(a.text?.endsWith(row)).toBe(true)
  })

  it('读不了照实说：坏的 xlsx、空表、改了名的二进制 csv；.xls 仍不收', () => {
    expect(readAssistantFile({ name: '坏.xlsx', data: b64('not a zip') }).unreadable).toMatch(
      /表格读不了/u,
    )
    expect(
      readAssistantFile({ name: '空.xlsx', data: b64(xlsx([{ name: 'S', rows: [['', '']] }])) })
        .unreadable,
    ).toBe('这份表格是空的')
    expect(
      readAssistantFile({ name: '假.csv', data: b64(Buffer.from([0x50, 0x4b, 0, 0, 1, 2])) })
        .unreadable,
    ).toMatch(/不是文字/u)
    expect(readAssistantFile({ name: '老表.xls', data: b64('x') }).unreadable).toMatch(
      /换成 .*\.xlsx/u,
    )
  })
})
