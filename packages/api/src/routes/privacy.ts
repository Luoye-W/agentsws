/**
 * 21 §4「删这个人」的唯一入口（39 待办 I）。
 *
 * 为什么要一条路由而不是三次调用：数据层、邮件原始区、会议原始区各有自己的
 * `eraseSubject`，三次独立调用意味着「删干净了没有」取决于调用方记不记得三处都调。
 * GDPR 上的删除请求不接受「忘了一处」，所以这里只暴露**一条**，编排在服务进程里。
 *
 * 三条纪律：
 * - **只有 owner 能删**：这是不可逆的（密钥一销毁，备份里的密文也读不出来了），
 *   和换密钥库密钥同一个等级的权限（v1 = 能写工作区策略层的人）。
 * - **可重跑**：任一步失败整体回 `partial`，同一个请求再发一次就是补做没成的那几步。
 * - **响应里没有被删的内容**：只有「删了哪个主体、每个库几行、成没成」。
 */
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { assignmentOf, body, ok, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'

const EraseBody = z.object({
  /** 主体的自然键：邮箱地址（邮件原始区按它加密与删行，会议侧按它匹配与会者）。 */
  subject: z.string().min(1).max(320),
  /** 数据层那一条记录；不给就不动数据层（那一步记 skipped）。 */
  record: z.object({ collection: z.string().min(1), id: z.string().min(1) }).optional(),
  /** 要连整场录音一起销毁的会议 id；不给只删这个人的转写行与产出。 */
  meetings: z.array(z.string().min(1)).max(200).optional(),
})

/** 删除是不可逆的，和换密钥库密钥同一个等级（v1 = owner）。 */
const OWNER = {
  domain: 'policy',
  op: 'stage',
  range: 'workspace',
  sensitivity: 'restricted',
} as const

export interface PrivacyEraseStepView {
  store: 'data' | 'channels' | 'meetings'
  status: 'done' | 'skipped' | 'failed'
  rows?: number
  shredded_at?: string
  error?: string
}

export interface PrivacyEraseView {
  subject: string
  status: 'done' | 'partial'
  at: string
  steps: PrivacyEraseStepView[]
}

/** 网关这一层只转发；三个库的编排在服务进程里（`apps/server/src/erase.ts`）。 */
export interface PrivacyPort {
  erase(
    input: {
      subject: string
      record?: { collection: string; id: string }
      meetings?: readonly string[]
    },
    actor: { workspace_id: string; person_id: string; assignment_id: string },
  ): Promise<PrivacyEraseView>
}

export function privacyRoutes(): Route[] {
  return [
    route(
      {
        method: 'post',
        path: '/v1/privacy/erase',
        operationId: 'erasePrivacySubject',
        summary: '把一个主体从数据层 / 邮件原始区 / 会议原始区一次删掉（owner）',
        tag: 'kernel',
        auth: 'bearer',
        assignment: true,
        authz: OWNER,
        body: EraseBody,
        returns: '{ subject, status: done|partial, at, steps[] }（**不回被删的内容**）',
      },
      async (c, deps) => {
        const p = principalOf(c)
        const assignment = assignmentOf(c)
        const privacy = deps.privacy
        if (privacy === undefined)
          throw new ApiError('not_implemented', '这个服务进程没有装配删除编排')
        const input = await body(c, EraseBody)
        const out = await privacy.erase(
          {
            subject: input.subject,
            ...(input.record === undefined ? {} : { record: input.record }),
            ...(input.meetings === undefined ? {} : { meetings: input.meetings }),
          },
          {
            workspace_id: p.workspace_id,
            person_id: p.person_id,
            assignment_id: assignment.id,
          },
        )
        // 墓碑事件由编排自己写（它知道每一步的结果）；这里不重复写一条
        return ok(c, out)
      },
    ),
  ]
}
