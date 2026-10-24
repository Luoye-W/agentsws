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
  PROPOSE_KNOWLEDGE_TOGGLE_TOOL,
  type ToolExecution,
  type ToolExecutor,
} from '@agentsws/stand-ins'
import type { KnowledgeLearner, LearnActor } from './knowledge-learn.js'

const bare = (name: string): string => name.split('__').pop() ?? name

/** WP506（决策 1796 C）：AI 提议停用 / 启用知识——只出卡；回来的是出没出卡、几条。 */
export interface KnowledgeToggleProposal {
  ok: boolean
  approval_item_id?: string
  count: number
  message: string
}

export interface KnowledgeToggleInput {
  action: 'disable' | 'enable'
  reason: string
  query?: string
  ids?: string[]
}

export function createKnowledgeLearnToolExecutor(options: {
  learner(): KnowledgeLearner | undefined
  /** 这个品牌接没接邮箱（没接直接回连接码，不开空事）。 */
  mailConnected(workspace_id: string): Promise<boolean>
  /**
   * WP506（决策 1796 C）：出一张「停用 / 启用这几条？」确认卡（不改任何东西）。不给 = 这个进程没有这一项。
   */
  proposeToggle?(actor: LearnActor, input: KnowledgeToggleInput): Promise<KnowledgeToggleProposal>
}): ToolExecutor {
  /** WP506：只出卡（人点了才生效），不碰知识库。 */
  const proposeToggle = async (call: Parameters<ToolExecutor>[0]): Promise<ToolExecution> => {
    if (options.proposeToggle === undefined)
      return { status: 'error', reason: '这里没装停用 / 启用知识的提议。' }
    const input = call.input
    const action =
      input.action === 'enable' ? 'enable' : input.action === 'disable' ? 'disable' : undefined
    if (action === undefined) return { status: 'error', reason: 'action 只认 disable / enable。' }
    const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 300) : ''
    if (reason === '') return { status: 'error', reason: '要写一句理由（reason），卡上给人看。' }
    const query = typeof input.query === 'string' ? input.query.trim().slice(0, 100) : ''
    const ids = Array.isArray(input.ids)
      ? input.ids.filter((x): x is string => typeof x === 'string' && x !== '').slice(0, 20)
      : []
    if (query === '' && ids.length === 0)
      return { status: 'error', reason: '给一个关键词（query）或知识 id（ids），才知道是哪几条。' }
    const req = call.request
    const out = await options.proposeToggle(
      {
        person_id: req.actor.person_id,
        workspace_id: req.workspace_id as never,
        assignment_id: req.actor.assignment_id,
        role_id: req.actor.role_id,
      },
      {
        action,
        reason,
        ...(query === '' ? {} : { query }),
        ...(ids.length === 0 ? {} : { ids }),
      },
    )
    return { status: 'ok', data: out }
  }
  return async (call): Promise<ToolExecution> => {
    if (!KNOWLEDGE_LEARN_TOOL_NAMES.includes(bare(call.name)))
      return { status: 'error', reason: '不认识的工具' }
    const req = call.request
    if (!isKnowledgeLearnRole(req.actor.role_id))
      return {
        status: 'blocked',
        reason:
          bare(call.name) === PROPOSE_KNOWLEDGE_TOGGLE_TOOL
            ? '停用 / 启用知识的提议只给客服岗位。'
            : '「学一遍」只给客服岗位。',
      }
    if (bare(call.name) === PROPOSE_KNOWLEDGE_TOGGLE_TOOL) return proposeToggle(call)
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
