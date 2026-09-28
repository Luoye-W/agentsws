/**
 * WP172（docs/84）：**B2B 库**——本机 SQLite，一个品牌一份（`<品牌目录>/b2b.sqlite`）。
 *
 * 写法照 `packages/data` 与 `packages/txn`：信封列（`workspace_id` / `id` / 时间）+ `body` JSON，
 * 版本号迁移（`@agentsws/core/sql` 的 `migrateSync`，一版一事务），每条查询都钉 `workspace_id`
 * ——同一个库文件里放着两个工作区的行，也互相读不到。
 *
 * 四条纪律：
 *
 * 1. **这里没有"业务写"**。九类对象只有执行器在改动卡批准之后才调 {@link B2bStore.put}
 *    （`b2b-service.ts` 的 `applyB2bChange`）；草稿、询盘、抑制名单是另外几张表。
 * 2. **报价版本只能插，不能改、不能删**：表上挂了两个触发器，谁 UPDATE / DELETE 都当场报错
 *    （契约 `B2bQuoteVersion` 是只读的，这里在库里再钉一次）。
 * 3. **联系方式没有明文**：联系人只存 `email_ref`（加密库 key 名）；按发件人认人靠
 *    `b2b_contact_email` 那张表里的**地址哈希**（`sha256(suppressionKey(地址))`）。
 * 4. **抑制名单只存哈希**：比对时把收件人照同一个口径算一遍（`core/suppression.ts` 的规则）。
 */
import type {
  B2bCollection,
  B2bDraft,
  B2bEnrollment,
  B2bInquiry,
  B2bOutboundSettings,
  B2bQuoteVersion,
  B2bSender,
  B2bSuppressionEntry,
  WorkspaceId,
} from '@agentsws/contracts'
import { sha256, suppressionKey } from '@agentsws/core'
import {
  type Migration,
  migrateSync,
  openSqliteDriver,
  type SqliteDriver,
} from '@agentsws/core/sql'

/** 地址 → 比对用的哈希（抑制名单与"发件人在不在库里"共用这一个口径）。 */
export function addressHash(address: string): string {
  return sha256(`b2b-addr|${suppressionKey(address)}`)
}

const envelope = (table: string): string => `CREATE TABLE IF NOT EXISTS ${table} (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id)
);`

/**
 * 迁移。**只加不改**：要改表就加一版。v1 = 九类对象 + 报价版本；v2 = 草稿 / 询盘 / 抑制名单 /
 * 我们发出去的信 / 联系人地址哈希；v3（WP173）= 开发序列（每人一条）、发信邮箱、主动开发设置。
 */
export const B2B_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `${[
      'b2b_account',
      'b2b_contact',
      'b2b_opportunity',
      'b2b_quote',
      'b2b_sample',
      'b2b_list',
      'trade_show',
      'trade_show_lead',
      'export_shipment',
    ]
      .map(envelope)
      .join('\n')}
CREATE TABLE IF NOT EXISTS b2b_quote_version (
  workspace_id TEXT NOT NULL,
  quote_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (workspace_id, quote_id, version)
);
CREATE TRIGGER IF NOT EXISTS b2b_quote_version_no_update BEFORE UPDATE ON b2b_quote_version
BEGIN SELECT RAISE(ABORT, 'b2b_quote_version is immutable'); END;
CREATE TRIGGER IF NOT EXISTS b2b_quote_version_no_delete BEFORE DELETE ON b2b_quote_version
BEGIN SELECT RAISE(ABORT, 'b2b_quote_version is immutable'); END;`,
  },
  {
    version: 2,
    sql: `${envelope('b2b_draft')}
${envelope('b2b_inquiry')}
CREATE INDEX IF NOT EXISTS b2b_inquiry_message ON b2b_inquiry (workspace_id, created_at);
CREATE TABLE IF NOT EXISTS b2b_suppression (
  workspace_id TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  at TEXT NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (workspace_id, key_hash)
);
CREATE TABLE IF NOT EXISTS b2b_outbound_message (
  workspace_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  at TEXT NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (workspace_id, message_id)
);
CREATE TABLE IF NOT EXISTS b2b_contact_email (
  workspace_id TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id, key_hash)
);`,
  },
  {
    version: 3,
    sql: `${envelope('b2b_enrollment')}
${envelope('b2b_sender')}
${envelope('b2b_outbound_settings')}`,
  },
]

/** 我们发出去的一封 B2B 信（开发信 / 报价信）：回信按它对线程（docs/84 §5 ①）。 */
export interface B2bOutboundNote {
  message_id: string
  kind: 'outreach' | 'quote' | 'reply'
  account_id?: string
  contact_id?: string
  /** WP173：开发信属于哪一条序列、第几封（回信按它停序列）。 */
  enrollment_id?: string
  step?: B2bEnrollment['steps'][number]['step']
}

