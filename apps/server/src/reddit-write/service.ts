/**
 * WP329（docs/102 §2.3 / §4 / §5.1，决策 663 / 667 / 669 / 708）：**Reddit 写**，每品牌一份。
 *
 * 一条路：起草（{@link RedditWriteService.draft}：FAQ + 品牌话术 + 帖子上下文 + 版规原文）
 * → 出一张「发出去」卡（{@link RedditWriteService.stage}：`outbound_draft` + `form: 'reddit_write'`，**永远 L1**）
 * → 人批（卡上能改字；个人模式审批人就是本人：669）
 * → 过了取消窗口执行器施行（{@link RedditWriteService.deliver}）：
 *    - 插件连着 Reddit：排进插件动作通道（WP313）→ 插件在用户已登录的 Reddit 页面里把草稿填进框 →
 *      **人自己点发送** → 插件认出新出现的那一条、读回编号与链接（{@link RedditWriteService.onActionEvent}）；
 *    - 插件从没连过、但有 OAuth 应用 / 官方号浏览器登着：走那条直发（`direct`，WP249 留作备用）；
 *    - 都没有：照样排进插件通道等 24 小时（用户批完再去 Chrome 里连 Reddit 也来得及），卡上照实说。
 * → 读回确认才算发出去：本地发出记录多一行（WP323，带编号与链接，之后对方的回复按编号挂回这一行）；
 *    没确认到（没点 / 被拦 / 没登录 / 停了 / 作废）就照实说原因，**不自动重试**。
 *
 * 交给插件那一刻，卡的施行结果记 `ok`（`outcome_ref.type = 'reddit_fill'`，与「人自己发」的 `manual_send`
 * 同一个意思：系统这一侧做完了，剩下那一下是人点）；真发没发出去看 {@link RedditWriteService.writes}。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SocialActor } from '@agentsws/api'
import {
  buildRedditJob,
  RedditPlanError,
  type RedditWrite,
  redditWritePlan,
} from '@agentsws/browser-action'
import type {
  ApprovalBus,
  ApprovalItem,
  Clock,
  ObjectRef,
  OutboundRecord,
  OutboundRecordInput,
  RedditDraftFact,
  RedditDraftInput,
  RedditDraftView,
  RedditStageInput,
  RedditStageResult,
  RedditWritePayload,
  RedditWriteSource,
  RedditWriteTarget,
  RedditWriteView,
  WorkspaceId,
} from '@agentsws/contracts'
import { REDDIT_WRITE_FORM } from '@agentsws/contracts'
import { checkOutbound, resolveVoice, voicePrompt } from '@agentsws/social-core'
import { finalPayload } from '@agentsws/txn'
import type { AdsActionEvent, AdsActionsService } from '../ads-actions/service.js'
import { replyBlockedReason } from '../social-reply-draft.js'
import { factQuery, type RedditDrafter, templateRedditDraft } from './draft.js'

/** 插件多久没来过就不算「连着 Reddit」（一周：电脑关了几天回来照样能接着做）。 */
export const EXTENSION_FRESH_MS = 7 * 24 * 60 * 60 * 1000
/** 本地留多少条进度（发出记录里另有永久的一份）。 */
const KEEP = 200

/** 执行器回给 txn 的那一份（与 `@agentsws/txn` 的 `BackendResult` 同形）。 */
export interface RedditWriteResult {
  status: 'ok' | 'failed'
  execution_id?: string
  outcome_ref?: ObjectRef | { type: string; id: string }
  error?: { message: string; retryable: boolean }
}

/** 直发（OAuth 应用 / 官方号浏览器）那一跳要的。 */
export interface RedditDirectWrite {
  write: RedditWrite
  text: string
  title?: string
  approval_id: string
}

export type RedditDirectResult =
  | { ok: true; external_id: string; url?: string }
  | { ok: false; message: string }

/** 一条批过的写（本地进度）。 */
export interface RedditWriteEntry extends RedditWriteView {
  via: 'extension' | 'direct'
  source?: RedditWriteSource
  /** 发出去那一条的编号（`t1_…` / `t3_…`）。 */
  fullname?: string
  /** 写进发出记录的那一行（发出去之后补上编号与链接）。 */
  record: OutboundRecordInput
  /**
   * WP332（决策 762）：交给插件的那一份（写到哪 + 批过的正文 / 标题），「再填一次」原样再交——不用重批。
   * WP332 之前的老进度没有这几格，那几条不能再填。
   */
  write?: RedditWrite
  text?: string
  title?: string
  /** 之前几次交给插件的活（再填一次换了新的 `job_id`）。 */
  previous_jobs?: string[]
}

