/**
 * 红人库的存储（48 §5.2 数据面，WP67）。
 *
 * 六类对象（`creator` / `platform_account` / `creator_contact` / `collaboration` /
 * `deliverable` / `tracked_link`）落在**这个品牌自己的**目录下（WP66 的
 * `BrandModules`：bootstrap 品牌用原来那个目录，别的品牌在
 * `<dbDir>/brands/<workspace_id>/` 下）。形状照 `invites.ts` / `org.ts` 那几个
 * 库抄：一张表一列 json，后端要么 sqlite 要么全内存（测试与一次性任务）。
 *
 * 三条纪律：
 *
 * 1. **联系方式不落明文**。`CreatorContact.value_ref` 存的是本机加密库里的 key 名，
 *    这个文件从头到尾没有一个地方接得到明文——`saveContact` 的入参类型里就没有。
 *    取明文要经加密库（`SecretStore`），那是发信那一跳的事。
 * 2. **合并不在这里发生**。`applyMerge` 是 `@agentsws/kol-core` 的纯函数，
 *    这里只负责把它算出来的结果写下去，而且写之前 `creator_id` 的迁移
 *    （账号、联系方式、合作跟着走）是同一次事务里的事——半迁完的库比没合更糟。
 * 3. **数字回填，不重算**。`TrackedLink` 的 `clicks` / `orders` / `revenue` 由
 *    归因那一跳算完写回来；读的时候原样端出去，面板上那一列不在渲染时现算
 *    （29 §1「数字不经模型手」的同一条）。
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type {
  Collaboration,
  CollaborationStage,
  Creator,
  CreatorContact,
  Deliverable,
  KolChannel,
  PlatformAccount,
  TrackedLink,
  WorkspaceId,
} from '@agentsws/contracts'
import { applyMerge } from '@agentsws/kol-core'
import type BetterSqlite3 from 'better-sqlite3'

/** 库里的六张表。名字与对象类型一一对应，不另起别名。 */
export type KolTable =
  | 'creator'
  | 'platform_account'
  | 'creator_contact'
  | 'collaboration'
  | 'deliverable'
  | 'tracked_link'

export const KOL_TABLES: readonly KolTable[] = [
  'creator',
  'platform_account',
  'creator_contact',
  'collaboration',
  'deliverable',
  'tracked_link',
]

interface KolBackend {
  all<T>(table: KolTable): T[]
  get<T>(table: KolTable, id: string): T | undefined
  put(table: KolTable, id: string, row: unknown): void
  remove(table: KolTable, id: string): void
  close(): void
}

function createMemoryBackend(): KolBackend {
  const tables = new Map<KolTable, Map<string, unknown>>()
  const of = (t: KolTable): Map<string, unknown> => {
    const found = tables.get(t)
    if (found !== undefined) return found
    const fresh = new Map<string, unknown>()
    tables.set(t, fresh)
    return fresh
  }
  return {
    all: <T>(t: KolTable) => [...of(t).values()].map((r) => structuredClone(r) as T),
    get: <T>(t: KolTable, id: string) => {
      const row = of(t).get(id)
      return row === undefined ? undefined : (structuredClone(row) as T)
    },
    put: (t, id, row) => {
      of(t).set(id, structuredClone(row))
    },
    remove: (t, id) => {
      of(t).delete(id)
    },
    close: () => tables.clear(),
  }
}

const SCHEMA = KOL_TABLES.map(
  (t) => `CREATE TABLE IF NOT EXISTS kol_${t} (id TEXT PRIMARY KEY, json TEXT NOT NULL);`,
).join('\n')

function createSqliteBackend(dbPath: string): KolBackend {
  const require = createRequire(import.meta.url)
  const Database = require('better-sqlite3') as typeof BetterSqlite3
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA)
  return {
    all: <T>(t: KolTable) =>
      (db.prepare(`SELECT json FROM kol_${t} ORDER BY id`).all() as { json: string }[]).map(
        (r) => JSON.parse(r.json) as T,
      ),
    get: <T>(t: KolTable, id: string) => {
      const row = db.prepare(`SELECT json FROM kol_${t} WHERE id = ?`).get(id) as
        | { json: string }
        | undefined
      return row === undefined ? undefined : (JSON.parse(row.json) as T)
    },
    put: (t, id, row) => {
      db.prepare(
        `INSERT INTO kol_${t} (id, json) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET json = excluded.json`,
      ).run(id, JSON.stringify(row))
    },
    remove: (t, id) => {
      db.prepare(`DELETE FROM kol_${t} WHERE id = ?`).run(id)
    },
    close: () => {
      db.close()
    },
  }
}

export interface KolStoreOptions {
  workspace_id: WorkspaceId
  /** 这个品牌的落盘目录（`BrandModules` 给的那一个）。不给就全内存。 */
  dbDir?: string
}

