/**
 * WP406（私有 docs/107 §7）：内容包按来源验——官方订阅的清单写 `source: 'official'`，只走官方那条通道；
 * 条目 id 放宽到带下划线（`role_content:…`、`rules:seo.claim_rules`），老 id 照认。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildContentPack,
  CONTENT_ITEM_ID,
  ContentPackError,
  contentPublicKeyOf,
  verifyContentManifest,
} from '../src/index.js'
import { meta, skillDir, testKey } from './content-helpers.js'

function build(source: 'official' | undefined) {
  const root = mkdtempSync(join(tmpdir(), 'wp406-src-'))
  const key = testKey()
  const rules = join(root, 'rules')
  mkdirSync(rules, { recursive: true })
  writeFileSync(join(rules, 'content.json'), JSON.stringify({ table: 'seo.claim_rules', rows: [] }))
  const built = buildContentPack({
    channel: 'stable',
    serial: 1,
    created_at: '2026-10-19T00:00:00.000Z',
    min_app_version: '0.0.0',
    privateKeyPem: key,
    ...(source === undefined ? {} : { source }),
    items: [
      { meta: meta('demo', '1.1.0'), dir: skillDir(root, 'demo', '新版') },
      {
        meta: {
          ...meta('seo.claim_rules', '1.0.1'),
          id: 'rules:seo.claim_rules',
          kind: 'rules',
          name: 'seo.claim_rules',
        },
        dir: rules,
      },
    ],
  })
  return { built, key: contentPublicKeyOf(key) }
}

const verify = (b: ReturnType<typeof build>, source?: 'official' | 'public') =>
  verifyContentManifest(b.built.manifestBytes, b.built.signature, {
    keys: [b.key],
    appVersion: '1.0.0',
    channel: 'stable',
    ...(source === undefined ? {} : { source }),
  })

describe('WP406 内容包的来源', () => {
  it('官方订阅的包写 source: official；官方通道收、公开通道不收', () => {
    const b = build('official')
    expect(b.built.manifest.source).toBe('official')
    expect(verify(b, 'official').items.map((i) => i.id)).toEqual([
      'skill:demo',
      'rules:seo.claim_rules',
    ])
    expect(() => verify(b, 'public')).toThrow(ContentPackError)
    try {
      verify(b, 'public')
    } catch (e) {
      expect((e as ContentPackError).reason).toBe('source')
    }
  })

  it('老清单不写 source = public：公开通道照收，官方通道不收；不问来源的老调用照旧', () => {
    const b = build(undefined)
    expect(b.built.manifest.source).toBeUndefined()
    expect(verify(b, 'public').serial).toBe(1)
    expect(verify(b).serial).toBe(1)
    expect(() => verify(b, 'official')).toThrow(/来源对不上/)
  })

  it('条目 id 放宽：种类、名字可带下划线；老 id 照认；大写、空名照旧不认', () => {
    for (const ok of [
      'skill:shopify',
      'role_content:dtc.store',
      'rules:seo.claim_rules',
      'position_content:web-ops',
    ])
      expect(CONTENT_ITEM_ID.test(ok), ok).toBe(true)
    for (const bad of ['Skill:x', 'skill:', 'skill:_x', ':x', 'skill x:y'])
      expect(CONTENT_ITEM_ID.test(bad), bad).toBe(false)
  })
})
