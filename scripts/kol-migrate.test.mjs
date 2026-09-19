/**
 * 搬家两步的用例（WP116 §3）。
 *
 * **一次都不连真库、一个真邮箱都不出现**：导出那一半测的是"原系统的一行 →
 * 我们的一条 NDJSON"那个纯函数（`renderSection`），行是**合成**的，域名一律
 * `example.com`；导入那一半测的是分块、排序、汇总与那条 POST（`fetch` 是替身）。
 *
 * 要钉住的事：
 *
 * 1. 六种 kind 各自映射对；
 * 2. 不认识的平台、不成形状的 handle **跳过并数出来**，不猜也不静默丢；
 * 3. 没有 handle 的老频道用 `external_id` 顶上（YouTube 那一批 `UCxxxx`）；
 * 4. `bio` 一个字都不导（简介里常写着邮箱）；
 * 5. 分块按 500 行，文件按名字排序推（person / creator 要先落）；
 * 6. 一块失败就停，并且说清"再跑一次就是补差"。
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { confidenceOf, keyHandle, renderSection, SECTIONS } from './export-kolagents-public.mjs'
import { BATCH, chunk, filesIn, merge, pushDir } from './import-kol-public.mjs'

/** 按文件名拿一段。 */
const section = (file) => {
  const found = SECTIONS.find((s) => s.file === file)
  if (found === undefined) throw new Error(`没有这一段：${file}`)
  return found
}

/** 一段 + 几行 → 解出来的那几条记录。 */
const records = (file, rows) =>
  renderSection(section(file), rows)
    .text.split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l))

