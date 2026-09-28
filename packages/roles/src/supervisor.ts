/**
 * WP174（docs/84 §11.1 第 3 条，Luoye 09-28）：`scope_manager` 的审批落到谁。
 *
 * 一条规矩，全仓只有这一份：
 *
 *   发起这张卡的职责所在岗位的**上级** → 没设 / 是本人 / 已经不在工作区 → **老板**。
 *
 * 纯函数：岗位表、谁在做哪个岗位、谁还在工作区，都由调用方递进来。服务进程
 * （`apps/server/src/supervisor.ts`）与模拟世界用的是同一个函数，所以"模拟里转上级、
 * 真机器上转老板"这种两边不一样的事不会再出现（WP172 报告「需要定」第 1 条）。
 */
import type { PersonId, Position, RoleId } from '@agentsws/contracts'

/** 解析要看的岗位那几格（存下来的那份岗位就够，不要求整份模板）。 */
export type SupervisedPosition = Pick<Position, 'id' | 'roles' | 'supervisor_person_id'> & {
  name?: { zh: string; en: string }
}

/** 为什么落到这个人（进事件与卡面那一句）。 */
export type ScopeManagerReason =
  /** 岗位设了上级，落到他。 */
  | 'supervisor'
  /** 这条职责不在任何岗位里（自定义职责单挂），没有上级可找。 */
  | 'no_position'
  /** 岗位没设上级。 */
  | 'no_supervisor'
  /** 上级就是提议者本人——自己不能批自己超授权的东西。 */
  | 'self'
  /** 上级已经不在这个工作区（离职 / 被移出）。 */
  | 'inactive'

export interface ScopeManagerRoute {
  person: PersonId
  via: 'scope_manager' | 'owner'
  reason: ScopeManagerReason
  /** 按哪个岗位找的上级（找不到岗位就没有）。 */
  position_id?: string
}

export interface ScopeManagerInput {
  role_id: RoleId
  /** 提议者（这张卡是谁的活儿）。 */
  proposer: PersonId
  owner: PersonId
  positions: readonly SupervisedPosition[]
  /** 提议者在做哪几个岗位（优先按这些找）。不给 = 不知道，按模板找。 */
  heldBy?: readonly string[]
  /** 这个人还在工作区吗。不给 = 都当在。 */
  isActive?(person: PersonId): boolean
}

/**
 * 这条职责归哪个岗位。
 *
 * 一条职责可能挂在好几个岗位里（`common.member` 几乎每个岗位都有一格可选的）。顺序：
 * 1. 提议者自己在做、又含这条职责的岗位；
 * 2. 这条职责是**默认勾上**的岗位（它的"本家"）；
 * 3. 随便哪个含它的岗位。
 * 每一档里按岗位 id 排，结果与存储顺序无关。
 */
export function positionOfRole(
  role_id: RoleId,
  positions: readonly SupervisedPosition[],
  heldBy: readonly string[] = [],
): SupervisedPosition | undefined {
  const withRole = positions
    .filter((p) => p.roles.some((r) => r.role === role_id))
    .sort((a, b) => a.id.localeCompare(b.id))
  const held = withRole.find((p) => heldBy.includes(p.id))
  if (held !== undefined) return held
  const home = withRole.find((p) => p.roles.some((r) => r.role === role_id && r.default))
  return home ?? withRole[0]
}

/** 发起这张卡的职责所在岗位的上级 → 没设或是本人 → 老板。 */
export function resolveScopeManager(input: ScopeManagerInput): ScopeManagerRoute {
  const toOwner = (reason: ScopeManagerReason, position_id?: string): ScopeManagerRoute => ({
    person: input.owner,
    via: 'owner',
    reason,
    ...(position_id === undefined ? {} : { position_id }),
  })
  const position = positionOfRole(input.role_id, input.positions, input.heldBy)
  if (position === undefined) return toOwner('no_position')
  const supervisor = position.supervisor_person_id
  if (supervisor === undefined) return toOwner('no_supervisor', position.id)
  if (supervisor === input.proposer) return toOwner('self', position.id)
  if (input.isActive !== undefined && !input.isActive(supervisor))
    return toOwner('inactive', position.id)
  // 上级就是老板：照样算「转上级」，只是人是同一个
  return {
    person: supervisor,
    via: 'scope_manager',
    reason: 'supervisor',
    position_id: position.id,
  }
}

/**
 * 卡上那一句「转给了谁、为什么」。名字由调用方查好递进来；查不到就用「老板」「上级」这类称呼，
 * 绝不印 id。
 */
export function scopeManagerReasonText(
  route: ScopeManagerRoute,
  names: { person?: string; position?: string },
): string {
  const who = names.person ?? (route.via === 'owner' ? '老板' : '上级')
  const pos = names.position === undefined ? '这个岗位' : `「${names.position}」岗位`
  switch (route.reason) {
    case 'supervisor':
      return `转给了${pos}的上级${who}`
    case 'no_position':
      return `这条职责不在任何岗位里，没有上级，转给了老板${who === '老板' ? '' : who}`
    case 'no_supervisor':
      return `${pos}没设上级，转给了老板${who === '老板' ? '' : who}`
    case 'self':
      return `${pos}的上级就是提的人自己，转给了老板${who === '老板' ? '' : who}`
    case 'inactive':
      return `${pos}的上级已经不在工作区，转给了老板${who === '老板' ? '' : who}`
  }
}
