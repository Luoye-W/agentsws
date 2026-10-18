/**
 * WP328（docs/102，Luoye 10-14 定）：**Reddit 每日巡查**——社媒运营岗位（持有 `social.reddit` 的人）名下，每品牌一份。
 *
 * 一次巡查三块：
 * 1. 收件箱、2. 自家版块（新帖 + 新评论）——排一件只读活给**插件**（用户日常 Chrome 里已登录的品牌号会话），
 *    插件来领、读完交回（`next` / `result`）；插件没配对 / 没连 Reddit / 没登录 → 出连接卡（WP324），不硬读；
 * 3. 外部社区——全站关键词走第三方数据渠道（现有 Reddit 读能力），每个关键词一次。
 *
 * 读回来的按全名去重入库；收件箱里回的是我们发过的那条 → 挂到发出记录那一行下（WP323）；对方删了原话 → 我们也清掉。
 * 新的每条交给 AI 判「要不要回 / 为什么」（没有模型按规则兜底）；要回的进「待处理」，通知 WP329 起草（`onPending`）。
 * 库交成通用的 `WatchSource`（`watch-source.ts`）给报告积木（WP331：查巡查数据 / 立即巡查）；本单不起草、不发。
 *
 * 频率：一天一次起步，用户可改（WP331 起没有「周报触发的那一次」：要最新数据由 AI 出报告前调 `sweepNow`）。
 * 没有任何冷却 / 占比 / 身份声明之类的规矩。
 *
 * WP340（决策 836 / 834）：
 * - **重点版块**（别人的版）也由插件只读新帖，进「外部社区」那一类；**每个版块可单独设一周几次**（`due.ts` 的 `dueSubs`），
 *   一件活最多 12 路，排不下的版块留到下一拍；
 * - **告警词**本地匹配：命中的条目标「优先」、单独出一条提醒（同一条只一次，`onAlert` + 视图里的 `alerts`）；
 * - **标签词**本地匹配：给条目打标签（查巡查数据可按标签筛）；
 * - 配置卡第一次出时预填 **AI 按品牌档案给的建议**（`suggest.ts`；没模型就留空，只问一次、记下来）。
 */
import {
  normalizeSubreddit,
  Pace,
  REDDIT_PACE_LIMITS,
  REDDIT_READ_MAX_PARTS,
  type RedditListingItem,
  type RedditReadJob,
  type RedditReadNextResponse,
  type RedditReadRequest,
  type RedditReadResultInput,
  redditPaceKey,
} from '@agentsws/browser-action'
import {
  type ConnectNeed,
  type Iso8601,
  REDDIT_WATCH_ALERT_DAYS,
  type RedditWatchDigest,
  type RedditWatchEntry,
  type RedditWatchItemStatus,
  type RedditWatchPart,
  type RedditWatchRun,
  type RedditWatchRunPart,
  type RedditWatchSettings,
  type RedditWatchView,
  type RunRequest,
  redditWeekWindow,
  type WorkspaceId,
} from '@agentsws/contracts'
import type { RedditItem } from '@agentsws/social-core'
import type { OutboundLog } from '../outbound/log.js'
import type { SetupCardsAssembly, SetupTarget } from '../setup-cards.js'
import { buildDigest } from './digest.js'
import { dueParts, dueSubs, type PartClock } from './due.js'
import { externalItemOf, type IngestContext, watchItemOf } from './ingest.js'
import { type JudgeComplete, judgeItems } from './judge.js'
import { type PatrolPluginState, researchPatrol } from './plan.js'
import {
  isConfigured,
  REDDIT_WATCH_TARGET,
  readSettings,
  redditWatchSetupTarget,
  type SettingsSuggestions,
  writeSettings,
} from './settings.js'
import { patrolState } from './state.js'
import type { RedditWatchItemQuery, RedditWatchStore } from './store.js'
import { type PatrolBrandBrief, type PatrolSuggestion, suggestPatrol } from './suggest.js'
import { applyLocalMarks } from './terms.js'

/** 第三方数据渠道那一跳（全站搜关键词）。 */
export type RedditSearchResult =
  | { ok: true; items: RedditItem[] }
  | { ok: false; message: string; not_configured?: boolean }

export interface RedditWatchOptions {
  workspace_id: WorkspaceId
  store: RedditWatchStore
  now(): Iso8601
  newId(prefix: string): string
  /** 品牌时区（东八区 480）。 */
  tzOffsetMinutes(): number
  brandName?(): string | undefined
  /** 外部社区：全站搜一个关键词（按最新、限定时间窗）。不给 = 这一块没配。 */
  search?(input: {
    query: string
    time_window: 'day' | 'week'
    limit: number
  }): Promise<RedditSearchResult>
  /** AI 判断（不给 / 回 undefined = 只按规则）。 */
  complete?(): JudgeComplete | undefined
  /** 配置卡的建议值（WP249 登记的自家版 / 品牌号）。 */
  suggestions?(): SettingsSuggestions | undefined
  /** WP340：品牌档案（给 AI 出配置卡建议值用；没有就不建议）。 */
  brandBrief?(): MaybePromise<PatrolBrandBrief | undefined>
  setupCards?(): Promise<SetupCardsAssembly | undefined>
  /** 缺连接 / 缺设置的卡挂在谁名下（持有 `social.reddit` 的人）；没人持有就不出卡。 */
  actor?(): RunRequest['actor'] | undefined
  outbound?(): Pick<OutboundLog, 'addFollowUp' | 'counterpartDeleted'> | undefined
  /** 审计事件（只有 id、种类、数字；不含正文）。 */
  emit?(type: string, payload: Record<string, unknown>): void
  /** Reddit 号的节奏（与 WP329 写共用一本账；不给就自己建一本）。 */
  pace?: Pace
  /** `sweepNow` 等插件交回时怎么等（测试给假的）。 */
  sleep?(ms: number): Promise<void>
}

