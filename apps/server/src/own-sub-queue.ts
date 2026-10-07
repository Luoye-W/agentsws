/**
 * WP249（决策 81 / 88 / 89）：「自家版待处理」——读队列、出卡、批了之后执行。
 *
 * 只对**登记过、标成自家版**的 subreddit 拉（`SocialAccount.own_subreddit`）。读走 Reddit 的出口
 * （`social-core` 的 `createRedditHybridAdapter`：有 OAuth 走接口、没有走官方号浏览器），
 * 建议由 `suggestOwnSubAction` 按这个版自己的版规给。
 *
 * 四条纪律：
 *
 * 1. **动作一律出卡**（`community_moderation`，风险档 medium → 永远人审；封禁 guardrail 再升 L1）。
 *    卡上写清原文、AI 建议、理由、将执行的动作（移除附的那句公开理由也原样写上）。
 * 2. **批了才执行，只执行卡上那一个**：卡批准后过了取消窗口，由执行器调 {@link OwnSubQueue.apply}
 *    （`server.ts` 的 `backendApply`），结果进变更账本；失败照实报（卡上「执行没成」+ 队列里那一条
 *    标上原话），不重试。
 * 3. **限速复用适配器那一本账**：接口那条每分钟 60 跳（`reddit.ts`），浏览器那条低频（官方号浏览器
 *    自己的读写账）。这里不另数。
 * 4. **队列正文是外部文本**：原样上卡给人看，进事件日志的只有 id 与动作名。
 */
import type { SocialActor, SocialStagedView } from '@agentsws/api'
import { ApiError } from '@agentsws/api'
import type {
  ApprovalItem,
  ChangeKind,
  Clock,
  ObjectRef,
  OwnSubQueueItem,
  OwnSubQueueView,
  OwnSubSourceStatus,
  OwnSubStageInput,
  RedditOfficialBrowserStatus,
  SocialAccount,
  StagedChange,
  WorkspaceId,
} from '@agentsws/contracts'
import {
  ACTION_WORDS,
  type ModerationAction,
  type ModQueueEntry,
  ownSubKindOf,
  type SocialChannelAdapter,
  suggestOwnSubAction,
} from '@agentsws/social-core'
import type { RedditOfficialBrowser } from './reddit-official-browser/index.js'
import type { SocialStore } from './social.js'

/** 这一类卡在 `after.source` 上的记号（执行器靠它认出来）。 */
export const OWN_SUB_SOURCE = 'own_sub_queue'

/** 与 `social-service.ts` 的 `stageOne` 同形（由它注入，审批与额度只有那一处）。 */
export type OwnSubStageFn = (input: {
  actor: SocialActor
  action: string
  kind: ChangeKind
  target: ObjectRef
  before: unknown
  after: unknown
  notes: string[]
  title: string
  summary: string
  seen: ObjectRef[]
  rule: 'role_holder' | 'scope_manager' | 'owner'
}) => Promise<SocialStagedView>

export interface OwnSubQueueOptions {
  workspace_id: WorkspaceId
  store: SocialStore
  clock: Clock
  /** Reddit 的出口（接口优先、浏览器兜底）。没装配 = 两条都不通。 */
  adapter(): SocialChannelAdapter | undefined
  /** 连接里有没有 Reddit 的 OAuth 凭据（页头说这次走的哪条路）。 */
  apiConnected(): boolean
  officialBrowser?: RedditOfficialBrowser
  stage: OwnSubStageFn
  ledger: {
    list(filter: { workspace_id: WorkspaceId; kind?: ChangeKind }): Promise<StagedChange[]>
  }
  emit(type: string, actor: string, payload: Record<string, unknown>): void
  /**
   * 批准之后把这张卡施行掉（`txn.executor.applyApproval`）。取消窗口内会被拒，所以批准那一刻
   * 先排一个「窗口过了再施行」，读队列时再扫一遍补漏。
   */
  applyApproval?(item_id: string): Promise<unknown>
  /** 取消窗口（毫秒；与 txn 策略同一个数，默认 120 秒）。 */
  cancelWindowMs?: number
}

