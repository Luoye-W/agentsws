/**
 * WP410（真机 #9）：Reddit 巡查**此刻的真实状态**——给岗位 AI 的「当前设置快照」那一段。
 *
 * 10-18 真机：AI 说「Reddit 还没连上、之前那张『连 Reddit API』的卡还在等」「关键词只有 IVRA」，
 * 实际插件早已交回 `reddit_connected: true, user: IVRA_Official`，设置里关键词有 5 个、巡查已经在跑。
 * 所以 AI 描述连接与设置一律读这里：
 * - 连接以**插件交回**的为准（`rw_kv.ext`）；Reddit 官方 API 是可选的另一条路，巡查不靠它；
 * - 设置读 `settings` 原值（不补建议值、不补 AI 猜的）；
 * - 最近一轮巡查：什么时候、每块读成没有、读了几条；正在跑就说正在跑。
 */
import type {
  Iso8601,
  RedditWatchPart,
  RedditWatchRun,
  RedditWatchSettings,
} from '@agentsws/contracts'
import type { SetupTargetState } from '../setup-cards.js'
import { formatSubList, isConfigured } from './settings.js'

/** 插件那一侧（`rw_kv.ext` 里记的，插件每次来问 / 交回时更新）。 */
export interface PatrolExtSnapshot {
  seen_at?: Iso8601
  reddit_connected?: boolean
  user?: string
  outcome?: string
}

/** 巡查用的是品牌号的登录态，官方 API 不是这条路要的东西。 */
export const REDDIT_API_OPTIONAL = '可选的另一条路；巡查走插件里的品牌号，不需要它'

const PART_ZH: Record<RedditWatchPart, string> = {
  inbox: '收件箱',
  own_sub: '自家版块',
  watch_sub: '重点版块',
  external: '外部关键词',
}
const STATUS_ZH: Record<string, string> = {
  ok: '读成了',
  waiting: '等插件交回',
  skipped: '这次跳过',
  failed: '没读成',
  needs_connection: '缺连接',
  needs_setup: '缺设置',
}

const everyLabel = (h: number): string => (h >= 24 ? '每天一次' : `每 ${h} 小时一次`)

/** 插件交回的那一句（只看插件，不看官方 API 连没连）。 */
export function pluginLine(e: PatrolExtSnapshot): string {
  if (e.seen_at === undefined) return '插件还没配对'
  if (e.reddit_connected !== true) return '插件配上了，但插件里还没连 Reddit'
  if (e.outcome === 'not_logged_in') return '插件连了 Reddit，但 Chrome 里没登录 Reddit'
  if (e.outcome === 'wrong_user')
    return `插件连了 Reddit，但 Chrome 里登着的不是品牌号${e.user === undefined ? '' : `（现在是 u/${e.user}）`}`
  return e.user === undefined
    ? '已连好（插件里连了 Reddit）'
    : `已连好：插件里连了 Reddit，Chrome 里登着 u/${e.user}`
}

/** 一轮巡查 → 一句（每块读成没有、读了几条）。 */
export function runLine(run: RedditWatchRun, running: boolean): string {
  const parts = run.parts
    .map((p) => {
      const st = STATUS_ZH[p.status] ?? p.status
      return p.status === 'ok'
        ? `${PART_ZH[p.part]}${st} ${p.fetched} 条（新 ${p.fresh}）`
        : `${PART_ZH[p.part]}${st}${p.message === undefined ? '' : `（${p.message}）`}`
    })
    .join('；')
  const head = running ? `正在巡查（${run.started_at} 开始）` : `最近一轮巡查 ${run.started_at}`
  return `${head}：${parts === '' ? '没有要读的' : parts}${running ? '' : `；新出待处理 ${run.pending} 条`}`
}

/** 设置原值 + 插件交回的连接 + 最近一轮 → 快照。 */
export function patrolState(input: {
  settings: RedditWatchSettings
  ext: PatrolExtSnapshot
  last?: RedditWatchRun
  running: boolean
  /** 还在「待处理 / 起草中」的条数。 */
  pending: number
}): SetupTargetState {
  const s = input.settings
  const per = s.sub_per_week ?? {}
  const configured = isConfigured(s)
  const notes: string[] = []
  if (!s.enabled) notes.push('巡查开关是关的')
  if (input.last === undefined) notes.push(configured ? '还没巡查过' : '还没设好，没巡查过')
  else notes.push(runLine(input.last, input.running))
  notes.push(`待处理 / 起草中 ${input.pending} 条`)
  return {
    configured,
    values: {
      自家版块: formatSubList(s.own_subreddits, per),
      重点版块: formatSubList(s.watch_subreddits ?? [], per),
      关键词: s.keywords.join(', '),
      告警词: (s.alert_words ?? []).join(', '),
      标签词: (s.tag_words ?? []).join(', '),
      品牌号: s.brand_username === undefined ? '' : `u/${s.brand_username}`,
      收件箱和关键词: everyLabel(s.every_hours),
    },
    connections: {
      'Chrome 插件（巡查走这条）': pluginLine(input.ext),
      'Reddit 官方 API': REDDIT_API_OPTIONAL,
    },
    notes,
  }
}
