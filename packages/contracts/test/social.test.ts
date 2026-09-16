import { describe, expect, it } from 'vitest'
import {
  KOL_CHANNELS,
  SOCIAL_CHANNEL_IDS,
  SOCIAL_CHANNELS,
  SOCIAL_ROLE_IDS,
  socialChannelOfRole,
  socialChannelSpec,
  socialChannelsOfGroup,
} from '../src/index.js'

describe('56 §1 / §2 九条渠道的常量表（WP72）', () => {
  it('九条，顺序 = 岗位模板里的摆法（内容组在前）', () => {
    expect(SOCIAL_CHANNEL_IDS).toEqual([
      'meta',
      'tiktok',
      'x',
      'youtube',
      'facebook_group',
      'reddit',
      'discord',
      'telegram_group',
      'whatsapp',
    ])
  })

  it('内容组四条、社群组五条（56 §0）', () => {
    expect(socialChannelsOfGroup('content').map((c) => c.id)).toEqual([
      'meta',
      'tiktok',
      'x',
      'youtube',
    ])
    expect(socialChannelsOfGroup('community')).toHaveLength(5)
  })

  it('职责 id 写在表里，不由调用方现拼（下划线 → 短横线）', () => {
    expect(SOCIAL_ROLE_IDS).toContain('social.facebook-group')
    expect(SOCIAL_ROLE_IDS).toContain('social.telegram-group')
    expect(socialChannelOfRole('social.discord')?.id).toBe('discord')
    expect(socialChannelOfRole('kol.youtube')).toBeUndefined()
  })

  it('YouTube 与红人岗位共用同一张连接卡（56 §1）——一把 key 管两条职责', () => {
    const social = socialChannelSpec('youtube')
    const kol = KOL_CHANNELS.find((c) => c.id === 'youtube')
    expect(social?.connector_kind).toBe('youtube_data')
    expect(social?.connector_kind).toBe(kol?.connector_kind)
  })

  it('Facebook 群组没有连接卡、走浏览器（Groups API 已停，56 §1）', () => {
    const fb = socialChannelSpec('facebook_group')
    expect(fb?.mode).toBe('browser')
    expect(fb?.connector_kind).toBeUndefined()
    expect(fb?.api_access).toBe('browser_only')
    // 其余八条都是 api 模式，而且都有一张卡
    for (const c of SOCIAL_CHANNELS.filter((x) => x.id !== 'facebook_group')) {
      expect(c.mode).toBe('api')
      expect(c.connector_kind).toMatch(/^[a-z_]+$/)
    }
  })

  it('接口现实写在表里（界面上那句人话靠它，不靠"连接失败"）', () => {
    expect(socialChannelSpec('tiktok')?.api_access).toBe('apply')
    expect(socialChannelSpec('x')?.api_access).toBe('paid')
    expect(socialChannelSpec('whatsapp')?.api_access).toBe('template_optin')
  })

  it('不认识的渠道回 undefined，不编一条出来', () => {
    expect(socialChannelSpec('mastodon')).toBeUndefined()
  })
})
