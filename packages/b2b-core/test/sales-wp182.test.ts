import { inflateSync } from 'node:zlib'
import type { B2bAccount, B2bInquiry, B2bOpportunity, B2bQuoteVersion } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  askedFactCategories,
  b2bFactCategoryOf,
  b2bFactTemplates,
  buildQuoteSheet,
  draftInquiryReply,
  gradeB2bInquiry,
  guessIndustry,
  invertedTier,
  missingRequirements,
  pdfFamilyOf,
  planHandover,
  renderQuotePdf,
  sampleReminders,
  sampleStepProblem,
  templateInquiryReply,
  ungroundedFigures,
  winAnsi,
} from '../src/index.js'

void inflateSync

const FACTS = [
  {
    id: 'kc_moq',
    category: 'pricing_moq' as const,
    statement: 'GaN 65W MOQ 500 件每款',
    reply_en: 'The MOQ for the GaN 65W is 500 pcs per model.',
  },
  {
    id: 'kc_delivery',
    category: 'delivery' as const,
    statement: '常规交期定金到账后 15-20 天',
    reply_en: 'Standard lead time is 15-20 days after deposit.',
  },
]

describe('WP182 询盘分级（b2b-inquiry 技能四档）', () => {
  it('真买家：说得出数量、规格、认证', () => {
    const g = gradeB2bInquiry({
      subject: 'GaN 65W charger for UK market',
      text: 'We are a distributor in the UK. We need 3,000 pcs of 65W USB-C PD chargers with UKCA, FOB Shenzhen.',
      from_email: 'buying@volthaus.example',
    })
    expect(g.grade).toBe('buyer')
    expect(g.reasons).toContain('说得出数量')
  })
  it('在比价：Dear Supplier + 只要价格表', () => {
    const g = gradeB2bInquiry({
      subject: 'Inquiry',
      text: 'Dear Supplier, please send your best price list for all products.',
      from_email: 'info@trade.example',
    })
    expect(g.grade).toBe('comparing')
  })
  it('骗样嫌疑：免费样品 + 运费不付', () => {
    const g = gradeB2bInquiry({
      subject: 'samples',
      text: 'Please send free samples of each model one piece, freight collect is not possible, you pay the shipping.',
      from_email: 'someone@gmail.com',
    })
    expect(g.grade).toBe('sample_hunter')
  })
  it('诈骗嫌疑：登录看订单 / 危险附件 / 入围费', () => {
    expect(
      gradeB2bInquiry({
        subject: 'New order',
        text: 'Please click the link below and login to view the purchase order.',
        from_email: 'po@walmart-orders.example',
      }).grade,
    ).toBe('scam')
    expect(
      gradeB2bInquiry({
        subject: 'PO',
        text: 'see attached',
        from_email: 'a@b.example',
        attachments: ['PO_2026.zip'],
      }).grade,
    ).toBe('scam')
    expect(
      gradeB2bInquiry({
        subject: 'Walmart vendor program',
        text: 'Walmart purchasing here, please pay the supplier registration fee first.',
        from_email: 'walmart.purchase@gmail.com',
      }).reasons,
    ).toEqual(expect.arrayContaining(['自称大公司却用免费邮箱']))
  })
  it('客户库里认得的直接算真买家', () => {
    expect(
      gradeB2bInquiry({
        subject: 'hi',
        text: 'any news?',
        from_email: 'x@known.example',
        known: true,
      }).grade,
    ).toBe('buyer')
  })
})

describe('WP182 首回：只引事实卡，没有卡就说确认', () => {
  it('模板：问了 MOQ 与交期 → 引两张卡英文那一句；问价不报价；问最缺的两三项', () => {
    const d = templateInquiryReply({
      subject: 'GaN 65W inquiry',
      text: 'What is the MOQ and lead time? And the price?',
      first_name: 'Anna',
      our_company: 'Shenzhen Demo',
      sender_name: 'He Jia',
      facts: FACTS,
    })
    expect(d.cited).toEqual(['kc_moq', 'kc_delivery'])
    expect(d.body).toContain('500 pcs')
    expect(d.body).not.toMatch(/USD \d|\$\d/)
    expect(d.body).toContain('formal quotation')
    expect(d.asked.length).toBeLessThanOrEqual(3)
    expect(d.subject).toBe('Re: GaN 65W inquiry')
  })
  it('没有卡：说确认后回复，卡上列要确认的类别', () => {
    const d = templateInquiryReply({
      subject: 'CE?',
      text: 'Do you have CE and FCC certificates?',
      our_company: 'X',
      sender_name: 'Y',
      facts: FACTS,
    })
    expect(d.body).toMatch(/confirm this with our team/)
    expect(d.to_confirm).toEqual(['认证清单'])
  })
  it('模型那一版：数对不上 / 报了价 → 退回模板；过了自查就用模型的', async () => {
    const base = {
      subject: 'GaN 65W',
      text: 'MOQ?',
      our_company: 'X',
      sender_name: 'Y',
      facts: FACTS,
      grade: 'buyer',
      skill: '## skill body that must not leak verbatim into replies at all',
    }
    const bad = await draftInquiryReply({
      ...base,
      model: async () => ({ text: '{"body":"MOQ is 300 pcs, price USD 5.2"}' }),
    })
    expect(bad.by).toBe('template')
    expect(bad.fallback_reason).toMatch(/300 pcs/)
    const good = await draftInquiryReply({
      ...base,
      model: async () => ({
        text: '{"body":"Hi, the MOQ is 500 pcs per model.","cited":["kc_moq","nope"]}',
      }),
    })
    expect(good.by).toBe('model')
    expect(good.cited).toEqual(['kc_moq'])
    const thrown = await draftInquiryReply({
      ...base,
      model: async () => {
        throw new Error('down')
      },
    })
    expect(thrown.by).toBe('template')
  })
  it('ungroundedFigures 按数值比（1,000 = 1000）', () => {
    expect(
      ungroundedFigures('MOQ 1,000 pcs, 15 days', [
        { id: 'a', category: 'pricing_moq', statement: 'MOQ 1000 件，15 天' },
      ]),
    ).toEqual([])
    expect(askedFactCategories('need samples and warranty').categories).toEqual([
      'sample_policy',
      'after_sales',
    ])
    expect(missingRequirements('we need 500 pcs with CE, FOB')).not.toContain('quantity')
  })
})

