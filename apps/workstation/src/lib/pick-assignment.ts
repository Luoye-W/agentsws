/**
 * WP139（docs/78 阻断 #2）：**不属于任何岗位的页面**，按「这一页要什么职责」挑自己的身份。
 *
 * 试聊（`/chat`）、聊天窗（`/chat-window`）、连接页的「自带数据接口」都不挂在某个岗位下，
 * 以前却用全局「当前岗位」发请求——整页刷新后当前岗位落回店主，店主那条分配没有
 * `customer.read` / `creator.read`，于是一律 403，页面还把它说成「没装」。
 *
 * 这里的办法：从**我名下**的分配里挑一条持有这条职责的，只给这一页的请求用
 * （`X-Assignment` 覆盖），**不改全局当前岗位**。挑的是本人自己的分配，不是借别人的
 * 岗位扩权（54 §2）——网关照样按那条分配判权限。
 *
 * 挑的顺序：
 * 1. 需要「分配了范围」的（`range=assigned` 的接口），**有范围的优先**——空范围的分配
 *    去读 assigned 范围一定被拒（31 §3.1），挑它等于挑一个必 403 的；
 * 2. 职责按需求里列的先后（`dtc.live-chat` 排在 `dtc.support` 前面）；
 * 3. 同一档里当前岗位优先（人刚从那条职责点过来，就用那条）；
 * 4. 再不行按 `/v1/me` 给的顺序。
 */
import type { Assignment } from './api'

/** 一页要的那条职责。`roles` 里 `kol.*` 这种以 `.*` 结尾的是前缀。 */
export interface DutyNeed {
  /** 有序：越前越优先 */
  roles: readonly string[]
  /** 接口按 `range=assigned` 判（空范围的分配必被拒） */
  needs_range: boolean
  /** 挑不到时那句话里的职责名（i18n 键） */
  duty_key: string
}

/** 网站在线客服：会话、试聊。客服那两条也持有 `customer.read`，排在后面兜底。 */
export const LIVE_CHAT_NEED: DutyNeed = {
  roles: ['dtc.live-chat', 'dtc.support', 'dtc.community-support'],
  needs_range: true,
  duty_key: 'need.duty.live_chat',
}

/**
 * 教 AI 一句（`customer.stage`）。`dtc.live-chat` 的职责模板只有 `customer.read`
 * （「只答不承诺」），所以持有 stage 的客服职责排前面；只有在线客服那一条时照样用它，
 * 被拒了界面说「这条职责没有这项权限」（见报告「需要 Luoye 定的事」）。
 */
export const LIVE_CHAT_TEACH_NEED: DutyNeed = {
  roles: ['dtc.support', 'dtc.community-support', 'dtc.live-chat'],
  needs_range: true,
  duty_key: 'need.duty.live_chat',
}

/** 红人：任一渠道的红人职责都行。 */
export const KOL_NEED: DutyNeed = {
  roles: ['kol.*'],
  needs_range: true,
  duty_key: 'need.duty.kol',
}

/** 工作区级配置（聊天窗外观 / 转发器）：`store_config` / `policy` 只有所有者持有。 */
export const OWNER_NEED: DutyNeed = {
  roles: ['common.owner'],
  needs_range: false,
  duty_key: 'need.duty.owner',
}

export type AssignmentPick =
  /** 挑到了，放心用 */
  | { kind: 'ok'; assignment: string; role_id: string }
  /** 有这条职责，但它还没分配店铺 / 品牌（接口必拒）——告诉人去分配 */
  | { kind: 'no_range'; assignment: string; role_id: string }
  /** 名下没有这条职责 */
  | { kind: 'none' }

/** 这条职责在需求里排第几（`kol.*` 按前缀）；不在就是 -1。 */
function rank(roles: readonly string[], role_id: string): number {
  const matches = (r: string): boolean =>
    r.endsWith('.*') ? role_id.startsWith(r.slice(0, -1)) : r === role_id
  return roles.findIndex(matches)
}

export function pickAssignment(
  assignments: readonly Assignment[],
  need: DutyNeed,
  current?: string | null,
): AssignmentPick {
  const candidates = assignments
    .map((a, i) => ({ a, i, r: rank(need.roles, a.role_id) }))
    .filter((c) => c.a.revoked_at === undefined && c.r >= 0)
  if (candidates.length === 0) return { kind: 'none' }
  const ranged = (a: Assignment): number => (need.needs_range && a.ranges.length === 0 ? 1 : 0)
  candidates.sort(
    (x, y) =>
      ranged(x.a) - ranged(y.a) ||
      x.r - y.r ||
      Number(y.a.id === current) - Number(x.a.id === current) ||
      x.i - y.i,
  )
  const best = candidates[0] as (typeof candidates)[number]
  return {
    kind: ranged(best.a) === 1 ? 'no_range' : 'ok',
    assignment: best.a.id,
    role_id: best.a.role_id,
  }
}

/** 名下有没有这条职责（没撤销的；不管有没有范围）。常驻入口用它决定出不出现。 */
export function holdsDuty(assignments: readonly Assignment[], role_id: string): boolean {
  return assignments.some((a) => a.revoked_at === undefined && rank([role_id], a.role_id) >= 0)
}
