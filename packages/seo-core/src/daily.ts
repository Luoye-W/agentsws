/**
 * 每天早上那一轮：读 → 判断 → 挑 5 件（WP154 §2 / §3）。
 *
 * 这里只**算**，不出卡、不开事项——那些副作用在服务端（`apps/server/src/seo-service.ts`）。
 * 算的结果就是 `SeoDailyPayload`：卡上那 5 件 + 每个信号的命中数 + 几句人话备注。
 *
 * 搜索数据接口（WP155）只在一个地方用：新页面那几件要先看一眼 SERP。没接
 * （`status().configured === false`）就跳过，卡上一句「搜索数据接口还没接」，其余照跑。
 */
import type {
  GscRow,
  SearchDataPort,
  SeoDailyPayload,
  SeoPick,
  SitePage,
} from '@agentsws/contracts'
import { DAILY_PICKS, type PickDraft, rankDrafts, toPick } from './picks.js'
import { judgeSerpCrowd } from './serp.js'
import { countSignals, detectSignals, type SignalOptions } from './signals.js'

/** 一天最多看几次 SERP（一次一个词；官方数据接口按次扣积分，不能因为候选多就一直查）。 */
export const MAX_SERP_CHECKS_PER_DAY = 5

export const NOTE_GSC_MISSING = 'Search Console 还没连，接上才看得到每天值得动的几件事。'
export const NOTE_SEARCH_DATA_MISSING =
  '搜索数据接口还没接：新页面选题没先看搜索结果，所以今天不出选题卡，只列在这里。'

export interface DailyInput {
  /** `undefined` = Search Console 没连（不是"今天没数据"）。 */
  rows: readonly GscRow[] | undefined
  pages: readonly SitePage[]
  signals: SignalOptions
  search: SearchDataPort
  /** SERP 按哪个国家 / 语言查（工作区设置）。 */
  country: string
  language: string
  our_domains: readonly string[]
  date: string
}

/**
 * 算今天那张卡。
 *
 * 顺序：先修再写的草稿表（`rankDrafts`）从上往下走，新页面那几件逐个看 SERP——
 * 人群不对的**划掉并记一句**，下一件补上来；凑满 5 件或者草稿走完为止。
 */
export async function buildDaily(input: DailyInput): Promise<SeoDailyPayload> {
  const notes: string[] = []
  if (input.rows === undefined) {
    return {
      variant: 'daily',
      date: input.date,
      gsc: 'not_connected',
      search_data: (await input.search.status()).configured ? 'configured' : 'not_configured',
      picks: [],
      signal_counts: countSignals([]),
      notes: [NOTE_GSC_MISSING],
    }
  }
  const hits = detectSignals(input.rows, input.pages, input.signals)
  const drafts = rankDrafts(hits, input.rows)
  const status = await input.search.status()
  let serpBudget = MAX_SERP_CHECKS_PER_DAY
  const picks: SeoPick[] = []
  let skippedNote = false
  for (const d of drafts) {
    if (picks.length >= DAILY_PICKS) break
    const pick = toPick(d, picks.length + 1)
    if (d.lane === 'new_page') {
      const checked = await checkNewPage(d, pick, input, status.configured, serpBudget)
      if (checked.used) serpBudget -= 1
      if (checked.killed !== undefined) {
        notes.push(checked.killed)
        continue
      }
      if (pick.serp_skipped !== undefined && !skippedNote) {
        skippedNote = true
        notes.push(status.configured ? pick.serp_skipped : NOTE_SEARCH_DATA_MISSING)
      }
    }
    picks.push(pick)
  }
  if (picks.length === 0) notes.push('六个信号今天一个都没响，没有值得动的——不硬凑。')
  return {
    variant: 'daily',
    date: input.date,
    gsc: 'connected',
    search_data: status.configured ? 'configured' : 'not_configured',
    picks,
    signal_counts: countSignals(hits),
    notes,
  }
}

async function checkNewPage(
  d: PickDraft,
  pick: SeoPick,
  input: DailyInput,
  configured: boolean,
  budget: number,
): Promise<{ used: boolean; killed?: string }> {
  if (!configured) {
    pick.serp_skipped = '搜索数据接口还没接'
    return { used: false }
  }
  if (budget <= 0) {
    pick.serp_skipped = '今天看搜索结果的次数用完了，明天再看'
    return { used: false }
  }
  try {
    const serp = await input.search.serp({
      query: d.row.query,
      engine: 'google',
      country: input.country,
      language: input.language,
    })
    const check = judgeSerpCrowd(serp, input.our_domains)
    if (!check.right_crowd) return { used: true, killed: `「${d.row.query}」：${check.reason}` }
    pick.serp_check = check
    return { used: true }
  } catch (err) {
    // 拉不到照实说，不当成"人群对"——这一件留在卡上，但不出选题卡
    pick.serp_skipped = `这次没查到搜索结果（${(err instanceof Error ? err.message : String(err)).slice(0, 80)}）`
    return { used: true }
  }
}
