import { Buffer } from 'node:buffer'
import type {
  Clock,
  DataDomain,
  FactCard,
  KnowledgeLayer,
  KnowledgeStage,
  RangeRef,
  Retrieval,
  RetrievalHit,
  RetrievalMode,
  RetrievalTier,
  RunId,
} from '@agentsws/contracts'
import type { Database } from 'better-sqlite3'
import type { KnowledgeEmitter } from './events.js'
import { rankByVerification, resolveProvenanceGrade, verificationOf } from './provenance.js'
import { type CardRow, rowToCard } from './rows.js'
import type { Embedder } from './store.js'
import { matchExpression, queryTerms, redactSecrets } from './text.js'
import { type GrantedActor, rangeKey, visibilityWhere } from './visibility.js'

export const DEFAULT_K = 8
/** RRF 常数（Cormack et al.），BM25 与向量两路排名融合。 */
export const RRF_K = 60

/**
 * WP56（48 §4 #7）：**长上下文优先**的字符预算。
 *
 * 中小卖家的整个知识库常常就几千字——那就别检索了，整库塞进去。没有召回损失，
 * 没有向量库，也没有"为什么这条没被检索到"这种没人查得清的问题。超过预算才退回
 * 关键词检索。工作区可以覆盖它（`createKnowledge({ budgetChars })`）。
 */
export const DEFAULT_CONTEXT_BUDGET_CHARS = 16_000

export interface SearchQuery {
  text: string
  actor: GrantedActor
  domains?: (DataDomain | 'company')[]
  scope?: RangeRef[]
  layers?: KnowledgeLayer[]
  k?: number
  precheck?: boolean
  /** WP56（48 §3 L2）：这次问的是售前还是售后。 */
  stage?: KnowledgeStage
  /** WP56（48 §4 #7）：检索档，缺省 `auto`。 */
  mode?: RetrievalMode
  /** WP56：这一次的字符预算（渠道侧可以压得更小）。 */
  budget_chars?: number
}

export interface RetrievalOptions {
  clock: Clock
  embed?: Embedder
  emit?: KnowledgeEmitter
  /** WP56：本工作区的长上下文预算（缺省 `DEFAULT_CONTEXT_BUDGET_CHARS`）。 */
  budgetChars?: number
}

/**
 * WP56（48 §4 #7）：这一次走哪一档。
 *
 * `hybrid`（BM25 + 向量 RRF）**留接口不实现**：真到了那个量级再说，现在按 lexical 跑。
 * KefuAgent 命中不足 4 条时的"行业模板回落"我们不做——那套平台标准库是多租户
 * SaaS 的产物，本地档没有那个东西可落。
 */
export function decideTier(opts: {
  mode: RetrievalMode
  kb_chars: number
  budget_chars: number
}): RetrievalTier {
  if (opts.mode !== 'auto' && opts.mode !== undefined) return opts.mode
  return opts.kb_chars <= opts.budget_chars ? 'context' : 'lexical'
}

