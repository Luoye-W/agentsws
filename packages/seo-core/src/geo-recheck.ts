/**
 * WP380：**改完自动复查**——每张 GEO 改动记「改了什么、期望哪个数动、哪天复查」；到期把那组问题
 * 原样再问一遍，和改之前比，给「保留 / 扩大 / 修改 / 停」建议。
 *
 * 纯函数：取那组问题上的数（前 / 后）、按差几个百分点给建议。样本太少（任一边 < 3）不下结论。
 */
import type {
  GeoRecheck,
  GeoRecheckAdvice,
  GeoRecheckMetric,
  GeoRecheckSide,
} from '@agentsws/contracts'
import { latestPerCell, type MetricAnswer } from './geo-metrics.js'

/** 任一边样本少于这个数就不下结论。 */
export const RECHECK_MIN_N = 3
/** 默认几天后复查（本职责改页面）；要等站外改的（公关、一致性）用 {@link RECHECK_DAYS_OFFSITE}。 */
export const RECHECK_DAYS = 14
export const RECHECK_DAYS_OFFSITE = 28
/** 到期没拿到回答最多再等几次（每次一周）。 */
export const RECHECK_MAX_TRIES = 2

/** 建议的门槛（百分点）：≥ 20 扩大、≥ 5 保留、> −5 修改、其余停。 */
export const RECHECK_EXPAND_PP = 20
export const RECHECK_KEEP_PP = 5

/** 复查建议的中文。 */
export const RECHECK_ADVICE_ZH: Readonly<Record<GeoRecheckAdvice, string>> = {
  keep: '保留',
  expand: '扩大',
  modify: '修改',
  stop: '停',
}

/** 复查看的数的中文。 */
export const RECHECK_METRIC_ZH: Readonly<Record<GeoRecheckMetric, string>> = {
  mention_rate: '提及率',
  citation_rate: '引用率',
  win_rate: '比较胜率',
  accuracy: '描述准确度',
}

const round = (v: number): number => Math.round(v * 1000) / 1000

/**
 * 一组问题上的数（只算拿到回答的；同一格取最新）。`week` 给了只看那一周，不给看这些行里最新的一周。
 */
export function recheckSide(
  rows: readonly MetricAnswer[],
  metric: GeoRecheckMetric,
  prompt_ids: readonly string[],
  week?: string,
): GeoRecheckSide {
  const ids = new Set(prompt_ids)
  const mine = latestPerCell(rows).filter(
    (r) => r.answer.status === 'ok' && ids.has(r.answer.prompt_id),
  )
  const at = week ?? [...new Set(mine.map((r) => r.week))].sort().at(-1)
  if (at === undefined) return { n: 0 }
  const ok = mine.filter((r) => r.week === at)
  const ours = (r: MetricAnswer) => r.mentions.find((m) => m.entity === 'ours')
  let hit = 0
  let n = 0
  if (metric === 'mention_rate' || metric === 'citation_rate') {
    n = ok.length
    hit = ok.filter((r) =>
      metric === 'mention_rate' ? ours(r)?.mentioned === true : ours(r)?.cited === true,
    ).length
  } else if (metric === 'win_rate') {
    const decided = ok.flatMap((r) =>
      r.insight?.compare === undefined || r.insight.compare.verdict === 'tie'
        ? []
        : [r.insight.compare],
    )
    n = decided.length
    hit = decided.filter((c) => c.verdict === 'ours').length
  } else {
    const claims = ok.flatMap((r) => r.insight?.claims ?? [])
    n = claims.length
    hit = claims.filter((c) => c.verdict === 'correct').length
  }
  return n === 0 ? { n: 0, week: at } : { value: round(hit / n), n, week: at }
}

/** 前后一比：差几个百分点、建议、一句为什么。样本太少回 `undefined`（再等等）。 */
export function recheckAdvice(
  before: GeoRecheckSide,
  after: GeoRecheckSide,
): Pick<GeoRecheck, 'advice' | 'delta_pp' | 'why'> | undefined {
  if (after.value === undefined || after.n < RECHECK_MIN_N) return undefined
  if (before.value === undefined || before.n < RECHECK_MIN_N) {
    const good = after.value >= 0.6
    return {
      advice: good ? 'keep' : 'modify',
      why: good
        ? `改之前没有可比的数；现在 ${Math.round(after.value * 100)}%（n=${after.n}），先保留。`
        : `改之前没有可比的数；现在只有 ${Math.round(after.value * 100)}%（n=${after.n}），换个改法。`,
    }
  }
  const delta = Math.round((after.value - before.value) * 1000) / 10
  const advice: GeoRecheckAdvice =
    delta >= RECHECK_EXPAND_PP
      ? 'expand'
      : delta >= RECHECK_KEEP_PP
        ? 'keep'
        : delta > -RECHECK_KEEP_PP
          ? 'modify'
          : 'stop'
  const from = `${Math.round(before.value * 100)}%（n=${before.n}）`
  const to = `${Math.round(after.value * 100)}%（n=${after.n}）`
  const why =
    advice === 'expand'
      ? `从 ${from} 到 ${to}，明显变好：同样的改法用到相近的页和问题上。`
      : advice === 'keep'
        ? `从 ${from} 到 ${to}，有点变好：保留，继续看。`
        : advice === 'modify'
          ? `从 ${from} 到 ${to}，没什么动静：换一种改法。`
          : `从 ${from} 到 ${to}，变差了：先停下，考虑改回去。`
  return { advice, delta_pp: delta, why }
}
