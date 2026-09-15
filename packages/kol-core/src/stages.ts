/**
 * 合作与交付物的阶段机（48 §5.2「阶段机（合作与交付物）」）。
 *
 * **全仓库只有这一份合法迁移表**。guardrail 那一层（`kol_collaboration` 的
 * `stage_transition_ok`）认的是这里算出来的结论，不自己再写一张——两张表分头
 * 演化的后果是"提案层放过、账本层拦下"，而卡面上看不出为什么。
 *
 * 非法跳转抛的是**人话**（36 §1）：不是 `invalid transition sourced->delivered`，
 * 是"还没建联就说交付完了——中间少了建联、回复、谈条件、签定、拍片这几步"。
 * 这种错误最后会出现在卡面上或事项时间线上，写给机器看等于白写。
 */
import type { CollaborationStage, DeliverableReview } from '@agentsws/contracts'

/**
 * 合作的合法迁移（48 §5.1 那条链）。
 *
 * 主线单向：`sourced → contacted → replied → negotiating → agreed → delivering
 * → delivered → closed`。三条额外的边，每条都有理由：
 *
 * - 任何一态都能掉到 `declined`（对方随时可以说不）；
 * - `contacted → negotiating`（有的人第一封信就直接开价，跳过"回复"那一格没意义）；
 * - `declined → contacted`（半年后再问一次是常事；重新开始，不是接着上次）。
 *
 * 没有 `closed → *`：结了就是结了。要再合作一次，建新的一条——
 * 否则一条记录上会挂着两次合作的预算与交付物，归因就永远算不清。
 */
export const COLLABORATION_TRANSITIONS: Readonly<
  Record<CollaborationStage, readonly CollaborationStage[]>
> = {
  sourced: ['contacted', 'declined'],
  contacted: ['replied', 'negotiating', 'declined'],
  replied: ['negotiating', 'declined'],
  negotiating: ['agreed', 'declined'],
  agreed: ['delivering', 'declined'],
  delivering: ['delivered', 'declined'],
  delivered: ['closed', 'declined'],
  closed: [],
  declined: ['contacted'],
}

/** 交付物审核结论的合法迁移。`rejected` 是终态：这一条不要了，要就重交一条新的。 */
export const DELIVERABLE_TRANSITIONS: Readonly<
  Record<DeliverableReview, readonly DeliverableReview[]>
> = {
  pending: ['approved', 'changes_requested', 'rejected'],
  // 打回去改完再交上来，回到待审
  changes_requested: ['pending', 'rejected'],
  // 批过了还能打回：视频发出去之后发现描述区的链接是错的，这条路必须留着
  approved: ['changes_requested'],
  rejected: [],
}

const STAGE_ZH: Readonly<Record<CollaborationStage, string>> = {
  sourced: '已找到',
  contacted: '已建联',
  replied: '已回复',
  negotiating: '谈条件中',
  agreed: '已签定',
  delivering: '拍摄制作中',
  delivered: '已交付',
  closed: '已结案',
  declined: '已谢绝',
}

const REVIEW_ZH: Readonly<Record<DeliverableReview, string>> = {
  pending: '待审',
  approved: '已通过',
  changes_requested: '要求修改',
  rejected: '已拒收',
}

/** 阶段的中文名（卡面与面板上显示的那一个）。 */
export const collaborationStageName = (s: CollaborationStage): string => STAGE_ZH[s]
/** 审核结论的中文名。 */
export const deliverableReviewName = (s: DeliverableReview): string => REVIEW_ZH[s]

/** 非法跳转抛的就是它；`message` 是人话，`from` / `to` 给调用方做判断用。 */
export class StageTransitionError extends Error {
  readonly from: string
  readonly to: string
  constructor(message: string, from: string, to: string) {
    super(message)
    this.name = 'StageTransitionError'
    this.from = from
    this.to = to
  }
}

/** 这一跳合不合法（只回真假，不抛）。 */
export function canAdvanceCollaboration(from: CollaborationStage, to: CollaborationStage): boolean {
  return COLLABORATION_TRANSITIONS[from].includes(to)
}

/**
 * 走一跳合作阶段。非法就抛 {@link StageTransitionError}，`message` 是人话。
 *
 * 原地不动（`from === to`）也算非法：账本上多一行"从已建联改成已建联"，
 * 读账本的人会以为发生过什么事。
 */
export function advanceCollaboration(
  from: CollaborationStage,
  to: CollaborationStage,
): CollaborationStage {
  if (canAdvanceCollaboration(from, to)) return to
  const allowed = COLLABORATION_TRANSITIONS[from]
  const tail =
    allowed.length === 0
      ? '这条合作已经结案了，要再合作一次请新建一条。'
      : `从「${STAGE_ZH[from]}」只能走到：${allowed.map((s) => STAGE_ZH[s]).join(' / ')}。`
  throw new StageTransitionError(
    `合作不能从「${STAGE_ZH[from]}」直接跳到「${STAGE_ZH[to]}」。${tail}`,
    from,
    to,
  )
}

/** 这一跳审核结论合不合法。 */
export function canAdvanceDeliverable(from: DeliverableReview, to: DeliverableReview): boolean {
  return DELIVERABLE_TRANSITIONS[from].includes(to)
}

/** 走一跳交付物审核。非法就抛 {@link StageTransitionError}。 */
export function advanceDeliverable(
  from: DeliverableReview,
  to: DeliverableReview,
): DeliverableReview {
  if (canAdvanceDeliverable(from, to)) return to
  const allowed = DELIVERABLE_TRANSITIONS[from]
  const tail =
    allowed.length === 0
      ? '这一条已经拒收了，要继续就让对方重交一条新的。'
      : `从「${REVIEW_ZH[from]}」只能走到：${allowed.map((s) => REVIEW_ZH[s]).join(' / ')}。`
  throw new StageTransitionError(
    `交付物审核不能从「${REVIEW_ZH[from]}」直接改成「${REVIEW_ZH[to]}」。${tail}`,
    from,
    to,
  )
}

/**
 * 建联漏斗的阶段计数（面板"建联漏斗"那一块）。
 *
 * 顺序固定成主线那八格 + `declined` 收尾——面板上漏斗的形状不能随数据变，
 * 否则今天没有"谈条件中"的人，明天有了，柱子的位置就换了。
 */
export const FUNNEL_ORDER: readonly CollaborationStage[] = [
  'sourced',
  'contacted',
  'replied',
  'negotiating',
  'agreed',
  'delivering',
  'delivered',
  'closed',
  'declined',
]

export interface FunnelBucket {
  stage: CollaborationStage
  label: string
  count: number
}

/** 一批合作 → 漏斗。空的格子也出（`count: 0`），见 {@link FUNNEL_ORDER} 的注释。 */
export function collaborationFunnel(
  collaborations: readonly { stage: CollaborationStage }[],
): FunnelBucket[] {
  return FUNNEL_ORDER.map((stage) => ({
    stage,
    label: STAGE_ZH[stage],
    count: collaborations.filter((c) => c.stage === stage).length,
  }))
}
