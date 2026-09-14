/**
 * Extracted from KefuAgent `src/lib/support/knowledge/recheck.ts`
 * （源页变更钩子、三选一复核卡、stale / quarantined 纪律），rewritten for agentsws（48 §4 #6）。
 *
 * 一句话：**源页改了，先比指纹，再决定要不要惊动人。**
 *
 * ```
 * sync(源, 新正文)
 *   ├─ 内容 hash 没变            → 什么都不做
 *   ├─ hash 变了、受管辖数值没变  → 自动回鲜，只记一笔 source_changed_at
 *   └─ hash 变了、数值也变了      → 派生卡标 stale（照常检索，只是排最后）
 *                                  + 一张复核卡（确认没变 / 按新值更新 / 忽略）
 * ```
 *
 * 三条红线：
 * - **口径绝不静默改变**：实质变更只产生一张请人作答的卡；人没答之前，卡上的
 *   陈述与结构化值逐字段不变；
 * - **也绝不静默撤掉口径**：`stale` 仍然进检索与 prompt，`quarantined` 是唯一
 *   拦截态且只能由人显式产生；
 * - **非阻塞**：同步失败不拖垮主流程。
 */
import { createHash } from 'node:crypto'
import type { Clock, FactCard, Iso8601, KnowledgeSource, WorkspaceId } from '@agentsws/contracts'
import type { Database } from 'better-sqlite3'
import { invalidInput, notFound } from './errors.js'
import type { KnowledgeEmitter, KnowledgeEventType } from './events.js'
import {
  describeFactKeyZh,
  diffFactFingerprints,
  extractFactFingerprint,
  type FactFingerprint,
  type MaterialChangeVerdict,
} from './fact-fingerprint.js'
import { nextSeq } from './schema.js'
import type { SqliteKnowledgeStore } from './store.js'

/** 内容 hash：sha256 前 16 位。同一份正文换行不同也算同一份（先归一化换行）。 */
export function contentHashOf(content: string): string {
  return createHash('sha256')
    .update(content.replace(/\r\n?/g, '\n').trim())
    .digest('hex')
    .slice(0, 16)
}

/** 复核卡的三个选项（冻结：id 进审批项 payload，改名等于改口径）。 */
export const RECHECK_OPTIONS: readonly { id: RecheckResolution; label: string }[] = [
  { id: 'unchanged', label: '确认没变' },
  { id: 'adopt_new', label: '按新值更新' },
  { id: 'ignore', label: '忽略' },
]

export type RecheckResolution = 'unchanged' | 'adopt_new' | 'ignore'
export type RecheckStatus = 'open' | 'resolved' | 'superseded'

export interface KnowledgeRecheck {
  id: string
  workspace_id: WorkspaceId
  source_id: string
  card_id: string
  status: RecheckStatus
  reason: 'source_changed'
  /** 变更前后那几类受管辖数值（给人看的那一面）。 */
  before: string[]
  after: string[]
  categories: string[]
  /** 新正文里抽到的那一版指纹（选「按新值更新」时用它改卡）。 */
  proposed_fingerprint?: FactFingerprint
  /** 新正文（截断后），选「按新值更新」时拿它替陈述。 */
  proposed_statement?: string
  approval_item_id?: string
  resolution?: RecheckResolution
  resolved_by?: string
  resolved_at?: Iso8601
  created_at: Iso8601
}

/* ------------------------------------------------------------------ */
/* 纯函数：这次同步该怎么处置                                            */
/* ------------------------------------------------------------------ */

export interface SourceSyncDecision {
  card_id: string
  /** `refresh` = 自动回鲜；`stale` = 标过时并开复核。 */
  action: 'refresh' | 'stale'
  verdict: MaterialChangeVerdict
}

export interface SourceSyncPlan {
  content_hash: string
  /** 内容 hash 变了没有。没变的话下面全是空的。 */
  changed: boolean
  /** 第一次同步（源还没有 `last_content_hash`）：只记 hash，不惊动任何人。 */
  first_sync: boolean
  decisions: SourceSyncDecision[]
}

/**
 * 纯函数：给定源的上一版 hash、这一版正文、这个源派生出来的卡，算出该怎么处置。
 *
 * 零 IO、零模型——**"是不是实质变更"这个判断绝不交给 LLM**。
 */
