/**
 * WP314：解析两家导出、读回核对、Editor CSV 与列名对照。
 * 样例全部手写（假名字、假编号、假数），没有任何真实账户数据。
 */
import { describe, expect, it } from 'vitest'
import {
  type AdSheetOp,
  activationOpsFor,
  attachIdsFromExport,
  buildGoogleEditorCsv,
  exportEntities,
  exportFieldOf,
  GOOGLE_BULK_COLUMNS,
  GOOGLE_EDITOR_COLUMN_MAP,
  META_COLUMNS,
  normalizeStatus,
  parseAdsExport,
  parseExportNumber,
  readBackCheck,
  splitGoogleKeyword,
  stripMetaFormulaPrefix,
} from '../src/index.js'

/** Google 报表样子：两行标题、表头、数据、Total 合计行。 */
const GOOGLE_REPORT = [
  'Campaign report',
  '"October 1, 2026 - October 7, 2026"',
  'Campaign,Campaign ID,Campaign state,Budget,Currency code,Cost,Impr.,Clicks,Conversions,Conv. value',
  'Live One,1001,Enabled,230.00,USD,"1,234.50","10,000",321,12,"2,400.00"',
  'Old One,1002,Paused,50.00,USD,--,0,0,0,0',
  'Total: Account,,,,USD,"1,234.50","10,000",321,12,"2,400.00"',
].join('\n')

describe('解析导出', () => {
  it('跳过标题行与合计行，认出 Google，数字去千分位，-- 是「没数」不是 0', () => {
    const p = parseAdsExport(GOOGLE_REPORT)
    expect(p.platform).toBe('google')
    expect(p.skipped).toEqual({ title_lines: 2, total_rows: 1 })
    expect(p.rows).toHaveLength(2)
    const [live, old] = exportEntities(p)
    expect(live).toMatchObject({
      level: 'campaign',
      campaign: 'Live One',
      campaign_id: '1001',
      status: 'enabled',
      budget: 230,
      metrics: {
        cost: 1234.5,
        impressions: 10000,
        clicks: 321,
        conversions: 12,
        conversion_value: 2400,
      },
    })
    expect(old?.status).toBe('paused')
    expect(old?.metrics.cost).toBeUndefined()
  })

  it('Meta 导出：一行拆三层对象、去掉 < > 前缀、指标只记在最细一层', () => {
    const tsv = [
      'Campaign ID\tCampaign Name\tCampaign Status\tAd Set ID\tAd Set Name\tAd Set Run Status\tAd Set Daily Budget\tAd ID\tAd Name\tAd Status\tBody\tAmount spent (USD)',
      '2001\tLive\tACTIVE\t3001\tLive set\tPAUSED\t50\t4001\tAd A\tACTIVE\t< > =fun\t12.00',
      '2001\tLive\tACTIVE\t3001\tLive set\tPAUSED\t50\t4002\tAd B\tACTIVE\tplain\t3.00',
    ].join('\n')
    const p = parseAdsExport(tsv)
    expect(p.platform).toBe('meta')
    expect(p.rows[0]?.values.body).toBe('=fun')
    const es = exportEntities(p)
    expect(es.map((e) => e.level)).toEqual(['campaign', 'ad_group', 'ad', 'ad'])
    expect(es[1]).toMatchObject({ level: 'ad_group', status: 'paused', budget: 50 })
    expect(es[0]?.metrics).toEqual({})
    expect(es[2]?.metrics.cost).toBe(12)
  })

  it('认不出表头 → 空表、unknown，不编', () => {
    const p = parseAdsExport('hello\nworld')
    expect(p.platform).toBe('unknown')
    expect(p.rows).toEqual([])
  })

  it('小工具', () => {
    expect(stripMetaFormulaPrefix('< > +20% off')).toBe('+20% off')
    expect(stripMetaFormulaPrefix('< > hello')).toBe('< > hello')
    expect(parseExportNumber('US$1,234.5')).toBe(1234.5)
    expect(parseExportNumber('12.5%')).toBe(12.5)
    expect(parseExportNumber('--')).toBeUndefined()
    expect(normalizeStatus('Campaign paused')).toBe('paused')
    expect(normalizeStatus('INACTIVE')).toBe('paused')
    expect(normalizeStatus('Eligible')).toBe('enabled')
    expect(normalizeStatus('Removed')).toBe('removed')
    expect(splitGoogleKeyword('[trail shoes]')).toEqual({ text: 'trail shoes', match: 'exact' })
    expect(splitGoogleKeyword('red shoes', 'Phrase match')).toEqual({
      text: 'red shoes',
      match: 'phrase',
    })
    expect(exportFieldOf('Amount spent (EUR)')).toBe('cost')
    expect(exportFieldOf('ad set name')).toBe('ad_group')
  })
})

