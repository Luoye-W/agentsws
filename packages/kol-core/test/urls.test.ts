import { describe, expect, it } from 'vitest'
import { isChannelUrl, normalizeHandle, parseCreatorUrl } from '../src/index.js'

describe('五个渠道的链接解析（48 §5.2）', () => {
  it('五条渠道的主页链接都认得出来', () => {
    const cases: [string, string, string][] = [
      ['https://www.youtube.com/@gadgetjonas', 'youtube', 'gadgetjonas'],
      ['https://www.youtube.com/channel/UC123abc', 'youtube', 'uc123abc'],
      ['https://www.facebook.com/nordvolt', 'facebook', 'nordvolt'],
      ['https://www.instagram.com/deskrosa/', 'instagram', 'deskrosa'],
      ['https://www.tiktok.com/@deskrosa', 'tiktok', 'deskrosa'],
      ['https://x.com/deskrosa', 'x', 'deskrosa'],
      ['https://twitter.com/deskrosa', 'x', 'deskrosa'],
    ]
    for (const [url, channel, handle] of cases) {
      const p = parseCreatorUrl(url)
      expect(p?.channel, url).toBe(channel)
      expect(p?.handle, url).toBe(handle)
      expect(p?.target, url).toBe('profile')
    }
  })

  it('内容链接与主页链接分得开（打分要的是一个人的数，不是一条视频的数）', () => {
    expect(parseCreatorUrl('https://www.youtube.com/watch?v=abc123')).toMatchObject({
      channel: 'youtube',
      target: 'content',
      content_id: 'abc123',
    })
    expect(parseCreatorUrl('https://youtu.be/abc123')).toMatchObject({
      channel: 'youtube',
      target: 'content',
      content_id: 'abc123',
    })
    expect(parseCreatorUrl('https://www.instagram.com/p/XYZ789/')).toMatchObject({
      channel: 'instagram',
      target: 'content',
      content_id: 'XYZ789',
    })
    expect(parseCreatorUrl('https://www.tiktok.com/@deskrosa/video/7123')).toMatchObject({
      channel: 'tiktok',
      handle: 'deskrosa',
      target: 'content',
      content_id: '7123',
    })
    expect(parseCreatorUrl('https://x.com/deskrosa/status/999')).toMatchObject({
      channel: 'x',
      handle: 'deskrosa',
      target: 'content',
    })
  })

  it('平台自己的页面不会被认成一个叫 about 的红人', () => {
    for (const url of [
      'https://www.instagram.com/explore/tags/desk',
      'https://x.com/search?q=desk',
      'https://www.facebook.com/watch',
      'https://www.youtube.com/feed/subscriptions',
    ])
      expect(parseCreatorUrl(url)?.target, url).not.toBe('profile')
  })

  it('认不出来就回 undefined，不猜一个渠道', () => {
    expect(parseCreatorUrl('https://xiaohongshu.com/user/123')).toBeUndefined()
    expect(parseCreatorUrl('不是一条链接')).toBeUndefined()
    expect(parseCreatorUrl('')).toBeUndefined()
    expect(parseCreatorUrl('javascript:alert(1)')).toBeUndefined()
  })

  it('不带协议的也认（用户从地址栏抄过来常常没有 https://）', () => {
    expect(parseCreatorUrl('youtube.com/@gadgetjonas')?.handle).toBe('gadgetjonas')
  })

  it('规范链接去掉 query 与 fragment：UTM 不该跟着一条红人记录进库', () => {
    expect(parseCreatorUrl('https://www.instagram.com/deskrosa?utm_source=x#top')?.url).toBe(
      'https://instagram.com/deskrosa',
    )
  })

  it('handle 归一到不带 @ 的小写（不归一同一个账号会躺两条）', () => {
    expect(normalizeHandle('  @GadgetJonas/ ')).toBe('gadgetjonas')
    expect(isChannelUrl('https://www.tiktok.com/@X', 'tiktok')).toBe(true)
    expect(isChannelUrl('https://www.tiktok.com/@X', 'youtube')).toBe(false)
  })
})
