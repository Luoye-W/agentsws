/**
 * WP314：Meta 批量导入表（docs/101 §3.1；决策 553）。
 * 样例全部手写（假主页编号、假图片哈希），没有任何真实账户数据。
 */
import { describe, expect, it } from 'vitest'
import {
  type AdSheetOp,
  type AdUploadFile,
  buildAdUploadBundle,
  parseAdsExport,
  parseDelimited,
  protectMetaCell,
} from '../src/index.js'

const HASH = '0123456789abcdef0123456789abcdef'

const NEW_SET: AdSheetOp[] = [
  { kind: 'create_campaign', campaign: 'Test Spring', meta: { objective: 'OUTCOME_SALES' } },
  {
    kind: 'create_ad_group',
    campaign: 'Test Spring',
    ad_group: 'US 25-44',
    meta: { daily_budget: 40, countries: ['US'], age_min: 25, age_max: 44 },
  },
  {
    kind: 'create_ad',
    campaign: 'Test Spring',
    ad_group: 'US 25-44',
    final_url: 'https://shop.example.com/spring',
    meta: {
      body: '+20% off your next pair',
      title: 'Spring trail shoes',
      page_id: '123456789',
      image_file: 'spring-01.jpg',
      call_to_action: 'SHOP_NOW',
    },
  },
  {
    kind: 'create_ad',
    campaign: 'Test Spring',
    ad_group: 'US 25-44',
    final_url: 'https://shop.example.com/spring',
    meta: { body: 'Grip on wet rock.', page_id: '123456789', image_hash: HASH },
  },
]

const only = (b: { files: AdUploadFile[] }, id: string): AdUploadFile => {
  const f = b.files.find((x) => x.sheet === id)
  if (f === undefined) throw new Error(`没有 ${id}`)
  return f
}
const col = (f: AdUploadFile, h: string): string[] =>
  f.rows.map((r) => r[f.headers.indexOf(h)] ?? '')

describe('新建（编号列全空、三层都 PAUSED）', () => {
  const b = buildAdUploadBundle({ platform: 'meta', ops: NEW_SET })
  const f = only(b, 'meta_new')

  it('一行一条广告，带着广告组与广告系列', () => {
    expect(b.ok).toBe(true)
    expect(f.rows).toHaveLength(2)
    expect(col(f, 'Campaign Name')).toEqual(['Test Spring', 'Test Spring'])
    expect(col(f, 'Ad Set Name')).toEqual(['US 25-44', 'US 25-44'])
    expect(col(f, 'Campaign ID')).toEqual(['', ''])
    expect(col(f, 'Ad ID')).toEqual(['', ''])
  })

  it('三层状态都是 PAUSED；预算两位小数；主页写成 o:编号', () => {
    for (const h of ['Campaign Status', 'Ad Set Status', 'Ad Status'])
      expect(col(f, h)).toEqual(['PAUSED', 'PAUSED'])
    expect(col(f, 'Ad Set Daily Budget')).toEqual(['40.00', '40.00'])
    expect(col(f, 'Link Object ID')).toEqual(['o:123456789', 'o:123456789'])
    expect(col(f, 'Ad Name')).toEqual(['US 25-44 · 1', 'US 25-44 · 2'])
  })

  it('以 + 开头的正文按 Meta 导出同款写成「< > 原文」', () => {
    expect(col(f, 'Body')[0]).toBe('< > +20% off your next pair')
    expect(protectMetaCell('@home')).toBe('< > @home')
    expect(protectMetaCell('plain')).toBe('plain')
  })

  it('同时给 .xlsx 与可粘贴文字（制表符）', () => {
    expect(f.name).toBe('meta-new-ads.xlsx')
    expect(f.content).toBeInstanceOf(Uint8Array)
    const pasted = parseDelimited(f.paste_text ?? '', '\t')
    expect(pasted[0]).toEqual([...f.headers])
    expect(pasted).toHaveLength(3)
  })

  it('摘要与启用清单（Meta 没有关键词）', () => {
    expect(b.summary.sentence).toBe(
      'Meta 广告：新建 1 个广告系列、1 个广告组、2 条广告，都先暂停。',
    )
    expect(b.activation_ops.map((o) => o.ref.ad ?? o.level)).toEqual([
      'campaign',
      'ad_group',
      'US 25-44 · 1',
      'US 25-44 · 2',
    ])
  })
})