describe('读回核对（照搬「读回自证」）', () => {
  const ops: AdSheetOp[] = [
    { kind: 'create_campaign', campaign: 'New C', daily_budget: 20 },
    { kind: 'create_ad_group', campaign: 'New C', ad_group: 'G1' },
    { kind: 'add_keyword', campaign: 'New C', ad_group: 'G1', text: 'trail shoes', match: 'exact' },
    {
      kind: 'set_budget',
      level: 'campaign',
      ref: { campaign: 'Live One', campaign_id: '1001' },
      before: 200,
      after: 230,
    },
  ]
  const after = (kwStatus: string, budget: string): string =>
    [
      'Campaign,Campaign ID,Campaign state,Budget,Ad group,Ad group ID,Ad group state,Keyword,Status',
      `New C,5001,Paused,20.00,,,,,`,
      `New C,5001,Paused,20.00,G1,6001,Paused,,`,
      `New C,5001,Paused,20.00,G1,6001,Paused,[trail shoes],${kwStatus}`,
      `Live One,1001,Enabled,${budget},,,,,`,
    ].join('\n')

  it('全部对上', () => {
    const r = readBackCheck(ops, parseAdsExport(after('Paused', '230.00')))
    expect(r.items.map((x) => x.result)).toEqual(['ok', 'ok', 'ok', 'ok'])
    expect(r.ok).toBe(true)
    expect(r.sentence).toBe('读回核对：4 条全部对上。')
  })

  it('关键词被启用了、预算没改上 → 照实报', () => {
    const r = readBackCheck(ops, parseAdsExport(after('Enabled', '200.00')))
    expect(r.ok).toBe(false)
    expect(r.items[2]?.result).toBe('mismatch')
    expect(r.items[2]?.message).toContain('应该是暂停')
    expect(r.items[3]?.message).toContain('预算是 200')
    expect(r.sentence).toContain('2 条对不上')
  })

  it('找不到 → missing；「开始投放」那几条能补上编号', () => {
    const r = readBackCheck(
      [{ kind: 'create_campaign', campaign: 'Ghost', daily_budget: 1 }],
      parseAdsExport(after('Paused', '230.00')),
    )
    expect(r.items[0]?.result).toBe('missing')
    const act = attachIdsFromExport(
      activationOpsFor('google', ops),
      parseAdsExport(after('Paused', '230.00')),
    )
    expect(act[0]?.ref.campaign_id).toBe('5001')
    expect(act[1]?.ref.ad_group_id).toBe('6001')
  })
})

describe('Google Ads Editor（决策 561）', () => {
  it('一个文件装所有层级；关键词不带括号、匹配方式单列；新建都是 Paused', () => {
    const f = buildGoogleEditorCsv([
      { kind: 'create_campaign', campaign: 'C', daily_budget: 20 },
      { kind: 'create_ad_group', campaign: 'C', ad_group: 'G' },
      { kind: 'add_keyword', campaign: 'C', ad_group: 'G', text: 'trail shoes', match: 'exact' },
    ])
    expect(f.sheet).toBe('editor')
    const at = (h: string): string[] => f.rows.map((r) => r[f.headers.indexOf(h)] ?? '')
    expect(at('Keyword')).toEqual(['', '', 'trail shoes'])
    expect(at('Criterion Type')).toEqual(['', '', 'Exact'])
    expect(at('Campaign Status')).toEqual(['Paused', '', ''])
    expect(at('Ad Group Status')).toEqual(['', 'Paused', ''])
    expect(at('Status')).toEqual(['', '', 'Paused'])
  })

  it('对照表覆盖网页版每一列；没核实的列都标出来', () => {
    const bulk = new Set(GOOGLE_EDITOR_COLUMN_MAP.map((m) => m.bulk))
    for (const id of [
      'campaign',
      'campaign_status',
      'ad_group',
      'keyword',
      'final_url',
      'budget',
    ] as const)
      expect(bulk.has(GOOGLE_BULK_COLUMNS[id].header)).toBe(true)
    const unverified = Object.values(GOOGLE_BULK_COLUMNS)
      .filter((c) => !c.verified)
      .map((c) => c.header)
    expect(unverified).toContain('Ad group status')
    expect(META_COLUMNS.call_to_action.verified).toBe(false)
  })
})
