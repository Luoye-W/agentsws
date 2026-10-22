/**
 * WP329（docs/102 §2.3 / §4 / §5.1，决策 663 / 667 / 669 / 708）：**Reddit 写**，每品牌一份。
 *
 * 一条路：起草（{@link RedditWriteService.draft}：FAQ + 品牌话术 + 帖子上下文 + 版规原文）
 * → 出一张「发出去」卡（{@link RedditWriteService.stage}：`outbound_draft` + `form: 'reddit_write'`，**永远 L1**）
 * → 人批（卡上能改字；个人模式审批人就是本人：669）
 * → 执行器施行（{@link RedditWriteService.deliver}）：排进插件动作通道（WP313）→ 插件在用户已登录的 Reddit 页面里
 *    把草稿填进框 → **人自己点发送** → 插件认出新出现的那一条、读回编号与链接（{@link RedditWriteService.onActionEvent}）。
 *    插件不在线就等着（「等你发」7 天没打开才作废），卡上照实说。
 * → 读回确认才算发出去：本地发出记录多一行（WP323，带编号与链接，之后对方的回复按编号挂回这一行）；
 *    没确认到（没点 / 被拦 / 没登录 / 停了 / 作废）就照实说原因，**不自动重试**。
 *
 * WP432（Luoye 10-20 反馈 9）：**批了不自动开页面**——交给插件的活进队就是「等你在插件里打开」（`awaiting`），
 * 插件的定时领活领不到；人在插件侧边栏里点「打开这一条」（{@link RedditWriteService.open}，可以先改字）才交出去，
 * 插件在当前窗口新开标签页填好、人自己点发送。「不发了」（{@link RedditWriteService.drop}）也在侧边栏里。
 * 默认在新版 www.reddit.com 上填，设置里选了旧版才走 old.reddit。读回的真发出去的字与批的那一版不一样（人改过）
 * 就记进发出记录（`draft_content` / `content`），差进学习回路（`onEdited`）。
 *
 * WP445（决策 1322–1324，Luoye 10-21）：**审与发都在插件里一步完成**——AI 起草的这一条不在工坊出卡，
 * 卡直接落进插件侧边栏「等你发」（`payload.desk = 'plugin'`）：人在侧边栏里看、改、点「打开这一条」（= 批 + 打开）
 * 或「不发 + 理由」。公司模式里职责设了「要主管先批」的例外（{@link RedditWriteServiceOptions.reviewer}）：
 * 主管在工坊批，批完进发起人的插件「等你发」。一律新版 www.reddit.com（旧版选择器只作页面兜底）；
 * 决策 761 留下的「程序直发」那条路删了：**Reddit 的写只有插件 + 人点这一条路**。
 *
 * 交给插件那一刻，卡的施行结果记 `ok`（`outcome_ref.type = 'reddit_fill'`，与「人自己发」的 `manual_send`
 * 同一个意思：系统这一侧做完了，剩下那一下是人点）；真发没发出去看 {@link RedditWriteService.writes}。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SocialActor } from '@agentsws/api'
import {
  type ActionJob,
  buildRedditJob,
  postedKey,
  REDDIT_WRITE_ORIGIN_NEW,
  RedditPlanError,
  type RedditWrite,
  redditWritePlan,
  SOFT_MISS_LABEL,
} from '@agentsws/browser-action'
import type {
  ApprovalBus,
  ApprovalItem,
  Clock,
  ObjectRef,
  OutboundRecord,
  OutboundRecordInput,
  Recipient,
  RedditDraftCheck,
  RedditDraftConflict,
  RedditDraftFact,
  RedditDraftInput,
  RedditDraftView,
  RedditPersona,
  RedditStageInput,
  RedditStageResult,
  RedditThreadContext,
  RedditWritePayload,
  RedditWriteSource,
  RedditWriteTarget,
  RedditWriteView,
  WorkspaceId,
} from '@agentsws/contracts'
import { REDDIT_WRITE_FORM } from '@agentsws/contracts'
import {
  checkOutbound,
  redditPlainText,
  redditPlainTitle,
  resolveVoice,
  stripUngrounded,
  voicePrompt,
} from '@agentsws/social-core'
import { finalPayload } from '@agentsws/txn'
import type { AdsActionEvent, AdsActionsService } from '../ads-actions/service.js'
import { replyBlockedReason } from '../social-reply-draft.js'
import {
  conflictNote,
  factQuery,
  fixNotes,
  type RedditDrafter,
  reviewRedditDraft,
  templateRedditDraft,
} from './draft.js'
import type { RedditLimitKey, RedditLimits } from './limits.js'

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

/** 一条批过的写（本地进度）。 */
export interface RedditWriteEntry extends RedditWriteView {
  /** 老进度里可能还有 `direct`（WP445 删了那条路，只读不新写）。 */
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
  /** WP432：批的那一版（批了之后人在侧边栏里改过字才记；`text` 是改过的）。 */
  draft_text?: string
}

