/**
 * WP71（36 §9）：第三栏里那四个面板**跟着谁走**。
 *
 * 规矩一句话：**在职责页看的是那条职责，在别处看的是当前岗位**。
 *
 * - `/positions/:assignment/duties/:role_id` → 职责层（那条职责）；
 * - 其余任何一页（岗位页 / 事项页 / 首页 / 知识库…）→ 岗位层，用的是
 *   当前分配（`X-Assignment`）所属的那个岗位；
 * - 面板头上可以手切"岗位层 / 职责层"——同一条职责在两层都有自己的记忆与技能，
 *   看哪一层是人的选择，不是地址的选择（54 §3）。
 *
 * 这里**只算范围，不取数**：取数在各个面板里，各打各的接口。
 */
import type { PositionInstanceData } from '@/lib/api'
import { myAssignments } from '@/lib/positions'

export type RailTier = 'position' | 'role'

export interface RailScope {
  tier: RailTier
  /** 岗位层 = `position_id`；职责层 = `role_id`。就是 `GET /v1/memory?scope_id=` 那一格。 */
  scope_id: string
  /** 面板头上显示的名字（"网站运营" / "店铺管理"）。 */
  name: string
  /** 请求要带的 `X-Assignment`：职责层是那条职责的分配，岗位层是本人在这个岗位下的第一条。 */
  assignment?: string
  /**
   * 上面那一层（职责层的上面是它所属的岗位）。
   * 记忆面板下面折着的"上面继承的"要它——不然界面只知道自己这一层的 id。
   */
  parent?: { tier: RailTier; scope_id: string; name: string }
}

export interface RailContext {
  position?: RailScope
  role?: RailScope
  /** 地址栏本来落在哪一层（面板头的默认选中项）。 */
  preferred: RailTier
}

/** `/positions/asg_1/duties/dtc.store` → `{ assignment, role_id }`；不是这条路就回 undefined。 */
export function parseDutyPath(
  pathname: string,
): { assignment: string; role_id: string } | undefined {
  const m = /^\/positions\/([^/]+)\/duties\/([^/]+)\/?$/.exec(pathname)
  const assignment = m?.[1]
  const role_id = m?.[2]
  if (assignment === undefined || role_id === undefined) return undefined
  return { assignment: decodeURIComponent(assignment), role_id: decodeURIComponent(role_id) }
}

/** `/positions/asg_1` → `asg_1`；职责页那条更长的路不算（它由 {@link parseDutyPath} 认）。 */
export function parsePositionPath(pathname: string): string | undefined {
  const m = /^\/positions\/([^/]+)\/?$/.exec(pathname)
  return m?.[1] === undefined ? undefined : decodeURIComponent(m[1])
}

/**
 * 算出这一页的两层范围。
 *
 * `current` 是当前分配（`useApp().position`）——不在职责页时，岗位层靠它定位；
 * 没装岗位面的服务进程（`instances` 为空）两层都算不出来，第三栏那四个面板
 * 会照实说"先进一个岗位"，而不是去打一个注定 400 的接口。
 */
export function railContextOf(
  pathname: string,
  instances: readonly PositionInstanceData[] | undefined,
  current: string | null,
  lang: 'zh' | 'en',
): RailContext {
  const list = instances ?? []
  const nameOf = (p: PositionInstanceData): string => (lang === 'en' ? p.name.en : p.name.zh)
  const duty = parseDutyPath(pathname)
  const anchor = duty?.assignment ?? parsePositionPath(pathname) ?? current ?? ''
  const owner = list.find((p) => myAssignments(p).includes(anchor))

  const position: RailScope | undefined =
    owner === undefined
      ? undefined
      : {
          tier: 'position',
          scope_id: owner.position_id,
          name: nameOf(owner),
          ...(myAssignments(owner)[0] === undefined
            ? {}
            : { assignment: myAssignments(owner)[0] as string }),
        }

  // 职责层：地址栏指着哪条就是哪条；不在职责页时用当前分配对应的那条职责
  const held = owner?.roles.find((r) =>
    duty === undefined ? r.my_assignment_id === anchor : r.role_id === duty.role_id,
  )
  const role: RailScope | undefined =
    held === undefined
      ? undefined
      : {
          tier: 'role',
          scope_id: held.role_id,
          name: held.role_name,
          ...(held.my_assignment_id === undefined ? {} : { assignment: held.my_assignment_id }),
          ...(position === undefined
            ? {}
            : {
                parent: {
                  tier: 'position' as const,
                  scope_id: position.scope_id,
                  name: position.name,
                },
              }),
        }

  return {
    ...(position === undefined ? {} : { position }),
    ...(role === undefined ? {} : { role }),
    // 只有职责页默认停在职责层；别处一律先看岗位那一层（认知成本，36 §10）
    preferred: duty === undefined ? 'position' : 'role',
  }
}
