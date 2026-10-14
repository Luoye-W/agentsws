/**
 * WP314：Google 批量上传 CSV（docs/101 §2.1；决策 552 / 553）。
 * 样例全部手写（假名字、假编号），没有任何真实账户数据。
 */
import { describe, expect, it } from 'vitest'
import {
  type AdSheetOp,
  type AdUploadFile,
  buildAdUploadBundle,
  bundleFingerprint,
  checkNewRowsPaused,
  googleTextLength,
  parseDelimited,
  routeAdChange,
} from '../src/index.js'

const HEADLINES = ['Trail Shoes Sale', 'Free Shipping Over $50', 'Light And Grippy']
const DESCS = ['Built for wet rocks and long climbs.', 'Order today, ships in 2 days.']

const NEW_CAMPAIGN: AdSheetOp[] = [
  {
    kind: 'create_campaign',
    campaign: 'Test Trail',
    daily_budget: 30,
    google: { networks: ['Google search'], languages: ['en'], locations: ['United States'] },
  },
  {
    kind: 'create_ad_group',
    campaign: 'Test Trail',
    ad_group: 'Waterproof',
    google: { max_cpc: 1.2 },
  },
  {
    kind: 'create_ad',
    campaign: 'Test Trail',
    ad_group: 'Waterproof',
    final_url: 'https://shop.example.com/trail',
    google: { headlines: HEADLINES, descriptions: DESCS, path1: 'trail' },
  },
  {
    kind: 'add_keyword',
    campaign: 'Test Trail',
    ad_group: 'Waterproof',
    text: 'trail shoes',
    match: 'exact',
  },
  {
    kind: 'add_keyword',
    campaign: 'Test Trail',
    ad_group: 'Waterproof',
    text: 'hiking shoes',
    match: 'phrase',
  },
  {
    kind: 'add_keyword',
    campaign: 'Test Trail',
    ad_group: 'Waterproof',
    text: 'shoes',
    match: 'broad',
  },
]

const sheet = (files: readonly AdUploadFile[], id: string): AdUploadFile => {
  const f = files.find((x) => x.sheet === id)
  if (f === undefined) throw new Error(`没有 ${id}`)
  return f
}
const col = (f: AdUploadFile, h: string): string[] =>
  f.rows.map((r) => r[f.headers.indexOf(h)] ?? '')

describe('新建一整套（553：一律暂停）', () => {
  const b = buildAdUploadBundle({ platform: 'google', ops: NEW_CAMPAIGN })

  it('没问题、按上传顺序出四张表、审批级别 L1', () => {
    expect(b.problems.filter((p) => p.severity === 'error')).toEqual([])
    expect(b.ok).toBe(true)
    expect(b.files.map((f) => f.sheet)).toEqual(['campaigns', 'ad_groups', 'ads', 'keywords'])
    expect(b.approval_level).toBe('L1')
  })

  it('广告系列表头照官方模板写法、新建行 Action=Add 且状态写死 Paused', () => {
    const f = sheet(b.files, 'campaigns')
    expect(f.headers.slice(0, 2)).toEqual(['Action', 'Campaign status'])
    expect(f.headers).toContain('Bid strategy type')
    expect(col(f, 'Action')).toEqual(['Add'])
    expect(col(f, 'Campaign status')).toEqual(['Paused'])
    expect(col(f, 'Budget')).toEqual(['30.00'])
    expect(col(f, 'Campaign type')).toEqual(['Search'])
    expect(col(f, 'Bid strategy type')).toEqual(['Manual CPC'])
  })

  it('每一张表的每一行新建都是 Paused', () => {
    for (const f of b.files) {
      const st = f.headers.find((h) => /status$/i.test(h)) as string
      expect(col(f, st).every((s) => s === 'Paused')).toBe(true)
    }
  })

  it('关键词照官方「Add Keyword(s)」模板：纯文字 + Match Type 列', () => {
    const f = sheet(b.files, 'keywords')
    expect(f.headers).toEqual([
      'Action',
      'Keyword status',
      'Campaign',
      'Ad group',
      'Keyword',
      'Match Type',
    ])
    expect(col(f, 'Keyword')).toEqual(['trail shoes', 'hiking shoes', 'shoes'])
    expect(col(f, 'Match Type')).toEqual(['Exact Match', 'Phrase Match', 'Broad Match'])
    const parsed = parseDelimited(f.content as string, ',')
    expect(parsed[2]?.[parsed[0]?.indexOf('Keyword') ?? -1]).toBe('hiking shoes')
  })

  it('广告组表照官方「Create Ad Group(s)」模板：状态列叫 Status', () => {
    const f = sheet(b.files, 'ad_groups')
    expect(f.headers).toEqual(['Action', 'Status', 'Campaign', 'Ad group', 'Default max. CPC'])
    expect(col(f, 'Status')).toEqual(['Paused'])
  })

  it('广告表：标题 / 描述 / 路径 / 落地页；没用到的标题列不出', () => {
    const f = sheet(b.files, 'ads')
    expect(col(f, 'Headline 3')).toEqual(['Light And Grippy'])
    expect(f.headers).not.toContain('Headline 4')
    // 官方 RSA 模板：第一条描述叫 Description（没有序号），第二条起 Description 2
    expect(col(f, 'Description')).toEqual([DESCS[0]])
    expect(col(f, 'Description 2')).toEqual([DESCS[1]])
    expect(f.headers).not.toContain('Description 1')
    expect(col(f, 'Ad status')).toEqual(['Paused'])
    expect(col(f, 'Final URL')).toEqual(['https://shop.example.com/trail'])
    expect(col(f, 'Ad type')).toEqual(['Responsive search ad'])
  })

  it('摘要一句话 + 「开始投放」要启用的清单', () => {
    expect(b.summary.sentence).toBe(
      'Google 广告：新建 1 个广告系列、1 个广告组、1 条广告、3 个关键词，都先暂停。',
    )
    expect(b.activation_ops.map((o) => o.level)).toEqual([
      'campaign',
      'ad_group',
      'ad',
      'keyword',
      'keyword',
      'keyword',
    ])
    expect(b.activation_ops.every((o) => o.status === 'enabled')).toBe(true)
  })
})

