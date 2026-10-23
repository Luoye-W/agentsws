/**
 * WP496 对拍：**插件路 vs ego 路，逐字段一致**。
 *
 * - 插件路 = 标准答案 `test/fixtures/pages/golden/*.json`：私有插件 @57fca9c 的**真代码**（面板那几步 + `pluginApi` +
 *   后台 `local-handlers` 换形）在同一批假页面上跑出来、它要发给本机服务的那几条请求体（开发机上现场跑、写下来的，
 *   不是手写的；那段跑法要私有插件源码，不进开源仓——见 WP496 报告）。
 * - ego 路 = 这个包打出来的页面脚本（`creatorCapturePageExpression`，ego 用 `page.evaluate` 注入的就是这一段）在假页面里求值，
 *   再经 `ingestPlanOf` 换成请求体。
 *
 * 两边在同一个 jsdom 里跑、同一个钟（固定时间）。jsdom 没有 `innerText`，这里两边同样按 `textContent` 补上；
 * 真浏览器里的那一半由 `scripts/e2e-wp496-ego-capture.mts`（真 ego × 本机假页面）验。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import type { PageCapture } from '../../src/page/capture.js'
import { creatorCapturePageExpression } from '../../src/page-script.js'
import { ingestPlanOf } from '../../src/wire/plan.js'
import { FAKE_PAGES, fakePageHtml } from '../fixtures/pages/index.js'

/** 包根目录（按本文件位置算，不靠 cwd：仓根跑全量时 cwd 是仓根；传字符串给 fileURLToPath，jsdom 换掉了全局 URL）。 */
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')

declare const jsdom: { reconfigure(o: { url: string }): void }

const FIXED = Date.parse('2026-10-23T08:00:00.000Z')
const GOLDEN_DIR = join(PKG_ROOT, 'test/fixtures/pages/golden')

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

function egoCapture(name: string): PageCapture {
  const page = FAKE_PAGES.find((p) => p.name === name)
  if (page === undefined) throw new Error(name)
  jsdom.reconfigure({ url: page.url })
  document.open()
  document.write(fakePageHtml(page))
  document.close()
  // ego：`page.evaluate(表达式)`——这里同一段表达式在同一个页面里求值
  // biome-ignore lint/security/noGlobalEval: 这就是被测的东西——ego 也是把这一段表达式交给浏览器求值
  return globalThis.eval(creatorCapturePageExpression({ lang: 'en' })) as PageCapture
}

/** 逐字段比：哪一格不一样，失败信息里直接是那一格的路径。 */
function expectFieldByField(actual: unknown, expected: unknown, path: string): void {
  if (expected !== null && typeof expected === 'object' && !Array.isArray(expected)) {
    expect(actual, path).toBeTypeOf('object')
    const a = actual as Record<string, unknown>
    const e = expected as Record<string, unknown>
    for (const key of new Set([...Object.keys(a), ...Object.keys(e)]))
      expectFieldByField(a[key], e[key], `${path}.${key}`)
    return
  }
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual), path).toBe(true)
    expect((actual as unknown[]).length, `${path}.length`).toBe(expected.length)
    for (const [i, one] of expected.entries())
      expectFieldByField((actual as unknown[])[i], one, `${path}[${i}]`)
    return
  }
  expect(actual, path).toEqual(expected)
}

const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

const CASES = [...FAKE_PAGES.map((p) => p.name), 'youtube-channel+linktree']

describe('插件路 vs ego 路：同一批假页面，逐字段一致', () => {
  for (const name of CASES) {
    test(name, () => {
      const golden = JSON.parse(readFileSync(join(GOLDEN_DIR, `${name}.json`), 'utf8'))
      const withLinktree = name.endsWith('+linktree')
      const bio = withLinktree ? egoCapture('linktree').bio_link : undefined
      const capture = egoCapture(withLinktree ? 'youtube-channel' : name)
      expect(capture.pending).toBe(false)
      const plan = ingestPlanOf(capture, {
        now: new Date(FIXED).toISOString(),
        ...(bio === undefined ? {} : { bio_links: [bio] }),
      })

      // 1. 页面上读到的（快照）
      if (golden.capture.creator !== undefined)
        expectFieldByField(plain(plan.creator), golden.capture.creator, 'creator')
      // 插件读不到（页面没渲染出这一块）记的是 null，ego 路就不带这一格——都是「没读到」
      if (golden.capture.content === null) expect(capture.content).toBeUndefined()
      else if (golden.capture.content !== undefined)
        expectFieldByField(capture.content, golden.capture.content, 'content')
      if (golden.capture.bio_link !== undefined)
        expectFieldByField(capture.bio_link, golden.capture.bio_link, 'bio_link')
      if (golden.capture.list !== undefined) {
        expectFieldByField(capture.list?.target, golden.capture.list.target, 'list.target')
        expectFieldByField(
          capture.list?.candidates,
          golden.capture.list.candidates,
          'list.candidates',
        )
      }
      // 2. 交给本机服务的（请求体）
      expectFieldByField(
        plain(plan.observation_batches),
        golden.observation_batches,
        'observations',
      )
      expectFieldByField(
        plain(plan.content_observations),
        golden.content_observations,
        'content_observations',
      )
      expectFieldByField(
        plain(plan.bio_link_observations),
        golden.bio_link_observations,
        'bio_link_observations',
      )
    })
  }
})
