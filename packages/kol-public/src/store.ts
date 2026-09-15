/**
 * 公共红人库的库（48 §5.3）。两份实现：内存（测试与 `bin/dev.mjs`）与 sqlite（云上）。
 * 形状一样、行为一样，所以逻辑只测一次。
 *
 * **库按 `channel` 分区**：主键是 `(channel, handle)` 这个自足键，不是任何一侧的 id。
 * 同一个人在两个渠道就是两行——48 §5.1 的"渠道之间零共享数据"在这一层就成立。
 *
 * 七张表里，有两张的形状是纪律而不是设计：
 *
 * - `kol_contacts`：**没有明文邮箱这一列**。只有 `email_sha256`（去重与"同一人合并"）
 *   与 `email_cipher`（云侧服务密钥加的密文）——想存明文也没地方存（同 49 M6 的
 *   `metering_events` 只有八列那一条）。
 * - `kol_plugin_tokens`：**没有明文令牌这一列**，只有 `sha256`；撤销是 `revoked_at`
 *   一列，不是删行（18 §1）。
 *
 * `kol_observations` 里也没有正文：列就是 `PUBLIC_OBSERVATION_FIELDS` 那几个
 * 加上"谁报的、什么时候报的、算不算奖励"。
 */
import type {
  Benchmark,
  Dispute,
  FollowersBand,
  Iso8601,
  KolChannel,
  KolObservationSource,
  PluginPairing,
  PublicCreatorCard,
  PublicCreatorContact,
  PublicCreatorObservation,
  WorkspaceId,
} from '@agentsws/contracts'

/** 库里的一行红人卡（形状就是对外那张卡——这一层没有第二份字段表）。 */
export type CreatorRow = PublicCreatorCard

/** 库里的一条观察。 */
export interface ObservationRow extends PublicCreatorObservation {
  id: string
  /** 谁报的（`plg:…` / `ws:…`）。**不进任何对外响应**。 */
  subject: string
  source: KolObservationSource
  /** 落库时刻（与 `observed_at` 分开：一条昨天看到的资料可以今天才报上来）。 */
  at: Iso8601
  followers_band: FollowersBand
  /** 这一条算不算贡献奖励（24h 内重复的那些不算）。 */
  counted: boolean
}

export type ContactRow = PublicCreatorContact

export type DisputeRow = Dispute

/** 日配额与日奖励（插件、工作区、以及外部源的配额池共用这一张）。 */
export interface QuotaRow {
  /** `plg:…` / `ws:…` / `source:youtube`。 */
  subject: string
  /** `YYYY-MM-DD`（UTC）。 */
  day: string
  /** 今天收了多少条观察。 */
  observations: number
  /** 今天发了多少奖励积分。 */
  reward_credits: number
  /** 今天用掉多少外部配额单位（只有 `source:*` 那几行用得上）。 */
  units: number
}

export interface CreatorFilter {
  channel?: KolChannel | undefined
  q?: string | undefined
  min_followers?: number | undefined
  category?: string | undefined
  limit: number
}

export interface BucketFilter {
  channel: KolChannel
  followers_band: FollowersBand
  /** `any` = 不按类目筛（基准只按渠道 + 量级）。 */
  category: string
}

export interface KolStore {
  creator(channel: KolChannel, handle: string): CreatorRow | undefined
  listCreators(filter: CreatorFilter): CreatorRow[]
  putCreator(row: CreatorRow): void

  appendObservation(row: ObservationRow): void
  observationsOf(channel: KolChannel, handle: string): ObservationRow[]
  /** 这个贡献者最近一次报这个 handle 是什么时候（24h 去重用）。 */
  lastObservationAt(subject: string, channel: KolChannel, handle: string): Iso8601 | undefined
  /** 一个基准桶里的观察（k-匿名要数它）。 */
  observationsInBucket(filter: BucketFilter): ObservationRow[]

  contactOf(channel: KolChannel, handle: string): ContactRow | undefined
  contactBySha(channel: KolChannel, handle: string, email_sha256: string): ContactRow | undefined
  putContact(row: ContactRow): void

  putDispute(row: DisputeRow): void
  disputesOf(channel: KolChannel, handle: string): DisputeRow[]