describe('复查：生成出来的表里新建不是暂停就拦', () => {
  it('有人把状态改成 Enabled → error', () => {
    const b = buildAdUploadBundle({ platform: 'google', ops: NEW_CAMPAIGN })
    const f = sheet(b.files, 'campaigns')
    const tampered: AdUploadFile = {
      ...f,
      rows: f.rows.map((r) => r.map((c) => (c === 'Paused' ? 'Enabled' : c))),
    }
    const p = checkNewRowsPaused([tampered])
    expect(p).toHaveLength(1)
    expect(p[0]?.code).toBe('new_not_paused')
    expect(p[0]?.message).toContain('留空就是启用')
  })

  it('状态列被删掉也拦', () => {
    const f: AdUploadFile = {
      name: 'x.csv',
      mime: 'text/csv',
      content: '',
      sheet: 'keywords',
      upload_from: '',
      headers: ['Action', 'Campaign', 'Ad group', 'Keyword'],
      rows: [['Add', 'C', 'G', 'k']],
    }
    expect(checkNewRowsPaused([f])[0]?.code).toBe('new_not_paused')
  })
})

describe('改预算 / 暂停（Action=Edit）', () => {
  const ref = { campaign: 'Live One', campaign_id: '1001' }

  it('额度内提预算：只写 Budget，状态列留空', () => {
    const b = buildAdUploadBundle({
      platform: 'google',
      ops: [{ kind: 'set_budget', level: 'campaign', ref, before: 200, after: 230 }],
    })
    expect(b.ok).toBe(true)
    const f = sheet(b.files, 'campaigns')
    expect(col(f, 'Action')).toEqual(['Edit'])
    expect(col(f, 'Campaign ID')).toEqual(['1001'])
    expect(col(f, 'Budget')).toEqual(['230.00'])
    expect(f.headers).not.toContain('Campaign status')
    expect(b.summary.sentence).toBe('Google 广告：Live One 预算从 ¥200 改到 ¥230。')
  })

  it('超 20% 额度：默认拦；标成超额 L1 卡就只提醒', () => {
    const op: AdSheetOp = { kind: 'set_budget', level: 'campaign', ref, before: 200, after: 300 }
    const blocked = buildAdUploadBundle({ platform: 'google', ops: [op] })
    expect(blocked.ok).toBe(false)
    expect(blocked.files).toEqual([])
    expect(blocked.problems[0]?.code).toBe('budget_over_cap')
    expect(blocked.problems[0]?.message).toContain('超过 20%')
    const allowed = buildAdUploadBundle({
      platform: 'google',
      ops: [op],
      context: { allow_over_cap: true },
    })
    expect(allowed.ok).toBe(true)
    expect(allowed.problems[0]?.severity).toBe('warning')
  })

  it('降预算不卡额度；但日花费总闸满了的提预算要拦', () => {
    const down = buildAdUploadBundle({
      platform: 'google',
      ops: [{ kind: 'set_budget', level: 'campaign', ref, before: 200, after: 50 }],
    })
    expect(down.ok).toBe(true)
    const capped = buildAdUploadBundle({
      platform: 'google',
      ops: [{ kind: 'set_budget', level: 'campaign', ref, before: 200, after: 220 }],
      context: { spend_today_by_platform: { google: 600, meta: 395 } },
    })
    expect(capped.problems.map((p) => p.code)).toContain('daily_cap')
  })

  it('改已有广告系列不带编号 → error；暂停关键词写官方匹配符号', () => {
    const noId = buildAdUploadBundle({
      platform: 'google',
      ops: [
        { kind: 'set_status', level: 'campaign', ref: { campaign: 'Live One' }, status: 'paused' },
      ],
    })
    expect(noId.problems[0]?.code).toBe('missing_id')
    const kw = buildAdUploadBundle({
      platform: 'google',
      ops: [
        {
          kind: 'set_status',
          level: 'keyword',
          ref: { campaign: 'Live One', ad_group: 'G1', keyword: 'red shoes', match: 'phrase' },
          status: 'paused',
        },
      ],
    })
    const f = sheet(kw.files, 'keywords')
    expect(col(f, 'Keyword')).toEqual(['red shoes'])
    expect(col(f, 'Match Type')).toEqual(['Phrase Match'])
    expect(col(f, 'Keyword status')).toEqual(['Paused'])
    expect(col(f, 'Action')).toEqual(['Edit'])
  })
})