describe('WP116 导出 · 六种 kind 的映射', () => {
  it('creator：平台 → 渠道，latest_followers → followers，joined_date 进 extra', () => {
    const out = records('02-creator.ndjson', [
      {
        id: 'cr_1',
        person_id: 'per_1',
        platform: 'YouTube',
        external_id: 'UC123',
        handle: '@SomeCreator',
        name: 'Some Creator',
        avatar_url: 'https://cdn.example.com/a.jpg',
        country: 'US',
        language: 'en',
        joined_date: 'Jul 8, 2006',
        latest_followers: 120_000,
        latest_captured_at: new Date('2026-09-10T00:00:00Z'),
        updated_at: new Date('2026-09-11T00:00:00Z'),
      },
    ])
    expect(out).toHaveLength(1)
    const one = out[0]
    expect(one.kind).toBe('creator')
    expect(one.channel).toBe('youtube')
    expect(one.handle).toBe('somecreator')
    expect(one.external_id).toBe('UC123')
    expect(one.person_id).toBe('per_1')
    expect(one.followers).toBe(120_000)
    expect(one.observed_at).toBe('2026-09-10T00:00:00.000Z')
    expect(one.extra).toEqual({ joined_date: 'Jul 8, 2006', kolagents_id: 'cr_1' })
    // 原系统有这两个数，但它们属于指标快照那张表——**不混进卡里**
    expect(one.avg_views).toBeUndefined()
    expect(one.posts_30d).toBeUndefined()
    expect(one.engagement_rate).toBeUndefined()
  })

  it('creator：bio 一个字都不导（简介里常写着邮箱）', () => {
    const rows = [
      {
        id: 'cr_2',
        platform: 'youtube',
        external_id: 'UC999',
        handle: 'withbio',
        bio: '商务合作 biz@example.com',
        updated_at: new Date('2026-09-11T00:00:00Z'),
      },
    ]
    // SQL 里根本没 select 它，这里连行上带着都不导
    expect(section('02-creator.ndjson').sql).not.toContain('bio')
    expect(JSON.stringify(records('02-creator.ndjson', rows))).not.toContain('biz@example.com')
  })

  it('creator：不认识的平台跳过并数出来，不猜', () => {
    const out = renderSection(section('02-creator.ndjson'), [
      { id: 'a', platform: 'myspace', external_id: 'x', handle: 'ghost' },
      { id: 'b', platform: 'twitter', external_id: 'y', handle: 'ok' },
    ])
    expect(out.written).toBe(1)
    expect(out.skipped).toEqual([{ reason: '不认识的平台：myspace', count: 1 }])
    // twitter 是 x 的旧名字
    expect(JSON.parse(out.text.trim()).channel).toBe('x')
  })

  it('没有 handle 的老频道用 external_id 顶上；两个都不成形状才跳过', () => {
    expect(keyHandle({ handle: null, external_id: 'UCabc_123' })).toBe('ucabc_123')
    expect(keyHandle({ handle: '  ', external_id: '   ' })).toBeUndefined()
    const out = renderSection(section('02-creator.ndjson'), [
      { id: 'a', platform: 'youtube', external_id: '', handle: '!!!' },
    ])
    expect(out.written).toBe(0)
    expect(out.skipped[0].reason).toBe('handle 与 external_id 都不成形状')
  })

  it('contact：source_type → 可信度档 + 原样留细的那一档；确认 / 报错折成 confidence', () => {
    const out = records('03-contact.ndjson', [
      {
        value: ' Hi@Example.COM ',
        source_url: 'https://www.example.com/@somecreator/about',
        source_type: 'youtube_channel_description',
        confirmation_count: 3,
        dispute_count: 1,
        last_confirmed_at: new Date('2026-09-01T00:00:00Z'),
        platform: 'youtube',
        handle: 'somecreator',
        external_id: 'UC123',
      },
    ])
    expect(out[0]).toMatchObject({
      kind: 'contact',
      channel: 'youtube',
      handle: 'somecreator',
      email: 'hi@example.com',
      source: 'official_api',
      source_detail: 'youtube_channel_description',
      confirmations: 3,
      disputes: 1,
    })
    expect(out[0].confidence).toBeCloseTo(0.75, 6)
  })

  it('contact：不像邮箱的那一行跳过并数出来', () => {
    const out = renderSection(section('03-contact.ndjson'), [
      { value: 'not an email', platform: 'youtube', handle: 'somecreator' },
    ])
    expect(out.written).toBe(0)
    expect(out.skipped).toEqual([{ reason: '这不像一个邮箱地址', count: 1 }])
  })

  it('confidenceOf：两边都是 0 时不编一个数', () => {
    expect(confidenceOf(0, 0)).toBeUndefined()
    expect(confidenceOf(1, 0)).toBe(1)
  })

  it('content / content_metric / metric / person：各自的必填与来源档', () => {
    const content = records('04-content.ndjson', [
      {
        external_id: 'vid_1',
        content_type: 'reel',
        title: '一条视频',
        url: 'https://www.example.com/watch?v=vid_1',
        tags: ['beauty', ''],
        orientation: 'portrait',
        duration_seconds: 61,
        published_at: new Date('2026-08-01T00:00:00Z'),
        latest_views: 1000,
        latest_captured_at: new Date('2026-09-01T00:00:00Z'),
        platform: 'youtube',
        handle: 'somecreator',
        creator_external_id: 'UC123',
      },
    ])
    expect(content[0]).toMatchObject({
      kind: 'content',
      external_id: 'vid_1',
      content_type: 'reel',
      orientation: 'portrait',
      tags: ['beauty'],
      views: 1000,
    })

    const metricRows = renderSection(section('05-content-metric.ndjson'), [
      {
        content_external_id: 'vid_1',
        views: 2000,
        captured_at: new Date('2026-09-02T00:00:00Z'),
        source: 'refresh',
        platform: 'youtube',
        handle: 'somecreator',
        creator_external_id: 'UC123',
      },
      // 没说是哪条内容的：跳过
      { views: 1, platform: 'youtube', handle: 'somecreator' },
    ])
    expect(metricRows.written).toBe(1)
    expect(JSON.parse(metricRows.text.trim()).source).toBe('official_api')

    const snapshots = records('06-metric.ndjson', [
      {
        followers: 120_000,
        avg_views: 8000,
        video_count: 300,
        total_views: 9_000_000,
        captured_at: new Date('2026-09-01T00:00:00Z'),
        source: 'plugin',
        platform: 'youtube',
        handle: 'somecreator',
        external_id: 'UC123',
      },
    ])
    expect(snapshots[0]).toMatchObject({
      kind: 'metric',
      followers: 120_000,
      avg_views: 8000,
      video_count: 300,
      total_views: 9_000_000,
      source: 'plugin',
    })
    // `recent_items` 不导（会与内容表打架）
    expect(section('06-metric.ndjson').sql).not.toContain('recent_items')

    const persons = records('01-person.ndjson', [
      {
        id: 'per_1',
        display_name: 'Some Creator',
        created_at: new Date('2026-01-01T00:00:00Z'),
        updated_at: new Date('2026-09-01T00:00:00Z'),
      },
      { id: '  ' },
    ])
    expect(persons).toHaveLength(1)
    expect(persons[0]).toMatchObject({ kind: 'person', id: 'per_1' })
  })

  it('六段的顺序就是导入的顺序：person / creator 在最前面', () => {
    expect(SECTIONS.map((s) => s.file)).toEqual([
      '01-person.ndjson',
      '02-creator.ndjson',
      '03-contact.ndjson',
      '04-content.ndjson',
      '05-content-metric.ndjson',
      '06-metric.ndjson',
    ])
  })
})