export interface B2bStore {
  readonly workspace_id: WorkspaceId
  /** 一类对象的全部行（按 id 排）。 */
  list<T>(collection: B2bCollection): T[]
  get<T>(collection: B2bCollection, id: string): T | undefined
  /** 落一条（新建或覆盖）。**只有执行器在卡批准之后调**（文件头第 1 条）。 */
  put(collection: B2bCollection, row: { id: string } & Record<string, unknown>): void
  /** 一张报价的全部版本（从 1 起）。 */
  quoteVersions(quote_id: string): B2bQuoteVersion[]
  /** 插一版报价。已有同号 → 抛错（不可改，文件头第 2 条）。 */
  addQuoteVersion(v: B2bQuoteVersion): void

  drafts(filter?: { collection?: B2bCollection; status?: B2bDraft['status'] }): B2bDraft[]
  draft(id: string): B2bDraft | undefined
  saveDraft(d: B2bDraft): void

  inquiries(): B2bInquiry[]
  inquiry(id: string): B2bInquiry | undefined
  inquiryByMessage(message_id: string): B2bInquiry | undefined
  saveInquiry(i: B2bInquiry): void

  /** 抑制名单：按地址查（内部算哈希，地址不落盘）。 */
  isSuppressed(address: string): boolean
  suppressions(): B2bSuppressionEntry[]
  /** 进名单。已在名单上回 `false`（不重复记）。 */
  suppress(entry: B2bSuppressionEntry): boolean

  /** 记一封我们发出去的 B2B 信（回信按它对线程）。 */
  noteOutbound(note: B2bOutboundNote, at: string): void
  /** 这几个 Message-ID 里有没有我们发出去的 B2B 信。 */
  outboundMatch(ids: readonly string[]): B2bOutboundNote | undefined

  /** 联系人的地址哈希 → 联系人 id（建联系人时记，按发件人认人时查）。 */
  indexContactEmail(key_hash: string, contact_id: string): void
  contactIdByEmail(address: string): string | undefined

  /** WP173：开发序列（每个联系人每一轮一条）。 */
  enrollments(): B2bEnrollment[]
  enrollment(id: string): B2bEnrollment | undefined
  saveEnrollment(e: B2bEnrollment): void
  /** WP173：发信邮箱（id = 小写地址）。 */
  senders(): B2bSender[]
  sender(address: string): B2bSender | undefined
  saveSender(s: B2bSender): void
  /** WP173：主动开发的设置（一个品牌一份）。 */
  outboundSettings(): B2bOutboundSettings
  saveOutboundSettings(s: B2bOutboundSettings): void
  close(): void
}

export interface B2bStoreOptions {
  workspace_id: WorkspaceId
  /** 这个品牌的落盘目录。不给就是内存库（`:memory:`，同一份 SQL）。 */
  dbDir?: string
  /** 迁移记账用的时刻。 */
  now?(): string
}

const normId = (id: string): string => id.trim().toLowerCase()