describe('WP182 六类事实卡模板', () => {
  it('3C 预填认证清单；其余是空模板；key 认得回来', () => {
    const t = b2bFactTemplates(guessIndustry('we make GaN chargers and power banks'))
    expect(t).toHaveLength(6)
    const cert = t.find((x) => x.category === 'certifications')
    expect(cert?.structured.certifications).toEqual(
      expect.arrayContaining(['CE', 'FCC', 'RoHS', 'UKCA', 'PSE']),
    )
    expect(cert?.structured.reply_en).toContain('UKCA')
    expect(cert?.structured.reply_en).not.toContain('UL/ETL')
    expect(t.find((x) => x.category === 'delivery')?.structured.reply_en).toBe('')
    expect(b2bFactCategoryOf('b2b:delivery')).toBe('delivery')
    expect(b2bFactCategoryOf('policy:refund')).toBeUndefined()
    const smart = b2bFactTemplates(guessIndustry('smart home matter hub'))
    expect(
      smart.find((x) => x.category === 'certifications')?.structured.certifications?.join(),
    ).toMatch(/Matter/)
  })
})

describe('WP182 报价单与 PDF', () => {
  const version: B2bQuoteVersion = {
    quote_id: 'quo_1',
    version: 2,
    lines: [
      { sku: 'GaN65', description: 'GaN 65W USB-C charger, UKCA', qty: 3000, unit_price_usd: 6.2 },
    ],
    amount_usd: 18414,
    margin_pct: 18.5,
    discount_pct: 1,
    payment_terms_days: 30,
    incoterm: 'FOB',
    incoterm_place: 'Shenzhen',
    valid_until: '2026-10-31T00:00:00.000Z',
    created_at: '2026-09-29T00:00:00.000Z',
    created_by: 'agent',
    tiers: [
      { min_qty: 1000, unit_price_usd: 6.5 },
      { min_qty: 3000, unit_price_usd: 6.2 },
    ],
  }
  it('条款：术语带地点与版本、账期写成人话、阶梯不倒挂', () => {
    const s = buildQuoteSheet({
      letterhead: { company: 'Shenzhen Demo Tech', color: '#0F766E', font_family: 'Inter' },
      number: 'Q-20260929-01',
      version,
      customer: { name: 'Volthaus GmbH' },
      moq: '500 pcs per model',
      lead_time: '15-20 days after deposit',
      issued_at: '2026-09-29T00:00:00.000Z',
    })
    expect(s.incoterm_text).toBe('FOB Shenzhen, Incoterms® 2020')
    expect(s.payment_text).toMatch(/30 days/)
    expect(s.total_usd).toBe(18414)
    expect(s.issues).toEqual([])
    expect(
      invertedTier([
        { min_qty: 1, unit_price_usd: 5 },
        { min_qty: 10, unit_price_usd: 6 },
      ])?.min_qty,
    ).toBe(10)
  })
  it('自查：没地点 / 没 MOQ / 过期都列出来', () => {
    const s = buildQuoteSheet({
      letterhead: { company: 'X' },
      number: 'Q',
      version: {
        ...version,
        incoterm_place: undefined as never,
        valid_until: '2026-01-01T00:00:00Z',
      },
      customer: { name: 'Y' },
      issued_at: '2026-09-29T00:00:00.000Z',
    })
    expect(s.issues.join()).toMatch(/没写地点/)
    expect(s.issues.join()).toMatch(/有效期已经过了/)
    expect(s.issues.join()).toMatch(/MOQ/)
  })
  it('PDF：合法的 PDF 头尾、品牌色进了内容流、衬线字体映射到 Times、中文换成 ? 并报出来', () => {
    const sheet = buildQuoteSheet({
      letterhead: {
        company: '深圳演示 Demo Tech',
        color: '#0F766E',
        font_family: 'Playfair Display',
      },
      number: 'Q-1',
      version,
      customer: { name: 'Volthaus' },
      issued_at: '2026-09-29T00:00:00.000Z',
    })
    const pdf = renderQuotePdf(sheet)
    const text = Buffer.from(pdf.bytes).toString('latin1')
    expect(text.startsWith('%PDF-1.4')).toBe(true)
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true)
    expect(text).toContain('/BaseFont /Times-Roman')
    expect(text).toContain('0.059 0.463 0.431 rg')
    expect(text).toContain('FOB Shenzhen, Incoterms\\256 2020')
    expect(pdf.font).toBe('Times')
    expect(pdf.lossy).toBe(true)
    // xref 偏移对得上：第一个对象就在记下的位置
    const xrefAt = Number(text.match(/startxref\n(\d+)/)?.[1])
    expect(text.slice(xrefAt, xrefAt + 4)).toBe('xref')
    const first = Number(text.match(/xref\n0 \d+\n0000000000 65535 f \n(\d{10})/)?.[1])
    expect(text.slice(first, first + 7)).toBe('1 0 obj')
    expect(pdfFamilyOf('JetBrains Mono')).toBe('Courier')
    expect(pdfFamilyOf('Noto Sans SC')).toBe('Helvetica')
    expect(winAnsi('café –').lossy).toBe(false)
  })
})

