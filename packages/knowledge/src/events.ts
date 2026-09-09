import type { Iso8601, KnownEventType, WorkspaceId } from '@agentsws/contracts'

/**
 * 19 §6 的事件名。是契约 `KnownEventType` 的子集（本地窄化，方便本包的 emitter 只收这几条）。
 */
export type KnowledgeEventType = Extract<KnownEventType, `knowledge.${string}`>

export interface KnowledgeEvent {
  type: KnowledgeEventType
  workspace_id: WorkspaceId
  at: Iso8601
  payload: Record<string, unknown>
}

export type KnowledgeEmitter = (event: KnowledgeEvent) => void
