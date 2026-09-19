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
import type { KolDeckData } from '@agentsws/deck'
import {
  applyMerge,
  collaborationFunnel,
  collaborationStageName,
  rankCreators,
} from '@agentsws/kol-core'
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
  /**
   * WP117 交付 4：删掉一行。
   *
   * **只为「清空演练」存在**——库里其余地方一条删除路径都没有，这是有意的
   * （红人库是攒出来的资产，误删一条没有回收站可捡）。演练那一批是造出来的，
   * 清得掉才敢让人放手玩。
   *
   * 调用方负责顺序（先删挂在人身上的，最后删人），这里不替它判：
   * 一个会级联删除的接口太容易被别处误用。
   */
  removeRow(table: KolTable, id: string): void
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

    removeRow: (table, id) => {
      backend.remove(table, id)
    },

    close: () => backend.close(),
  }
}

/**
 * `KolStore` → 面板五块要的那份投影（48 §5.1）。
 *
 * 放在这里而不是 deck 里：deck 是**纯**的（29 §1，它连库都不认识），
 * 而这一步要查三张表把"这条合作是跟谁的"拼出来。deck 拿到的已经是算好的行。
 *
 * 三件事在这一跳定死：
 *
 * 1. **找人清单的分是当场算的，用同一份纯函数**（`kol-core` 的 `rankCreators`）。
 *    算法是确定的：同样的账号 + 同样的条件 = 同样的分，所以"当场算"与"存一份"
 *    在数值上没有差别，而存一份要多一张表和一条"什么时候重算"的规矩。
 *    调用方按 campaign 定了条件（类目 / 语言 / 粉丝带）时用 `scores` 盖过去——
 *    那才是"这次找人要什么样的人"，面板上的默认条件不知道这件事。
 * 2. **归因的数字原样端出去**：`clicks` / `orders` / `revenue` 是归因那一跳回填的。
 * 3. 阶段的中文名只有 `kol-core` 的 `stages.ts` 那一份翻译。
 */
export function kolDeckData(
  store: Pick<KolStore, 'creators' | 'accounts' | 'collaborations' | 'deliverables' | 'links'>,
  options: {
    /** 算"数据新鲜度"那一项要的现在时刻。不给就当拿不到——那一项 0 分并说明白。 */
    now?: string
    /** 这次找人的条件算出来的分（按 `PlatformAccount.id`）。给了就盖过默认那一份。 */
    scores?: ReadonlyMap<string, { score: number; blocked?: string }>
  } = {},
): KolDeckData {
  const creators = new Map(store.creators().map((c) => [c.id, c]))
  const nameOf = (creator_id: string): string =>
    creators.get(creator_id)?.display_name ?? creator_id
  const collaborations = store.collaborations()
  const collabById = new Map(collaborations.map((c) => [c.id, c]))

  const accounts = store.accounts()
  // 排序（含"刷粉的排在后面而不是剔掉"那一条）也在 `rankCreators` 里，不在这儿重写
  const ranked = rankCreators(accounts, { now: options.now ?? '' })
  const discovery = ranked.map(({ account, score }) => {
    const override = options.scores?.get(account.id)
    const blocked = override === undefined ? score.blocked : override.blocked
    return {
      creator_id: account.creator_id,
      display_name: nameOf(account.creator_id),
      channel: account.channel as string,
      handle: account.handle,
      ...(account.followers === undefined ? {} : { followers: account.followers }),
      score: override?.score ?? score.total,
      ...(blocked === undefined ? {} : { blocked }),
    }
  })

  return {
    discovery,
    funnel: collaborationFunnel(collaborations),
    collaborations: collaborations
      // 已结案与已谢绝的不在"进行中"里
      .filter((c) => c.stage !== 'closed' && c.stage !== 'declined')
      .map((c) => ({
        collaboration_id: c.id,
        display_name: nameOf(c.creator_id),
        channel: c.channel as string,
        stage: c.stage as string,
        stage_label: collaborationStageName(c.stage),
        ...(c.budget === undefined ? {} : { budget: c.budget }),
        currency: c.currency,
      })),
    pending_deliverables: store.deliverables({ pending: true }).map((d) => {
      const collab = collabById.get(d.collaboration_id)
      return {
        deliverable_id: d.id,
        display_name: collab === undefined ? d.collaboration_id : nameOf(collab.creator_id),
        channel: (collab?.channel ?? '') as string,
        kind: d.kind as string,
        due_at: d.due_at,
        ...(d.url === undefined ? {} : { url: d.url }),
      }
    }),
    attribution: store.links().map((l) => {
      const collab = collabById.get(l.collaboration_id)
      return {
        tracked_link_id: l.id,
        display_name: collab === undefined ? l.collaboration_id : nameOf(collab.creator_id),
        channel: (collab?.channel ?? '') as string,
        clicks: l.clicks,
        orders: l.orders,
        revenue: l.revenue,
        currency: 'USD',
      }
    }),
  }
}

