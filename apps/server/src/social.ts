/**
 * 社媒库的存储（56 §2 数据面，WP72）。
 *
 * 四类对象（`social_account` / `social_post` / `community_member` /
 * `community_thread`）落在**这个品牌自己的**目录下（WP66 的 `BrandModules`：
 * bootstrap 品牌用原来那个目录，别的品牌在 `<dbDir>/brands/<workspace_id>/` 下）。
 * 形状照 `kol.ts` 抄：一张表一列 json，后端要么 sqlite 要么全内存（测试与一次性任务）。
 *
 * 四条纪律：
 *
 * 1. **凭据一格都没有**。`SocialAccount.connection_id` 指的是连接页上那一条连接；
 *    取 token 要经本品牌加密库，那是发出去那一跳的事（同 `kol.ts` 的第 1 条）。
 * 2. **九条渠道之间零共享**。同一个品牌在 TikTok 与在 Discord 是两条
 *    `SocialAccount`，各带各的粉丝数、各算各的额度。所以这里每个读口都能按
 *    `channel` 筛——面板上一条职责只该看见它自己那条渠道的行。
 * 3. **分类结论跟着线程走，回复不在这里发生**。`triage` 是
 *    `@agentsws/social-core` 判完写回来的一格；判成客户问题的那一条，这里记的是
 *    `routed_approval_id`（那张转客服卡），**不是**一段答复——答是客服
 *    （`dtc.community-support`）的事（56 边界行）。
 * 4. **数字不重算**。`SocialPost.metrics` 与 `metrics_observed_at` 是拉数那一跳
 *    写回来的；读的时候原样端出去，面板上那几列不在渲染时现算
 *    （29 §1「数字不经模型手」）。
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type {
  CommunityMember,
  CommunityThread,
  SocialAccount,
  SocialChannel,
  SocialPost,
  SocialPostStatus,
  WorkspaceId,
} from '@agentsws/contracts'
import type { SocialDeckData } from '@agentsws/deck'
import type BetterSqlite3 from 'better-sqlite3'

/** 库里的四张表。名字与对象类型一一对应，不另起别名。 */
export type SocialTable = 'social_account' | 'social_post' | 'community_member' | 'community_thread'

export const SOCIAL_TABLES: readonly SocialTable[] = [
  'social_account',
  'social_post',
  'community_member',
  'community_thread',
]

interface SocialBackend {
  all<T>(table: SocialTable): T[]
  get<T>(table: SocialTable, id: string): T | undefined
  put(table: SocialTable, id: string, row: unknown): void
  remove(table: SocialTable, id: string): void
  close(): void
}

