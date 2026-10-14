/**
 * WP310（docs/99 §5.5，决策 467 / 473）：SEO / GEO 监测的本机存储——一个品牌一个 `geo.sqlite`
 * （放在品牌目录下，和 `seo-state.json` 并排）。
 *
 * | 表 | 一行是什么 |
 * |---|---|
 * | `watch_settings` | 这个品牌的「关注设置」（只有一行） |
 * | `geo_prompts` | 一条 Prompt（**原句不可改**：改字 = 归档旧的 + 新建一条；候选 / 已选用 `selected` 分开） |
 * | `watch_runs` | 一轮监测（geo / rank / brand_gsc） |
 * | `geo_answers` | 一次问答的**全文**（Prompt × AI × 市场 × 那一轮）——真源，指标都从它算、可重算 |
 * | `geo_citations` | 回答里的一条引用（原样网址 + `url_norm` + 站的类型） |
 * | `geo_mentions` | 一条回答里一个品牌的判定（提到 / 引用 / 首次位置 / 名次；情感 O2 才有） |
 * | `seo_rank_snapshots` | 一个关注词一次排名 |
 * | `seo_brand_gsc_weekly` | 品牌词在 Search Console 里一周的曝光 / 点击 / 平均排名（决策 468，Luoye 10-14 改） |
 * | `domain_kinds` | 域名分类缓存（内置表认不出的，O2 交模型判一次；人可改） |
 *
 * 决策 473（Luoye 10-14 改）：回答全文、引用、周指标都**长期保存**，**不做过期清理**；
 * 用户可导出（JSON / CSV）、可删除（按品牌 / 按时间段）。迁移用 `PRAGMA user_version`，只加不删。
 */
import { createHash } from 'node:crypto'
import type {
  AiPlatform,
  BrandWatch,
  CitedSiteKind,
  GeoAnswerRecord,
  GeoCitationRecord,
  GeoHistoryDeleteInput,
  GeoHistoryDeleteResult,
  GeoHistoryExport,
  GeoMentionRecord,
  GeoQuestion,
  Iso8601,
  SeoBrandGscWeek,
  SeoRankSnapshot,
  WatchRun,
} from '@agentsws/contracts'
import {
  BRAND_WATCH_DEFAULT_PLATFORMS,
  GEO_PROMPT_CAP_DEFAULT,
  GEO_STRATEGY_FALLBACK_PROMPTS,
  RANK_CHECK_DEFAULT_DEVICE,
} from '@agentsws/contracts'
import Database from 'better-sqlite3'

/** 每一版迁移（下标 + 1 = 版本号）。**只加不删、不改已发出去的那几条。** */
const MIGRATIONS: readonly string[] = [
  `
CREATE TABLE IF NOT EXISTS geo_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS watch_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  brand_name TEXT NOT NULL,
  brand_aliases TEXT NOT NULL,
  brand_domains TEXT NOT NULL,
  competitors TEXT NOT NULL,
  keywords TEXT NOT NULL,
  platforms TEXT NOT NULL,
  markets TEXT NOT NULL,
  markets_off TEXT,
  frequency TEXT NOT NULL,
  rank_device TEXT NOT NULL,
  prompt_limit INTEGER NOT NULL,
  prompt_cap INTEGER NOT NULL,
  enabled INTEGER NOT NULL,
  next_run_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS geo_prompts (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  topic TEXT,
  branded INTEGER,
  origin TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  selected INTEGER NOT NULL DEFAULT 0,
  seq INTEGER NOT NULL,
  replaces TEXT,
  created_at TEXT NOT NULL,
  archived_at TEXT
);
CREATE INDEX IF NOT EXISTS geo_prompts_live ON geo_prompts (archived_at, selected, seq);
CREATE TABLE IF NOT EXISTS watch_runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  trigger TEXT NOT NULL,
  period TEXT NOT NULL,
  status TEXT NOT NULL,
  planned INTEGER NOT NULL,
  answered INTEGER NOT NULL,
  credits REAL NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS watch_runs_period ON watch_runs (kind, period);
CREATE TABLE IF NOT EXISTS geo_answers (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  prompt_id TEXT NOT NULL,
  prompt_text TEXT NOT NULL,
  asked_text TEXT NOT NULL,
  platform TEXT NOT NULL,
  model TEXT NOT NULL,
  via TEXT NOT NULL,
  market TEXT NOT NULL,
  language TEXT NOT NULL,
  status TEXT NOT NULL,
  answer_md TEXT NOT NULL,
  answer_hash TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  credits REAL NOT NULL,
  UNIQUE (run_id, prompt_id, platform, market)
);
CREATE INDEX IF NOT EXISTS geo_answers_time ON geo_answers (fetched_at);
CREATE INDEX IF NOT EXISTS geo_answers_cell ON geo_answers (prompt_id, platform, market, fetched_at);
CREATE TABLE IF NOT EXISTS geo_citations (
  answer_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  url TEXT NOT NULL,
  url_norm TEXT NOT NULL,
  domain TEXT NOT NULL,
  title TEXT,
  snippet TEXT,
  "where" TEXT NOT NULL,
  site_kind TEXT NOT NULL,
  PRIMARY KEY (answer_id, position)
);
CREATE INDEX IF NOT EXISTS geo_citations_domain ON geo_citations (domain);
CREATE INDEX IF NOT EXISTS geo_citations_page ON geo_citations (url_norm);
CREATE TABLE IF NOT EXISTS geo_mentions (
  answer_id TEXT NOT NULL,
  entity TEXT NOT NULL,
  name_snapshot TEXT NOT NULL,
  alias_hit TEXT,
  mentioned INTEGER NOT NULL,
  cited INTEGER NOT NULL,
  first_offset INTEGER,
  rank INTEGER,
  sentiment TEXT,
  sentiment_quote TEXT,
  rules_version INTEGER NOT NULL,
  PRIMARY KEY (answer_id, entity)
);
CREATE TABLE IF NOT EXISTS seo_rank_snapshots (
  run_id TEXT NOT NULL,
  keyword TEXT NOT NULL,
  market TEXT NOT NULL,
  device TEXT NOT NULL,
  rank INTEGER,
  url TEXT,
  serp_features TEXT NOT NULL,
  aio_mentions_us INTEGER NOT NULL,
  aio_cites_us INTEGER NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (run_id, keyword, market, device)
);
CREATE INDEX IF NOT EXISTS seo_rank_time ON seo_rank_snapshots (keyword, market, fetched_at);
CREATE TABLE IF NOT EXISTS seo_brand_gsc_weekly (
  week TEXT NOT NULL,
  query TEXT NOT NULL,
  impressions INTEGER NOT NULL,
  clicks INTEGER NOT NULL,
  position REAL NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (week, query)
);
CREATE TABLE IF NOT EXISTS domain_kinds (
  domain TEXT PRIMARY KEY,
  site_kind TEXT NOT NULL,
  by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`,
  // WP321（O2）：一轮的几句人话；排队档任务（提交了、还没取回的）；模型认出的其他品牌；
  // 每周指标的快照（决策 473：周指标长期保存）
  `
ALTER TABLE watch_runs ADD COLUMN notes TEXT;
CREATE TABLE IF NOT EXISTS watch_tasks (
  task_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  capability TEXT NOT NULL,
  platform TEXT,
  market TEXT NOT NULL,
  language TEXT NOT NULL,
  device TEXT,
  items TEXT NOT NULL,
  status TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  collected_at TEXT
);
CREATE INDEX IF NOT EXISTS watch_tasks_status ON watch_tasks (status, run_id);
CREATE TABLE IF NOT EXISTS geo_other_brands (
  answer_id TEXT NOT NULL,
  name TEXT NOT NULL,
  PRIMARY KEY (answer_id, name)
);
CREATE TABLE IF NOT EXISTS watch_weekly (
  period TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  computed_at TEXT NOT NULL,
  PRIMARY KEY (period, kind)
);
`,
]