  pairingBySha(sha256: string): PluginPairing | undefined
  putPairing(row: PluginPairing): void

  quota(subject: string, day: string): QuotaRow
  putQuota(row: QuotaRow): void

  cachedBenchmark(filter: BucketFilter): Benchmark | undefined
  putBenchmark(row: Benchmark): void

  close?(): void
}

/** 基准缓存多久算新鲜。 */
export const BENCHMARK_CACHE_MS = 60 * 60 * 1000

const keyOf = (channel: string, handle: string): string => `${channel}/${handle}`
const bucketKeyOf = (f: BucketFilter): string => `${f.channel}/${f.followers_band}/${f.category}`

/** 浏览的排序：粉丝多的在前，同粉丝数按 handle（结果稳定，翻页不会乱跳）。 */
function byFollowers(a: CreatorRow, b: CreatorRow): number {
  if (a.followers !== b.followers) return b.followers - a.followers
  return a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : 0
}

function matches(row: CreatorRow, filter: CreatorFilter): boolean {
  if (filter.channel !== undefined && row.channel !== filter.channel) return false
  if (filter.min_followers !== undefined && row.followers < filter.min_followers) return false
  if (filter.category !== undefined && !row.categories.includes(filter.category.toLowerCase()))
    return false
  if (filter.q !== undefined && filter.q !== '') {
    const q = filter.q.toLowerCase()
    const hay = `${row.handle} ${row.categories.join(' ')}`.toLowerCase()
    if (!hay.includes(q)) return false
  }
  return true
}

export class MemoryKolStore implements KolStore {
  private readonly creators = new Map<string, CreatorRow>()
  private readonly obs: ObservationRow[] = []
  private readonly contacts = new Map<string, ContactRow>()
  private readonly disputes: DisputeRow[] = []
  private readonly pairings = new Map<string, PluginPairing>()
  private readonly quotas = new Map<string, QuotaRow>()
  private readonly benchmarks = new Map<string, Benchmark>()

  creator(channel: KolChannel, handle: string): CreatorRow | undefined {
    const row = this.creators.get(keyOf(channel, handle))
    return row === undefined ? undefined : { ...row, categories: [...row.categories] }
  }

  listCreators(filter: CreatorFilter): CreatorRow[] {
    return [...this.creators.values()]
      .filter((r) => matches(r, filter))
      .sort(byFollowers)
      .slice(0, filter.limit)
      .map((r) => ({ ...r, categories: [...r.categories] }))
  }

  putCreator(row: CreatorRow): void {
    this.creators.set(keyOf(row.channel, row.handle), { ...row, categories: [...row.categories] })
  }

  appendObservation(row: ObservationRow): void {
    this.obs.push({
      ...row,
      ...(row.categories === undefined ? {} : { categories: [...row.categories] }),
    })
  }

  observationsOf(channel: KolChannel, handle: string): ObservationRow[] {
    return this.obs
      .filter((o) => o.channel === channel && o.handle === handle)
      .map((o) => ({ ...o }))
  }

  lastObservationAt(subject: string, channel: KolChannel, handle: string): Iso8601 | undefined {
    let last: Iso8601 | undefined
    for (const o of this.obs) {
      if (o.subject !== subject || o.channel !== channel || o.handle !== handle) continue
      if (last === undefined || o.at > last) last = o.at
    }
    return last
  }

  observationsInBucket(filter: BucketFilter): ObservationRow[] {
    return this.obs
      .filter(
        (o) =>
          o.channel === filter.channel &&
          o.followers_band === filter.followers_band &&
          (filter.category === 'any' || (o.categories ?? []).includes(filter.category)),
      )
      .map((o) => ({ ...o }))
  }

  contactOf(channel: KolChannel, handle: string): ContactRow | undefined {
    let best: ContactRow | undefined
    for (const c of this.contacts.values()) {
      if (c.channel !== channel || c.handle !== handle) continue
      if (best === undefined || c.at > best.at) best = c
    }
    return best === undefined ? undefined : { ...best }
  }

  contactBySha(channel: KolChannel, handle: string, email_sha256: string): ContactRow | undefined {
    const row = this.contacts.get(`${keyOf(channel, handle)}/${email_sha256}`)
    return row === undefined ? undefined : { ...row }
  }

