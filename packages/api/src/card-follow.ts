/**
 * WP414（Luoye 10-19 真机，INMO Reddit 回信卡）：**同类卡跟着前一个决定**。
 *
 * 人对一张卡做了决定之后，在**同一个人、同一条职责、同一种卡**的待处理卡里找同类的
 * （「同类」怎么算由宿主注入的 `similarCards` 说了算——用现有的相似度工具，不在网关里另造）：
 *
 * - 「不要」「稍后」这类**不对外**的决定：同类卡一并照办（每张单独记一次决定，`via: 'batch'`，
 *   决定上带 `followed`：谁带动的、为什么算同类），账本记一条 `approval.followed`；人能整批撤回；
 * - 「发送 / 通过」这类**对外**动作：**绝不自动做**，只把同类卡列回去（`suggested`），由人逐张或一次性确认。
 *
 * 只跟这几种卡：它们的「不要 / 稍后」除了卡本身的状态没有别的副作用，撤回能原样放回去。
 * 别的卡（导入整批、插件装卸、花钱的服务单…）被拒时会连带做事，撤不干净，不跟。
 */
import type { ApprovalItem, ApprovalKind, PersonId } from '@agentsws/contracts'
import { tokenFor } from './helpers.js'
import type { GatewayDeps } from './types.js'

/** 「为什么算同类」的几把钥匙（前端按它出中英文；`why` 是给账本的那一句中文）。 */
export type FollowBasis = 'same_object' | 'same_topic' | 'same_source' | 'same_judgement'

/** 宿主给回来的一张同类卡。 */
export interface SimilarCard {
  id: string
  /** 一句话：为什么算同类（中文，进决定与账本）。 */
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
  /** 已经跟着处理了的（只有「不要 / 稍后」才有） */
  applied: FollowedCard[]
  /** 同类、但要人自己确认的（「发送 / 通过」） */
  suggested: FollowedCard[]
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

const hasOptions = (item: ApprovalItem): boolean => {
  const p = item.payload as { options?: unknown } | null | undefined
  return Array.isArray(p?.options) && p.options.length > 0
}

/**
 * 人刚定了 `item`（`action` 是他点的那个卡片动词）→ 找同类、按规矩处理。
 * 不该跟（没装相似度、不是那几种卡、选择题卡、状态对不上）回 `undefined`；一张同类都没有回空列表。
 */
export async function followDecision(
  deps: Pick<GatewayDeps, 'approvals' | 'similarCards' | 'eventLog'>,
  input: {
    item: ApprovalItem
    person_id: PersonId
    action: 'reject' | 'snooze' | 'approve'
    trace_id: string
  },
): Promise<CardFollowResult | undefined> {
  const { item, person_id, action } = input
  if (deps.similarCards === undefined || !FOLLOW_KINDS.has(item.kind) || hasOptions(item))
    return undefined
  const expected =
    action === 'reject'
      ? ['rejected']
      : action === 'snooze'
        ? ['deferred']
        : ['approved', 'approved_edited', 'applying', 'applied']
  if (!expected.includes(item.state)) return undefined

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
  if (pool.length === 0)
    return { action, leader_id: item.id, leader_title: item.title, applied: [], suggested: [] }
  const byId = new Map(pool.map((c) => [c.id, c]))
  const similar = (await deps.similarCards(item, pool))
    .filter((s) => byId.has(s.id))
    .slice(0, FOLLOW_LIMIT)
  const withTitle = (s: SimilarCard): FollowedCard => ({ ...s, title: byId.get(s.id)?.title ?? '' })

  // 对外的动作：绝不自动做，只列回去
  if (action === 'approve')
    return {
      action,
      leader_id: item.id,
      leader_title: item.title,
      applied: [],
      suggested: similar.map(withTitle),
    }

  const applied: FollowedCard[] = []
  for (const s of similar) {
    const card = byId.get(s.id)
    if (card === undefined) continue
    const token = tokenFor(card, person_id)
    if (token === undefined) continue
    try {
      await deps.approvals.decide(card.id, person_id, {
        decision_token: token,
        action: action === 'reject' ? 'reject' : 'defer',
        reason: followReason(item.title, item.decision?.reason),
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
    // 账本：谁的哪个决定带动了哪几张
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
        followers: applied.map((a) => ({ id: a.id, why: a.why, basis: a.basis })),
      },
    })
  return { action, leader_id: item.id, leader_title: item.title, applied, suggested: [] }
}
