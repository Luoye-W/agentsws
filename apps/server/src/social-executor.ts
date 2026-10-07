/**
 * WP254（决策 117）：**社媒库两类卡批了之后的执行器**——WP73 起这两类卡批了什么都不发生：
 *
 * | 卡 | 批了之后 |
 * |---|---|
 * | 别的社群（非 Reddit 自家版）的版务卡 `community_moderation`（删帖 / 禁言 / 封禁 / 解封…） | 经这条渠道适配器的 `moderate` 真去做 |
 * | 回帖卡 `outbound_draft` + `payload.form = 'social_reply'` | 经这条渠道的出口 `reply` 发出去（Reddit：WP249 的「接口优先、官方号浏览器兜底」） |
 *
 * 自家版那一类仍归 `own-sub-queue.ts`（WP249），这里一张都不碰（`after.source === 'own_sub_queue'` 跳过）。
 *
 * 四条纪律（与 WP249 同一套）：
 *
 * 1. **批了才执行，只执行卡上那一个**：读的是卡上的结构化字段（动作、目标 id、正文），不现编。
 *    批准那一刻排一个「取消窗口过了再施行」，定时发布那一轮再补扫一遍。
 * 2. **结果记账**：版务卡的结果由执行器写进变更账本（applied / failed + 原话）；回帖卡是出站，结果记在
 *    这张卡的施行记录上（同客服回信），两类都另记一条社媒事件（只有 id 与动作名，不含正文）。
 * 3. **失败照实报、不重试**（`retryable: false`）：一条可能已经发出去的回复重发一次，关注的人会看到两条；
 *    一次删帖 / 封禁的半截状态也不该被自动再按一遍。人在卡片流里点「重试」才再来。
 * 4. **「提醒一句」（warn）没有平台动作**：只记在工作台里（这个人再犯时算累犯），卡上事先写明，不假装发了话。
 */
import type {
  ApprovalItem,
  ChangeKind,
  Clock,
  CommunityThread,
  SocialChannel,
  StagedChange,
  WorkspaceId,
} from '@agentsws/contracts'
import { socialChannelSpec } from '@agentsws/contracts'
import type { ModerateInput, SocialChannelAdapter } from '@agentsws/social-core'
import { finalPayload } from '@agentsws/txn'
import { OWN_SUB_SOURCE } from './own-sub-queue.js'
import type { SocialStore } from './social.js'

/** 回帖卡在 `payload.form` 上的记号（与模拟世界那张同一个）。 */
export const SOCIAL_REPLY_FORM = 'social_reply'

/** 执行器回给 txn 的那一份（与 `@agentsws/txn` 的 `BackendResult` 同形）。 */
export interface SocialExecResult {
  status: 'ok' | 'failed'
  execution_id?: string
  outcome_ref?: { type: string; id: string }
  error?: { message: string; retryable: boolean }
}

export interface SocialExecutorOptions {
  workspace_id: WorkspaceId
  store: SocialStore
  clock: Clock
  /** 这条渠道的出口（`social-channels.ts` 装好的那一套；Reddit 已是混合出口）。没装配 = undefined。 */
  adapter(channel: SocialChannel): SocialChannelAdapter | undefined
  emit(type: string, actor: string, payload: Record<string, unknown>): void
  ledger: {
    list(filter: { workspace_id: WorkspaceId; kind?: ChangeKind }): Promise<StagedChange[]>
  }
  /** 这本账上批了、还没施行的回帖卡（补扫用；不给就只靠批准那一刻排的那一次）。 */
  approvedItems?(): readonly ApprovalItem[]
  /** 施行一张卡（`txn.executor.applyApproval`）。取消窗口内会被拒，所以批准那一刻先排一个。 */
  applyApproval?(item_id: string): Promise<unknown>
  /** 取消窗口（毫秒；与 txn 策略同一个数，默认 120 秒）。 */
  cancelWindowMs?: number
}

