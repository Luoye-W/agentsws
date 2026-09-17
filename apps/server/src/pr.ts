/**
 * 公关库的存储（60 §5 数据面，WP78）。
 *
 * 四类对象（`media_contact` / `press_release` / `mention` / `external_post`）落在
 * **这个品牌自己的**目录下（WP66 的 `BrandModules`：bootstrap 品牌用原来那个目录，
 * 别的品牌在 `<dbDir>/brands/<workspace_id>/` 下）。形状照 `social.ts` 抄：
 * 一张表一列 json，后端要么 sqlite 要么全内存（测试与一次性任务）。
 *
 * 四条纪律：
 *
 * 1. **联系方式明文一格都没有**。`MediaContact.email_ref` 是本机加密库里的
 *    key 名，`email_masked` 是 `a***@x.com`——这两格都进不了一封信
 *    （同 48 §5.2 的 `CreatorContact.value_ref`）。
 * 2. **提及先去重再落库**。`Mention.dedupe_key` 由 `@agentsws/pr-core` 的
 *    `mentionKey` 算；{@link PrStore.saveMention} 按它查重，重复的只把
 *    `seen_count` 加一——"今天有 40 条负面"这句话只有在去过重之后才是真的。
 * 3. **判类结论跟着提及走，回复不在这里发生**。判成客户问题的那一条，这里记的是
 *    `routed_approval_id`（那张转客服卡），**不是**一段答复——答是客服的事
 *    （60 分界行）。
 * 4. **版规结论跟着帖子走**。`ExternalPost.rules_checked` 是提案那一跳算完写进来的，
 *    读的时候原样端出去；面板上"版规过没过"那一列不在渲染时现判
 *    （版规是会改的东西，现判等于用今天的规矩解释昨天的决定）。
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type {
  ExternalPost,
  MediaContact,
  Mention,
  MentionSentiment,
  MentionTriage,
  PressRelease,
  WorkspaceId,
} from '@agentsws/contracts'
import { extractFigures, uncitedFigures } from '@agentsws/core'
import type { PrDeckData, PrMentionRow } from '@agentsws/deck'
import { pitchFunnel } from '@agentsws/pr-core'
import type BetterSqlite3 from 'better-sqlite3'

/** 库里的四张表。名字与对象类型一一对应，不另起别名。 */
export type PrTable = 'media_contact' | 'press_release' | 'mention' | 'external_post'

export const PR_TABLES: readonly PrTable[] = [
  'media_contact',
  'press_release',
  'mention',
  'external_post',
]

/**
 * 一条提及在库里多出来的两格。
 *
 * `seen_count` 是**被转了几次**：同一条新闻被十几个站转载，去重之后是一条，
 * 但"被转了 30 次"正是舆情要不要升级的判据（`pr-core` 的 `dedupeMentions`
 * 在一批里算，这里在时间上累加）。
 */
export interface StoredMention extends Mention {
  seen_count: number
}

interface PrBackend {
  all<T>(table: PrTable): T[]
  get<T>(table: PrTable, id: string): T | undefined
  put(table: PrTable, id: string, row: unknown): void
  remove(table: PrTable, id: string): void
  close(): void
}

