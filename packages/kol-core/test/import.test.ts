import { describe, expect, it } from 'vitest'
import { importAccounts, importSummary, mapHeader } from '../src/index.js'

describe('Excel / CSV 导入（48 §5.2）', () => {
  it('中英表头都认得出来，认不出的那一列说出来而不是按位置猜', () => {
    expect(mapHeader('  粉丝数 ')).toBe('followers')
    expect(mapHeader('Followers')).toBe('followers')
    expect(mapHeader('主页')).toBe('url')
    expect(mapHeader('内部备注')).toBeUndefined()

    const r = importAccounts([['链接', '粉丝数', '内部备注']])
    expect(r.mapping.unmapped).toEqual(['内部备注'])
  })

  it('渠道以链接为准（链接是事实，列里那个字是人打的）', () => {
    const r = importAccounts([
      ['链接', '渠道'],
      ['https://www.tiktok.com/@deskrosa', 'youtube'],
    ])
    expect(r.accounts[0]).toMatchObject({ channel: 'tiktok', handle: 'deskrosa' })
  })

  it('没有链接时靠"渠道 + 账号名"两列一起', () => {
    const r = importAccounts([
      ['平台', '用户名'],
      ['instagram', '@DeskRosa'],
    ])
    expect(r.accounts[0]).toMatchObject({ channel: 'instagram', handle: 'deskrosa' })
  })

  it('去重只按 渠道 + handle，重复行报得出是跟第几行重的', () => {
    const r = importAccounts([
      ['链接'],
      ['https://www.youtube.com/@gadgetjonas'],
      ['https://youtube.com/@GadgetJonas/'],
      ['https://www.instagram.com/gadgetjonas'],
    ])
    expect(r.accounts).toHaveLength(2)
    expect(r.duplicates).toEqual([
      { source_row: 3, same_as_row: 2, handle: 'gadgetjonas', channel: 'youtube' },
    ])
  })

  it('认不出来的行进 rejected 并指得回原表行号', () => {
    const r = importAccounts([
      ['链接'],
      ['https://xiaohongshu.com/user/1'],
      [''],
      ['https://www.youtube.com/@ok'],
    ])
    expect(r.rejected).toHaveLength(1)
    expect(r.rejected[0]?.source_row).toBe(2)
    expect(r.rejected[0]?.reason).toContain('认不出')
    expect(r.accounts).toHaveLength(1)
  })

  it('粉丝数的几种人写法都读得进来', () => {
    const r = importAccounts([
      ['链接', '粉丝'],
      ['https://www.youtube.com/@a', '48,000'],
      ['https://www.youtube.com/@b', '1.2M'],
      ['https://www.youtube.com/@c', '3.5万'],
      ['https://www.youtube.com/@d', '12K'],
    ])
    expect(r.accounts.map((a) => a.followers)).toEqual([48_000, 1_200_000, 35_000, 12_000])
  })

  it('互动率归一到 0–1：3.2% 与 3.2 都是 0.032', () => {
    const r = importAccounts([
      ['链接', '互动率'],
      ['https://www.youtube.com/@a', '3.2%'],
      ['https://www.youtube.com/@b', '3.2'],
      ['https://www.youtube.com/@c', '0.032'],
    ])
    for (const a of r.accounts) expect(a.engagement_rate).toBeCloseTo(0.032, 6)
  })

  it('同一个字段被两列认到时用第一列，第二列当没用上', () => {
    const r = importAccounts([
      ['链接', '粉丝数', 'followers'],
      ['https://www.youtube.com/@a', '100', '999'],
    ])
    expect(r.accounts[0]?.followers).toBe(100)
    expect(r.mapping.unmapped).toEqual(['followers'])
  })

  it('导完那一句话把四件事都说了', () => {
    const r = importAccounts([
      ['链接', '内部备注'],
      ['https://www.youtube.com/@a', 'x'],
      ['https://www.youtube.com/@a', 'x'],
      ['nope', 'x'],
    ])
    const s = importSummary(r)
    expect(s).toContain('认出 1 个账号')
    expect(s).toContain('重复 1 行')
    expect(s).toContain('1 行认不出来')
    expect(s).toContain('内部备注')
  })

  it('空表不炸', () => {
    expect(importAccounts([]).accounts).toEqual([])
  })
})
