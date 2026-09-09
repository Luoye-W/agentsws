/**
 * 36 §3 三个对话入口之一：卡片 / 记录里的「问 AI」——**单轮、只你可见、不发给客户**。
 *
 * 四条纪律，全部在这条路由与它的宿主实现里兑现：
 * 1. **单轮**：一次 `complete`，没有会话、没有工具、没有续跑；
 * 2. **只回给本人**：答案只在这个响应体里，不落审批项、不落草稿、不进任何对客户可见的地方；
 * 3. **有边界**：只能问某个事项或某张卡——上下文按本人身份取，外部文本经围栏；
 * 4. **可审计但不留正文**：事件日志里有 `model.*` 与 `ask.answered`，但**只记哈希**，
 *    问题与答案的正文不进事件日志（21 §5）。
 */
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { assignmentOf, body, ok, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'

const AskBody = z
  .object({
    scope: z.object({
      matter_id: z.string().min(1).optional(),
      card_id: z.string().min(1).optional(),
    }),
    question: z.string().min(1).max(2000),
  })
  .refine((v) => v.scope.matter_id !== undefined || v.scope.card_id !== undefined, {
    message: '问 AI 一定有边界：scope 里至少要有 matter_id 或 card_id',
  })

export interface AskActor {
  workspace_id: string
  person_id: string
  assignment_id: string
}

export interface AskAnswer {
  answer: string
  /** 答案的 sha256（事件日志里只留它，不留正文） */
  answer_hash: string
  /** 这次回答看了什么（人话，不露裸 id） */
  grounded_on: string[]
}

export interface AskPort {
  ask(
    actor: AskActor,
    input: {
      scope: { matter_id?: string | undefined; card_id?: string | undefined }
      question: string
    },
  ): Promise<AskAnswer>
}

export function askRoutes(): Route[] {
  return [
    route(
      {
        method: 'post',
        path: '/v1/ask',
        operationId: 'askAi',
        summary: '问 AI（单轮、只你可见、不发给客户）',
        tag: 'workstation',
        auth: 'bearer',
        assignment: true,
        // 能读自己的队列就能问自己看得见的东西；上下文按本人身份取
        authz: { domain: 'approval', op: 'read', range: 'own', sensitivity: 'internal' },
        body: AskBody,
        returns: '{ answer, answer_hash, grounded_on }',
      },
      async (c, deps: GatewayDeps) => {
        const p = principalOf(c)
        const assignment = assignmentOf(c)
        const port = deps.ask
        if (port === undefined)
          throw new ApiError('not_implemented', '这个服务进程没有装配问 AI（GatewayDeps.ask）')
        const input = await body(c, AskBody)
        return ok(
          c,
          await port.ask(
            {
              workspace_id: p.workspace_id,
              person_id: p.person_id,
              assignment_id: assignment.id,
            },
            input,
          ),
        )
      },
    ),
  ]
}