export function planSourceSync(input: {
  source: Pick<KnowledgeSource, 'last_content_hash'>
  content: string
  cards: readonly FactCard[]
}): SourceSyncPlan {
  const content_hash = contentHashOf(input.content)
  const previous = input.source.last_content_hash
  if (previous === undefined || previous === '')
    return { content_hash, changed: true, first_sync: true, decisions: [] }
  if (previous === content_hash)
    return { content_hash, changed: false, first_sync: false, decisions: [] }

  const after = extractFactFingerprint(input.content)
  const decisions: SourceSyncDecision[] = []
  for (const card of input.cards) {
    // 隔离态只有人能解除：源再怎么变也不动它
    if (card.verification_state === 'quarantined') continue
    const verdict = diffFactFingerprints(card.fact_fingerprint, after, {
      restrict_to_before_categories: true,
    })
    decisions.push({ card_id: card.id, action: verdict.material ? 'stale' : 'refresh', verdict })
  }
  return { content_hash, changed: true, first_sync: false, decisions }
}

/* ------------------------------------------------------------------ */
/* 落库                                                                */
/* ------------------------------------------------------------------ */

interface RecheckRow {
  id: string
  workspace_id: string
  source_id: string
  card_id: string
  status: string
  reason: string
  before_json: string
  after_json: string
  categories_json: string
  approval_item_id: string | null
  resolution: string | null
  resolved_by: string | null
  resolved_at: string | null
  created_at: string
}

function rowToRecheck(r: RecheckRow): KnowledgeRecheck {
  return {
    id: r.id,
    workspace_id: r.workspace_id,
    source_id: r.source_id,
    card_id: r.card_id,
    status: r.status as RecheckStatus,
    reason: 'source_changed',
    before: JSON.parse(r.before_json) as string[],
    after: JSON.parse(r.after_json) as string[],
    categories: JSON.parse(r.categories_json) as string[],
    created_at: r.created_at,
    ...(r.approval_item_id === null ? {} : { approval_item_id: r.approval_item_id }),
    ...(r.resolution === null ? {} : { resolution: r.resolution as RecheckResolution }),
    ...(r.resolved_by === null ? {} : { resolved_by: r.resolved_by }),
    ...(r.resolved_at === null ? {} : { resolved_at: r.resolved_at }),
  }
}

export interface RecheckStoreOptions {
  clock: Clock
  emit?: KnowledgeEmitter
}

/** 新正文进卡片时的上限（与 `MAX_STATEMENT_CHARS` 同口径，这里不 import 避免环）。 */
const MAX_PROPOSED_CHARS = 500

export interface SyncSourceResult {
  plan: SourceSyncPlan
  /** 自动回鲜的卡。 */
  refreshed: string[]
  /** 标成 stale 并开了复核的卡。 */
  stale: string[]
  rechecks: KnowledgeRecheck[]
}

export class SqliteRecheckStore {
  private readonly db: Database
  private readonly store: SqliteKnowledgeStore
  private readonly clock: Clock
  private readonly emit: KnowledgeEmitter | undefined

  constructor(db: Database, store: SqliteKnowledgeStore, opts: RecheckStoreOptions) {
    this.db = db
    this.store = store
    this.clock = opts.clock
    this.emit = opts.emit
  }

  private fire(
    type: KnowledgeEventType,
    workspace_id: WorkspaceId,
    payload: Record<string, unknown>,
  ): void {
    this.emit?.({ type, workspace_id, at: this.clock.now(), payload })
  }

  /** 这个源派生出来的卡：出处的 ref 指着它。 */
  cardsOfSource(workspace_id: WorkspaceId, ref: string): FactCard[] {
    const rows = this.db
      .prepare(
        "SELECT id FROM fact_cards WHERE workspace_id = ? AND status != 'retired'" +
          ' AND provenance_json LIKE ? ORDER BY created_at, id',
      )
      .all(workspace_id, `%${ref}%`) as { id: string }[]
    const out: FactCard[] = []
    for (const r of rows) {
      const card = this.store.getUnchecked(r.id)
      if (card !== undefined) out.push(card)
    }
    return out
  }

