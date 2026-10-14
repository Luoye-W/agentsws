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
 * 周报（WP330）出之前调 `sweepNow` 做本周最后一次、等它做完；周汇总给 `RedditWeekSource`（`week-source.ts`）。本单不起草、不发。
 *
 * 频率：一天一次起步，用户可改；周五那一次由周报触发。没有任何冷却 / 占比 / 身份声明之类的规矩。
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
import { dueParts, type PartClock } from './due.js'
import { externalItemOf, type IngestContext, watchItemOf } from './ingest.js'
import { type JudgeComplete, judgeItems } from './judge.js'
import {
  isConfigured,
  REDDIT_WATCH_TARGET,
  readSettings,
  redditWatchSetupTarget,
  type SettingsSuggestions,
  writeSettings,
} from './settings.js'
import type { RedditWatchItemQuery, RedditWatchStore } from './store.js'

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
   * WP330：周报出之前做本周最后一次巡查，等这一轮做完再回；有哪块没读成就抛一句人话（周报照样出）。
   * `timeoutMs` 默认 10 分钟（等插件交回）。
   */
  sweepNow(options?: { timeoutMs?: number; pollMs?: number }): Promise<RedditWatchRun>
  /** 周报用的一周汇总（不给窗口 = 本周日 00:00 到现在）。 */
  digest(window?: { since: Iso8601; until: Iso8601 }): RedditWatchDigest
  /** 插件来领活（`connected` = 插件里连上 Reddit 了）。 */
  next(input: { connected: boolean }): RedditReadNextResponse
  /** 插件交回；不是在等的那一件回 `undefined`。 */
  result(id: string, input: RedditReadResultInput): Promise<{ accepted: true } | undefined>
  /** WP329：新出的要回的几条。回注销函数。 */
  onPending(listener: (items: RedditWatchEntry[]) => void): () => void
  /** 本周最后一次（`sweepNow` 起的那一轮）做完了。回注销函数（WP330 用 `sweepNow` 就够，这个留给别的听众）。 */
  onFinal(listener: (run: RedditWatchRun, digest: RedditWatchDigest) => void): () => void
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
}

/** WP329：版规多久算旧（旧了下一轮再读一次）。 */
export const RULES_FRESH_MS = 7 * 86_400_000
/** WP329：一轮巡查最多顺手读几个版的版规（一件活最多 12 路）。 */
const RULES_PER_RUN = 3

/** 周报前那一次最多等插件多久。 */
export const WEEKLY_WAIT_MS = 10 * 60_000
const PART_ZH: Record<RedditWatchPart, string> = {
  inbox: '收件箱',
  own_sub: '自家版块',
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
}
type Parts = Partial<Record<RedditWatchPart, PartClock>>

export const REDDIT_SESSION_NEED_KIND = 'reddit_session'

