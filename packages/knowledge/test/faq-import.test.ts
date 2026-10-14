import { describe, expect, it } from 'vitest'
import {
  existingFaqOf,
  extractFaqRows,
  faqCard,
  faqKey,
  faqMappingPrompt,
  findHeaderRow,
  guessColumns,
  parseFaqMapping,
  planFaqImport,
  ruleMapping,
} from '../src/faq-import.js'
import { createKnowledge, downgradeOf, stateWordSkipFor } from '../src/index.js'
import { readSpreadsheet, type SheetGrid } from '../src/sheet.js'
import { aftersales } from './fixtures.js'
import { buildXlsx } from './sheet-fixtures.js'

// 全是现编的假问答（WP322：测试里不放任何真实客户数据）
const fields = (headers: string[]) =>
  Object.fromEntries(guessColumns(headers).map((c) => [c.field, c.col]))

describe('WP322 认列', () => {
  it('中英常见列名、括号里的注、「问题分类」是分类不是问题', () => {
    expect(fields(['分类', '问题', '回答'])).toEqual({ category: 0, question: 1, answer: 2 })
    expect(fields(['Question', 'Answer (EN)', 'Lang'])).toEqual({
      question: 0,
      answer: 1,
      language: 2,
    })
    expect(fields(['问题分类', '客户常见问题', '标准回复话术', '适用机型', '备注'])).toEqual({
      category: 0,
      question: 1,
      answer: 2,
      product: 3,
    })
    expect(fields(['Q', 'A'])).toEqual({ question: 0, answer: 1 })
    // 认不出的怪表头：一列都不给
    expect(fields(['Customer asks', 'We say'])).toEqual({})
  })

  it('表头不在第一行：跳过标题、空行与横跨的合并标题', () => {
    const rows = [
      ['小蓝灯售后手册', '小蓝灯售后手册', '小蓝灯售后手册'],
      ['', '', ''],
      ['更新于某天', '', ''],
      ['类别', '问题', '答案'],
      ['配送', '几天到？', '3–5 天。'],
    ]
    expect(findHeaderRow(rows)).toBe(3)
  })
})

describe('WP322 读行', () => {
  const grid: SheetGrid = {
    name: '售后',
    rows: [
      ['类别', '问题', '答案'],
      ['一、配送', '一、配送', '一、配送'],
      ['配送', '几天到？', '3–5 天。'],
      ['', '', ''],
      ['配送', '能寄到海外吗？', ''],
      ['保修', '保修多久？', '一年。'],
      ['保修', '保修多久？', '人为损坏不保。'],
      ['类别', '问题', '答案'],
      ['保修', '怎么报修？', '在 App 里提交。'],
    ],
  }

  it('分节标题、空行、重复表头跳过；缺答案记一笔；竖着合并的问题把答案接起来', () => {
    const mapping = ruleMapping(grid)
    expect(mapping?.header_row).toBe(1)
    const { rows, skipped } = extractFaqRows(grid, mapping as NonNullable<typeof mapping>)
    expect(skipped).toBe(1)
    expect(rows.map((r) => [r.row, r.question, r.answer, r.category])).toEqual([
      [3, '几天到？', '3–5 天。', '配送'],
      [6, '保修多久？', '一年。\n人为损坏不保。', '保修'],
      [9, '怎么报修？', '在 App 里提交。', '保修'],
    ])
  })
})

