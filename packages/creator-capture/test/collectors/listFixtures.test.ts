/** 移植自 agentsws-extension `test/contents/listFixtures.test.ts` @ 57fca9c（决策 1739 A：采集器测试随采集器一起搬；只改 import 路径）。 */
/**
 * WP130 验收：列表页解析器与旧插件同输入同输出——**常规测试这一半**。
 *
 * 标准答案 `test/fixtures/lists/golden/*.json` 是旧插件解析器在同一份夹具上的
 * 输出（由 `WRITE_GOLDEN=1 pnpm test:parity` 从旧仓工作区现场跑出来写下的，
 * 不是手写的）。这里只跑新仓那一半，于是没有旧仓的机器上对拍也照跑。
 * 旧仓在手边时，`pnpm test:parity` 做的是两边现场对跑。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

import * as listCaptureTarget from '../../src/collectors/listCaptureTarget.js'
import * as relevance from '../../src/collectors/relevance.js'
import * as searchFilters from '../../src/collectors/searchFilters.js'
import * as socialList from '../../src/collectors/socialList.js'
import * as youtubeInitialData from '../../src/collectors/youtubeInitialData.js'
import * as youtubeWatchRelated from '../../src/collectors/youtubeWatchRelated.js'
import * as bulkCapture from '../../src/kol/bulkCapture.js'
import * as youtubeSearch from '../../src/kol/utils/youtubeSearch.js'

import { FIXTURE_DIR, LIST_FIXTURES, runListPipeline } from '../fixtures/lists/pipeline'

const NEW = {
  listCaptureTarget,
  youtubeSearch,
  youtubeWatchRelated,
  youtubeInitialData,
  socialList,
  searchFilters,
  relevance,
  bulkCapture,
}

describe('列表页夹具：新仓输出 = 旧插件输出（标准答案）', () => {
  for (const fixture of LIST_FIXTURES) {
    test(fixture.file, () => {
      const golden = JSON.parse(
        readFileSync(join(FIXTURE_DIR, 'golden', fixture.file.replace('.html', '.json')), 'utf8'),
      )
      const out = runListPipeline(NEW, fixture)
      expect(out.candidates.length).toBeGreaterThan(0)
      if (fixture.newOnlyTarget) {
        // 旧插件认不出这一页（WP130 本仓补的页型）：只比解析那一截。
        expect(golden.target).toBeNull()
        expect(out.target).not.toBeNull()
        expect({ ...out, target: null }).toEqual(golden)
      } else {
        expect(out).toEqual(golden)
      }
    })
  }
})
