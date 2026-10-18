/**
 * WP393：店铺管理「竞品动向」那两个工具的执行器（定义在 `@agentsws/stand-ins` 的 `runtime/competitor-store.ts`）。
 *
 * - `find_competitor_store`：探一家竞品的平台、写进唯一工作清单；
 * - `read_competitor_stores`：现在读一次；还没配好回 `needs_setup: 'store.competitor_watch'`
 *   （运行时收尾时出方案卡，人点头之后按原话接着做）。
 *
 * 只给 `dtc.store`（C1）；只读外部公开页面，不出审批卡。
 */
import type { WorkspaceId } from '@agentsws/contracts'
import {
  COMPETITOR_STORE_ROLES,
  FIND_COMPETITOR_STORE_TOOL,
  READ_COMPETITOR_STORES_TOOL,
  type ToolExecutor,
} from '@agentsws/stand-ins'
import type { CompetitorStoreAssembly } from './store-plan.js'

const bare = (name: string): string =>
  name.includes('.') ? name.slice(name.indexOf('.') + 1) : name
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, 300) : undefined

export function createCompetitorStoreTools(options: {
  of(workspace_id: WorkspaceId): Promise<CompetitorStoreAssembly | undefined>
}): ToolExecutor {
  return async (call) => {
    if (!COMPETITOR_STORE_ROLES.includes(call.request.actor.role_id))
      return { status: 'blocked', reason: '这条职责管不了竞品动向' }
    const cs = await options.of(call.request.workspace_id as WorkspaceId)
    if (cs === undefined) return { status: 'error', reason: '这台电脑上没装竞品监控' }
    const input = call.input ?? {}
    const competitor = str(input.competitor)
    switch (bare(call.name)) {
      case FIND_COMPETITOR_STORE_TOOL: {
        const url = str(input.url)
        const out = await cs.find({
          ...(competitor === undefined ? {} : { competitor }),
          ...(url === undefined ? {} : { url }),
        })
        return { status: 'ok', data: out }
      }
      case READ_COMPETITOR_STORES_TOOL:
        return {
          status: 'ok',
          data: await cs.readNow(competitor === undefined ? {} : { competitor }),
        }
      default:
        return { status: 'error', reason: `不认识的工具 ${call.name}` }
    }
  }
}