/** 现在的表结构版本。 */
export const GEO_STORE_VERSION = MIGRATIONS.length

/** 回答全文的指纹（同一格两周回答一字不差时，前后对比直接说「没变」）。 */
export function answerHash(markdown: string): string {
  return createHash('sha256').update(markdown, 'utf8').digest('hex').slice(0, 16)
}

/** 关注设置里除了 Prompt 那两格之外的部分（Prompt 单独一张表）。 */
export type BrandWatchSettings = Omit<BrandWatch, 'prompt_candidates' | 'prompts'>

/** 一条存着的 Prompt（契约形状 + 建的时刻 + 它替掉的是哪一条）。 */
export type StoredPrompt = GeoQuestion & { created_at: Iso8601; replaces?: string }

/** 取历史的时间段：`[from, to)`（ISO 时刻；不写就是不限）。 */
export interface GeoRange {
  from?: Iso8601 | undefined
  to?: Iso8601 | undefined
}

/**
 * WP321：一个排队档任务（`ai_answer_batch.*` / `seo.rank_check`）——提交时记下问的是哪几条，
 * 取回时按它对回 Prompt / 关键词。
 */
export interface WatchTask {
  task_id: string
  run_id: string
  kind: 'geo' | 'rank'
  capability: string
  platform?: AiPlatform
  market: string
  language: string
  device?: 'mobile' | 'desktop'
  /** geo：每条问的 Prompt（id、原句、真问出去的那句）；rank：关键词。 */
  items: { prompt_id?: string; prompt_text?: string; asked?: string; keyword?: string }[]
  status: 'pending' | 'collected' | 'failed'
  submitted_at: Iso8601
  collected_at?: Iso8601
}

export interface GeoStore {
  /** 表结构版本（迁移跑完之后）。 */
  version(): number
  meta(key: string): string | undefined
  setMeta(key: string, value: string): void

  /** 关注设置（含候选与已选 Prompt，都不含归档的）；还没建过回 `undefined`。 */
  watch(): BrandWatch | undefined
  saveSettings(settings: BrandWatchSettings): void

  /** Prompt（默认不含归档的；按建的先后）。 */
  prompts(opts?: { archived?: boolean }): StoredPrompt[]
  prompt(id: string): StoredPrompt | undefined
  /** 加一条（id 已有就跳过——原句不可改，见 {@link editPromptText}）。回是否真加了。 */
  addPrompt(p: StoredPrompt): boolean
  /** 改开关 / 选没选 / 方向 / 带没带品牌名（**不改字**）。 */
  updatePrompt(
    id: string,
    patch: Partial<Pick<GeoQuestion, 'enabled' | 'selected' | 'topic' | 'branded'>>,
  ): void
  /** 改字 = 归档旧的 + 新建一条（新的继承方向与选没选）；回新的那条。 */
  editPromptText(id: string, next: { id: string; text: string; at: Iso8601 }): StoredPrompt
  archivePrompt(id: string, at: Iso8601): void
  /** 已选 = 这几条（其余没归档的都变候选）。 */
  selectPrompts(ids: readonly string[]): void

  startRun(run: WatchRun): void
  finishRun(
    id: string,
    patch: Partial<
      Pick<WatchRun, 'status' | 'planned' | 'answered' | 'credits' | 'finished_at' | 'notes'>
    >,
  ): void
  runs(filter?: { kind?: WatchRun['kind']; range?: GeoRange | undefined }): WatchRun[]

  /**
   * 存一次问答（全文 + 引用 + 各品牌判定，一个事务；同 id 覆盖）。同一格（轮 × Prompt × AI × 市场）
   * 已经有另一条时抛错——一轮里一格只问一次（docs/99 §5.2）。
   */
  recordAnswer(
    a: GeoAnswerRecord,
    citations: readonly GeoCitationRecord[],
    mentions: readonly GeoMentionRecord[],
  ): void
  answers(filter?: {
    range?: GeoRange | undefined
    run_id?: string
    prompt_id?: string
    platform?: AiPlatform
    market?: string
  }): GeoAnswerRecord[]
  citations(answer_id: string): GeoCitationRecord[]
  mentions(answer_id: string): GeoMentionRecord[]
  /** 改了匹配规则 / 关注设置之后，对历史原文重算判定（整条回答的判定一起换）。 */
  replaceMentions(answer_id: string, mentions: readonly GeoMentionRecord[]): void

