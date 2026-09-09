/**
 * 36 §3 首页装配：① 跨岗位卡片队列 + 告警 ② 每岗位一条核心数据条 ③ 摘要 + 「预计 X 分钟」。
 *
 * 首页**没有图表也没有表格**（36 §5.2）：`tiles` 里只有 stat_tile，其余积木都在岗位面板。
 */
import type { ApprovalItem, RoleId } from '@agentsws/contracts'
import { estimatedMinutes, projectCard } from './project.js'
import { sortCards } from './queue.js'
import { computeTiles } from './tiles.js'
import type {
  DeckCard,
  HomeAssembly,
  PositionId,
  PositionTiles,
  ProjectContext,
  QueryContext,
  RangeName,
} from './types.js'

export interface HomePosition {
  position_id: PositionId
  role_id: RoleId
  role_name: string
  /** 该岗位的待办（已按 recipient 过滤好） */
  items: ApprovalItem[]
  /** 用户挑过的数字块；没挑过就传职责默认值 */
  tile_ids: string[]
  /** 该岗位记住的时间范围（36 §3：时间范围跟随岗位记忆） */
  range: RangeName
  /** 该岗位的查询上下文（数据源连接状态、订单行…） */
  query: QueryContext
}

export interface HomeInput {
  now: string
  positions: HomePosition[]
  /** 系统卡（重新授权 / 预算告急 / 模型不可用）；不是审批项，宿主直接给 */
  alerts?: DeckCard[]
  digest?: DeckCard
  /** 首页整体的时间范围；没给就各岗位用自己的记忆 */
  range?: RangeName
  label?: ProjectContext['label']
  riskClass?: ProjectContext['riskClass']
}

/**
 * 只有**系统卡**离开队列（06 §1.2 的 `alert` placement）。
 *
 * WP15 把 P0 也踢进告警区，这在 37 §1 的一次一张 deck 下是错的：P0 是"客户在等"，
 * 它必须是这副牌的第一张、带着倒计时被人翻到，而不是被搬到卡片队列之外的另一个区
 * ——那样筛选、合并、"第 N / M 张"全都跳过它，倒计时也没人看。排序已经把 P0 放在
 * 最前面了，不需要第二个容器。
 */
const isAlert = (card: DeckCard): boolean => card.kind === 'system_alert'

export function assembleHome(input: HomeInput): HomeAssembly {
  const queue: DeckCard[] = []
  const alerts: DeckCard[] = [...(input.alerts ?? [])]
  const tiles: PositionTiles[] = []

  for (const p of input.positions) {
    const ctx: ProjectContext = {
      now: input.now,
      position_id: p.position_id,
      ...(input.label === undefined ? {} : { label: input.label }),
      ...(input.riskClass === undefined ? {} : { riskClass: input.riskClass }),
    }
    for (const item of p.items) {
      const card = projectCard(item, ctx)
      if (card.kind === 'digest') continue
      if (isAlert(card)) alerts.push(card)
      else queue.push(card)
    }
    // 没有数字块的岗位（common.member / common.owner 之类）不出数据条，
    // 但它的卡照样进队列——首页的形状不随岗位数变（06 §1.1）。
    if (p.tile_ids.length > 0) {
      const range = input.range ?? p.range
      tiles.push({
        position_id: p.position_id,
        role_id: p.role_id,
        role_name: p.role_name,
        range,
        tiles: computeTiles(p.tile_ids, p.query, range),
      })
    }
  }

  const sortedQueue = sortCards(queue)
  const sortedAlerts = sortCards(alerts)
  return {
    queue: sortedQueue,
    alerts: sortedAlerts,
    tiles,
    ...(input.digest === undefined ? {} : { digest: input.digest }),
    // 「今天队列预计 X 分钟」把告警也算进去——它们同样要人处理（14 §8）
    estimated_minutes: estimatedMinutes([...sortedQueue, ...sortedAlerts]),
    range: input.range ?? input.positions[0]?.range ?? 'yesterday',
  }
}
