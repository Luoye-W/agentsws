/**
 * WP323：`/v1/outbound/*` 的端口（网关只做装配与校验，这里把请求人所在品牌接到发出记录上）。
 */
import type { OutboundPort } from '@agentsws/api'
import { ApiError } from '@agentsws/api'
import type { OutboundLog } from './log.js'

export function createOutboundPort(log: OutboundLog): OutboundPort {
  const sinkOr404 = (ws: Parameters<OutboundLog['sinks']>[0], id: string) => {
    const s = log.sinks(ws).find((x) => x.id === id)
    if (s === undefined) throw new ApiError('not_found', '没有这个记录去处')
    return s
  }
  return {
    list: (actor, q) => log.list(actor.workspace_id, q),
    export: (actor, format, q) => log.export(actor.workspace_id, format, q),
    addFollowUp: (actor, input) => log.addFollowUp(actor.workspace_id, input) ?? null,
    counterpartDeleted: (actor, ext) => ({ rows: log.counterpartDeleted(actor.workspace_id, ext) }),
    sinks: (actor) => log.sinks(actor.workspace_id),
    pauseSink: (actor, id) => {
      sinkOr404(actor.workspace_id, id)
      return log.pause(actor.workspace_id, id) ?? sinkOr404(actor.workspace_id, id)
    },
    resumeSink: (actor, id) => {
      sinkOr404(actor.workspace_id, id)
      return log.resume(actor.workspace_id, id) ?? sinkOr404(actor.workspace_id, id)
    },
    retrySink: async (actor, id) => {
      sinkOr404(actor.workspace_id, id)
      const written = await log.retry(actor.workspace_id, id)
      return { written, sink: sinkOr404(actor.workspace_id, id) }
    },
    removeSink: async (actor, id) => {
      sinkOr404(actor.workspace_id, id)
      await log.remove(actor.workspace_id, id)
      return { removed: true as const }
    },
  }
}