  recordRank(s: SeoRankSnapshot): void
  ranks(filter?: {
    keyword?: string
    market?: string
    range?: GeoRange | undefined
  }): SeoRankSnapshot[]
  /** 同一周同一个词新取的覆盖旧的。 */
  recordBrandGscWeeks(rows: readonly SeoBrandGscWeek[]): void
  brandGscWeeks(filter?: { query?: string; range?: GeoRange | undefined }): SeoBrandGscWeek[]

  domainKind(domain: string): CitedSiteKind | undefined
  setDomainKind(
    domain: string,
    kind: CitedSiteKind,
    by: 'rule' | 'model' | 'human',
    at: Iso8601,
  ): void

  /** 决策 473：导出（JSON 一份 / CSV 每张表一份）。 */
  exportHistory(format: 'json' | 'csv', at: Iso8601, range?: GeoRange | undefined): GeoHistoryExport
  /** 决策 473：删除（按品牌 = 全部历史，可连设置一起；按时间段 = `[from, to)`）。 */
  deleteHistory(input: GeoHistoryDeleteInput): GeoHistoryDeleteResult
  /** WP321：排队档任务。 */
  addTask(t: WatchTask): void
  tasks(filter?: { status?: WatchTask['status']; run_id?: string }): WatchTask[]
  finishTask(task_id: string, status: 'collected' | 'failed', at: Iso8601): void
  /** WP321：模型从一条回答里认出的其他品牌（整条换）。 */
  setOtherBrands(answer_id: string, names: readonly string[]): void
  otherBrands(answer_ids?: readonly string[]): { answer_id: string; name: string }[]
  /** WP321（决策 473）：每周指标的快照（同一周同一种新算的覆盖旧的）。 */
  saveWeekly(
    period: string,
    kind: 'geo' | 'rank' | 'brand_gsc',
    payload: unknown,
    at: Iso8601,
  ): void
  weekly(
    kind: 'geo' | 'rank' | 'brand_gsc',
  ): { period: string; payload: unknown; computed_at: Iso8601 }[]
  /** 一个事务里做完（迁移老数据用）。 */
  tx<T>(fn: () => T): T
  close(): void
}

/* ── 行 ↔ 契约 ───────────────────────────────────────────────────────── */

type Row = Record<string, unknown>
const j = (v: unknown): string => JSON.stringify(v)
const pj = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== 'string') return fallback
  try {
    return JSON.parse(v) as T
  } catch {
    return fallback
  }
}
const b = (v: boolean): number => (v ? 1 : 0)
const opt = <K extends string, V>(k: K, v: V | null | undefined): { [P in K]?: V } =>
  (v === null || v === undefined ? {} : { [k]: v }) as { [P in K]?: V }

function promptOf(r: Row): StoredPrompt {
  return {
    id: String(r.id),
    text: String(r.text),
    origin: r.origin as GeoQuestion['origin'],
    enabled: r.enabled === 1,
    ...opt('topic', r.topic as GeoQuestion['topic'] | null),
    ...(r.branded === null || r.branded === undefined ? {} : { branded: r.branded === 1 }),
    selected: r.selected === 1,
    ...opt('archived_at', r.archived_at as string | null),
    created_at: String(r.created_at),
    ...opt('replaces', r.replaces as string | null),
  }
}

function runOf(r: Row): WatchRun {
  return {
    id: String(r.id),
    kind: r.kind as WatchRun['kind'],
    trigger: r.trigger as WatchRun['trigger'],
    period: String(r.period),
    status: r.status as WatchRun['status'],
    planned: Number(r.planned),
    answered: Number(r.answered),
    credits: Number(r.credits),
    started_at: String(r.started_at),
    ...opt('finished_at', r.finished_at as string | null),
    ...(() => {
      const notes = pj<string[] | undefined>(r.notes, undefined)
      return notes === undefined || notes.length === 0 ? {} : { notes }
    })(),
  }
}

function taskOf(r: Row): WatchTask {
  return {
    task_id: String(r.task_id),
    run_id: String(r.run_id),
    kind: r.kind as WatchTask['kind'],
    capability: String(r.capability),
    ...opt('platform', r.platform as AiPlatform | null),
    market: String(r.market),
    language: String(r.language),
    ...opt('device', r.device as WatchTask['device'] | null),
    items: pj(r.items, []),
    status: r.status as WatchTask['status'],
    submitted_at: String(r.submitted_at),
    ...opt('collected_at', r.collected_at as string | null),
  }
}

function answerOf(r: Row): GeoAnswerRecord {
  return {
    id: String(r.id),
    run_id: String(r.run_id),
    prompt_id: String(r.prompt_id),
    prompt_text: String(r.prompt_text),
    asked_text: String(r.asked_text),
    platform: r.platform as AiPlatform,
    model: String(r.model),
    via: r.via as GeoAnswerRecord['via'],
    market: String(r.market),
    language: String(r.language),
    status: r.status as GeoAnswerRecord['status'],
    answer_md: String(r.answer_md),
    answer_hash: String(r.answer_hash),
    fetched_at: String(r.fetched_at),
    credits: Number(r.credits),
  }
}

function citationOf(r: Row): GeoCitationRecord {
  return {
    answer_id: String(r.answer_id),
    position: Number(r.position),
    url: String(r.url),
    url_norm: String(r.url_norm),
    domain: String(r.domain),
    ...opt('title', r.title as string | null),
    ...opt('snippet', r.snippet as string | null),
    where: r.where as GeoCitationRecord['where'],
    site_kind: r.site_kind as CitedSiteKind,
  }
}

function mentionOf(r: Row): GeoMentionRecord {
  return {
    answer_id: String(r.answer_id),
    entity: String(r.entity),
    name_snapshot: String(r.name_snapshot),
    ...opt('alias_hit', r.alias_hit as string | null),
    mentioned: r.mentioned === 1,
    cited: r.cited === 1,
    ...opt('first_offset', r.first_offset as number | null),
    ...opt('rank', r.rank as number | null),
    ...opt('sentiment', r.sentiment as GeoMentionRecord['sentiment'] | null),
    ...opt('sentiment_quote', r.sentiment_quote as string | null),
    rules_version: Number(r.rules_version),
  }
}

