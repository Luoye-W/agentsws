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
  KolLibraryStats,
  KolObservationSource,
  PluginPairing,
  PublicContentSample,
  PublicCreatorCard,
  PublicCreatorContact,
  PublicCreatorMetricSnapshot,
  PublicCreatorObservation,
  PublicPerson,
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

  /**
   * 搜索幂等窗口（WP126 口径①：一次提交的搜索算一次）。
   *
   * 键是 `(subject, 规范化查询)` 的哈希，值是**上一次真收钱那一刻**。
   * 窗口之内（10 分钟）翻页 / 重排不再扣第二次。没有记录回 `undefined`。
   */
  searchChargeAt(key: string): Iso8601 | undefined
  putSearchCharge(key: string, at: Iso8601): void

  cachedBenchmark(filter: BucketFilter): Benchmark | undefined
  putBenchmark(row: Benchmark): void

  /**
   * 扔掉比 `olderThan` 还老的基准缓存行（WP110 的进程内定时调它）。返回删掉的条数。
   *
   * **可选成员**：读的时候本来就按 {@link BENCHMARK_CACHE_MS} 判新鲜，不清也不会
   * 读到过期数据——这一条只是不让一年前的桶永远占着行。老实现没有它，宿主跳过就是了。
   */
  sweepBenchmarks?(olderThan: string): number

  close?(): void
}

/** 卡上那几格"搬来的事实"（{@link KolLibraryStore.putCreatorExtra} 的入参）。 */
export interface CreatorExtraRow {
  channel: KolChannel
  handle: string
  external_id?: string | undefined
  name?: string | undefined
  avatar_url?: string | undefined
  country?: string | undefined
  person_id?: string | undefined
  extra?: Record<string, string | number | boolean> | undefined
  imported_from?: string | undefined
}

/** 一条内容在某一刻的数（{@link KolLibraryStore.putContentMetric} 的入参）。 */
export interface ContentMetricRow {
  channel: KolChannel
  handle: string
  content_external_id: string
  views?: number | undefined
  likes?: number | undefined
  comments?: number | undefined
  shares?: number | undefined
  observed_at: Iso8601
  source: KolObservationSource
  at: Iso8601
}

export interface OptOutRow {
  channel: KolChannel
  handle: string
  reason: string
  /** 谁按的（后台账号 id）。 */
  removed_by: string
  at: Iso8601
}

export interface CreatorSearchFilter {
  q?: string | undefined
  channel?: KolChannel | undefined
  /** 只看有联系方式的 / 只看没有的。 */
  has_contact?: boolean | undefined
  /** 只看从别处搬来的那些。 */
  imported_only?: boolean | undefined
  limit: number
  offset: number
}

/**
 * 搬家与运营后台要的那一组（WP116）。
 *
 * **它是 {@link KolStore} 的可选伴生口，不是 `KolStore` 的一部分**——内存档
 * （测试、`bin/dev.mjs`）没有它。理由：这一组里每一个方法都在做聚合或跨表连接，
 * 在内存里再实现一遍等于把同一段逻辑写两次，而它们**只在落盘的库上被用到**
 * （搬家、后台）。不实现就明说不实现（路由回 501），比给一个行为略有差别的
 * 第二份实现诚实。
 *
 * 用 {@link isLibraryStore} 判。
 */
export interface KolLibraryStore {
  putCreatorExtra(row: CreatorExtraRow): void
  putPerson(row: PublicPerson): void
  person(id: string): PublicPerson | undefined
  putContent(row: PublicContentSample): void
  content(channel: KolChannel, external_id: string): PublicContentSample | undefined
  contentsOf(channel: KolChannel, handle: string, limit: number): PublicContentSample[]
  putContentMetric(row: ContentMetricRow): void
  putMetricSnapshot(row: PublicCreatorMetricSnapshot): void
  metricsOf(
    channel: KolChannel,
    handle: string,
    limit: number,
  ): (PublicCreatorMetricSnapshot & { at: Iso8601 })[]
  /** 这个人要求过被移除吗（搬家与上报都要先问一句）。 */
  optedOut(channel: KolChannel, handle: string): boolean
  putOptOut(row: OptOutRow): void
  /** 把这个人的全部行删掉（卡 / 观察 / 联系方式 / 内容 / 指标）。回删掉几行。 */
  purgeCreator(channel: KolChannel, handle: string): number
  /** 后台那一页的几个数。`at` 是"现在"，用来算近 7 / 30 天。 */
  libraryStats(at: Iso8601): KolLibraryStats
  searchCreators(filter: CreatorSearchFilter): { rows: CreatorRow[]; total: number }
}