describe('WP116 导入 · 分块与顺序', () => {
  /** 一个装着两份 NDJSON 的临时目录。 */
  function fixture(counts) {
    const dir = mkdtempSync(join(tmpdir(), 'kol-import-'))
    mkdirSync(dir, { recursive: true })
    for (const [file, n] of Object.entries(counts)) {
      const lines = Array.from({ length: n }, (_, i) =>
        JSON.stringify({ kind: 'creator', channel: 'youtube', handle: `c${String(i)}` }),
      )
      writeFileSync(join(dir, file), `${lines.join('\n')}\n`, 'utf8')
    }
    // 不是 .ndjson 的一律不推
    writeFileSync(join(dir, 'README.txt'), '别推我', 'utf8')
    return dir
  }

  it('一趟最多 500 行；空行不算行', () => {
    expect(BATCH).toBe(500)
    expect(chunk('a\n\n\nb\n')).toEqual([['a', 'b']])
    expect(chunk(`${Array.from({ length: 1200 }, (_, i) => String(i)).join('\n')}\n`)).toHaveLength(
      3,
    )
  })

  it('只推 .ndjson，而且按名字排序（序号就是顺序）', () => {
    const dir = fixture({ '02-creator.ndjson': 1, '01-person.ndjson': 1 })
    expect(filesIn(dir)).toEqual(['01-person.ndjson', '02-creator.ndjson'])
  })

  it('分块推：每块一次 POST，结果按理由合并', async () => {
    const dir = fixture({ '02-creator.ndjson': 1200 })
    const seen = []
    const out = await pushDir(
      {
        baseUrl: 'https://cloud.example.com',
        token: 'test-token',
        fetch: (url, init) => {
          seen.push({ url, lines: init.body.trim().split('\n').length })
          return Promise.resolve(
            new Response(
              JSON.stringify({
                data: {
                  received: 1,
                  inserted: 1,
                  updated: 0,
                  skipped: 0,
                  rejected: [{ reason: '这一行不是一个对象', count: 1 }],
                },
              }),
              { status: 200 },
            ),
          )
        },
      },
      dir,
    )
    expect(seen).toHaveLength(3)
    expect(seen[0].url).toBe('https://cloud.example.com/v1/admin/kol/import')
    expect(seen.map((s) => s.lines)).toEqual([500, 500, 200])
    expect(out[0].result.rejected).toEqual([{ reason: '这一行不是一个对象', count: 3 }])
  })

  it('一块失败就停，并把状态码带回来（再跑一次就是补差）', async () => {
    const dir = fixture({ '02-creator.ndjson': 900 })
    let n = 0
    const out = await pushDir(
      {
        baseUrl: 'https://cloud.example.com',
        token: 'test-token',
        fetch: () => {
          n += 1
          return Promise.resolve(
            n === 1
              ? new Response(JSON.stringify({ data: { received: 500, inserted: 500 } }), {
                  status: 200,
                })
              : new Response(JSON.stringify({ code: 'unauthenticated' }), { status: 401 }),
          )
        },
      },
      dir,
    )
    expect(out).toHaveLength(1)
    expect(out[0].failed).toMatchObject({ block: 2, of: 2, status: 401 })
  })

  it('merge：受 / 新 / 更 / 跳都加起来', () => {
    expect(
      merge([
        { received: 2, inserted: 2, updated: 0, skipped: 0, rejected: [] },
        {
          received: 3,
          inserted: 0,
          updated: 3,
          skipped: 1,
          rejected: [{ reason: '坏', count: 2 }],
        },
      ]),
    ).toEqual({
      received: 5,
      inserted: 2,
      updated: 3,
      skipped: 1,
      rejected: [{ reason: '坏', count: 2 }],
    })
  })
})
