/** 移植自 agentsws-extension `test/fixtures/lists/pipeline.ts` @ 57fca9c（WP130 列表页对拍流水线），逐字照搬。 */
/**
 * WP130 对拍用的「同一条流水线」：夹具 HTML + 页面网址 → 面板会给出的那一切。
 *
 * 这一份代码**不认模块来自哪里**：新仓跑它时传新仓的解析器，对拍脚本
 * （`test-parity/lists.parity.test.ts`）跑它时传旧插件的解析器——同输入、
 * 同一条流水线，输出逐字比。流水线就是 SearchCaptureFab 在「打开面板 →
 * 点采集」之间做的那几步，按原顺序：
 *
 *   列表页判定 → 读页面（搜索 / TikTok / Instagram 读卡片；相关视频栏读右栏 +
 *   页内身份映射 + 剔种子）→ 预筛打分（只相关视频栏，拿固定的种子主题词）→
 *   阈值筛选（固定两档）→ 每行变成上报条目 → 按 20 条分块。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'

/* 旧仓与新仓的模块形状相同；这里只描述流水线用到的那几个函数。 */
// biome-ignore lint/suspicious/noExplicitAny: 两个仓库的类型对象不是同一个，只比运行时输出
type Fn = (...args: any[]) => any
export interface ListModules {
  listCaptureTarget: { resolveListCaptureTarget: Fn }
  youtubeSearch: { collectYouTubeSearchCreators: Fn }
  youtubeWatchRelated: {
    collectWatchRelatedEntries: Fn
    readWatchSeedIdentity: Fn
    watchRelatedCandidates: Fn
    railChannelCount: Fn
  }
  youtubeInitialData: { readInitialDataScript: Fn; readWatchInitialData: Fn }
  socialList: { collectSocialListCreators: Fn }
  searchFilters: {
    parseFilterPrefs: Fn
    applyCaptureFilters: Fn
    availableFilters: Fn
    summarizeVideoEvidence: Fn
  }
  relevance: { scoreCandidates: Fn; relevanceTally: Fn }
  bulkCapture: { toBulkObservationItem: Fn; chunkItems: Fn }
}

export interface ListFixture {
  /** `test/fixtures/lists/<file>` */
  file: string
  /** 这个夹具冒充的页面网址。 */
  url: string
  /** 旧插件认不出这一页（WP130 本仓补的页型）：对拍时只比解析，不比页型判定。 */
  newOnlyTarget?: boolean
}

export const LIST_FIXTURES: ListFixture[] = [
  { file: 'youtube-search.html', url: 'https://www.youtube.com/results?search_query=standing+desk' },
  { file: 'youtube-watch.html', url: 'https://www.youtube.com/watch?v=SeedVideo01&list=PL1&t=42s' },
  { file: 'tiktok-search.html', url: 'https://www.tiktok.com/search?q=meal%20prep' },
  { file: 'tiktok-tag.html', url: 'https://www.tiktok.com/tag/mealprep' },
  { file: 'instagram-tag.html', url: 'https://www.instagram.com/explore/tags/mealprep/' },
  {
    file: 'instagram-search.html',
    url: 'https://www.instagram.com/explore/search/keyword/?q=mealprep',
    newOnlyTarget: true,
  },
]

/** 相关视频栏预筛用的种子主题词（固定，替代 seed-signature 端点）。 */
const SEED_TOPICS = ['standing desk', 'desk setup', 'cable']

/** 两档阈值：不设 / 设「播放 ≥ 5 万」。 */
const THRESHOLDS = [{}, { minViewsText: '50K' }]

/** 夹具目录（vitest 在 jsdom 环境里 `import.meta.url` 不是 file:，按仓根拼）。 */
export const FIXTURE_DIR = join(process.cwd(), 'test/fixtures/lists')

export function fixturePath(file: string): string {
  return join(FIXTURE_DIR, file)
}

export function loadFixture(fixture: ListFixture): Document {
  const html = readFileSync(fixturePath(fixture.file), 'utf8')
  return new JSDOM(html, { url: fixture.url }).window.document
}

/** JSON 往返一次：去掉 `undefined` 键与原型差异，只留「会被看见 / 被上报」的值。 */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function runListPipeline(mods: ListModules, fixture: ListFixture) {
  const doc = loadFixture(fixture)
  const target = mods.listCaptureTarget.resolveListCaptureTarget(fixture.url)
  const platform: 'youtube' | 'tiktok' | 'instagram' = fixture.url.includes('tiktok.com')
    ? 'tiktok'
    : fixture.url.includes('instagram.com')
      ? 'instagram'
      : 'youtube'
  const watch = fixture.url.includes('/watch?')

  let raw: unknown[]
  let rail: Record<string, unknown> | undefined
  if (watch) {
    const videoId = new URL(fixture.url).searchParams.get('v')
    const entries = mods.youtubeWatchRelated.collectWatchRelatedEntries(doc)
    const seed = mods.youtubeWatchRelated.readWatchSeedIdentity(doc)
    const identities = mods.youtubeInitialData.readWatchInitialData(
      mods.youtubeInitialData.readInitialDataScript(doc),
      videoId,
    )
    // 与 SearchCaptureFab 的 `rail` 那段 useMemo 同一个 join。
    const joined = entries.map((entry: { videoId: string }) => {
      const found = identities.byVideoId.get(entry.videoId)
      return found
        ? { ...entry, channelExternalId: found.externalId, channelHandle: found.handle }
        : entry
    })
    const out = mods.youtubeWatchRelated.watchRelatedCandidates(joined, {
      seedExternalId: seed?.externalId,
      seedHandle: seed?.handle,
    })
    raw = out.candidates
    rail = {
      entries,
      seed,
      fresh: identities.fresh,
      unidentified: out.unidentified,
      channelCount: mods.youtubeWatchRelated.railChannelCount(entries, seed?.name),
    }
  } else if (platform === 'youtube') {
    raw = mods.youtubeSearch.collectYouTubeSearchCreators(doc)
  } else {
    raw = mods.socialList.collectSocialListCreators(platform, doc)
  }

  const scored = mods.relevance.scoreCandidates(raw, watch ? SEED_TOPICS : undefined)
  const filters = THRESHOLDS.map((prefs) => {
    const filtered = mods.searchFilters.applyCaptureFilters(
      scored,
      mods.searchFilters.parseFilterPrefs(prefs),
    )
    const items = filtered.visible.map(mods.bulkCapture.toBulkObservationItem)
    return {
      prefs,
      hidden: filtered.hidden,
      unknown: filtered.unknown,
      visibleKeys: filtered.visible.map((c: { key: string }) => c.key),
      items,
      chunks: mods.bulkCapture.chunkItems(items).map((c: unknown[]) => c.length),
    }
  })

  return plain({
    target,
    candidates: scored,
    ...(rail ? { rail } : {}),
    offered: mods.searchFilters.availableFilters(scored),
    evidence: scored.map((c: unknown) => mods.searchFilters.summarizeVideoEvidence(c)),
    bands: mods.relevance.relevanceTally(scored),
    filters,
  })
}