export function createB2bStore(options: B2bStoreOptions): B2bStore {
  const ws = options.workspace_id
  const driver: SqliteDriver = openSqliteDriver({
    path: options.dbDir === undefined ? ':memory:' : `${options.dbDir}/b2b.sqlite`,
  })
  migrateSync(driver, B2B_MIGRATIONS, options.now?.() ?? new Date(0).toISOString())
  const now = (): string => options.now?.() ?? new Date().toISOString()

  const all = <T>(table: string): T[] =>
    driver
      .prepareSync<{ body: string }>(`SELECT body FROM ${table} WHERE workspace_id = ? ORDER BY id`)
      .allSync(ws)
      .map((r) => JSON.parse(r.body) as T)
  const one = <T>(table: string, id: string): T | undefined => {
    const row = driver
      .prepareSync<{ body: string }>(`SELECT body FROM ${table} WHERE workspace_id = ? AND id = ?`)
      .getSync(ws, id)
    return row === undefined ? undefined : (JSON.parse(row.body) as T)
  }
  const upsert = (table: string, id: string, row: unknown): void => {
    const at = now()
    driver
      .prepareSync(
        `INSERT INTO ${table} (workspace_id, id, created_at, updated_at, body) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, id) DO UPDATE SET updated_at = excluded.updated_at, body = excluded.body`,
      )
      .runSync(ws, id, at, at, JSON.stringify(row))
  }

  return {
    workspace_id: ws,
    list: (c) => all(c),
    get: (c, id) => one(c, id),
    put: (c, row) => upsert(c, row.id, { ...row, workspace_id: ws }),
    quoteVersions: (quote_id) =>
      driver
        .prepareSync<{ body: string }>(
          'SELECT body FROM b2b_quote_version WHERE workspace_id = ? AND quote_id = ? ORDER BY version',
        )
        .allSync(ws, quote_id)
        .map((r) => JSON.parse(r.body) as B2bQuoteVersion),
    addQuoteVersion: (v) => {
      driver
        .prepareSync(
          'INSERT INTO b2b_quote_version (workspace_id, quote_id, version, created_at, body) VALUES (?, ?, ?, ?, ?)',
        )
        .runSync(ws, v.quote_id, v.version, v.created_at, JSON.stringify(v))
    },

    drafts: (filter) =>
      all<B2bDraft>('b2b_draft')
        .filter((d) => filter?.collection === undefined || d.collection === filter.collection)
        .filter((d) => filter?.status === undefined || d.status === filter.status),
    draft: (id) => one<B2bDraft>('b2b_draft', id),
    saveDraft: (d) => upsert('b2b_draft', d.id, d),

    inquiries: () =>
      all<B2bInquiry>('b2b_inquiry').sort((a, b) => b.received_at.localeCompare(a.received_at)),
    inquiry: (id) => one<B2bInquiry>('b2b_inquiry', id),
    inquiryByMessage: (message_id) =>
      all<B2bInquiry>('b2b_inquiry').find((i) => i.message_id === message_id),
    saveInquiry: (i) => upsert('b2b_inquiry', i.id, i),

    isSuppressed: (address) =>
      driver
        .prepareSync('SELECT 1 FROM b2b_suppression WHERE workspace_id = ? AND key_hash = ?')
        .getSync(ws, addressHash(address)) !== undefined,
    suppressions: () =>
      driver
        .prepareSync<{ body: string }>(
          'SELECT body FROM b2b_suppression WHERE workspace_id = ? ORDER BY at',
        )
        .allSync(ws)
        .map((r) => JSON.parse(r.body) as B2bSuppressionEntry),
    suppress: (entry) =>
      driver
        .prepareSync(
          `INSERT INTO b2b_suppression (workspace_id, key_hash, at, body) VALUES (?, ?, ?, ?)
           ON CONFLICT (workspace_id, key_hash) DO NOTHING`,
        )
        .runSync(ws, entry.key_hash, entry.at, JSON.stringify(entry)).changes > 0,

    noteOutbound: (note, at) => {
      driver
        .prepareSync(
          `INSERT INTO b2b_outbound_message (workspace_id, message_id, at, body) VALUES (?, ?, ?, ?)
           ON CONFLICT (workspace_id, message_id) DO NOTHING`,
        )
        .runSync(ws, normId(note.message_id), at, JSON.stringify(note))
    },
    outboundMatch: (ids) => {
      const stmt = driver.prepareSync<{ body: string }>(
        'SELECT body FROM b2b_outbound_message WHERE workspace_id = ? AND message_id = ?',
      )
      for (const id of ids) {
        const row = stmt.getSync(ws, normId(id))
        if (row !== undefined) return JSON.parse(row.body) as B2bOutboundNote
      }
      return undefined
    },

    indexContactEmail: (key_hash, contact_id) => {
      driver
        .prepareSync(
          `INSERT INTO b2b_contact_email (workspace_id, key_hash, contact_id) VALUES (?, ?, ?)
           ON CONFLICT (workspace_id, key_hash) DO UPDATE SET contact_id = excluded.contact_id`,
        )
        .runSync(ws, key_hash, contact_id)
    },
    contactIdByEmail: (address) =>
      driver
        .prepareSync<{ contact_id: string }>(
          'SELECT contact_id FROM b2b_contact_email WHERE workspace_id = ? AND key_hash = ?',
        )
        .getSync(ws, addressHash(address))?.contact_id,

    enrollments: () => all<B2bEnrollment>('b2b_enrollment'),
    enrollment: (id) => one<B2bEnrollment>('b2b_enrollment', id),
    saveEnrollment: (e) => upsert('b2b_enrollment', e.id, e),
    senders: () => all<B2bSender>('b2b_sender'),
    sender: (address) => one<B2bSender>('b2b_sender', address.trim().toLowerCase()),
    saveSender: (s) => upsert('b2b_sender', s.address.trim().toLowerCase(), s),
    outboundSettings: () => one<B2bOutboundSettings>('b2b_outbound_settings', 'settings') ?? {},
    saveOutboundSettings: (s) => upsert('b2b_outbound_settings', 'settings', s),
    close: () => {
      driver.closeSync()
    },
  }
}