export interface RedditWriteServiceOptions {
  workspace_id: WorkspaceId
  clock: Clock
  approvals: Pick<ApprovalBus, 'create'>
  emit(type: string, actor: string, payload: Record<string, unknown>): void
  /** 品牌名（提示词里用）。 */
  brand(): string
  /** 品牌号用户名（不带 `u/`；不知道 = undefined，按品牌算每天的写额度）。 */
  account?(): string | undefined
  /** 起草引擎（没接上真模型 = undefined，给一句模板并照实说）。 */
  drafter?(actor: SocialActor): RedditDrafter | undefined
  /** 查知识库（WP322 的 FAQ 卡也在里面）。 */
  facts?(actor: SocialActor, query: string): Promise<RedditDraftFact[]>
  /** 品牌话术（公司层技能 `brand-voice` 的正文；没有 = undefined）。 */
  voice?(actor: SocialActor): Promise<string | undefined>
  /** 这个版的版规原文（读不到 = undefined；读不到就不放进提示词，不替用户判能不能推广）。 */
  rules?(subreddit: string): Promise<string[] | undefined>
  /** 插件动作通道（每品牌一份；托管实例没有）。 */
  actions?: Pick<AdsActionsService, 'enqueue' | 'lastSeen' | 'jobs'>
  /** 插件用不了时的直发；这条路不通回 `undefined`。 */
  direct?(input: RedditDirectWrite): Promise<RedditDirectResult | undefined>
  /** 发出去了：记进发出记录（WP323）。 */
  record(input: OutboundRecordInput): OutboundRecord | undefined
  /** 审批人 id → 人名（发出记录「谁批的」那一格）。 */
  approverName?(person_id: string): Promise<string | undefined>
  /** 出了卡（WP328 的待处理条目标「起草中」）。 */
  onStaged?(source: RedditWriteSource, approval_item_id: string): void
  /** 一条写有了结局（发出去了 / 没发出去）：按来源回写（社媒线程 / 公关帖 / WP328 条目）。 */
  onSettled?(entry: RedditWriteEntry): void
  /** 施行一张卡（`txn.executor.applyApproval`）。取消窗口内会被拒，所以批准那一刻先排一个。 */
  applyApproval?(item_id: string): Promise<unknown>
  /** 取消窗口（毫秒；与 txn 策略同一个数，默认 120 秒）。 */
  cancelWindowMs?: number
  /** 这本账上批了、还没施行的「发出去」卡（补扫用）。 */
  approvedItems?(): readonly ApprovalItem[]
  /** `<品牌目录>/reddit-writes`；不给 = 纯内存。 */
  dir?: string
  /** 测试指向本地假 old.reddit。 */
  origin?: string
}

/** 一次写交进来要的（卡、社媒回帖、公关外部帖三条路都汇到这里）。 */
export interface RedditSendInput {
  approval_item_id: string
  write: RedditWrite
  text: string
  title?: string
  subreddit: string
  record: OutboundRecordInput
  source?: RedditWriteSource
  label?: string
}

export interface RedditWriteService {
  draft(actor: SocialActor, input: RedditDraftInput): Promise<RedditDraftView>
  stage(actor: SocialActor, input: RedditStageInput): Promise<RedditStageResult>
  /**
   * WP328 → WP329 的接口：「待处理」里一条要回的（`redditTargetFromItem(item)` 转成写到哪）——
   * 起草一份、直接出一张「发出去」卡（人在卡上改字、批）。起草出来是空的、或过不了承诺扫描就不出卡、照实回。
   * 发新帖不走这里（要人给要点）。
   */
  draftAndStage(
    actor: SocialActor,
    input: { target: RedditWriteTarget; reason?: string },
  ): Promise<RedditStageResult>
  /** 执行器调：是 Reddit 写卡就交出去并回结果，不是回 undefined。 */
  deliver(item: ApprovalItem): Promise<RedditWriteResult | undefined>
  /** 社媒回帖卡 / 公关外部帖也从这里交出去（同一条插件通道、同一份进度与记录）。 */
  send(input: RedditSendInput): Promise<RedditWriteResult>
  /** 插件动作通道的事件（只认 Reddit 的活）。 */
  onActionEvent(event: AdsActionEvent): void
  /**
   * WP332（决策 762）：没发出去的那一条「再填一次」——同一份已批的草稿原样再交给插件（新的一件活），
   * **不出新卡、不用重批**；人照样自己点发送。只有没发出去的、走插件的、记着草稿的才能再填。
   */
  refill(
    job_id: string,
  ): Promise<{ ok: true; view: RedditWriteView } | { ok: false; message: string }>
  /** WP332：人看过、收起岗位页那一行提醒（这一条再填一次又没发出去时重新出）。 */
  dismiss(job_id: string): RedditWriteView | undefined
  writes(): RedditWriteView[]
  /** 插件最近一周来过、连着 Reddit。 */
  extensionReady(): boolean
  /** 决策 761：直发开关（默认关）。 */
  settings(): RedditWriteSettings
  setSettings(patch: Partial<RedditWriteSettings>): RedditWriteSettings
  /** 卡被决定了（批了 → 过了取消窗口施行）。不是 Reddit 写卡什么都不做。 */
  onDecided(item: ApprovalItem): Promise<void>
  /** 补扫：批了、过了取消窗口、还没施行的那几张。回施行了几张。 */
  sweep(): Promise<number>
  close(): void
}

