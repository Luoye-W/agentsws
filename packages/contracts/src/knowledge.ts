import type {
  AssignmentId,
  DataDomain,
  Iso8601,
  ObjectRef,
  PersonId,
  RangeRef,
  RoleId,
  RunId,
  Sensitivity,
  WorkspaceId,
} from './common.js'

/** 19 §1 事实卡 */
export type KnowledgeLayer = 'fact' | 'phrasing' | 'policy'
export interface Provenance {
  source: 'document' | 'meeting' | 'email' | 'web' | 'human' | 'agent_inference'
  ref: string
  locator?: string
  quote?: string
  at: Iso8601
}
export interface FactCard {
  id: string
  schema_version: 1
  workspace_id: WorkspaceId
  layer: KnowledgeLayer
  domain: DataDomain | 'company'
  scope: RangeRef[]
  sensitivity: Sensitivity
  subject: { type: string; id?: string; key: string }
  statement: string
  structured?: Record<string, unknown>
  provenance: Provenance[]
  confidence: {
    value: number
    state: 'unverified' | 'plausible' | 'probable' | 'verified' | 'refuted'
  }
  conflicts?: { with: string; note: string }[]
  valid: { from?: Iso8601; until?: Iso8601 }
  usage: {
    recalled: number
    cited: number
    last_recalled_at?: Iso8601
    drafts_edited_after_cite: number
  }
  status: 'proposed' | 'active' | 'retired'
  owner: PersonId
  created_by: { kind: 'agent' | 'person'; id: string }
  created_at: Iso8601
  updated_at: Iso8601
}

export interface KnowledgeSource {
  id: string
  workspace_id: WorkspaceId
  kind: 'upload' | 'feishu_doc' | 'shopify_page' | 'website' | 'email_thread' | 'meeting'
  ref: string
  acl_inherit: boolean
  last_synced_at?: Iso8601
  chunks: number
  parser: 'anydoc' | 'html' | 'transcript'
}

export interface RetrievalActor {
  person_id: PersonId
  assignment_id: AssignmentId
  role_id: RoleId
  workspace_id: WorkspaceId
}
export interface RetrievalHit {
  fact_card_id: string
  score: number
  layer: KnowledgeLayer
  statement_redacted: string
  provenance_summary: string
  sensitivity: Sensitivity
}

/** 19 §3：先按身份过滤候选再算相似度（过滤下推）；precheck 不读正文不计 usage。 */
export interface Retrieval {
  search(q: {
    text: string
    actor: RetrievalActor
    domains?: (DataDomain | 'company')[]
    scope?: RangeRef[]
    layers?: KnowledgeLayer[]
    k?: number
    precheck?: boolean
  }): Promise<{ hits: RetrievalHit[]; relevant: boolean; matched: string[]; missing: string[] }>
  cite(fact_card_id: string, run_id: RunId): Promise<void>
}

export interface KnowledgeStore {
  propose(
    card: Omit<FactCard, 'id' | 'status' | 'usage' | 'created_at' | 'updated_at'>,
  ): Promise<FactCard>
  activate(id: string, by: PersonId): Promise<FactCard>
  retire(id: string, by: PersonId): Promise<FactCard>
  get(id: string, actor: RetrievalActor): Promise<FactCard | undefined>
  list(
    filter: {
      workspace_id: WorkspaceId
      domain?: string
      layer?: KnowledgeLayer
      status?: FactCard['status']
    },
    actor: RetrievalActor,
  ): Promise<FactCard[]>
  health(
    workspace_id: WorkspaceId,
  ): Promise<{ total: number; silent: number; stale: number; conflicts: number }>
}

/** 19 §1.2 运行记忆（Commerce Agents A7）：小、类型化、有上限、可撤销；写过滤拒秘密。 */
export interface MemoryFactRecord {
  key: string
  value: string
  category: 'constraint' | 'preference' | 'context'
  subject: ObjectRef
  source_run_hash: string
  expires_at: Iso8601
  workspace_id: WorkspaceId
}
export interface MemoryStore {
  /** 返回被写过滤拒绝的条目与原因 */
  write(facts: MemoryFactRecord[]): Promise<{
    accepted: MemoryFactRecord[]
    rejected: { fact: MemoryFactRecord; reason: string }[]
  }>
  recall(subject: ObjectRef, opts?: { cap?: number }): Promise<MemoryFactRecord[]>
  forget(subject: ObjectRef, key: string): Promise<void>
}