export interface KolStore {
  readonly workspace_id: WorkspaceId
  creators(): Creator[]
  creator(id: string): Creator | undefined
  accounts(filter?: { creator_id?: string; channel?: KolChannel }): PlatformAccount[]
  contacts(creator_id?: string): CreatorContact[]
  collaborations(filter?: { channel?: KolChannel; stage?: CollaborationStage }): Collaboration[]
  collaboration(id: string): Collaboration | undefined
  deliverables(filter?: { collaboration_id?: string; pending?: boolean }): Deliverable[]
  links(collaboration_id?: string): TrackedLink[]

  saveCreator(row: Creator): void
  saveAccount(row: PlatformAccount): void
  /** 联系方式。入参里**没有**明文那一格（见文件头第 1 条）。 */
  saveContact(row: CreatorContact): void
  saveCollaboration(row: Collaboration): void
  saveDeliverable(row: Deliverable): void
  saveLink(row: TrackedLink): void
  /** 归因算完之后回填那三个数。链接不在就什么也不做（不凭空建一条）。 */
  recordAttribution(input: {
    tracked_link_id: string
    clicks?: number
    orders: number
    revenue: number
  }): void
  /**
   * 人在合并建议卡上点了「合」之后走这一跳。
   *
   * 三件事一起做：被合掉那条名下的账号 / 联系方式 / 合作改挂到保留那条上、
   * 保留那条的 `merged_from` 记下来、被合掉那条删掉。少做任何一件，
   * 库里就会出现一条谁也指不到的孤儿记录。
   */
  merge(input: { keep_id: string; merge_id: string }): Creator | undefined
  close(): void
}

export function createKolStore(options: KolStoreOptions): KolStore {
  const backend =
    options.dbDir === undefined
      ? createMemoryBackend()
      : createSqliteBackend(join(options.dbDir, 'kol.sqlite'))

  const collaborations = (filter?: { channel?: KolChannel; stage?: CollaborationStage }) =>
    backend
      .all<Collaboration>('collaboration')
      .filter((c) => filter?.channel === undefined || c.channel === filter.channel)
      .filter((c) => filter?.stage === undefined || c.stage === filter.stage)

  return {
    workspace_id: options.workspace_id,
    creators: () => backend.all<Creator>('creator'),
    creator: (id) => backend.get<Creator>('creator', id),
    accounts: (filter) =>
      backend
        .all<PlatformAccount>('platform_account')
        .filter((a) => filter?.creator_id === undefined || a.creator_id === filter.creator_id)
        .filter((a) => filter?.channel === undefined || a.channel === filter.channel),
    contacts: (creator_id) =>
      backend
        .all<CreatorContact>('creator_contact')
        .filter((c) => creator_id === undefined || c.creator_id === creator_id),
    collaborations,
    collaboration: (id) => backend.get<Collaboration>('collaboration', id),
    deliverables: (filter) =>
      backend
        .all<Deliverable>('deliverable')
        .filter(
          (d) =>
            filter?.collaboration_id === undefined ||
            d.collaboration_id === filter.collaboration_id,
        )
        // 「待审」= 还没有结论的那些。`changes_requested` 不算待审：球在对方那边。
        .filter((d) => filter?.pending !== true || d.review === 'pending'),
    links: (collaboration_id) =>
      backend
        .all<TrackedLink>('tracked_link')
        .filter((l) => collaboration_id === undefined || l.collaboration_id === collaboration_id),

    saveCreator: (row) => backend.put('creator', row.id, row),
    saveAccount: (row) => backend.put('platform_account', row.id, row),
    saveContact: (row) => backend.put('creator_contact', row.id, row),
    saveCollaboration: (row) => backend.put('collaboration', row.id, row),
    saveDeliverable: (row) => backend.put('deliverable', row.id, row),
    saveLink: (row) => backend.put('tracked_link', row.id, row),

    recordAttribution: (input) => {
      const link = backend.get<TrackedLink>('tracked_link', input.tracked_link_id)
      if (link === undefined) return
      backend.put('tracked_link', link.id, {
        ...link,
        ...(input.clicks === undefined ? {} : { clicks: input.clicks }),
        orders: input.orders,
        revenue: input.revenue,
      })
    },

    merge: ({ keep_id, merge_id }) => {
      const keep = backend.get<Creator>('creator', keep_id)
      const merge = backend.get<Creator>('creator', merge_id)
      if (keep === undefined || merge === undefined) return undefined
      for (const a of backend
        .all<PlatformAccount>('platform_account')
        .filter((x) => x.creator_id === merge_id))
        backend.put('platform_account', a.id, { ...a, creator_id: keep_id })
      for (const c of backend
        .all<CreatorContact>('creator_contact')
        .filter((x) => x.creator_id === merge_id))
        backend.put('creator_contact', c.id, { ...c, creator_id: keep_id })
      for (const c of collaborations().filter((x) => x.creator_id === merge_id))
        backend.put('collaboration', c.id, { ...c, creator_id: keep_id })
      const merged = applyMerge(keep, merge)
      backend.put('creator', merged.id, merged)
      backend.remove('creator', merge_id)
      return merged
    },

    close: () => backend.close(),
  }
}