  /**
   * 源同步了一次。
   *
   * 注意它**不解析**新正文（解析是 `ingest` 的事），只拿正文算 hash 与指纹——
   * 复核要回答的问题只有一个：页面上那几个受管辖数值有没有变。
   */
  async syncSource(input: {
    source: KnowledgeSource
    content: string
    /** 不给就按出处 ref 去找这个源派生的卡。 */
    cards?: readonly FactCard[]
  }): Promise<SyncSourceResult> {
    const cards = input.cards ?? this.cardsOfSource(input.source.workspace_id, input.source.ref)
    const plan = planSourceSync({ source: input.source, content: input.content, cards })
    const now = this.clock.now()
    const refreshed: string[] = []
    const stale: string[] = []
    const rechecks: KnowledgeRecheck[] = []
    if (!plan.changed || plan.first_sync) return { plan, refreshed, stale, rechecks }

    const proposedFingerprint = extractFactFingerprint(input.content)
    const proposedStatement = input.content.replace(/\s+/g, ' ').trim().slice(0, MAX_PROPOSED_CHARS)

    for (const decision of plan.decisions) {
      const card = cards.find((c) => c.id === decision.card_id)
      if (card === undefined) continue
      if (decision.action === 'refresh') {
        // 源动过、口径没动：自动回鲜，只留一笔"源什么时候动的"
        await this.store.patch(card.id, {
          verification_state: 'fresh',
          source_changed_at: now,
          source_content_hash: plan.content_hash,
        })
        refreshed.push(card.id)
        this.fire('knowledge.card.refreshed', card.workspace_id, {
          card_id: card.id,
          source_id: input.source.id,
          reason: 'no_material_change',
        })
        continue
      }
      await this.store.patch(card.id, {
        verification_state: 'stale',
        source_changed_at: now,
      })
      stale.push(card.id)
      this.fire('knowledge.card.stale', card.workspace_id, {
        card_id: card.id,
        source_id: input.source.id,
        reason: 'source_page_changed',
        categories: decision.verdict.categories,
      })
      rechecks.push(
        this.open({
          workspace_id: card.workspace_id,
          source_id: input.source.id,
          card_id: card.id,
          before: decision.verdict.removed,
          after: decision.verdict.added,
          categories: decision.verdict.categories,
          proposed_fingerprint: proposedFingerprint,
          proposed_statement: proposedStatement,
        }),
      )
    }
    return { plan, refreshed, stale, rechecks }
  }

  /** 开一张复核。同 (源, 卡) 已经开着就回原来那张（连改三次不刷三张卡）。 */
  open(input: {
    workspace_id: WorkspaceId
    source_id: string
    card_id: string
    before: readonly string[]
    after: readonly string[]
    categories: readonly string[]
    proposed_fingerprint?: FactFingerprint
    proposed_statement?: string
  }): KnowledgeRecheck {
    const existing = this.db
      .prepare(
        "SELECT * FROM knowledge_rechecks WHERE workspace_id = ? AND source_id = ? AND card_id = ? AND status = 'open'",
      )
      .get(input.workspace_id, input.source_id, input.card_id) as RecheckRow | undefined
    if (existing !== undefined) return rowToRecheck(existing)

    const now = this.clock.now()
    const seq = nextSeq(this.db, 'knowledge_recheck_seq')
    const id = `rck_${createHash('sha256')
      .update([input.workspace_id, input.source_id, input.card_id, now, String(seq)].join(' '))
      .digest('hex')
      .slice(0, 24)}`
    this.db
      .prepare(
        `INSERT INTO knowledge_rechecks
           (id, workspace_id, source_id, card_id, status, reason, before_json, after_json,
            categories_json, approval_item_id, resolution, resolved_by, resolved_at, created_at)
         VALUES (?, ?, ?, ?, 'open', 'source_changed', ?, ?, ?, NULL, NULL, NULL, NULL, ?)`,
      )
      .run(
        id,
        input.workspace_id,
        input.source_id,
        input.card_id,
        JSON.stringify([...input.before]),
        JSON.stringify([...input.after]),
        JSON.stringify([...input.categories]),
        now,
      )
    // 新正文与新指纹不进这张表的固定列，挂在 meta 上（只有"按新值更新"用得着）
    if (input.proposed_fingerprint !== undefined || input.proposed_statement !== undefined)
      this.db.prepare('INSERT OR REPLACE INTO knowledge_meta (k, v) VALUES (?, ?)').run(
        `recheck_proposed:${id}`,
        JSON.stringify({
          fingerprint: input.proposed_fingerprint,
          statement: input.proposed_statement,
        }),
      )
    this.fire('knowledge.recheck.opened', input.workspace_id, {
      recheck_id: id,
      card_id: input.card_id,
      source_id: input.source_id,
      categories: [...input.categories],
    })
    return this.require(id)
  }

  private proposedOf(id: string): { fingerprint?: FactFingerprint; statement?: string } {
    const row = this.db
      .prepare('SELECT v FROM knowledge_meta WHERE k = ?')
      .get(`recheck_proposed:${id}`) as { v: string } | undefined
    if (row === undefined) return {}
    return JSON.parse(row.v) as { fingerprint?: FactFingerprint; statement?: string }
  }

