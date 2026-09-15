import { describe, expect, it } from 'vitest'
import {
  type Collaboration,
  type CreatorContact,
  KOL_CHANNEL_IDS,
  KOL_CHANNELS,
  kolChannelSpec,
  type PlatformAccount,
} from '../src/index.js'

describe('48 §5.1 五条渠道的常量表（WP67）', () => {
  it('五条，顺序即界面上的出场顺序', () => {
    expect(KOL_CHANNEL_IDS).toEqual(['youtube', 'facebook', 'instagram', 'tiktok', 'x'])
  })

  it('每条都有连接器 kind 与"数据怎么拿得到"——界面上那句人话靠它', () => {
    for (const c of KOL_CHANNELS) {
      expect(c.connector_kind).toMatch(/^[a-z_]+$/)
      expect(['official', 'apply', 'paid', 'plugin_only']).toContain(c.api_access)
      expect(c.zh.length).toBeGreaterThan(0)
      expect(c.icon.length).toBeGreaterThan(0)
    }
  })

  it('连接器 kind 互不重复：一条渠道一张连接卡', () => {
    const kinds = KOL_CHANNELS.map((c) => c.connector_kind)
    expect(new Set(kinds).size).toBe(kinds.length)
  })

  it('认不出来的渠道回 undefined，不编一条出来', () => {
    expect(kolChannelSpec('youtube')?.api_access).toBe('official')
    // TikTok 的 Research API 是申请制，X 的是付费档——界面上说的就是这两句
    expect(kolChannelSpec('tiktok')?.api_access).toBe('apply')
    expect(kolChannelSpec('x')?.api_access).toBe('paid')
    expect(kolChannelSpec('xiaohongshu')).toBeUndefined()
  })
})

describe('48 §5.2 六个对象的形状', () => {
  it('同一个人在两条渠道是两条 platform_account（渠道之间零共享数据）', () => {
    const a: PlatformAccount = {
      id: 'pa_1',
      creator_id: 'cre_1',
      channel: 'youtube',
      handle: 'gadgetjonas',
      url: 'https://www.youtube.com/@gadgetjonas',
      followers: 48_000,
      observed_at: '2026-09-15T00:00:00Z',
    }
    const b: PlatformAccount = { ...a, id: 'pa_2', channel: 'instagram', followers: 12_000 }
    expect(a.creator_id).toBe(b.creator_id)
    expect(a.id).not.toBe(b.id)
  })

  it('联系方式只有加密库 key 名，类型里就没有放明文的地方', () => {
    const c: CreatorContact = {
      id: 'cc_1',
      creator_id: 'cre_1',
      kind: 'email',
      value_ref: 'kol:contact:cc_1',
      source: 'channel_about',
    }
    expect(Object.keys(c)).not.toContain('value')
    expect(c.value_ref).not.toContain('@')
  })

  it('合作带渠道：同一个人两条渠道各一条合作，额度各算各的', () => {
    const yt: Collaboration = {
      id: 'col_1',
      creator_id: 'cre_1',
      channel: 'youtube',
      stage: 'sourced',
      currency: 'USD',
    }
    const ig: Collaboration = { ...yt, id: 'col_2', channel: 'instagram' }
    expect(yt.channel).not.toBe(ig.channel)
  })
})