export interface RedditWriteServiceOptions {
  workspace_id: WorkspaceId
  clock: Clock
  /** WP338（决策 783）：每天 / 每周几条由用户自己设（默认不限）；到了就不出卡、照实说。 */
  limits?: Pick<RedditLimits, 'check' | 'note'>
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
  /**
   * WP411（#11）：品牌号怎么说话（个人 / 团队口吻）。给了这个口子而还没配 → 自动起草不出卡（`needs_persona`），
   * 先出设置卡；不给 = 老行为（不问人设）。
   */
  persona?(): RedditPersona | undefined
  /** 这个版的版规原文（读不到 = undefined；读不到就不放进提示词，不替用户判能不能推广）。 */
  rules?(subreddit: string): Promise<string[] | undefined>
  /** 插件动作通道（每品牌一份；托管实例没有）。WP432：`open` / `stop` 是侧边栏「打开这一条 / 不发了」。 */
  actions?: Pick<AdsActionsService, 'enqueue' | 'lastSeen' | 'jobs'> &
    Partial<Pick<AdsActionsService, 'open' | 'stop'>>
  /**
   * WP445（决策 1322）：这一条要不要先给主管批——公司模式里这条职责的这个动作设了「主管定 / 老板定」、
   * 落到的不是发起人自己时回那个人（卡在工坊里给他批）；不用（个人 / 同事互联 / 落回本人）回 `undefined`：
   * 卡直接进发起人的插件「等你发」，工坊不出卡。不给 = 一律进插件。
   */
  reviewer?(actor: SocialActor, kind: RedditWrite['kind']): Promise<Recipient | undefined>
  /** WP445：这本账上还没定、在插件里等你发的卡（看板上「插件里 N 条等你发」）。 */
  deskCards?(): readonly ApprovalItem[]
  /** WP445：主管批过、等你在插件里打开的那一条，人在插件里点了「不发 + 理由」（进学习回路）。 */
  onDropped?(input: { approval_item_id: string; reason?: string; at: string }): void
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
  /** 测试指向本地假页面（不给 = 新版 www.reddit.com）。 */
  origin?: string
  /**
   * WP432：批了之后人又改了字（侧边栏里改、或在 Reddit 页面上改了再发）——批的那一版与真发出去的那一版，
   * 进学习回路（与卡上「改了再批」同一条路）。
   */
  onEdited?(input: { approval_item_id: string; before: string; after: string; at: string }): void
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
    input: {
      target: RedditWriteTarget
      reason?: string
      /** WP411：整串上下文（品牌号已经回过这一条就不起草；起草照这一串的口径）。 */
      thread?: RedditThreadContext
    },
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
  /**
   * WP432：人在插件侧边栏里点「打开这一条」（改过就带改过的字）——只有这一下能把等你发的那一件交给插件；
   * 回交出去的那一件活（插件在当前窗口新开标签页填好、等人点发送）。
   */
  open(
    job_id: string,
    edit?: { text?: string; title?: string },
  ): Promise<{ ok: true; job: ActionJob; view: RedditWriteView } | { ok: false; message: string }>
  /** WP432：侧边栏里点「不发了」（批过的这一条不发；不再提醒）。 */
  drop(
    job_id: string,
    reason?: string,
  ): { ok: true; view: RedditWriteView } | { ok: false; message: string }
  writes(): RedditWriteView[]
  /** WP445：插件里等你发的几条（还没打开的卡 + 批过、等你打开的；同一张卡算一条）。 */
  inPlugin(): number
  /** 插件最近一周来过、连着 Reddit。 */
  extensionReady(): boolean
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

/**
 * 落盘那一份。WP445 起不再写 `direct_fallback`（决策 1324 删了程序直发）与 `site`（决策 1323 一律新版）；
 * 老文件里有也只是忽略。
 */
interface StateFile {
  version: 1
  entries: RedditWriteEntry[]
  seq: number
}

/** WP432：两段字去掉 Markdown 记号与空白后一样吗（页面上读回来的是渲染后的字）。 */
export function sameSentText(a: string, b: string): boolean {
  const plain = (s: string): string =>
    postedKey(s.replace(/!?\[([^\]]*)\]\([^)]*\)/gu, '$1').replace(/[*_~`>#|]/gu, ' '))
  return plain(a) === plain(b)
}

/** WP432：等你在插件里发的那一句（插件最近没来过时）。 */
export const OPEN_IN_PLUGIN_OFFLINE = '插件不在线：打开 Chrome，在插件侧边栏里点开这一条。'

/** WP432：认不出框、等人自己粘贴时，进度里那一句。 */
export const PASTE_YOURSELF = '页面对不上：在插件侧边栏里点「复制草稿」，自己粘贴、点发送'

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
    writeFileSync(tmp, JSON.stringify({ version: 1, entries, seq } satisfies StateFile))
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

  /**
   * 发出去了：记一行发出记录（带编号与链接）。WP432：`sent_text` = 页面上读回的真发出去的字——
   * 和批的那一版不一样（人改过）就按真发的记，批的那一版记进 `draft_content`，差进学习回路。
   */
  const markSent = (
    entry: RedditWriteEntry,
    fullname?: string,
    path?: string,
    readback: { sent_text?: string; pasted?: boolean } = {},
  ): void => {
    const link = redditLink(path)
    entry.state = 'sent'
    entry.finished_at = now()
    if (fullname !== undefined && fullname !== '') entry.fullname = fullname
    if (link !== undefined) entry.link = link
    delete entry.message
    if (readback.pasted === true) entry.pasted = true
    const approved = entry.text ?? entry.record.content
    const draft = entry.draft_text ?? approved
    const sent = readback.sent_text?.trim()
    if (sent !== undefined && sent !== '' && entry.write?.kind !== 'submit') {
      entry.sent_text = sent
      if (!sameSentText(sent, approved)) entry.edited = true
    }
    const finalText =
      entry.sent_text !== undefined && !sameSentText(entry.sent_text, approved)
        ? entry.sent_text
        : approved
    const changed = !sameSentText(finalText, draft)
    if (changed) {
      try {
        options.onEdited?.({
          approval_item_id: entry.approval_item_id,
          before: draft,
          after: finalText,
          at: entry.finished_at,
        })
      } catch {
        // 学不到不挡「发出去了」
      }
    }
    try {
      const row = options.record({
        ...entry.record,
        content: finalText,
        ...(changed ? { draft_content: draft } : {}),
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
    const account = options.account?.()
    const job = buildRedditJob({
      id: nextId('rdw'),
      workspace_id: ws,
      account_id: account ?? `ws:${ws}`,
      action: { write: input.write, text: input.text },
      approval_id: input.approval_item_id,
      approval_level: 'L1',
      ...(input.label === undefined ? {} : { title: input.label }),
      created_at: now(),
      origin: options.origin ?? REDDIT_WRITE_ORIGIN_NEW,
      ...(account === undefined ? {} : { author: account }),
    })
    // WP432：等你在插件里点开（插件的定时领活领不到它）
    const queued = await actions.enqueue(job, undefined, { hold: true })
    return queued.ok ? { ok: true, job } : queued
  }

  /** WP432：等你在插件里发了（插件图标上的数字、通知「等你发」都从这一条来）。 */
  const awaiting = (entry: RedditWriteEntry): void => {
    options.emit('reddit.write_awaiting', 'system', {
      approval_item_id: entry.approval_item_id,
      job_id: entry.job_id,
      kind: entry.kind,
      subreddit: entry.subreddit,
      ...(entry.label === undefined ? {} : { label: entry.label }),
    })
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
    // 决策 1324：Reddit 的写只有插件 + 人点发送这一条路（程序直发删了）
    const queued = await toPlugin(input)
    if (!queued.ok) return failed(queued.why)
    const job = queued.job
    const entry: RedditWriteEntry = {
      ...base,
      job_id: job.id,
      // WP432：批了 = 等你在插件里打开（不自己开页面）
      state: 'awaiting',
      via: 'extension',
      ...(extensionReady() ? {} : { message: OPEN_IN_PLUGIN_OFFLINE }),
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
    awaiting(entry)
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
      const persona = options.persona?.()
      const thread = input.thread
      const ask = (fix?: string[]) =>
        drafter === undefined
          ? Promise.resolve(undefined)
          : drafter({
              target,
              brand: options.brand(),
              ...(account === undefined ? {} : { account }),
              voice,
              facts,
              ...(rules === undefined ? {} : { rules }),
              ...(input.instruction === undefined ? {} : { instruction: input.instruction }),
              ...(thread === undefined ? {} : { thread }),
              ...(persona === undefined ? {} : { persona }),
              ...(fix === undefined ? {} : { fix }),
            }).catch(() => undefined)
      let ai = await ask()
      // WP411（#11）：几道检查（矛盾 / 没依据 / 口吻）；没过就照着问题重写一次
      const review = (text: string): RedditDraftCheck[] =>
        reviewRedditDraft(text, {
          facts,
          ...(thread === undefined ? {} : { thread }),
          ...(persona === undefined ? {} : { persona }),
        })
      let checks = ai === undefined ? [] : review(ai.text)
      if (ai !== undefined && checks.length > 0) {
        const again = await ask(fixNotes(checks))
        if (again !== undefined && again.text.trim() !== '') {
          ai = again
          checks = review(again.text)
        }
      }
      const out = ai ?? templateRedditDraft(target, input.instruction)
      // 还没依据的那几句：换成「我去确认一下」（宁可不说也不猜）
      const bad = checks.filter((c) => c.kind === 'ungrounded').map((c) => c.quote ?? '')
      const text = stripUngrounded(out.text, bad)
      checks = checks.map((c) => (c.kind === 'ungrounded' ? { ...c, fixed: true } : c))
      if (thread?.read === 'store')
        checks.push({ kind: 'thread', message: thread.note ?? '这一串没现读成，只看了库里有的。' })
      if (options.persona !== undefined && persona === undefined)
        checks.push({ kind: 'persona', message: '品牌号的口吻还没定，这一份按中性口吻写的。' })
      const scan = checkOutbound(`${out.title ?? ''}\n${text}`)
      options.emit('reddit.write_drafted', actor.person_id, {
        kind: target.kind,
        source: ai === undefined ? 'template' : 'ai',
        facts: facts.length,
        flagged: !scan.ok,
        checks: checks.map((c) => c.kind),
      })
      const prior = thread?.ours ?? []
      return {
        text,
        ...(out.title === undefined ? {} : { title: out.title }),
        source: ai === undefined ? 'template' : 'ai',
        facts,
        ...(rules === undefined || rules.length === 0 ? {} : { rules }),
        ...(scan.ok ? {} : { warning: replyBlockedReason(scan) }),
        ...(ai === undefined ? { note: '这次没用 AI：先给一句开头，你接着写。' } : {}),
        ...(checks.length === 0 ? {} : { checks }),
        ...(prior.length === 0 ? {} : { prior_replies: prior.slice(-5) }),
      }
    },

    async stage(actor, input) {
      // WP468（决策 1510）：出卡前兜一道——残留的 Markdown 记号转纯文字（新版评论框是富文本）
      const text = redditPlainText(input.text)
      const title = input.title === undefined ? undefined : redditPlainTitle(input.title)
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
      // WP338（决策 783）：用户设了上限才数；没设 = 不限
      const limitKey: RedditLimitKey = actor.role_id.startsWith('pr.')
        ? shape.kind === 'submit'
          ? 'pr_posts'
          : 'pr_replies'
        : shape.kind === 'submit'
          ? 'social_broadcasts'
          : 'social_replies'
      const overLimit = options.limits?.check(limitKey)
      if (overLimit !== undefined) return { staged: false, message: overLimit }
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
        ...(input.checks === undefined || input.checks.length === 0
          ? {}
          : { checks: input.checks }),
        ...(input.prior_replies === undefined || input.prior_replies.length === 0
          ? {}
          : { prior_replies: input.prior_replies }),
      }
      // WP445（决策 1322）：要不要主管先批（公司模式里职责设了「主管定」）；不用就直接进插件「等你发」
      const asked = await options.reviewer?.(actor, shape.kind).catch(() => undefined)
      const reviewer = asked !== undefined && asked.person !== actor.person_id ? asked : undefined
      const supervised = reviewer !== undefined
      payload.desk = supervised ? 'workshop' : 'plugin'
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
        // 决策 669：审批人只有本人（个人模式下就是点起草的这个人）——在插件里审；
        // WP445：公司模式里职责设了「主管先批」的，落到主管（在工坊里批）
        routing: {
          recipients:
            reviewer === undefined ? [{ person: actor.person_id, via: 'role_holder' }] : [reviewer],
          rule:
            reviewer === undefined
              ? 'role_holder'
              : reviewer.via === 'owner'
                ? 'owner'
                : 'scope_manager',
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
        desk: payload.desk,
        ...(target.source === undefined ? {} : { source: target.source.type }),
      })
      // WP445：进了插件「等你发」——插件图标数字、系统通知、铃铛「等你发」都从这一条来（工坊不出卡）
      if (!supervised)
        options.emit('reddit.write_awaiting', 'system', {
          approval_item_id: item.id,
          kind: target.kind,
          subreddit: subOf(target.subreddit),
          label: item.title,
          desk: 'plugin',
        })
      if (target.source !== undefined) options.onStaged?.(target.source, item.id)
      options.limits?.note(limitKey)
      return { staged: true, approval_item_id: item.id }
    },

    async draftAndStage(actor, input) {
      if (input.target.kind === 'submit')
        return { staged: false, message: '发新帖要你给一句要点，不自动起草。' }
      // WP411（#11）：品牌号在这串里已经直接回过这一条 → 不再起草
      const parent = input.target.parent_fullname?.toLowerCase()
      const done =
        parent === undefined
          ? undefined
          : input.thread?.ours.find((c) => (c.parent_fullname ?? '').toLowerCase() === parent)
      if (done !== undefined)
        return {
          staged: false,
          skipped: 'already_replied',
          message: `品牌号${done.created_at === undefined ? '' : ` ${done.created_at.slice(5, 10)} `}已经回过这一条：「${done.text.slice(0, 80)}」，不再起草。`,
        }
      // WP411：品牌号怎么说话还没定 → 先不起草（宿主出设置卡，定了再交回来）
      if (options.persona !== undefined && options.persona() === undefined)
        return {
          staged: false,
          skipped: 'needs_persona',
          message: '品牌号怎么说话还没定：先出一张设置卡，定了再起草。',
        }
      let draft: RedditDraftView
      try {
        draft = await service.draft(actor, {
          target: input.target,
          ...(input.thread === undefined ? {} : { thread: input.thread }),
        })
      } catch (err) {
        return { staged: false, message: err instanceof Error ? err.message : String(err) }
      }
      if (draft.text.trim() === '') return { staged: false, message: '起草出来是空的，没出卡。' }
      // 决策 1199（Luoye 10-19 改）：重写一次后仍和品牌号说过的矛盾 → 不出卡、也不标黄出卡，
      // 条目留在待处理里「和你 <日期> 说的矛盾，要你看」（附原话与日期），由人决定
      const clash = draft.checks?.find((c) => c.kind === 'contradiction')
      if (clash !== undefined) {
        const conflict: RedditDraftConflict = {
          quote: clash.quote ?? '',
          prior: clash.prior ?? '',
          ...(clash.prior_at === undefined ? {} : { prior_at: clash.prior_at }),
        }
        return {
          staged: false,
          skipped: 'contradiction',
          conflict,
          message: conflictNote(conflict),
        }
      }
      return service.stage(actor, {
        target: input.target,
        text: draft.text,
        ...(draft.facts.length === 0 ? {} : { fact_ids: draft.facts.map((f) => f.id) }),
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        ...(draft.checks === undefined ? {} : { checks: draft.checks }),
        ...(draft.prior_replies === undefined ? {} : { prior_replies: draft.prior_replies }),
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
          // WP432：等你在插件里打开的那一件 7 天没打开才作废（老的排队活仍是 24 小时）
          entry.state === 'awaiting'
            ? '等你在插件里打开，7 天没打开，这一条没发。'
            : '24 小时没有插件来领：Chrome 没开，或插件没连 Reddit。这一条没发。',
          'expired',
        )
        return
      }
      if (event.type !== 'finished') return
      const result = event.result
      if (result?.outcome === 'done') {
        markSent(entry, result.reads.fullname, result.reads.permalink, {
          ...(result.reads.sent_text === undefined ? {} : { sent_text: result.reads.sent_text }),
          ...(result.reads.fill_missed === '1' ? { pasted: true } : {}),
        })
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
      // WP432：再填一次也是「等你在插件里打开」
      entry.state = 'awaiting'
      entry.queued_at = now()
      entry.refills = (entry.refills ?? 0) + 1
      delete entry.finished_at
      delete entry.outcome
      delete entry.dismissed
      if (extensionReady()) delete entry.message
      else entry.message = OPEN_IN_PLUGIN_OFFLINE
      save()
      awaiting(entry)
      options.emit('reddit.write_refilled', 'system', {
        approval_item_id: entry.approval_item_id,
        job_id: entry.job_id,
        kind: entry.kind,
        refills: entry.refills,
      })
      const view = service.writes().find((w) => w.job_id === entry.job_id)
      return view === undefined ? { ok: false, message: '找不到这一条。' } : { ok: true, view }
    },

    async open(job_id, edit) {
      const entry = entries.find((e) => e.job_id === job_id)
      if (entry === undefined) return { ok: false, message: '找不到这一条。' }
      if (entry.state !== 'awaiting' && entry.state !== 'queued')
        return {
          ok: false,
          message:
            entry.state === 'sent'
              ? '这一条已经发出去了。'
              : entry.state === 'filling'
                ? '这一条已经打开了，在那个标签页里。'
                : '这一条没发出去：点「再填一次」重新交给插件。',
        }
      const actions = options.actions
      if (actions?.open === undefined || entry.write === undefined || entry.text === undefined)
        return { ok: false, message: '这一条不能在插件里打开（没记下草稿）。' }
      // 侧边栏里改过字：按改过的重新拼一件（白名单只认这一段字），老的那件作废
      const text = edit?.text?.trim()
      const title = edit?.title?.trim()
      const changedText = text !== undefined && text !== '' && text !== entry.text
      const changedTitle =
        entry.write.kind === 'submit' &&
        title !== undefined &&
        title !== '' &&
        title !== entry.write.title
      if (changedText || changedTitle) {
        const write: RedditWrite =
          changedTitle && entry.write.kind === 'submit'
            ? { ...entry.write, title: title as string }
            : entry.write
        const nextText = changedText ? (text as string) : entry.text
        try {
          redditWritePlan({ write, text: nextText }, options.origin)
        } catch (err) {
          return { ok: false, message: err instanceof Error ? err.message : String(err) }
        }
        const scan = checkOutbound(`${write.kind === 'submit' ? write.title : ''}\n${nextText}`)
        if (!scan.ok) return { ok: false, message: replyBlockedReason(scan) }
        const queued = await toPlugin({
          write,
          text: nextText,
          approval_item_id: entry.approval_item_id,
          ...(entry.label === undefined ? {} : { label: entry.label }),
        })
        if (!queued.ok) return { ok: false, message: queued.why }
        actions.stop?.(entry.job_id)
        entry.previous_jobs = [...(entry.previous_jobs ?? []), entry.job_id]
        entry.job_id = queued.job.id
        entry.draft_text ??= entry.text
        entry.text = nextText
        entry.write = write
        if (write.kind === 'submit') {
          entry.title = write.title
          entry.record = { ...entry.record, subject: write.title }
        }
        entry.record = { ...entry.record, content: nextText }
        entry.edited = true
      }
      const got = actions.open(entry.job_id)
      if (!got.ok) {
        save()
        return { ok: false, message: got.why }
      }
      entry.state = 'queued'
      delete entry.message
      save()
      options.emit('reddit.write_opened', 'system', {
        approval_item_id: entry.approval_item_id,
        job_id: entry.job_id,
        kind: entry.kind,
        ...(entry.edited === true ? { edited: true } : {}),
      })
      const view = service.writes().find((w) => w.job_id === entry.job_id)
      return view === undefined
        ? { ok: false, message: '找不到这一条。' }
        : { ok: true, job: got.job, view }
    },

    drop(job_id, reason) {
      const entry = entries.find((e) => e.job_id === job_id)
      if (entry === undefined) return { ok: false, message: '找不到这一条。' }
      if (entry.state !== 'awaiting')
        return {
          ok: false,
          message:
            entry.state === 'sent'
              ? '这一条已经发出去了。'
              : '这一条已经打开了，在那个标签页里关掉就行。',
        }
      options.actions?.stop?.(entry.job_id)
      entry.dismissed = true
      markFailed(entry, reason?.trim() || '你在插件里点了不发。', 'dropped')
      // WP445：写了理由才进学习回路（同 WP414 的口径；没写只记这一次不发）
      const why = reason?.trim()
      if (why !== undefined && why !== '')
        try {
          options.onDropped?.({
            approval_item_id: entry.approval_item_id,
            reason: why,
            at: entry.finished_at ?? now(),
          })
        } catch {
          // 学不到不挡「不发」
        }
      options.emit('reddit.write_dropped', 'system', {
        approval_item_id: entry.approval_item_id,
        job_id: entry.job_id,
        kind: entry.kind,
      })
      const view = service.writes().find((w) => w.job_id === job_id)
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

    inPlugin() {
      const ids = new Set<string>()
      for (const item of options.deskCards?.() ?? []) ids.add(item.id)
      for (const e of entries) if (e.state === 'awaiting') ids.add(e.approval_item_id)
      return ids.size
    },

    writes() {
      const running = new Map((options.actions?.jobs() ?? []).map((j) => [j.id, j] as const))
      return [...entries].reverse().map((e): RedditWriteView => {
        const job = running.get(e.job_id)
        const st = job?.status
        const state =
          e.state === 'queued' && (st === 'running' || st === 'waiting_confirm')
            ? 'filling'
            : e.state
        // WP432：新版页面对不上、在等人自己粘贴——照实说
        const message =
          state === 'filling' && job?.progress?.label === SOFT_MISS_LABEL
            ? PASTE_YOURSELF
            : e.message
        return {
          approval_item_id: e.approval_item_id,
          job_id: e.job_id,
          kind: e.kind,
          subreddit: e.subreddit,
          state,
          ...(message === undefined ? {} : { message }),
          ...(e.outcome === undefined || e.state !== 'failed' ? {} : { outcome: e.outcome }),
          ...(e.label === undefined ? {} : { label: e.label }),
          ...(e.state === 'failed' && canRefill(e) ? { can_refill: true } : {}),
          ...(e.refills === undefined || e.refills === 0 ? {} : { refills: e.refills }),
          ...(e.dismissed === true ? { dismissed: true } : {}),
          ...(e.link === undefined ? {} : { link: e.link }),
          ...(e.record_id === undefined ? {} : { record_id: e.record_id }),
          ...(e.text === undefined ? {} : { text: e.text }),
          ...(e.write?.kind === 'submit' ? { title: e.write.title } : {}),
          ...(e.sent_text === undefined ? {} : { sent_text: e.sent_text }),
          ...(e.edited === true ? { edited: true } : {}),
          ...(e.pasted === true ? { pasted: true } : {}),
          queued_at: e.queued_at,
          ...(e.finished_at === undefined ? {} : { finished_at: e.finished_at }),
        }
      })
    },
  }
  return service
}