  putContact(row: ContactRow): void {
    this.contacts.set(`${keyOf(row.channel, row.handle)}/${row.email_sha256}`, { ...row })
  }

  putDispute(row: DisputeRow): void {
    this.disputes.push({ ...row })
  }

  disputesOf(channel: KolChannel, handle: string): DisputeRow[] {
    return this.disputes
      .filter((d) => d.channel === channel && d.handle === handle)
      .map((d) => ({
        ...d,
      }))
  }

  pairingBySha(sha256: string): PluginPairing | undefined {
    const row = this.pairings.get(sha256)
    return row === undefined ? undefined : { ...row }
  }

  putPairing(row: PluginPairing): void {
    this.pairings.set(row.token_sha256, { ...row })
  }

  quota(subject: string, day: string): QuotaRow {
    return (
      this.quotas.get(`${subject}/${day}`) ?? {
        subject,
        day,
        observations: 0,
        reward_credits: 0,
        units: 0,
      }
    )
  }

  putQuota(row: QuotaRow): void {
    this.quotas.set(`${row.subject}/${row.day}`, { ...row })
  }

  cachedBenchmark(filter: BucketFilter): Benchmark | undefined {
    const row = this.benchmarks.get(bucketKeyOf(filter))
    return row === undefined ? undefined : { ...row }
  }

  putBenchmark(row: Benchmark): void {
    this.benchmarks.set(
      bucketKeyOf({
        channel: row.channel,
        followers_band: row.followers_band,
        category: row.category,
      }),
      { ...row },
    )
  }
}

