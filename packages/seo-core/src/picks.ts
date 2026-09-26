/**
 * 判断：从六个信号里挑出**今天值得动的 5 件事**，按「先修再写」排好，并给每件定一条车道。
 *
 * 车道（WP154 §3）：
 * - `fix_page`：改现有页面（元信息 / 开头 / 小节 / 内链）→ 本职责出改动卡；
 * - `site_handoff`：页面没被收录 / 在跳转 / 规范网址不对 → 交给「建站」；
 * - `pr_handoff`：页面该有的都有了还卡在第二页 → 缺的是站外有人提到它，交给「公关」；
 * - `new_page`：要一页新的 → 先看 SERP 排前面的是不是对的人群，是才出选题卡。
 *
 * 排序：车道先（能改现有页面的排前面），同车道按曝光（文章第 5 步："用量来排队，
 * 不用来决定一页该不该存在"），再按点击、再按查询字面（同输入同输出）。
 *
 * 一件事一个查询；同一页同一种改法只出一次（同一页标题一天改两遍，第二遍会顶掉第一遍）。
 */
import type {
  GscRow,
  SeoEvidence,
  SeoFixKind,
  SeoLane,
  SeoPick,
  SeoSignalId,
  SitePage,
} from '@agentsws/contracts'
import {
  intentsCompatible,
  normalizeQuery,
  pageIntent,
  pageTargets,
  queryIntent,
  type SignalHit,
  weekOverWeek,
  wordCount,
} from './signals.js'

/** 每天最多几件（文章：只出值得动的；Luoye：不堆数据）。 */
export const DAILY_PICKS = 5

/** 车道的先后：能改现有页面的排前面（先修再写）。 */
export const LANE_ORDER: Record<SeoLane, number> = {
  fix_page: 0,
  site_handoff: 1,
  pr_handoff: 2,
  new_page: 3,
}

/**
 * 同一个查询命中好几个信号时，挑哪个当主信号（越靠前越先）。
 *
 * `wrong_intent` 排第一：意图不对的时候改标题没用（文章第 4 步"给想要按钮的人写了篇随笔，
 * 什么标题都救不回来"）——它同时也是 `almost_there` 也一样，要的是一页新的。
 * 其余按"改得越小越先"：没人点（改四格）→ 在掉（加小节）→ 快到了（加一句 / 内链）。
 */
export const SIGNAL_ORDER: Record<SeoSignalId, number> = {
  wrong_intent: 0,
  no_clicks: 1,
  decaying: 2,
  almost_there: 3,
  untargeted: 4,
  ai_mode: 5,
}

const INTENT_LABEL: Record<string, string> = {
  informational: '一篇讲清楚的文章',
  comparison: '一页对比',
  pricing: '一页价格 / 计算器',
  transactional: '一个能直接买的商品页',
  navigational: '首页或联系页',
}

const PAGE_KIND_LABEL: Record<SitePage['kind'], string> = {
  article: '博客文章',
  page: '独立页面',
  product: '商品页',
  collection: '集合页',
  home: '首页',
  other: '页面',
}

const INDEX_LABEL: Record<NonNullable<SitePage['index_status']>, string> = {
  indexed: '已收录',
  not_indexed: '没被 Google 收录',
  redirect: '在跳转（排名落在跳转前的地址上）',
  canonical_mismatch: '规范网址指向了别的地址',
}

export function evidenceOf(row: GscRow): SeoEvidence {
  const wow = weekOverWeek(row)
  return {
    clicks: row.clicks,
    impressions: row.impressions,
    ctr: row.ctr,
    position: row.position,
    ...(row.clicks_prev_week === undefined ? {} : { clicks_prev_week: row.clicks_prev_week }),
    ...(wow === undefined ? {} : { wow_pct: wow }),
    words: wordCount(row.query),
  }
}

const pct = (v: number): string => `${Math.round(v * 1000) / 10}%`
const pos = (v: number): string => `${Math.round(v * 10) / 10}`

/** 证据数字写成一句（卡上那一行；数全从行里来）。 */
export function evidenceText(e: SeoEvidence): string {
  const parts = [
    `曝光 ${e.impressions}`,
    `点击 ${e.clicks}`,
    `点击率 ${pct(e.ctr)}`,
    `排名 ${pos(e.position)}`,
  ]
  if (e.wow_pct !== undefined) parts.push(`点击周环比 ${e.wow_pct > 0 ? '+' : ''}${e.wow_pct}%`)
  return parts.join(' · ')
}

/** 一件事的草稿：车道、改法、建议——还没排序、还没截到 5 件。 */
export interface PickDraft {
  signal: SeoSignalId
  row: GscRow
  page?: SitePage
  lane: SeoLane
  fix?: SeoFixKind
  suggestion: string
  /** `internal_link_edit`：从哪一页链过来（点击最多的那一页）。 */
  link_from?: string
}

/**
 * 一次命中 → 车道与建议。`strongPage` 是这批数据里点击最多的那一页（内链从它链出去）。
 */