const cosine = (a: Float64Array, b: readonly number[]): number => {
  let dot = 0
  let na = 0
  let nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    dot += x * y
    na += x * x
    nb += y * y
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/**
 * 19 §3 带身份检索。硬要求是**过滤下推**：可见性谓词进同一条 SQL 的 WHERE，
 * 无权数据域的卡片根本不进候选集（零命中），而不是先取 top-k 再脱敏。
 */
export class SqliteRetrieval implements Retrieval {
  private readonly db: Database
  private readonly clock: Clock
  private readonly embed: Embedder | undefined
  private readonly emit: KnowledgeEmitter | undefined
  private readonly budgetChars: number

  constructor(db: Database, opts: RetrievalOptions) {
    this.db = db
    this.clock = opts.clock
    this.embed = opts.embed
    this.emit = opts.emit
    this.budgetChars = opts.budgetChars ?? DEFAULT_CONTEXT_BUDGET_CHARS
  }

  /** 可见性 + 状态 + 显式过滤条件，供 FTS 查询与向量查询共用。 */
  private candidateWhere(q: SearchQuery): { sql: string; params: (string | number)[] } {
    const vis = visibilityWhere(q.actor)
    const where = [
      vis.sql,
      "c.status = 'active'",
      // WP56（48 §4 #6）：`quarantined` 是**唯一**真正从检索里排除的状态，
      // 而且只能由人显式产生。`stale` / `unverified` 一律不排除——只是排在后面。
      "(c.verification_state IS NULL OR c.verification_state != 'quarantined')",
    ]
    const params: (string | number)[] = [...vis.params]

    if (q.domains !== undefined && q.domains.length > 0) {
      where.push(`c.domain IN (${q.domains.map(() => '?').join(', ')})`)
      params.push(...q.domains)
    }
    if (q.layers !== undefined && q.layers.length > 0) {
      where.push(`c.layer IN (${q.layers.map(() => '?').join(', ')})`)
      params.push(...q.layers)
    }
    // WP56（48 §3 L2）：**只排除只属于另一头的**。`both` 与没标的两头都进。
    if (q.stage !== undefined && q.stage !== 'both') {
      where.push("(c.stage IS NULL OR c.stage = 'both' OR c.stage = ?)")
      params.push(q.stage)
    }
    if (q.scope !== undefined && q.scope.length > 0) {
      const refs = q.scope.map(rangeKey)
      where.push(
        `EXISTS (SELECT 1 FROM fact_card_scopes s WHERE s.card_id = c.id AND s.ref IN (${refs
          .map(() => '?')
          .join(', ')}))`,
      )
      params.push(...refs)
    }
    return { sql: where.join(' AND '), params }
  }

  /** 这个 actor 看得见的全部候选（按更新时间倒序）——长上下文档要的就是它。 */
  private candidateRows(q: SearchQuery): CardRow[] {
    const base = this.candidateWhere(q)
    return this.db
      .prepare(`SELECT c.* FROM fact_cards c WHERE ${base.sql} ORDER BY c.updated_at DESC, c.id`)
      .all(...base.params) as CardRow[]
  }

  /**
   * 溯源分层 + 按预算装箱（48 §4 #6 与 #7 在这里合流）。
   *
   * 顺序先由调用方定（context 档按更新时间倒序、lexical 档按打分），再叠一层溯源分层
   * 做主键——**层内保序**。装得下时分层只影响顺序；装不下时 `stale` 与 `unverified`
   * 自动最先被挤出预算，这就是"降权"的准确含义，不需要另设阈值。
   */
  private packToBudget(cards: readonly FactCard[], budget: number, k: number): FactCard[] {
    const ranked = rankByVerification(
      cards.map((card) => ({
        card,
        provenance_grade: resolveProvenanceGrade(card),
        verification_state: verificationOf(card),
      })),
    ).map((x) => x.card)
    const out: FactCard[] = []
    let used = 0
    for (const card of ranked) {
      if (out.length >= k) break
      const cost = card.statement.length
      if (out.length > 0 && used + cost > budget) break
      out.push(card)
      used += cost
    }
    return out
  }

  async search(q: SearchQuery): Promise<{
    hits: RetrievalHit[]
    relevant: boolean
    matched: string[]
    missing: string[]
    tier?: RetrievalTier
  }> {
    const terms = queryTerms(q.text)
    const base = this.candidateWhere(q)
    const k = q.k ?? DEFAULT_K
    const budget = q.budget_chars ?? this.budgetChars

    // matched / missing 只看"这个 actor 的候选集里有没有"，同样是过滤下推的结果
    const probe = this.db.prepare(
      'SELECT 1 AS hit FROM fact_cards_fts JOIN fact_cards c ON c.rowid = fact_cards_fts.rowid' +
        ` WHERE fact_cards_fts MATCH ? AND ${base.sql} LIMIT 1`,
    )
    const matched: string[] = []
    const missing: string[] = []
    for (const t of terms) {
      const found = probe.get(t.phrase, ...base.params) as { hit: number } | undefined
      if (found === undefined) missing.push(t.term)
      else matched.push(t.term)
    }
    const relevant = matched.length > 0

    // 19 §3：precheck 不读正文、不计 usage
    if (q.precheck === true || terms.length === 0)
      return { hits: [], relevant: terms.length === 0 ? false : relevant, matched, missing }

    /* WP56（48 §4 #7）长上下文档：全库（按身份过滤之后）装得下就整库注入，不检索。
     *
     * 为什么这不是偷懒：检索的召回损失是**看不见**的——没被检索到的那条知识不会报错，
     * 只会让回信少一句该说的话。库只有几千字的时候，把它整个给模型比任何排序都准。 */
    const candidates = this.candidateRows(q).map(rowToCard)
    const kbChars = candidates.reduce((sum, c) => sum + c.statement.length, 0)
    const tier = decideTier({ mode: q.mode ?? 'auto', kb_chars: kbChars, budget_chars: budget })
    if (tier === 'context') {
      // 整库注入：调用方明确给了 k 才按 k 截（渠道侧压条数），不给就全给
      const packed = this.packToBudget(candidates, budget, q.k ?? candidates.length)
      const hits = this.toHits(
        packed.map((card) => ({ card, score: 0 })),
        q,
      )
      // context 档没有"检索"这回事：整库都在上下文里，relevant 只看库空不空
      return { hits, relevant: hits.length > 0, matched, missing, tier }
    }

    const expr = matchExpression(terms)
    if (expr === undefined) return { hits: [], relevant: false, matched, missing, tier }

    const poolSize = Math.max(k * 5, 50)
    const bmRows = this.db
      .prepare(
        'SELECT c.*, bm25(fact_cards_fts) AS bm FROM fact_cards_fts' +
          ' JOIN fact_cards c ON c.rowid = fact_cards_fts.rowid' +
          ` WHERE fact_cards_fts MATCH ? AND ${base.sql} ORDER BY bm ASC, c.id ASC LIMIT ?`,
      )
      .all(expr, ...base.params, poolSize) as (CardRow & { bm: number })[]

    const rows = new Map<string, CardRow>()
    for (const r of bmRows) rows.set(r.id, r)

    let ranked: { id: string; score: number }[]
    if (this.embed === undefined) {
      // 只有 BM25：分数取 -bm25（SQLite 的 bm25 越小越相关）
      ranked = bmRows.map((r) => ({ id: r.id, score: -r.bm }))
    } else {
      const qv = await this.embed(q.text)
      const vecRows = this.db
        .prepare(
          'SELECT c.*, v.vec AS vec FROM fact_cards c JOIN fact_card_vectors v ON v.card_id = c.id' +
            ` WHERE ${base.sql}`,
        )
        .all(...base.params) as (CardRow & { vec: Buffer })[]
      const vecScored = vecRows
        .map((r) => {
          const buf = Buffer.from(r.vec)
          const arr = new Float64Array(
            buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
          )
          rows.set(r.id, r)
          return { id: r.id, sim: cosine(arr, qv) }
        })
        // 相似度 0 的卡不算候选：否则查询词一个都不沾边时会把全库都召回来
        .filter((x) => x.sim > 0)
        .sort((a, b) => b.sim - a.sim || (a.id < b.id ? -1 : 1))
        .slice(0, poolSize)

      const fused = new Map<string, number>()
      const fuse = (ids: readonly { id: string }[]) => {
        for (const [i, r] of ids.entries())
          fused.set(r.id, (fused.get(r.id) ?? 0) + 1 / (RRF_K + i + 1))
      }
      fuse(bmRows)
      fuse(vecScored)
      ranked = [...fused].map(([id, score]) => ({ id, score }))
    }

    ranked.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
    const scored = ranked
      .map((r) => {
        const row = rows.get(r.id)
        return row === undefined ? undefined : { card: rowToCard(row), score: r.score }
      })
      .filter((x): x is { card: FactCard; score: number } => x !== undefined)
    // WP56：打分之后再叠溯源分层与预算装箱（层内按打分保序）
    const packed = this.packToBudget(
      scored.map((x) => x.card),
      budget,
      k,
    )
    const scoreOf = new Map(scored.map((x) => [x.card.id, x.score]))
    const hits = this.toHits(
      packed.map((card) => ({ card, score: scoreOf.get(card.id) ?? 0 })),
      q,
    )
    return { hits, relevant: hits.length > 0, matched, missing, tier }
  }

  /** 命中 → `RetrievalHit`，顺手记 `usage.recalled` 与 `knowledge.card.recalled`。 */
  private toHits(
    entries: readonly { card: FactCard; score: number }[],
    q: SearchQuery,
  ): RetrievalHit[] {
    const now = this.clock.now()
    const bump = this.db.prepare(
      'UPDATE fact_cards SET usage_recalled = usage_recalled + 1, usage_last_recalled_at = ?' +
        ' WHERE id = ?',
    )
    const hits: RetrievalHit[] = []
    for (const { card, score } of entries) {
      bump.run(now, card.id)
      this.emit?.({
        type: 'knowledge.card.recalled',
        workspace_id: card.workspace_id,
        at: now,
        payload: { card_id: card.id, actor: q.actor.person_id },
      })
      const first = card.provenance[0]
      const summary =
        first === undefined
          ? '无出处'
          : `${first.source} ${first.ref}${first.locator === undefined ? '' : ` ${first.locator}`}` +
            `${card.provenance.length > 1 ? ` 等 ${card.provenance.length} 处` : ''}`
      const state = verificationOf(card)
      hits.push({
        fact_card_id: card.id,
        score,
        layer: card.layer,
        statement_redacted: redactSecrets(card.statement),
        provenance_summary: summary,
        sensitivity: card.sensitivity,
        // 47 J2：历史案例要把"当时"一起带出去——调用方据此决定要不要标它过时
        ...(card.as_of === undefined ? {} : { as_of: card.as_of }),
        // WP56：溯源四件套跟着命中一起出去，prompt 那头照 PROVENANCE_PROMPT_CLAUSES 渲染
        provenance_grade: resolveProvenanceGrade(card),
        verification: state === 'stale' ? 'stale' : 'fresh',
        ...(card.last_verified_at === undefined ? {} : { last_verified_at: card.last_verified_at }),
        ...(card.stage === undefined ? {} : { stage: card.stage }),
      })
    }
    return hits
  }

  /** 19 §3：记 usage.cited，供"高召回低认可"与晋升判断用。 */
  async cite(fact_card_id: string, run_id: RunId): Promise<void> {
    const now = this.clock.now()
    const info = this.db
      .prepare('UPDATE fact_cards SET usage_cited = usage_cited + 1, updated_at = ? WHERE id = ?')
      .run(now, fact_card_id)
    if (info.changes === 0) return
    this.db
      .prepare('INSERT INTO fact_card_citations (card_id, run_id, at) VALUES (?, ?, ?)')
      .run(fact_card_id, run_id, now)
    const row = this.db
      .prepare('SELECT workspace_id FROM fact_cards WHERE id = ?')
      .get(fact_card_id) as { workspace_id: string } | undefined
    if (row !== undefined)
      this.emit?.({
        type: 'knowledge.card.cited',
        workspace_id: row.workspace_id,
        at: now,
        payload: { card_id: fact_card_id, run_id },
      })
  }
}