function rankOf(r: Row): SeoRankSnapshot {
  return {
    run_id: String(r.run_id),
    keyword: String(r.keyword),
    market: String(r.market),
    device: r.device as SeoRankSnapshot['device'],
    ...opt('rank', r.rank as number | null),
    ...opt('url', r.url as string | null),
    serp_features: pj(r.serp_features, {
      ai_overview: false,
      people_also_ask: false,
      shopping: false,
      video: false,
    }),
    aio_mentions_us: r.aio_mentions_us === 1,
    aio_cites_us: r.aio_cites_us === 1,
    fetched_at: String(r.fetched_at),
  }
}

function gscOf(r: Row): SeoBrandGscWeek {
  return {
    week: String(r.week),
    query: String(r.query),
    impressions: Number(r.impressions),
    clicks: Number(r.clicks),
    position: Number(r.position),
    fetched_at: String(r.fetched_at),
  }
}

/** `[from, to)` → SQL 条件 + 参数。 */
function rangeSql(col: string, range: GeoRange | undefined): { sql: string; args: string[] } {
  const parts: string[] = []
  const args: string[] = []
  if (range?.from !== undefined) {
    parts.push(`${col} >= ?`)
    args.push(range.from)
  }
  if (range?.to !== undefined) {
    parts.push(`${col} < ?`)
    args.push(range.to)
  }
  return { sql: parts.join(' AND '), args }
}

/** 多个条件拼成 `WHERE …`（空的跳过）。 */
function where(conds: { sql: string; args: unknown[] }[]): { sql: string; args: unknown[] } {
  const live = conds.filter((c) => c.sql !== '')
  return {
    sql: live.length === 0 ? '' : ` WHERE ${live.map((c) => c.sql).join(' AND ')}`,
    args: live.flatMap((c) => c.args),
  }
}