export interface OwnSubQueue {
  queue(actor: SocialActor): Promise<OwnSubQueueView>
  stage(actor: SocialActor, input: OwnSubStageInput): Promise<SocialStagedView>
  /** 执行器调：是这一类卡就执行并回结果，不是就 `undefined`（掉回原来那条路）。 */
  apply(change: StagedChange): Promise<
    | {
        status: 'ok' | 'failed'
        execution_id?: string
        error?: { message: string; retryable?: boolean }
      }
    | undefined
  >
  /** 审批决定之后（批准 → 过了取消窗口施行）。 */
  onDecided(item: ApprovalItem): Promise<void>
  browserStatus(): RedditOfficialBrowserStatus
  openLogin(): Promise<RedditOfficialBrowserStatus>
  checkLogin(): Promise<RedditOfficialBrowserStatus>
  closeWindow(): Promise<RedditOfficialBrowserStatus>
  close(): void
}

interface Cached {
  entry: ModQueueEntry
  account: SocialAccount
}

const NO_BROWSER_STATUS: RedditOfficialBrowserStatus = {
  state: 'unknown',
  message: '这台没装配官方号浏览器通道。',
  writes_last_day: 0,
  max_writes_per_day: 0,
}

const isOwnSub = (after: unknown): after is Record<string, unknown> =>
  typeof after === 'object' &&
  after !== null &&
  (after as { source?: unknown }).source === OWN_SUB_SOURCE

