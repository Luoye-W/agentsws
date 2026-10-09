/**
 * WP289（决策 318）：「以后都这样」出卡这一步——**卡片指导与聊天窗「教 AI」共用这一份**。
 *
 * 不管从哪儿教，都是同一张策略卡（`@agentsws/core` 的 `instructionRuleCard`）、同一个收件人
 * （③ 老板，① ② 本人：`instructionRuleApprover`）、同一条目录项（工具箱上的「规矩」）；
 * 批了由宿主落进同一本职责规矩（服务端 `role-rules.ts` 的 `onDecided`），之后进运行提示词。
 */
import type { ApprovalItem } from '@agentsws/contracts'
import { instructionRuleCard } from '@agentsws/core'
import type { GatewayDeps } from './types.js'

export async function proposeInstructionRule(
  deps: GatewayDeps,
  input: {
    workspace_id: string
    person_id: string
    assignment_id: string
    /** 指导写在哪张卡上（聊天窗来的：按会话合成的一张，见 `chat`）。 */
    item: Pick<ApprovalItem, 'id' | 'role_id' | 'subject' | 'title'>
    text: string
    chat?: { session_id: string }
  },
): Promise<ApprovalItem | undefined> {
  // ③ 发给批策略变更的老板（普通成员自己点不了，收件人令牌不在他手上）；① ② 本人
  const approver = await deps.instructionRuleApprover?.(input.workspace_id)
  const created = await deps.approvals.create(
    instructionRuleCard({
      workspace_id: input.workspace_id,
      person_id: input.person_id,
      assignment_id: input.assignment_id,
      item: input.item,
      text: input.text,
      ...(approver === undefined ? {} : { approver }),
      ...(input.chat === undefined ? {} : { chat: input.chat }),
    }),
  )
  if (created.state === 'blocked') return undefined
  // 规矩在别处没有一张自己的表：目录替它保管一份，工具箱上才看得见
  await deps.catalog?.record?.({
    kind: 'rule',
    id: `rule:${created.id}`,
    title: input.text.slice(0, 60),
    summary: '指导落成的规矩：批了写进这条职责的规矩',
    owner: input.person_id,
    layer: 'personal',
    used_by_positions: [input.assignment_id],
    runs_30d: 0,
    workspace_id: input.workspace_id,
  })
  return created
}
