import { Buffer } from 'node:buffer'
import type {
  Clock,
  DataDomain,
  KnowledgeLayer,
  RangeRef,
  Retrieval,
  RetrievalHit,
  RunId,
} from '@agentsws/contracts'
import type { Database } from 'better-sqlite3'
import type { KnowledgeEmitter } from './events.js'
import { type CardRow, rowToCard } from './rows.js'
import type { Embedder } from './store.js'
import { matchExpression, queryTerms, redactSecrets } from './text.js'
import { type GrantedActor, rangeKey, visibilityWhere } from './visibility.js'

export const DEFAULT_K = 8
/** RRF 常数（Cormack et al.），BM25 与向量两路排名融合。 */
export const RRF_K = 60

export interface SearchQuery {
  text: string
  actor: GrantedActor
  domains?: (DataDomain | 'company')[]
  scope?: RangeRef[]
  layers?: KnowledgeLayer[]
  k?: number
  precheck?: boolean
}

export interface RetrievalOptions {
  clock: Clock
  embed?: Embedder
  emit?: KnowledgeEmitter
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

  constructor(db: Database, opts: RetrievalOptions) {
    this.db = db
    this.clock = opts.clock
    this.embed = opts.embed
    this.emit = opts.emit
  }

  /** 可见性 + 状态 + 显式过滤条件，供 FTS 查询与向量查询共用。 */
  private candidateWhere(q: SearchQuery): { sql: string; params: (string | number)[] } {
    const vis = visibilityWhere(q.actor)
    const where = [vis.sql, "c.status = 'active'"]
    const params: (string | number)[] = [...vis.params]

    if (q.domains !== undefined && q.domains.length > 0) {
      where.push(`c.domain IN (${q.domains.map(() => '?').join(', ')})`)
      params.push(...q.domains)
    }
    if (q.layers !== undefined && q.layers.length > 0) {
      where.push(`c.layer IN (${q.layers.map(() => '?').join(', ')})`)
      params.push(...q.layers)
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

  async search(q: SearchQuery): Promise<{
    hits: RetrievalHit[]
    relevant: boolean
    matched: string[]
    missing: string[]
  }> {
    const terms = queryTerms(q.text)
    const base = this.candidateWhere(q)
    const k = q.k ?? DEFAULT_K

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

    const expr = matchExpression(terms)
    if (expr === undefined) return { hits: [], relevant: false, matched, missing }

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
    const top = ranked.slice(0, k)

    const now = this.clock.now()
    const bump = this.db.prepare(
      'UPDATE fact_cards SET usage_recalled = usage_recalled + 1, usage_last_recalled_at = ?' +
        ' WHERE id = ?',
    )
    const hits: RetrievalHit[] = []
    for (const r of top) {
      const row = rows.get(r.id)
      if (row === undefined) continue
      const card = rowToCard(row)
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
      hits.push({
        fact_card_id: card.id,
        score: r.score,
        layer: card.layer,
        statement_redacted: redactSecrets(card.statement),
        provenance_summary: summary,
        sensitivity: card.sensitivity,
        // 47 J2：历史案例要把"当时"一起带出去——调用方据此决定要不要标它过时
        ...(card.as_of === undefined ? {} : { as_of: card.as_of }),
      })
    }
    return { hits, relevant: hits.length > 0, matched, missing }
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