  get(id: string): KnowledgeRecheck | undefined {
    const row = this.db.prepare('SELECT * FROM knowledge_rechecks WHERE id = ?').get(id) as
      | RecheckRow
      | undefined
    if (row === undefined) return undefined
    const recheck = rowToRecheck(row)
    const proposed = this.proposedOf(id)
    return {
      ...recheck,
      ...(proposed.fingerprint === undefined ? {} : { proposed_fingerprint: proposed.fingerprint }),
      ...(proposed.statement === undefined ? {} : { proposed_statement: proposed.statement }),
    }
  }

  require(id: string): KnowledgeRecheck {
    const r = this.get(id)
    if (r === undefined) throw notFound(`复核不存在：${id}`, { id })
    return r
  }

  list(workspace_id: WorkspaceId, filter: { status?: RecheckStatus } = {}): KnowledgeRecheck[] {
    const rows = (
      filter.status === undefined
        ? this.db
            .prepare('SELECT id FROM knowledge_rechecks WHERE workspace_id = ? ORDER BY rowid')
            .all(workspace_id)
        : this.db
            .prepare(
              'SELECT id FROM knowledge_rechecks WHERE workspace_id = ? AND status = ? ORDER BY rowid',
            )
            .all(workspace_id, filter.status)
    ) as { id: string }[]
    return rows.map((r) => this.require(r.id))
  }

  /** 记下这张复核对应的审批项（宿主建卡，本包只存 id）。 */
  linkApproval(id: string, approval_item_id: string): KnowledgeRecheck {
    this.db
      .prepare('UPDATE knowledge_rechecks SET approval_item_id = ? WHERE id = ?')
      .run(approval_item_id, id)
    return this.require(id)
  }

  /**
   * 有人答了那张复核卡。
   *
   * - `unchanged`（确认没变）：卡回鲜，`last_verified_at` 记到今天——**这一下才是
   *   真正的"核实过"**；
   * - `adopt_new`（按新值更新）：旧口径先归档成一条历史案例（它当时是真的），
   *   卡换成新正文与新指纹，回鲜；
   * - `ignore`（忽略）：卡**留在 stale**。忽略不是"当它没发生"——源确实变了，
   *   下次还会排在后面。
   */
  async resolve(
    id: string,
    input: { resolution: RecheckResolution; by: string; at?: Iso8601 },
  ): Promise<{ recheck: KnowledgeRecheck; archived_card_id?: string }> {
    const recheck = this.require(id)
    if (recheck.status !== 'open') throw invalidInput(`复核已经是 ${recheck.status}，不能再答一次`)
    const now = input.at ?? this.clock.now()
    let archived: string | undefined

    if (input.resolution === 'unchanged') {
      await this.store.patch(recheck.card_id, {
        verification_state: 'fresh',
        last_verified_at: now,
      })
      this.fire('knowledge.card.refreshed', recheck.workspace_id, {
        card_id: recheck.card_id,
        reason: 'confirmed_unchanged',
        by: input.by,
      })
    } else if (input.resolution === 'adopt_new') {
      const before = recheck.before.map(describeFactKeyZh).join('、')
      const card = await this.store.archiveAsCase(
        recheck.card_id,
        now,
        before === '' ? '旧口径' : `旧口径：${before}`,
      )
      archived = card.id
      await this.store.patch(recheck.card_id, {
        verification_state: 'fresh',
        last_verified_at: now,
        ...(recheck.proposed_statement === undefined
          ? {}
          : { statement: recheck.proposed_statement }),
        ...(recheck.proposed_fingerprint === undefined
          ? {}
          : { fact_fingerprint: recheck.proposed_fingerprint }),
      })
      this.fire('knowledge.card.refreshed', recheck.workspace_id, {
        card_id: recheck.card_id,
        reason: 'adopted_new_value',
        archived_card_id: archived,
        by: input.by,
      })
    }
    // ignore：什么都不改，卡留在 stale

    this.db
      .prepare(
        "UPDATE knowledge_rechecks SET status = 'resolved', resolution = ?, resolved_by = ?," +
          ' resolved_at = ? WHERE id = ?',
      )
      .run(input.resolution, input.by, now, id)
    this.fire('knowledge.recheck.resolved', recheck.workspace_id, {
      recheck_id: id,
      card_id: recheck.card_id,
      resolution: input.resolution,
      by: input.by,
      ...(archived === undefined ? {} : { archived_card_id: archived }),
    })
    return {
      recheck: this.require(id),
      ...(archived === undefined ? {} : { archived_card_id: archived }),
    }
  }
}