export function routeHit(hit: SignalHit, strongPage: string | undefined): PickDraft {
  const { row, page, signal } = hit
  const q = row.query
  const base = { signal, row, ...(page === undefined ? {} : { page }) }
  // 页面本身出了问题（没收录 / 在跳转 / 规范网址不对）：不是内容的事，交建站
  if (page?.index_status !== undefined && page.index_status !== 'indexed')
    return {
      ...base,
      lane: 'site_handoff',
      suggestion: `「${q}」排上的那页${INDEX_LABEL[page.index_status]}。不是内容的问题——交给建站处理跳转、规范网址与收录，处理完再看排名。`,
    }
  const fits = page !== undefined && intentsCompatible(queryIntent(q), pageIntent(page))
  switch (signal) {
    case 'no_clicks':
      return {
        ...base,
        lane: 'fix_page',
        fix: 'page_seo_edit',
        suggestion: `被看见了没人点：把「${q}」原样写进标题、描述、H1 和第一句，答案放在头两行。`,
      }
    case 'almost_there': {
      const targeted = page !== undefined && pageTargets(page, q)
      if (targeted && row.position > 10) {
        if (strongPage !== undefined && strongPage !== row.page)
          return {
            ...base,
            lane: 'fix_page',
            fix: 'internal_link_edit',
            link_from: strongPage,
            suggestion: `这页已经专门写了「${q}」，还卡在第 ${pos(row.position)} 位。从点击最多的那页链一下它，站稳了再把链接挪给下一页。`,
          }
        return {
          ...base,
          lane: 'pr_handoff',
          suggestion: `这页该有的都有了，还卡在第 ${pos(row.position)} 位。缺的是站外有人提到它——交给公关（Reddit / 论坛 / 新闻稿）。`,
        }
      }
      return {
        ...base,
        lane: 'fix_page',
        fix: 'page_seo_edit',
        suggestion: `已经排到第 ${pos(row.position)} 位。在开头加一句带「${q}」原话的句子，往前挪一页。`,
      }
    }
    case 'decaying':
      return {
        ...base,
        lane: 'fix_page',
        fix: 'page_section_add',
        suggestion: `点击比上周少了 ${Math.abs(hit.wow_pct ?? 0)}%。给这页加一个小节接住「${q}」，更新日期后请 Google 重新收录。`,
      }
    case 'wrong_intent': {
      const want = INTENT_LABEL[hit.intents?.query ?? 'informational'] ?? '另一种页'
      const got = page === undefined ? '页面' : PAGE_KIND_LABEL[page.kind]
      return {
        ...base,
        lane: 'new_page',
        suggestion: `搜「${q}」的人要的是${want}，落在了一篇${got}上——标题改不好这件事，要一页新的。写好后从现在这页链过去。`,
      }
    }
    case 'untargeted':
    case 'ai_mode':
      if (fits)
        return {
          ...base,
          lane: 'fix_page',
          fix: 'page_section_add',
          suggestion:
            signal === 'ai_mode'
              ? `有人像问 AI 一样搜「${q}」。在这页加一个用这句原话做小标题的小节，答案放在第一句。`
              : `这页顺带排上了「${q}」但没真正回答它。加一个小节接住这个词。`,
        }
      return {
        ...base,
        lane: 'new_page',
        suggestion: `没有一页专门写「${q}」。先看搜索结果里排前面的是不是我们的顾客，是才写；写好后从排上的那页链过去。`,
      }
  }
}

/** 这批数据里点击最多的那一页（内链的"强页"）；并列按 URL 字面。 */
export function strongestPage(rows: readonly GscRow[]): string | undefined {
  const byPage = new Map<string, number>()
  for (const r of rows) byPage.set(r.page, (byPage.get(r.page) ?? 0) + r.clicks)
  let best: [string, number] | undefined
  for (const [p, c] of [...byPage.entries()].sort((a, b) => a[0].localeCompare(b[0])))
    if (c > 0 && (best === undefined || c > best[1])) best = [p, c]
  return best?.[0]
}

/**
 * 全部草稿（每个查询一件、同页同改法一件），已按先修再写排好。**不截断**——
 * 截到 5 件要等新页面那几件看过 SERP（看完可能被划掉），所以截断在 `daily.ts`。
 */
export function rankDrafts(hits: readonly SignalHit[], rows: readonly GscRow[]): PickDraft[] {
  const strong = strongestPage(rows)
  const byQuery = new Map<string, PickDraft>()
  const better = (a: PickDraft, b: PickDraft): boolean =>
    SIGNAL_ORDER[a.signal] < SIGNAL_ORDER[b.signal]
  for (const h of hits) {
    const d = routeHit(h, strong)
    const k = normalizeQuery(h.row.query)
    const prev = byQuery.get(k)
    if (prev === undefined || better(d, prev)) byQuery.set(k, d)
  }
  const sorted = [...byQuery.values()].sort(
    (a, b) =>
      LANE_ORDER[a.lane] - LANE_ORDER[b.lane] ||
      b.row.impressions - a.row.impressions ||
      b.row.clicks - a.row.clicks ||
      a.row.query.localeCompare(b.row.query),
  )
  const seen = new Set<string>()
  const out: PickDraft[] = []
  for (const d of sorted) {
    if (d.lane === 'fix_page' && d.fix !== undefined) {
      const key = `${fixTarget(d)}|${d.fix}`
      if (seen.has(key)) continue
      seen.add(key)
    }
    out.push(d)
  }
  return out
}

/**
 * 这件改动落在哪一页：内链改的是**链出去的那一页**（强页），其余改的就是排上的那一页。
 * 同一页同一种改法一天只出一次，按它判。
 */
export function fixTarget(d: Pick<PickDraft, 'fix' | 'link_from' | 'row'>): string {
  return d.fix === 'internal_link_edit' && d.link_from !== undefined ? d.link_from : d.row.page
}

/** 草稿 → 卡上的一件（`rank` 由调用方按最终顺序填）。 */
export function toPick(d: PickDraft, rank: number): SeoPick {
  return {
    rank,
    signal: d.signal,
    query: d.row.query,
    ...(d.row.page === '' ? {} : { page: d.row.page }),
    evidence: evidenceOf(d.row),
    lane: d.lane,
    ...(d.fix === undefined ? {} : { fix: d.fix }),
    ...(d.link_from === undefined ? {} : { link_from: d.link_from }),
    suggestion: d.suggestion,
  }
}