function createMemoryBackend(): PrBackend {
  const tables = new Map<PrTable, Map<string, unknown>>()
  const of = (t: PrTable): Map<string, unknown> => {
    const found = tables.get(t)
    if (found !== undefined) return found
    const fresh = new Map<string, unknown>()
    tables.set(t, fresh)
    return fresh
  }
  return {
    all: <T>(t: PrTable) => [...of(t).values()].map((r) => structuredClone(r) as T),
    get: <T>(t: PrTable, id: string) => {
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

const SCHEMA = PR_TABLES.map(
  (t) => `CREATE TABLE IF NOT EXISTS pr_${t} (id TEXT PRIMARY KEY, json TEXT NOT NULL);`,
).join('\n')

function createSqliteBackend(dbPath: string): PrBackend {
  const require = createRequire(import.meta.url)
  const Database = require('better-sqlite3') as typeof BetterSqlite3
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA)
  return {
    all: <T>(t: PrTable) =>
      (db.prepare(`SELECT json FROM pr_${t} ORDER BY id`).all() as { json: string }[]).map(
        (r) => JSON.parse(r.json) as T,
      ),
    get: <T>(t: PrTable, id: string) => {
      const row = db.prepare(`SELECT json FROM pr_${t} WHERE id = ?`).get(id) as
        | { json: string }
        | undefined
      return row === undefined ? undefined : (JSON.parse(row.json) as T)
    },
    put: (t, id, row) => {
      db.prepare(
        `INSERT INTO pr_${t} (id, json) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET json = excluded.json`,
      ).run(id, JSON.stringify(row))
    },
    remove: (t, id) => {
      db.prepare(`DELETE FROM pr_${t} WHERE id = ?`).run(id)
    },
    close: () => {
      db.close()
    },
  }
}

export interface PrStoreOptions {
  workspace_id: WorkspaceId
  /** 这个品牌的落盘目录（`BrandModules` 给的那一个）。不给就全内存。 */
  dbDir?: string
}

export interface PrStore {
  readonly workspace_id: WorkspaceId
  contacts(filter?: { stage?: MediaContact['stage']; beat?: string }): MediaContact[]
  contact(id: string): MediaContact | undefined
  releases(filter?: { status?: PressRelease['status'] }): PressRelease[]
  release(id: string): PressRelease | undefined
  mentions(filter?: {
    sentiment?: MentionSentiment
    triage?: MentionTriage
    /** 只要还没处理完的（`new` / `triaged`）。 */
    open?: boolean
  }): StoredMention[]
  mention(id: string): StoredMention | undefined
  posts(filter?: { platform?: string; status?: ExternalPost['status'] }): ExternalPost[]
  post(id: string): ExternalPost | undefined

  saveContact(row: MediaContact): void
  saveRelease(row: PressRelease): void
  savePost(row: ExternalPost): void
  /**
   * 落一条提及。**按 `dedupe_key` 查重**（文件头第 2 条）。
   *
   * 已经有一条同键的：只把 `seen_count` 加一，并把 `published_at` 往早了取
   * （转载链上第一条多半是原发）；判类结论与卡 id **一个字不动**——
   * 同一条新闻被再转一次，不该把它已经定下来的归属重置掉。
   *
   * 回的是库里那一条（新的或已有的），以及它是不是新的。
   */
  saveMention(row: Mention): { mention: StoredMention; created: boolean }
  /**
   * 判类那一跳的结论写回提及（`@agentsws/pr-core` 的 `triageMention` 算的）。
   *
   * 判成客户问题的那一条带着转客服卡的 id 一起写回来——提及从此归客服
   * （`status: 'routed_to_support'`），公关这边的队列里它就不再是"待处理"。
   */
  recordTriage(input: {
    mention_id: string
    triage: MentionTriage
    sentiment: MentionSentiment
    routed_approval_id?: string
    alert_approval_id?: string
  }): void
  /** 露出之后的反馈回填（赞 / 回复 / 被删）。帖子不在就什么也不做，**不凭空建一条**。 */
  recordFeedback(input: { post_id: string; feedback: NonNullable<ExternalPost['feedback']> }): void
  close(): void
}

/** 还没处理完的那两档（面板"提及流"读它）。 */
const OPEN_STATUSES: readonly Mention['status'][] = ['new', 'triaged']

export function createPrStore(options: PrStoreOptions): PrStore {
  const backend =
    options.dbDir === undefined
      ? createMemoryBackend()
      : createSqliteBackend(join(options.dbDir, 'pr.sqlite'))

  const findByKey = (key: string): StoredMention | undefined =>
    backend.all<StoredMention>('mention').find((m) => m.dedupe_key === key)

  return {
    workspace_id: options.workspace_id,

    contacts: (filter) =>
      backend
        .all<MediaContact>('media_contact')
        .filter((c) => filter?.stage === undefined || c.stage === filter.stage)
        .filter((c) => filter?.beat === undefined || c.beats.includes(filter.beat)),
    contact: (id) => backend.get<MediaContact>('media_contact', id),

    releases: (filter) =>
      backend
        .all<PressRelease>('press_release')
        .filter((r) => filter?.status === undefined || r.status === filter.status),
    release: (id) => backend.get<PressRelease>('press_release', id),

    mentions: (filter) =>
      backend
        .all<StoredMention>('mention')
        .filter((m) => filter?.sentiment === undefined || m.sentiment === filter.sentiment)
        .filter((m) => filter?.triage === undefined || m.triage === filter.triage)
        // 转给客服的那些**不算**公关的待处理：球在客服那边（60 分界行）
        .filter((m) => filter?.open !== true || OPEN_STATUSES.includes(m.status)),
    mention: (id) => backend.get<StoredMention>('mention', id),

    posts: (filter) =>
      backend
        .all<ExternalPost>('external_post')
        .filter((p) => filter?.platform === undefined || p.platform === filter.platform)
        .filter((p) => filter?.status === undefined || p.status === filter.status),
    post: (id) => backend.get<ExternalPost>('external_post', id),

    saveContact: (row) => backend.put('media_contact', row.id, row),
    saveRelease: (row) => backend.put('press_release', row.id, row),
    savePost: (row) => backend.put('external_post', row.id, row),

    saveMention: (row) => {
      const found = findByKey(row.dedupe_key)
      if (found === undefined) {
        const fresh: StoredMention = { ...row, seen_count: 1 }
        backend.put('mention', fresh.id, fresh)
        return { mention: fresh, created: true }
      }
      const merged: StoredMention = {
        ...found,
        seen_count: found.seen_count + 1,
        // 原发那一条的时刻更早，取早的；判类结论与卡 id 一个字不动（见接口注释）
        published_at:
          Date.parse(row.published_at) < Date.parse(found.published_at)
            ? row.published_at
            : found.published_at,
        observed_at: row.observed_at,
      }
      backend.put('mention', merged.id, merged)
      return { mention: merged, created: false }
    },

    recordTriage: ({ mention_id, triage, sentiment, routed_approval_id, alert_approval_id }) => {
      const row = backend.get<StoredMention>('mention', mention_id)
      if (row === undefined) return
      backend.put('mention', row.id, {
        ...row,
        triage,
        sentiment,
        status: routed_approval_id === undefined ? 'triaged' : 'routed_to_support',
        ...(routed_approval_id === undefined ? {} : { routed_approval_id }),
        ...(alert_approval_id === undefined ? {} : { alert_approval_id }),
      })
    },

    recordFeedback: ({ post_id, feedback }) => {
      const row = backend.get<ExternalPost>('external_post', post_id)
      if (row === undefined) return
      backend.put('external_post', row.id, {
        ...row,
        feedback,
        // 被删了就照实改状态——混在"已发布"里，那条露出在报表上会一直算数
        ...(feedback.removed === true ? { status: 'removed' as const } : {}),
      })
    },

    close: () => backend.close(),
  }
}

/** 每块最多端多少行——面板不是导出。 */
const MAX_ROWS = 20

/** 正文摘要：卡面与表格上那一列。**原样截断，不改写**（外部文本，21 §1）。 */
function excerpt(text: string, max = 60): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length <= max ? one : `${one.slice(0, max)}…`
}

/**
 * `PrStore` → 面板那五块要的那份投影（60 §3）。
 *
 * 放在这里而不是 deck 里：deck 是**纯**的（29 §1，它连库都不认识），
 * 而这一步要把稿子里的数字数一遍、把媒体名单折成六档漏斗。deck 拿到的已经是算好的行。
 *
 * 三件事在这一跳定死：
 *
 * 1. **数字的两个数在这里算**（`figures` 与 `facts_cited`），用的是
 *    `@agentsws/core` 的 `extractFigures` / `uncitedFigures`——与 guardrail
 *    拦下那一条时读的是同一份代码，不存在"面板说 6 个、门说 7 个"。
 * 2. **转客服的提及只出现在「转客服」那一块**，不出现在提及流与预警里：
 *    球在客服那边，公关的队列里留着它只会让人重复处理一遍（60 分界行）。
 * 3. **负面预警按传播量排**，不按时间：一条被转了 30 次的旧负面，比一条刚出现
 *    的孤立抱怨更要紧。
 */
export function prDeckData(
  store: Pick<PrStore, 'contacts' | 'releases' | 'mentions' | 'posts'>,
): PrDeckData {
  const at = (iso: string | undefined): number => (iso === undefined ? Number.NaN : Date.parse(iso))
  const all = store.mentions()

  const row = (m: StoredMention): PrMentionRow => ({
    mention_id: m.id,
    source: m.source as string,
    origin: m.origin,
    url: m.url,
    excerpt: excerpt(m.title ?? m.text),
    ...(m.author === undefined ? {} : { author: m.author }),
    published_at: m.published_at,
    ...(m.sentiment === undefined ? {} : { sentiment: m.sentiment as string }),
    ...(m.triage === undefined ? {} : { triage: m.triage as string }),
    status: m.status as string,
  })

  /** 提及流：转出去的那些不在这里（第 2 条）。 */
  const mentions = all
    .filter((m) => m.triage !== 'customer_issue')
    .slice()
    .sort((a, b) => at(b.published_at) - at(a.published_at))
    .slice(0, MAX_ROWS)
    .map(row)

  /** 负面预警：判成舆情且是负面的，**按被转了几次排**（第 3 条）。 */
  const negative_alerts = all
    .filter((m) => m.sentiment === 'negative' && m.triage === 'reputation')
    .slice()
    .sort((a, b) => b.seen_count - a.seen_count || at(b.published_at) - at(a.published_at))
    .slice(0, MAX_ROWS)
    .map((m) => ({ ...row(m), seen_count: m.seen_count }))

  /** 转客服：判成客户问题的那些（计数与清单在同一张表里）。 */
  const handoffs = all
    .filter((m) => m.triage === 'customer_issue')
    .slice()
    .sort((a, b) => at(b.published_at) - at(a.published_at))
    .slice(0, MAX_ROWS)
    .map((m) => ({
      ...row(m),
      ...(m.routed_approval_id === undefined ? {} : { approval_id: m.routed_approval_id }),
    }))

  /** 待发新闻稿：草稿与批过还没发的（发出去的那些不再是"待发"）。 */
  const releases = store
    .releases()
    .filter((r) => r.status === 'draft' || r.status === 'approved')
    .slice()
    .sort((a, b) => at(b.updated_at) - at(a.updated_at))
    .slice(0, MAX_ROWS)
    .map((r) => {
      const figures = extractFigures(r.body)
      const uncited = uncitedFigures(
        r.body,
        r.facts_cited.map((c) => c.figure),
      )
      return {
        release_id: r.id,
        status: r.status as string,
        headline: r.headline,
        // 两个数不等 = 有数没出处。**在这里算**，与 guardrail 同一份代码
        figures: figures.length,
        facts_cited: figures.length - uncited.length,
        ...(r.embargo_until === undefined ? {} : { embargo_until: r.embargo_until }),
        updated_at: r.updated_at,
      }
    })

  /** pitch 漏斗：六档都出一行（`pr-core` 那一份，不在这里再排一次顺序）。 */
  const pitch_funnel = pitchFunnel(store.contacts())

  /** 外部露出：最近的在最上面；被删的那一条要看得见。 */
  const external_posts = store
    .posts()
    .slice()
    .sort((a, b) => at(b.published_at ?? b.created_at) - at(a.published_at ?? a.created_at))
    .slice(0, MAX_ROWS)
    .map((p) => ({
      post_id: p.id,
      platform: p.platform,
      venue: p.venue,
      status: p.status as string,
      excerpt: excerpt(p.title ?? p.body),
      rules_ok: p.rules_checked.ok,
      ...(p.rules_checked.reasons.length === 0
        ? {}
        : { rules_reasons: p.rules_checked.reasons.join('、') }),
      ...(p.published_at === undefined ? {} : { published_at: p.published_at }),
      ...(p.feedback?.score === undefined ? {} : { score: p.feedback.score }),
      ...(p.feedback?.replies === undefined ? {} : { replies: p.feedback.replies }),
      ...(p.feedback?.removed === undefined ? {} : { removed: p.feedback.removed }),
    }))

  return { mentions, negative_alerts, releases, pitch_funnel, external_posts, handoffs }
}

/**
 * `agentsws demo` 用的那几条公关数据。
 *
 * 为什么要有它：公关库是**我们自己的库**，不是连接器——所以合成世界（`packs/`）
 * 里没有它的行，而 demo 里如果这几块全是空的，公共关系这个岗位在演示与截图里
 * 就看不出任何东西（同 `seedDemoSocial` / `seedDemoKol`）。
 *
 * 数据本身是**演示数据**，不是假装的真数据：三个媒体联系人（邮箱只有脱敏那一格）、
 * 两篇稿子（一篇数字齐全、一篇故意少一个出处）、五条提及（负面 / 正面 / 客户问题
 * 各有——那条客户问题就是 60 分界行在演示里的落点）、两条外部露出（一条被版规
 * 拦下、一条发出去了并有反馈）。一个 token、一个真邮箱都不放。
 */
export function seedDemoPr(store: PrStore, now: string): void {
  if (store.releases().length > 0 || store.mentions().length > 0) return
  const nowMs = Date.parse(now)
  const iso = (offsetMs: number): string => new Date(nowMs + offsetMs).toISOString()
  const DAY = 86_400_000
  const ws = store.workspace_id

  for (const c of [
    {
      id: 'mc_lin',
      kind: 'journalist' as const,
      name: '林书',
      outlet: '极客电源',
      beats: ['消费电子', '户外装备'],
      stage: 'pitched' as const,
      last_pitched_at: iso(-2 * DAY),
    },
    {
      id: 'mc_zhou',
      kind: 'blogger' as const,
      name: '周野',
      outlet: '野外笔记',
      beats: ['户外装备'],
      stage: 'covered' as const,
      last_covered_at: iso(-20 * DAY),
    },
    {
      id: 'mc_qi',
      kind: 'newsletter' as const,
      name: '齐橙',
      outlet: 'DTC 周报',
      beats: ['消费电子'],
      stage: 'new' as const,
    },
  ]) {
    store.saveContact({
      workspace_id: ws,
      url: `https://example.invalid/${c.id}`,
      // 明文不在库里：这里连 `email_ref` 都不放（demo 没有加密库条目）
      email_masked: `${c.name.slice(0, 1)}***@example.invalid`,
      created_at: iso(-30 * DAY),
      ...c,
    })
  }

  store.saveRelease({
    id: 'prl_launch',
    workspace_id: ws,
    status: 'draft',
    headline: 'Nordvolt 发布第二代户外电源',
    dek: 'Nordvolt 今天发布第二代户外电源，续航与充电速度都有提升。',
    body: '第二代机型续航提升 18%，快充功率提高到 140 瓦。首批 3,200 台将于本月出货。',
    quotes: [
      {
        speaker: '王岚，Nordvolt 创始人',
        text: '我们把电池管理重做了一遍，这一代能陪你多撑一个晚上。',
        provided_by: '王岚',
        provided_at: iso(-1 * DAY),
      },
    ],
    boilerplate: 'Nordvolt 做户外电源，2023 年成立，产品在 12 个国家销售。',
    contact: { name: '王岚', email: 'press@nordvolt.invalid' },
    facts_cited: [
      { figure: '18%', fact_card_id: 'fc_battery_life', statement: '二代续航比一代高 18%' },
      { figure: '140', fact_card_id: 'fc_charge_watt', statement: '快充功率 140 瓦' },
      { figure: '3,200', fact_card_id: 'fc_first_batch', statement: '首批产量 3,200 台' },
    ],
    created_at: iso(-2 * DAY),
    updated_at: iso(-1 * DAY),
  })

  /*
   * 第二篇故意少一个出处（"复购率 41%"没有对应的事实卡）——面板上那两个数
   * 会不相等，而它真要往外发的时候 guardrail 会直接拦下，理由是
   * "这个数字没有出处：41%"。demo 里留着它，是为了让人看见那道门长什么样。
   */
  store.saveRelease({
    id: 'prl_milestone',
    workspace_id: ws,
    status: 'draft',
    headline: 'Nordvolt 用户数破十万',
    dek: 'Nordvolt 今天宣布注册用户突破十万。',
    body: '注册用户达到 100,000 人，复购率 41%。',
    quotes: [],
    boilerplate: 'Nordvolt 做户外电源，2023 年成立，产品在 12 个国家销售。',
    contact: { name: '王岚', email: 'press@nordvolt.invalid' },
    facts_cited: [{ figure: '100,000', fact_card_id: 'fc_users', statement: '注册用户 10 万' }],
    created_at: iso(-4 * DAY),
    updated_at: iso(-3 * DAY),
  })

  const mentions: {
    id: string
    source: Mention['source']
    origin: string
    title: string
    text: string
    author?: string
    days: number
    sentiment: MentionSentiment
    triage: MentionTriage
    status: Mention['status']
    seen: number
  }[] = [
    {
      id: 'mn_recall',
      source: 'reddit',
      origin: 'r/gadgets',
      title: '这个牌子的电源用两周就漏电，避雷',
      text: '买了一个月，最近开始发烫，已经申请退货了。大家避雷。',
      author: 'linaw',
      days: -1,
      sentiment: 'negative',
      triage: 'reputation',
      status: 'triaged',
      seen: 7,
    },
    {
      id: 'mn_review',
      source: 'news',
      origin: 'geekpower.invalid',
      title: 'Nordvolt 二代评测：续航是真的',
      text: '实测比上一代多撑了一晚，做工扎实，值得推荐。',
      days: -2,
      sentiment: 'positive',
      triage: 'praise',
      status: 'triaged',
      seen: 3,
    },
    {
      id: 'mn_order',
      source: 'forum',
      origin: 'quora.com',
      title: '我的订单还没发货',
      text: '上周下的单到现在还没发货，单号 #10231，什么时候能寄出？',
      author: 'mikec',
      days: -1,
      sentiment: 'neutral',
      // 60 分界行在演示里的落点：这条**转客服**，公关一个字都不答
      triage: 'customer_issue',
      status: 'routed_to_support',
      seen: 1,
    },
    {
      id: 'mn_press',
      source: 'news',
      origin: 'dtcweekly.invalid',
      title: '想做一篇户外电源的横评',
      text: '我在写一篇关于户外电源的横评，press inquiry：能否提供一台样品？',
      author: '齐橙',
      days: -3,
      sentiment: 'neutral',
      triage: 'media_inquiry',
      status: 'triaged',
      seen: 1,
    },
    {
      id: 'mn_noise',
      source: 'other',
      origin: 'example.invalid',
      title: '有人用过这个牌子吗',
      text: '看到广告，不知道怎么样。',
      days: -4,
      sentiment: 'neutral',
      triage: 'noise',
      status: 'archived',
      seen: 1,
    },
  ]
  for (const m of mentions) {
    const url = `https://${m.origin.replace(/^r\//, 'www.reddit.com/r/')}/${m.id}`
    const saved = store.saveMention({
      id: m.id,
      workspace_id: ws,
      source: m.source,
      origin: m.origin,
      url,
      title: m.title,
      text: m.text,
      ...(m.author === undefined ? {} : { author: m.author }),
      published_at: iso(m.days * DAY),
      observed_at: now,
      status: m.status,
      dedupe_key: `url:${url}`,
    })
    store.recordTriage({
      mention_id: saved.mention.id,
      triage: m.triage,
      sentiment: m.sentiment,
      ...(m.triage === 'customer_issue' ? { routed_approval_id: 'ap_demo_handoff' } : {}),
    })
    // 转载量：再落同一条几次，`seen_count` 自己加上去（去重那一条纪律的演示）
    for (let i = 1; i < m.seen; i += 1)
      store.saveMention({
        id: m.id,
        workspace_id: ws,
        source: m.source,
        origin: m.origin,
        url,
        title: m.title,
        text: m.text,
        published_at: iso(m.days * DAY),
        observed_at: now,
        status: m.status,
        dedupe_key: `url:${url}`,
      })
  }

  store.savePost({
    id: 'ep_bifl',
    workspace_id: ws,
    role_id: 'pr.reddit',
    kind: 'post',
    platform: 'reddit',
    venue: 'BuyItForLife',
    title: '三年后拆开我们自己的一代产品',
    body: '把我们一代的机器拆了，说说哪几处设计撑住了三年、哪几处没撑住。',
    status: 'blocked',
    // 这个版禁自我推广——卡上原样写着理由，这一条永远发不出去
    rules_checked: {
      ok: false,
      reasons: ['no_self_promotion'],
      checked_at: iso(-1 * DAY),
    },
    created_at: iso(-1 * DAY),
  })
  store.savePost({
    id: 'ep_quora',
    workspace_id: ws,
    role_id: 'pr.forums',
    kind: 'answer',
    platform: 'quora',
    venue: 'outdoor-power',
    body: '选户外电源先看电芯类型与循环次数，再看快充功率。',
    status: 'published',
    rules_checked: { ok: true, reasons: [], checked_at: iso(-6 * DAY) },
    url: 'https://www.quora.com/q/demo',
    published_at: iso(-6 * DAY),
    feedback: { score: 34, replies: 5, observed_at: now },
    created_at: iso(-7 * DAY),
  })
}