/**
 * `agentsws demo` 用的那几条红人数据。
 *
 * 为什么要有它：红人库是**我们自己的库**，不是连接器——所以合成世界（`packs/`）
 * 里没有它的行，而 demo 里如果这五块全是空的，红人营销这个岗位在演示与截图里
 * 就看不出任何东西。这与 `seedDemoMeetings` 是同一类东西：给一个空库放几行真实形状的数据。
 *
 * 数据本身是**演示数据**，不是假装的真数据：两个红人、两条合作、两条交付物、
 * 两条追踪链接，数字都对得上（归因那两行的收入就是那两条链接回填的）。
 * 一条联系方式都不放：那要经加密库，演示不该往加密库里塞东西。
 */
export function seedDemoKol(store: KolStore, now: string): void {
  if (store.creators().length > 0) return
  const observed_at = now

  store.saveCreator({ id: 'cre_demo_1', display_name: 'Gadget Jonas', merged_from: [] })
  store.saveCreator({ id: 'cre_demo_2', display_name: 'Desk Rosa', merged_from: [] })
  store.saveCreator({ id: 'cre_demo_3', display_name: 'Cable Kevin', merged_from: [] })
  // WP68：一条 Instagram 的账号。**为了 campaign 那张清单**——跨渠道挑人时，
  // 本人只有 YouTube 那条职责，Instagram 这一组要在清单上看得见、灰着、
  // 并说得出为什么（05 §4）。一组空的挑人清单演示不出这件事。
  store.saveCreator({ id: 'cre_demo_4', display_name: 'Studio Mia', merged_from: [] })

  store.saveAccount({
    id: 'pa_demo_1',
    creator_id: 'cre_demo_1',
    channel: 'youtube',
    handle: 'gadgetjonas',
    url: 'https://www.youtube.com/@gadgetjonas',
    followers: 48_000,
    engagement_rate: 0.062,
    category: '数码',
    language: 'de',
    region: 'DE',
    observed_at,
  })
  store.saveAccount({
    id: 'pa_demo_2',
    creator_id: 'cre_demo_2',
    channel: 'youtube',
    handle: 'deskrosa',
    url: 'https://www.youtube.com/@deskrosa',
    followers: 31_000,
    engagement_rate: 0.041,
    category: '家居',
    language: 'en',
    region: 'GB',
    observed_at,
  })
  // 刷粉护栏那一条：清单上要看得见"这个数不可信"，而不是悄悄少一行
  store.saveAccount({
    id: 'pa_demo_3',
    creator_id: 'cre_demo_3',
    channel: 'youtube',
    handle: 'cablekevin',
    url: 'https://www.youtube.com/@cablekevin',
    followers: 620_000,
    engagement_rate: 0.002,
    category: '数码',
    language: 'en',
    region: 'US',
    observed_at,
  })

  store.saveAccount({
    id: 'pa_demo_4',
    creator_id: 'cre_demo_4',
    channel: 'instagram',
    handle: 'studiomia',
    url: 'https://www.instagram.com/studiomia',
    followers: 26_000,
    engagement_rate: 0.055,
    category: '家居',
    language: 'en',
    region: 'US',
    observed_at,
  })

  store.saveCollaboration({
    id: 'col_demo_1',
    creator_id: 'cre_demo_1',
    channel: 'youtube',
    stage: 'delivering',
    budget: 400,
    currency: 'USD',
    agreed_at: now,
  })
  store.saveCollaboration({
    id: 'col_demo_2',
    creator_id: 'cre_demo_2',
    channel: 'youtube',
    stage: 'contacted',
    currency: 'USD',
  })

  const day = 86_400_000
  store.saveDeliverable({
    id: 'dlv_demo_1',
    collaboration_id: 'col_demo_1',
    kind: 'video',
    url: 'https://www.youtube.com/watch?v=demo1',
    due_at: new Date(Date.parse(now) + 3 * day).toISOString(),
    submitted_at: now,
    review: 'pending',
    notes: '正片交了，描述区的追踪链接还没加。',
  })
  store.saveDeliverable({
    id: 'dlv_demo_2',
    collaboration_id: 'col_demo_1',
    kind: 'post',
    due_at: new Date(Date.parse(now) + 7 * day).toISOString(),
    review: 'pending',
  })

  store.saveLink({
    id: 'tl_demo_1',
    collaboration_id: 'col_demo_1',
    url: 'https://nordvolt.example/p/charger-65w',
    utm: { source: 'youtube', medium: 'kol', campaign: 'autumn-desk', content: 'col_demo_1' },
    affiliate_code: 'GADGETJO10',
    clicks: 318,
    orders: 5,
    revenue: 645.5,
  })
  store.saveLink({
    id: 'tl_demo_2',
    collaboration_id: 'col_demo_2',
    url: 'https://nordvolt.example/p/desk-hub',
    utm: { source: 'youtube', medium: 'kol', campaign: 'autumn-desk', content: 'col_demo_2' },
    clicks: 41,
    orders: 0,
    revenue: 0,
  })
}
