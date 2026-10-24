/**
 * WP498：
 * - **1740 B 「存入红人池」对拍**：ego 路这一份请求体（`creatorSaveBodyOf`）去掉 1740 B 多存的两格（加入时间、近期作品）后，
 *   与私有插件 @57fca9c 的**真代码**（面板 `toWorkspacePayload` + 后台 `toCreatorSaveBody`）在同一批假页面上要发的
 *   那一份逐字段一致（标准答案 `test/fixtures/pages/golden/save/*.json`，开发机上现场跑出来的，生成器在私有仓）；
 * - **1742 C 列表页预筛**：分是插件那套算法打的（与直接调 `scoreCandidates` 一致），不丢行，按分排序，插件会筛掉的标出来；
 *   搜索 / 话题页不打分（同插件）；分随观测记下（`relevance_score`）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { irrelevantKeys, scoreCandidates } from '../../src/collectors/relevance.js'
import type { PageCapture } from '../../src/page/capture.js'
import { creatorCapturePageExpression } from '../../src/page-script.js'
import { creatorSaveBodyOf, SAVE_RECENT_ITEMS_MAX } from '../../src/wire/creatorSave.js'
import { ingestPlanOf } from '../../src/wire/plan.js'
import { prescreenList } from '../../src/wire/prescreen.js'
import { FAKE_PAGES, fakePageHtml } from '../fixtures/pages/index.js'

/** 包根目录（按本文件位置算，不靠 cwd）。 */
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const GOLDEN = join(PKG_ROOT, 'test/fixtures/pages/golden')
const LISTS = join(PKG_ROOT, 'test/fixtures/lists')
const FIXED = Date.parse('2026-10-23T08:00:00.000Z')
const NOW = new Date(FIXED).toISOString()

declare const jsdom: { reconfigure(o: { url: string }): void }

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'innerText', {
    configurable: true,
    get() {
      return this.textContent
    },
  })
  vi.useFakeTimers({ toFake: ['Date'], now: FIXED })
})
afterAll(() => {
  vi.useRealTimers()
})

function capture(url: string, html: string): PageCapture {
  jsdom.reconfigure({ url })
  document.open()
  document.write(html)
  document.close()
  // biome-ignore lint/security/noGlobalEval: ego 也是把这一段表达式交给浏览器求值
  return globalThis.eval(creatorCapturePageExpression({ lang: 'en' })) as PageCapture
}

function fakePage(name: string): PageCapture {
  const page = FAKE_PAGES.find((p) => p.name === name)
  if (page === undefined) throw new Error(name)
  return capture(page.url, fakePageHtml(page))
}

const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

describe('1740 B：存入红人池的请求体与插件按钮逐字段一致（再多两格）', () => {
  for (const name of [
    'youtube-channel',
    'youtube-channel-reveal',
    'tiktok-profile',
    'instagram-profile',
    'youtube-channel+linktree',
  ]) {
    test(name, () => {
      const golden = JSON.parse(readFileSync(join(GOLDEN, 'save', `${name}.json`), 'utf8'))
      const withLinktree = name.endsWith('+linktree')
      const bio = withLinktree ? fakePage('linktree').bio_link : undefined
      const cap = fakePage(withLinktree ? 'youtube-channel' : name)
      const plan = ingestPlanOf(cap, { now: NOW, ...(bio ? { bio_links: [bio] } : {}) })
      const body = plain(plan.creator_save) as Record<string, unknown>
      const { joined_date, recent_items, ...pluginPart } = body
      expect(pluginPart).toEqual(golden.save_creator[0])
      // 多存的两格：页面上读到的原样
      expect(joined_date).toBe(plan.creator?.joinedDate)
      const recent = plan.creator?.recentItems ?? []
      expect((recent_items as unknown[] | undefined)?.length ?? 0).toBe(
        Math.min(recent.length, SAVE_RECENT_ITEMS_MAX),
      )
      if (recent[0] !== undefined)
        expect((recent_items as Record<string, unknown>[])[0]).toMatchObject({
          title: recent[0].title,
          ...(recent[0].views === undefined ? {} : { views: recent[0].views }),
        })
    })
  }

  test('YouTube 主页：国家、加入时间、总播放、近期作品都在', () => {
    const body = creatorSaveBodyOf(fakePage('youtube-channel').creator as never, NOW)
    expect(body).toMatchObject({
      country: 'Germany',
      joined_date: 'Mar 3, 2021',
      total_views: 1_234_567,
      source: 'manual_save',
    })
    expect(body.recent_items?.[0]).toMatchObject({
      title: 'The ultimate desk setup guide',
      views: 39_000,
      views_text: '39K views',
      published_text: '2 days ago',
    })
  })
})

describe('1742 C：列表页预筛（插件同一套算法），一行不丢', () => {
  const SEED_TOPICS = ['standing desk', 'desk setup', 'cable']
  const watch = () =>
    capture(
      'https://www.youtube.com/watch?v=SeedVideo01&list=PL1&t=42s',
      readFileSync(join(LISTS, 'youtube-watch.html'), 'utf8'),
    )

  test('右栏：读出种子频道；分 = 直接调 scoreCandidates；按分排，插件会筛掉的标出来', () => {
    const cap = watch()
    const list = cap.list
    if (list === undefined) throw new Error('没读到右栏')
    // 页面上频道链接是 `/@seedchannel`：插件拿去问本机的就是这个（本机按 handle 或平台 id 都认）
    expect(list.seed?.externalId).toBe('@seedchannel')
    const pre = prescreenList(list, SEED_TOPICS)
    const direct = scoreCandidates(list.candidates, SEED_TOPICS)
    expect(pre.candidates).toEqual(direct)
    expect(pre.scored).toBe(true)
    expect(pre.ranked).toHaveLength(list.candidates.length)
    expect(new Set(pre.skipped_keys)).toEqual(new Set(irrelevantKeys(direct)))
    expect(pre.skipped_keys.length).toBeGreaterThan(0)
    const scores = pre.ranked.map((r) => r.candidate.relevanceScore as number)
    expect([...scores].sort((a, b) => b - a)).toEqual(scores)
    for (const r of pre.ranked)
      expect(r.plugin_would_skip).toBe(pre.skipped_keys.includes(r.candidate.key))

    // 全记：每一行都进观测，分随观测带上（同插件 relevance_score）
    const plan = ingestPlanOf(cap, { now: NOW, list_candidates: pre.candidates })
    const rows = plan.observation_batches.flat()
    expect(rows).toHaveLength(list.candidates.length)
    for (const row of rows) expect(typeof row.relevance_score).toBe('number')
  })

  test('种子不在库里（没有主题词）：不打分，照页面顺序，一个都不标', () => {
    const list = watch().list
    if (list === undefined) throw new Error('没读到右栏')
    const pre = prescreenList(list, undefined)
    expect(pre.scored).toBe(false)
    expect(pre.skipped_keys).toEqual([])
    expect(pre.ranked.map((r) => r.candidate.key)).toEqual(list.candidates.map((c) => c.key))
  })

  test('搜索 / 话题页：插件不打分，给了主题词也不用', () => {
    const cap = capture(
      'https://www.tiktok.com/tag/mealprep',
      readFileSync(join(LISTS, 'tiktok-tag.html'), 'utf8'),
    )
    const list = cap.list
    if (list === undefined) throw new Error('没读到列表')
    const pre = prescreenList(list, ['meal prep'])
    expect(pre.scored).toBe(false)
    expect(pre.candidates.every((c) => c.relevanceScore === undefined)).toBe(true)
    expect(list.seed).toBeUndefined()
  })
})
