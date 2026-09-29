import { describe, expect, it } from 'vitest'
import {
  ACTIVE_SOCIAL_CHANNELS,
  ACTIVE_SOCIAL_ROLE_IDS,
  KOL_CHANNELS,
  SOCIAL_CHANNEL_IDS,
  SOCIAL_CHANNELS,
  SOCIAL_ROLE_IDS,
  socialChannelHeirs,
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
      // WP191（docs/86）：内容账号组末尾加四条，只加不改
      'facebook',
      'instagram',
      'threads',
      'linkedin',
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
      'facebook',
      'instagram',
      'threads',
      'linkedin',
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

describe('WP191（docs/86 §5 / §6）Meta 拆成三条、加 LinkedIn', () => {
  it('meta 不删，标 superseded_by：FB 主页 + IG 接手；新建岗位只读还在用的那一份', () => {
    expect(socialChannelHeirs('meta')).toEqual(['facebook', 'instagram'])
    expect(socialChannelHeirs('facebook')).toBeUndefined()
    expect(ACTIVE_SOCIAL_CHANNELS.map((c) => c.id)).not.toContain('meta')
    expect(ACTIVE_SOCIAL_ROLE_IDS).not.toContain('social.meta')
    expect(ACTIVE_SOCIAL_ROLE_IDS).toHaveLength(SOCIAL_CHANNELS.length - 1)
    // 接手的渠道都在表里，而且自己不是老渠道
    for (const heir of socialChannelHeirs('meta') ?? [])
      expect(socialChannelSpec(heir)?.superseded_by).toBeUndefined()
  })

  it('FB 与 IG 共用一张 meta_graph（连一次、批一次）；Threads 与 LinkedIn 各一张新卡', () => {
    expect(socialChannelSpec('facebook')?.connector_kind).toBe('meta_graph')
    expect(socialChannelSpec('instagram')?.connector_kind).toBe('meta_graph')
    expect(socialChannelSpec('meta')?.connector_kind).toBe('meta_graph')
    expect(socialChannelSpec('threads')?.connector_kind).toBe('threads_api')
    expect(socialChannelSpec('linkedin')?.connector_kind).toBe('linkedin_api')
  })

  it('LinkedIn：申请制 + 到点发不出去变待办；别的渠道没有这一格', () => {
    expect(socialChannelSpec('linkedin')?.api_access).toBe('apply')
    expect(socialChannelSpec('linkedin')?.publish_fallback).toBe('manual_task')
    for (const c of SOCIAL_CHANNELS.filter((x) => x.id !== 'linkedin'))
      expect(c.publish_fallback, c.id).toBeUndefined()
  })
})