/** 这张审批项是不是 Reddit「发出去」卡。 */
export function isRedditWriteCard(item: Pick<ApprovalItem, 'kind' | 'payload'>): boolean {
  return (
    item.kind === 'outbound_draft' &&
    typeof item.payload === 'object' &&
    item.payload !== null &&
    (item.payload as Record<string, unknown>).form === REDDIT_WRITE_FORM
  )
}

const APPROVED = new Set(['approved', 'approved_edited'])

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined

const subOf = (s: string): string => s.replace(/^\/?r\//u, '').trim()

/** 写到哪 → 插件那一侧的「一次写」。对不上形状回一句人话。 */
export function writeOfTarget(
  target: RedditWriteTarget,
  title?: string,
): RedditWrite | { why: string } {
  const sub = subOf(target.subreddit)
  if (target.parent_fullname?.startsWith('t4_') === true)
    return { why: '私信不在这里回（主动发私信永远不做）。' }
  switch (target.kind) {
    case 'reply':
      if (target.parent_fullname === undefined || !target.parent_fullname.startsWith('t1_'))
        return { why: '要回的那条评论没有编号。' }
      if (target.permalink === undefined) return { why: '要回的那条评论没有链接，找不到回复框。' }
      return { kind: 'reply', parent: target.parent_fullname, permalink: target.permalink }
    case 'comment':
      if (target.parent_fullname === undefined || !target.parent_fullname.startsWith('t3_'))
        return { why: '要回的那个帖子没有编号。' }
      return {
        kind: 'comment',
        post: target.parent_fullname,
        ...(target.permalink === undefined ? {} : { permalink: target.permalink }),
      }
    case 'submit':
      if (title === undefined || title.trim() === '') return { why: '新帖要有标题。' }
      return { kind: 'submit', subreddit: sub, title: title.trim() }
  }
}

const ACTION_OF: Record<RedditWrite['kind'], string> = {
  reply: 'reply',
  comment: 'comment',
  submit: 'post',
}

/** 站内路径 → 给人点的链接。 */
export const redditLink = (path: string | undefined): string | undefined =>
  path === undefined || path === ''
    ? undefined
    : /^https?:/iu.test(path)
      ? path
      : `https://www.reddit.com${path.startsWith('/') ? '' : '/'}${path}`

interface StateFile {
  version: 1
  entries: RedditWriteEntry[]
  seq: number
  /** 决策 761：插件不在线时要不要走程序直发（OAuth 应用 / 官方号浏览器）。默认关。 */
  direct_fallback?: boolean
}

/** Reddit 写的设置（决策 761）。 */
export interface RedditWriteSettings {
  /** 插件不在线时走程序直发（不是人点）。默认关：等插件、等你打开 Chrome。 */
  direct_fallback: boolean
}

/** WP332：能不能「再填一次」：走插件的、记着草稿的（直发那条路不再填：761 默认关）。 */
const canRefill = (e: RedditWriteEntry): boolean =>
  e.via === 'extension' && e.write !== undefined && e.text !== undefined

/** 插件不在线时进度里那一句。 */
export const PLUGIN_OFFLINE = '插件不在线，等你打开 Chrome（24 小时内来领都行）。'

export function createRedditWriteService(options: RedditWriteServiceOptions): RedditWriteService {
  const ws = options.workspace_id
  const stateFile = options.dir === undefined ? undefined : join(options.dir, 'state.json')
  const loaded = ((): StateFile | undefined => {
    if (stateFile === undefined || !existsSync(stateFile)) return undefined
    try {
      const raw = JSON.parse(readFileSync(stateFile, 'utf8')) as StateFile
      return raw.version === 1 ? raw : undefined
    } catch {
      return undefined
    }
  })()
  const entries: RedditWriteEntry[] = [...(loaded?.entries ?? [])]
  let seq = loaded?.seq ?? 0
  let directFallback = loaded?.direct_fallback === true
  /** 起草时查到的知识卡（出卡时按 id 带上那句话；只在内存里留最近的）。 */
  const factCache = new Map<string, RedditDraftFact>()

  const now = (): string => options.clock.now()
  const nextId = (prefix: string): string =>
    `${prefix}_${Date.parse(now()).toString(36)}_${(++seq).toString(36)}`

  const save = (): void => {
    if (stateFile === undefined || options.dir === undefined) return
    while (entries.length > KEEP) entries.shift()
    mkdirSync(options.dir, { recursive: true })
    const tmp = `${stateFile}.tmp`
    writeFileSync(
      tmp,
      JSON.stringify({
        version: 1,
        entries,
        seq,
        ...(directFallback ? { direct_fallback: true } : {}),
      } satisfies StateFile),
    )
    renameSync(tmp, stateFile)
  }

  const extensionReady = (): boolean => {
    const seen = options.actions?.lastSeen('reddit')
    return seen !== undefined && Date.parse(now()) - seen < EXTENSION_FRESH_MS
  }

  const failed = (message: string): RedditWriteResult => ({
    status: 'failed',
    error: { message, retryable: false },
  })

  const settle = (entry: RedditWriteEntry): void => {
    save()
    try {
      options.onSettled?.(entry)
    } catch {
      // 回写不上不影响这一条的结局
    }
  }

  /** 发出去了：记一行发出记录（带编号与链接）。 */
  const markSent = (entry: RedditWriteEntry, fullname?: string, path?: string): void => {
    const link = redditLink(path)
    entry.state = 'sent'
    entry.finished_at = now()
    if (fullname !== undefined && fullname !== '') entry.fullname = fullname
    if (link !== undefined) entry.link = link
    delete entry.message
    try {
      const row = options.record({
        ...entry.record,
        ...(entry.fullname === undefined ? {} : { external_id: entry.fullname }),
        ...(link === undefined ? {} : { link }),
        sent_at: entry.finished_at,
      })
      if (row !== undefined) entry.record_id = row.id
    } catch {
      // 记不上不挡「发出去了」这件事
    }
    options.emit('reddit.write_sent', 'system', {
      approval_item_id: entry.approval_item_id,
      job_id: entry.job_id,
      kind: entry.kind,
      via: entry.via,
      ...(entry.record_id === undefined ? {} : { record_id: entry.record_id }),
    })
    settle(entry)
  }

  const markFailed = (entry: RedditWriteEntry, message: string, outcome: string): void => {
    entry.state = 'failed'
    entry.finished_at = now()
    entry.message = message
    entry.outcome = outcome
    options.emit('reddit.write_failed', 'system', {
      approval_item_id: entry.approval_item_id,
      job_id: entry.job_id,
      kind: entry.kind,
      outcome,
    })
    settle(entry)
  }

  /** 交给插件动作通道（一件新活）。 */
  const toPlugin = async (
    input: Pick<RedditSendInput, 'write' | 'text' | 'approval_item_id' | 'label'>,
  ): Promise<{ ok: true; job: { id: string } } | { ok: false; why: string }> => {
    const actions = options.actions
    if (actions === undefined)
      return {
        ok: false,
        why: 'Reddit 还没接上：在 Chrome 的「Agents 工坊助手」插件里连接 Reddit（或填已有的 OAuth 开发者应用）。',
      }
    const job = buildRedditJob({
      id: nextId('rdw'),
      workspace_id: ws,
      account_id: options.account?.() ?? `ws:${ws}`,
      action: { write: input.write, text: input.text },
      approval_id: input.approval_item_id,
      approval_level: 'L1',
      ...(input.label === undefined ? {} : { title: input.label }),
      created_at: now(),
      ...(options.origin === undefined ? {} : { origin: options.origin }),
    })
    const queued = await actions.enqueue(job)
    return queued.ok ? { ok: true, job } : queued
  }

  const send = async (input: RedditSendInput): Promise<RedditWriteResult> => {
    const plan = (() => {
      try {
        redditWritePlan({ write: input.write, text: input.text }, options.origin)
        return undefined
      } catch (err) {
        return err instanceof RedditPlanError ? err.message : String(err)
      }
    })()
    if (plan !== undefined) return failed(plan)
    const base = {
      approval_item_id: input.approval_item_id,
      kind: input.write.kind,
      subreddit: subOf(input.subreddit),
      queued_at: now(),
      ...(input.source === undefined ? {} : { source: input.source }),
      record: input.record,
    }
    // 插件最近没来过、有直发的路：先走直发（OAuth 应用 / 官方号浏览器；WP249 留作备用）
    // 决策 761：直发是开关、默认关——关着就一律等插件（人点发送）
    if (directFallback && !extensionReady() && options.direct !== undefined) {
      const direct = await options.direct({
        write: input.write,
        text: input.text,
        ...(input.title === undefined ? {} : { title: input.title }),
        approval_id: input.approval_item_id,
      })
      if (direct !== undefined) {
        const entry: RedditWriteEntry = {
          ...base,
          job_id: nextId('rdd'),
          state: 'queued',
          via: 'direct',
        }
        entries.push(entry)
        if (!direct.ok) {
          markFailed(entry, direct.message, 'failed')
          return failed(direct.message)
        }
        markSent(entry, direct.external_id, direct.url)
        return {
          status: 'ok',
          execution_id: `reddit_direct_${entry.job_id}`,
          outcome_ref: { type: 'reddit_write', id: entry.job_id },
        }
      }
    }
    const queued = await toPlugin(input)
    if (!queued.ok) return failed(queued.why)
    const job = queued.job
    const entry: RedditWriteEntry = {
      ...base,
      job_id: job.id,
      state: 'queued',
      via: 'extension',
      ...(extensionReady() ? {} : { message: PLUGIN_OFFLINE }),
      write: input.write,
      text: input.text,
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.label === undefined ? {} : { label: input.label }),
    }
    entries.push(entry)
    save()
    options.emit('reddit.write_queued', 'system', {
      approval_item_id: input.approval_item_id,
      job_id: job.id,
      kind: input.write.kind,
    })
    return {
      status: 'ok',
      execution_id: `reddit_fill_${job.id}`,
      outcome_ref: { type: 'reddit_fill', id: job.id },
    }
  }

  const titleOf = (target: RedditWriteTarget, title: string | undefined): string => {
    const where = `Reddit · r/${subOf(target.subreddit)}`
    switch (target.kind) {
      case 'reply':
        return `回复 ${target.parent_author ?? '一条评论'}（${where}）`
      case 'comment':
        return `回帖：${(target.post_title ?? target.parent_author ?? '一个帖子').slice(0, 60)}（${where}）`
      case 'submit':
        return `发帖：${(title ?? '').slice(0, 60)}（${where}）`
    }
  }

  const windowMs = options.cancelWindowMs ?? 120_000
  const timers = new Set<NodeJS.Timeout>()
  const apply = async (id: string): Promise<boolean> => {
    if (options.applyApproval === undefined) return false
    try {
      await options.applyApproval(id)
      return true
    } catch {
      // 取消窗口没过 / 已经施行过 / 被撤了：下一轮再说（或者不用再说）
      return false
    }
  }

  const service: RedditWriteService = {
    extensionReady,
    send,
    settings: () => ({ direct_fallback: directFallback }),
    setSettings(patch) {
      if (patch.direct_fallback !== undefined) directFallback = patch.direct_fallback
      save()
      return { direct_fallback: directFallback }
    },

    async onDecided(item) {
      if (item.workspace_id !== ws || !APPROVED.has(item.state) || !isRedditWriteCard(item)) return
      if (options.applyApproval === undefined) return
      const t = setTimeout(() => {
        timers.delete(t)
        void apply(item.id)
      }, windowMs + 1_000)
      t.unref?.()
      timers.add(t)
    },

    async sweep() {
      const nowMs = Date.parse(now())
      let applied = 0
      for (const item of options.approvedItems?.() ?? []) {
        if (item.workspace_id !== ws || !APPROVED.has(item.state) || !isRedditWriteCard(item))
          continue
        const at = item.decision?.at
        if (at !== undefined && nowMs - Date.parse(at) < windowMs) continue
        if (await apply(item.id)) applied += 1
      }
      return applied
    },

    close() {
      for (const t of timers) clearTimeout(t)
      timers.clear()
    },

    async draft(actor, input) {
      const target = input.target
      const shape = writeOfTarget(target, target.kind === 'submit' ? 'x' : undefined)
      if ('why' in shape) throw new RedditPlanError(shape.why)
      const query = factQuery(target, input.instruction)
      const facts = (
        query === '' ? [] : await (options.facts?.(actor, query) ?? Promise.resolve([]))
      ).slice(0, 6)
      for (const f of facts) factCache.set(f.id, f)
      while (factCache.size > 200) factCache.delete(factCache.keys().next().value as string)
      const guidance = await options.voice?.(actor).catch(() => undefined)
      const voice = voicePrompt(
        resolveVoice(
          guidance === undefined ? [] : [{ id: 'brand-voice', scope: 'org', guidance }],
          'reddit',
        ),
      )
      const rules = await options.rules?.(subOf(target.subreddit)).catch(() => undefined)
      const account = options.account?.()
      const drafter = options.drafter?.(actor)
      const ai =
        drafter === undefined
          ? undefined
          : await drafter({
              target,
              brand: options.brand(),
              ...(account === undefined ? {} : { account }),
              voice,
              facts,
              ...(rules === undefined ? {} : { rules }),
              ...(input.instruction === undefined ? {} : { instruction: input.instruction }),
            }).catch(() => undefined)
      const out = ai ?? templateRedditDraft(target, input.instruction)
      const scan = checkOutbound(`${out.title ?? ''}\n${out.text}`)
      options.emit('reddit.write_drafted', actor.person_id, {
        kind: target.kind,
        source: ai === undefined ? 'template' : 'ai',
        facts: facts.length,
        flagged: !scan.ok,
      })
      return {
        text: out.text,
        ...(out.title === undefined ? {} : { title: out.title }),
        source: ai === undefined ? 'template' : 'ai',
        facts,
        ...(rules === undefined || rules.length === 0 ? {} : { rules }),
        ...(scan.ok ? {} : { warning: replyBlockedReason(scan) }),
        ...(ai === undefined ? { note: '这次没用 AI：先给一句开头，你接着写。' } : {}),
      }
    },

    async stage(actor, input) {
      const text = input.text.trim()
      const title = input.title?.trim()
      const target = input.target
      const shape = writeOfTarget(target, title)
      if ('why' in shape) return { staged: false, message: shape.why }
      try {
        redditWritePlan({ write: shape, text }, options.origin)
      } catch (err) {
        return { staged: false, message: err instanceof Error ? err.message : String(err) }
      }
      const scan = checkOutbound(`${title ?? ''}\n${text}`)
      if (!scan.ok) return { staged: false, message: replyBlockedReason(scan) }
      const facts = (input.fact_ids ?? []).map((id) => factCache.get(id) ?? { id, text: '' })
      // 卡上「版规 N 条」（原文进问号）：与起草时同一个来源（插件只读读回的那一份）
      const rules = await options.rules?.(subOf(target.subreddit)).catch(() => undefined)
      const ref: ObjectRef = {
        type: actor.role_id.startsWith('pr.') ? 'external_post' : 'community_thread',
        id: `reddit:${target.parent_fullname ?? `r/${subOf(target.subreddit)}`}`,
      }
      const payload: RedditWritePayload & { to: ObjectRef } = {
        form: REDDIT_WRITE_FORM,
        channel: 'reddit',
        channel_label: `Reddit · r/${subOf(target.subreddit)}`,
        reddit: target,
        to: ref,
        body: { text, ...(title === undefined ? {} : { subject: title }) },
        ...(target.parent_author === undefined ? {} : { author: target.parent_author }),
        ...((target.parent_text ?? target.post_title) === undefined
          ? {}
          : { in_reply_to: (target.parent_text ?? target.post_title ?? '').slice(0, 300) }),
        ...(facts.length === 0 ? {} : { facts }),
        ...(rules === undefined || rules.length === 0 ? {} : { rules }),
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      }
      const item = await options.approvals.create({
        workspace_id: ws,
        schema_version: 1,
        kind: 'outbound_draft',
        role_id: actor.role_id,
        subject: { object: ref },
        dedupe_key: `${ws}:reddit_write:${ref.id}:${nextId('d')}`,
        title: titleOf(target, title),
        summary: (title ?? text).slice(0, 120),
        payload,
        evidence: {
          source_events: [],
          run_id: `run_reddit_${nextId('r')}`,
          provenance: { seen: [ref] },
          precheck: {},
        },
        proposer: { kind: 'person', id: actor.person_id, assignment_id: actor.assignment_id },
        // 决策 663：Reddit 的发帖 / 评论 / 回复永远逐条人批，不看职责等级
        automation: {
          level_at_creation: 'L1',
          auto_approved: false,
          mandate_check: { within: true, caps_hit: [] },
          sampling: { selected: false },
        },
        // 决策 669：审批人只有本人（个人模式下就是点起草的这个人）
        routing: {
          recipients: [{ person: actor.person_id, via: 'role_holder' }],
          rule: 'role_holder',
          escalation: { after_hours: 24, business_hours: true, chain: [], escalated_at: [] },
          separation_of_duties: false,
        },
        priority: 'queue',
        context: {
          thread_participants: [ref.id],
          gates: [
            {
              gate: 'commitment_scan' as const,
              status: 'pass' as const,
              ruleset_hash: 'support-core/commitment',
              evidence: { hits: 0 },
            },
          ],
        },
      })
      if (item.state === 'blocked')
        return {
          staged: false,
          message: `没出卡：前置检查没过（${Object.entries(item.evidence.precheck)
            .filter(([, v]) => v !== 'ok')
            .map(([k]) => k)
            .join('、')}）`,
        }
      options.emit('reddit.write_staged', actor.person_id, {
        approval_item_id: item.id,
        kind: target.kind,
        ...(target.source === undefined ? {} : { source: target.source.type }),
      })
      if (target.source !== undefined) options.onStaged?.(target.source, item.id)
      return { staged: true, approval_item_id: item.id }
    },

    async draftAndStage(actor, input) {
      if (input.target.kind === 'submit')
        return { staged: false, message: '发新帖要你给一句要点，不自动起草。' }
      let draft: RedditDraftView
      try {
        draft = await service.draft(actor, { target: input.target })
      } catch (err) {
        return { staged: false, message: err instanceof Error ? err.message : String(err) }
      }
      if (draft.text.trim() === '') return { staged: false, message: '起草出来是空的，没出卡。' }
      return service.stage(actor, {
        target: input.target,
        text: draft.text,
        ...(draft.facts.length === 0 ? {} : { fact_ids: draft.facts.map((f) => f.id) }),
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      })
    },

    async deliver(item) {
      if (item.workspace_id !== ws || item.kind !== 'outbound_draft') return undefined
      const fp = finalPayload(item)
      const p = isRecord(fp) ? fp : isRecord(item.payload) ? item.payload : {}
      if (p.form !== REDDIT_WRITE_FORM) return undefined
      const target = (isRecord(p.reddit) ? p.reddit : {}) as unknown as RedditWriteTarget
      const body = isRecord(p.body) ? p.body : {}
      const text = str(body.text)
      const title = str(body.subject)
      if (text === undefined) return failed('卡上没有正文，没发。')
      const write = writeOfTarget(target, title)
      if ('why' in write) return failed(write.why)
      const by = item.decision?.by
      const approved_by =
        by === undefined
          ? undefined
          : by === 'mandate'
            ? '自动'
            : ((await options.approverName?.(by).catch(() => undefined)) ?? by)
      const facts = Array.isArray(p.facts) ? p.facts.filter(isRecord) : []
      const record: OutboundRecordInput = {
        source_key: `approval:${item.id}`,
        channel: 'reddit',
        action: ACTION_OF[write.kind],
        kind: REDDIT_WRITE_FORM,
        destination: `r/${subOf(target.subreddit)}`,
        ...(target.post_title === undefined ? {} : { thread_title: target.post_title }),
        ...(target.permalink === undefined ? {} : { thread_url: redditLink(target.permalink) }),
        ...(target.parent_author === undefined ? {} : { counterpart: target.parent_author }),
        ...(target.parent_text === undefined
          ? {}
          : { counterpart_text: target.parent_text.slice(0, 1000) }),
        ...(title === undefined ? {} : { subject: title }),
        content: text,
        ...(target.parent_fullname === undefined
          ? {}
          : { parent_external_id: target.parent_fullname }),
        ...(facts.length === 0
          ? {}
          : { reason: { faq: facts.map((f) => String(f.id)).filter((s) => s !== '') } }),
        approval_item_id: item.id,
        ...(item.subject.matter_id === undefined ? {} : { matter_id: item.subject.matter_id }),
        role_id: item.role_id,
        ...(approved_by === undefined ? {} : { approved_by }),
        ...(item.decision?.at === undefined ? {} : { approved_at: item.decision.at }),
      } as OutboundRecordInput
      return send({
        approval_item_id: item.id,
        write,
        text,
        ...(title === undefined ? {} : { title }),
        subreddit: target.subreddit,
        record,
        ...(target.source === undefined ? {} : { source: target.source }),
        label: item.title,
      })
    },

    onActionEvent(event) {
      if (event.job.plan.platform !== 'reddit') return
      const entry = entries.find((e) => e.job_id === event.job.id)
      if (entry === undefined || entry.state === 'sent' || entry.state === 'failed') return
      if (event.type === 'expired') {
        markFailed(
          entry,
          '24 小时没有插件来领：Chrome 没开，或插件没连 Reddit。这一条没发。',
          'expired',
        )
        return
      }
      if (event.type !== 'finished') return
      const result = event.result
      if (result?.outcome === 'done') {
        markSent(entry, result.reads.fullname, result.reads.permalink)
        return
      }
      markFailed(
        entry,
        result?.message ?? event.view.result?.message ?? '插件没回结局。',
        result?.outcome ?? event.view.status,
      )
    },

    async refill(job_id) {
      const entry = entries.find((e) => e.job_id === job_id)
      if (entry === undefined) return { ok: false, message: '找不到这一条。' }
      if (entry.state !== 'failed')
        return {
          ok: false,
          message:
            entry.state === 'sent' ? '这一条已经发出去了。' : '这一条还在插件那边，等它做完。',
        }
      if (!canRefill(entry) || entry.write === undefined || entry.text === undefined)
        return { ok: false, message: '这一条没记下草稿，不能再填；从卡片流里重新起草一张。' }
      const queued = await toPlugin({
        write: entry.write,
        text: entry.text,
        approval_item_id: entry.approval_item_id,
        ...(entry.label === undefined ? {} : { label: entry.label }),
      })
      if (!queued.ok) return { ok: false, message: queued.why }
      entry.previous_jobs = [...(entry.previous_jobs ?? []), entry.job_id]
      entry.job_id = queued.job.id
      entry.state = 'queued'
      entry.queued_at = now()
      entry.refills = (entry.refills ?? 0) + 1
      delete entry.finished_at
      delete entry.outcome
      delete entry.dismissed
      if (extensionReady()) delete entry.message
      else entry.message = PLUGIN_OFFLINE
      save()
      options.emit('reddit.write_refilled', 'system', {
        approval_item_id: entry.approval_item_id,
        job_id: entry.job_id,
        kind: entry.kind,
        refills: entry.refills,
      })
      const view = service.writes().find((w) => w.job_id === entry.job_id)
      return view === undefined ? { ok: false, message: '找不到这一条。' } : { ok: true, view }
    },

    dismiss(job_id) {
      const entry = entries.find((e) => e.job_id === job_id)
      if (entry === undefined) return undefined
      if (entry.state === 'failed' && entry.dismissed !== true) {
        entry.dismissed = true
        save()
      }
      return service.writes().find((w) => w.job_id === job_id)
    },

    writes() {
      const running = new Map((options.actions?.jobs() ?? []).map((j) => [j.id, j.status] as const))
      return [...entries].reverse().map((e): RedditWriteView => {
        const st = running.get(e.job_id)
        const state =
          e.state === 'queued' && (st === 'running' || st === 'waiting_confirm')
            ? 'filling'
            : e.state
        return {
          approval_item_id: e.approval_item_id,
          job_id: e.job_id,
          kind: e.kind,
          subreddit: e.subreddit,
          state,
          ...(e.message === undefined ? {} : { message: e.message }),
          ...(e.outcome === undefined || e.state !== 'failed' ? {} : { outcome: e.outcome }),
          ...(e.label === undefined ? {} : { label: e.label }),
          ...(e.state === 'failed' && canRefill(e) ? { can_refill: true } : {}),
          ...(e.refills === undefined || e.refills === 0 ? {} : { refills: e.refills }),
          ...(e.dismissed === true ? { dismissed: true } : {}),
          ...(e.link === undefined ? {} : { link: e.link }),
          ...(e.record_id === undefined ? {} : { record_id: e.record_id }),
          queued_at: e.queued_at,
          ...(e.finished_at === undefined ? {} : { finished_at: e.finished_at }),
        }
      })
    },
  }
  return service
}
