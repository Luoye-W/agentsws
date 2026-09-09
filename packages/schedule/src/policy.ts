/**
 * 「这条定时任务要不要人点头」——25 §3 与 §5 的两条规则，写成一个纯函数，
 * API 路由与对话里的 `schedule_task` 工具用同一份判定（省得两处各写一遍、慢慢走偏）。
 *
 * - 25 §3：`created_by: agent` 且到点会**写 / 会发** → 出一条 `scheduled_task` 审批项；
 *   只读 / 提醒 / 起草类直接 active，在对话里出一张「已设定时」卡
 * - 25 §5：人自己建、给**自己岗位**的直接生效；给**别人岗位**建的要那边点头
 */

/** 到点那一下会做什么：只看、要写、要发。 */
export type ScheduleEffect = 'read_only' | 'writes' | 'sends'

export interface ScheduleApprovalInput {
  created_by: 'user' | 'agent'
  effect: ScheduleEffect
  /** 人建的时候：给的是不是本人自己持有的那条 Assignment。 */
  own_assignment?: boolean
}

export interface ScheduleApprovalDecision {
  needs_approval: boolean
  /** 直接生效就是 `active`；要人点头就先 `pending` */
  state: 'active' | 'pending'
  /** 人话理由，进卡片与事件 payload */
  reason: string
}

export function decideScheduleApproval(input: ScheduleApprovalInput): ScheduleApprovalDecision {
  if (input.created_by === 'agent') {
    if (input.effect === 'read_only') {
      return {
        needs_approval: false,
        state: 'active',
        reason: '只读 / 提醒类，直接生效并在对话里出卡',
      }
    }
    return {
      needs_approval: true,
      state: 'pending',
      reason: input.effect === 'sends' ? '到点会往外发，先请你确认' : '到点会写数据，先请你确认',
    }
  }
  if (input.own_assignment === false) {
    return { needs_approval: true, state: 'pending', reason: '给别人的岗位设定时，要那边点头' }
  }
  return { needs_approval: false, state: 'active', reason: '本人给自己岗位设的定时，直接生效' }
}