describe('WP182 样品', () => {
  it('只能一步一步走；已寄要单号', () => {
    expect(sampleStepProblem('to_ship', 'delivered')).toMatch(/一步一步/)
    expect(sampleStepProblem('to_ship', 'shipped')).toMatch(/单号/)
    expect(sampleStepProblem('to_ship', 'shipped', 'DHL1')).toBeUndefined()
  })
  it('超期不寄、超期没反馈出提醒', () => {
    const base = {
      workspace_id: 'ws' as never,
      account_id: 'a',
      items: [],
      updated_at: '2026-09-01T00:00:00Z',
    }
    const due = sampleReminders(
      [
        { ...base, id: 's1', status: 'to_ship', ship_by: '2026-09-20T00:00:00Z' },
        { ...base, id: 's2', status: 'delivered', ship_by: '2026-09-01T00:00:00Z' },
        {
          ...base,
          id: 's3',
          status: 'shipped',
          ship_by: '2026-09-01T00:00:00Z',
          feedback_by: '2026-10-30T00:00:00Z',
        },
        { ...base, id: 's4', status: 'to_ship', ship_by: '2026-10-20T00:00:00Z' },
      ],
      '2026-09-29T00:00:00Z',
      { feedback_days: 14 },
    )
    expect(due.map((d) => `${d.sample_id}:${d.kind}`)).toEqual([
      's1:ship_overdue',
      's2:feedback_overdue',
    ])
    expect(due[0]?.days_over).toBe(9)
  })
})

describe('WP182 离职交接', () => {
  const acc = (id: string, owner: string, region: string, line: string): B2bAccount => ({
    id,
    workspace_id: 'ws' as never,
    name: id.toUpperCase(),
    region,
    product_lines: [line],
    stage: 'quote',
    owner_person_id: owner as never,
    source: { kind: 'manual', observed_at: '2026-01-01T00:00:00Z' },
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  })
  it('按接手的人在管的地区 / 产品线分；对不上的给兜底；没接手人全待分', () => {
    const accounts = [
      acc('a_eu', 'p_he', 'EU', 'GaN'),
      acc('a_na', 'p_he', 'NA', 'TWS'),
      acc('a_me', 'p_he', 'ME', 'Power'),
      acc('b_eu', 'p_wu', 'EU', 'Cable'),
      acc('c_na', 'p_li', 'NA', 'TWS'),
    ]
    const opp: B2bOpportunity = {
      id: 'o1',
      workspace_id: 'ws' as never,
      account_id: 'a_eu',
      name: 'GaN 2026',
      stage: 'quote',
      value_usd: 18000,
      owner_person_id: 'p_he' as never,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    }
    const inq = {
      id: 'inq1',
      kind: 'inquiry',
      status: 'new',
      owner_person_id: 'p_he',
      account_id: 'a_na',
      subject: 'TWS',
      from_domain: 'na.example',
    } as unknown as B2bInquiry
    const plan = planHandover({
      departing: 'p_he' as never,
      accounts,
      opportunities: [opp],
      inquiries: [inq],
      successors: [{ person_id: 'p_wu' as never }, { person_id: 'p_li' as never }],
      fallback: 'p_lin' as never,
    })
    const to = Object.fromEntries(plan.items.map((i) => [i.id, i.successor_id]))
    expect(to).toEqual({ a_eu: 'p_wu', a_na: 'p_li', a_me: 'p_lin', o1: 'p_wu', inq1: 'p_li' })
    expect(plan.totals).toEqual({ accounts: 3, deals: 1, inquiries: 1, value_usd: 18000 })
    const none = planHandover({
      departing: 'p_he' as never,
      accounts,
      opportunities: [],
      inquiries: [],
      successors: [],
    })
    expect(none.items).toEqual([])
    expect(none.unassigned).toHaveLength(3)
  })
})