export interface RedditWatchAssembly {
  view(): RedditWatchView
  settings(): RedditWatchSettings
  updateSettings(patch: Partial<RedditWatchSettings>): RedditWatchSettings
  items(query?: RedditWatchItemQuery): RedditWatchEntry[]
  /** 巡查记录（新的在前）。 */
  runs(query?: { since?: Iso8601; limit?: number }): RedditWatchRun[]
  item(id: string): RedditWatchEntry | undefined
  /** WP329：起草中 / 回过了（挂上发出记录那一行）/ 人说不回。 */
  setStatus(
    id: string,
    status: RedditWatchItemStatus,
    extra?: { outbound_record_id?: string },
  ): RedditWatchEntry | undefined
  /** 人点「现在巡查」。正在跑的那一轮没结束就回那一轮。 */
  runNow(): Promise<RedditWatchRun>
  /** 定时一拍（每小时）：到点了才跑。 */
  tick(): Promise<{ ran: boolean; run_id?: string; skipped?: string }>
  /**
   * 现在巡查一次，等这一轮做完再回（WP331「立即巡查」工具用）；正在跑的那一轮直接等它。有哪块没读成就抛一句人话。
   * `timeoutMs` 默认 10 分钟（等插件交回）。
   */
  sweepNow(options?: { timeoutMs?: number; pollMs?: number }): Promise<RedditWatchRun>
  /** 一周汇总（不给窗口 = 本周日 00:00 到现在；`GET /v1/reddit-watch/digest`）。 */
  digest(window?: { since: Iso8601; until: Iso8601 }): RedditWatchDigest
  /** 插件来领活（`connected` = 插件里连上 Reddit 了）。 */
  next(input: { connected: boolean }): RedditReadNextResponse
  /** 插件交回；不是在等的那一件回 `undefined`。 */
  result(id: string, input: RedditReadResultInput): Promise<{ accepted: true } | undefined>
  /** WP329：新出的要回的几条。回注销函数。 */
  onPending(listener: (items: RedditWatchEntry[]) => void): () => void
  /** 配置卡的设置目标（`reddit.watch`），由宿主登记到 WP324。 */
  setupTarget(): SetupTarget
  /** 连接卡复查：插件连上 Reddit、登着品牌号了没有（不知道回 `undefined`）。 */
  sessionReady(): boolean | undefined
  /** 到期的活收掉（定时一拍与看视图时都调）。 */
  sweep(): void
  /** Reddit 号的节奏（WP329 写也记在这一本上：同一个号一次一件）。 */
  readonly pace: Pace
  /**
   * WP329（决策 764）：这个版最近读到的版规（插件借品牌号会话读 `about/rules.json`，巡查时顺手读；
   * 自家版块每轮都读，别的版要先 {@link wantRules}）。没读过回 `undefined`。
   */
  rules(subreddit: string): { rules: string[]; at: Iso8601 } | undefined
  /** WP329：下一轮巡查顺手读这几个版的版规（起草时读不到就记一笔，下次就有了）。 */
  wantRules(subreddit: string): void
  /** WP340：新出的「优先」（命中告警词）几条——同一条只通知一次。回注销函数。 */
  onAlert(listener: (items: RedditWatchEntry[]) => void): () => void
  /** WP340：人收起了这一条的「优先」提醒（找不到回 `undefined`）。 */
  dismissAlert(id: string): RedditWatchEntry | undefined
  /**
   * WP340：配置卡的 AI 建议（第一次问过就记下；没模型回 `undefined`）。
   * WP348：`brief` 压过档案那一份（带上搜到的版块）；没有巡查自己的模型口时用 `ask`（配置卡那一次）。
   */
  aiSuggestions(input?: {
    brief?: PatrolBrandBrief
    ask?(prompt: string): Promise<string | undefined>
  }): Promise<PatrolSuggestion | undefined>
  /** WP348：插件那一侧现在怎样（配置卡方案里品牌号只从这里来）。 */
  pluginState(): PatrolPluginState
}

/** WP329：版规多久算旧（旧了下一轮再读一次）。 */
export const RULES_FRESH_MS = 7 * 86_400_000
/** WP329：一轮巡查最多顺手读几个版的版规（一件活最多 12 路）。 */
const RULES_PER_RUN = 3

/** `sweepNow` 默认最多等插件多久。 */
export const WEEKLY_WAIT_MS = 10 * 60_000
const PART_ZH: Record<RedditWatchPart, string> = {
  inbox: '收件箱',
  own_sub: '自家版块',
  watch_sub: '重点版块',
  external: '外部社区',
}
/** 插件多久没来问就算「没开」。 */
export const EXT_FRESH_MS = 15 * 60_000
/** 排着的活多久没人领就作废（Chrome 没开）。 */
export const JOB_QUEUED_TTL_MS = 2 * 3_600_000
/** 领走多久没交回就算断了。 */
export const JOB_RUNNING_TTL_MS = 20 * 60_000
/** 同一种卡一天最多出一次。 */
export const CARD_GAP_MS = 20 * 3_600_000
/** 第一次读只要这么近的。 */
export const FIRST_READ_WINDOW_S = 7 * 86_400
/** WP410：升级迁移（旧版记下的「设置卡今天出过了」作废）跑过的记号。 */
export const PATROL_SETUP_MIGRATION_KEY = 'migrated:wp410'
/** WP410：巡查快照注进哪几条职责的上下文（官方版块 / 外部版块）。 */
export const PATROL_STATE_ROLES: readonly string[] = ['social.reddit', 'pr.reddit']

interface ExtState {
  seen_at?: Iso8601
  reddit_connected?: boolean
  user?: string
  note?: string
  /** 最近一次读的结局（`not_logged_in` / `wrong_user` 时连接卡认它）。 */
  outcome?: string
}
interface JobRec {
  job: RedditReadJob
  run_id: string
  status: 'queued' | 'running'
  queued_at: Iso8601
  picked_at?: Iso8601
  pace_key: string
  /**
   * WP348：只看登着哪个号（一路都不读：插件照例先读 `/api/me.json`）。还没配巡查、插件刚连上 Reddit
   * 时排一件，配置卡的方案里品牌号就是插件里登着的那个；不占读的次数，真巡查来了直接顶掉它。
   */
  whoami?: true
}
type Parts = Partial<Record<RedditWatchPart, PartClock>>
type MaybePromise<T> = T | Promise<T>

/** WP340：重点版块每次读几页新帖（一页 100 条）。 */
const WATCH_SUB_PAGES = 2
/** WP340：「优先」提醒最多列几条。 */
const ALERTS_MAX = 20

export const REDDIT_SESSION_NEED_KIND = 'reddit_session'