describe('Meta 专属的拦法', () => {
  it('广告系列上写预算、加关键词、图片两样都给 / 都不给 → error', () => {
    const b = buildAdUploadBundle({
      platform: 'meta',
      ops: [
        {
          kind: 'create_campaign',
          campaign: 'X',
          daily_budget: 10,
          meta: { objective: 'OUTCOME_SALES' },
        },
        { kind: 'add_keyword', campaign: 'X', ad_group: 'G', text: 'shoes', match: 'broad' },
        {
          kind: 'create_ad',
          campaign: 'X',
          ad_group: 'G',
          final_url: 'https://shop.example.com',
          meta: { body: 'Hi', page_id: '1', image_file: 'a.jpg', image_hash: HASH },
        },
      ],
    })
    const codes = b.problems.map((p) => p.code)
    expect(codes).toEqual(expect.arrayContaining(['unsupported', 'missing', 'missing_parent_id']))
    expect(b.files).toEqual([])
  })

  it('挂在已有广告组下的新广告：上级没编号 → error（Meta 会当成再建一个）', () => {
    const b = buildAdUploadBundle({
      platform: 'meta',
      ops: [
        {
          kind: 'create_ad',
          campaign: 'Live',
          ad_group: 'Live set',
          final_url: 'https://shop.example.com',
          meta: { body: 'Hi', page_id: '1', image_hash: HASH },
        },
      ],
    })
    expect(b.problems.filter((p) => p.code === 'missing_parent_id')).toHaveLength(2)
    const ok = buildAdUploadBundle({
      platform: 'meta',
      ops: [
        {
          kind: 'create_ad',
          campaign: 'Live',
          campaign_id: '2001',
          ad_group: 'Live set',
          ad_group_id: '3001',
          final_url: 'https://shop.example.com',
          meta: { body: 'Hi', page_id: '1', image_hash: HASH },
        },
      ],
    })
    expect(ok.ok).toBe(true)
    const f = only(ok, 'meta_new')
    expect(col(f, 'Ad Set ID')).toEqual(['3001'])
    expect(col(f, 'Ad Set Status')).toEqual([''])
    expect(col(f, 'Ad Status')).toEqual(['PAUSED'])
  })

  it('正文超 125 字只提醒不拦', () => {
    const b = buildAdUploadBundle({
      platform: 'meta',
      ops: [
        {
          kind: 'create_ad',
          campaign: 'Live',
          campaign_id: '2001',
          ad_group: 'S',
          ad_group_id: '3001',
          final_url: 'https://shop.example.com',
          meta: { body: 'a'.repeat(130), page_id: '1', image_hash: HASH },
        },
      ],
    })
    expect(b.ok).toBe(true)
    expect(b.problems.find((p) => p.code === 'too_long')?.severity).toBe('warning')
  })
})

/** 手写的一份「改前导出」：一行一条广告，Body 带 Meta 的 `< >` 前缀。 */
const BEFORE_TSV = [
  'Campaign ID\tCampaign Name\tCampaign Status\tAd Set ID\tAd Set Name\tAd Set Run Status\tAd Set Daily Budget\tAd ID\tAd Name\tAd Status\tBody',
  '2001\tLive\tACTIVE\t3001\tLive set\tACTIVE\t50\t4001\tAd A\tACTIVE\t< > +10% today',
  '2001\tLive\tACTIVE\t3001\tLive set\tACTIVE\t50\t4002\tAd B\tACTIVE\tPlain copy',
].join('\n')

describe('改已有（照官方：导出 → 在原行上改 → 导入）', () => {
  const before = parseAdsExport(BEFORE_TSV)
  const budget: AdSheetOp = {
    kind: 'set_budget',
    level: 'ad_group',
    ref: { campaign: 'Live', campaign_id: '2001', ad_group: 'Live set', ad_group_id: '3001' },
    before: 50,
    after: 55,
  }

  it('给了改前导出：用原列原行，只改预算那一格，`< >` 前缀原样带回', () => {
    const b = buildAdUploadBundle({ platform: 'meta', ops: [budget], before })
    expect(b.ok).toBe(true)
    const f = only(b, 'meta_edit')
    expect(f.headers).toEqual(before.headers)
    expect(col(f, 'Ad Set Daily Budget')).toEqual(['55.00', '55.00'])
    expect(col(f, 'Ad ID')).toEqual(['4001', '4002'])
    expect(col(f, 'Body')).toEqual(['< > +10% today', 'Plain copy'])
    expect(b.summary.rows[0]).toMatchObject({
      action: '改预算',
      before: '¥50',
      after: '¥55（+10%）',
    })
  })

  it('暂停一条广告：摘要里的「改前」从导出里取', () => {
    const b = buildAdUploadBundle({
      platform: 'meta',
      ops: [
        {
          kind: 'set_status',
          level: 'ad',
          ref: { campaign: 'Live', ad_group: 'Live set', ad: 'Ad B', ad_id: '4002' },
          status: 'paused',
        },
      ],
      before,
    })
    const f = only(b, 'meta_edit')
    expect(f.rows).toHaveLength(1)
    expect(col(f, 'Ad Status')).toEqual(['PAUSED'])
    expect(b.summary.rows[0]).toMatchObject({ action: '暂停', before: '启用', after: '暂停' })
  })

  it('导出里找不到这条 → error；没给改前导出 → 只出最少的列并提醒', () => {
    const missing = buildAdUploadBundle({
      platform: 'meta',
      ops: [{ ...budget, ref: { ...budget.ref, ad_group_id: '9999' } } as AdSheetOp],
      before,
    })
    expect(missing.problems[0]?.code).toBe('not_in_before')
    expect(missing.ok).toBe(false)
    const bare = buildAdUploadBundle({ platform: 'meta', ops: [budget] })
    expect(bare.ok).toBe(true)
    expect(bare.problems.map((p) => p.code)).toEqual(['no_before_export'])
    const f = only(bare, 'meta_edit')
    expect(f.headers).toEqual([
      'Campaign ID',
      'Campaign Name',
      'Ad Set ID',
      'Ad Set Name',
      'Ad Set Daily Budget',
      'Ad ID',
      'Ad Name',
    ])
  })

  it('改已有不带编号 → error（编号空着的行 Meta 当新建）', () => {
    const b = buildAdUploadBundle({
      platform: 'meta',
      ops: [
        {
          kind: 'set_status',
          level: 'ad_group',
          ref: { campaign: 'Live', ad_group: 'Live set' },
          status: 'paused',
        },
      ],
    })
    expect(b.problems[0]?.message).toContain('当成新建')
  })
})