describe('WP322 AI 认列', () => {
  const grid: SheetGrid = {
    name: 'Sheet1',
    rows: [
      ['Customer asks', 'We say', 'Owner'],
      ['Does it float?', 'No, please keep it dry.', 'Team A'],
    ],
  }

  it('规则认不出才问 AI；提示词带行号列字母、包在外部数据围栏里', () => {
    expect(ruleMapping(grid)).toBeUndefined()
    const prompt = faqMappingPrompt([grid])
    expect(prompt).toContain('第1行: A=Customer asks | B=We say | C=Owner')
    expect(prompt).toContain('<external_data')
  })

  it('AI 回的 JSON 验过才用：表名、行号、列都得对得上', () => {
    const ok = parseFaqMapping(
      '好的：{"sheets":[{"sheet":"Sheet1","faq":true,"header_row":1,"question":"A","answer":"B","category":null}]}',
      [grid],
    )
    expect(ok).toEqual([
      {
        sheet: 'Sheet1',
        header_row: 1,
        by: 'ai',
        rows: 1,
        columns: [
          { field: 'question', col: 0, header: 'Customer asks' },
          { field: 'answer', col: 1, header: 'We say' },
        ],
      },
    ])
    // 同一列当问题又当答案、列超出表宽、不是问答表、不是 JSON：一律不认
    const bad = [
      '{"sheets":[{"sheet":"Sheet1","faq":true,"header_row":1,"question":"A","answer":"A"}]}',
      '{"sheets":[{"sheet":"Sheet1","faq":true,"header_row":1,"question":"A","answer":"Q"}]}',
      '{"sheets":[{"sheet":"Sheet1","faq":false}]}',
      '不知道',
    ]
    for (const text of bad) expect(parseFaqMapping(text, [grid])).toEqual([])
  })
})

describe('WP322 去重与成卡', () => {
  const ctx = {
    workspace_id: 'ws_t',
    owner: 'p_owner',
    by: 'p_up',
    at: '2026-10-14T00:00:00.000Z',
    source_ref: 'blob://knowledge/ws_t/abc.xlsx',
    filename: '小蓝灯FAQ.xlsx',
  }

  it('一行一张卡：问答都在陈述里、出处是文件 › 表 › 行', () => {
    const card = faqCard(
      {
        sheet: '售后',
        row: 7,
        question: '保修多久？',
        answer: '一年。',
        product: '小蓝灯 2',
        category: '保修',
      },
      ctx,
    )
    expect(card.statement).toBe('Q: 保修多久？（小蓝灯 2）\nA: 一年。')
    expect(card.subject).toEqual({ type: 'faq', id: '保修', key: faqKey('保修多久？') })
    expect(card.provenance[0]?.locator).toBe('小蓝灯FAQ.xlsx › 售后 › 第 7 行')
    expect(card.structured).toEqual({
      question: '保修多久？',
      answer: '一年。',
      category: '保修',
      product: '小蓝灯 2',
    })
  })

  it('按问题去重（全半角 / 标点 / 大小写不算不同）；答案变了是更新；同名表里没了的只提示', () => {
    expect(faqKey('Ship to Canada?')).toBe(faqKey('ship  to canada？'))
    const existing = [
      {
        id: 'f1',
        key: faqKey('几天到？'),
        question: '几天到？',
        answer: '3–5 天。',
        status: 'active' as const,
        locator: '小蓝灯FAQ.xlsx › 售后 › 第 3 行',
      },
      {
        id: 'f2',
        key: faqKey('保修多久？'),
        question: '保修多久？',
        answer: '半年。',
        status: 'active' as const,
        locator: '小蓝灯FAQ.xlsx › 售后 › 第 4 行',
      },
      {
        id: 'f3',
        key: faqKey('能退吗？'),
        question: '能退吗？',
        answer: '七天。',
        status: 'active' as const,
        locator: '小蓝灯FAQ.xlsx › 售后 › 第 5 行',
      },
      {
        id: 'f4',
        key: faqKey('别的表'),
        question: '别的表',
        answer: 'x',
        status: 'active' as const,
        locator: '另一份.csv › 第 2 行',
      },
    ]
    const plan = planFaqImport(
      [
        { sheet: '售后', row: 2, question: '几天到?', answer: '3–5 天。 ' },
        { sheet: '售后', row: 3, question: '保修多久？', answer: '一年。' },
        { sheet: '售后', row: 4, question: '新问题？', answer: '新答案。' },
        { sheet: '售后', row: 5, question: '新问题', answer: '重复的。' },
      ],
      existing,
      '小蓝灯FAQ.xlsx',
    )
    expect(plan.same.map((r) => r.row)).toEqual([2])
    expect(plan.changed.map((c) => [c.row.row, c.replaces.id])).toEqual([[3, 'f2']])
    expect(plan.fresh.map((r) => r.row)).toEqual([4])
    expect(plan.duplicates).toBe(1)
    expect(plan.removed.map((e) => e.id)).toEqual(['f3'])
  })

  it('整份表走一遍：多表、表头不在第一行、合并的分类、英文表；成卡后检索中英都命中', async () => {
    const bytes = buildXlsx([
      {
        name: '中文',
        rows: [
          ['小蓝灯 FAQ', null, null],
          [null, null, null],
          ['分类', '问题', '回答'],
          ['续航', '充一次电能用多久？', '正常使用约 6 小时。'],
          [null, '充满要多久？', '约 90 分钟。'],
        ],
        merges: ['A1:C1', 'A4:A5'],
      },
      {
        name: 'English',
        rows: [
          ['Question', 'Answer', 'Language'],
          ['Is it waterproof?', 'Splash resistant only, do not submerge.', 'en'],
        ],
      },
      {
        name: '价目',
        rows: [
          ['SKU', '价格'],
          ['LB-1', 99],
        ],
      },
    ])
    const grids = readSpreadsheet('xlsx', bytes)
    const mappings = grids.flatMap((g) => {
      const m = ruleMapping(g)
      return m === undefined ? [] : [m]
    })
    expect(mappings.map((m) => [m.sheet, m.header_row, m.rows])).toEqual([
      ['中文', 3, 2],
      ['English', 1, 1],
    ])
    const rows = mappings.flatMap(
      (m) => extractFaqRows(grids.find((g) => g.name === m.sheet) as SheetGrid, m).rows,
    )
    expect(rows[1]?.category).toBe('续航')

    const k = createKnowledge({ workspace_id: 'ws_t' })
    for (const row of rows) {
      const card = await k.store.propose(faqCard(row, ctx))
      await k.store.activate(card.id, 'p_up')
    }
    // 售后客服那一档身份（只有 knowledge 读权限）：起草回复时检索走的就是这一档
    const actor = aftersales('ws_t')
    const zh = await k.retrieval.search({ text: '充满要多久', actor, mode: 'lexical' })
    expect(zh.hits[0]?.statement_redacted).toContain('约 90 分钟')
    const en = await k.retrieval.search({ text: 'waterproof', actor, mode: 'lexical' })
    expect(en.hits[0]?.statement_redacted).toContain('Q: Is it waterproof?')
    const listed = await k.store.list({ workspace_id: 'ws_t' }, actor)
    expect(listed.map(existingFaqOf).filter((e) => e !== undefined)).toHaveLength(3)
    k.close()
  })
})

