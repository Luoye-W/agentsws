/**
 * WP495（1707b）：导入的红人送公共库时，资料那几格（名字、主页链接、类目、语言、地区）能上云；
 * **报价、备注、合作状态、日期、负责人永远不收**——白名单与生意数据键一个都不许重。
 */
import { describe, expect, it } from 'vitest'
import {
  MAX_CATEGORIES,
  PUBLIC_CONTACT_FIELDS,
  PUBLIC_LIBRARY_BUSINESS_KEYS,
  PUBLIC_OBSERVATION_FIELDS,
  sanitizePublicProfile,
} from '../src/index.js'

describe('白名单只加不删', () => {
  it('资料那几格都在；原来的一格不少', () => {
    for (const key of [
      'channel',
      'handle',
      'followers',
      'posts_30d',
      'engagement_rate',
      'language',
      'region',
      'categories',
      'public_contacts',
      'observed_at',
      'display_name',
      'profile_url',
    ])
      expect(PUBLIC_OBSERVATION_FIELDS as readonly string[]).toContain(key)
  })

  it('生意数据（报价 / 备注 / 合作状态 / 日期 / 负责人）一个键都不在白名单里', () => {
    for (const key of ['price', 'quote', 'notes', 'status', 'agreed_at', 'date', 'owner'])
      expect(PUBLIC_LIBRARY_BUSINESS_KEYS).toContain(key)
    const allowed = new Set<string>([...PUBLIC_OBSERVATION_FIELDS, ...PUBLIC_CONTACT_FIELDS])
    for (const key of PUBLIC_LIBRARY_BUSINESS_KEYS) expect(allowed.has(key)).toBe(false)
  })
})

describe('sanitizePublicProfile', () => {
  it('规整成云端收的形状', () => {
    expect(
      sanitizePublicProfile({
        display_name: '  Kai \n Setup ',
        url: 'https://www.youtube.com/@kaisetuplab?utm_source=sheet#about',
        category: '桌搭, Tech / 数码、桌搭',
        language: 'English',
        region: '美国',
      }),
    ).toEqual({
      display_name: 'Kai Setup',
      profile_url: 'https://www.youtube.com/@kaisetuplab',
      categories: ['桌搭', 'tech', '数码'],
      language: 'en',
      region: 'US',
    })
    expect(sanitizePublicProfile({ language: 'zh-cn', region: 'uk' })).toEqual({
      language: 'zh-CN',
      region: 'GB',
    })
  })

  it('认不出的那一格丢掉、别的照送（不猜、不整条丢）', () => {
    expect(
      sanitizePublicProfile({
        display_name: '   ',
        url: 'https://www.instagram.com/direct/inbox/',
        category: '',
        language: '火星语言很长很长很长很长很长很长',
        region: 'North America',
      }),
    ).toEqual({})
    expect(sanitizePublicProfile({ url: 'https://x.com/a?session=abc', region: 'DE' })).toEqual({
      region: 'DE',
    })
    expect(sanitizePublicProfile({ display_name: 'a'.repeat(300) }).display_name).toHaveLength(200)
    expect(
      sanitizePublicProfile({ category: Array.from({ length: 12 }, (_, i) => `c${i}`).join(',') })
        .categories,
    ).toHaveLength(MAX_CATEGORIES)
  })

  it('入参里多塞生意数据也出不去：只看五格', () => {
    const out = sanitizePublicProfile({
      display_name: 'Kai',
      price: '¥3,000',
      notes: '效果很好别外传',
      status: '已合作',
      agreed_at: '2025-11-10',
      owner: '阿林',
    } as never)
    expect(Object.keys(out)).toEqual(['display_name'])
    const text = JSON.stringify(out)
    for (const leak of ['3,000', '别外传', '已合作', '2025-11-10', '阿林'])
      expect(text).not.toContain(leak)
  })
})
