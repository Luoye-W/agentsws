/**
 * WP487（决策 1661 补）：`sanitizePublicContacts`——主页上公开的联系方式能上云的那几条。
 * 本机服务转发前用它筛，云端用同一份规矩判（拒而不改）。
 */
import { describe, expect, it } from 'vitest'
import {
  MAX_PUBLIC_CONTACTS,
  PUBLIC_CONTACT_FIELDS,
  PUBLIC_OBSERVATION_FIELDS,
  sanitizePublicContacts,
} from '../src/index.js'

describe('sanitizePublicContacts', () => {
  it('白名单只加了 public_contacts 一格；单条只有 kind / value / label', () => {
    expect(PUBLIC_OBSERVATION_FIELDS).toContain('public_contacts')
    // WP495（1707b）又只加了 display_name / profile_url 两格
    expect(PUBLIC_OBSERVATION_FIELDS).toHaveLength(12)
    expect([...PUBLIC_CONTACT_FIELDS]).toEqual(['kind', 'value', 'label'])
  })

  it('规整：mailto / 大小写 / # / 跟踪参数；label 收空白、截到 60 字；别的键丢掉', () => {
    expect(
      sanitizePublicContacts([
        { kind: 'email', value: ' mailto:Hi@Creator.Example?subject=collab ', note: 'x' },
        { kind: 'website', value: 'https://creator.example/p?id=7&utm_medium=bio&fbclid=1#x' },
        { kind: 'business', value: 'Deals@Agency.example', label: `  For   ${'a'.repeat(80)}` },
        { kind: 'agent', value: 'https://agency.example/talent/creator' },
        { kind: 'social', value: 'https://www.facebook.com/profile.php?id=1000' },
      ]),
    ).toEqual([
      { kind: 'email', value: 'hi@creator.example' },
      { kind: 'website', value: 'https://creator.example/p?id=7' },
      { kind: 'business', value: 'deals@agency.example', label: `For ${'a'.repeat(56)}` },
      { kind: 'agent', value: 'https://agency.example/talent/creator' },
      { kind: 'social', value: 'https://www.facebook.com/profile.php?id=1000' },
    ])
  })

  it('私信 / 收件箱 / 登录页、账号密码、凭据参数、非 http(s)：整条不收', () => {
    expect(
      sanitizePublicContacts([
        { kind: 'social', value: 'https://www.instagram.com/direct/t/1234567890' },
        { kind: 'social', value: 'https://www.instagram.com/direct/inbox/' },
        { kind: 'social', value: 'https://x.com/messages/111-222' },
        { kind: 'social', value: 'https://www.facebook.com/messages/t/123' },
        { kind: 'website', value: 'https://creator.example/login' },
        { kind: 'website', value: 'https://user:pw@creator.example/' },
        { kind: 'website', value: 'https://creator.example/?token=abc' },
        { kind: 'website', value: 'https://creator.example/?sessionid=abc' },
        { kind: 'website', value: 'https://creator.example/cb?code=abc&state=xyz' },
        { kind: 'business', value: 'javascript:alert(1)' },
        { kind: 'website', value: 'ftp://creator.example/' },
        { kind: 'website', value: 'hi@creator.example' },
        { kind: 'email', value: 'https://creator.example/' },
        { kind: 'dm', value: 'hey what is your rate' },
        { kind: 'phone', value: '+1 555 0100' },
      ]),
    ).toEqual([])
  })

  it('商务入口里的公开「给我发消息」链接照收（不是私信内容）；折扣码参数照留', () => {
    expect(
      sanitizePublicContacts([
        { kind: 'business', value: 'https://m.me/creatorbrand' },
        { kind: 'business', value: 'https://wa.me/15550100' },
        { kind: 'website', value: 'https://shop.example/?discount=CREATOR10' },
      ]).map((c) => c.value),
    ).toEqual([
      'https://m.me/creatorbrand',
      'https://wa.me/15550100',
      'https://shop.example/?discount=CREATOR10',
    ])
  })

  it('去重、封顶 10 条；不是数组回空', () => {
    const many = Array.from({ length: 15 }, (_, i) => ({
      kind: 'website',
      value: `https://s${i % 12}.example/`,
    }))
    expect(sanitizePublicContacts(many)).toHaveLength(MAX_PUBLIC_CONTACTS)
    expect(
      sanitizePublicContacts([
        { kind: 'email', value: 'a@b.example' },
        { kind: 'email', value: 'A@B.example' },
      ]),
    ).toHaveLength(1)
    expect(sanitizePublicContacts(undefined)).toEqual([])
    expect(sanitizePublicContacts('a@b.example')).toEqual([])
  })
})