export interface SocialExecutor {
  /** 执行器调（`backendApply`）：是别的社群的版务卡就执行并回结果，不是回 undefined。 */
  applyModeration(change: StagedChange): Promise<SocialExecResult | undefined>
  /** 执行器调（`deliverOutbound`）：是回帖卡就经渠道出口发出去，不是回 undefined。 */
  deliverReply(item: ApprovalItem): Promise<SocialExecResult | undefined>
  /** 审批决定之后（批准 → 过了取消窗口施行）。 */
  onDecided(item: ApprovalItem): Promise<void>
  /** 补扫：批了、过了取消窗口、还没施行的那几张（定时发布那一轮顺手调）。回施行了几张。 */
  sweep(): Promise<number>
  close(): void
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

/** 别的社群的版务卡（自家版那一类归 WP249）。 */
export function isOtherModeration(kind: string | undefined, after: unknown): boolean {
  return kind === 'community_moderation' && !(isRecord(after) && after.source === OWN_SUB_SOURCE)
}

/** 这张审批项是不是回帖卡。 */
export function isSocialReplyItem(item: Pick<ApprovalItem, 'kind' | 'payload'>): boolean {
  return (
    item.kind === 'outbound_draft' &&
    isRecord(item.payload) &&
    item.payload.form === SOCIAL_REPLY_FORM
  )
}

/** 这张审批项归不归这个执行器（`server.ts` 的决定钩子用）。 */
export function isSocialExecutableApproval(item: ApprovalItem): boolean {
  if (isSocialReplyItem(item)) return true
  if (item.kind !== 'staged_change' || !isRecord(item.payload)) return false
  return isOtherModeration(str(item.payload.kind), item.payload.after)
}

/** `ModerateInput.action` 收得下的那几个（`warn` / `none` 没有平台动作）。 */
const PLATFORM_ACTIONS = new Set<ModerateInput['action']>([
  'delete_post',
  'mute',
  'unmute',
  'ban',
  'permanent_ban',
  'unban',
  'approve',
])

/** 版务动作做成之后，库里那个人 / 那条线程该是什么样。 */
const MEMBER_STATUS: Partial<Record<string, 'active' | 'muted' | 'banned'>> = {
  mute: 'muted',
  unmute: 'active',
  ban: 'banned',
  permanent_ban: 'banned',
  unban: 'active',
}

const APPROVED = new Set(['approved', 'approved_edited'])

export function createSocialExecutor(options: SocialExecutorOptions): SocialExecutor {
  const { workspace_id, store } = options
  const windowMs = options.cancelWindowMs ?? 120_000
  const timers = new Set<NodeJS.Timeout>()
  const label = (channel: string): string => socialChannelSpec(channel)?.zh ?? channel

  const failed = (message: string): SocialExecResult => ({
    status: 'failed',
    error: { message, retryable: false },
  })

  const applyModeration = async (change: StagedChange): Promise<SocialExecResult | undefined> => {
    if (change.workspace_id !== workspace_id) return undefined
    if (!isOtherModeration(change.kind, change.after)) return undefined
    const after = isRecord(change.after) ? change.after : {}
    const action = str(after.action) ?? ''
    const channel = str(after.channel) ?? ''
    const fail = (message: string): SocialExecResult => {
      options.emit('social.moderation_failed', 'system', {
        change_id: change.id,
        channel,
        action,
      })
      return failed(message)
    }
    const account = store.account(str(after.account_id) ?? '')
    if (account === undefined) return fail('这个号 / 群已经不在社媒库里了，没执行。')
    const target = str(after.target_external_id)
    // 纪律 4：「提醒一句」没有平台动作，只记在工作台里
    if (action === 'warn') {
      options.emit('social.moderation_applied', 'system', {
        change_id: change.id,
        channel,
        action,
        local_only: true,
      })
      return { status: 'ok', execution_id: `social_mod_${change.id}` }
    }
    if (!PLATFORM_ACTIONS.has(action as ModerateInput['action']) || target === undefined)
      return fail(`卡上的动作（${action || '空'}）这里执行不了，没执行。`)
    const adapter = options.adapter(account.channel)
    if (adapter?.moderate === undefined)
      return fail(`${label(account.channel)} 还没有能执行版务动作的出口，这一条没执行。`)
    const res = await adapter.moderate({
      account_external_id: account.external_id,
      target_external_id: target,
      action: action as ModerateInput['action'],
      ...(typeof after.duration_minutes === 'number'
        ? { duration_minutes: after.duration_minutes }
        : {}),
      ...(str(after.reason) === undefined ? {} : { reason: str(after.reason) as string }),
    })
    if (!res.ok) return fail(res.message)
    // 库里跟上：删掉的那条线程关掉；禁言 / 封禁 / 解封的那个人改状态
    if (change.target.type === 'community_thread' && action === 'delete_post') {
      const thread = store.thread(change.target.id)
      if (thread !== undefined) store.saveThread({ ...thread, status: 'closed' })
    }
    const memberStatus = MEMBER_STATUS[action]
    if (memberStatus !== undefined) {
      const member = store.members({ account_id: account.id }).find((m) => m.external_id === target)
      if (member !== undefined) store.saveMember({ ...member, status: memberStatus })
    }
    options.emit('social.moderation_applied', 'system', {
      change_id: change.id,
      channel,
      action,
    })
    return { status: 'ok', execution_id: `social_mod_${change.id}` }
  }

  const deliverReply = async (item: ApprovalItem): Promise<SocialExecResult | undefined> => {
    if (item.workspace_id !== workspace_id || !isSocialReplyItem(item)) return undefined
    // 批的时候改过正文就发改过的那一版（同客服回信）
    const payload = (isRecord(finalPayload(item)) ? finalPayload(item) : item.payload) as Record<
      string,
      unknown
    >
    const body = payload.body
    const text = (
      typeof body === 'string' ? body : isRecord(body) ? str(body.text) : undefined
    )?.trim()
    const threadId = str(payload.thread_id) ?? item.subject.object.id
    const thread: CommunityThread | undefined = store.thread(threadId)
    const channel = thread?.channel ?? str(payload.channel) ?? ''
    const fail = (message: string): SocialExecResult => {
      options.emit('social.reply_failed', 'system', {
        approval_item_id: item.id,
        thread_id: threadId,
        channel,
      })
      return failed(message)
    }
    if (thread === undefined) return fail('要回的那条线程已经不在社媒库里了，没发。')
    if (text === undefined || text === '') return fail('回帖卡上没有正文，没发。')
    const account = store.account(thread.account_id)
    if (account === undefined) return fail('这个号 / 群已经不在社媒库里了，没发。')
    const adapter = options.adapter(thread.channel)
    if (adapter?.reply === undefined)
      return fail(`${label(thread.channel)} 还没有能回帖的出口，这一条没发。`)
    const res = await adapter.reply({
      parent_external_id: thread.external_id,
      text,
      account_external_id: account.external_id,
      last_inbound_at: thread.created_at,
    })
    if (!res.ok) return fail(res.message)
    store.saveThread({
      ...thread,
      status: 'answered',
      ...(res.data.external_id === '' ? {} : { reply_external_id: res.data.external_id }),
    })
    options.emit('social.reply_sent', 'system', {
      approval_item_id: item.id,
      thread_id: thread.id,
      channel: thread.channel,
    })
    return {
      status: 'ok',
      execution_id: `social_reply_${item.id}`,
      outcome_ref: { type: 'community_thread', id: thread.id },
    }
  }

  const apply = async (item_id: string): Promise<boolean> => {
    if (options.applyApproval === undefined) return false
    try {
      await options.applyApproval(item_id)
      return true
    } catch {
      // 取消窗口没过 / 已经施行过 / 被撤了：下一轮再说（或者不用再说）
      return false
    }
  }

  return {
    applyModeration,
    deliverReply,
    async onDecided(item) {
      if (item.workspace_id !== workspace_id || !APPROVED.has(item.state)) return
      if (!isSocialExecutableApproval(item) || options.applyApproval === undefined) return
      const t = setTimeout(() => {
        timers.delete(t)
        void apply(item.id)
      }, windowMs + 1_000)
      t.unref?.()
      timers.add(t)
    },
    async sweep() {
      const nowMs = Date.parse(options.clock.now())
      const due: string[] = []
      for (const c of await options.ledger.list({ workspace_id, kind: 'community_moderation' })) {
        if (c.status !== 'approved' || c.approval === undefined) continue
        if (!isOtherModeration(c.kind, c.after)) continue
        if (nowMs - Date.parse(c.approval.at) < windowMs) continue
        due.push(c.approval.item_id)
      }
      for (const item of options.approvedItems?.() ?? []) {
        if (item.workspace_id !== workspace_id || !APPROVED.has(item.state)) continue
        if (!isSocialReplyItem(item)) continue
        const at = item.decision?.at
        if (at !== undefined && nowMs - Date.parse(at) < windowMs) continue
        due.push(item.id)
      }
      let applied = 0
      for (const id of due) if (await apply(id)) applied += 1
      return applied
    },
    close() {
      for (const t of timers) clearTimeout(t)
      timers.clear()
    },
  }
}