/** better-sqlite3 的那一点点面（不把整个类型拖进这个包）。 */
export interface SqliteLike {
  exec(sql: string): unknown
  prepare(sql: string): {
    run(...args: unknown[]): unknown
    get(...args: unknown[]): unknown
    all(...args: unknown[]): unknown[]
  }
  close(): void
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kol_creators (
  channel         TEXT NOT NULL,
  handle          TEXT NOT NULL,
  followers       INTEGER NOT NULL,
  posts_30d       INTEGER NOT NULL,
  engagement_rate REAL NOT NULL,
  language        TEXT,
  region          TEXT,
  categories      TEXT NOT NULL DEFAULT '[]',
  observed_at     TEXT NOT NULL,
  source          TEXT NOT NULL,
  observations    INTEGER NOT NULL DEFAULT 0,
  confidence      REAL NOT NULL DEFAULT 0,
  has_contact     INTEGER NOT NULL DEFAULT 0,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (channel, handle)
);
CREATE INDEX IF NOT EXISTS kol_creators_by_followers ON kol_creators(channel, followers DESC);

-- 观察：列就是字段白名单那几个 + 谁报的。**没有正文列**。
CREATE TABLE IF NOT EXISTS kol_observations (
  id              TEXT PRIMARY KEY,
  channel         TEXT NOT NULL,
  handle          TEXT NOT NULL,
  subject         TEXT NOT NULL,
  source          TEXT NOT NULL,
  followers       INTEGER NOT NULL,
  posts_30d       INTEGER NOT NULL,
  engagement_rate REAL NOT NULL,
  language        TEXT,
  region          TEXT,
  categories      TEXT NOT NULL DEFAULT '[]',
  followers_band  TEXT NOT NULL,
  observed_at     TEXT NOT NULL,
  at              TEXT NOT NULL,
  counted         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS kol_observations_by_creator ON kol_observations(channel, handle, at);
CREATE INDEX IF NOT EXISTS kol_observations_by_subject ON kol_observations(subject, channel, handle, at);
CREATE INDEX IF NOT EXISTS kol_observations_by_bucket ON kol_observations(channel, followers_band);

-- 联系方式：**只有哈希与密文**，没有明文那一列。
CREATE TABLE IF NOT EXISTS kol_contacts (
  channel         TEXT NOT NULL,
  handle          TEXT NOT NULL,
  email_sha256    TEXT NOT NULL,
  email_cipher    TEXT NOT NULL,
  source          TEXT NOT NULL,
  contributed_by  TEXT NOT NULL,
  at              TEXT NOT NULL,
  PRIMARY KEY (channel, handle, email_sha256)
);

CREATE TABLE IF NOT EXISTS kol_disputes (
  id          TEXT PRIMARY KEY,
  channel     TEXT NOT NULL,
  handle      TEXT NOT NULL,
  field       TEXT NOT NULL,
  claim       TEXT NOT NULL,
  reported_by TEXT NOT NULL,
  org_id      TEXT NOT NULL,
  status      TEXT NOT NULL,
  at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS kol_disputes_by_creator ON kol_disputes(channel, handle);

-- 插件令牌：**只有 sha256**；撤销是一列不是删行。
CREATE TABLE IF NOT EXISTS kol_plugin_tokens (
  token_sha256       TEXT PRIMARY KEY,
  id                 TEXT NOT NULL,
  workspace_id       TEXT NOT NULL,
  org_id             TEXT NOT NULL,
  account_id         TEXT NOT NULL,
  label              TEXT NOT NULL,
  issued_at          TEXT NOT NULL,
  expires_at         TEXT NOT NULL,
  revoked_at         TEXT,
  valid_observations INTEGER NOT NULL DEFAULT 0,
  granted_credits    REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS kol_plugin_tokens_by_ws ON kol_plugin_tokens(workspace_id);

CREATE TABLE IF NOT EXISTS kol_plugin_quota (
  subject        TEXT NOT NULL,
  day            TEXT NOT NULL,
  observations   INTEGER NOT NULL DEFAULT 0,
  reward_credits REAL NOT NULL DEFAULT 0,
  units          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (subject, day)
);

CREATE TABLE IF NOT EXISTS kol_benchmarks_cache (
  channel            TEXT NOT NULL,
  category           TEXT NOT NULL,
  followers_band     TEXT NOT NULL,
  sample_size        INTEGER NOT NULL,
  insufficient       INTEGER NOT NULL,
  engagement_p25     REAL,
  engagement_p50     REAL,
  engagement_p75     REAL,
  followers_p25      REAL,
  followers_p50      REAL,
  followers_p75      REAL,
  computed_at        TEXT NOT NULL,
  PRIMARY KEY (channel, category, followers_band)
);
`

interface CreatorSqlRow {
  channel: string
  handle: string
  followers: number
  posts_30d: number
  engagement_rate: number
  language: string | null
  region: string | null
  categories: string
  observed_at: string
  source: string
  observations: number
  confidence: number
  has_contact: number
  updated_at: string
}

interface ObservationSqlRow {
  id: string
  channel: string
  handle: string
  subject: string
  source: string
  followers: number
  posts_30d: number
  engagement_rate: number
  language: string | null
  region: string | null
  categories: string
  followers_band: string
  observed_at: string
  at: string
  counted: number
}

interface ContactSqlRow {
  channel: string
  handle: string
  email_sha256: string
  email_cipher: string
  source: string
  contributed_by: string
  at: string
}

interface DisputeSqlRow {
  id: string
  channel: string
  handle: string
  field: string
  claim: string
  reported_by: string
  org_id: string
  status: string
  at: string
}

interface PairingSqlRow {
  token_sha256: string
  id: string
  workspace_id: string
  org_id: string
  account_id: string
  label: string
  issued_at: string
  expires_at: string
  revoked_at: string | null
  valid_observations: number
  granted_credits: number
}

interface QuotaSqlRow {
  subject: string
  day: string
  observations: number
  reward_credits: number
  units: number
}

interface BenchmarkSqlRow {
  channel: string
  category: string
  followers_band: string
  sample_size: number
  insufficient: number
  engagement_p25: number | null
  engagement_p50: number | null
  engagement_p75: number | null
  followers_p25: number | null
  followers_p50: number | null
  followers_p75: number | null
  computed_at: string
}

const parseCategories = (raw: string): string[] => {
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function toCreator(row: CreatorSqlRow): CreatorRow {
  return {
    channel: row.channel as KolChannel,
    handle: row.handle,
    followers: row.followers,
    posts_30d: row.posts_30d,
    engagement_rate: row.engagement_rate,
    ...(row.language === null ? {} : { language: row.language }),
    ...(row.region === null ? {} : { region: row.region }),
    categories: parseCategories(row.categories),
    observed_at: row.observed_at,
    source: row.source as KolObservationSource,
    observations: row.observations,
    confidence: row.confidence,
    has_contact: row.has_contact === 1,
    updated_at: row.updated_at,
  }
}

function toObservation(row: ObservationSqlRow): ObservationRow {
  return {
    id: row.id,
    channel: row.channel as KolChannel,
    handle: row.handle,
    subject: row.subject,
    source: row.source as KolObservationSource,
    followers: row.followers,
    posts_30d: row.posts_30d,
    engagement_rate: row.engagement_rate,
    ...(row.language === null ? {} : { language: row.language }),
    ...(row.region === null ? {} : { region: row.region }),
    categories: parseCategories(row.categories),
    followers_band: row.followers_band as FollowersBand,
    observed_at: row.observed_at,
    at: row.at,
    counted: row.counted === 1,
  }
}

function toBenchmark(row: BenchmarkSqlRow): Benchmark {
  const trio = (
    p25: number | null,
    p50: number | null,
    p75: number | null,
  ): { p25: number; p50: number; p75: number } | undefined =>
    p25 === null || p50 === null || p75 === null ? undefined : { p25, p50, p75 }
  const engagement = trio(row.engagement_p25, row.engagement_p50, row.engagement_p75)
  const followers = trio(row.followers_p25, row.followers_p50, row.followers_p75)
  return {
    channel: row.channel as KolChannel,
    category: row.category,
    followers_band: row.followers_band as FollowersBand,
    sample_size: row.sample_size,
    insufficient_samples: row.insufficient === 1,
    ...(engagement === undefined ? {} : { engagement_rate: engagement }),
    ...(followers === undefined ? {} : { followers }),
    computed_at: row.computed_at,
  }
}

export class SqliteKolStore implements KolStore {
  private readonly db: SqliteLike

  constructor(db: SqliteLike) {
    this.db = db
    this.db.exec(SCHEMA)
  }

  creator(channel: KolChannel, handle: string): CreatorRow | undefined {
    const row = this.db
      .prepare('SELECT * FROM kol_creators WHERE channel = ? AND handle = ?')
      .get(channel, handle) as CreatorSqlRow | undefined
    return row === undefined ? undefined : toCreator(row)
  }

  listCreators(filter: CreatorFilter): CreatorRow[] {
    const where: string[] = []
    const args: unknown[] = []
    if (filter.channel !== undefined) {
      where.push('channel = ?')
      args.push(filter.channel)
    }
    if (filter.min_followers !== undefined) {
      where.push('followers >= ?')
      args.push(filter.min_followers)
    }
    if (filter.q !== undefined && filter.q !== '') {
      where.push('(lower(handle) LIKE ? OR lower(categories) LIKE ?)')
      const like = `%${filter.q.toLowerCase()}%`
      args.push(like, like)
    }
    if (filter.category !== undefined) {
      where.push('lower(categories) LIKE ?')
      args.push(`%"${filter.category.toLowerCase()}"%`)
    }
    const sql = `SELECT * FROM kol_creators${
      where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`
    } ORDER BY followers DESC, handle ASC LIMIT ?`
    const rows = this.db.prepare(sql).all(...args, filter.limit) as CreatorSqlRow[]
    return rows.map(toCreator)
  }

  putCreator(row: CreatorRow): void {
    this.db
      .prepare(
        `INSERT INTO kol_creators
           (channel, handle, followers, posts_30d, engagement_rate, language, region, categories,
            observed_at, source, observations, confidence, has_contact, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(channel, handle) DO UPDATE SET
           followers = excluded.followers,
           posts_30d = excluded.posts_30d,
           engagement_rate = excluded.engagement_rate,
           language = excluded.language,
           region = excluded.region,
           categories = excluded.categories,
           observed_at = excluded.observed_at,
           source = excluded.source,
           observations = excluded.observations,
           confidence = excluded.confidence,
           has_contact = excluded.has_contact,
           updated_at = excluded.updated_at`,
      )
      .run(
        row.channel,
        row.handle,
        row.followers,
        row.posts_30d,
        row.engagement_rate,
        row.language ?? null,
        row.region ?? null,
        JSON.stringify(row.categories),
        row.observed_at,
        row.source,
        row.observations,
        row.confidence,
        row.has_contact ? 1 : 0,
        row.updated_at,
      )
  }

  appendObservation(row: ObservationRow): void {
    this.db
      .prepare(
        `INSERT INTO kol_observations
           (id, channel, handle, subject, source, followers, posts_30d, engagement_rate,
            language, region, categories, followers_band, observed_at, at, counted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.channel,
        row.handle,
        row.subject,
        row.source,
        row.followers,
        row.posts_30d,
        row.engagement_rate,
        row.language ?? null,
        row.region ?? null,
        JSON.stringify(row.categories ?? []),
        row.followers_band,
        row.observed_at,
        row.at,
        row.counted ? 1 : 0,
      )
  }

  observationsOf(channel: KolChannel, handle: string): ObservationRow[] {
    const rows = this.db
      .prepare('SELECT * FROM kol_observations WHERE channel = ? AND handle = ? ORDER BY at ASC')
      .all(channel, handle) as ObservationSqlRow[]
    return rows.map(toObservation)
  }

  lastObservationAt(subject: string, channel: KolChannel, handle: string): Iso8601 | undefined {
    const row = this.db
      .prepare(
        'SELECT max(at) AS at FROM kol_observations WHERE subject = ? AND channel = ? AND handle = ?',
      )
      .get(subject, channel, handle) as { at: string | null } | undefined
    return row?.at ?? undefined
  }

  observationsInBucket(filter: BucketFilter): ObservationRow[] {
    const rows =
      filter.category === 'any'
        ? (this.db
            .prepare('SELECT * FROM kol_observations WHERE channel = ? AND followers_band = ?')
            .all(filter.channel, filter.followers_band) as ObservationSqlRow[])
        : (this.db
            .prepare(
              'SELECT * FROM kol_observations WHERE channel = ? AND followers_band = ? AND lower(categories) LIKE ?',
            )
            .all(
              filter.channel,
              filter.followers_band,
              `%"${filter.category.toLowerCase()}"%`,
            ) as ObservationSqlRow[])
    return rows.map(toObservation)
  }

  contactOf(channel: KolChannel, handle: string): ContactRow | undefined {
    const row = this.db
      .prepare(
        'SELECT * FROM kol_contacts WHERE channel = ? AND handle = ? ORDER BY at DESC LIMIT 1',
      )
      .get(channel, handle) as ContactSqlRow | undefined
    return row === undefined
      ? undefined
      : { ...row, channel: row.channel as KolChannel, source: row.source as KolObservationSource }
  }

  contactBySha(channel: KolChannel, handle: string, email_sha256: string): ContactRow | undefined {
    const row = this.db
      .prepare('SELECT * FROM kol_contacts WHERE channel = ? AND handle = ? AND email_sha256 = ?')
      .get(channel, handle, email_sha256) as ContactSqlRow | undefined
    return row === undefined
      ? undefined
      : { ...row, channel: row.channel as KolChannel, source: row.source as KolObservationSource }
  }

  putContact(row: ContactRow): void {
    this.db
      .prepare(
        `INSERT INTO kol_contacts (channel, handle, email_sha256, email_cipher, source, contributed_by, at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(channel, handle, email_sha256) DO UPDATE SET
           email_cipher = excluded.email_cipher, source = excluded.source, at = excluded.at`,
      )
      .run(
        row.channel,
        row.handle,
        row.email_sha256,
        row.email_cipher,
        row.source,
        row.contributed_by,
        row.at,
      )
  }

  putDispute(row: DisputeRow): void {
    this.db
      .prepare(
        `INSERT INTO kol_disputes (id, channel, handle, field, claim, reported_by, org_id, status, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.channel,
        row.handle,
        row.field,
        row.claim,
        row.reported_by,
        row.org_id,
        row.status,
        row.at,
      )
  }

  disputesOf(channel: KolChannel, handle: string): DisputeRow[] {
    const rows = this.db
      .prepare('SELECT * FROM kol_disputes WHERE channel = ? AND handle = ? ORDER BY at ASC')
      .all(channel, handle) as DisputeSqlRow[]
    return rows.map((row) => ({
      ...row,
      channel: row.channel as KolChannel,
      reported_by: row.reported_by as WorkspaceId,
      status: 'open' as const,
    }))
  }

  pairingBySha(sha256: string): PluginPairing | undefined {
    const row = this.db
      .prepare('SELECT * FROM kol_plugin_tokens WHERE token_sha256 = ?')
      .get(sha256) as PairingSqlRow | undefined
    if (row === undefined) return undefined
    return {
      id: row.id,
      workspace_id: row.workspace_id,
      org_id: row.org_id,
      account_id: row.account_id,
      label: row.label,
      token_sha256: row.token_sha256,
      issued_at: row.issued_at,
      expires_at: row.expires_at,
      ...(row.revoked_at === null ? {} : { revoked_at: row.revoked_at }),
      valid_observations: row.valid_observations,
      granted_credits: row.granted_credits,
    }
  }

  putPairing(row: PluginPairing): void {
    this.db
      .prepare(
        `INSERT INTO kol_plugin_tokens
           (token_sha256, id, workspace_id, org_id, account_id, label, issued_at, expires_at,
            revoked_at, valid_observations, granted_credits)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(token_sha256) DO UPDATE SET
           revoked_at = excluded.revoked_at,
           valid_observations = excluded.valid_observations,
           granted_credits = excluded.granted_credits`,
      )
      .run(
        row.token_sha256,
        row.id,
        row.workspace_id,
        row.org_id,
        row.account_id,
        row.label,
        row.issued_at,
        row.expires_at,
        row.revoked_at ?? null,
        row.valid_observations,
        row.granted_credits,
      )
  }

  quota(subject: string, day: string): QuotaRow {
    const row = this.db
      .prepare('SELECT * FROM kol_plugin_quota WHERE subject = ? AND day = ?')
      .get(subject, day) as QuotaSqlRow | undefined
    return row ?? { subject, day, observations: 0, reward_credits: 0, units: 0 }
  }

  putQuota(row: QuotaRow): void {
    this.db
      .prepare(
        `INSERT INTO kol_plugin_quota (subject, day, observations, reward_credits, units)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(subject, day) DO UPDATE SET
           observations = excluded.observations,
           reward_credits = excluded.reward_credits,
           units = excluded.units`,
      )
      .run(row.subject, row.day, row.observations, row.reward_credits, row.units)
  }

  cachedBenchmark(filter: BucketFilter): Benchmark | undefined {
    const row = this.db
      .prepare(
        'SELECT * FROM kol_benchmarks_cache WHERE channel = ? AND category = ? AND followers_band = ?',
      )
      .get(filter.channel, filter.category, filter.followers_band) as BenchmarkSqlRow | undefined
    return row === undefined ? undefined : toBenchmark(row)
  }

  putBenchmark(row: Benchmark): void {
    this.db
      .prepare(
        `INSERT INTO kol_benchmarks_cache
           (channel, category, followers_band, sample_size, insufficient,
            engagement_p25, engagement_p50, engagement_p75,
            followers_p25, followers_p50, followers_p75, computed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(channel, category, followers_band) DO UPDATE SET
           sample_size = excluded.sample_size,
           insufficient = excluded.insufficient,
           engagement_p25 = excluded.engagement_p25,
           engagement_p50 = excluded.engagement_p50,
           engagement_p75 = excluded.engagement_p75,
           followers_p25 = excluded.followers_p25,
           followers_p50 = excluded.followers_p50,
           followers_p75 = excluded.followers_p75,
           computed_at = excluded.computed_at`,
      )
      .run(
        row.channel,
        row.category,
        row.followers_band,
        row.sample_size,
        row.insufficient_samples ? 1 : 0,
        row.engagement_rate?.p25 ?? null,
        row.engagement_rate?.p50 ?? null,
        row.engagement_rate?.p75 ?? null,
        row.followers?.p25 ?? null,
        row.followers?.p50 ?? null,
        row.followers?.p75 ?? null,
        row.computed_at,
      )
  }

  close(): void {
    this.db.close()
  }
}
