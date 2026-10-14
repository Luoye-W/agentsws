import { describe, expect, it } from 'vitest'
import { readCsv, readSpreadsheet } from '../src/sheet.js'
import { buildXls, buildXlsx, type FakeSheet } from './sheet-fixtures.js'

// 全是现编的假内容（WP322：测试里不放任何真实客户数据）
const SHEETS: FakeSheet[] = [
  {
    name: '常见问题',
    rows: [
      ['小蓝灯 FAQ（内部）', null, null],
      [null, null, null],
      ['分类', '问题', '回答'],
      ['续航', '充一次电能用多久？', '正常使用约 6 小时。'],
      [null, '充满要多久？', '约 90 分钟 & 支持快充。'],
      ['配送', 'Ship to Canada?', 'Yes, 7–10 days.'],
    ],
    merges: ['A1:C1', 'A4:A5'],
  },
  {
    name: 'English',
    rows: [
      ['Question', 'Answer', 'Lang'],
      ['Is it waterproof?', 'Splash resistant only.', 'en'],
      ['Battery?', 42, 'en'],
    ],
  },
  { name: 'lists', rows: [['a'], ['b']], hidden: true },
]

describe('WP322 表格读取', () => {
  it('xlsx：多表、合并格铺满、实体还原、数字转字、隐藏表不读', () => {
    const grids = readSpreadsheet('xlsx', buildXlsx(SHEETS))
    expect(grids.map((g) => g.name)).toEqual(['常见问题', 'English'])
    const [faq, en] = grids
    expect(faq?.rows[0]).toEqual(['小蓝灯 FAQ（内部）', '小蓝灯 FAQ（内部）', '小蓝灯 FAQ（内部）'])
    expect(faq?.rows[4]?.[0]).toBe('续航')
    expect(faq?.rows[4]?.[2]).toBe('约 90 分钟 & 支持快充。')
    expect(en?.rows[2]).toEqual(['Battery?', '42', 'en'])
  })

  it('xls（BIFF8）：共享字串跨 CONTINUE、合并格、LABEL / NUMBER 格', () => {
    const sheets: FakeSheet[] = [
      {
        name: '问答',
        rows: [
          ['类别', 'Question text', '答案'],
          ['售后', '保修多久？', 'label:一年，人为损坏除外。'],
          [null, 'Return window?', 30],
        ],
        merges: ['A2:A3'],
      },
      { name: 'hidden', rows: [['x']], hidden: true },
    ]
    const grids = readSpreadsheet('xls', buildXls(sheets))
    expect(grids).toHaveLength(1)
    expect(grids[0]?.name).toBe('问答')
    expect(grids[0]?.rows).toEqual([
      ['类别', 'Question text', '答案'],
      ['售后', '保修多久？', '一年，人为损坏除外。'],
      ['售后', 'Return window?', '30'],
    ])
  })

  it('xls：小于 4096 字节的工作簿流在迷你流里也读得出', () => {
    const grids = readSpreadsheet(
      'xls',
      buildXls(
        [
          {
            name: 'S',
            rows: [
              ['Q', 'A'],
              ['hi?', 'hello'],
            ],
          },
        ],
        { mini: true },
      ),
    )
    expect(grids[0]?.rows).toEqual([
      ['Q', 'A'],
      ['hi?', 'hello'],
    ])
  })

  it('csv：BOM、分号分隔、引号里的换行与逗号', () => {
    const text = '﻿问题;答案\n"能退吗;怎么退？";"可以，""七天""内\n联系客服"\n\n'
    expect(readCsv(text)).toEqual([
      ['问题', '答案'],
      ['能退吗;怎么退？', '可以，"七天"内\n联系客服'],
      [''],
    ])
  })

  it('读坏的文件抛一句人话', () => {
    expect(() => readSpreadsheet('xlsx', new Uint8Array([1, 2, 3]))).toThrow(/打不开/)
    expect(() => readSpreadsheet('xls', new Uint8Array(600))).toThrow(/另存为 .xlsx/)
  })
})
