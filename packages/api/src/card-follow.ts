/**
 * WP414（Luoye 10-19 真机，Reddit 回信卡；10-19 更正）：**同类卡跟着前一个决定——以理由为准**。
 *
 * 人对一张卡做了决定之后，在**同一个人、同一条职责、同一种卡**的待处理卡里看还有没有一样的：
 *
 * - 「不要」「稍后」这类**不对外**的决定：
 *   - **没给理由就只处理这一张**，一张都不带；
 *   - **给了理由**（决定时带的，或事后点快捷理由 / 自己写的——补理由那一刻再去找）才去找：把理由和每张
 *     候选卡交给宿主注入的 `judgeByReason`（AI 逐张判「这张是不是也属于这个理由说的情况」；词重合只做预筛），
 *     判为是的直接替人照办（每张单独记一次决定，`via: 'batch'`，决定上带 `followed`：谁带动的、为什么），
 *     账本记一条 `approval.followed`；人能单张恢复、整批撤回；
 * - 「发送 / 通过」这类**对外**动作：**绝不自动做**，只把同类卡列回去（`suggested`，用宿主的 `similarCards`），
 *   由人逐张或一次性确认。
 *
 * 只跟这几种卡：它们的「不要 / 稍后」除了卡本身的状态没有别的副作用，撤回能原样放回去。
 * 别的卡（导入整批、插件装卸、花钱的服务单…）被拒时会连带做事，撤不干净，不跟。
 */
import type { ApprovalItem, ApprovalKind, PersonId } from '@agentsws/contracts'
import { REJECT_NO_REASON } from '@agentsws/deck'
import { tokenFor } from './helpers.js'
import type { GatewayDeps } from './types.js'

/**
 * 「为什么算同类」的几把钥匙。`same_reason` = AI 按人给的理由判的（前端直接显示 `why` 那一句）；
 * 其余几把是「要一起发吗」那一路的词重合（前端按钥匙出中英文）。
 */
export type FollowBasis =
  | 'same_reason'
  | 'same_object'
  | 'same_topic'
  | 'same_source'
  | 'same_judgement'

/** 宿主给回来的一张同类卡。 */
export interface SimilarCard {
  id: string
  /** 一句话：为什么算同类（进决定与账本）。 */
  why: string
  basis: FollowBasis[]
  /** 同一来源时的来源名（「r/Smartphones」），前端拼句子用。 */
  source?: string
}

/** 回给工作台的一张（标题给人看，`why` / `basis` 写在卡上）。 */
export interface FollowedCard extends SimilarCard {
  title: string
}

export interface CardFollowResult {
  /** 人刚才那一下是什么 */
  action: 'reject' | 'snooze' | 'approve'
  leader_id: string
  leader_title: string
  /** 按哪条理由判的（「不要 / 稍后」才有） */
  reason?: string
  /** 已经跟着处理了的（只有给了理由的「不要 / 稍后」才有） */
  applied: FollowedCard[]
  /** 同类、但要人自己确认的（「发送 / 通过」） */
  suggested: FollowedCard[]
}

/** 交给宿主判「是不是也属于这个理由」的那一份。 */
export interface ReasonJudgeInput {
  leader: ApprovalItem
  /** 同一个人、同一条职责、同一种卡、还没定的（宿主自己再预筛） */
  pool: readonly ApprovalItem[]
  /** 人给的理由（原话） */
  reason: string
  action: 'reject' | 'snooze'
  /** 记账用：这次是谁、在哪条分配上（调模型时归属） */
  person_id: PersonId
  assignment_id: string
}

/** 只跟这几种卡（见文件头）。 */
export const FOLLOW_KINDS: ReadonlySet<ApprovalKind> = new Set<ApprovalKind>([
  'outbound_draft',
  'staged_change',
  'knowledge_update',
  'seo_topic',
])

/** 一次最多带动几张（再多就不是「同类」而是整条队列了）。 */
export const FOLLOW_LIMIT = 20

/** 跟着处理时那一次决定的理由（账本里看得出是跟着谁）。 */
export function followReason(leaderTitle: string, leaderReason: string | undefined): string {
  const r = leaderReason?.trim()
  return r === undefined || r === '' ? `跟着「${leaderTitle}」` : `跟着「${leaderTitle}」：${r}`
}

/** 算不算「给了理由」：空的、`REJECT_NO_REASON`（没写理由时记的那一句）都不算。 */
export function givenReason(reason: string | undefined): string | undefined {
  const r = reason?.trim()
  return r === undefined || r === '' || r === REJECT_NO_REASON ? undefined : r
}