/** `dbPath` 不给就是内存档（测试与一次性任务）。打开时把迁移跑到最新。 */
export function createGeoStore(dbPath?: string): GeoStore {
  const db = new Database(dbPath ?? ':memory:')
  if (dbPath !== undefined) db.pragma('journal_mode = WAL')
  const current = Number(db.pragma('user_version', { simple: true }))
  db.transaction(() => {
    for (let v = current; v < MIGRATIONS.length; v += 1) db.exec(MIGRATIONS[v] ?? '')
    if (current < MIGRATIONS.length) db.pragma(`user_version = ${MIGRATIONS.length}`)
  })()

  const all = (sql: string, ...args: unknown[]): Row[] => db.prepare(sql).all(...args) as Row[]
  const one = (sql: string, ...args: unknown[]): Row | undefined =>
    db.prepare(sql).get(...args) as Row | undefined

  const settings = (): BrandWatchSettings | undefined => {
    const r = one('SELECT * FROM watch_settings WHERE id = 1')
    if (r === undefined) return undefined
    const markets_off = pj<string[] | undefined>(r.markets_off, undefined)
    return {
      brand: {
        name: String(r.brand_name),
        aliases: pj(r.brand_aliases, []),
        domains: pj(r.brand_domains, []),
      },
      competitors: pj(r.competitors, []),
      prompt_limit: Number(r.prompt_limit),
      prompt_cap: Number(r.prompt_cap),
      keywords: pj(r.keywords, []),
      markets: pj(r.markets, []),
      ...(markets_off === undefined ? {} : { markets_off }),
      platforms: pj(r.platforms, []),
      frequency: r.frequency as BrandWatch['frequency'],
      rank_device: r.rank_device as BrandWatch['rank_device'],
      enabled: r.enabled === 1,
      ...opt('next_run_at', r.next_run_at as string | null),
      updated_at: String(r.updated_at),
    }
  }

  const prompts = (opts?: { archived?: boolean }): StoredPrompt[] =>
    all(
      `SELECT * FROM geo_prompts${opts?.archived === true ? '' : ' WHERE archived_at IS NULL'} ORDER BY seq, id`,
    ).map(promptOf)

  const nextSeq = (): number =>
    Number(one('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM geo_prompts')?.n ?? 1)

  const insertPrompt = (p: StoredPrompt): boolean =>
    db
      .prepare(
        `INSERT OR IGNORE INTO geo_prompts
         (id, text, topic, branded, origin, enabled, selected, seq, replaces, created_at, archived_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        p.id,
        p.text,
        p.topic ?? null,
        p.branded === undefined ? null : b(p.branded),
        p.origin,
        b(p.enabled),
        b(p.selected === true),
        nextSeq(),
        p.replaces ?? null,
        p.created_at,
        p.archived_at ?? null,
      ).changes > 0

  const answerIdsIn = (range: GeoRange | undefined): string[] => {
    const w = where([rangeSql('fetched_at', range)])
    return all(`SELECT id FROM geo_answers${w.sql}`, ...w.args).map((r) => String(r.id))
  }
  const forAnswers = <T>(table: string, ids: readonly string[], map: (r: Row) => T): T[] => {
    const out: T[] = []
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500)
      const marks = chunk.map(() => '?').join(',')
      const order =
        table === 'geo_citations'
          ? 'answer_id, position'
          : table === 'geo_other_brands'
            ? 'answer_id, name'
            : 'answer_id, entity'
      out.push(
        ...all(
          `SELECT * FROM ${table} WHERE answer_id IN (${marks}) ORDER BY ${order}`,
          ...chunk,
        ).map(map),
      )
    }
    return out
  }

  const insertMentions = (answer_id: string, mentions: readonly GeoMentionRecord[]): void => {
    const put = db.prepare(
      `INSERT OR REPLACE INTO geo_mentions (answer_id, entity, name_snapshot, alias_hit, mentioned, cited,
         first_offset, rank, sentiment, sentiment_quote, rules_version) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    )
    for (const m of mentions)
      put.run(
        answer_id,
        m.entity,
        m.name_snapshot,
        m.alias_hit ?? null,
        b(m.mentioned),
        b(m.cited),
        m.first_offset ?? null,
        m.rank ?? null,
        m.sentiment ?? null,
        m.sentiment_quote ?? null,
        m.rules_version,
      )
  }

  const store: GeoStore = {
    version: () => Number(db.pragma('user_version', { simple: true })),
    meta: (key) => {
      const r = one('SELECT value FROM geo_meta WHERE key = ?', key)
      return r === undefined ? undefined : String(r.value)
    },
    setMeta: (key, value) => {
      db.prepare(
        'INSERT INTO geo_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ).run(key, value)
    },

    watch: () => {
      const s = settings()
      if (s === undefined) return undefined
      const live = prompts()
      return {
        ...s,
        prompt_candidates: live.filter((p) => p.selected !== true).map(asQuestion),
        prompts: live.filter((p) => p.selected === true).map(asQuestion),
      }
    },
    saveSettings: (w) => {
      db.prepare(
        `INSERT INTO watch_settings (id, brand_name, brand_aliases, brand_domains, competitors, keywords,
           platforms, markets, markets_off, frequency, rank_device, prompt_limit, prompt_cap, enabled,
           next_run_at, updated_at)
         VALUES (1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET brand_name = excluded.brand_name,
           brand_aliases = excluded.brand_aliases, brand_domains = excluded.brand_domains,
           competitors = excluded.competitors, keywords = excluded.keywords,
           platforms = excluded.platforms, markets = excluded.markets,
           markets_off = excluded.markets_off, frequency = excluded.frequency,
           rank_device = excluded.rank_device, prompt_limit = excluded.prompt_limit,
           prompt_cap = excluded.prompt_cap, enabled = excluded.enabled,
           next_run_at = excluded.next_run_at, updated_at = excluded.updated_at`,
      ).run(
        w.brand.name,
        j(w.brand.aliases),
        j(w.brand.domains),
        j(w.competitors),
        j(w.keywords),
        j(w.platforms),
        j(w.markets),
        w.markets_off === undefined ? null : j(w.markets_off),
        w.frequency,
        w.rank_device,
        w.prompt_limit,
        w.prompt_cap,
        b(w.enabled),
        w.next_run_at ?? null,
        w.updated_at,
      )
    },

    prompts,
    prompt: (id) => {
      const r = one('SELECT * FROM geo_prompts WHERE id = ?', id)
      return r === undefined ? undefined : promptOf(r)
    },
    addPrompt: insertPrompt,
    updatePrompt: (id, patch) => {
      const sets: string[] = []
      const args: unknown[] = []
      const set = (col: string, v: unknown): void => {
        sets.push(`${col} = ?`)
        args.push(v)
      }
      if (patch.enabled !== undefined) set('enabled', b(patch.enabled))
      if (patch.selected !== undefined) set('selected', b(patch.selected))
      if (patch.topic !== undefined) set('topic', patch.topic)
      if (patch.branded !== undefined) set('branded', b(patch.branded))
      if (sets.length === 0) return
      db.prepare(`UPDATE geo_prompts SET ${sets.join(', ')} WHERE id = ?`).run(...args, id)
    },
    editPromptText: (id, next) =>
      db.transaction(() => {
        const old = store.prompt(id)
        if (old === undefined) throw new Error(`没有这条 Prompt：${id}`)
        if (old.text === next.text.trim()) return old
        db.prepare(
          'UPDATE geo_prompts SET archived_at = ? WHERE id = ? AND archived_at IS NULL',
        ).run(next.at, id)
        const fresh: StoredPrompt = {
          id: next.id,
          text: next.text.trim(),
          origin: 'human',
          enabled: old.enabled,
          ...(old.topic === undefined ? {} : { topic: old.topic }),
          selected: old.selected === true,
          created_at: next.at,
          replaces: id,
        }
        insertPrompt(fresh)
        return fresh
      })(),
    archivePrompt: (id, at) => {
      db.prepare(
        'UPDATE geo_prompts SET archived_at = ?, selected = 0 WHERE id = ? AND archived_at IS NULL',
      ).run(at, id)
    },
    selectPrompts: (ids) =>
      db.transaction(() => {
        db.prepare('UPDATE geo_prompts SET selected = 0 WHERE archived_at IS NULL').run()
        const sel = db.prepare(
          'UPDATE geo_prompts SET selected = 1 WHERE id = ? AND archived_at IS NULL',
        )
        for (const id of ids) sel.run(id)
      })(),

    startRun: (r) => {
      db.prepare(
        `INSERT INTO watch_runs (id, kind, trigger, period, status, planned, answered, credits, started_at, finished_at, notes)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        r.id,
        r.kind,
        r.trigger,
        r.period,
        r.status,
        r.planned,
        r.answered,
        r.credits,
        r.started_at,
        r.finished_at ?? null,
        r.notes === undefined ? null : j(r.notes),
      )
    },
    finishRun: (id, patch) => {
      const cur = one('SELECT * FROM watch_runs WHERE id = ?', id)
      if (cur === undefined) return
      const next = { ...runOf(cur), ...patch }
      db.prepare(
        'UPDATE watch_runs SET status = ?, planned = ?, answered = ?, credits = ?, finished_at = ?, notes = ? WHERE id = ?',
      ).run(
        next.status,
        next.planned,
        next.answered,
        next.credits,
        next.finished_at ?? null,
        next.notes === undefined ? null : j(next.notes),
        id,
      )
    },
    runs: (filter) => {
      const w = where([
        filter?.kind === undefined
          ? { sql: '', args: [] }
          : { sql: 'kind = ?', args: [filter.kind] },
        rangeSql('started_at', filter?.range),
      ])
      return all(`SELECT * FROM watch_runs${w.sql} ORDER BY started_at, id`, ...w.args).map(runOf)
    },

    recordAnswer: (a, citations, mentions) =>
      db.transaction(() => {
        db.prepare('DELETE FROM geo_citations WHERE answer_id = ?').run(a.id)
        db.prepare('DELETE FROM geo_mentions WHERE answer_id = ?').run(a.id)
        db.prepare(
          `INSERT INTO geo_answers (id, run_id, prompt_id, prompt_text, asked_text, platform,
             model, via, market, language, status, answer_md, answer_hash, fetched_at, credits)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET run_id = excluded.run_id, prompt_id = excluded.prompt_id,
             prompt_text = excluded.prompt_text, asked_text = excluded.asked_text,
             platform = excluded.platform, model = excluded.model, via = excluded.via,
             market = excluded.market, language = excluded.language, status = excluded.status,
             answer_md = excluded.answer_md, answer_hash = excluded.answer_hash,
             fetched_at = excluded.fetched_at, credits = excluded.credits`,
        ).run(
          a.id,
          a.run_id,
          a.prompt_id,
          a.prompt_text,
          a.asked_text,
          a.platform,
          a.model,
          a.via,
          a.market,
          a.language,
          a.status,
          a.answer_md,
          a.answer_hash,
          a.fetched_at,
          a.credits,
        )
        const cit = db.prepare(
          `INSERT INTO geo_citations (answer_id, position, url, url_norm, domain, title, snippet, "where", site_kind)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        )
        for (const c of citations)
          cit.run(
            a.id,
            c.position,
            c.url,
            c.url_norm,
            c.domain,
            c.title ?? null,
            c.snippet ?? null,
            c.where,
            c.site_kind,
          )
        insertMentions(a.id, mentions)
      })(),
    answers: (filter) => {
      const eq = (col: string, v: string | undefined) =>
        v === undefined ? { sql: '', args: [] } : { sql: `${col} = ?`, args: [v] }
      const w = where([
        rangeSql('fetched_at', filter?.range),
        eq('run_id', filter?.run_id),
        eq('prompt_id', filter?.prompt_id),
        eq('platform', filter?.platform),
        eq('market', filter?.market),
      ])
      return all(`SELECT * FROM geo_answers${w.sql} ORDER BY fetched_at, id`, ...w.args).map(
        answerOf,
      )
    },
    citations: (answer_id) =>
      all('SELECT * FROM geo_citations WHERE answer_id = ? ORDER BY position', answer_id).map(
        citationOf,
      ),
    mentions: (answer_id) =>
      all('SELECT * FROM geo_mentions WHERE answer_id = ? ORDER BY rowid', answer_id).map(
        mentionOf,
      ),
    replaceMentions: (answer_id, mentions) =>
      db.transaction(() => {
        db.prepare('DELETE FROM geo_mentions WHERE answer_id = ?').run(answer_id)
        insertMentions(answer_id, mentions)
      })(),

    recordRank: (r) => {
      db.prepare(
        `INSERT OR REPLACE INTO seo_rank_snapshots (run_id, keyword, market, device, rank, url,
           serp_features, aio_mentions_us, aio_cites_us, fetched_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        r.run_id,
        r.keyword,
        r.market,
        r.device,
        r.rank ?? null,
        r.url ?? null,
        j(r.serp_features),
        b(r.aio_mentions_us),
        b(r.aio_cites_us),
        r.fetched_at,
      )
    },
    ranks: (filter) => {
      const w = where([
        filter?.keyword === undefined
          ? { sql: '', args: [] }
          : { sql: 'keyword = ?', args: [filter.keyword] },
        filter?.market === undefined
          ? { sql: '', args: [] }
          : { sql: 'market = ?', args: [filter.market] },
        rangeSql('fetched_at', filter?.range),
      ])
      return all(
        `SELECT * FROM seo_rank_snapshots${w.sql} ORDER BY fetched_at, keyword`,
        ...w.args,
      ).map(rankOf)
    },
    recordBrandGscWeeks: (rows) =>
      db.transaction(() => {
        const put = db.prepare(
          `INSERT INTO seo_brand_gsc_weekly (week, query, impressions, clicks, position, fetched_at)
           VALUES (?,?,?,?,?,?) ON CONFLICT(week, query) DO UPDATE SET impressions = excluded.impressions,
           clicks = excluded.clicks, position = excluded.position, fetched_at = excluded.fetched_at`,
        )
        for (const r of rows)
          put.run(r.week, r.query, r.impressions, r.clicks, r.position, r.fetched_at)
      })(),
    brandGscWeeks: (filter) => {
      const w = where([
        filter?.query === undefined
          ? { sql: '', args: [] }
          : { sql: 'query = ?', args: [filter.query] },
        rangeSql('week', filter?.range),
      ])
      return all(`SELECT * FROM seo_brand_gsc_weekly${w.sql} ORDER BY week, query`, ...w.args).map(
        gscOf,
      )
    },

    domainKind: (domain) => {
      const r = one('SELECT site_kind FROM domain_kinds WHERE domain = ?', domain.toLowerCase())
      return r === undefined ? undefined : (r.site_kind as CitedSiteKind)
    },
    setDomainKind: (domain, kind, by, at) => {
      // 人改过的不让模型 / 规则盖回去
      const cur = one('SELECT by FROM domain_kinds WHERE domain = ?', domain.toLowerCase())
      if (cur !== undefined && cur.by === 'human' && by !== 'human') return
      db.prepare(
        `INSERT INTO domain_kinds (domain, site_kind, by, updated_at) VALUES (?,?,?,?)
         ON CONFLICT(domain) DO UPDATE SET site_kind = excluded.site_kind, by = excluded.by,
         updated_at = excluded.updated_at`,
      ).run(domain.toLowerCase(), kind, by, at)
    },

    exportHistory: (format, at, range) => {
      const answers = store.answers({ range })
      const ids = answers.map((a) => a.id)
      const tables = {
        watch: store.watch() ?? null,
        runs: store.runs({ range }),
        answers,
        citations: forAnswers('geo_citations', ids, citationOf),
        mentions: forAnswers('geo_mentions', ids, mentionOf),
        ranks: store.ranks({ range }),
        brand_gsc: store.brandGscWeeks({ range: weekRange(range) }),
        other_brands: store.otherBrands(ids),
      }
      const head = {
        format,
        exported_at: at,
        ...(range?.from === undefined && range?.to === undefined
          ? {}
          : {
              range: {
                ...(range?.from === undefined ? {} : { from: range.from }),
                ...(range?.to === undefined ? {} : { to: range.to }),
              },
            }),
      }
      if (format === 'json') return { ...head, tables }
      return {
        ...head,
        csv: {
          prompts: toCsv(prompts({ archived: true })),
          runs: toCsv(tables.runs),
          answers: toCsv(tables.answers),
          citations: toCsv(tables.citations),
          mentions: toCsv(tables.mentions),
          ranks: toCsv(tables.ranks),
          brand_gsc: toCsv(tables.brand_gsc),
          other_brands: toCsv(tables.other_brands),
        },
      }
    },
    deleteHistory: (input) =>
      db.transaction((): GeoHistoryDeleteResult => {
        const range: GeoRange | undefined =
          input.scope === 'brand' ? undefined : { from: input.from, to: input.to }
        if (input.scope === 'range' && input.from === undefined && input.to === undefined)
          throw new Error('按时间段删要给 from 或 to（全删请用按品牌）。')
        const ids = answerIdsIn(range)
        const drop = (table: string): number => {
          let n = 0
          for (let i = 0; i < ids.length; i += 500) {
            const chunk = ids.slice(i, i + 500)
            n += db
              .prepare(
                `DELETE FROM ${table} WHERE answer_id IN (${chunk.map(() => '?').join(',')})`,
              )
              .run(...chunk).changes
          }
          return n
        }
        const del = (table: string, col: string, r: GeoRange | undefined): number => {
          const w = where([rangeSql(col, r)])
          return db.prepare(`DELETE FROM ${table}${w.sql}`).run(...w.args).changes
        }
        drop('geo_other_brands')
        const out: GeoHistoryDeleteResult = {
          citations: drop('geo_citations'),
          mentions: drop('geo_mentions'),
          answers: del('geo_answers', 'fetched_at', range),
          runs: del('watch_runs', 'started_at', range),
          ranks: del('seo_rank_snapshots', 'fetched_at', range),
          brand_gsc: del('seo_brand_gsc_weekly', 'week', weekRange(range)),
        }
        // WP321：排队档任务与每周快照跟着走（快照是从删掉的那段算出来的）
        del('watch_tasks', 'submitted_at', range)
        del('watch_weekly', 'period', weekRange(range))
        if (input.scope === 'brand' && input.include_settings === true) {
          // 迁移标记留着：删了设置之后不会再从 seo-state.json 把老问题搬回来
          db.prepare('DELETE FROM watch_settings').run()
          db.prepare('DELETE FROM geo_prompts').run()
          db.prepare('DELETE FROM domain_kinds').run()
        }
        return out
      })(),
    addTask: (t) => {
      db.prepare(
        `INSERT OR REPLACE INTO watch_tasks (task_id, run_id, kind, capability, platform, market, language,
           device, items, status, submitted_at, collected_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        t.task_id,
        t.run_id,
        t.kind,
        t.capability,
        t.platform ?? null,
        t.market,
        t.language,
        t.device ?? null,
        j(t.items),
        t.status,
        t.submitted_at,
        t.collected_at ?? null,
      )
    },
    tasks: (filter) => {
      const eq = (col: string, v: string | undefined) =>
        v === undefined ? { sql: '', args: [] } : { sql: `${col} = ?`, args: [v] }
      const w = where([eq('status', filter?.status), eq('run_id', filter?.run_id)])
      return all(`SELECT * FROM watch_tasks${w.sql} ORDER BY submitted_at, task_id`, ...w.args).map(
        taskOf,
      )
    },
    finishTask: (task_id, status, at) => {
      db.prepare('UPDATE watch_tasks SET status = ?, collected_at = ? WHERE task_id = ?').run(
        status,
        at,
        task_id,
      )
    },
    setOtherBrands: (answer_id, names) =>
      db.transaction(() => {
        db.prepare('DELETE FROM geo_other_brands WHERE answer_id = ?').run(answer_id)
        const put = db.prepare(
          'INSERT OR IGNORE INTO geo_other_brands (answer_id, name) VALUES (?, ?)',
        )
        for (const n of names) put.run(answer_id, n)
      })(),
    otherBrands: (answer_ids) =>
      (answer_ids === undefined
        ? all('SELECT * FROM geo_other_brands ORDER BY answer_id, name')
        : forAnswers('geo_other_brands', answer_ids, (r) => r)
      ).map((r) => ({ answer_id: String(r.answer_id), name: String(r.name) })),
    saveWeekly: (period, kind, payload, at) => {
      db.prepare(
        `INSERT INTO watch_weekly (period, kind, payload, computed_at) VALUES (?,?,?,?)
         ON CONFLICT(period, kind) DO UPDATE SET payload = excluded.payload, computed_at = excluded.computed_at`,
      ).run(period, kind, j(payload), at)
    },
    weekly: (kind) =>
      all('SELECT * FROM watch_weekly WHERE kind = ? ORDER BY period', kind).map((r) => ({
        period: String(r.period),
        payload: pj(r.payload, null),
        computed_at: String(r.computed_at),
      })),
    tx: (fn) => db.transaction(fn)(),
    close: () => db.close(),
  }
  return store
}

