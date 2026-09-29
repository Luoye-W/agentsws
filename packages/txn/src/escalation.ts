/**
 * WP199：升级链留痕与核对（14 §7「升级 = 新增 Delivery 给下一层，不撤销原 recipients」）。
 *
 * 执行快照（14 §4）有一格是 `recipients`。以前这一格直接拿当前收件人名单算，于是：
 * 卡落在批不了的人手上 → 升级把老板加进名单 → 老板批了 → 施行前重算快照，名单多了一个人，
 * 与批准时绑定的那一份对不上 → `snapshot_mismatch`，施行失败（WP191 报告偏离第 1 条）。
 *
 * 改法：快照那一格只绑**出卡（或改派 / 重提）时**的名单；升级追加的人不进那一格，
 * 而是按升级链一步步核对——
 *
 * - 每一步记在 `routing.escalation.trail` 上（第几级、送给谁、什么时候、有没有新加人、
 *   当时的 revision），与上一步首尾相接（`digest`）；
 * - 只有「链接得上 + 这一级在卡的升级链里 + 同一级没升过两次 + 挂在当前 revision +
 *   这个人在名单里确实是 `via: 'escalation'`」的人才从那一格里拿掉；
 * - 核对不过的人照旧算进那一格 → 快照对不上 → 不施行。**不是谁批都行。**
 *
 * 改派（reroute / redirect）与重提（同键再提）都会 revision + 1 并重算快照：那一刻名单里的人
 * （包括之前升级进来的）全部重新绑进快照，旧步骤只作留痕。
 *
 * 这里是纯函数：审批总线出卡 / 批准时算快照、执行器施行前重算快照用的是同一份。
 */
import type { ApprovalItem, EscalationStep, Iso8601, PersonId } from '@agentsws/contracts'
import { sha256 } from '@agentsws/core'

type Tier = EscalationStep['tier']

/** 一步的指纹：挂在哪张卡、哪个 revision、接在哪一步后面、这一步本身。 */
export function escalationDigest(
  item_id: string,
  step: { revision: number; tier: Tier; to: PersonId; at: Iso8601; added: boolean },
  prev: string,
): string {
  return sha256(
    [item_id, step.revision, prev, step.tier, step.to, step.at, step.added ? '1' : '0'].join('|'),
  )
}

/** 在卡上追加一步（总线升级时调）。返回新的这一步。 */
export function appendEscalationStep(
  item: ApprovalItem,
  step: { tier: Tier; to: PersonId; at: Iso8601; added: boolean },
): EscalationStep {
  const trail = item.routing.escalation.trail ?? []
  const prev = trail[trail.length - 1]?.digest ?? ''
  const body = { ...step, revision: item.revision }
  const next: EscalationStep = { ...body, digest: escalationDigest(item.id, body, prev) }
  item.routing.escalation.trail = [...trail, next]
  return next
}

/**
 * 当前 revision 下、按升级链核对得上的「升级追加进来的人」。
 *
 * 链从头走：哪一步的指纹对不上（被改过 / 被插过），这一步和它后面的都不认。
 */
export function verifiedEscalatedRecipients(item: ApprovalItem): Set<PersonId> {
  const { chain, trail = [] } = item.routing.escalation
  const out = new Set<PersonId>()
  const tiers = new Set<Tier>()
  let prev = ''
  for (const step of trail) {
    if (step.digest !== escalationDigest(item.id, step, prev)) break
    if (!chain.includes(step.tier) || tiers.has(step.tier)) break
    prev = step.digest
    tiers.add(step.tier)
    if (!step.added || step.revision !== item.revision) continue
    if (item.routing.recipients.some((r) => r.person === step.to && r.via === 'escalation'))
      out.add(step.to)
  }
  return out
}

/** 执行快照 `recipients` 那一格：当前名单去掉核对得上的升级追加者，排好序。 */
export function boundRecipients(item: ApprovalItem): PersonId[] {
  const escalated = verifiedEscalatedRecipients(item)
  return item.routing.recipients
    .map((r) => r.person)
    .filter((p) => !escalated.has(p))
    .sort()
}

/**
 * 施行前再问一句：拍板的这个人是不是合法审批人。
 *
 * 合法 = 在快照绑定的名单里，或是核对得上的升级追加者。额度自动批（`mandate`）不在此列。
 * 名单被人塞过（链对不上）的情况，快照那一格已经会对不上；这一句兜的是「拍板人
 * 根本不在名单里」——决定那一刻已经拦过，施行前再拦一次，两处都说。
 */
export function deciderIsLegitimate(item: ApprovalItem): boolean {
  const by = item.decision?.by
  if (by === undefined || by === 'mandate') return true
  return item.routing.recipients.some((r) => r.person === by)
}
