/**
 * 审批项的两件定时家务：**过期**与**升级**（14 §4.4 / §7、31 §3.2、39 待办 A）。
 *
 * 为什么单独一个文件：这两件事在 WP4 就实现好了（`ApprovalBus.expire()` /
 * `escalate()`），但**在服务进程里从来没有人调**——全仓只有模拟回路
 * （`packages/simulation/src/runner.ts` 的 tick）在调。也就是说真跑起来的机器上：
 *
 * - 一张 7 天没人管的卡永远停在 `pending`，永远不会 `expired`；
 * - 一条 `approved` 之后没人 apply 的变更，它的额度预占永远不释放
 *   （预占是跟着审批项过期一起放的，15 §3.2 (d)），于是那一天的额度被白占掉；
 * - 24 工作小时没人认领也不会升级给范围管理者，48 小时也不会到 owner。
 *
 * 所以这里做的不是新机制，是**把已有机制接上真实的时间**：一分钟一拍，
 * 节奏与模拟回路一致（模拟回路每个 tick 调一次 `expire`，真机器每分钟调一次）。
 *
 * 纪律：
 * - 时间只经注入的 Clock（调度器把 `ctx.at` 递进来，不读机器时钟）；
 * - 两件事各自 try/catch：过期挂了不该让升级也不跑；
 * - 不产生任何对外动作——过期与升级只改队列状态与投递，出站在别处。
 */
import type { ApprovalBus, ApprovalItem, Iso8601, PersonId } from '@agentsws/contracts'
import type { RoleStore } from '@agentsws/roles'
import type { Directory } from '@agentsws/txn'

/** 一拍家务的结果（进调度器的运行历史，界面上看得到「上次跑了什么」）。 */
export interface HousekeepingOutcome {
  expired: string[]
  escalated: string[]
  /** 哪一步炸了（另一步照跑）。 */
  failed: { step: 'expire' | 'escalate'; error: string }[]
}

export interface HousekeepingDeps {
  approvals: ApprovalBus
  /** 不给就用调度器递进来的 `ctx.at`。 */
  now?(): Iso8601
}

const idsOf = (items: readonly ApprovalItem[]): string[] => items.map((i) => i.id)
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * 跑一拍：先过期再升级。
 *
 * 顺序有讲究：先过期，已经该过期的那几张就不会在这一拍里又被升级一次
 * ——升级的语义是「还等着人」，一张已经作废的卡不该再去打扰下一层。
 */
export async function runApprovalHousekeeping(
  deps: HousekeepingDeps,
  at: Iso8601,
): Promise<HousekeepingOutcome> {
  const now = deps.now?.() ?? at
  const failed: HousekeepingOutcome['failed'] = []
  let expired: string[] = []
  let escalated: string[] = []
  try {
    expired = idsOf(await deps.approvals.expire(now))
  } catch (e) {
    failed.push({ step: 'expire', error: messageOf(e) })
  }
  try {
    escalated = idsOf(await deps.approvals.escalate(now))
  } catch (e) {
    failed.push({ step: 'escalate', error: messageOf(e) })
  }
  return { expired, escalated, failed }
}

export interface ApprovalDirectoryOptions {
  /**
   * 都是取值函数，不是值：审批总线在装配线上排在身份**之前**
   * （`createTxn` 早于 `identity.createPerson`），所以 owner 与工作区
   * 要等装到那一步才知道。给一个空壳、之后填上，比把装配顺序拧过来安全。
   */
  workspace_id(): string | undefined
  /** 工作区 owner；升级链的最后一层永远是他。 */
  owner(): PersonId | undefined
  roles: RoleStore
}

/**
 * 14 §7 升级链要问的两个问题：这条卡的**范围管理者**是谁、**owner** 是谁。
 *
 * v1 的答法（单工作区、本地档）：
 * - owner = 工作区所有者，钉死；
 * - 范围管理者 = 本工作区里另一个持有 `common.owner` 的人（不是提议者本人）；
 *   找不到就退回 owner——**宁可多通知一个人，也不要让一张卡卡在无人可升**
 *   （14 §4.3「SoD 无人可替时升级 owner 并留痕，不硬阻断」的同一条原则）。
 *
 * 这个目录只回答升级要问的两件事：`canApprove` 与 `memberCount` 留空，
 * 免得顺手改了 SoD 与「谁能决定」的既有行为（那两条各有自己的真源）。
 */
export function createApprovalDirectory(options: ApprovalDirectoryOptions): Directory {
  const managers = (item: ApprovalItem): PersonId | undefined => {
    const workspace_id = options.workspace_id()
    const owner = options.owner()
    if (workspace_id === undefined) return owner
    const proposer = item.proposer.kind === 'person' ? item.proposer.id : undefined
    const found = options.roles.assignments
      .listByRole('common.owner', { workspace_id })
      .filter((a) => a.revoked_at === undefined && a.person_id !== proposer)
      .map((a) => a.person_id)
    return found.find((p) => p !== owner) ?? found[0] ?? owner
  }
  return {
    scopeManager: (item) => managers(item),
    owner: () => options.owner(),
  }
}
