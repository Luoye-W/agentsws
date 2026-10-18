/**
 * WP394：亚马逊店铺运营「竞品动向」的工具执行器（定义在 `@agentsws/stand-ins` 的 `runtime/amazon-competitor.ts`）。
 *
 * - `read_amazon_competitors`：现在读一次 Amazon 对标款；还没配好回 `needs_setup: 'amazon.competitor_watch'`
 *   （运行时收尾时出方案卡，人点头之后按原话接着做）。被拦退云端、扣了多少积分在出参 `say` 里，要照实说。
 *
 * 只给 `amz.store`；只读 Amazon 前台公开页面，不出审批卡。
 */
import type { WorkspaceId } from '@agentsws/contracts'
import {
  AMAZON_COMPETITOR_ROLES,
  READ_AMAZON_COMPETITORS_TOOL,
  type ToolExecutor,
} from '@agentsws/stand-ins'
import type { AmazonCompetitorAssembly } from './amazon-plan.js'

const bare = (name: string): string =>
  name.includes('.') ? name.slice(name.indexOf('.') + 1) : name
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, 300) : undefined

export function createAmazonCompetitorTools(options: {
  of(workspace_id: WorkspaceId): Promise<AmazonCompetitorAssembly | undefined>
}): ToolExecutor {
  return async (call) => {
    if (!AMAZON_COMPETITOR_ROLES.includes(call.request.actor.role_id))
      return { status: 'blocked', reason: '这条职责管不了 Amazon 竞品' }
    const ac = await options.of(call.request.workspace_id as WorkspaceId)
    if (ac === undefined) return { status: 'error', reason: '这台电脑上没装竞品监控' }
    const competitor = str(call.input?.competitor)
    switch (bare(call.name)) {
      case READ_AMAZON_COMPETITORS_TOOL:
        return {
          status: 'ok',
          data: await ac.readNow(competitor === undefined ? {} : { competitor }),
        }
      default:
        return { status: 'error', reason: `不认识的工具 ${call.name}` }
    }
  }
}
