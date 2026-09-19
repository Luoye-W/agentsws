/**
 * 搬家（WP116 §3）。四件事各一条：**重跑幂等**、**邮箱加密落库**、
 * **坏行跳过并计数**、**要求过移除的人搬不回来**。
 *
 * 邮箱一律用 `example.com`（合成的）——真实邮箱一个字符都不进仓库。
 */
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { importKolRecords, type KolImportDeps, parseNdjson, SqliteKolStore } from '../src/index.js'
import { nodeKolSecrets } from '../src/node-crypto.js'
import { TEST_EMAIL_KEY, testClock } from './helpers.js'

function deps(emailKey: string | undefined = TEST_EMAIL_KEY): KolImportDeps & {
  store: SqliteKolStore
} {
  const clock = testClock()
  const store = new SqliteKolStore(new Database(':memory:'))
  return {
    store,
    secrets: nodeKolSecrets({ env: { AGENTSWS_KOL_EMAIL_KEY: emailKey } }),
    now: () => clock.now(),
  }
}

const CREATOR = {
  kind: 'creator',
  channel: 'youtube',
  handle: '@SomeCreator',
  external_id: 'UC_abc123',
  name: '某个频道',
  country: 'US',
  language: 'en',
  followers: 52_000,
  categories: ['3C', '3c', 'Gaming'],
  observed_at: '2026-09-01T00:00:00.000Z',
  extra: { kolagents_id: 42, verified: true, junk: { nope: 1 } },
}

const CONTACT = {
  kind: 'contact',
  channel: 'youtube',
  handle: 'somecreator',
  email: 'Hello@Example.com',
  source: 'official_api',
  source_url: 'https://www.youtube.com/@somecreator/about',
  source_detail: 'youtube_channel_description',
  confirmations: 3,
  confidence: 1.4,
}

describe('搬家：落库与幂等', () => {
  it('第一趟插入、第二趟全是更新（一行都不重复）', () => {
    const d = deps()
    const rows = [CREATOR, CONTACT, { kind: 'person', id: 'p_1', display_name: '某人' }]
    const first = importKolRecords(d, rows)
    expect(first).toMatchObject({ received: 3, inserted: 3, updated: 0, skipped: 0 })
    expect(first.rejected).toEqual([])

    const second = importKolRecords(d, rows)
    expect(second).toMatchObject({ received: 3, inserted: 0, updated: 3, skipped: 0 })

    // handle 归一化过（@ 去掉、小写），类目去重小写，extra 只留标量
    const card = d.store.creator('youtube', 'somecreator')
    expect(card).toMatchObject({ followers: 52_000, name: '某个频道', external_id: 'UC_abc123' })
    expect(card?.categories).toEqual(['3c', 'gaming'])
    expect(card?.extra).toEqual({ kolagents_id: 42, verified: true })
    expect(card?.imported_from).toBe('kolagents')
    expect(card?.region).toBe('US')
    // 搬家不抬高可信度：它不是"有人报了一条"
    expect(card?.observations).toBe(0)
  })

  it('邮箱只以哈希 + 密文落库，明文解得回来；置信度夹在 0–1', () => {
    const d = deps()
    importKolRecords(d, [CREATOR, CONTACT])
    const contact = d.store.contactOf('youtube', 'somecreator')
    expect(contact?.email_cipher).toBeTypeOf('string')
    expect(JSON.stringify(contact)).not.toContain('hello@example.com')
    expect(d.secrets.decrypt(contact?.email_cipher ?? '')).toBe('hello@example.com')
    expect(contact?.email_sha256).toBe(d.secrets.sha256('hello@example.com'))
    expect(contact?.confidence).toBe(1)
    expect(contact?.source_url).toContain('youtube.com')
  })

  it('没配邮箱密钥就**一个字节都不落**（算 skipped，不降级成明文）', () => {
    const d = deps('')
    const out = importKolRecords(d, [CREATOR, CONTACT])
    expect(out).toMatchObject({ inserted: 1, skipped: 1 })
    expect(d.store.contactOf('youtube', 'somecreator')).toBeUndefined()
  })

  it('内容与指标：主键带 observed_at，重跑不翻倍', () => {
    const d = deps()
    const rows = [
      CREATOR,
      {
        kind: 'content',
        channel: 'youtube',
        handle: 'somecreator',
        external_id: 'vid_1',
        title: '开箱',
        views: 12_000,
        published_at: '2026-08-20T00:00:00.000Z',
        tags: ['unboxing'],
      },
      {
        kind: 'content_metric',
        channel: 'youtube',
        handle: 'somecreator',
        content_external_id: 'vid_1',
        views: 12_000,
        observed_at: '2026-09-01T00:00:00.000Z',
      },
      {
        kind: 'metric',
        channel: 'youtube',
        handle: 'somecreator',
        followers: 52_000,
        observed_at: '2026-09-01T00:00:00.000Z',
      },
    ]
    importKolRecords(d, rows)
    importKolRecords(d, rows)
    expect(d.store.contentsOf('youtube', 'somecreator', 10)).toHaveLength(1)
    expect(d.store.metricsOf('youtube', 'somecreator', 10)).toHaveLength(1)
    expect(d.store.content('youtube', 'vid_1')).toMatchObject({ title: '开箱', views: 12_000 })
  })
})

describe('搬家：坏行与合规闸', () => {
  it('坏行只算它自己坏，理由合并计数，其余行照进', () => {
    const d = deps()
    const out = importKolRecords(d, [
      CREATOR,
      '不是对象',
      { kind: 'creator', channel: '抖音号', handle: 'x' },
      { kind: 'creator', channel: 'youtube', handle: '   ' },
      { kind: 'contact', channel: 'youtube', handle: 'somecreator', email: '这不是邮箱' },
      { kind: '外星人', channel: 'youtube', handle: 'somecreator' },
    ])
    expect(out.inserted).toBe(1)
    expect(out.received).toBe(6)
    const total = out.rejected.reduce((sum, one) => sum + one.count, 0)
    expect(total).toBe(5)
    expect(out.rejected.some((one) => one.reason.includes('不认识的 kind'))).toBe(true)
  })

  it('NDJSON 里的坏 JSON 行不让整趟失败', () => {
    const d = deps()
    const text = `${JSON.stringify(CREATOR)}\n{ 这行坏了\n\n${JSON.stringify(CONTACT)}\n`
    const out = importKolRecords(d, parseNdjson(text))
    expect(out).toMatchObject({ received: 3, inserted: 2 })
    expect(out.rejected).toEqual([{ reason: '这一行不是一个对象', count: 1 }])
  })

  it('要求过被移除的人，搬家不许把他搬回来', () => {
    const d = deps()
    importKolRecords(d, [CREATOR, CONTACT])
    d.store.putOptOut({
      channel: 'youtube',
      handle: 'somecreator',
      reason: '本人来信要求移除',
      removed_by: 'acc_admin',
      at: d.now(),
    })
    d.store.purgeCreator('youtube', 'somecreator')
    const again = importKolRecords(d, [CREATOR, CONTACT])
    expect(again).toMatchObject({ inserted: 0, updated: 0, skipped: 2 })
    expect(d.store.creator('youtube', 'somecreator')).toBeUndefined()
  })
})