const hasOptions = (item: ApprovalItem): boolean => {
  const p = item.payload as { options?: unknown } | null | undefined
  return Array.isArray(p?.options) && p.options.length > 0
}

const STATES: Record<CardFollowResult['action'], readonly string[]> = {
  reject: ['rejected'],
  snooze: ['deferred'],
  approve: ['approved', 'approved_edited', 'applying', 'applied'],
}

/**
 * 人刚定了 `item`（`action` 是他点的那个卡片动词，`reason` 是他给的理由）→ 找同类、按规矩处理。
 * 不该跟（没装判断、不是那几种卡、选择题卡、状态对不上、「不要 / 稍后」没给理由）回 `undefined`；
 * 一张同类都没有回空列表。
 */
export async function followDecision(
  deps: Pick<GatewayDeps, 'approvals' | 'similarCards' | 'judgeByReason' | 'eventLog'>,
  input: {
    item: ApprovalItem
    person_id: PersonId
    assignment_id: string
    action: CardFollowResult['action']
    reason?: string
    trace_id: string
  },
): Promise<CardFollowResult | undefined> {
  const { item, person_id, action } = input
  if (!FOLLOW_KINDS.has(item.kind) || hasOptions(item)) return undefined
  if (!STATES[action].includes(item.state)) return undefined
  const reason = action === 'approve' ? undefined : givenReason(input.reason)
  // 「不要 / 稍后」没给理由：只处理这一张
  if (action !== 'approve' && reason === undefined) return undefined
  if (action === 'approve' ? deps.similarCards === undefined : deps.judgeByReason === undefined)
    return undefined

  const pool = (
    await deps.approvals.queue({
      workspace_id: item.workspace_id,
      person_id,
      lane: 'mine',
      kind: item.kind,
      role_id: item.role_id,
      state: ['pending', 'in_review'],
    })
  ).filter((c) => c.id !== item.id && !hasOptions(c))
  const base = {
    action,
    leader_id: item.id,
    leader_title: item.title,
    ...(reason === undefined ? {} : { reason }),
  }
  if (pool.length === 0) return { ...base, applied: [], suggested: [] }
  const byId = new Map(pool.map((c) => [c.id, c]))
  const withTitle = (s: SimilarCard): FollowedCard => ({ ...s, title: byId.get(s.id)?.title ?? '' })

  // 对外的动作：绝不自动做，只列回去
  if (action === 'approve') {
    const similar = (await deps.similarCards?.(item, pool)) ?? []
    return {
      ...base,
      applied: [],
      suggested: similar
        .filter((s) => byId.has(s.id))
        .slice(0, FOLLOW_LIMIT)
        .map(withTitle),
    }
  }

  // 「不要 / 稍后」+ 理由：AI 按理由逐张判，判为是的替人照办
  const judged = (
    (await deps.judgeByReason?.({
      leader: item,
      pool,
      reason: reason ?? '',
      action,
      person_id,
      assignment_id: input.assignment_id,
    })) ?? []
  )
    .filter((s) => byId.has(s.id))
    .slice(0, FOLLOW_LIMIT)
  const applied: FollowedCard[] = []
  for (const s of judged) {
    const card = byId.get(s.id)
    if (card === undefined) continue
    const token = tokenFor(card, person_id)
    if (token === undefined) continue
    try {
      await deps.approvals.decide(card.id, person_id, {
        decision_token: token,
        action: action === 'reject' ? 'reject' : 'defer',
        reason: followReason(item.title, reason),
        ...(action === 'snooze' && item.decision?.defer_until !== undefined
          ? { defer_until: item.decision.defer_until }
          : {}),
        via: 'batch',
        followed: { leader_id: item.id, why: s.why },
      })
      applied.push(withTitle(s))
    } catch {
      // 那张卡刚被别处定了 / 令牌换了：跳过，不影响别的
    }
  }
  if (applied.length > 0)
    // 账本：谁的哪个决定（按哪条理由）带动了哪几张
    deps.eventLog.append?.({
      schema_version: 1,
      workspace_id: item.workspace_id,
      type: 'approval.followed',
      actor: { kind: 'person', id: person_id },
      subject: { type: 'approval_item', id: item.id },
      correlation: { trace_id: input.trace_id },
      payload: {
        leader_id: item.id,
        action,
        reason,
        followers: applied.map((a) => ({ id: a.id, why: a.why })),
      },
    })
  return { ...base, applied, suggested: [] }
}
