/**
 * WP405（私有 docs/107 §6 / §7）：岗位更新订阅的契约——动作集、服务 id、桶里的键、摘要怎么算（只加不删）。
 */
import { describe, expect, it } from 'vitest'
import {
  allocationBucketOf,
  CLOUD_SCOPES,
  CONTENT_MANIFEST_SCHEMA,
  CONTENT_SCOPE,
  CONTENT_SERVICE_ID,
  CONTENT_SOURCES,
  type ContentItem,
  type ContentManifest,
  DEFAULT_CLOUD_SCOPES,
  isContentSha256,
  OFFICIAL_CONTENT_KEYS,
  OFFICIAL_CONTENT_PATHS,
  OFFICIAL_CONTENT_SUMMARY_MAX_POSITIONS,
  officialContentChannelOf,
  parseContentPositionsQuery,
  positionsOfContentBlob,
  pricingBlockOf,
  summarizeOfficialContent,
} from '../src/index.js'

const SHA = (c: string): string => c.repeat(64)

const item = (over: Partial<ContentItem> & { id: string }): ContentItem => ({
  kind: 'skill',
  name: over.id.split(':')[1] ?? over.id,
  version: '1.0.0',
  title: { zh: `标题 ${over.id}`, en: `Title ${over.id}` },
  summary: { zh: '正文那句改了什么', en: 'body' },
  upstream: { id: 'official', repo: 'x', commit: 'c', published_at: '2026-10-19', license: 'x' },
  review: {
    reviewer: 'r',
    reviewed_at: '2026-10-19',
    license_before: 'x',
    license_after: 'x',
    scan_hits: 0,
    scan_rules: [],
    notes_ok: true,
    tests_ok: true,
  },
  files: [{ path: 'SKILL.md', sha256: SHA('a'), size: 1 }],
  sha256: SHA('f'),
  ...over,
})

const manifest = (items: ContentItem[]): ContentManifest => ({
  schema: CONTENT_MANIFEST_SCHEMA,
  channel: 'stable',
  source: 'official',
  serial: 7,
  created_at: '2026-10-19T00:00:00.000Z',
  min_app_version: '0.1.0',
  key_id: 'k',
  items,
})

describe('WP405 岗位更新订阅契约', () => {
  it('动作集 content 进默认集；服务 id 是 content.official.monthly，计费归 service、额度归其它', () => {
    expect(CONTENT_SCOPE).toBe('content')
    expect(CLOUD_SCOPES).toContain('content')
    expect(DEFAULT_CLOUD_SCOPES).toContain('content')
    expect(CONTENT_SERVICE_ID).toBe('content.official.monthly')
    expect(pricingBlockOf({ capability: CONTENT_SERVICE_ID })).toBe('service')
    expect(allocationBucketOf(CONTENT_SERVICE_ID)).toBe('other')
    expect(CONTENT_SOURCES).toEqual(['public', 'official'])
  })

  it('桶里的键按渠道放清单与签名、按内容哈希放文件；路径前缀固定', () => {
    expect(OFFICIAL_CONTENT_KEYS.manifest('stable')).toBe('stable/content-manifest.json')
    expect(OFFICIAL_CONTENT_KEYS.signature('beta')).toBe('beta/content-manifest.json.sig')
    expect(OFFICIAL_CONTENT_KEYS.blob(SHA('a'))).toBe(`blobs/${SHA('a')}`)
    expect(OFFICIAL_CONTENT_PATHS.blobs).toBe('/v1/content/official/blobs/')
  })

  it('哈希只认 64 位小写十六进制；渠道不给是 stable、认不出是 undefined', () => {
    expect(isContentSha256(SHA('a'))).toBe(true)
    expect(isContentSha256(SHA('A'))).toBe(false)
    expect(isContentSha256(`${SHA('a')}0`)).toBe(false)
    expect(isContentSha256('../stable/content-manifest.json')).toBe(false)
    expect(officialContentChannelOf(null)).toBe('stable')
    expect(officialContentChannelOf('beta')).toBe('beta')
    expect(officialContentChannelOf('nightly')).toBeUndefined()
  })

  it('positions= 去重去空；不像岗位 id 或太多 = null；不给 = undefined', () => {
    expect(parseContentPositionsQuery(undefined)).toBeUndefined()
    expect(parseContentPositionsQuery(' , ')).toBeUndefined()
    expect(parseContentPositionsQuery('amazon-ops, seo,amazon-ops')).toEqual(['amazon-ops', 'seo'])
    expect(parseContentPositionsQuery('a/../b')).toBeNull()
    const many = Array.from({ length: OFFICIAL_CONTENT_SUMMARY_MAX_POSITIONS + 1 }, (_, i) => `p${i}`)
    expect(parseContentPositionsQuery(many.join(','))).toBeNull()
  })

  it('摘要：只数最近一周、按岗位分、急的标出来、只给标题不给正文', () => {
    const m = manifest([
      item({ id: 'skill:a', positions: ['amazon-ops'], released_at: '2026-10-18T00:00:00.000Z' }),
      item({ id: 'skill:b', positions: ['amazon-ops', 'seo'], urgent: true, released_at: '2026-10-19T08:00:00.000Z' }),
      item({ id: 'skill:old', positions: ['amazon-ops'], released_at: '2026-10-01T00:00:00.000Z' }),
      item({ id: 'skill:none' }),
      // 不写 released_at 按清单 created_at（10-19，在窗口里）
      item({ id: 'skill:c', positions: ['seo'] }),
    ])
    const s = summarizeOfficialContent(m, { now: '2026-10-19T12:00:00.000Z' })
    expect(s.available).toBe(true)
    expect(s.serial).toBe(7)
    expect(s.since).toBe('2026-10-12T12:00:00.000Z')
    expect(s.positions.map((p) => [p.position_id, p.count, p.urgent])).toEqual([
      ['amazon-ops', 2, true],
      ['seo', 2, true],
    ])
    // 新的在前
    expect(s.positions[0]?.titles[0]?.zh).toBe('标题 skill:b')
    expect(JSON.stringify(s)).not.toContain('正文那句改了什么')
    const only = summarizeOfficialContent(m, { now: '2026-10-19T12:00:00.000Z', positions: ['seo'] })
    expect(only.positions.map((p) => p.position_id)).toEqual(['seo'])
  })

  it('一个文件归哪几个岗位：清单里含它的条目的 positions 并起来', () => {
    const m = manifest([
      item({ id: 'skill:a', positions: ['seo'] }),
      item({ id: 'skill:b', positions: ['amazon-ops', 'seo'] }),
      item({ id: 'skill:x', positions: ['kol'], files: [{ path: 'x.md', sha256: SHA('b'), size: 1 }] }),
    ])
    expect(positionsOfContentBlob(m, SHA('a'))).toEqual(['amazon-ops', 'seo'])
    expect(positionsOfContentBlob(m, SHA('c'))).toEqual([])
  })
})
