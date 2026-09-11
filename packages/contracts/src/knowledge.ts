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

/**
 * 19 §1 事实卡的层。
 *
 * WP52（47 J2）加了第四层 `historical_case`：**知识层只存文字与判断，不存状态**。
 * 带订单号 / 金额 / 库存数 / 履约状态这类"状态词"的句子进 Wiki 时降到这一层，
 * 打上"当时"的时间戳（`as_of`），从此它是**历史案例**不是事实——回答时可以参考
 * "上次这种情况我们怎么办的"，但不能拿它当"现在是什么样"。
 *
 * **只加不删**：原来那三层的含义一个字没动。
 */
export type KnowledgeLayer = 'fact' | 'phrasing' | 'policy' | 'historical_case'
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
  /**
   * 47 J2：这句话描述的是**什么时候**的状态。
   *
   * 只有 `historical_case` 层有——它就是那个"当时"。`valid.from` 说的是"这条从
   * 什么时候开始生效"（政策的启用日），两回事：一条 2026-09 写下的退款记录，
   * `as_of` 是 2026-09，而它作为一条政策从来没有"生效"过。
   */
  as_of?: Iso8601
  /**
   * 47 J2：进入管道把它从哪一层降下来的。
   *
   * 留着是为了**能改回去**：正则会误伤（"我们承诺 30 天内退款"里也有数字），
   * 人在界面上点一下就能还原成原来那层，不用猜它本来是什么。
   */
  downgraded_from?: KnowledgeLayer
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

/** 19 §1.3 的登记入参（`id` / `chunks` / `last_synced_at` 由实现给）。 */
export interface KnowledgeSourceInput {
  kind: KnowledgeSource['kind']
  ref: string
  parser: KnowledgeSource['parser']
  acl_inherit?: boolean
}

export type KnowledgeGapStatus = 'open' | 'answered' | 'dismissed'

/**
 * 19 §4 缺口：「Agent 答不了 → question 提议 → 有人答 → 自动变 knowledge_update」。
 *
 * WP33 时它只是网关包里的一个本地类型（19 §6 的 API 表提了 `POST /knowledge/gaps`，
 * 契约里却没有这个对象）；WP35 搬进契约——换一个知识实现照样接得上。
 */
export interface KnowledgeGap {
  id: string
  workspace_id: WorkspaceId
  question: string
  /** 关于什么（与 `FactCard.subject` 同形）。 */
  subject: { type: string; id?: string; key: string }
  domain: DataDomain | 'company'
  status: KnowledgeGapStatus
  asked_by: { kind: 'agent' | 'person'; id: string }
  run_id?: RunId
  answer?: string
  answered_by?: PersonId
  answered_at?: Iso8601
  /** 答完之后生成的那张 `knowledge_update` 审批项。 */
  approval_item_id?: string
  created_at: Iso8601
}

export interface KnowledgeGapInput {
  question: string
  subject: { type: string; id?: string; key: string }
  domain?: DataDomain | 'company'
  run_id?: RunId
}

export interface KnowledgeGapAnswer {
  gap: KnowledgeGap
  /** 19 §4：答案不直接生效，先变一张审批项。 */
  approval_item_id?: string
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
  recall(
    subject: ObjectRef,
    opts?: { cap?: number; workspace_id?: WorkspaceId },
  ): Promise<MemoryFactRecord[]>
  forget(subject: ObjectRef, key: string, opts?: { workspace_id?: WorkspaceId }): Promise<void>
}