describe('WP333 决策 700：FAQ 表导入的卡不按金额降', () => {
  const ctx = {
    workspace_id: 'ws_t',
    owner: 'p_owner',
    by: 'p_up',
    at: '2026-10-14T00:00:00.000Z',
    source_ref: 'blob://knowledge/ws_t/abc.xlsx',
    filename: '小蓝灯FAQ.xlsx',
  }
  const propose = async (question: string, answer: string) => {
    const k = createKnowledge({ workspace_id: 'ws_t' })
    const card = await k.store.propose(faqCard({ sheet: '售后', row: 2, question, answer }, ctx))
    k.close()
    return card
  }

  it('答案带金额（$ / 元 / USD）还是事实层', async () => {
    for (const answer of ['满 $50 包邮。', '运费 9.9 元。', 'Orders over USD 50 ship free.']) {
      const card = await propose('包邮吗？', answer)
      expect(card.layer, answer).toBe('fact')
      expect(card.downgraded_from).toBeUndefined()
      expect(card.as_of).toBeUndefined()
    }
  })

  it('订单号、物流状态、库存数照旧降（金额同在也降）', async () => {
    const cases: [string, string][] = [
      ['我的单呢？', '订单 #1001 已发货。'],
      ['到了吗？', 'The package was delivered on Friday.'],
      ['有货吗？', '库存还有 3 件，$29。'],
    ]
    for (const [q, a] of cases) {
      const card = await propose(q, a)
      expect(card.layer, a).toBe('historical_case')
      expect(card.downgraded_from).toBe('fact')
    }
  })

  it('别的卡带金额照旧降；跳过只认 FAQ 那一类', () => {
    expect(downgradeOf('fact', '给客户退了 129 美元')).toBeDefined()
    expect(stateWordSkipFor('faq')).toEqual(['money'])
    expect(stateWordSkipFor('policy')).toBeUndefined()
    expect(downgradeOf('fact', '满 $50 包邮', undefined, ['money'])).toBeUndefined()
  })
})
