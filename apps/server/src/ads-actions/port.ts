/**
 * WP313：插件动作通道的端口——**按令牌 / 主体上的 workspace_id 取那个品牌的那一份**
 * （与 `extension-port.ts` 同一个做法，52 O1：品牌 A 的活在 B 的任何路由里都看不到）。
 */
import type { ExtensionActionsPort } from '@agentsws/api'
import type { WorkspaceId } from '@agentsws/contracts'
import type { AdsActionsService } from './service.js'

export function brandAdsActionsPort(options: {
  serviceOf(workspace_id: WorkspaceId): Promise<AdsActionsService>
}): ExtensionActionsPort {
  const of = options.serviceOf
  return {
    next: async (session, input) =>
      (await of(session.workspace_id)).next(input.platforms, input.wait_ms),
    sheet: async (session, id) => (await of(session.workspace_id)).sheet(id),
    progress: async (session, id, input) => (await of(session.workspace_id)).progress(id, input),
    evidence: async (session, id, input) => (await of(session.workspace_id)).evidence(id, input),
    download: async (session, id, input) => (await of(session.workspace_id)).download(id, input),
    result: async (session, id, input) => (await of(session.workspace_id)).result(id, input),
    consent: async (session, input) =>
      (await of(session.workspace_id)).consent(input.platform, input.text_version),
    settings: async (ws) => (await of(ws)).settings(),
    setZone: async (ws, zone, enabled) => (await of(ws)).setZone(zone, enabled),
    revokeConsent: async (ws, platform) => (await of(ws)).revokeConsent(platform),
    jobs: async (ws) => (await of(ws)).jobs(),
    stop: async (ws, id) => (await of(ws)).stop(id),
    confirm: async (ws, id) => (await of(ws)).confirm(id),
    enqueue: async (input) =>
      (await of(input.job.workspace_id as WorkspaceId)).enqueue(input.job, input.sheet_bytes),
  }
}
