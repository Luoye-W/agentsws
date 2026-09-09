/**
 * 05 §0 不变量 2：Assignment 的额度覆盖**只能更紧**。
 *
 * `core.resolveMandate` 在解析时已经把"想放宽的值"静默丢掉了（`tighter`），
 * 但界面上改范围 / 改额度时静默丢弃是最坏的一种反馈：管理者以为改成功了。
 * 所以写入前先在这里判一次，放宽就报 `invalid_input`，并说清是哪个动作的哪个键。
 */
import type { Mandate, WorkspacePolicy } from '@agentsws/contracts'
import { resolveMandate } from '@agentsws/core'
import { type RoleDefinitionFull, RoleError } from './types.js'

type Cap = Mandate['caps'][string]

/** 一条覆盖是不是比基准更紧（相等算更紧）。 */
function tighterOrEqual(base: Cap | undefined, next: Cap): boolean {
  if (base === undefined) return true
  if (typeof base === 'number' && typeof next === 'number') return next <= base
  if (typeof base === 'boolean' && typeof next === 'boolean') return next || !base
  if (Array.isArray(base) && Array.isArray(next)) return next.every((x) => base.includes(x))
  // 类型都对不上（字符串枚举之类）：只允许原样保留
  return JSON.stringify(base) === JSON.stringify(next)
}

/**
 * 校验一组 `mandate_overrides`：动作必须属于该职责，且每一项都不得放宽
 * （基准 = Role 默认额度经 WorkspacePolicy 覆盖之后的那份）。
 */
export function assertTighterOverrides(
  role: RoleDefinitionFull,
  policy: WorkspacePolicy | undefined,
  overrides: Record<string, Partial<Mandate>>,
): void {
  for (const [actionId, override] of Object.entries(overrides)) {
    const action = role.actions.find((a) => a.id === actionId)
    if (!action)
      throw new RoleError('invalid_input', `职责 ${role.id} 没有「${actionId}」这个动作`, {
        action_id: actionId,
      })
    const base = resolveMandate(action.mandate, policy?.mandates[actionId])
    for (const [key, value] of Object.entries(override.caps ?? {})) {
      if (!tighterOrEqual(base.caps[key], value))
        throw new RoleError(
          'invalid_input',
          `「${actionId}」的额度只能更紧：${key} 现在是 ${String(base.caps[key])}，不能改成 ${String(value)}`,
          { action_id: actionId, cap: key },
        )
    }
    const window = override.window
    if (
      window !== undefined &&
      base.window !== undefined &&
      window.max_count > base.window.max_count
    )
      throw new RoleError(
        'invalid_input',
        `「${actionId}」的频次只能更紧：现在每${base.window.per === 'day' ? '天' : '周'} ${base.window.max_count} 次`,
        { action_id: actionId, cap: 'window.max_count' },
      )
    const maxItems = override.per_change_limits?.max_items
    const baseItems = base.per_change_limits?.max_items
    if (maxItems !== undefined && baseItems !== undefined && maxItems > baseItems)
      throw new RoleError(
        'invalid_input',
        `「${actionId}」每次最多改 ${baseItems} 项，不能改成 ${maxItems}`,
        { action_id: actionId, cap: 'per_change_limits.max_items' },
      )
  }
}