function createMemoryBackend(): SocialBackend {
  const tables = new Map<SocialTable, Map<string, unknown>>()
  const of = (t: SocialTable): Map<string, unknown> => {
    const found = tables.get(t)
    if (found !== undefined) return found
    const fresh = new Map<string, unknown>()
    tables.set(t, fresh)
    return fresh
  }
  return {
    all: <T>(t: SocialTable) => [...of(t).values()].map((r) => structuredClone(r) as T),
    get: <T>(t: SocialTable, id: string) => {
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

const SCHEMA = SOCIAL_TABLES.map(
  (t) => `CREATE TABLE IF NOT EXISTS social_${t} (id TEXT PRIMARY KEY, json TEXT NOT NULL);`,
).join('\n')

function createSqliteBackend(dbPath: string): SocialBackend {
  const require = createRequire(import.meta.url)
  const Database = require('better-sqlite3') as typeof BetterSqlite3
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA)
  return {
    all: <T>(t: SocialTable) =>
      (db.prepare(`SELECT json FROM social_${t} ORDER BY id`).all() as { json: string }[]).map(
        (r) => JSON.parse(r.json) as T,
      ),
    get: <T>(t: SocialTable, id: string) => {
      const row = db.prepare(`SELECT json FROM social_${t} WHERE id = ?`).get(id) as
        | { json: string }
        | undefined
      return row === undefined ? undefined : (JSON.parse(row.json) as T)
    },
    put: (t, id, row) => {
      db.prepare(
        `INSERT INTO social_${t} (id, json) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET json = excluded.json`,
      ).run(id, JSON.stringify(row))
    },
    remove: (t, id) => {
      db.prepare(`DELETE FROM social_${t} WHERE id = ?`).run(id)
    },
    close: () => {
      db.close()
    },
  }
}

export interface SocialStoreOptions {
  workspace_id: WorkspaceId
  /** 这个品牌的落盘目录（`BrandModules` 给的那一个）。不给就全内存。 */
  dbDir?: string
}

export interface SocialStore {
  readonly workspace_id: WorkspaceId
  accounts(filter?: { channel?: SocialChannel }): SocialAccount[]
  account(id: string): SocialAccount | undefined
  posts(filter?: {
    channel?: SocialChannel
    account_id?: string
    status?: SocialPostStatus
  }): SocialPost[]
  post(id: string): SocialPost | undefined
  members(filter?: {
    channel?: SocialChannel
    account_id?: string
    pending?: boolean
  }): CommunityMember[]
  threads(filter?: {
    channel?: SocialChannel
    account_id?: string
    /** 只要还没处理完的那些（`open`）。 */
    open?: boolean
    surface?: CommunityThread['surface']
  }): CommunityThread[]
  thread(id: string): CommunityThread | undefined

  saveAccount(row: SocialAccount): void
  savePost(row: SocialPost): void
  saveMember(row: CommunityMember): void
  saveThread(row: CommunityThread): void
  /**
   * 拉完数之后回填一条帖子的表现。
   *
   * 帖子不在就什么也不做（**不凭空建一条**：一条只有数字没有正文的帖子，
   * 在"近 30 天表现"里会变成一行没人认得的数）。
   */
  recordMetrics(input: {
    post_id: string
    metrics: NonNullable<SocialPost['metrics']>
    observed_at: string
  }): void
  /**
   * 分类那一跳的结论写回线程（`@agentsws/social-core` 的 `triage` 算的）。
   *
   * 判成客户问题的那一条带着转客服卡的 id 一起写回来——线程从此归客服
   * （`status: 'routed_to_support'`），社媒运营那边的队列里它就不再是"待回"。
   */
  recordTriage(input: {
    thread_id: string
    triage: NonNullable<CommunityThread['triage']>
    routed_approval_id?: string
  }): void
  close(): void
}

export function createSocialStore(options: SocialStoreOptions): SocialStore {
  const backend =
    options.dbDir === undefined
      ? createMemoryBackend()
      : createSqliteBackend(join(options.dbDir, 'social.sqlite'))

  return {
    workspace_id: options.workspace_id,
    accounts: (filter) =>
      backend
        .all<SocialAccount>('social_account')
        .filter((a) => filter?.channel === undefined || a.channel === filter.channel),
    account: (id) => backend.get<SocialAccount>('social_account', id),
    posts: (filter) =>
      backend
        .all<SocialPost>('social_post')
        .filter((p) => filter?.channel === undefined || p.channel === filter.channel)
        .filter((p) => filter?.account_id === undefined || p.account_id === filter.account_id)
        .filter((p) => filter?.status === undefined || p.status === filter.status),
    post: (id) => backend.get<SocialPost>('social_post', id),
    members: (filter) =>
      backend
        .all<CommunityMember>('community_member')
        .filter((m) => filter?.channel === undefined || m.channel === filter.channel)
        .filter((m) => filter?.account_id === undefined || m.account_id === filter.account_id)
        // 「待审入群」= 递了申请还没批的那些
        .filter((m) => filter?.pending !== true || m.status === 'pending'),
    threads: (filter) =>
      backend
        .all<CommunityThread>('community_thread')
        .filter((t) => filter?.channel === undefined || t.channel === filter.channel)
        .filter((t) => filter?.account_id === undefined || t.account_id === filter.account_id)
        .filter((t) => filter?.surface === undefined || t.surface === filter.surface)
        // 转给客服的那些**不算**社媒运营的待处理：球在客服那边（56 边界行）
        .filter((t) => filter?.open !== true || t.status === 'open'),
    thread: (id) => backend.get<CommunityThread>('community_thread', id),

    saveAccount: (row) => backend.put('social_account', row.id, row),
    savePost: (row) => backend.put('social_post', row.id, row),
    saveMember: (row) => backend.put('community_member', row.id, row),
    saveThread: (row) => backend.put('community_thread', row.id, row),

    recordMetrics: ({ post_id, metrics, observed_at }) => {
      const post = backend.get<SocialPost>('social_post', post_id)
      if (post === undefined) return
      backend.put('social_post', post.id, { ...post, metrics, metrics_observed_at: observed_at })
    },

    recordTriage: ({ thread_id, triage, routed_approval_id }) => {
      const thread = backend.get<CommunityThread>('community_thread', thread_id)
      if (thread === undefined) return
      backend.put('community_thread', thread.id, {
        ...thread,
        triage,
        ...(routed_approval_id === undefined
          ? {}
          : { routed_approval_id, status: 'routed_to_support' }),
      })
    },

    close: () => backend.close(),
  }
}

/** 近 30 天：算"表现"那一块的窗口。 */
const THIRTY_DAYS = 30 * 86_400_000
/** 活跃度按 7 天算（56 §2 那一块要回答的是"这个群这周还有人说话吗"）。 */
const SEVEN_DAYS = 7 * 86_400_000
/** 每块最多端多少行——面板不是导出。 */
const MAX_ROWS = 20

/** 正文摘要：卡面与表格上那一列。**原样截断，不改写**（外部文本，21 §1）。 */
function excerpt(text: string, max = 60): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length <= max ? one : `${one.slice(0, max)}…`
}

/**
 * `SocialStore` → 面板那几块要的那份投影（56 §2）。
 *
 * 放在这里而不是 deck 里：deck 是**纯**的（29 §1，它连库都不认识），
 * 而这一步要跨三张表把"这条线程是哪个号下面的"拼出来。deck 拿到的已经是算好的行。
 *
 * 三件事在这一跳定死：
 *
 * 1. **每一行都带 `channel`**。九条职责共用同一份投影，面板那一层按自己那条渠道筛
 *    （`socialChannelOfRole`）——不在这里按职责切，切了就得算九遍。
 * 2. **数字原样端出去**：曝光 / 互动是拉数那一跳回填的，拿不到的一律留空，**不补 0**
 *    （"这个平台不给这个数"与"这个数是 0"在面板上必须分得开，见契约 `SocialPostMetrics`）。
 * 3. **转客服的线程只出现在「转客服」那一块**，不出现在"待回评论 / 待处理帖子"里：
 *    球在客服那边，社媒运营的队列里留着它只会让人重复回一遍（56 边界行）。
 */
export function socialDeckData(
  store: Pick<SocialStore, 'accounts' | 'posts' | 'members' | 'threads'>,
  options: { now?: string } = {},
): SocialDeckData {
  const nowMs = options.now === undefined ? Number.NaN : Date.parse(options.now)
  const accounts = new Map(store.accounts().map((a) => [a.id, a]))
  const accountName = (id: string): string => accounts.get(id)?.display_name ?? id
  const posts = store.posts()
  const threads = store.threads()

  const at = (iso: string | undefined): number => (iso === undefined ? Number.NaN : Date.parse(iso))
  const within = (iso: string | undefined, span: number): boolean => {
    const ms = at(iso)
    return !Number.isNaN(ms) && !Number.isNaN(nowMs) && nowMs - ms <= span && ms <= nowMs
  }

  /** 日历：排好期的与已发的，按时间正序——面板读下来就是这一周的顺序。 */
  const calendar = posts
    .filter((p) => p.status === 'scheduled' || p.status === 'published' || p.status === 'failed')
    .slice()
    .sort((a, b) => at(a.scheduled_at ?? a.published_at) - at(b.scheduled_at ?? b.published_at))
    .slice(0, MAX_ROWS)
    .map((p) => ({
      post_id: p.id,
      channel: p.channel as string,
      account: accountName(p.account_id),
      kind: p.kind as string,
      status: p.status as string,
      ...(p.scheduled_at === undefined ? {} : { scheduled_at: p.scheduled_at }),
      // 已发的那条没有排期时间也要有个时刻——日历上"什么时候"那一列不能空着
      ...(p.published_at === undefined ? {} : { published_at: p.published_at }),
      excerpt: excerpt(p.body),
      // 平台退回来的原因原样显示，不翻译成"出错了"（契约 `SocialPost.failure_reason`）
      ...(p.failure_reason === undefined ? {} : { failure_reason: p.failure_reason }),
    }))

  /** 待发布队列：草稿与排期（还没出去的那些），最急的在最上面。 */
  const queue = posts
    .filter((p) => p.status === 'draft' || p.status === 'scheduled')
    .slice()
    .sort((a, b) => at(a.scheduled_at) - at(b.scheduled_at))
    .slice(0, MAX_ROWS)
    .map((p) => ({
      post_id: p.id,
      channel: p.channel as string,
      account: accountName(p.account_id),
      status: p.status as string,
      ...(p.scheduled_at === undefined ? {} : { scheduled_at: p.scheduled_at }),
      excerpt: excerpt(p.body),
    }))

  /** 近 30 天表现：只算**已发**的。数字拿不到就留空，不补 0。 */
  const performance = posts
    .filter((p) => p.status === 'published' && within(p.published_at, THIRTY_DAYS))
    .slice()
    .sort((a, b) => at(b.published_at) - at(a.published_at))
    .slice(0, MAX_ROWS)
    .map((p) => ({
      post_id: p.id,
      channel: p.channel as string,
      account: accountName(p.account_id),
      ...(p.published_at === undefined ? {} : { published_at: p.published_at }),
      excerpt: excerpt(p.body, 40),
      ...(p.metrics?.impressions === undefined ? {} : { impressions: p.metrics.impressions }),
      ...(p.metrics?.views === undefined ? {} : { views: p.metrics.views }),
      ...(p.metrics?.likes === undefined ? {} : { likes: p.metrics.likes }),
      ...(p.metrics?.comments === undefined ? {} : { comments: p.metrics.comments }),
      ...(p.metrics?.new_followers === undefined ? {} : { new_followers: p.metrics.new_followers }),
      ...(p.metrics_observed_at === undefined ? {} : { observed_at: p.metrics_observed_at }),
    }))

  const openThreads = threads.filter((t) => t.status === 'open')
  const threadRow = (t: CommunityThread) => ({
    thread_id: t.id,
    channel: t.channel as string,
    account: accountName(t.account_id),
    surface: t.surface as string,
    author: t.author_handle,
    excerpt: excerpt(t.text),
    created_at: t.created_at,
    ...(t.triage === undefined ? {} : { triage: t.triage as string }),
  })
  const byOldest = (a: CommunityThread, b: CommunityThread): number =>
    at(a.created_at) - at(b.created_at)

  /** 待回评论：评论区那一面（内容组看的）。 */
  const pending_comments = openThreads
    .filter((t) => t.surface === 'comment')
    .slice()
    .sort(byOldest)
    .slice(0, MAX_ROWS)
    .map(threadRow)

  /** 待处理帖子：群里的帖子与私信（社群组看的）。 */
  const pending_threads = openThreads
    .filter((t) => t.surface !== 'comment')
    .slice()
    .sort(byOldest)
    .slice(0, MAX_ROWS)
    .map(threadRow)

  /** 转客服：判成客户问题、已经出了卡的那些。计数与清单在同一张表里。 */
  const handoffs = threads
    .filter((t) => t.triage === 'customer_question')
    .slice()
    .sort((a, b) => at(b.created_at) - at(a.created_at))
    .slice(0, MAX_ROWS)
    .map((t) => ({
      ...threadRow(t),
      status: t.status as string,
      ...(t.routed_approval_id === undefined ? {} : { approval_id: t.routed_approval_id }),
    }))

  /** 待审入群：递了申请还没批的。 */
  const pending_members = store
    .members({ pending: true })
    .slice()
    .sort((a, b) => at(a.joined_at) - at(b.joined_at))
    .slice(0, MAX_ROWS)
    .map((m) => ({
      member_id: m.id,
      channel: m.channel as string,
      account: accountName(m.account_id),
      handle: m.handle,
      ...(m.display_name === undefined ? {} : { display_name: m.display_name }),
      ...(m.joined_at === undefined ? {} : { applied_at: m.joined_at }),
      // 申请答案**只报条数**：那是外部文本，原文进面板等于把它塞进每个人的眼睛里
      answers: m.application_answers?.length ?? 0,
    }))

  /**
   * 活跃度：一条渠道一行（一条渠道上有几个号就合几行，因为面板按渠道看）。
   *
   * 三个数各有各的含义，不合成一个"健康分"：成员数是存量、近 7 天发言人数是流量、
   * 待处理是欠账。合成一个分之后没人答得上"到底哪儿不对"。
   */
  const activity = store
    .accounts()
    .filter((a) => a.member_count !== undefined || a.followers !== undefined)
    .map((a) => {
      const members = store.members({ account_id: a.id })
      return {
        account_id: a.id,
        channel: a.channel as string,
        account: a.display_name,
        ...(a.member_count === undefined ? {} : { member_count: a.member_count }),
        ...(a.followers === undefined ? {} : { followers: a.followers }),
        active_7d: members.filter((m) => within(m.last_active_at, SEVEN_DAYS)).length,
        pending_members: members.filter((m) => m.status === 'pending').length,
        open_threads: openThreads.filter((t) => t.account_id === a.id).length,
        observed_at: a.observed_at,
      }
    })

  /** 群发队列：排着的那几条群发（`kind: 'post'` 里 surface 不分——群发就是一条帖子）。 */
  const broadcasts = posts
    .filter((p) => p.status === 'draft' || p.status === 'scheduled')
    .filter((p) => accounts.get(p.account_id)?.member_count !== undefined)
    .slice()
    .sort((a, b) => at(a.scheduled_at) - at(b.scheduled_at))
    .slice(0, MAX_ROWS)
    .map((p) => ({
      post_id: p.id,
      channel: p.channel as string,
      account: accountName(p.account_id),
      ...(p.scheduled_at === undefined ? {} : { scheduled_at: p.scheduled_at }),
      excerpt: excerpt(p.body),
      // 受众数从账号上的成员数来；抑制剔除数由群发那一跳算完写在卡上，不在这儿猜
      ...(accounts.get(p.account_id)?.member_count === undefined
        ? {}
        : { audience: accounts.get(p.account_id)?.member_count as number }),
    }))

  return {
    calendar,
    queue,
    performance,
    pending_comments,
    pending_threads,
    pending_members,
    activity,
    broadcasts,
    handoffs,
  }
}

/**
 * `agentsws demo` 用的那几条社媒数据。
 *
 * 为什么要有它：社媒库是**我们自己的库**，不是连接器——所以合成世界（`packs/`）
 * 里没有它的行，而 demo 里如果这几块全是空的，社媒运营这个岗位在演示与截图里
 * 就看不出任何东西（同 `seedDemoKol`）。
 *
 * 数据本身是**演示数据**，不是假装的真数据：两个号（一个 Meta 主页、一个 Discord
 * 服务器）、五条帖子（排期 / 已发 / 草稿 / 退回各有）、三个入群申请、四条线程
 * （其中一条是客户问题——它就是 56 那条边界在演示里的落点）。一个 token 都不放。
 */
export function seedDemoSocial(store: SocialStore, now: string): void {
  if (store.accounts().length > 0) return
  const nowMs = Date.parse(now)
  const iso = (offsetMs: number): string => new Date(nowMs + offsetMs).toISOString()
  const DAY = 86_400_000
  const observed_at = now

  store.saveAccount({
    id: 'sa_demo_meta',
    workspace_id: store.workspace_id,
    channel: 'meta',
    handle: '@nordvolt',
    display_name: 'Nordvolt 主页',
    url: 'https://www.facebook.com/nordvolt',
    external_id: '100000000000001',
    followers: 12_400,
    observed_at,
  })
  store.saveAccount({
    id: 'sa_demo_discord',
    workspace_id: store.workspace_id,
    channel: 'discord',
    handle: 'nordvolt-desk',
    display_name: 'Nordvolt 桌面党',
    url: 'https://discord.gg/nordvolt',
    external_id: '900000000000001',
    member_count: 860,
    observed_at,
  })

  store.savePost({
    id: 'sp_demo_1',
    account_id: 'sa_demo_meta',
    channel: 'meta',
    kind: 'image',
    status: 'published',
    body: '65W 桌面充电器上新：一个口喂饱笔记本、手机和耳机。',
    published_at: iso(-3 * DAY),
    external_id: 'fb_1',
    metrics: { impressions: 18_200, likes: 412, comments: 37, new_followers: 63 },
    metrics_observed_at: now,
  })
  store.savePost({
    id: 'sp_demo_2',
    account_id: 'sa_demo_meta',
    channel: 'meta',
    kind: 'post',
    status: 'scheduled',
    body: '周四晚八点开一场桌面收纳直播，来的人送线材收纳夹。',
    scheduled_at: iso(2 * DAY),
  })
  store.savePost({
    id: 'sp_demo_3',
    account_id: 'sa_demo_meta',
    channel: 'meta',
    kind: 'image',
    status: 'failed',
    body: '春季桌面焕新合集（九宫格）。',
    scheduled_at: iso(-1 * DAY),
    // 平台退回来的原话原样留着——混进"排期中"里就再也没人发现它没发出去
    failure_reason: '图片比例不符合要求（需要 4:5 至 1.91:1）',
  })
  store.savePost({
    id: 'sp_demo_4',
    account_id: 'sa_demo_discord',
    channel: 'discord',
    kind: 'post',
    status: 'scheduled',
    body: '【群公告】周四直播同步开麦，#桌面秀 频道发图抽三位送充电器。',
    scheduled_at: iso(1 * DAY),
  })
  store.savePost({
    id: 'sp_demo_5',
    account_id: 'sa_demo_discord',
    channel: 'discord',
    kind: 'post',
    status: 'draft',
    body: '【群公告】新版群规草稿：外链只允许发在 #资源 频道。',
  })

  store.saveMember({
    id: 'cm_demo_1',
    account_id: 'sa_demo_discord',
    channel: 'discord',
    external_id: 'u_1001',
    handle: 'deskhero',
    display_name: 'Desk Hero',
    status: 'pending',
    joined_at: iso(-2 * 3_600_000),
    application_answers: ['在用 Nordvolt 的 65W', '想看别人的桌面'],
  })
  store.saveMember({
    id: 'cm_demo_2',
    account_id: 'sa_demo_discord',
    channel: 'discord',
    external_id: 'u_1002',
    handle: 'cheap_cables_24h',
    status: 'pending',
    joined_at: iso(-1 * 3_600_000),
    application_answers: ['dm me for cheap cables'],
  })
  store.saveMember({
    id: 'cm_demo_3',
    account_id: 'sa_demo_discord',
    channel: 'discord',
    external_id: 'u_1003',
    handle: 'linaw',
    display_name: 'Lina W.',
    status: 'active',
    joined_at: iso(-40 * DAY),
    last_active_at: iso(-4 * 3_600_000),
  })

  store.saveThread({
    id: 'ct_demo_1',
    account_id: 'sa_demo_meta',
    channel: 'meta',
    external_id: 'fb_c_1',
    surface: 'comment',
    author_external_id: 'u_2001',
    author_handle: 'mikez',
    text: '这个能给 MacBook Pro 16 满速充吗？',
    created_at: iso(-6 * 3_600_000),
    status: 'open',
  })
  store.saveThread({
    id: 'ct_demo_2',
    account_id: 'sa_demo_meta',
    channel: 'meta',
    external_id: 'fb_c_2',
    surface: 'comment',
    author_external_id: 'u_2002',
    author_handle: 'tinaq',
    text: '桌面照拍得真好看，求同款显示器支架链接。',
    created_at: iso(-5 * 3_600_000),
    status: 'open',
  })
  // 56 那条边界在演示里的落点：这一条是**客户的问题**，社媒运营不答，转客服
  store.saveThread({
    id: 'ct_demo_3',
    account_id: 'sa_demo_discord',
    channel: 'discord',
    external_id: 'dc_t_1',
    surface: 'thread',
    author_external_id: 'u_1003',
    author_handle: 'linaw',
    text: '我上周下的单到现在还没发货，单号 #10231，什么时候能寄出？',
    created_at: iso(-3 * 3_600_000),
    status: 'routed_to_support',
    triage: 'customer_question',
  })
  store.saveThread({
    id: 'ct_demo_4',
    account_id: 'sa_demo_discord',
    channel: 'discord',
    external_id: 'dc_t_2',
    surface: 'thread',
    author_external_id: 'u_1002',
    author_handle: 'cheap_cables_24h',
    text: '低价线材批发，加我私聊 →',
    created_at: iso(-2 * 3_600_000),
    status: 'open',
    triage: 'spam',
  })
}