export function createRedditWatch(options: RedditWatchOptions): RedditWatchAssembly {
  const ws = options.workspace_id
  const store = options.store
  const pace = options.pace ?? new Pace({ limits: REDDIT_PACE_LIMITS })
  const pendingListeners = new Set<(items: RedditWatchEntry[]) => void>()
  const finalListeners = new Set<(run: RedditWatchRun, digest: RedditWatchDigest) => void>()
  const ms = (t: Iso8601 | undefined): number => (t === undefined ? 0 : Date.parse(t))
  const nowMs = (): number => Date.parse(options.now())

  const settings = (): RedditWatchSettings => readSettings(store, ws)
  const ext = (): ExtState => store.kv<ExtState>(ws, 'ext') ?? {}
  const setExt = (patch: ExtState): void => store.setKv(ws, 'ext', { ...ext(), ...patch })
  const parts = (): Parts => store.kv<Parts>(ws, 'parts') ?? {}
  const touchPart = (p: RedditWatchPart, patch: PartClock): void =>
    store.setKv(ws, 'parts', { ...parts(), [p]: { ...parts()[p], ...patch } })
  const jobRec = (): JobRec | undefined => store.kv<JobRec | null>(ws, 'job') ?? undefined
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
    const at = store.kv<Iso8601>(ws, `asked:${kind}`)
    if (at !== undefined && nowMs() - ms(at) < CARD_GAP_MS) return true
    store.setKv(ws, `asked:${kind}`, options.now())
    return false
  }
  const askSetup = async (): Promise<void> => {
    const actor = options.actor?.()
    if (actor === undefined || throttled('setup')) return
    await (await options.setupCards?.())
      ?.askSetup({ target: REDDIT_WATCH_TARGET, actor })
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
    // 周报来要「最后一次」时这一轮还在跑：记在杂项里（这一轮的对象可能还握在别的调用手里）
    if (!run.final && store.kv<string | null>(ws, 'final_run') === run.id) run.final = true
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
    if (!run.final) return
    const digest = buildDigest({
      store,
      workspace_id: ws,
      settings: settings(),
      ...redditWeekWindow(run.finished_at, options.tzOffsetMinutes()),
    })
    for (const l of finalListeners) safely(() => l(run, digest))
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
        if (store.insert(it)) fresh.push(it)
      }
    }
    await judgeAndStore(run, fresh)
    const allFailed = failures.length > 0 && failures.length === s.keywords.length
    setPart(run, 'external', {
      status: allFailed ? 'failed' : 'ok',
      fetched,
      fresh: fresh.length,
      ...(failures.length === 0 ? {} : { message: failures.slice(0, 3).join('；').slice(0, 300) }),
    })
  }

  /* ── 收件箱 / 自家版块：排一件只读活给插件 ───────────────────────────── */
  const readsFor = (want: RedditWatchPart[]): RedditReadRequest[] => {
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
    if (want.includes('inbox')) out.push(one({ key: 'inbox', kind: 'inbox', max_pages: 2 }))
    if (want.includes('own_sub'))
      for (const sub of s.own_subreddits) {
        out.push(
          one({
            key: `sub_new:${sub.toLowerCase()}`,
            kind: 'sub_new',
            subreddit: sub,
            max_pages: 3,
          }),
        )
        out.push(
          one({
            key: `sub_comments:${sub.toLowerCase()}`,
            kind: 'sub_comments',
            subreddit: sub,
            max_pages: 5,
          }),
        )
      }
    // WP329（决策 764）：顺手读版规——自家版块与起草时要过的版，旧了（7 天）才读，一轮最多 3 个
    if (want.includes('inbox') || want.includes('own_sub')) {
      const wanted = store.kv<string[]>(ws, 'rules_wanted') ?? []
      const subs = [...new Set([...s.own_subreddits, ...wanted].map((x) => x.toLowerCase()))]
      let n = 0
      for (const sub of subs) {
        if (n >= RULES_PER_RUN || out.length >= REDDIT_READ_MAX_PARTS) break
        const have = store.kv<{ rules: string[]; at: Iso8601 }>(ws, `rules:${sub}`)
        if (have !== undefined && nowMs() - ms(have.at) < RULES_FRESH_MS) continue
        const norm = normalizeSubreddit(sub)
        if (norm === undefined) continue
        out.push({ key: `rules:${sub}`, kind: 'sub_rules', subreddit: norm, max_pages: 1 })
        n += 1
      }
    }
    return out
  }

  const queueExtension = async (run: RedditWatchRun, want: RedditWatchPart[]): Promise<void> => {
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
    if (jobRec() !== undefined) {
      for (const p of want) setPart(run, p, { status: 'skipped', message: '上一轮还没读完。' })
      return
    }
    const s = settings()
    const job: RedditReadJob = {
      id: options.newId('rj'),
      workspace_id: ws,
      ...(s.brand_username === undefined ? {} : { expect_user: s.brand_username }),
      reads: readsFor(want),
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

  /** 起一轮（三块里该跑的那几块）。 */
  const start = async (
    trigger: RedditWatchRun['trigger'],
    final: boolean,
    want: RedditWatchPart[],
  ): Promise<RedditWatchRun> => {
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
    emit('reddit_watch.run_started', { run_id: run.id, final, trigger, parts: want })
    if (want.includes('external')) await runExternal(run)
    const viaExt = want.filter((p) => p !== 'external')
    if (viaExt.length > 0) await queueExtension(run, viaExt)
    finishIfDone(run)
    return run
  }

  const applicable = (s: RedditWatchSettings): RedditWatchPart[] => {
    const out: RedditWatchPart[] = ['inbox']
    if (s.own_subreddits.length > 0) out.push('own_sub')
    if (s.keywords.length > 0) out.push('external')
    return out
  }

  const activeRun = (): RedditWatchRun | undefined => {
    const id = store.kv<string | null>(ws, 'active_run')
    if (id === undefined || id === null) return undefined
    const run = store.run(ws, id)
    return run === undefined || run.finished_at !== undefined ? undefined : run
  }

  /* ── 插件交回来的 ───────────────────────────────────────────────── */
  const partOfKey = (key: string): RedditWatchPart => (key === 'inbox' ? 'inbox' : 'own_sub')

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
        const it = watchItemOf(raw, p === 'inbox' ? 'inbox' : 'own_sub', ingestCtx(run), brandUser)
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
    if (rec.status === 'running') pace.endKey(rec.pace_key, rec.job.id)
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
    if (due.length === 0) return { ran: false, skipped: 'not_due' }
    const run = await start('schedule', false, due)
    return { ran: true, run_id: run.id }
  }

  /**
   * WP330 对齐：周报出之前调——做本周最后一次巡查，**等这一轮做完**（插件那两块交回或超时）再回。
   * 有哪一块没读成就抛一句人话（周报照样出、把原因写进去）；正在跑的那一轮直接算作最后一次。
   */
  const sweepNow: RedditWatchAssembly['sweepNow'] = async (o = {}) => {
    sweep()
    let run = activeRun()
    if (run === undefined) {
      const s = settings()
      if (!isConfigured(s)) throw new Error('没配 Reddit 巡查（自家版块、外部关键词都没有）。')
      run = await start('weekly', true, applicable(s))
    } else if (!run.final) {
      store.setKv(ws, 'final_run', run.id)
      run.final = true
      store.putRun(run)
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
        throw new Error('插件还没交回这一轮（Chrome 没开着？），周报先用已经读到的。')
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
    return start('manual', false, isConfigured(s) ? applicable(s) : ['inbox'])
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
      void tick().catch(() => undefined)
    }
    sweep()
    const rec = jobRec()
    if (!input.connected || rec === undefined || rec.status !== 'queued')
      return { retry_after_ms: 60_000 }
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
    onFinal: (l) => {
      finalListeners.add(l)
      return () => finalListeners.delete(l)
    },
    setupTarget: () =>
      redditWatchSetupTarget({
        store,
        workspace_id: ws,
        ...(options.suggestions === undefined ? {} : { suggestions: options.suggestions }),
      }),
    sessionReady,
    sweep,
    pace,
  }
}