describe('文案校验', () => {
  const ad = (
    headlines: string[],
    descriptions = DESCS,
    url = 'https://shop.example.com',
  ): AdSheetOp => ({
    kind: 'create_ad',
    campaign: 'Live One',
    ad_group: 'G1',
    final_url: url,
    google: { headlines, descriptions },
  })

  it('中日韩字算 2 个字符：16 个汉字就超 30', () => {
    expect(googleTextLength('春季徒步鞋')).toBe(10)
    expect(googleTextLength('abc')).toBe(3)
    const b = buildAdUploadBundle({
      platform: 'google',
      ops: [ad(['一二三四五六七八九十一二三四五六', 'b', 'c'])],
    })
    expect(b.problems.map((p) => p.code)).toContain('too_long')
  })

  it('标题少于 3 条、网址没写 https、禁用词、以 = 开头，都拦', () => {
    const b = buildAdUploadBundle({
      platform: 'google',
      ops: [ad(['Only one'], DESCS, 'shop.example.com'), ad(['全网最低价', '=SUM(A1)', 'ok'])],
    })
    const codes = b.problems.map((p) => p.code)
    expect(codes).toEqual(
      expect.arrayContaining(['count', 'bad_url', 'forbidden_copy', 'formula_like']),
    )
    expect(b.ok).toBe(false)
  })

  it('品牌禁用词也拦', () => {
    const b = buildAdUploadBundle({
      platform: 'google',
      ops: [ad(['Cheapest Trail Shoes', 'b2', 'c3'])],
      context: { banned_terms: ['cheapest'] },
    })
    expect(b.problems.find((p) => p.code === 'forbidden_copy')?.message).toContain('cheapest')
  })
})

describe('走表还是直接点（552）与指纹', () => {
  it('有新建 / 3 条以上走表；1–2 条暂停改预算直接点', () => {
    expect(routeAdChange(NEW_CAMPAIGN.slice(0, 1)).route).toBe('sheet')
    const pause: AdSheetOp = {
      kind: 'set_status',
      level: 'campaign',
      ref: { campaign: 'A', campaign_id: '1' },
      status: 'paused',
    }
    expect(routeAdChange([pause, pause]).route).toBe('form')
    expect(routeAdChange([pause, pause, pause]).route).toBe('sheet')
  })

  it('同一批 op 指纹稳定；改一个字就变', () => {
    const a = buildAdUploadBundle({ platform: 'google', ops: NEW_CAMPAIGN })
    const b = buildAdUploadBundle({ platform: 'google', ops: NEW_CAMPAIGN })
    expect(a.fingerprint).toBe(b.fingerprint)
    expect(a.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    const f = a.files[0] as AdUploadFile
    expect(
      bundleFingerprint([{ ...f, content: `${f.content as string} ` }, ...a.files.slice(1)]),
    ).not.toBe(a.fingerprint)
  })
})