/** 这个库带不带搬家与后台那一组。 */
export function isLibraryStore(store: KolStore): store is KolStore & KolLibraryStore {
  return typeof (store as Partial<KolLibraryStore>).libraryStats === 'function'
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
  private readonly searchCharges = new Map<string, Iso8601>()

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

  searchChargeAt(key: string): Iso8601 | undefined {
    return this.searchCharges.get(key)
  }

  putSearchCharge(key: string, at: Iso8601): void {
    this.searchCharges.set(key, at)
  }

  cachedBenchmark(filter: BucketFilter): Benchmark | undefined {
    const row = this.benchmarks.get(bucketKeyOf(filter))
    return row === undefined ? undefined : { ...row }
  }

  sweepBenchmarks(olderThan: string): number {
    const cutoff = Date.parse(olderThan)
    let removed = 0
    for (const [key, row] of this.benchmarks)
      if (Date.parse(row.computed_at) <= cutoff) {
        this.benchmarks.delete(key)
        removed += 1
      }
    return removed
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

-- WP126 口径①：搜索幂等窗口。键 = sha256(subject + 规范化查询)，值 = 上次真收钱那一刻
CREATE TABLE IF NOT EXISTS kol_search_window (
  key TEXT PRIMARY KEY,
  at  TEXT NOT NULL
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

/**
 * WP116 搬家那一批表（48 §5.3 / 64 §10.2）。
 *
 * **全是新表，一条 `ALTER TABLE` 都没有**。理由有两条，都不是洁癖：
 *
 * 1. 官方托管形态下迁移在 Durable Object **第一次唤醒**时同步跑完，而新旧对象会在
 *    同一时刻分别存在（docs/64 §5）。`CREATE TABLE IF NOT EXISTS` 重跑一百次是安全的，
 *    `ALTER TABLE ADD COLUMN` 第二次就报错；
 * 2. 红人卡上那几格（原生 id / 名称 / 头像 / 分组）**不是每一行都有**——本系统自己
 *    攒的行一格都不填。它们住在一张 1:1 的旁表里，读的时候 LEFT JOIN，
 *    比在主表上加六个常年为 NULL 的列更诚实。
 */
const SCHEMA_IMPORT = `
-- 红人卡上那几格"从别处搬来的事实" + 第一次见到这个人的时刻。
-- first_seen_at 对**每一行**都写（不只是搬来的）：后台那页要数"近 7 / 30 天新增"，
-- 而主表上只有 updated_at（每报一条观察就变），用它当"新增"会把老人算成新人。
CREATE TABLE IF NOT EXISTS kol_creator_extra (
  channel       TEXT NOT NULL,
  handle        TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  external_id   TEXT,
  name          TEXT,
  avatar_url    TEXT,
  country       TEXT,
  person_id     TEXT,
  extra         TEXT NOT NULL DEFAULT '{}',
  imported_from TEXT,
  PRIMARY KEY (channel, handle)
);
CREATE INDEX IF NOT EXISTS kol_creator_extra_external  ON kol_creator_extra(channel, external_id);
CREATE INDEX IF NOT EXISTS kol_creator_extra_person    ON kol_creator_extra(person_id);
CREATE INDEX IF NOT EXISTS kol_creator_extra_first     ON kol_creator_extra(first_seen_at);
CREATE INDEX IF NOT EXISTS kol_creator_extra_imported  ON kol_creator_extra(imported_from);

-- 同一个人在多个渠道的分组。**只分组，不下结论**（48 §5.1 渠道之间零共享）。
CREATE TABLE IF NOT EXISTS kol_persons (
  id           TEXT PRIMARY KEY,
  display_name TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- 内容样本：创作者自己公开发布的元数据。**没有评论、没有文案、没有字幕。**
CREATE TABLE IF NOT EXISTS kol_contents (
  channel          TEXT NOT NULL,
  handle           TEXT NOT NULL,
  external_id      TEXT NOT NULL,
  content_type     TEXT NOT NULL DEFAULT 'video',
  title            TEXT,
  url              TEXT,
  thumbnail_url    TEXT,
  tags             TEXT NOT NULL DEFAULT '[]',
  orientation      TEXT,
  duration_seconds INTEGER,
  published_at     TEXT,
  views            INTEGER,
  likes            INTEGER,
  comments         INTEGER,
  shares           INTEGER,
  observed_at      TEXT NOT NULL,
  source           TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (channel, external_id)
);
CREATE INDEX IF NOT EXISTS kol_contents_by_creator ON kol_contents(channel, handle, published_at);

-- 一条内容在某一刻的播放 / 点赞数。主键是 (渠道, 内容, 观察时刻)——
-- 同一刻重复报是同一条，重跑搬家不会翻倍。
CREATE TABLE IF NOT EXISTS kol_content_metrics (
  channel             TEXT NOT NULL,
  content_external_id TEXT NOT NULL,
  handle              TEXT NOT NULL,
  views               INTEGER,
  likes               INTEGER,
  comments            INTEGER,
  shares              INTEGER,
  observed_at         TEXT NOT NULL,
  source              TEXT NOT NULL,
  at                  TEXT NOT NULL,
  PRIMARY KEY (channel, content_external_id, observed_at)
);

-- 账号级指标快照。**与 kol_observations 刻意分开**：观察要带 posts_30d 与
-- engagement_rate，而搬进来的那一批没有这两个数；填 0 会让 k-匿名基准的中位
-- 互动率变成 0，那是一个编出来的数（21 §4）。
CREATE TABLE IF NOT EXISTS kol_metric_snapshots (
  channel     TEXT NOT NULL,
  handle      TEXT NOT NULL,
  followers   INTEGER,
  avg_views   INTEGER,
  video_count INTEGER,
  total_views INTEGER,
  observed_at TEXT NOT NULL,
  source      TEXT NOT NULL,
  at          TEXT NOT NULL,
  PRIMARY KEY (channel, handle, observed_at)
);

-- 联系方式的来源与置信度。旁表，同样不 ALTER 主表。
-- **这里没有明文邮箱**：主键的第三段是哈希，与 kol_contacts 对得上。
-- source_url 是合规上最要紧的一格——"这个邮箱你从哪儿看到的"是任何一次
-- 移除请求的第一个问题。
CREATE TABLE IF NOT EXISTS kol_contact_extra (
  channel       TEXT NOT NULL,
  handle        TEXT NOT NULL,
  email_sha256  TEXT NOT NULL,
  source_url    TEXT,
  source_detail TEXT,
  confidence    REAL,
  confirmations INTEGER,
  disputes      INTEGER,
  PRIMARY KEY (channel, handle, email_sha256)
);

-- opt-out 墓碑。**删行不够**：不留墓碑的话下一趟搬家会把人再搬回来，
-- 而"我要求过把我从你们库里拿掉"应该只需要说一次。
CREATE TABLE IF NOT EXISTS kol_optouts (
  channel    TEXT NOT NULL,
  handle     TEXT NOT NULL,
  reason     TEXT NOT NULL,
  removed_by TEXT NOT NULL,
  at         TEXT NOT NULL,
  PRIMARY KEY (channel, handle)
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
  /* ↓ LEFT JOIN kol_creator_extra 带回来的那几格（没有旁表行时全是 null）。 */
  x_external_id?: string | null
  x_name?: string | null
  x_avatar_url?: string | null
  x_country?: string | null
  x_person_id?: string | null
  x_extra?: string | null
  x_imported_from?: string | null
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
  /* ↓ LEFT JOIN kol_contact_extra（没有旁表行时全是 null）。 */
  x_source_url?: string | null
  x_source_detail?: string | null
  x_confidence?: number | null
  x_confirmations?: number | null
  x_disputes?: number | null
}

/** 读联系方式的那一条 SELECT（主表 + 旁表）。与 {@link CREATOR_SELECT} 同一个理由。 */
const CONTACT_SELECT = `SELECT t.*,
         x.source_url    AS x_source_url,
         x.source_detail AS x_source_detail,
         x.confidence    AS x_confidence,
         x.confirmations AS x_confirmations,
         x.disputes      AS x_disputes
    FROM kol_contacts t
    LEFT JOIN kol_contact_extra x
           ON x.channel = t.channel AND x.handle = t.handle AND x.email_sha256 = t.email_sha256`

function toContact(row: ContactSqlRow): ContactRow {
  const out: ContactRow = {
    channel: row.channel as KolChannel,
    handle: row.handle,
    email_sha256: row.email_sha256,
    email_cipher: row.email_cipher,
    source: row.source as KolObservationSource,
    contributed_by: row.contributed_by,
    at: row.at,
  }
  if (row.x_source_url !== null && row.x_source_url !== undefined) out.source_url = row.x_source_url
  if (row.x_source_detail !== null && row.x_source_detail !== undefined)
    out.source_detail = row.x_source_detail
  if (row.x_confidence !== null && row.x_confidence !== undefined) out.confidence = row.x_confidence
  if (row.x_confirmations !== null && row.x_confirmations !== undefined)
    out.confirmations = row.x_confirmations
  if (row.x_disputes !== null && row.x_disputes !== undefined) out.disputes = row.x_disputes
  return out
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
    ...extrasOf(row),
  }
}

/** 旁表那几格 → 卡上那几个可选键（一格都没有时回一个空对象）。 */
function extrasOf(row: CreatorSqlRow): Partial<PublicCreatorCard> {
  const out: Partial<PublicCreatorCard> = {}
  if (row.x_external_id !== null && row.x_external_id !== undefined)
    out.external_id = row.x_external_id
  if (row.x_name !== null && row.x_name !== undefined) out.name = row.x_name
  if (row.x_avatar_url !== null && row.x_avatar_url !== undefined) out.avatar_url = row.x_avatar_url
  if (row.x_country !== null && row.x_country !== undefined) out.country = row.x_country
  if (row.x_person_id !== null && row.x_person_id !== undefined) out.person_id = row.x_person_id
  if (row.x_imported_from !== null && row.x_imported_from !== undefined)
    out.imported_from = row.x_imported_from
  const extra = parseExtra(row.x_extra ?? null)
  if (Object.keys(extra).length > 0) out.extra = extra
  return out
}

/** `extra` 只收标量（见契约上那条注释）：数组 / 对象 / null 一律丢掉。 */
function parseExtra(raw: string | null): Record<string, string | number | boolean> {
  if (raw === null || raw === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  const out: Record<string, string | number | boolean> = {}
  for (const [k, v] of Object.entries(parsed))
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v
  return out
}

/**
 * 读红人卡的那一条 SELECT（主表 + 旁表）。
 *
 * 写成一个常量是因为 `creator()` 与 `listCreators()` 必须回**同一个形状**——
 * 两处各写一遍的话，某一天加一格只改了一处，浏览列表与详情就会不一致。
 */
const CREATOR_SELECT = `SELECT c.*,
         x.external_id   AS x_external_id,
         x.name          AS x_name,
         x.avatar_url    AS x_avatar_url,
         x.country       AS x_country,
         x.person_id     AS x_person_id,
         x.extra         AS x_extra,
         x.imported_from AS x_imported_from
    FROM kol_creators c
    LEFT JOIN kol_creator_extra x ON x.channel = c.channel AND x.handle = c.handle`

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

export class SqliteKolStore implements KolStore, KolLibraryStore {
  private readonly db: SqliteLike

  constructor(db: SqliteLike) {
    this.db = db
    this.db.exec(SCHEMA)
    // WP116 那一批（全是 CREATE … IF NOT EXISTS，重跑安全 —— 见 SCHEMA_IMPORT 头注释）
    this.db.exec(SCHEMA_IMPORT)
  }

  creator(channel: KolChannel, handle: string): CreatorRow | undefined {
    const row = this.db
      .prepare(`${CREATOR_SELECT} WHERE c.channel = ? AND c.handle = ?`)
      .get(channel, handle) as CreatorSqlRow | undefined
    return row === undefined ? undefined : toCreator(row)
  }

  listCreators(filter: CreatorFilter): CreatorRow[] {
    const where: string[] = []
    const args: unknown[] = []
    if (filter.channel !== undefined) {
      where.push('c.channel = ?')
      args.push(filter.channel)
    }
    if (filter.min_followers !== undefined) {
      where.push('c.followers >= ?')
      args.push(filter.min_followers)
    }
    if (filter.q !== undefined && filter.q !== '') {
      // 名称也进搜索：搬进来的那一批很多 handle 是一串原生 id，只搜 handle 等于搜不到
      where.push('(lower(c.handle) LIKE ? OR lower(c.categories) LIKE ? OR lower(x.name) LIKE ?)')
      const like = `%${filter.q.toLowerCase()}%`
      args.push(like, like, like)
    }
    if (filter.category !== undefined) {
      where.push('lower(c.categories) LIKE ?')
      args.push(`%"${filter.category.toLowerCase()}"%`)
    }
    const sql = `${CREATOR_SELECT}${
      where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`
    } ORDER BY c.followers DESC, c.handle ASC LIMIT ?`
    const rows = this.db.prepare(sql).all(...args, filter.limit) as CreatorSqlRow[]
    return rows.map(toCreator)
  }

  putCreator(row: CreatorRow): void {
    // opt-out 是一道**写入闸**，不是一个读取过滤：被移除的人不该被下一条观察带回来
    if (this.optedOut(row.channel, row.handle)) return
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
    /*
     * 第一次见到这个人的时刻。`DO NOTHING` 是要紧的那一半——每报一条观察都会
     * 走到这里，如果它会覆盖，"新增"这个数就永远等于"活跃"。
     */
    this.db
      .prepare(
        `INSERT INTO kol_creator_extra (channel, handle, first_seen_at)
         VALUES (?, ?, ?) ON CONFLICT(channel, handle) DO NOTHING`,
      )
      .run(row.channel, row.handle, row.updated_at)
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
      .prepare(`${CONTACT_SELECT} WHERE t.channel = ? AND t.handle = ? ORDER BY t.at DESC LIMIT 1`)
      .get(channel, handle) as ContactSqlRow | undefined
    return row === undefined ? undefined : toContact(row)
  }

  contactBySha(channel: KolChannel, handle: string, email_sha256: string): ContactRow | undefined {
    const row = this.db
      .prepare(`${CONTACT_SELECT} WHERE t.channel = ? AND t.handle = ? AND t.email_sha256 = ?`)
      .get(channel, handle, email_sha256) as ContactSqlRow | undefined
    return row === undefined ? undefined : toContact(row)
  }

  putContact(row: ContactRow): void {
    // 与 putCreator 同一道闸：被移除的人，联系方式也不该被下一次回填带回来
    if (this.optedOut(row.channel, row.handle)) return
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
    const hasExtra =
      row.source_url !== undefined ||
      row.source_detail !== undefined ||
      row.confidence !== undefined ||
      row.confirmations !== undefined ||
      row.disputes !== undefined
    if (!hasExtra) return
    this.db
      .prepare(
        `INSERT INTO kol_contact_extra
           (channel, handle, email_sha256, source_url, source_detail, confidence, confirmations, disputes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(channel, handle, email_sha256) DO UPDATE SET
           source_url    = COALESCE(excluded.source_url, kol_contact_extra.source_url),
           source_detail = COALESCE(excluded.source_detail, kol_contact_extra.source_detail),
           confidence    = COALESCE(excluded.confidence, kol_contact_extra.confidence),
           confirmations = COALESCE(excluded.confirmations, kol_contact_extra.confirmations),
           disputes      = COALESCE(excluded.disputes, kol_contact_extra.disputes)`,
      )
      .run(
        row.channel,
        row.handle,
        row.email_sha256,
        row.source_url ?? null,
        row.source_detail ?? null,
        row.confidence ?? null,
        row.confirmations ?? null,
        row.disputes ?? null,
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

  searchChargeAt(key: string): Iso8601 | undefined {
    const row = this.db.prepare('SELECT at FROM kol_search_window WHERE key = ?').get(key) as
      | { at: Iso8601 }
      | undefined
    return row?.at
  }

  putSearchCharge(key: string, at: Iso8601): void {
    this.db
      .prepare(
        `INSERT INTO kol_search_window (key, at) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET at = excluded.at`,
      )
      .run(key, at)
  }

  cachedBenchmark(filter: BucketFilter): Benchmark | undefined {
    const row = this.db
      .prepare(
        'SELECT * FROM kol_benchmarks_cache WHERE channel = ? AND category = ? AND followers_band = ?',
      )
      .get(filter.channel, filter.category, filter.followers_band) as BenchmarkSqlRow | undefined
    return row === undefined ? undefined : toBenchmark(row)
  }

  sweepBenchmarks(olderThan: string): number {
    // `SqliteLike.run` 故意只回 `unknown`（这个包不把 better-sqlite3 的类型拖进来）
    const result = this.db
      .prepare('DELETE FROM kol_benchmarks_cache WHERE computed_at <= ?')
      .run(olderThan) as { changes?: number } | undefined
    return result?.changes ?? 0
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

  /* ───────────────── WP116：搬家与运营后台那一组（KolLibraryStore） ───────────────── */

  putCreatorExtra(row: CreatorExtraRow): void {
    if (this.optedOut(row.channel, row.handle)) return
    /*
     * `COALESCE(excluded.x, 原值)`：搬家可能分两趟推同一个人（先 creator 再补名称），
     * 第二趟没给的格子不该把第一趟的擦掉。
     */
    this.db
      .prepare(
        `INSERT INTO kol_creator_extra
           (channel, handle, first_seen_at, external_id, name, avatar_url, country, person_id, extra, imported_from)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(channel, handle) DO UPDATE SET
           external_id   = COALESCE(excluded.external_id, kol_creator_extra.external_id),
           name          = COALESCE(excluded.name, kol_creator_extra.name),
           avatar_url    = COALESCE(excluded.avatar_url, kol_creator_extra.avatar_url),
           country       = COALESCE(excluded.country, kol_creator_extra.country),
           person_id     = COALESCE(excluded.person_id, kol_creator_extra.person_id),
           extra         = excluded.extra,
           imported_from = COALESCE(excluded.imported_from, kol_creator_extra.imported_from)`,
      )
      .run(
        row.channel,
        row.handle,
        // 只有这一行还不存在时才用得上；存在时 DO UPDATE 不碰 first_seen_at
        new Date(0).toISOString(),
        row.external_id ?? null,
        row.name ?? null,
        row.avatar_url ?? null,
        row.country ?? null,
        row.person_id ?? null,
        JSON.stringify(row.extra ?? {}),
        row.imported_from ?? null,
      )
  }

  putPerson(row: PublicPerson): void {
    this.db
      .prepare(
        `INSERT INTO kol_persons (id, display_name, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           display_name = COALESCE(excluded.display_name, kol_persons.display_name),
           updated_at   = excluded.updated_at`,
      )
      .run(row.id, row.display_name ?? null, row.created_at, row.updated_at)
  }

  person(id: string): PublicPerson | undefined {
    const row = this.db.prepare('SELECT * FROM kol_persons WHERE id = ?').get(id) as
      | { id: string; display_name: string | null; created_at: string; updated_at: string }
      | undefined
    if (row === undefined) return undefined
    return {
      id: row.id,
      ...(row.display_name === null ? {} : { display_name: row.display_name }),
      created_at: row.created_at,
      updated_at: row.updated_at,
    }
  }

  putContent(row: PublicContentSample): void {
    if (this.optedOut(row.channel, row.handle)) return
    this.db
      .prepare(
        `INSERT INTO kol_contents
           (channel, handle, external_id, content_type, title, url, thumbnail_url, tags,
            orientation, duration_seconds, published_at, views, likes, comments, shares,
            observed_at, source, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(channel, external_id) DO UPDATE SET
           handle           = excluded.handle,
           content_type     = excluded.content_type,
           title            = COALESCE(excluded.title, kol_contents.title),
           url              = COALESCE(excluded.url, kol_contents.url),
           thumbnail_url    = COALESCE(excluded.thumbnail_url, kol_contents.thumbnail_url),
           tags             = excluded.tags,
           orientation      = COALESCE(excluded.orientation, kol_contents.orientation),
           duration_seconds = COALESCE(excluded.duration_seconds, kol_contents.duration_seconds),
           published_at     = COALESCE(excluded.published_at, kol_contents.published_at),
           views            = COALESCE(excluded.views, kol_contents.views),
           likes            = COALESCE(excluded.likes, kol_contents.likes),
           comments         = COALESCE(excluded.comments, kol_contents.comments),
           shares           = COALESCE(excluded.shares, kol_contents.shares),
           observed_at      = excluded.observed_at,
           source           = excluded.source,
           updated_at       = excluded.updated_at`,
      )
      .run(
        row.channel,
        row.handle,
        row.external_id,
        row.content_type,
        row.title ?? null,
        row.url ?? null,
        row.thumbnail_url ?? null,
        JSON.stringify(row.tags ?? []),
        row.orientation ?? null,
        row.duration_seconds ?? null,
        row.published_at ?? null,
        row.views ?? null,
        row.likes ?? null,
        row.comments ?? null,
        row.shares ?? null,
        row.observed_at,
        row.source,
        row.updated_at,
      )
  }

  content(channel: KolChannel, external_id: string): PublicContentSample | undefined {
    const row = this.db
      .prepare('SELECT * FROM kol_contents WHERE channel = ? AND external_id = ?')
      .get(channel, external_id) as ContentSqlRow | undefined
    return row === undefined ? undefined : toContent(row)
  }

  contentsOf(channel: KolChannel, handle: string, limit: number): PublicContentSample[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM kol_contents WHERE channel = ? AND handle = ?
          ORDER BY COALESCE(published_at, observed_at) DESC LIMIT ?`,
      )
      .all(channel, handle, limit) as ContentSqlRow[]
    return rows.map(toContent)
  }

  putContentMetric(row: ContentMetricRow): void {
    if (this.optedOut(row.channel, row.handle)) return
    this.db
      .prepare(
        `INSERT INTO kol_content_metrics
           (channel, content_external_id, handle, views, likes, comments, shares, observed_at, source, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(channel, content_external_id, observed_at) DO UPDATE SET
           views = excluded.views, likes = excluded.likes,
           comments = excluded.comments, shares = excluded.shares,
           source = excluded.source, at = excluded.at`,
      )
      .run(
        row.channel,
        row.content_external_id,
        row.handle,
        row.views ?? null,
        row.likes ?? null,
        row.comments ?? null,
        row.shares ?? null,
        row.observed_at,
        row.source,
        row.at,
      )
  }

  putMetricSnapshot(row: PublicCreatorMetricSnapshot): void {
    if (this.optedOut(row.channel, row.handle)) return
    this.db
      .prepare(
        `INSERT INTO kol_metric_snapshots
           (channel, handle, followers, avg_views, video_count, total_views, observed_at, source, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(channel, handle, observed_at) DO UPDATE SET
           followers = excluded.followers, avg_views = excluded.avg_views,
           video_count = excluded.video_count, total_views = excluded.total_views,
           source = excluded.source`,
      )
      .run(
        row.channel,
        row.handle,
        row.followers ?? null,
        row.avg_views ?? null,
        row.video_count ?? null,
        row.total_views ?? null,
        row.observed_at,
        row.source,
        row.observed_at,
      )
  }

  metricsOf(
    channel: KolChannel,
    handle: string,
    limit: number,
  ): (PublicCreatorMetricSnapshot & { at: Iso8601 })[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM kol_metric_snapshots WHERE channel = ? AND handle = ?
          ORDER BY observed_at DESC LIMIT ?`,
      )
      .all(channel, handle, limit) as MetricSqlRow[]
    return rows.map((row) => ({
      channel: row.channel as KolChannel,
      handle: row.handle,
      ...(row.followers === null ? {} : { followers: row.followers }),
      ...(row.avg_views === null ? {} : { avg_views: row.avg_views }),
      ...(row.video_count === null ? {} : { video_count: row.video_count }),
      ...(row.total_views === null ? {} : { total_views: row.total_views }),
      observed_at: row.observed_at,
      source: row.source as KolObservationSource,
      at: row.at,
    }))
  }

  optedOut(channel: KolChannel, handle: string): boolean {
    const row = this.db
      .prepare('SELECT 1 AS hit FROM kol_optouts WHERE channel = ? AND handle = ?')
      .get(channel, handle) as { hit: number } | undefined
    return row !== undefined
  }

  putOptOut(row: OptOutRow): void {
    this.db
      .prepare(
        `INSERT INTO kol_optouts (channel, handle, reason, removed_by, at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(channel, handle) DO UPDATE SET
           reason = excluded.reason, removed_by = excluded.removed_by, at = excluded.at`,
      )
      .run(row.channel, row.handle, row.reason, row.removed_by, row.at)
  }

  purgeCreator(channel: KolChannel, handle: string): number {
    /*
     * 逐表删。**联系方式那一张先删**：万一中间炸了，留下一张没有邮箱的卡
     * 比留下一个"卡没了但邮箱还在"的孤儿好得多。
     */
    const tables: [string, string][] = [
      ['kol_contact_extra', 'channel = ? AND handle = ?'],
      ['kol_contacts', 'channel = ? AND handle = ?'],
      ['kol_content_metrics', 'channel = ? AND handle = ?'],
      ['kol_contents', 'channel = ? AND handle = ?'],
      ['kol_metric_snapshots', 'channel = ? AND handle = ?'],
      ['kol_observations', 'channel = ? AND handle = ?'],
      ['kol_disputes', 'channel = ? AND handle = ?'],
      ['kol_creator_extra', 'channel = ? AND handle = ?'],
      ['kol_creators', 'channel = ? AND handle = ?'],
    ]
    let removed = 0
    for (const [table, where] of tables) {
      const result = this.db.prepare(`DELETE FROM ${table} WHERE ${where}`).run(channel, handle) as
        | { changes?: number }
        | undefined
      removed += result?.changes ?? 0
    }
    return removed
  }

  libraryStats(at: Iso8601): KolLibraryStats {
    const count = (sql: string, ...args: unknown[]): number =>
      (this.db.prepare(sql).get(...args) as { n: number } | undefined)?.n ?? 0
    const since = (days: number): string =>
      new Date(Date.parse(at) - days * 24 * 60 * 60 * 1000).toISOString()
    const byChannel = this.db
      .prepare(
        `SELECT c.channel AS channel,
                COUNT(*) AS creators,
                SUM(CASE WHEN c.has_contact = 1 THEN 1 ELSE 0 END) AS contacts
           FROM kol_creators c GROUP BY c.channel ORDER BY creators DESC`,
      )
      .all() as { channel: string; creators: number; contacts: number }[]
    return {
      creators: count('SELECT COUNT(*) AS n FROM kol_creators'),
      contacts: count('SELECT COUNT(*) AS n FROM kol_contacts'),
      contents: count('SELECT COUNT(*) AS n FROM kol_contents'),
      observations: count('SELECT COUNT(*) AS n FROM kol_observations'),
      imported: count(
        'SELECT COUNT(*) AS n FROM kol_creator_extra WHERE imported_from IS NOT NULL',
      ),
      removed: count('SELECT COUNT(*) AS n FROM kol_optouts'),
      new_7d: count(
        'SELECT COUNT(*) AS n FROM kol_creator_extra WHERE first_seen_at >= ?',
        since(7),
      ),
      new_30d: count(
        'SELECT COUNT(*) AS n FROM kol_creator_extra WHERE first_seen_at >= ?',
        since(30),
      ),
      by_channel: byChannel.map((r) => ({
        channel: r.channel as KolChannel,
        creators: r.creators,
        contacts: r.contacts,
      })),
      at,
    }
  }

  searchCreators(filter: CreatorSearchFilter): { rows: CreatorRow[]; total: number } {
    const where: string[] = []
    const args: unknown[] = []
    if (filter.channel !== undefined) {
      where.push('c.channel = ?')
      args.push(filter.channel)
    }
    if (filter.q !== undefined && filter.q !== '') {
      where.push(
        '(lower(c.handle) LIKE ? OR lower(x.name) LIKE ? OR lower(x.external_id) LIKE ? OR lower(c.categories) LIKE ?)',
      )
      const like = `%${filter.q.toLowerCase()}%`
      args.push(like, like, like, like)
    }
    if (filter.has_contact !== undefined) {
      where.push('c.has_contact = ?')
      args.push(filter.has_contact ? 1 : 0)
    }
    if (filter.imported_only === true) where.push('x.imported_from IS NOT NULL')
    const clause = where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`
    const total =
      (
        this.db
          .prepare(
            `SELECT COUNT(*) AS n FROM kol_creators c
               LEFT JOIN kol_creator_extra x ON x.channel = c.channel AND x.handle = c.handle${clause}`,
          )
          .get(...args) as { n: number } | undefined
      )?.n ?? 0
    const rows = this.db
      .prepare(
        `${CREATOR_SELECT}${clause} ORDER BY c.followers DESC, c.handle ASC LIMIT ? OFFSET ?`,
      )
      .all(...args, filter.limit, filter.offset) as CreatorSqlRow[]
    return { rows: rows.map(toCreator), total }
  }

  close(): void {
    this.db.close()
  }
}

interface ContentSqlRow {
  channel: string
  handle: string
  external_id: string
  content_type: string
  title: string | null
  url: string | null
  thumbnail_url: string | null
  tags: string
  orientation: string | null
  duration_seconds: number | null
  published_at: string | null
  views: number | null
  likes: number | null
  comments: number | null
  shares: number | null
  observed_at: string
  source: string
  updated_at: string
}

interface MetricSqlRow {
  channel: string
  handle: string
  followers: number | null
  avg_views: number | null
  video_count: number | null
  total_views: number | null
  observed_at: string
  source: string
  at: string
}

function toContent(row: ContentSqlRow): PublicContentSample {
  const tags = parseCategories(row.tags)
  return {
    channel: row.channel as KolChannel,
    handle: row.handle,
    external_id: row.external_id,
    content_type: row.content_type as PublicContentSample['content_type'],
    ...(row.title === null ? {} : { title: row.title }),
    ...(row.url === null ? {} : { url: row.url }),
    ...(row.thumbnail_url === null ? {} : { thumbnail_url: row.thumbnail_url }),
    ...(tags.length === 0 ? {} : { tags }),
    ...(row.orientation === null
      ? {}
      : { orientation: row.orientation as 'landscape' | 'portrait' }),
    ...(row.duration_seconds === null ? {} : { duration_seconds: row.duration_seconds }),
    ...(row.published_at === null ? {} : { published_at: row.published_at }),
    ...(row.views === null ? {} : { views: row.views }),
    ...(row.likes === null ? {} : { likes: row.likes }),
    ...(row.comments === null ? {} : { comments: row.comments }),
    ...(row.shares === null ? {} : { shares: row.shares }),
    observed_at: row.observed_at,
    source: row.source as KolObservationSource,
    updated_at: row.updated_at,
  }
}
