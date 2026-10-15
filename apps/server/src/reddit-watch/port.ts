/**
 * WP328：把每品牌一份的巡查服务接到网关端口上（插件按令牌上的品牌、工作台按请求人的品牌）。
 */
import type { RedditWatchPort } from '@agentsws/api'
import type { WorkspaceId } from '@agentsws/contracts'
import type { RedditWatchAssembly } from './service.js'

export function redditWatchPort(
  of: (ws: WorkspaceId) => Promise<RedditWatchAssembly>,
): RedditWatchPort {
  return {
    next: async (session, input) => (await of(session.workspace_id)).next(input),
    result: async (session, id, input) => (await of(session.workspace_id)).result(id, input),
    view: async (ws) => (await of(ws)).view(),
    updateSettings: async (ws, patch) => (await of(ws)).updateSettings(patch),
    runNow: async (ws) => (await of(ws)).runNow(),
    items: async (ws, query) => (await of(ws)).items(query),
    setStatus: async (ws, id, status) => (await of(ws)).setStatus(id, status),
    digest: async (ws, window) => (await of(ws)).digest(window),
    dismissAlert: async (ws, id) => (await of(ws)).dismissAlert(id),
  }
}