export function createRedditWatch(options: RedditWatchOptions): RedditWatchAssembly {
  const ws = options.workspace_id
  const store = options.store
  const pace = options.pace ?? new Pace({ limits: REDDIT_PACE_LIMITS })
  const pendingListeners = new Set<(items: RedditWatchEntry[]) => void>()
  const alertListeners = new Set<(items: RedditWatchEntry[]) => void>()
  const ms = (t: Iso8601 | undefined): number => (t === undefined ? 0 : Date.parse(t))
  const nowMs = (): number => Date.parse(options.now())

  const settings = (): RedditWatchSettings => readSettings(store, ws)
  const ext = (): ExtState => store.kv<ExtState>(ws, 'ext') ?? {}
  const setExt = (patch: ExtState): void => store.setKv(ws, 'ext', { ...ext(), ...patch })
  const parts = (): Parts => store.kv<Parts>(ws, 'parts') ?? {}
  const touchPart = (p: RedditWatchPart, patch: PartClock): void =>
    store.setKv(ws, 'parts', { ...parts(), [p]: { ...parts()[p], ...patch } })
  const jobRec = (): JobRec | undefined => store.kv<JobRec | null>(ws, 'job') ?? undefined
  // WP340：每个版块各自一个钟（键小写）；老数据没有 → 自家版块借原来整块「自家版块」那一个
  const subClocks = (): Record<string, PartClock> =>
    store.kv<Record<string, PartClock>>(ws, 'sub_clocks') ?? {}
  const touchSub = (sub: string, patch: PartClock): void => {
    const all = subClocks()
    const k = sub.toLowerCase()
    store.setKv(ws, 'sub_clocks', { ...all, [k]: { ...all[k], ...patch } })
  }
  const setJob = (j: JobRec | undefined): void => store.setKv(ws, 'job', j ?? null)

  const emit = (type: string, payload: Record<string, unknown>): void => {
    try {
      options.emit?.(type, { workspace_id: ws, ...payload })
    } catch {
      // 审计事件失败不拦正事
    }
  }
  const safely = <T>(fn: () => T): void => {
    try {
      fn()
    } catch {
      // 听的人出错不拦巡查
    }
  }

  /* ── 卡：缺设置 / 缺连接（一种卡一天最多一次）────────────────────────── */
  const throttled = (kind: string): boolean => {
    const at = store.kv<Iso8601 | null>(ws, `asked:${kind}`) ?? undefined
    if (at !== undefined && nowMs() - ms(at) < CARD_GAP_MS) return true
    store.setKv(ws, `asked:${kind}`, options.now())
    return false
  }
  /*
   * WP410（真机 #5）：升级迁移，跑一次就记下——旧版记下的「设置卡今天出过了」作废
   * （旧版那张空表单卡由 setup-cards 的迁移换成方案卡；这里不清，新版就要再等一天才出得来）。
   */
  if (store.kv(ws, PATROL_SETUP_MIGRATION_KEY) === undefined) {
    store.setKv(ws, 'asked:setup', null)
    store.setKv(ws, PATROL_SETUP_MIGRATION_KEY, options.now())
  }
  /**
   * 缺设置出方案卡（一天最多一次）。WP410：`force` = 插件刚把账号交回 / 刚连上 Reddit——不受一天一次限制，
   * 开着的那张也重查一遍（已知的品牌号、自家版块要预填上）。
   */
  const askSetup = async (o: { force?: boolean } = {}): Promise<void> => {
    const actor = options.actor?.()
    if (actor === undefined) return
    if (o.force === true) store.setKv(ws, 'asked:setup', options.now())
    else if (throttled('setup')) return
    await (await options.setupCards?.())
      ?.askSetup({
        target: REDDIT_WATCH_TARGET,
        actor,
        ...(o.force === true ? { refresh: true } : {}),
      })
      .catch(() => undefined)
  }
  const askConnect = async (need: ConnectNeed, why: string): Promise<void> => {
    const actor = options.actor?.()
    if (actor === undefined || throttled(`connect:${need.kind}:${need.state ?? ''}`)) return
    await (await options.setupCards?.())
      ?.askConnect({ needs: [need], why, actor })
      .catch(() => undefined)
  }
  const EXTENSION_NEED: ConnectNeed = {
    kind: 'extension',
    service: 'extension',
    name: 'Agents 工坊助手（Chrome 插件）',
    required: true,
  }
  const sessionNeed = (state: 'not_connected' | 'reauth'): ConnectNeed => ({
    kind: REDDIT_SESSION_NEED_KIND,
    name: 'Chrome 里的 Reddit 品牌号',
    required: true,
    state,
  })
  const SESSION_WHY =
    '巡查收件箱和自家版块要用插件：在插件设置里点「连接 Reddit」，并在这个 Chrome 里登录品牌号。'

  /* ── 一轮的收尾 ─────────────────────────────────────────────────── */
  const partOf = (run: RedditWatchRun, p: RedditWatchPart): RedditWatchRunPart | undefined =>
    run.parts.find((x) => x.part === p)
  const setPart = (
    run: RedditWatchRun,
    p: RedditWatchPart,
    patch: Partial<RedditWatchRunPart>,
  ): void => {
    const hit = partOf(run, p)
    if (hit === undefined) return
    Object.assign(hit, patch)
    if (patch.status !== undefined && patch.status !== 'waiting') hit.finished_at = options.now()
    if (patch.status === 'ok') touchPart(p, { last_ok_at: options.now() })
  }
  const finishIfDone = (run: RedditWatchRun): void => {
    store.putRun(run)
    if (run.finished_at !== undefined || run.parts.some((p) => p.status === 'waiting')) return
    run.finished_at = options.now()
    store.putRun(run)
    if (store.kv<string>(ws, 'active_run') === run.id) store.setKv(ws, 'active_run', null)
    emit('reddit_watch.run_finished', {
      run_id: run.id,
      final: run.final,
      pending: run.pending,
      parts: run.parts.map((p) => `${p.part}:${p.status}`),
    })
  }

  /** 新条目判一遍、存、要回的通知 WP329。 */
  const judgeAndStore = async (run: RedditWatchRun, fresh: RedditWatchEntry[]): Promise<void> => {
    const todo = fresh.filter((x) => x.ours !== true && x.deleted !== true)
    if (todo.length === 0) return
    const s = settings()
    const { since } = redditWeekWindow(options.now(), options.tzOffsetMinutes())
    const topics = [
      ...new Set(
        store
          .list(ws, { source: 'external', since, limit: 500 })
          .map((x) => x.judgement?.topic)
          .filter((t): t is string => t !== undefined),
      ),
    ]
    const brand = options.brandName?.()
    const verdicts = await judgeItems(
      todo,
      {
        ...(brand === undefined ? {} : { brand }),
        own_subreddits: s.own_subreddits,
        watch_subreddits: s.watch_subreddits ?? [],
        keywords: s.keywords,
        topics,
      },
      options.complete?.(),
    )
    const pending: RedditWatchEntry[] = []
    for (const it of todo) {
      const j = verdicts.get(it.id)
      if (j === undefined) continue
      it.judgement = j
      store.put(it)
      if (j.reply) pending.push(it)
    }
    run.pending += pending.length
    if (pending.length > 0) for (const l of pendingListeners) safely(() => l(pending))
  }

  /**
   * WP340：新入库里命中告警词的 → 单独提醒一次。同一条（同一全名）在别的来源已经标过「优先」的不再提醒
   * （直接记成看过），这一批里重复的也只算一次。
   */
  const notifyAlerts = (fresh: RedditWatchEntry[]): void => {
    const out: RedditWatchEntry[] = []
    const batch = new Set(fresh.map((x) => x.id))
    for (const it of fresh) {
      if (it.priority !== true || it.alert_seen === true) continue
      const dup =
        out.some((x) => x.fullname === it.fullname) ||
        store.byFullname(ws, it.fullname).some((x) => !batch.has(x.id) && x.priority === true)
      if (dup) {
        it.alert_seen = true
        store.put(it)
        continue
      }
      out.push(it)
    }
    if (out.length === 0) return
    emit('reddit_watch.alert', {
      items: out.map((x) => ({ item_id: x.id, words: x.alert_hits ?? [] })),
    })
    for (const l of alertListeners) safely(() => l(out))
  }

  const ingestCtx = (run: RedditWatchRun): IngestContext => ({
    workspace_id: ws,
    run_id: run.id,
    now: options.now(),
    newId: options.newId,
  })

  /* ── 外部社区：每个关键词搜一次（第三方数据渠道）──────────────────────── */
  const runExternal = async (run: RedditWatchRun): Promise<void> => {
    const s = settings()
    const search = options.search
    if (search === undefined) {
      setPart(run, 'external', {
        status: 'failed',
        message: '没接第三方数据渠道，外部社区这次没搜。',
      })
      return
    }
    const own = new Set(s.own_subreddits.map((x) => x.toLowerCase()))
    const fresh: RedditWatchEntry[] = []
    const failures: string[] = []
    let fetched = 0
    for (const keyword of s.keywords) {
      const got = await search({
        query: keyword,
        time_window: s.every_hours > 24 ? 'week' : 'day',
        limit: s.keyword_limit,
      }).catch(
        (e: unknown): RedditSearchResult => ({
          ok: false,
          message: e instanceof Error ? e.message : String(e),
        }),
      )
      if (!got.ok) {
        failures.push(`「${keyword}」：${got.message}`)
        continue
      }
      for (const r of got.items) {
        // 自家版块里的不算外部（那一块插件已经在读）
        if (r.subreddit !== undefined && own.has(r.subreddit.toLowerCase())) continue
        const it = externalItemOf(r, keyword, ingestCtx(run))
        if (it === undefined) continue
        fetched += 1
        if (store.insert(applyLocalMarks(it, s))) fresh.push(it)
      }
    }
    await judgeAndStore(run, fresh)
    notifyAlerts(fresh)
    const allFailed = failures.length > 0 && failures.length === s.keywords.length
    setPart(run, 'external', {
      status: allFailed ? 'failed' : 'ok',
      fetched,
      fresh: fresh.length,
      ...(failures.length === 0 ? {} : { message: failures.slice(0, 3).join('；').slice(0, 300) }),
    })
  }

  /* ── 收件箱 / 版块：排一件只读活给插件 ─────────────────────────────── */
  const isOwn = (sub: string): boolean =>
    settings().own_subreddits.some((x) => x.toLowerCase() === sub.toLowerCase())

  /**
   * 这一件活读哪几路：收件箱、到点的版块（自家：新帖 + 新评论；重点：新帖）、顺手读版规。
   * 一件最多 {@link REDDIT_READ_MAX_PARTS} 路，排不下的版块不进这一件（钟不动，下一拍再排）。
   */
  const readsFor = (
    inbox: boolean,
    subs: readonly string[],
  ): { reads: RedditReadRequest[]; subs: string[] } => {
    const s = settings()
    const firstSince = Math.floor(nowMs() / 1000) - FIRST_READ_WINDOW_S
    const one = (req: Omit<RedditReadRequest, 'stop_at' | 'since_utc'>): RedditReadRequest => {
      const c = store.kv<{ name: string; created_utc: number }>(ws, `cursor:${req.key}`)
      return c === undefined
        ? { ...req, since_utc: firstSince }
        : // 上一条被删了找不到时，按时间兜底（早一小时的余量）
          { ...req, stop_at: c.name, since_utc: c.created_utc - 3_600 }
    }
    const out: RedditReadRequest[] = []
    const taken: string[] = []
    if (inbox) out.push(one({ key: 'inbox', kind: 'inbox', max_pages: 2 }))
    for (const sub of subs) {
      const k = sub.toLowerCase()
      const reqs: Omit<RedditReadRequest, 'stop_at' | 'since_utc'>[] = isOwn(sub)
        ? [
            { key: `sub_new:${k}`, kind: 'sub_new', subreddit: sub, max_pages: 3 },
            { key: `sub_comments:${k}`, kind: 'sub_comments', subreddit: sub, max_pages: 5 },
          ]
        : [{ key: `watch_new:${k}`, kind: 'sub_new', subreddit: sub, max_pages: WATCH_SUB_PAGES }]
      if (out.length + reqs.length > REDDIT_READ_MAX_PARTS) continue
      for (const r of reqs) out.push(one(r))
      taken.push(sub)
    }
    // WP329（决策 764）：顺手读版规——自家版块与起草时要过的版，旧了（7 天）才读，一轮最多 3 个
    if (inbox || taken.some(isOwn)) {
      const wanted = store.kv<string[]>(ws, 'rules_wanted') ?? []
      const rulesSubs = [...new Set([...s.own_subreddits, ...wanted].map((x) => x.toLowerCase()))]
      let n = 0
      for (const sub of rulesSubs) {
        if (n >= RULES_PER_RUN || out.length >= REDDIT_READ_MAX_PARTS) break
        const have = store.kv<{ rules: string[]; at: Iso8601 }>(ws, `rules:${sub}`)
        if (have !== undefined && nowMs() - ms(have.at) < RULES_FRESH_MS) continue
        const norm = normalizeSubreddit(sub)
        if (norm === undefined) continue
        out.push({ key: `rules:${sub}`, kind: 'sub_rules', subreddit: norm, max_pages: 1 })
        n += 1
      }
    }
    return { reads: out, subs: taken }
  }

  const queueExtension = async (
    run: RedditWatchRun,
    want: RedditWatchPart[],
    reads: RedditReadRequest[],
  ): Promise<void> => {
    const e = ext()
    if (e.seen_at === undefined) {
      for (const p of want)
        setPart(run, p, { status: 'needs_connection', message: '插件还没配对。' })
      await askConnect(EXTENSION_NEED, SESSION_WHY)
      return
    }
    if (e.reddit_connected !== true) {
      for (const p of want)
        setPart(run, p, { status: 'needs_connection', message: '插件里还没连接 Reddit。' })
      await askConnect(sessionNeed('not_connected'), SESSION_WHY)
      return
    }
    const cur = jobRec()
    // WP348：「只看登着哪个号」那一件直接被真巡查顶掉（真巡查照样先读登着哪个号）
    if (cur !== undefined && cur.whoami !== true) {
      for (const p of want) setPart(run, p, { status: 'skipped', message: '上一轮还没读完。' })
      return
    }
    const s = settings()
    const job: RedditReadJob = {
      id: options.newId('rj'),
      workspace_id: ws,
      ...(s.brand_username === undefined ? {} : { expect_user: s.brand_username }),
      reads,
      title: run.final ? 'Reddit 本周最后一次巡查' : 'Reddit 每日巡查',
      created_at: options.now(),
    }
    setJob({
      job,
      run_id: run.id,
      status: 'queued',
      queued_at: options.now(),
      pace_key: redditPaceKey(s.brand_username, ws),
    })
    for (const p of want) setPart(run, p, { status: 'waiting' })
  }

  /**
   * 起一轮：`parts` 是收件箱 / 外部关键词里该跑的，`subs` 是到点的版块（自家 + 重点）。
   * 版块按这一件活排得下的算（排不下的钟不动，下一拍再排）。
   */
  const start = async (
    trigger: RedditWatchRun['trigger'],
    final: boolean,
    parts: RedditWatchPart[],
    subs: readonly string[],
  ): Promise<RedditWatchRun> => {
    const plan = readsFor(parts.includes('inbox'), subs)
    const order: RedditWatchPart[] = ['inbox', 'own_sub', 'watch_sub', 'external']
    const want = order.filter((p) =>
      p === 'own_sub'
        ? plan.subs.some(isOwn)
        : p === 'watch_sub'
          ? plan.subs.some((x) => !isOwn(x))
          : parts.includes(p),
    )
    const run: RedditWatchRun = {
      id: options.newId('rwr'),
      workspace_id: ws,
      started_at: options.now(),
      final,
      trigger,
      parts: want.map((part) => ({ part, status: 'waiting', fetched: 0, fresh: 0 })),
      pending: 0,
    }
    store.putRun(run)
    store.setKv(ws, 'active_run', run.id)
    for (const p of want) touchPart(p, { last_try_at: options.now() })
    for (const sub of plan.subs) touchSub(sub, { last_try_at: options.now() })
    emit('reddit_watch.run_started', {
      run_id: run.id,
      final,
      trigger,
      parts: want,
      subs: plan.subs.length,
    })
    if (want.includes('external')) await runExternal(run)
    const viaExt = want.filter((p) => p !== 'external')
    if (viaExt.length > 0) await queueExtension(run, viaExt, plan.reads)
    finishIfDone(run)
    return run
  }

  /** 收件箱一直有；外部关键词配了才有（版块按各自的钟另算）。 */
  const applicable = (s: RedditWatchSettings): RedditWatchPart[] => {
    const out: RedditWatchPart[] = ['inbox']
    if (s.keywords.length > 0) out.push('external')
    return out
  }
  const allSubs = (s: RedditWatchSettings): string[] => [
    ...s.own_subreddits,
    ...(s.watch_subreddits ?? []),
  ]
  /** 到点的版块（老数据：自家版块没有自己的钟就借整块「自家版块」那一个）。 */
  const subsDue = (s: RedditWatchSettings): string[] => {
    const legacy = parts().own_sub
    return dueSubs({
      now: options.now(),
      tz_offset_minutes: options.tzOffsetMinutes(),
      settings: s,
      subs: allSubs(s),
      clocks: subClocks(),
      fallback: (sub) => (isOwn(sub) ? legacy : undefined),
    })
  }

  const activeRun = (): RedditWatchRun | undefined => {
    const id = store.kv<string | null>(ws, 'active_run')
    if (id === undefined || id === null) return undefined
    const run = store.run(ws, id)
    return run === undefined || run.finished_at !== undefined ? undefined : run
  }

  /* ── 插件交回来的 ───────────────────────────────────────────────── */
  const partOfKey = (key: string): RedditWatchPart =>
    key === 'inbox' ? 'inbox' : key.startsWith('watch_new:') ? 'watch_sub' : 'own_sub'
  /** 这一路是哪个版块的（收件箱 / 版规回 `undefined`）。 */
  const subOfKey = (key: string): string | undefined => {
    const m = /^(?:sub_new|sub_comments|watch_new):(.+)$/u.exec(key)
    return m?.[1]
  }

  /** 对方删了原话：我们这边清掉正文、发出记录里那一句也清（667）。 */
  const markDeleted = (raw: RedditListingItem): void => {
    for (const old of store.byFullname(ws, raw.name)) {
      if (old.deleted === true) continue
      store.put({ ...old, text: '', deleted: true })
    }
    safely(() => options.outbound?.()?.counterpartDeleted(ws, raw.name))
  }

  /** 回的是我们发过的那条 → 挂到发出记录那一行下。全名与去掉前缀的 id 都试（WP329 记哪种都认）。 */
  const followUp = (it: RedditWatchEntry): void => {
    const log = options.outbound?.()
    const parent = it.parent_fullname
    if (log === undefined || parent === undefined) return
    for (const ext of [parent, parent.replace(/^t\d_/u, '')]) {
      let hit: unknown
      try {
        hit = log.addFollowUp(ws, {
          parent_external_id: ext,
          ...(it.author === undefined ? {} : { author: it.author }),
          text: it.text,
          ...(it.url === undefined ? {} : { url: it.url }),
          external_id: it.fullname,
          at: it.created_at,
        })
      } catch {
        hit = undefined
      }
      if (hit !== undefined) {
        it.reply_to_ours = true
        return
      }
    }
  }

  const ingest = async (rec: JobRec, res: RedditReadResultInput): Promise<void> => {
    const run = store.run(ws, rec.run_id)
    if (run === undefined) return
    let s = settings()
    // 没配品牌号：第一次读到就把登着的号记成品牌号（决策 758）——之后换了号插件一条都不读
    if (s.brand_username === undefined && res.outcome === 'done' && res.user !== undefined)
      s = writeSettings(store, ws, { brand_username: res.user })
    const brandUser = s.brand_username ?? res.user
    const fresh: RedditWatchEntry[] = []
    // WP340：每个版块这一次是不是都读成了（自家版块两路都成才算）
    const subOk = new Map<string, boolean>()
    const stats = new Map<
      RedditWatchPart,
      { fetched: number; fresh: number; bad: string[]; gap: boolean }
    >()
    for (const part of res.parts) {
      // WP329：版规那几路不是条目，记下就走（读不成不算这一块失败）
      if (part.key.startsWith('rules:')) {
        const sub = part.key.slice('rules:'.length)
        if (part.ok && part.rules !== undefined) {
          store.setKv(ws, `rules:${sub}`, { rules: part.rules, at: options.now() })
          const left = (store.kv<string[]>(ws, 'rules_wanted') ?? []).filter((x) => x !== sub)
          store.setKv(ws, 'rules_wanted', left)
        }
        continue
      }
      const p = partOfKey(part.key)
      const sub = subOfKey(part.key)
      if (sub !== undefined) subOk.set(sub, (subOk.get(sub) ?? true) && part.ok)
      const st = stats.get(p) ?? { fetched: 0, fresh: 0, bad: [], gap: false }
      stats.set(p, st)
      const req = rec.job.reads.find((r) => r.key === part.key)
      if (!part.ok) st.bad.push(part.message ?? '没读成')
      // 翻到页数上限还没读到上次那一条：中间可能漏了（照实说，不装）
      if (part.ok && !part.reached_stop && req !== undefined && part.pages >= req.max_pages)
        st.gap = true
      let newest: RedditListingItem | undefined
      for (const raw of part.items) {
        st.fetched += 1
        if (newest === undefined || raw.created_utc > newest.created_utc) newest = raw
        if (raw.deleted === true) markDeleted(raw)
        // 重点版块（别人的版）读到的进「外部社区」那一类（按话题归组）
        const source = p === 'inbox' ? 'inbox' : p === 'watch_sub' ? 'external' : 'own_sub'
        const it = applyLocalMarks(watchItemOf(raw, source, ingestCtx(run), brandUser), s)
        if (!store.insert(it)) continue
        st.fresh += 1
        if (p === 'inbox') followUp(it)
        if (it.reply_to_ours === true) store.put(it)
        fresh.push(it)
      }
      if (part.ok && newest !== undefined)
        store.setKv(ws, `cursor:${part.key}`, {
          name: newest.name,
          created_utc: newest.created_utc,
        })
    }
    await judgeAndStore(run, fresh)
    notifyAlerts(fresh)
    for (const [sub, ok] of subOk) if (ok) touchSub(sub, { last_ok_at: options.now() })
    const loginLike = res.outcome === 'not_logged_in' || res.outcome === 'wrong_user'
    for (const p of run.parts) {
      if (p.part === 'external' || p.status !== 'waiting') continue
      const st = stats.get(p.part)
      const counts = { fetched: st?.fetched ?? 0, fresh: st?.fresh ?? 0 }
      if (loginLike)
        setPart(run, p.part, { status: 'needs_connection', message: res.message, ...counts })
      else if (st === undefined)
        setPart(run, p.part, { status: 'failed', message: res.message || '没读成', ...counts })
      else if (st.bad.length > 0)
        setPart(run, p.part, {
          status: 'failed',
          message: st.bad.slice(0, 2).join('；'),
          ...counts,
        })
      else
        setPart(run, p.part, {
          status: 'ok',
          ...counts,
          ...(st.gap ? { message: '这次新内容太多，没读完，可能有漏的。' } : {}),
        })
    }
    setExt({
      outcome: res.outcome,
      ...(res.user === undefined ? {} : { user: res.user }),
      note: res.outcome === 'done' ? '' : res.message,
    })
    if (loginLike) await askConnect(sessionNeed('reauth'), `${res.message} ${SESSION_WHY}`)
    finishIfDone(run)
  }

  /* ── 到期的活收掉 ───────────────────────────────────────────────── */
  const sweep = (): void => {
    const rec = jobRec()
    if (rec === undefined) return
    const age = nowMs() - ms(rec.status === 'queued' ? rec.queued_at : rec.picked_at)
    const ttl = rec.status === 'queued' ? JOB_QUEUED_TTL_MS : JOB_RUNNING_TTL_MS
    if (age < ttl) return
    setJob(undefined)
    if (rec.status === 'running' && rec.whoami !== true) pace.endKey(rec.pace_key, rec.job.id)
    const run = store.run(ws, rec.run_id)
    if (run === undefined) return
    const message =
      rec.status === 'queued'
        ? 'Chrome 没开着，插件没来领这一轮。'
        : '插件读到一半没回音（Chrome 关了？）。'
    for (const p of run.parts)
      if (p.status === 'waiting') setPart(run, p.part, { status: 'failed', message })
    finishIfDone(run)
  }

  const sessionReady = (): boolean | undefined => {
    const e = ext()
    if (e.seen_at === undefined) return false
    if (e.reddit_connected !== true) return false
    // 上次读到「没登录 / 号不对」：人可能已经登好了，读之前不知道——人点「接着做」就信人
    return e.outcome === 'not_logged_in' || e.outcome === 'wrong_user' ? undefined : true
  }

  /** WP348：插件那一侧（配置卡方案里品牌号只从这里来，不让 AI 猜）。 */
  const pluginState = (): PatrolPluginState => {
    const e = ext()
    const state =
      e.seen_at === undefined
        ? 'unpaired'
        : e.reddit_connected === true
          ? 'connected'
          : 'not_connected'
    return {
      state,
      ...(e.user === undefined || e.outcome === 'not_logged_in' ? {} : { user: e.user }),
    }
  }

  /* ── WP340：「优先」提醒 / 配置卡的 AI 建议 ──────────────────────── */
  /** 最近几天命中告警词、人还没收起的（同一条只一行，新的在前）。 */
  const alertsNow = (): RedditWatchEntry[] => {
    const since = new Date(nowMs() - REDDIT_WATCH_ALERT_DAYS * 86_400_000).toISOString()
    const seen = new Set<string>()
    const out: RedditWatchEntry[] = []
    for (const x of store.list(ws, { since, limit: 2000 })) {
      if (x.priority !== true || x.alert_seen === true || x.deleted === true) continue
      if (seen.has(x.fullname)) continue
      seen.add(x.fullname)
      out.push(x)
      if (out.length >= ALERTS_MAX) break
    }
    return out
  }

  /** 配置卡的 AI 建议：问过且问成了就记下（不重复花钱）；没模型 / 没问成回 `undefined`、下次再问。 */
  const aiSuggestions: RedditWatchAssembly['aiSuggestions'] = async (input = {}) => {
    const cached = store.kv<{ at: Iso8601; suggestion: PatrolSuggestion } | null>(ws, 'ai_suggest')
    if (cached !== undefined && cached !== null) return cached.suggestion
    const own = options.complete?.()
    const ask = input.ask
    const complete =
      own ??
      (ask === undefined
        ? undefined
        : async (prompt: string) => {
            const out = await ask(prompt)
            if (out === undefined) throw new Error('no_model')
            return out
          })
    if (complete === undefined) return undefined
    const brief =
      input.brief ?? (await Promise.resolve(options.brandBrief?.()).catch(() => undefined))
    const got = await suggestPatrol(brief, complete)
    if (got !== undefined) {
      store.setKv(ws, 'ai_suggest', { at: options.now(), suggestion: got })
      emit('reddit_watch.setup_suggested', {
        subs: got.own_subreddits.length + got.watch_subreddits.length,
        keywords: got.keywords.length,
      })
    }
    return got
  }

  /* ── 定时 / 人点 ────────────────────────────────────────────────── */
  const tick: RedditWatchAssembly['tick'] = async () => {
    sweep()
    if (activeRun() !== undefined) return { ran: false, skipped: 'running' }
    const s = settings()
    if (!s.enabled) return { ran: false, skipped: 'disabled' }
    if (!isConfigured(s)) {
      await askSetup()
      return { ran: false, skipped: 'needs_setup' }
    }
    const due = dueParts({
      now: options.now(),
      tz_offset_minutes: options.tzOffsetMinutes(),
      settings: s,
      parts: parts(),
      applicable: applicable(s),
    })
    const subs = subsDue(s)
    if (due.length === 0 && subs.length === 0) return { ran: false, skipped: 'not_due' }
    const run = await start('schedule', false, due, subs)
    return { ran: true, run_id: run.id }
  }

  /**
   * 现在巡查一次，**等这一轮做完**（插件那两块交回或超时）再回——报告积木「立即巡查」用（WP331）。
   * 有哪一块没读成就抛一句人话（报告照样用已入库的出）；正在跑的那一轮直接等它。
   */
  const sweepNow: RedditWatchAssembly['sweepNow'] = async (o = {}) => {
    sweep()
    let run = activeRun()
    if (run === undefined) {
      const s = settings()
      if (!isConfigured(s)) throw new Error('没配 Reddit 巡查（自家版块、外部关键词都没有）。')
      run = await start('manual', false, applicable(s), allSubs(s))
    }
    const poll = o.pollMs ?? 5_000
    const timeout = o.timeoutMs ?? WEEKLY_WAIT_MS
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
    for (let waited = 0; ; waited += poll) {
      const cur = store.run(ws, run.id)
      if (cur?.finished_at !== undefined) {
        run = cur
        break
      }
      if (waited >= timeout)
        throw new Error('插件还没交回这一轮（Chrome 没开着？），先用已经读到的。')
      await sleep(poll)
      sweep()
    }
    const bad = run.parts.filter((p) => p.status !== 'ok' && p.status !== 'skipped')
    if (bad.length > 0)
      throw new Error(
        bad
          .map((p) => `${PART_ZH[p.part]}：${p.message ?? '没读成'}`)
          .join('；')
          .slice(0, 400),
      )
    return run
  }

  const runNow = async (): Promise<RedditWatchRun> => {
    sweep()
    const active = activeRun()
    if (active !== undefined) return active
    const s = settings()
    if (!isConfigured(s)) await askSetup()
    return isConfigured(s)
      ? start('manual', false, applicable(s), allSubs(s))
      : start('manual', false, ['inbox'], [])
  }

  /* ── 插件那一侧 ─────────────────────────────────────────────────── */
  const next: RedditWatchAssembly['next'] = (input) => {
    const before = sessionReady()
    setExt({ seen_at: options.now(), reddit_connected: input.connected })
    // 刚连上：缺连接停着的那几块不用等一小时，马上再来一轮
    if (before === false && input.connected) {
      const p = parts()
      for (const k of ['inbox', 'own_sub'] as const)
        if (p[k] !== undefined) touchPart(k, { last_try_at: '1970-01-01T00:00:00.000Z' })
      for (const k of Object.keys(subClocks()))
        touchSub(k, { last_try_at: '1970-01-01T00:00:00.000Z' })
      // WP410（真机 #5）：刚连上、还没设好、已经知道登着哪个号——不等一天一次，直接出（或刷新）方案卡
      // （没设好时定时一拍也只是出卡，两条只走一条，免得同一张卡查两遍）
      if (ext().user !== undefined && !isConfigured(settings()))
        void askSetup({ force: true }).catch(() => undefined)
      else void tick().catch(() => undefined)
    }
    sweep()
    // WP348：还没配巡查、也不知道登着哪个号 → 排一件「只看登着哪个号」（配置卡方案里品牌号就用它）
    if (
      input.connected &&
      jobRec() === undefined &&
      ext().user === undefined &&
      !isConfigured(settings())
    )
      setJob({
        job: {
          id: options.newId('rj'),
          workspace_id: ws,
          reads: [],
          title: '看看 Chrome 里登着哪个 Reddit 号',
          created_at: options.now(),
        },
        run_id: '',
        status: 'queued',
        queued_at: options.now(),
        pace_key: redditPaceKey(undefined, ws),
        whoami: true,
      })
    const rec = jobRec()
    if (!input.connected || rec === undefined || rec.status !== 'queued')
      return { retry_after_ms: 60_000 }
    if (rec.whoami === true) {
      setJob({ ...rec, status: 'running', picked_at: options.now() })
      return { job: rec.job, retry_after_ms: 0 }
    }
    const ok = pace.beginKey(rec.pace_key, 'read', rec.job.id, nowMs())
    if (!ok.ok) {
      setExt({ note: ok.why })
      return { retry_after_ms: 10 * 60_000 }
    }
    setJob({ ...rec, status: 'running', picked_at: options.now() })
    emit('reddit_watch.job_picked', { job_id: rec.job.id, reads: rec.job.reads.length })
    return { job: rec.job, retry_after_ms: 0 }
  }

  const result: RedditWatchAssembly['result'] = async (id, input) => {
    const rec = jobRec()
    if (rec === undefined || rec.job.id !== id || rec.status !== 'running') return undefined
    setJob(undefined)
    if (rec.whoami === true) {
      // 只记登着哪个号（没登录也记下：方案里说清楚）
      setExt({ outcome: input.outcome, ...(input.user === undefined ? {} : { user: input.user }) })
      emit('reddit_watch.whoami', { outcome: input.outcome })
      // WP360（决策 947）：插件刚装好、刚连上 Reddit、知道登着哪个号了 → 不等人开口，接上巡查的方案卡
      // （品牌号就是插件里登着的那个；一天最多一张，与缺设置时出的是同一张）
      // 出卡前要查一遍（搜索 / 模型），不让插件这一条请求等着
      // WP410（真机 #5）：插件把账号交回来了——不受一天一次限制，开着的那张也按新知道的号重查
      if (!isConfigured(settings())) void askSetup({ force: true }).catch(() => undefined)
      return { accepted: true }
    }
    pace.endKey(rec.pace_key, rec.job.id)
    emit('reddit_watch.job_result', {
      job_id: id,
      outcome: input.outcome,
      items: input.parts.reduce((n, p) => n + p.items.length, 0),
    })
    await ingest(rec, input)
    return { accepted: true }
  }

  return {
    view: () => {
      sweep()
      const s = settings()
      const e = ext()
      const last = store.runs(ws, { limit: 1 })[0]
      return {
        settings: s,
        configured: isConfigured(s),
        extension: {
          ...(e.seen_at === undefined ? {} : { seen_at: e.seen_at }),
          ...(e.reddit_connected === undefined ? {} : { reddit_connected: e.reddit_connected }),
          ...(e.user === undefined ? {} : { user: e.user }),
          ...(e.note === undefined || e.note === '' ? {} : { note: e.note }),
        },
        ...(last === undefined ? {} : { last_run: last }),
        pending: store
          .list(ws, { reply: true, limit: 300 })
          .filter((x) => x.status === 'open' || x.status === 'drafting'),
        ...(() => {
          const alerts = alertsNow()
          return alerts.length === 0 ? {} : { alerts }
        })(),
      }
    },
    settings,
    rules: (subreddit) =>
      store.kv<{ rules: string[]; at: Iso8601 }>(
        ws,
        `rules:${subreddit.replace(/^\/?r\//u, '').toLowerCase()}`,
      ),
    wantRules: (subreddit) => {
      const sub = normalizeSubreddit(subreddit)?.toLowerCase()
      if (sub === undefined) return
      const now = store.kv<string[]>(ws, 'rules_wanted') ?? []
      if (!now.includes(sub)) store.setKv(ws, 'rules_wanted', [...now, sub].slice(-20))
    },
    updateSettings: (patch) => writeSettings(store, ws, patch),
    items: (query) => store.list(ws, query),
    runs: (query) => store.runs(ws, query),
    item: (id) => store.get(ws, id),
    setStatus: (id, status, extra) => {
      const it = store.get(ws, id)
      if (it === undefined) return undefined
      const next: RedditWatchEntry = { ...it, status, status_at: options.now() }
      if (extra?.outbound_record_id !== undefined)
        next.outbound_record_id = extra.outbound_record_id
      store.put(next)
      emit('reddit_watch.item_status', { item_id: id, status })
      return next
    },
    runNow,
    tick,
    sweepNow,
    digest: (window) => {
      const w = window ?? redditWeekWindow(options.now(), options.tzOffsetMinutes())
      return buildDigest({
        store,
        workspace_id: ws,
        settings: settings(),
        since: w.since,
        until: w.until,
      })
    },
    next,
    result,
    onPending: (l) => {
      pendingListeners.add(l)
      return () => pendingListeners.delete(l)
    },
    setupTarget: () => ({
      ...redditWatchSetupTarget({
        store,
        workspace_id: ws,
        ...(options.suggestions === undefined ? {} : { suggestions: options.suggestions }),
        // WP348：出卡前先查（档案、插件里登着的号、联网搜索、问一次模型）
        research: (kit) =>
          researchPatrol(kit, {
            registered: () => options.suggestions?.(),
            plugin: pluginState,
            brief: async () => await Promise.resolve(options.brandBrief?.()).catch(() => undefined),
            suggest: (brief, ask) => aiSuggestions({ brief, ask }),
          }),
      }),
      // WP410（真机 #9）：官方版块 / 外部版块的 AI 说巡查的连接与设置只读这一份（三个运行时同一份）
      roles: PATROL_STATE_ROLES,
      state: async () => {
        sweep()
        const active = activeRun()
        const last = active ?? store.runs(ws, { limit: 1 })[0]
        return patrolState({
          settings: settings(),
          ext: ext(),
          ...(last === undefined ? {} : { last }),
          running: active !== undefined,
          pending: store
            .list(ws, { reply: true, limit: 300 })
            .filter((x) => x.status === 'open' || x.status === 'drafting').length,
        })
      },
    }),
    onAlert: (l) => {
      alertListeners.add(l)
      return () => alertListeners.delete(l)
    },
    dismissAlert: (id) => {
      const it = store.get(ws, id)
      if (it === undefined) return undefined
      // 同一条（同一全名）在别的来源里的也一起收起
      for (const x of store.byFullname(ws, it.fullname))
        if (x.priority === true && x.alert_seen !== true) store.put({ ...x, alert_seen: true })
      emit('reddit_watch.alert_seen', { item_id: id })
      return store.get(ws, id)
    },
    aiSuggestions,
    pluginState,
    sessionReady,
    sweep,
    pace,
  }
}