/** 存着的 Prompt → 契约形状（去掉建的时刻与替掉了谁）。 */
function asQuestion(p: StoredPrompt): GeoQuestion {
  const { created_at: _c, replaces: _r, ...q } = p
  return q
}

/** 时刻段 → 周一日期段（`seo_brand_gsc_weekly.week` 是 `YYYY-MM-DD`）。 */
function weekRange(range: GeoRange | undefined): GeoRange | undefined {
  if (range === undefined) return undefined
  return {
    ...(range.from === undefined ? {} : { from: range.from.slice(0, 10) }),
    ...(range.to === undefined ? {} : { to: range.to.slice(0, 10) }),
  }
}

/**
 * 一组行 → CSV（UTF-8 带 BOM，表格软件直接认中文；带表头；数组 / 对象按 JSON 写）。
 * 以 `=` `+` `@` 开头的格前面加一个 `'`，免得表格软件当公式跑。
 */
export function toCsv(rows: readonly object[]): string {
  const cols: string[] = []
  for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k)
  const cell = (v: unknown): string => {
    if (v === undefined || v === null) return ''
    let t = typeof v === 'object' ? JSON.stringify(v) : String(v)
    if (/^[=+@\t\r]/u.test(t)) t = `'${t}`
    return /[",\n\r]|^\s|\s$/u.test(t) ? `"${t.replace(/"/gu, '""')}"` : t
  }
  const lines = [cols.join(','), ...rows.map((r) => cols.map((c) => cell((r as Row)[c])).join(','))]
  return `﻿${lines.join('\r\n')}\r\n`
}

/* ── 老数据：`seo-state.json` 里的问题清单与开关搬进来（老数据不丢） ──────────── */

/** `seo-state.json` 里与 GEO 有关的那两格（WP154 / 166 的形状）。 */
export interface LegacySeoGeoState {
  geo_settings?: { enabled: boolean; max_questions: number; markets_off?: string[] } | undefined
  geo_questions?: readonly GeoQuestion[] | undefined
}

/** 搬过一次就记这个键（值是搬的时刻）；之后不再搬，删了设置也不会把老问题搬回来。 */
export const SEO_STATE_IMPORTED_KEY = 'seo_state_imported_at'

/**
 * 一份新的关注设置：按决策 460 / 466 / 530–532（Luoye 10-14 改）的默认——**所有品牌一样**（没有真实
 * 用户，不分新老）：四个 AI（ChatGPT、Gemini、Claude、Google AI 概览，各自可关）、先按兜底追
 * {@link GEO_STRATEGY_FALLBACK_PROMPTS} 条（追几条 / 带品牌名几条在策略设定时由 AI 建议、人确认）、
 * 每周、手机。从老数据搬来的（`legacy`）只留老版的总开关与关掉的市场（不留老默认 6 条、不留老三家）。
 */
export function defaultWatchSettings(input: {
  brand: { name: string; domains: readonly string[]; aliases?: readonly string[] | undefined }
  markets: readonly string[]
  at: Iso8601
  legacy?: LegacySeoGeoState | undefined
}): BrandWatchSettings {
  const legacy = input.legacy
  const markets_off = legacy?.geo_settings?.markets_off
  return {
    brand: {
      name: input.brand.name,
      aliases: [...(input.brand.aliases ?? [])],
      domains: [...input.brand.domains],
    },
    competitors: [],
    prompt_limit: GEO_STRATEGY_FALLBACK_PROMPTS,
    prompt_cap: GEO_PROMPT_CAP_DEFAULT,
    keywords: [],
    markets: input.markets.map((m) => m.toUpperCase()),
    ...(markets_off === undefined ? {} : { markets_off: markets_off.map((m) => m.toUpperCase()) }),
    platforms: [...BRAND_WATCH_DEFAULT_PLATFORMS],
    frequency: 'weekly',
    rank_device: RANK_CHECK_DEFAULT_DEVICE,
    enabled: legacy?.geo_settings?.enabled ?? true,
    updated_at: input.at,
  }
}

/**
 * 把 `seo-state.json` 里的问题清单与开关搬进 `geo.sqlite`（只搬一次；`seo-state.json` 原样不动）。
 *
 * - 开关 / 关掉的市场 → 关注设置（已经有关注设置就不覆盖；决策 532：不留老默认 6 条、不留老三家）；
 * - 每个问题 → 一条 Prompt（id、原句、来路、开没开都照旧，**一条不丢**）；开着的前
 *   {@link GEO_STRATEGY_FALLBACK_PROMPTS} 条记为「已选」，其余是候选（不看老版「问几个」）；
 * - `branded` 按品牌名 / 别名判（给了 `isBranded` 才判）。
 */
export function importSeoState(
  store: GeoStore,
  state: LegacySeoGeoState,
  ctx: {
    at: Iso8601
    brand: { name: string; domains: readonly string[]; aliases?: readonly string[] | undefined }
    markets: readonly string[]
    isBranded?: ((text: string) => boolean) | undefined
  },
): { imported: boolean; prompts: number } {
  if (store.meta(SEO_STATE_IMPORTED_KEY) !== undefined) return { imported: false, prompts: 0 }
  return store.tx(() => {
    const questions = state.geo_questions ?? []
    const hasLegacy = state.geo_settings !== undefined || questions.length > 0
    if (store.watch() === undefined && hasLegacy)
      store.saveSettings(
        defaultWatchSettings({
          brand: ctx.brand,
          markets: ctx.markets,
          at: ctx.at,
          legacy: state,
        }),
      )
    // 决策 532：一律按新设置（兜底追 5 条）挑已选，不看老版「问几个」
    const limit = GEO_STRATEGY_FALLBACK_PROMPTS
    let picked = 0
    let added = 0
    for (const q of questions) {
      const selected = q.enabled && picked < limit
      if (selected) picked += 1
      const ok = store.addPrompt({
        id: q.id,
        text: q.text,
        origin: q.origin,
        enabled: q.enabled,
        ...(q.topic === undefined ? {} : { topic: q.topic }),
        ...(ctx.isBranded === undefined ? {} : { branded: ctx.isBranded(q.text) }),
        selected,
        created_at: ctx.at,
      })
      if (ok) added += 1
    }
    store.setMeta(SEO_STATE_IMPORTED_KEY, ctx.at)
    return { imported: true, prompts: added }
  })
}

/** WP321：迁到新设置做过一次就记这个键（值是做的时刻）。 */
export const WATCH_V321_KEY = 'watch_v321_at'

/**
 * WP321（决策 532，Luoye 10-14 改）：已有的关注设置**一律迁到新设置**——关注的 AI 换成默认四家、
 * 追几条回到兜底 {@link GEO_STRATEGY_FALLBACK_PROMPTS}（不留老默认 6 条、不留老三家）；已选里超出的
 * 那几条变回候选（按原来的先后留前几条），**老问题与老数据一条不动**。只做一次；之后人改的照人改的。
 * 回是否真迁了。
 */
export function upgradeWatchTo321(store: GeoStore, at: Iso8601): boolean {
  if (store.meta(WATCH_V321_KEY) !== undefined) return false
  return store.tx(() => {
    const w = store.watch()
    if (w !== undefined) {
      const { prompt_candidates: _c, prompts: selected, ...settings } = w
      store.saveSettings({
        ...settings,
        platforms: [...BRAND_WATCH_DEFAULT_PLATFORMS],
        prompt_limit: GEO_STRATEGY_FALLBACK_PROMPTS,
        updated_at: at,
      })
      if (selected.length > GEO_STRATEGY_FALLBACK_PROMPTS)
        store.selectPrompts(selected.slice(0, GEO_STRATEGY_FALLBACK_PROMPTS).map((p) => p.id))
    }
    store.setMeta(WATCH_V321_KEY, at)
    return w !== undefined
  })
}