const subName = (a: SocialAccount): string =>
  (a.external_id || a.handle).replace(/^\/?r\//u, '').replace(/\/$/u, '')

export function createOwnSubQueue(options: OwnSubQueueOptions): OwnSubQueue {
  const { workspace_id, store, clock } = options
  const cache = new Map<string, Cached>()
  /** 版规（短名）与读到的时刻：版规难得改，六小时内不重读（省官方号浏览器的读额度）。 */
  const rulesOf = new Map<string, string[]>()
  const rulesAt = new Map<string, number>()
  const RULES_TTL_MS = 6 * 3_600_000
  const failures = new Map<string, string>()
  /** 队列里那一条 → 它那张卡的审批项 id（卡片流认的是它）。 */
  const approvalOf = new Map<string, string>()
  const timers = new Set<NodeJS.Timeout>()
  const windowMs = options.cancelWindowMs ?? 120_000

  const ownSubs = (): SocialAccount[] =>
    store.accounts({ channel: 'reddit' }).filter((a) => a.own_subreddit === true)

  const browserStatus = (): RedditOfficialBrowserStatus =>
    options.officialBrowser?.status() ?? NO_BROWSER_STATUS

  const channel = (): OwnSubQueueView['channel'] =>
    options.apiConnected()
      ? 'api'
      : options.officialBrowser?.port.ready() === true
        ? 'browser'
        : 'none'

  /** 这个品牌还没定的 / 批了还没施行的那几张版务卡。 */
  const ownCards = async (): Promise<StagedChange[]> =>
    (await options.ledger.list({ workspace_id, kind: 'community_moderation' })).filter((c) =>
      isOwnSub(c.after),
    )

  /** 批了、过了取消窗口、还没施行的：补施行（读队列时顺手扫一遍）。 */
  const drain = async (cards: readonly StagedChange[]): Promise<void> => {
    if (options.applyApproval === undefined) return
    const nowMs = Date.parse(clock.now())
    for (const c of cards) {
      if (c.status !== 'approved' || c.approval === undefined) continue
      if (nowMs - Date.parse(c.approval.at) < windowMs) continue
      await options.applyApproval(c.approval.item_id).catch(() => undefined)
    }
  }

  return {
    async queue(_actor) {
      const subs = ownSubs()
      const cards = await ownCards()
      await drain(cards)
      const pending = new Map<string, string>()
      for (const c of await ownCards()) {
        const after = c.after as Record<string, unknown>
        if (c.status === 'staged' && typeof after.item_id === 'string')
          pending.set(after.item_id, approvalOf.get(after.item_id) ?? c.id)
      }
      const sources: OwnSubSourceStatus[] = []
      const items: OwnSubQueueItem[] = []
      const rules: OwnSubQueueView['rules'] = []
      const adapter = options.adapter()
      const route = channel()
      cache.clear()
      for (const account of subs) {
        const sub = subName(account)
        if (adapter === undefined || route === 'none') {
          for (const source of ['modqueue', 'unmoderated'] as const)
            sources.push({
              subreddit: sub,
              source,
              status: 'failed',
              message:
                '还没接上：去连接页点「登录官方号」，在弹出的浏览器里登录你们的官方号（或填已有的 OAuth 开发者应用）。',
            })
          rules.push({ subreddit: sub, rules: [] })
          continue
        }
        const fresh = Date.parse(clock.now()) - (rulesAt.get(sub) ?? -Infinity) < RULES_TTL_MS
        const r = fresh ? undefined : await adapter.communityRules?.(sub)
        const subRules = r?.ok === true ? r.data : (rulesOf.get(sub) ?? [])
        if (r?.ok === true) {
          rulesOf.set(sub, r.data)
          rulesAt.set(sub, Date.parse(clock.now()))
        }
        rules.push({ subreddit: sub, rules: subRules })
        for (const source of ['modqueue', 'unmoderated', 'join_requests'] as const) {
          const res = await adapter.modQueue?.({ account_external_id: sub, source, limit: 50 })
          if (res === undefined || !res.ok) {
            sources.push({
              subreddit: sub,
              source,
              status:
                res === undefined || res.reason === 'not_implemented'
                  ? 'unsupported'
                  : res.reason === 'rate_limited'
                    ? 'limited'
                    : 'failed',
              message: res?.message ?? '这条通道读不了这一类。',
            })
            continue
          }
          sources.push({ subreddit: sub, source, status: 'ok', count: res.data.length })
          for (const entry of res.data) {
            // 同一条既在 modqueue 又在 unmoderated：按 modqueue 那一条算（带举报的更要紧）
            if (cache.has(entry.id)) continue
            cache.set(entry.id, { entry, account })
            const pendingChange = pending.get(entry.id)
            const failure = failures.get(entry.id)
            items.push({
              id: entry.id,
              account_id: account.id,
              subreddit: sub,
              kind: ownSubKindOf(entry),
              thing: entry.thing,
              ...(entry.title === undefined ? {} : { title: entry.title }),
              excerpt: entry.excerpt,
              author: entry.author,
              report_reasons: entry.report_reasons,
              ...(entry.created_at === undefined ? {} : { created_at: entry.created_at }),
              url: entry.url,
              suggestion: suggestOwnSubAction(entry, subRules),
              ...(pendingChange === undefined ? {} : { pending_approval_id: pendingChange }),
              ...(failure === undefined ? {} : { last_failure: failure }),
            })
          }
        }
      }
      return {
        subreddits: subs.map((a) => ({
          account_id: a.id,
          name: subName(a),
          display_name: a.display_name,
        })),
        channel: route,
        browser: browserStatus(),
        sources,
        items,
        rules,
        observed_at: clock.now(),
      }
    },

    async stage(actor, input) {
      const hit = cache.get(input.item_id)
      if (hit === undefined || hit.account.id !== input.account_id)
        throw new ApiError('not_found', '队列里没有这一条了（可能刚被处理过）。刷新一下再点。')
      const cards = await ownCards()
      if (
        cards.some(
          (c) =>
            c.status === 'staged' && (c.after as Record<string, unknown>).item_id === input.item_id,
        )
      )
        return { staged: false, message: '这一条已经有一张卡在等你定了，去卡片流里看。' }
      const { entry, account } = hit
      const sub = subName(account)
      const suggestion = suggestOwnSubAction(entry, rulesOf.get(sub) ?? [])
      const action: ModerationAction =
        input.action === 'approve'
          ? 'approve'
          : input.action === 'remove'
            ? 'delete_post'
            : input.ban_days === undefined
              ? 'permanent_ban'
              : 'ban'
      const removal_rule = input.action === 'remove' ? input.removal_rule?.trim() : undefined
      const removal_message =
        removal_rule === undefined || removal_rule === ''
          ? undefined
          : `Removed: this breaks r/${sub} rule "${removal_rule}".`
      const what =
        input.action === 'ban'
          ? `封禁 u/${entry.author}${input.ban_days === undefined ? '（永久）' : `（${input.ban_days} 天）`}`
          : `${input.action === 'approve' ? '批准' : '移除'} u/${entry.author} 的这条${entry.thing === 'post' ? '帖子' : '评论'}`
      const via = channel() === 'api' ? '官方接口' : '官方号浏览器'
      const original =
        `${entry.title === undefined ? '' : `${entry.title}\n`}${entry.excerpt}`.slice(0, 600)
      const verdictWord = { approve: '批准', remove: '移除', ignore: '先不管' }[suggestion.verdict]
      const staged = await options.stage({
        actor,
        action: 'moderate',
        kind: 'community_moderation',
        target: { type: 'community_thread', id: entry.id },
        before: { status: 'in_queue', kind: ownSubKindOf(entry) },
        after: {
          source: OWN_SUB_SOURCE,
          action,
          action_label: ACTION_WORDS[action],
          channel: 'reddit',
          channel_label: `Reddit · r/${sub}`,
          account_id: account.id,
          subreddit: sub,
          item_id: entry.id,
          queue: entry.source,
          target_external_id: input.action === 'ban' ? entry.author : entry.id,
          author: entry.author,
          thing: entry.thing,
          ...(entry.title === undefined ? {} : { title: entry.title }),
          excerpt: entry.excerpt,
          report_reasons: entry.report_reasons,
          url: entry.url,
          suggestion,
          ...(input.action === 'ban' && input.ban_days !== undefined
            ? { duration_minutes: input.ban_days * 1440 }
            : {}),
          ...(removal_rule === undefined || removal_rule === '' ? {} : { removal_rule }),
          ...(removal_message === undefined ? {} : { removal_message }),
          via: channel(),
        },
        notes: [
          `将执行：${what}（经${via}）。`,
          `AI 建议：${verdictWord}。理由：${suggestion.reason}`,
          ...(entry.report_reasons.length === 0
            ? []
            : [`举报原因：${entry.report_reasons.join('；')}`]),
          ...(removal_message === undefined ? [] : [`移除后公开回复一句：${removal_message}`]),
        ],
        title: `${what}（r/${sub}）`,
        summary: `将执行：${what}。AI 建议：${verdictWord}——${suggestion.reason} 原文：${original}`,
        seen: [{ type: 'community_thread', id: entry.id }],
        rule: 'role_holder',
      })
      failures.delete(entry.id)
      if (staged.approval_item_id !== undefined) approvalOf.set(entry.id, staged.approval_item_id)
      options.emit('social.own_sub_staged', actor.person_id, {
        item_id: entry.id,
        subreddit: sub,
        action,
        suggestion: suggestion.verdict,
        staged: staged.staged,
      })
      return staged
    },

    async apply(change) {
      if (change.kind !== 'community_moderation' || !isOwnSub(change.after)) return undefined
      const after = change.after
      const adapter = options.adapter()
      const fail = (message: string) => {
        if (typeof after.item_id === 'string') failures.set(after.item_id, message)
        options.emit('social.own_sub_failed', 'system', {
          change_id: change.id,
          item_id: after.item_id,
          action: after.action,
        })
        return { status: 'failed' as const, error: { message, retryable: false } }
      }
      if (adapter?.moderate === undefined) return fail('Reddit 还没接上，这一条没执行。')
      const res = await adapter.moderate({
        account_external_id: String(after.subreddit ?? ''),
        target_external_id: String(after.target_external_id ?? ''),
        action: after.action as ModerationAction &
          ('approve' | 'delete_post' | 'ban' | 'permanent_ban'),
        ...(after.queue === 'modqueue' || after.queue === 'unmoderated'
          ? { queue: after.queue }
          : {}),
        ...(typeof after.removal_message === 'string'
          ? { removal_message: after.removal_message }
          : {}),
        ...(typeof after.duration_minutes === 'number'
          ? { duration_minutes: after.duration_minutes }
          : {}),
      })
      if (!res.ok) return fail(res.message)
      if (typeof after.item_id === 'string') {
        failures.delete(after.item_id)
        cache.delete(after.item_id)
      }
      options.emit('social.own_sub_applied', 'system', {
        change_id: change.id,
        item_id: after.item_id,
        action: after.action,
      })
      return { status: 'ok', execution_id: `own_sub_${change.id}` }
    },

    async onDecided(item) {
      if (item.workspace_id !== workspace_id) return
      if (item.state !== 'approved' && item.state !== 'approved_edited') return
      const apply = options.applyApproval
      if (apply === undefined) return
      const t = setTimeout(() => {
        timers.delete(t)
        void apply(item.id).catch(() => undefined)
      }, windowMs + 1_000)
      t.unref?.()
      timers.add(t)
    },

    browserStatus,
    openLogin: async () => (await options.officialBrowser?.openLogin()) ?? NO_BROWSER_STATUS,
    checkLogin: async () => (await options.officialBrowser?.checkLogin()) ?? NO_BROWSER_STATUS,
    async closeWindow() {
      await options.officialBrowser?.closeWindow()
      return browserStatus()
    },
    close() {
      for (const t of timers) clearTimeout(t)
      timers.clear()
      void options.officialBrowser?.close()
    },
  }
}

/** 这张审批卡是不是自家版那一类（`server.ts` 的决定钩子用）。 */
export function isOwnSubApproval(item: ApprovalItem): boolean {
  const payload = item.payload as { kind?: unknown; after?: unknown } | undefined
  return payload?.kind === 'community_moderation' && isOwnSub(payload.after)
}
