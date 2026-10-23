/**
 * WP488（决策 1680 / 1681）：客服岗位「学一遍」工具 `learn_support_knowledge` 的执行器
 * （名字 / 描述在 `@agentsws/stand-ins` 的 `runtime/knowledge-learn.ts`）。
 *
 * 对话里一句话：「从过往邮件学一下」「售后站是 help.example.com，学一下」→ 开一次「学一遍」（后台跑）。
 * 没接邮箱 → 回 `needs_connection:imap_smtp`，运行就地出连接卡（决策 690）；回给模型的是开跑结果，不是学到的内容。
 */
import { needsConnectionReason } from '@agentsws/contracts'
import {
  isKnowledgeLearnRole,
  KNOWLEDGE_LEARN_TOOL_NAMES,
  type ToolExecution,
  type ToolExecutor,
} from '@agentsws/stand-ins'
import type { KnowledgeLearner, LearnActor } from './knowledge-learn.js'

const bare = (name: string): string => name.split('__').pop() ?? name

export function createKnowledgeLearnToolExecutor(options: {
  learner(): KnowledgeLearner | undefined
  /** 这个品牌接没接邮箱（没接直接回连接码，不开空事）。 */
  mailConnected(workspace_id: string): Promise<boolean>
}): ToolExecutor {
  return async (call): Promise<ToolExecution> => {
    if (!KNOWLEDGE_LEARN_TOOL_NAMES.includes(bare(call.name)))
      return { status: 'error', reason: '不认识的工具' }
    const req = call.request
    if (!isKnowledgeLearnRole(req.actor.role_id))
      return { status: 'blocked', reason: '「学一遍」只给客服岗位。' }
    const learner = options.learner()
    if (learner === undefined) return { status: 'error', reason: '这里没装「学一遍」。' }
    const input = call.input
    const source = input.source === 'website' ? 'website' : 'email'
    if (source === 'email' && !(await options.mailConnected(req.workspace_id)))
      return {
        status: 'error',
        reason: needsConnectionReason('imap_smtp', '还没接客服邮箱，接上之后才能从过往邮件学。'),
      }
    const actor: LearnActor = {
      person_id: req.actor.person_id,
      workspace_id: req.workspace_id as never,
      assignment_id: req.actor.assignment_id,
      role_id: req.actor.role_id,
    }
    const months = typeof input.months === 'number' ? input.months : undefined
    const urls = Array.isArray(input.urls)
      ? input.urls.filter((u): u is string => typeof u === 'string').slice(0, 5)
      : undefined
    const job = await learner.start(actor, {
      source,
      ...(months === undefined ? {} : { months }),
      ...(urls === undefined ? {} : { urls }),
    })
    return {
      status: 'ok',
      data: {
        ok: job.state === 'running',
        state: job.state,
        source: job.source,
        ...(job.months === undefined ? {} : { months: job.months }),
        ...(job.urls === undefined ? {} : { urls: job.urls }),
        ...(job.matter_id === undefined ? {} : { matter_id: job.matter_id }),
        ...(job.note === undefined ? {} : { note: job.note }),
        message:
          job.state === 'running'
            ? '开始学了（后台跑，有进度）；学完会出一张「学到 N 条」的卡给用户确认、改范围。'
            : (job.note ?? '没开起来。'),
      },
    }
  }
}
