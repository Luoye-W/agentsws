/**
 * WP335（docs/99 O3）：「AI 回答监测」的接口——关注设置读写、AI 建议、现在跑一轮、看板的数、一条回答。
 *
 * 单独一个文件（`api.ts` 那张大表好几单同时在加），形状直接用契约里那几个类型。
 */
import type {
  GeoAnswerDetail,
  GeoMetricsView,
  GeoWatchPatch,
  GeoWatchRunResult,
  GeoWatchSuggestion,
  GeoWatchView,
} from '@agentsws/contracts'
import { api } from './api'

export type {
  AiPlatform,
  BrandWatch,
  BrandWatchCompetitor,
  GeoAnswerDetail,
  GeoAnswerSide,
  GeoCellState,
  GeoCitationRecord,
  GeoCitedSource,
  GeoGridView,
  GeoMetricsView,
  GeoQuestion,
  GeoRunEstimate,
  GeoWatchCardPayload,
  GeoWatchPatch,
  GeoWatchStrategy,
  GeoWatchView,
} from '@agentsws/contracts'

const as = (assignment: string | undefined) => (assignment === undefined ? {} : { assignment })

/** 关注设置 + 这一轮 / 每月大概多少积分 + 策略定没定。 */
export const getGeoWatch = (assignment?: string): Promise<GeoWatchView> =>
  api('/v1/seo/watch', as(assignment))

/** 改关注设置（每样可单给；改过就算「定了」）。 */
export const setGeoWatch = (patch: GeoWatchPatch, assignment?: string): Promise<GeoWatchView> =>
  api('/v1/seo/watch', { method: 'PUT', body: patch, ...as(assignment) })

/** 让 AI 按品牌档案重新建议一份（`card: true` 同时出一张设定卡）。 */
export const suggestGeoWatch = (
  input: { card?: boolean },
  assignment?: string,
): Promise<GeoWatchSuggestion> =>
  api('/v1/seo/watch/strategy', { method: 'POST', body: input, ...as(assignment) })

/** 现在跑一轮：有 Claude（单格 ≥ 1 积分）时先不带 `confirm` 拿估算，确认了再带上。 */
export const runGeoWatch = (
  input: { confirm?: boolean },
  assignment?: string,
): Promise<GeoWatchRunResult> =>
  api('/v1/seo/watch/run', { method: 'POST', body: input, ...as(assignment) })

/** 看板的数（默认近 12 周）。 */
export const getGeoMetrics = (assignment?: string): Promise<GeoMetricsView> =>
  api('/v1/seo/watch/metrics', as(assignment))

/** 一条回答（全文、引用、上一期、时间线）。 */
export const getGeoAnswer = (id: string, assignment?: string): Promise<GeoAnswerDetail> =>
  api(`/v1/seo/watch/answers/${encodeURIComponent(id)}`, as(assignment))

/** 第三栏「一条回答」的资源地址：`agentsws://geo-answer/<分配>/<回答 id>`。 */
export const GEO_ANSWER_ADDRESS_PREFIX = 'agentsws://geo-answer/'

export function geoAnswerAddress(assignment: string, answer_id: string): string {
  return `${GEO_ANSWER_ADDRESS_PREFIX}${encodeURIComponent(assignment)}/${encodeURIComponent(answer_id)}`
}

export function parseGeoAnswerAddress(
  address: string | undefined,
): { assignment: string; answer_id: string } | undefined {
  if (address === undefined || !address.startsWith(GEO_ANSWER_ADDRESS_PREFIX)) return undefined
  const [a, b] = address.slice(GEO_ANSWER_ADDRESS_PREFIX.length).split('/')
  if (a === undefined || b === undefined || a === '' || b === '') return undefined
  return { assignment: decodeURIComponent(a), answer_id: decodeURIComponent(b) }
}
