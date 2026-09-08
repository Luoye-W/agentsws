import type { Iso8601, WorkspaceId } from '@agentsws/contracts'

/**
 * 19 §6 的事件名。`KnownEventType`（contracts/events.ts）目前还没有 `knowledge.*`，
 * 本包不改契约，先在此声明，等契约补齐后换成 `KnownEventType` 的成员。
 */
export type KnowledgeEventType =
  | 'knowledge.card.proposed'
  | 'knowledge.card.activated'
  | 'knowledge.card.retired'
  | 'knowledge.card.conflict'
  | 'knowledge.card.recalled'
  | 'knowledge.card.cited'

export interface KnowledgeEvent {
  type: KnowledgeEventType
  workspace_id: WorkspaceId
  at: Iso8601
  payload: Record<string, unknown>
}

export type KnowledgeEmitter = (event: KnowledgeEvent) => void
